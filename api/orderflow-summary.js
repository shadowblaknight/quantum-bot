/* eslint-disable */
// api/orderflow-summary.js  v15.7
// GET /api/orderflow-summary
//
// Joins closed ledger trades with their CVD orderflow shadow records, then
// aggregates win-rate and P&L by cvdConfirms, cvdDivergence, and cvdSlope.
//
// This is a SHADOW-ONLY endpoint — no live position gating, read-only analysis.
// Use it to validate whether CVD confirmation correlates with better outcomes.

const { applyCors, getRedis, safeParse } = require('./_lib');
const { OF_SHADOW_KEY, OF_SHADOW_INDEX_KEY } = require('./orderflow-shadow');

const LEDGER_INDEX_KEY = 'v14:ledger:index';
const LEDGER_TRADE_KEY = (id) => `v14:ledger:trade:${id}`;
const MIN_N = 5;

async function loadAllLedger(r) {
  const indexRaw = await r.get(LEDGER_INDEX_KEY).catch(() => null);
  const index    = safeParse(indexRaw) || [];
  if (!index.length) return [];
  try {
    const pipe    = r.pipeline();
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
  const indexRaw = await r.get(OF_SHADOW_INDEX_KEY).catch(() => null);
  const index    = safeParse(indexRaw) || [];
  if (!index.length) return [];
  try {
    const pipe    = r.pipeline();
    for (const e of index) pipe.get(OF_SHADOW_KEY(e.id));
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
      const raw = await r.get(OF_SHADOW_KEY(e.id)).catch(() => null);
      const v   = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
      if (v) out.push(v);
    }
    return out;
  }
}

function stats(trades) {
  const n       = trades.length;
  const wins    = trades.filter(t => t.outcome === 'WIN');
  const losses  = trades.filter(t => t.outcome === 'LOSS');
  const netPnl  = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
  const winPnl  = wins.reduce((s, t) => s + (t.netPnl || 0), 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + (t.netPnl || 0), 0));
  const rList   = trades.filter(t => t.pnlR != null).map(t => t.pnlR);
  const winRate      = n > 0 ? wins.length / n : 0;
  const avgR         = rList.length > 0 ? rList.reduce((s, v) => s + v, 0) / rList.length : null;
  const profitFactor = lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? 99 : null);
  return { n, wins: wins.length, losses: losses.length, winRate, netPnl, avgR, profitFactor };
}

function groupBy(arr, keyFn) {
  const g = {};
  for (const x of arr) { const k = keyFn(x); if (!g[k]) g[k] = []; g[k].push(x); }
  return g;
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

    // Index shadows by id for O(1) join
    const shadowMap = new Map(shadows.map(s => [s.id, s]));

    // Join closed ledger trades with their shadow record
    const joined = ledger
      .filter(t => t.outcome && t.outcome !== 'OPEN')
      .map(t => {
        const sh = shadowMap.get(t.id) || null;
        return {
          id:           t.id,
          template:     t.template  || 'unknown',
          direction:    t.direction || null,
          htfTier:      t.htfTier   || null,
          outcome:      t.outcome,
          netPnl:       t.netPnl    || 0,
          pnlR:         t.pnlR      || null,
          hasCvd:       !!sh,
          cvdSlope:     sh?.cvdSlope      || null,
          cvdConfirms:  sh?.cvdConfirms   ?? null,
          cvdDivergence: sh?.cvdDivergence || null,
          cvdLowTrust:  sh?.cvdLowTrust   ?? null,
        };
      });

    const withCvd    = joined.filter(t => t.hasCvd);
    const coverage   = joined.length > 0 ? withCvd.length / joined.length : 0;

    // ── Split by cvdConfirms (the primary signal) ─────────────────────────────
    const confirmed   = withCvd.filter(t => t.cvdConfirms === true);
    const unconfirmed = withCvd.filter(t => t.cvdConfirms === false);

    // ── Split by cvdDivergence ────────────────────────────────────────────────
    const divBearish = withCvd.filter(t => t.cvdDivergence === 'bearish');
    const divBullish = withCvd.filter(t => t.cvdDivergence === 'bullish');
    const divNone    = withCvd.filter(t => t.cvdDivergence === 'none');

    // ── Split by cvdSlope ─────────────────────────────────────────────────────
    const bySlope = groupBy(withCvd, t => t.cvdSlope || 'unknown');

    // ── Per-template breakdown (cvdConfirms split) ────────────────────────────
    const byTemplate = {};
    for (const [tmpl, ts] of Object.entries(groupBy(withCvd, t => t.template))) {
      const conf   = ts.filter(t => t.cvdConfirms === true);
      const unconf = ts.filter(t => t.cvdConfirms === false);
      byTemplate[tmpl] = {
        all:       stats(ts),
        confirmed: stats(conf),
        unconfirmed: stats(unconf),
      };
    }

    // ── cvdLowTrust split (does trust level change correlation?) ─────────────
    const fullTrust = withCvd.filter(t => !t.cvdLowTrust);
    const lowTrust  = withCvd.filter(t => t.cvdLowTrust);
    const ftConf    = fullTrust.filter(t => t.cvdConfirms === true);
    const ftUnconf  = fullTrust.filter(t => t.cvdConfirms === false);

    return res.status(200).json({
      ok:          true,
      generatedAt: Date.now(),
      coverage: {
        totalClosed:   joined.length,
        withCvdShadow: withCvd.length,
        coveragePct:   Math.round(coverage * 1000) / 10,
        note:          coverage < 0.5 ? 'low-coverage — data still accumulating' : 'ok',
      },
      byConfirms: {
        confirmed:   { ...stats(confirmed),   label: 'cvdConfirms=true  (slope agrees with direction)' },
        unconfirmed: { ...stats(unconfirmed), label: 'cvdConfirms=false (slope opposes direction)' },
        delta: confirmed.length >= MIN_N && unconfirmed.length >= MIN_N
          ? { winRateDelta: stats(confirmed).winRate - stats(unconfirmed).winRate,
              netPnlDelta:  stats(confirmed).netPnl  - stats(unconfirmed).netPnl }
          : null,
      },
      byDivergence: {
        bearish: stats(divBearish),
        bullish: stats(divBullish),
        none:    stats(divNone),
      },
      bySlope: Object.fromEntries(
        Object.entries(bySlope).map(([k, ts]) => [k, stats(ts)])
      ),
      byTemplate,
      fullTrustVsLow: {
        fullTrust:  { all: stats(fullTrust),  confirmed: stats(ftConf), unconfirmed: stats(ftUnconf) },
        lowTrust:   stats(lowTrust),
        note: 'fullTrust = BTC/ETH/XAUUSD/NAS/US500; lowTrust = FX (volume less reliable)',
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
