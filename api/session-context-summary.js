'use strict';
/* eslint-disable */
// api/session-context-summary.js  v15.7
// GET /api/session-context-summary
//
// Joins closed ledger trades with session-context shadow records (via dedupeKey)
// and reports win-rate / netR splits by:
//   • liqCoincidence  (entry level within 0.25 ATR of a prior session high/low)
//   • withPriorSession (trade direction agrees with the prior session's direction)
//   • asianPosition   (above / inside / below the Asian range at signal time)
//
// n ≥ 8 gate on every bucket — results below that threshold are suppressed.
// This is a read-only analysis endpoint; it cannot gate or affect live trades.

const { applyCors, getRedis, safeParse } = require('./_lib');
const { SC_SHADOW_KEY, SC_SHADOW_INDEX_KEY } = require('./session-context-shadow');

const LEDGER_INDEX_KEY = 'v14:ledger:index';
const LEDGER_TRADE_KEY = (id) => `v14:ledger:trade:${id}`;
const MIN_N = 8;

// ── Bulk-load helpers ─────────────────────────────────────────────────────────
async function loadAllLedger(r) {
  const idxRaw = await r.get(LEDGER_INDEX_KEY).catch(() => null);
  const index  = safeParse(idxRaw) || [];
  if (!index.length) return [];
  try {
    const pipe = r.pipeline();
    for (const e of index) pipe.get(LEDGER_TRADE_KEY(e.id));
    const results = await pipe.exec();
    return results
      .map(raw => {
        const v = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
        return (v && typeof v === 'object') ? v : null;
      })
      .filter(Boolean);
  } catch (_) {
    const out = [];
    for (const e of index) {
      const raw = await r.get(LEDGER_TRADE_KEY(e.id)).catch(() => null);
      const v   = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
      if (v) out.push(v);
    }
    return out;
  }
}

