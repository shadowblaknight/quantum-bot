/* eslint-disable */
// api/dashboard-feed.js  (Pilot Dashboard v1.1)
const { applyCors, getRedis, safeParse, getCurrentSession } = require('./_lib');
const {
  getRules, setRules, updateInstrumentRule, setActiveMode, setTradingMode,
  emergencyStopAll, getActivity, getTodaysPnL,
} = require('./rules-store');
const { fetchAccount, fetchPositions } = require('./broker');
const { computeDailyPivots } = require('./pivots');
const { getPendingSetups, getCommentary } = require('./watcher');
const { computeTemplatePerformance } = require('./template-performance');
const { getActiveWatched, removeWatchedSetup } = require('./watched-setups');

const KNOWN_ASSETS = ['gold','eurusd','gbpusd','usdjpy','nas100','us500','btc'];

function ok(data) { return { ok: true, ...data }; }
function err(message, code = 400) { return { ok: false, error: message, code }; }
function round2(n) { return Math.round((n || 0) * 100) / 100; }

async function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function actionSummary() {
  const [account, positions, todaysPnL] = await Promise.all([
    withTimeout(fetchAccount(), 2000, null),
    withTimeout(fetchPositions(), 2000, []),
    getTodaysPnL(),
  ]);
  const rules = await getRules();
  const balance = account ? (account.balance || account.equity || 0) : 0;
  const equity = account ? (account.equity || balance) : 0;
  const freeMargin = account ? (account.freeMargin || equity) : 0;
  const managedPositions = (positions || []).filter((p) =>
    p.comment && (p.comment.startsWith('QB-V12-') || p.comment.startsWith('QB-V13-')));
  const watched = await getActiveWatched();
  const watchingCount = watched.filter((w) => w.status === 'watching').length;
  const alertedCount = watched.filter((w) => w.status === 'alerted').length;

  return ok({
    account: {
      balance: round2(balance), equity: round2(equity), freeMargin: round2(freeMargin),
      todaysPnL: round2(todaysPnL),
      todaysPnLPct: balance > 0 ? round2((todaysPnL / balance) * 100) : 0,
    },
    positions: { open: managedPositions.length, total: (positions || []).length },
    watched: { watching: watchingCount, alerted: alertedCount, total: watched.length },
    tradingMode: rules.tradingMode || 'auto',
    activeMode: rules.activeMode || 'active',
    emergencyStop: rules.account.emergencyStop || false,
    session: getCurrentSession(),
    ts: Date.now(),
  });
}

async function actionRules() { return ok({ rules: await getRules() }); }

async function actionSetRules(body) {
  if (!body || !body.rules) return err('missing rules in body');
  const result = await setRules({ ...body.rules, modifiedBy: body.modifiedBy || 'dashboard' });
  if (!result.ok) return err(result.error, 500);
  return ok({ rules: result.rules });
}

async function actionSetInstrument(body) {
  if (!body || !body.assetId || !body.patch) return err('missing assetId or patch');
  const result = await updateInstrumentRule(body.assetId, body.patch);
  if (!result.ok) return err(result.error, 500);
  return ok({ rules: result.rules });
}

async function actionSetMode(body) {
  if (!body || !body.mode) return err('missing mode');
  const result = await setActiveMode(body.mode);
  if (!result.ok) return err(result.error, 500);
  return ok({ rules: result.rules });
}

async function actionSetTradingMode(body) {
  if (!body || !body.mode) return err('missing mode');
  const result = await setTradingMode(body.mode);
  if (!result.ok) return err(result.error, 500);
  return ok({ rules: result.rules, tradingMode: body.mode });
}

async function actionEmergencyStop(body) {
  const enable = !!(body && body.enable);
  const result = await emergencyStopAll(enable);
  if (!result.ok) return err(result.error, 500);
  return ok({ rules: result.rules, emergencyStop: enable });
}

async function actionPositions() {
  const [positions, account] = await Promise.all([
    withTimeout(fetchPositions(), 2000, []),
    withTimeout(fetchAccount(), 2000, null),
  ]);
  const managed = (positions || []).filter((p) =>
    p.comment && (p.comment.startsWith('QB-V12-') || p.comment.startsWith('QB-V13-')));
  const enriched = managed.map((pos) => {
    let template = null;
    if (pos.comment) {
      const parts = pos.comment.split('-');
      if (parts.length >= 3) template = parts.slice(2, -1).join('-') || parts[2];
    }
    return {
      id: pos.id, symbol: pos.symbol,
      direction: pos.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT',
      volume: pos.volume, openPrice: pos.openPrice, currentPrice: pos.currentPrice,
      stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
      profit: round2(pos.profit || 0), swap: round2(pos.swap || 0), commission: round2(pos.commission || 0),
      template, comment: pos.comment, openTime: pos.time,
    };
  });
  return ok({ positions: enriched, count: enriched.length,
    accountEquity: account ? account.equity : null, ts: Date.now() });
}

