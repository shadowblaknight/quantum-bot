/* eslint-disable */
// api/perf-analysis.js  v15.7
// GET /api/perf-analysis
//
// Template × Tier × Session elimination analysis.
// Sources the same 150 rankable trades as perf-ranking (template-attributed, deduped,
// no unknown/legacy). htfTier A = with-trend, B = counter-trend, null/other = untiered.
//
// Returns five things:
//   byTemplateTier        – template × {A, B, untiered}
//   byTemplateSession     – template × session
//   byTemplateSessionTier – finest cut (template × session × tier); flag n<8 via verdict
//   keepers   – n≥8 net-positive AND above break-even WR, best-first
//   bleeders  – n≥8 net-negative OR below break-even WR, worst-first
//   watchlist – n<8 from template×tier + template×session, most-data-first
//
// Verdict rules (applied to template×tier and template×session, not the fine cut):
//   BLEEDER: netPnl ≤ 0  OR  winRate < breakEvenWR
//   KEEPER : netPnl > 0  AND (winRate ≥ breakEvenWR OR breakEvenWR unknown)
//   WATCH  : n < 8

const { applyCors, getRedis, safeParse } = require('./_lib');
const { getAllTrades }                    = require('./recognition-memory');

const LEDGER_INDEX_KEY = 'v14:ledger:index';
const LEDGER_TRADE_KEY = (id) => `v14:ledger:trade:${id}`;
const PR_MIN_N         = 8;
const EXCL             = new Set(['unknown', 'legacy', 'legacy-unknown']);

// ─── session (UTC) ────────────────────────────────────────────────────────────
function classifySession(openedAt) {
  if (!openedAt) return 'UNKNOWN';
  const ms = typeof openedAt === 'number' ? openedAt : new Date(openedAt).getTime();
  if (!isFinite(ms)) return 'UNKNOWN';
  const d = new Date(ms), day = d.getUTCDay();
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 0 || day === 6) return 'WEEKEND';
  if (h >= 23 || h < 8)      return 'ASIAN';
  if (h >= 8  && h < 13)     return 'LONDON';
  if (h >= 13 && h < 16)     return 'NY_AM';
  if (h >= 16 && h < 21)     return 'NY_PM';
  return 'OFF';
}

// ─── ledger loader (identical pipeline to perf-ranking) ──────────────────────
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

// ─── merge (ledger = P&L truth, recog enriches metadata) ─────────────────────
function mergeRecord(ledger, recog) {
  const l = ledger, g = recog;
  const openedAt = l?.openedAt ?? g?.openedAt ?? null;
  return {
    id:        l?.id        ?? g?.id,
    asset:     l?.asset     ?? g?.asset     ?? 'unknown',
    direction: l?.direction ?? g?.direction ?? null,
    template:  l?.template  || g?.template  || 'unknown',
    session:   classifySession(openedAt),
    htfTier:   l?.htfTier   ?? g?.htfTier   ?? null,
    netPnl:    l?.netPnl    ?? g?.pnl       ?? 0,
    pnlR:      l?.pnlR      ?? g?.pnlR      ?? null,
    outcome:   l?.outcome   ?? g?.outcome   ?? 'BREAKEVEN',
    openedAt,
    closedAt:  l?.closedAt  ?? g?.closedAt  ?? null,
    _source:   l && g ? 'both' : l ? 'ledger' : 'recog',
  };
}

// ─── tier ─────────────────────────────────────────────────────────────────────
// A = with-trend, B = counter-trend. Anything else (null, "C", etc.) = untiered.
function tier(htfTier) {
  if (htfTier === 'A') return 'A';
  if (htfTier === 'B') return 'B';
  return 'untiered';
}

// ─── bucket stats ─────────────────────────────────────────────────────────────
function computeStats(trades) {
  const n       = trades.length;
  const wins    = trades.filter(t => t.outcome === 'WIN');
  const losses  = trades.filter(t => t.outcome === 'LOSS');
  const netPnl  = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
  const winPnl  = wins.reduce((s, t) => s + (t.netPnl || 0), 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + (t.netPnl || 0), 0));
  const rList   = trades.filter(t => t.pnlR != null).map(t => t.pnlR);
  const winRate        = n > 0 ? wins.length / n : 0;
  const avgR           = rList.length > 0 ? rList.reduce((s, v) => s + v, 0) / rList.length : null;
  const profitFactor   = lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? 99 : null);
  const avgWin         = wins.length   > 0 ? winPnl  / wins.length   : null;
  const avgLoss        = losses.length > 0 ? lossPnl / losses.length : null;
  const breakEvenWR    = (avgWin != null && avgLoss != null && avgWin + avgLoss > 0)
                         ? avgLoss / (avgWin + avgLoss) : null;
  const wrVsBE         = breakEvenWR != null ? winRate - breakEvenWR : null;
  return { n, wins: wins.length, losses: losses.length, winRate, netPnl, avgR, profitFactor, breakEvenWR, wrVsBE };
}

