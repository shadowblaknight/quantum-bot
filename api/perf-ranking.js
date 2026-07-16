/* eslint-disable */
// api/perf-ranking.js  v15.6
// GET /api/perf-ranking
//
// Deduped performance ranking: recognition-memory (v12) ∪ ledger (v14).
// Join key: trade.id = "trade_{asset}_{positionId}" — deterministic, no fuzzy.
//   Evidence: ledger.js backfill line 351 already cross-references recognition-memory
//   using this exact key format → both stores share the same id convention.
// Merge: ledger = P&L source-of-truth (real netPnl/commission/slippage).
//        recognition-memory enriches metadata (entryType/htfTier/pnlR fallback).
// Session: always re-derived from openedAt UTC — stored field is unreliable.
// Returns reconciliation stats + flat deduped trade list; client does bucketing.

const { applyCors, getRedis, safeParse } = require('./_lib');
const { getAllTrades }                    = require('./recognition-memory');

const LEDGER_INDEX_KEY = 'v14:ledger:index';
const LEDGER_TRADE_KEY = (id) => `v14:ledger:trade:${id}`;

function classifySession(openedAt) {
  if (!openedAt) return 'UNKNOWN';
  const ms = typeof openedAt === 'number' ? openedAt : new Date(openedAt).getTime();
  if (!isFinite(ms)) return 'UNKNOWN';
  const d   = new Date(ms);
  const day = d.getUTCDay();
  const h   = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 0 || day === 6) return 'WEEKEND';
  if (h >= 23 || h < 8)      return 'ASIAN';
  if (h >= 8  && h < 13)     return 'LONDON';
  if (h >= 13 && h < 16)     return 'NY_AM';
  if (h >= 16 && h < 21)     return 'NY_PM';
  return 'OFF';
}

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

function mergeRecord(ledger, recog) {
  const l = ledger, r = recog;
  const openedAt = l?.openedAt ?? r?.openedAt ?? null;
  return {
    id:           l?.id           ?? r?.id,
    asset:        l?.asset        ?? r?.asset        ?? 'unknown',
    direction:    l?.direction    ?? r?.direction    ?? null,
    template:     l?.template     || r?.template     || 'unknown',
    session:      classifySession(openedAt),
    htfTier:      l?.htfTier      ?? r?.htfTier      ?? null,
    entryType:    r?.entryType                       ?? null,
    netPnl:       l?.netPnl       ?? r?.pnl          ?? 0,
    commission:   l?.commission                      ?? 0,
    slippagePips: l?.slippagePips                    ?? null,
    pnlR:         l?.pnlR         ?? r?.pnlR         ?? null,
    outcome:      l?.outcome      ?? r?.outcome      ?? 'BREAKEVEN',
    openedAt,
    closedAt:     l?.closedAt     ?? r?.closedAt     ?? null,
    _source:      l && r ? 'both' : l ? 'ledger' : 'recog',
  };
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    const [recogRaw, ledgerRaw] = await Promise.all([
      getAllTrades(1000).catch(() => []),
      loadAllLedger(r).catch(() => []),
    ]);

    // Match session-heatmap filter: exclude deleted + legacy ids (not synthetic — consistent with ~176 count)
    const recogFiltered = recogRaw.filter(t =>
      !t.deleted &&
      !String(t.id || '').includes('legacy')
    );
    // Exclude legacy MetaAPI backfill trades (pre-versioning "QuantumBot" comment)
    const ledgerFiltered = ledgerRaw.filter(t => !t._legacy);

    const recogMap  = new Map(recogFiltered.map(t => [t.id, t]));
    const ledgerMap = new Map(ledgerFiltered.map(t => [t.id, t]));

    // Union-dedupe: each real trade appears exactly once
    const allIds = new Set([...recogMap.keys(), ...ledgerMap.keys()]);
    let matched = 0, ledgerOnly = 0, recogOnly = 0;
    const trades = [];

    for (const id of allIds) {
      const recog  = recogMap.get(id)  ?? null;
      const ledger = ledgerMap.get(id) ?? null;
      if (recog && ledger)  matched++;
      else if (ledger)       ledgerOnly++;
      else                   recogOnly++;
      trades.push(mergeRecord(ledger, recog));
    }

    // Newest-first for UI display
    trades.sort((a, b) => {
      const ta = a.closedAt ? new Date(a.closedAt).getTime() : 0;
      const tb = b.closedAt ? new Date(b.closedAt).getTime() : 0;
      return tb - ta;
    });

    return res.status(200).json({
      ok:          true,
      generatedAt: Date.now(),
      reconciliation: {
        recogInput:  recogFiltered.length,
        ledgerInput: ledgerFiltered.length,
        matched,
        ledgerOnly,
        recogOnly,
        total:       trades.length,
      },
      trades,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