async function actionHistory() {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region = process.env.METAAPI_REGION || 'london';
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const until = new Date().toISOString();
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time/${since}/${until}`;
  try {
    const resp = await fetch(url, { headers: { 'auth-token': token, 'Accept': 'application/json' } });
    if (!resp.ok) return err('failed to fetch history', 500);
    const deals = await resp.json();
    if (!Array.isArray(deals)) return ok({ history: [] });
    const qbDeals = deals.filter((d) => d.comment && (d.comment.startsWith('QB-V12-') || d.comment.startsWith('QB-V13-')));
    const grouped = {};
    for (const d of qbDeals) {
      const pid = d.positionId;
      if (!pid) continue;
      if (!grouped[pid]) grouped[pid] = { positionId: pid, deals: [], totalPnL: 0, symbol: d.symbol, comment: d.comment };
      grouped[pid].deals.push(d);
      grouped[pid].totalPnL += (d.profit || 0) + (d.commission || 0) + (d.swap || 0);
    }
    const history = Object.values(grouped).map((g) => {
      const sorted = g.deals.sort((a, b) => new Date(a.time) - new Date(b.time));
      const opening = sorted[0], closing = sorted[sorted.length - 1];
      let template = null;
      if (g.comment) {
        const parts = g.comment.split('-');
        if (parts.length >= 3) template = parts.slice(2, -1).join('-') || parts[2];
      }
      return {
        positionId: g.positionId, symbol: g.symbol, template,
        direction: opening.type === 'DEAL_TYPE_BUY' ? 'LONG' : 'SHORT',
        openTime: opening.time, closeTime: closing.time,
        openPrice: opening.price, closePrice: closing.price,
        totalPnL: round2(g.totalPnL), dealCount: g.deals.length,
      };
    }).sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));
    return ok({ history, count: history.length });
  } catch (e) { return err(e.message, 500); }
}

async function actionPivots(_body, query) {
  const assetId = query.asset;
  if (!assetId) return err('missing asset param');
  if (!KNOWN_ASSETS.includes(assetId)) return err(`unknown asset: ${assetId}`);
  const pivots = await computeDailyPivots(assetId);
  if (!pivots) return err('no candle data available', 404);
  return ok({ pivots });
}

async function actionActivity(_body, query) {
  const limit = Math.min(parseInt(query.limit) || 50, 200);
  const activity = await getActivity(limit);
  return ok({ activity, count: activity.length });
}

async function actionCommentary(_body, query) {
  const assetId = query.asset;
  if (!assetId) return err('missing asset param');
  const events = await getCommentary(assetId, 50);
  return ok({ events, count: events.length });
}

async function actionPending(_body, query) {
  const assetId = query.asset;
  if (assetId) {
    const list = await getPendingSetups(assetId);
    return ok({ assetId, pending: list.filter((p) => p.status === 'placed' || p.status === 'filled') });
  }
  const all = {};
  for (const a of KNOWN_ASSETS) {
    const list = await getPendingSetups(a);
    all[a] = list.filter((p) => p.status === 'placed' || p.status === 'filled');
  }
  return ok({ pending: all });
}

async function actionTemplatePerformance() {
  const stats = await computeTemplatePerformance();
  return ok(stats);
}

async function actionWatchedSetups() {
  const list = await getActiveWatched();
  return ok({ watched: list, count: list.length });
}

async function actionCancelWatched(body) {
  if (!body || !body.id) return err('missing id');
  const result = await removeWatchedSetup(body.id);
  if (!result.ok) return err('cancel failed', 500);
  return ok({ removed: body.id });
}

const ACTIONS = {
  'summary': actionSummary, 'rules': actionRules,
  'positions': actionPositions, 'history': actionHistory,
  'pivots': actionPivots, 'activity': actionActivity,
  'commentary': actionCommentary, 'pending': actionPending,
  'template-performance': actionTemplatePerformance,
  'watched-setups': actionWatchedSetups,
  'set-rules': actionSetRules, 'set-instrument': actionSetInstrument,
  'set-mode': actionSetMode, 'set-trading-mode': actionSetTradingMode,
  'emergency-stop': actionEmergencyStop, 'cancel-watched': actionCancelWatched,
};

const WRITE_ACTIONS = new Set([
  'set-rules','set-instrument','set-mode','set-trading-mode','emergency-stop','cancel-watched',
]);

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const action = (req.query && req.query.action) || (req.body && req.body.action);
  if (!action) return res.status(400).json({ ok: false, error: 'missing action param' });
  const handler = ACTIONS[action];
  if (!handler) {
    return res.status(400).json({ ok: false, error: `unknown action: ${action}`, available: Object.keys(ACTIONS) });
  }
  if (WRITE_ACTIONS.has(action) && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: `${action} requires POST` });
  }
  try {
    const result = await handler(req.body || {}, req.query || {});
    const code = result.code || (result.ok ? 200 : 400);
    return res.status(code).json(result);
  } catch (e) {
    console.error(`[dashboard-feed] ${action} error:`, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};