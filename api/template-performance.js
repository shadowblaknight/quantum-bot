/* eslint-disable */
// api/template-performance.js  (Pilot Dashboard v1.2 — adds bySession)
const { getRedis, safeParse } = require('./_lib');

const POSSIBLE_TRADE_KEYS = ['v12:knn:trades', 'v12:recognition:trades', 'v12:closed-trades'];

async function listAllClosedTrades() {
  try {
    const recmem = require('./recognition-memory');
    if (typeof recmem.listClosedTrades === 'function') {
      const trades = await recmem.listClosedTrades();
      if (Array.isArray(trades)) return trades;
    }
    if (typeof recmem.getAllTrades === 'function') {
      const trades = await recmem.getAllTrades();
      if (Array.isArray(trades)) return trades;
    }
  } catch (_) {}
  const r = getRedis();
  if (!r) return [];
  for (const key of POSSIBLE_TRADE_KEYS) {
    try {
      const raw = await r.get(key);
      const parsed = safeParse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (_) {}
  }
  return [];
}

function templateOf(trade) {
  if (trade.template) return trade.template;
  if (Array.isArray(trade.contributingTactics) && trade.contributingTactics.length > 0) {
    return trade.contributingTactics[0];
  }
  return null;
}

function sessionFromTimestamp(ts) {
  if (!ts || !isFinite(ts)) return 'unknown';
  const d = new Date(ts);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return 'weekend';
  const hour = d.getUTCHours();
  const min  = d.getUTCMinutes();
  const t = hour + min / 60;
  if (t < 6)  return 'asia';
  if (t < 7)  return 'frankfurt-open';
  if (t < 9)  return 'london-open';
  if (t < 12) return 'london-mid';
  if (t < 13) return 'pre-ny';
  if (t < 15) return 'ny-open';
  if (t < 19) return 'ny-mid';
  if (t < 22) return 'ny-late';
  return 'asia';
}

const SESSION_ORDER = [
  'asia', 'frankfurt-open', 'london-open', 'london-mid',
  'pre-ny', 'ny-open', 'ny-mid', 'ny-late', 'weekend', 'unknown',
];

function computeGroupStats(template, trades) {
  if (!trades || trades.length === 0) return null;
  const wins   = trades.filter((t) => (t.pnl || 0) >  0.5);
  const losses = trades.filter((t) => (t.pnl || 0) < -0.5);
  const breakevens = trades.filter((t) => Math.abs(t.pnl || 0) <= 0.5);
  const decided = wins.length + losses.length;
  const winRate = decided > 0 ? wins.length / decided : 0;
  const totalPnL = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossWins   = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? null : 0);

  const rValues = trades.map((t) => {
    const risk = Math.abs(t.riskDollars || 0);
    if (risk === 0) return 0;
    return (t.pnl || 0) / risk;
  });
  const avgR = rValues.length > 0 ? rValues.reduce((s, x) => s + x, 0) / rValues.length : 0;

  const byAsset = {};
  for (const t of trades) {
    if (!t.asset) continue;
    if (!byAsset[t.asset]) byAsset[t.asset] = { wins: 0, losses: 0, be: 0, pnl: 0, count: 0 };
    const pnl = t.pnl || 0;
    byAsset[t.asset].pnl += pnl;
    byAsset[t.asset].count++;
    if (pnl > 0.5) byAsset[t.asset].wins++;
    else if (pnl < -0.5) byAsset[t.asset].losses++;
    else byAsset[t.asset].be++;
  }

  const bySession = {};
  for (const t of trades) {
    const session = sessionFromTimestamp(t.openedAt || t.closedAt);
    if (!bySession[session]) bySession[session] = { wins: 0, losses: 0, be: 0, pnl: 0, count: 0 };
    const pnl = t.pnl || 0;
    bySession[session].pnl += pnl;
    bySession[session].count++;
    if (pnl > 0.5) bySession[session].wins++;
    else if (pnl < -0.5) bySession[session].losses++;
    else bySession[session].be++;
  }

  for (const key of Object.keys(bySession)) {
    bySession[key].pnl = round2(bySession[key].pnl);
    bySession[key].winRate = (bySession[key].wins + bySession[key].losses) > 0
      ? round4(bySession[key].wins / (bySession[key].wins + bySession[key].losses)) : 0;
  }
  for (const key of Object.keys(byAsset)) {
    byAsset[key].pnl = round2(byAsset[key].pnl);
    byAsset[key].winRate = (byAsset[key].wins + byAsset[key].losses) > 0
      ? round4(byAsset[key].wins / (byAsset[key].wins + byAsset[key].losses)) : 0;
  }

  const sortedByTime = [...trades].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  const recent = sortedByTime.slice(-10);
  const recentWins   = recent.filter((t) => (t.pnl || 0) >  0.5).length;
  const recentLosses = recent.filter((t) => (t.pnl || 0) < -0.5).length;
  const recentDecided = recentWins + recentLosses;
  const recentWinRate = recentDecided > 0 ? recentWins / recentDecided : winRate;

  let trend = 'stable';
  if (recentDecided >= 3) {
    if (recentWinRate > winRate * 1.15) trend = 'improving';
    else if (recentWinRate < winRate * 0.85) trend = 'declining';
  } else if (trades.length < 5) trend = 'insufficient-data';

  let verdict;
  if (trades.length < 10) verdict = 'too-few-trades';
  else if (winRate >= 0.5 && profitFactor >= 1.5) verdict = 'profitable';
  else if (winRate >= 0.4 && profitFactor >= 1.2) verdict = 'marginal';
  else verdict = 'underperforming';

  return {
    template,
    sampleSize: trades.length,
    wins: wins.length, losses: losses.length, breakevens: breakevens.length,
    winRate: round4(winRate),
    avgR: round4(avgR),
    totalPnL: round2(totalPnL),
    profitFactor: profitFactor == null ? null : round4(profitFactor),
    grossWins: round2(grossWins),
    grossLosses: round2(grossLosses),
    recentWinRate: round4(recentWinRate),
    trend, verdict,
    byAsset, bySession,
    sessionOrder: SESSION_ORDER,
    lastTradeAt: sortedByTime.length > 0 ? (sortedByTime[sortedByTime.length - 1].closedAt || null) : null,
    firstTradeAt: sortedByTime.length > 0 ? (sortedByTime[0].openedAt || sortedByTime[0].closedAt || null) : null,
  };
}