async function loadAllShadows(r) {
  const idxRaw = await r.get(SC_SHADOW_INDEX_KEY).catch(() => null);
  const index  = safeParse(idxRaw) || [];
  if (!index.length) return [];
  try {
    const pipe = r.pipeline();
    for (const e of index) pipe.get(SC_SHADOW_KEY(e.id));
    const results = await pipe.exec();
    return results
      .map(raw => {
        const v = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
        return (v && typeof v === 'object') ? v : null;
      })
      .filter(Boolean);
  } catch (_) {
    const out = [];
    for (const e of index) {
      const raw = await r.get(SC_SHADOW_KEY(e.id)).catch(() => null);
      const v   = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
      if (v) out.push(v);
    }
    return out;
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function stats(trades) {
  const n      = trades.length;
  if (!n) return { n: 0, wins: 0, losses: 0, winRate: null, netPnl: null, avgR: null };
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const netPnl = r2(trades.reduce((s, t) => s + (t.netPnl  || 0), 0));
  const rList  = trades.filter(t => t.pnlR != null).map(t => t.pnlR);
  const avgR   = rList.length ? r2(rList.reduce((s, v) => s + v, 0) / rList.length) : null;
  return {
    n,
    wins:    wins.length,
    losses:  losses.length,
    winRate: r3(wins.length / n),
    netPnl,
    avgR,
  };
}

// Apply the n≥MIN_N gate: null out winRate/avgR for small buckets but keep n visible
function gated(st) {
  if (st.n < MIN_N) return { ...st, winRate: null, avgR: null, netPnl: null, insufficient: true };
  return st;
}

function splitBy(trades, keyFn, allowed) {
  const groups = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (allowed && !allowed.includes(k)) continue;
    if (k == null || k === 'null') continue;
    (groups[k] = groups[k] || []).push(t);
  }
  return Object.fromEntries(
    Object.entries(groups).map(([k, ts]) => [k, gated(stats(ts))])
  );
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    const [ledger, shadows] = await Promise.all([
      loadAllLedger(r).catch(() => []),
      loadAllShadows(r).catch(() => []),
    ]);

    // Build shadow map keyed by dedupeKey (= shadow.id)
    const shadowMap = new Map(shadows.map(s => [s.id, s]));

    // Join closed trades with their session-context shadow
    const joined = ledger
      .filter(t => t.outcome && t.outcome !== 'OPEN')
      .map(t => {
        const sc = (t.dedupeKey ? shadowMap.get(t.dedupeKey) : null) || null;
        return {
          id:              t.id,
          template:        t.template     || 'unknown',
          asset:           t.asset        || null,
          direction:       t.direction    || null,
          outcome:         t.outcome,
          netPnl:          t.netPnl       || 0,
          pnlR:            t.pnlR         || null,
          hasSc:           !!sc,
          liqCoincidence:  sc?.liqCoincidence  ?? null,
          withPriorSession: sc?.withPriorSession ?? null,
          asianPosition:   sc?.asianPosition   ?? null,
          londonDirection: sc?.londonDirection  ?? null,
          nearestLevel:    sc?.nearestLevel     ?? null,
          distATR:         sc?.distATR          ?? null,
          orbEntryP:       sc?.orbEntryP        ?? null,
          template_sc:     sc?.template         ?? null,
        };
      });

    const withSc  = joined.filter(t => t.hasSc);
    const coverage = joined.length > 0 ? withSc.length / joined.length : 0;

    // ── Coincidence split ─────────────────────────────────────────────────────
    const coincident    = withSc.filter(t => t.liqCoincidence === true);
    const nonCoincident = withSc.filter(t => t.liqCoincidence === false);

    // ── withPriorSession split ────────────────────────────────────────────────
    const withSession  = withSc.filter(t => t.withPriorSession === true);
    const againstSession = withSc.filter(t => t.withPriorSession === false);

    // ── Asian position ────────────────────────────────────────────────────────
    const byAsianPos = splitBy(withSc, t => t.asianPosition, ['above', 'inside', 'below']);

    // ── Per-template breakdown ────────────────────────────────────────────────
    const byTemplate = {};
    const templateKeys = [...new Set(withSc.map(t => t.template))].sort();
    for (const tmpl of templateKeys) {
      const ts  = withSc.filter(t => t.template === tmpl);
      const c   = ts.filter(t => t.liqCoincidence === true);
      const nc  = ts.filter(t => t.liqCoincidence === false);
      const ws  = ts.filter(t => t.withPriorSession === true);
      const as_ = ts.filter(t => t.withPriorSession === false);
      byTemplate[tmpl] = {
        all:            gated(stats(ts)),
        coincident:     gated(stats(c)),
        nonCoincident:  gated(stats(nc)),
        withSession:    gated(stats(ws)),
        againstSession: gated(stats(as_)),
      };
    }

    return res.status(200).json({
      ok:          true,
      generatedAt: Date.now(),
      coverage: {
        totalClosed:  joined.length,
        withScShadow: withSc.length,
        coveragePct:  Math.round(coverage * 1000) / 10,
        note: coverage < 0.5
          ? 'low coverage — session-context shadow accumulating (new trades only)'
          : 'ok',
      },
      minN: MIN_N,
      byLiqCoincidence: {
        all:          gated(stats(withSc)),
        coincident:   gated(stats(coincident)),
        nonCoincident: gated(stats(nonCoincident)),
        delta: coincident.length >= MIN_N && nonCoincident.length >= MIN_N
          ? {
              winRateDelta: r3(stats(coincident).winRate - stats(nonCoincident).winRate),
              avgRDelta:    r2((stats(coincident).avgR || 0) - (stats(nonCoincident).avgR || 0)),
            }
          : null,
      },
      byWithPriorSession: {
        withSession:    gated(stats(withSession)),
        againstSession: gated(stats(againstSession)),
        delta: withSession.length >= MIN_N && againstSession.length >= MIN_N
          ? {
              winRateDelta: r3(stats(withSession).winRate - stats(againstSession).winRate),
              avgRDelta:    r2((stats(withSession).avgR || 0) - (stats(againstSession).avgR || 0)),
            }
          : null,
      },
      byAsianPosition: byAsianPos,
      byTemplate,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

function r2(x) { return x == null || !isFinite(x) ? null : Math.round(x * 100) / 100; }
function r3(x) { return x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000; }
