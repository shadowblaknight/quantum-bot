'use strict';
// api/ledger.js — P&L + cost ledger for Quantum Bot (v14)
//
// Stores one record per closed trade at v14:ledger:trade:{id}.
// Index at v14:ledger:index (closedAt desc, capped at 2000).
// Entirely separate from recognition-memory — does not read or write v12:trades:* keys.
//
// Called from manage-trades.js detectAndProcessClosed (wrapped in try/catch).
// HTTP: GET /api/ledger?action=summary[&since=YYYY-MM-DD]
//              action=list[&limit=N]
//              action=backfill&key=WEBHOOK_API_KEY[&days=N]

const { getRedis, safeParse } = require('./_lib');
const { getAssetById } = require('./asset-registry');

const LEDGER_TRADE_KEY  = (id) => `v14:ledger:trade:${id}`;
const LEDGER_INDEX_KEY  = 'v14:ledger:index';
const INDEX_CAP         = 2000;

// ── template name parser for backfill ────────────────────────────────
// Handles both execute.js format (QB-V12-DAY-silver-bullet) and
// webhook format (QB-V13-ote-continuation-, QB-V13-silver-bullet-NY_PM).
const KNOWN_TEMPLATES = [
  'ote-continuation', 'silver-bullet', 'judas-swing', 'turtle-soup', 'unicorn',
  'reaction-fvg', 'reaction-ifvg', 'reaction', 'alexg', 'ict-ote', 'ict',
];

function parseTemplateFromComment(comment) {
  if (!comment || !comment.startsWith('QB-V')) return null;
  let s = comment.replace(/^QB-V\d+-/, '').replace(/^(DAY|SWING|SCALP)-/, '');
  for (const t of KNOWN_TEMPLATES) {
    if (s === t || s.startsWith(t + '-') || s.startsWith(t)) return t;
  }
  // fallback: strip trailing UPPERCASE/digit suffixes (session labels etc.)
  return s.replace(/-[A-Z0-9_]+$/, '').replace(/-+$/, '').slice(0, 40) || null;
}

// ── build a ledger record from live-close context ─────────────────────
// Called only when we have the full in-scope variables from detectAndProcessClosed.
function buildLedgerRecord({ state, matchedPending, positionDeals, positionId }) {
  const entryDeal = positionDeals.find(d => d.entryType === 'DEAL_ENTRY_IN');
  const exitDeals = positionDeals.filter(d =>
    d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT'
  );
  const exitDeal = exitDeals[exitDeals.length - 1] || null;

  const grossPnl   = positionDeals.reduce((s, d) => s + (d.profit     || 0), 0);
  const commission = positionDeals.reduce((s, d) => s + (d.commission || 0), 0);
  const swap       = positionDeals.reduce((s, d) => s + (d.swap       || 0), 0);
  const netPnl     = grossPnl + commission + swap;

  const actualEntry  = state.entry;
  const plannedEntry = matchedPending ? matchedPending.plannedEntry : null;
  const assetMeta    = getAssetById(state.asset);
  const pipSize      = assetMeta ? assetMeta.pipSize : 0.0001;
  const slippageRaw  = (actualEntry != null && plannedEntry != null)
    ? actualEntry - plannedEntry : null;
  const slippagePips = slippageRaw != null
    ? Math.round((slippageRaw / pipSize) * 10) / 10 : null;

  const riskDollars = matchedPending && matchedPending.sizing
    ? matchedPending.sizing.baseRisk : null;
  const pnlR    = (riskDollars > 0) ? netPnl / riskDollars : null;
  const outcome = netPnl > 0.5 ? 'WIN' : netPnl < -0.5 ? 'LOSS' : 'BREAKEVEN';

  const openedAt = entryDeal
    ? entryDeal.time
    : (state.createdAt ? new Date(state.createdAt).toISOString() : null);
  const closedAt = exitDeal
    ? exitDeal.time
    : new Date().toISOString();
  const holdTimeMinutes = (openedAt && closedAt)
    ? Math.round((new Date(closedAt) - new Date(openedAt)) / 60000) : null;

  const setup = matchedPending && matchedPending.setup ? matchedPending.setup : {};

  return {
    id:          `trade_${state.asset}_${positionId}`,
    asset:       state.asset,
    symbol:      entryDeal ? entryDeal.symbol : null,
    direction:   state.direction,
    template:    setup.template || (setup.contributingTactics || [])[0] || null,
    style:       setup.style    || null,
    session:     setup.session  || null,
    lot:         entryDeal ? entryDeal.volume : (state.originalLot || null),
    plannedEntry,
    actualEntry,
    slippage:     slippageRaw != null ? Math.round(slippageRaw * 1e5) / 1e5 : null,
    slippagePips,
    exitPrice:   exitDeal ? exitDeal.price  : null,
    exitReason:  exitDeal ? exitDeal.reason : null,
    slPrice:     entryDeal
      ? (entryDeal.stopLoss || null)
      : (matchedPending ? matchedPending.slPrice : null),
    tpsHit:      state.tpsHit || [],
    maxTP:       (state.tpsHit || []).reduce(
      (m, n) => Math.max(m, parseInt(String(n).slice(2), 10) || 0), 0
    ),
    grossPnl:    r2(grossPnl),
    commission:  r2(commission),
    swap:        r2(swap),
    netPnl:      r2(netPnl),
    spreadEstPips: null,
    riskDollars,
    pnlR:        pnlR != null ? r2(pnlR) : null,
    outcome,
    openedAt,
    closedAt,
    holdTimeMinutes,
    accountCurrencyExchangeRate:
      (exitDeal || entryDeal || {}).accountCurrencyExchangeRate || null,
    _backfilled: false,
  };
}