// ─── verdict ──────────────────────────────────────────────────────────────────
function verdictOf(stats) {
  if (stats.n < PR_MIN_N) return 'watch';
  if (stats.netPnl <= 0 || (stats.wrVsBE != null && stats.wrVsBE < 0)) return 'bleeder';
  if (stats.netPnl > 0)  return 'keeper';
  return 'watch';
}

// ─── group helper ─────────────────────────────────────────────────────────────
function groupBy(trades, keyFn) {
  const g = {};
  for (const t of trades) { const k = keyFn(t); if (!g[k]) g[k] = []; g[k].push(t); }
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    // ── load + dedupe (same pipeline as perf-ranking) ─────────────────────────
    const [recogRaw, ledgerRaw] = await Promise.all([
      getAllTrades(1000).catch(() => []),
      loadAllLedger(r).catch(() => []),
    ]);
    const recogFiltered  = recogRaw.filter(t => !t.deleted && !String(t.id || '').includes('legacy'));
    const ledgerFiltered = ledgerRaw.filter(t => !t._legacy);
    const recogMap  = new Map(recogFiltered.map(t => [t.id, t]));
    const ledgerMap = new Map(ledgerFiltered.map(t => [t.id, t]));
    const allIds    = new Set([...recogMap.keys(), ...ledgerMap.keys()]);

    let matched = 0, ledgerOnly = 0, recogOnly = 0;
    const allMerged = [];
    for (const id of allIds) {
      const recog  = recogMap.get(id)  ?? null;
      const ledger = ledgerMap.get(id) ?? null;
      if (recog && ledger) matched++;
      else if (ledger)     ledgerOnly++;
      else                 recogOnly++;
      allMerged.push(mergeRecord(ledger, recog));
    }
    // template-quality filter (same as perf-ranking)
    const trades = allMerged.filter(t => t.template && !EXCL.has(t.template));

    // ── 1. template × tier ────────────────────────────────────────────────────
    const byTemplateTier = {};
    for (const [k, ts] of Object.entries(groupBy(trades, t => `${t.template}|${tier(t.htfTier)}`))) {
      const [tmpl, tr] = k.split('|');
      const stats = computeStats(ts);
      byTemplateTier[k] = { template: tmpl, tier: tr, ...stats, verdict: verdictOf(stats) };
    }

    // ── 2. template × session ─────────────────────────────────────────────────
    const byTemplateSession = {};
    for (const [k, ts] of Object.entries(groupBy(trades, t => `${t.template}|${t.session}`))) {
      const [tmpl, sess] = k.split('|');
      const stats = computeStats(ts);
      byTemplateSession[k] = { template: tmpl, session: sess, ...stats, verdict: verdictOf(stats) };
    }

    // ── 3. template × session × tier (finest; may be thin — see verdict) ──────
    const byTemplateSessionTier = {};
    for (const [k, ts] of Object.entries(
      groupBy(trades, t => `${t.template}|${t.session}|${tier(t.htfTier)}`)
    )) {
      const parts = k.split('|');
      const stats = computeStats(ts);
      byTemplateSessionTier[k] = {
        template: parts[0], session: parts[1], tier: parts[2],
        ...stats, verdict: verdictOf(stats),
      };
    }

    // ── 4 & 5. bleeders / keepers / watchlist ────────────────────────────────
    // Sourced from template×tier AND template×session only (not the fine cut).
    const bleeders = [], keepers = [], watchlist = [];

    function classify(b, key, dimension) {
      const v = verdictOf(b);
      const item = {
        verdict: v, dimension, key,
        template:    b.template,
        session:     b.session  ?? null,
        tier:        b.tier     ?? null,
        n:           b.n,
        wins:        b.wins,
        losses:      b.losses,
        winRate:     b.winRate,
        netPnl:      b.netPnl,
        avgR:        b.avgR,
        profitFactor: b.profitFactor,
        breakEvenWR: b.breakEvenWR,
        wrVsBE:      b.wrVsBE,
      };
      if      (v === 'bleeder') bleeders.push(item);
      else if (v === 'keeper')  keepers.push(item);
      else                      watchlist.push(item);
    }

    for (const [k, b] of Object.entries(byTemplateTier))    classify(b, k, 'template×tier');
    for (const [k, b] of Object.entries(byTemplateSession)) classify(b, k, 'template×session');

    // sort: bleeders worst-first, keepers best-first, watchlist most-data-first
    bleeders.sort((a, b) => a.netPnl - b.netPnl);
    keepers.sort((a, b)  => b.netPnl - a.netPnl);
    watchlist.sort((a, b) => b.n - a.n);

    return res.status(200).json({
      ok:          true,
      generatedAt: Date.now(),
      reconciliation: {
        recogInput:  recogFiltered.length,
        ledgerInput: ledgerFiltered.length,
        matched, ledgerOnly, recogOnly,
        total:       allMerged.length,
        rankable:    trades.length,
        filteredOut: allMerged.length - trades.length,
      },
      byTemplateTier,
      byTemplateSession,
      byTemplateSessionTier,
      bleeders,
      keepers,
      watchlist,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