async function computeTemplatePerformance() {
  const trades = await listAllClosedTrades();
  if (!Array.isArray(trades) || trades.length === 0) {
    return { ok: true, templates: [], totalTrades: 0, message: 'no closed trades yet — gather demo data first' };
  }
  const byTemplate = {};
  for (const t of trades) {
    const tmpl = templateOf(t);
    if (!tmpl) continue;
    if (!byTemplate[tmpl]) byTemplate[tmpl] = [];
    byTemplate[tmpl].push(t);
  }
  const stats = Object.entries(byTemplate)
    .map(([tmpl, group]) => computeGroupStats(tmpl, group))
    .filter(Boolean)
    .sort((a, b) => b.sampleSize - a.sampleSize);
  const overall = {
    totalTrades: trades.length,
    totalPnL: round2(trades.reduce((s, t) => s + (t.pnl || 0), 0)),
    overallWinRate: (() => {
      const w = trades.filter((t) => (t.pnl || 0) > 0.5).length;
      const l = trades.filter((t) => (t.pnl || 0) < -0.5).length;
      return (w + l) > 0 ? round4(w / (w + l)) : 0;
    })(),
  };
  return { ok: true, templates: stats, overall, computedAt: Date.now() };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function round4(n) { return Math.round((n || 0) * 10000) / 10000; }

module.exports = { computeTemplatePerformance, listAllClosedTrades, sessionFromTimestamp };