// ── write one ledger record (manage-trades.js entry point) ────────────
async function writeLedgerRecord(args) {
  const r = getRedis();
  if (!r) return { error: 'redis unavailable' };
  try {
    const record = buildLedgerRecord(args);
    await r.set(LEDGER_TRADE_KEY(record.id), JSON.stringify(record));
    await _appendToIndex(r, record);
    return { ok: true, id: record.id };
  } catch (e) {
    return { error: e.message };
  }
}

// ── append one entry to the sorted index ─────────────────────────────
async function _appendToIndex(r, { id, closedAt, asset, template }) {
  const indexRaw = await r.get(LEDGER_INDEX_KEY).catch(() => null);
  const index    = safeParse(indexRaw) || [];
  const next     = index.filter(e => e.id !== id);
  next.push({ id, closedAt, asset, template });
  next.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  await r.set(LEDGER_INDEX_KEY, JSON.stringify(next.slice(0, INDEX_CAP)));
}

// ── bulk-fetch records via pipeline ───────────────────────────────────
async function _fetchRecords(r, index) {
  if (!index.length) return [];
  try {
    const pipe    = r.pipeline();
    for (const e of index) pipe.get(LEDGER_TRADE_KEY(e.id));
    const results = await pipe.exec();
    return results
      .map(raw => {
        if (!raw) return null;
        const v = typeof raw === 'string' ? safeParse(raw) : raw;
        return (v && typeof v === 'object') ? v : null;
      })
      .filter(Boolean);
  } catch (_) {
    // pipeline unavailable — sequential fallback
    const out = [];
    for (const e of index) {
      const raw = await r.get(LEDGER_TRADE_KEY(e.id)).catch(() => null);
      const v   = raw && typeof raw === 'string' ? safeParse(raw) : raw;
      if (v) out.push(v);
    }
    return out;
  }
}

// ── compute summary ───────────────────────────────────────────────────
async function computeSummary({ since } = {}) {
  const r = getRedis();
  if (!r) return { error: 'redis unavailable' };

  const indexRaw = await r.get(LEDGER_INDEX_KEY).catch(() => null);
  let index = safeParse(indexRaw) || [];

  if (since) {
    const sinceMs = new Date(since).getTime();
    if (!isNaN(sinceMs)) index = index.filter(e => new Date(e.closedAt).getTime() >= sinceMs);
  }

  const records = await _fetchRecords(r, index);
  if (!records.length) return { trades: 0, since: since || null };

  const wins     = records.filter(t => t.outcome === 'WIN');
  const losses   = records.filter(t => t.outcome === 'LOSS');
  const brkevens = records.filter(t => t.outcome === 'BREAKEVEN');

  const totalGross = records.reduce((s, t) => s + (t.grossPnl   || 0), 0);
  const totalComm  = records.reduce((s, t) => s + (t.commission || 0), 0);
  const totalSwap  = records.reduce((s, t) => s + (t.swap       || 0), 0);
  const totalNet   = records.reduce((s, t) => s + (t.netPnl     || 0), 0);

  const winAmts    = wins.map(t => t.netPnl || 0);
  const lossAmts   = losses.map(t => Math.abs(t.netPnl || 0));
  const winRs      = wins.filter(t => t.pnlR != null).map(t => t.pnlR);
  const lossRs     = losses.filter(t => t.pnlR != null).map(t => Math.abs(t.pnlR));

  const avgWinDollar  = _avg(winAmts);
  const avgLossDollar = _avg(lossAmts);
  const avgWinR       = _avg(winRs);
  const avgLossR      = _avg(lossRs);

  const winRate = records.length > 0 ? wins.length / records.length : null;

  // break-even WR: the win rate that makes expectancy exactly zero
  //   E = WR × avgWin − (1−WR) × avgLoss = 0  →  WR = avgLoss / (avgWin + avgLoss)
  const breakEvenWR = (avgWinDollar != null && avgLossDollar != null &&
                       avgWinDollar + avgLossDollar > 0)
    ? avgLossDollar / (avgWinDollar + avgLossDollar) : null;

  const slipRecs = records.filter(t => t.slippagePips != null);

  // per-template breakdown (worst net first)
  const byTemplate = _groupBy(records, t => t.template || 'unknown');
  const templateBreakdown = Object.entries(byTemplate)
    .map(([k, ts]) => _breakdownGroup('template', k, ts))
    .sort((a, b) => a.netPnl - b.netPnl);

  // per-instrument breakdown (worst net first)
  const byAsset = _groupBy(records, t => t.asset || 'unknown');
  const instrumentBreakdown = Object.entries(byAsset)
    .map(([k, ts]) => _breakdownGroup('asset', k, ts))
    .sort((a, b) => a.netPnl - b.netPnl);

  return {
    since: since || null,
    overall: {
      trades:          records.length,
      wins:            wins.length,
      losses:          losses.length,
      breakevens:      brkevens.length,
      winRate:         r3(winRate),
      grossPnl:        r2(totalGross),
      totalCommission: r2(totalComm),
      totalSwap:       r2(totalSwap),
      netPnl:          r2(totalNet),
      avgWinDollar:    avgWinDollar  != null ? r2(avgWinDollar)  : null,
      avgLossDollar:   avgLossDollar != null ? r2(avgLossDollar) : null,
      avgWinR:         avgWinR       != null ? r2(avgWinR)       : null,
      avgLossR:        avgLossR      != null ? r2(avgLossR)      : null,
      largestWin:      winAmts.length  ? r2(Math.max(...winAmts))  : null,
      largestLoss:     lossAmts.length ? r2(Math.max(...lossAmts)) : null,
      breakEvenWR:     r3(breakEvenWR),
      currentWRvsBreakEven: (winRate != null && breakEvenWR != null)
        ? r3(winRate - breakEvenWR) : null,
      avgSlippagePips:     slipRecs.length
        ? Math.round(_avg(slipRecs.map(t => t.slippagePips)) * 10) / 10 : null,
      slippageSampleSize: slipRecs.length,
    },
    byTemplate:    templateBreakdown,
    byInstrument:  instrumentBreakdown,
  };
}

// ── one-shot backfill from MetaAPI deal history ───────────────────────
async function backfillFromMetaAPI({ days = 60 } = {}) {
  const { resolveAsset } = require('./symbol-resolver');

  const token     = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region    = process.env.METAAPI_REGION || 'london';
  if (!token || !accountId) throw new Error('METAAPI_TOKEN or METAAPI_ACCOUNT_ID missing');

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const until = new Date().toISOString();
  const url   = `https://mt-client-api-v1.${region}.agiliumtrade.ai`
              + `/users/current/accounts/${accountId}/history-deals/time/${since}/${until}`;

  const resp = await fetch(url, {
    headers: { 'auth-token': token, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`MetaAPI ${resp.status}: ${body.slice(0, 200)}`);
  }
  const deals = await resp.json();
  if (!Array.isArray(deals)) throw new Error('MetaAPI returned non-array');

  // group by positionId, skip balance/credit entries
  const byPos = {};
  for (const d of deals) {
    if (!d.positionId || d.type === 'DEAL_TYPE_BALANCE' || d.type === 'DEAL_TYPE_CREDIT') continue;
    (byPos[d.positionId] = byPos[d.positionId] || []).push(d);
  }

  const r = getRedis();
  const indexRaw    = await r.get(LEDGER_INDEX_KEY).catch(() => null);
  const existIdx    = safeParse(indexRaw) || [];
  const existingIds = new Set(existIdx.map(e => e.id));

  const newRecords = [];
  let skipped = 0, already = 0;

  for (const [positionId, posDeals] of Object.entries(byPos)) {
    const entryDeal = posDeals.find(d => d.entryType === 'DEAL_ENTRY_IN');
    const exitDeals = posDeals.filter(d =>
      d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT'
    );
    if (!entryDeal || !exitDeals.length) { skipped++; continue; }

    const comment = entryDeal.comment || '';
    if (!comment.startsWith('QB-V')) { skipped++; continue; }

    let asset = null;
    try { asset = await resolveAsset(entryDeal.symbol); } catch (_) {}
    if (!asset) { skipped++; continue; }

    const tradeId = `trade_${asset}_${positionId}`;
    if (existingIds.has(tradeId)) { already++; continue; }

    // enrich from recognition-memory if available (template, style, session, tpsHit, riskDollars)
    let mem = null;
    try {
      const memRaw = await r.get(`v12:trades:closed:${tradeId}`).catch(() => null);
      mem = safeParse(memRaw);
    } catch (_) {}

    const grossPnl   = posDeals.reduce((s, d) => s + (d.profit     || 0), 0);
    const commission = posDeals.reduce((s, d) => s + (d.commission || 0), 0);
    const swap       = posDeals.reduce((s, d) => s + (d.swap       || 0), 0);
    const netPnl     = grossPnl + commission + swap;
    const exitDeal   = exitDeals[exitDeals.length - 1];
    const direction  = entryDeal.type === 'DEAL_TYPE_BUY' ? 'LONG' : 'SHORT';
    const template   = (mem && mem.template) || parseTemplateFromComment(comment);
    const riskDollars = (mem && mem.riskDollars) || null;
    const pnlR = riskDollars > 0
      ? netPnl / riskDollars
      : ((mem && mem.pnlR != null) ? mem.pnlR : null);
    const outcome = netPnl > 0.5 ? 'WIN' : netPnl < -0.5 ? 'LOSS' : 'BREAKEVEN';
    const holdTimeMinutes = (entryDeal.time && exitDeal.time)
      ? Math.round((new Date(exitDeal.time) - new Date(entryDeal.time)) / 60000) : null;

    newRecords.push({
      id:          tradeId,
      asset,
      symbol:      entryDeal.symbol,
      direction,
      template,
      style:       (mem && mem.style)   || null,
      session:     (mem && mem.session) || null,
      lot:         entryDeal.volume,
      plannedEntry: null,  // not available for historical trades
      actualEntry:  entryDeal.price,
      slippage:    null,
      slippagePips: null,
      exitPrice:   exitDeal.price,
      exitReason:  exitDeal.reason,
      slPrice:     entryDeal.stopLoss || null,
      tpsHit:      (mem && Array.isArray(mem.tpsHit)) ? mem.tpsHit : [],
      maxTP:       (mem && mem.maxTP != null) ? mem.maxTP : 0,
      grossPnl:    r2(grossPnl),
      commission:  r2(commission),
      swap:        r2(swap),
      netPnl:      r2(netPnl),
      spreadEstPips: null,
      riskDollars,
      pnlR:        pnlR != null ? r2(pnlR) : null,
      outcome,
      openedAt:    entryDeal.time,
      closedAt:    exitDeal.time,
      holdTimeMinutes,
      accountCurrencyExchangeRate: exitDeal.accountCurrencyExchangeRate || null,
      _backfilled: true,
    });
  }

  // batch-write all records via pipeline
  if (r && newRecords.length) {
    const writePipe = r.pipeline();
    for (const rec of newRecords) {
      writePipe.set(LEDGER_TRADE_KEY(rec.id), JSON.stringify(rec));
    }
    await writePipe.exec();

    // single index update
    const newIds = new Set(newRecords.map(rr => rr.id));
    const merged = [
      ...existIdx.filter(e => !newIds.has(e.id)),
      ...newRecords.map(rr => ({ id: rr.id, closedAt: rr.closedAt, asset: rr.asset, template: rr.template })),
    ];
    merged.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
    await r.set(LEDGER_INDEX_KEY, JSON.stringify(merged.slice(0, INDEX_CAP)));
  }

  return {
    written:  newRecords.length,
    skipped,
    already,
    total:    Object.keys(byPos).length,
  };
}

// ── HTTP handler ──────────────────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const q      = (req && req.query) || {};
    const action = String(q.action || 'summary');

    if (action === 'summary') {
      return res.status(200).json(
        await computeSummary({ since: q.since ? String(q.since) : undefined })
      );
    }

    if (action === 'list') {
      const limit = Math.min(parseInt(q.limit || '100', 10), 500);
      const r = getRedis();
      if (!r) return res.status(500).json({ error: 'redis unavailable' });
      const indexRaw = await r.get(LEDGER_INDEX_KEY).catch(() => null);
      const slice    = (safeParse(indexRaw) || []).slice(0, limit);
      const records  = await _fetchRecords(r, slice);
      return res.status(200).json({ count: records.length, trades: records });
    }

    if (action === 'backfill') {
      const key = String(q.key || '');
      if (!process.env.WEBHOOK_API_KEY || key !== process.env.WEBHOOK_API_KEY) {
        return res.status(401).json({ error: 'unauthorized — pass ?key=WEBHOOK_API_KEY' });
      }
      const days = Math.min(parseInt(q.days || '60', 10), 365);
      const result = await backfillFromMetaAPI({ days });
      return res.status(200).json({ ok: true, ...result });
    }

    return res.status(400).json({
      error: 'unknown action',
      valid: ['summary', 'list', 'backfill'],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.writeLedgerRecord   = writeLedgerRecord;
module.exports.computeSummary      = computeSummary;
module.exports.backfillFromMetaAPI = backfillFromMetaAPI;

// ── helpers ───────────────────────────────────────────────────────────
function r2(x)   { return (x == null || !isFinite(x)) ? 0  : Math.round(x * 100)  / 100; }
function r3(x)   { return (x == null || !isFinite(x)) ? null : Math.round(x * 1000) / 1000; }
function _avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }
function _groupBy(arr, fn) {
  const g = {};
  for (const item of arr) { const k = fn(item); (g[k] = g[k] || []).push(item); }
  return g;
}
function _breakdownGroup(keyName, label, trades) {
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const net    = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
  const rs     = trades.filter(t => t.pnlR != null).map(t => t.pnlR);
  const slips  = trades.filter(t => t.slippagePips != null).map(t => t.slippagePips);
  return {
    [keyName]:       label,
    trades:          trades.length,
    wins:            wins.length,
    losses:          losses.length,
    winRate:         r3(trades.length > 0 ? wins.length / trades.length : null),
    netPnl:          r2(net),
    avgR:            _avg(rs) != null ? r2(_avg(rs)) : null,
    avgSlippagePips: slips.length ? Math.round(_avg(slips) * 10) / 10 : null,
  };
}
