/* eslint-disable */
// api/jarvis-goal.js  v1.0
//
// Profit target tracking for JARVIS.
//
// GET  /api/jarvis-goal              → full goal status with derived metrics
// POST /api/jarvis-goal              → set/update goals
//   body: { dailyTarget?, monthlyTarget?, dailyAchieved?, monthlyAchieved?, currency? }
// POST /api/jarvis-goal?action=add   → add to achieved totals (called after trade close)
//   body: { dailyAdd?, monthlyAdd? }  (positive = profit, negative = loss)
//
// Stored in Redis with appropriate TTLs (daily resets at midnight, monthly at month end).
// JARVIS reads this to calibrate sizing and session priorities toward the goal.
// ----------------------------------------------------------------------------

const { applyCors, getRedis, safeParse } = require('./_lib');

const DAILY_KEY   = 'v1:jarvis:goal:daily';
const MONTHLY_KEY = 'v1:jarvis:goal:monthly';

// Trading days per month (conservative estimate)
const AVG_TRADING_DAYS = 21;
// Peak sessions per day worth trading
const SESSIONS_PER_DAY = 2;

function derivedMetrics(daily, monthly) {
  const now = new Date();
  const daysInMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth    = now.getDate();
  const tradingDaysFull = Math.round(daysInMonth * 5 / 7);
  const tradingDaysDone = Math.round(dayOfMonth * 5 / 7);
  const tradingDaysLeft = Math.max(1, tradingDaysFull - tradingDaysDone);
  const sessionsLeft    = tradingDaysLeft * SESSIONS_PER_DAY;

  const monthlyRemaining = Math.max(0, monthly.target - monthly.achieved);
  const dailyRemaining   = Math.max(0, daily.target - daily.achieved);

  // Required P&L per remaining session to hit monthly target
  const requiredPerSession = sessionsLeft > 0
    ? +(monthlyRemaining / sessionsLeft).toFixed(2)
    : 0;

  // On-track check: at this point in the month have we earned the expected proportion?
  const expectedByNow = monthly.target * (tradingDaysDone / tradingDaysFull);
  const onTrack       = monthly.achieved >= expectedByNow * 0.85;

  // Intensity: 1.0 = normal, >1.0 = JARVIS should push harder, <1.0 = can relax
  let intensity = 1.0;
  if (monthly.target > 0) {
    const paceRatio = monthly.achieved > 0
      ? (monthly.achieved / expectedByNow)
      : 0;
    intensity = onTrack ? (1 / Math.max(0.5, paceRatio)) : (expectedByNow / Math.max(1, monthly.achieved));
    intensity = Math.min(2.5, Math.max(0.5, intensity)); // clamp to sane range
  }

  // JARVIS sizing guidance: at 1% risk per trade, roughly how many R does JARVIS need?
  // Assumes 1R ≈ 1% of equity. User/JARVIS can override.
  const rNeededToday = daily.target > 0 && daily.target > daily.achieved
    ? +((daily.target - daily.achieved) / (daily.target * 0.01 || 1)).toFixed(1)
    : 0;

  return {
    dailyRemaining,
    monthlyRemaining,
    tradingDaysLeft,
    sessionsLeft,
    requiredPerSession,
    expectedByNow:   +expectedByNow.toFixed(2),
    onTrack,
    intensity:       +intensity.toFixed(2),
    rNeededToday,
    monthProgress:   monthly.target > 0 ? +(monthly.achieved / monthly.target * 100).toFixed(1) : 0,
    dailyProgress:   daily.target   > 0 ? +(daily.achieved   / daily.target   * 100).toFixed(1) : 0,
  };
}

// Increment daily + monthly achieved by pnl.
// Called by manage-trades.js on every trade close so JARVIS sees real-time goal progress.
// Safe to call with no goal set — achieved accumulates regardless (resets at midnight).
async function addGoalPnL(r, pnl) {
  if (!r || typeof pnl !== 'number' || !isFinite(pnl) || pnl === 0) return;
  try {
    const [rawD, rawM] = await Promise.all([
      r.get(DAILY_KEY).catch(() => null),
      r.get(MONTHLY_KEY).catch(() => null),
    ]);
    const daily   = safeParse(rawD) || { target: 0, achieved: 0, currency: 'USD' };
    const monthly = safeParse(rawM) || { target: 0, achieved: 0, currency: 'USD' };

    daily.achieved   = +(daily.achieved   + pnl).toFixed(2);
    monthly.achieved = +(monthly.achieved + pnl).toFixed(2);

    const now = new Date();
    const secondsUntilMidnight = Math.floor(
      (new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) - now) / 1000
    );
    await Promise.all([
      r.set(DAILY_KEY,   JSON.stringify(daily),   { ex: Math.max(3600, secondsUntilMidnight) }),
      r.set(MONTHLY_KEY, JSON.stringify(monthly), { ex: 35 * 24 * 3600 }),
    ]);
  } catch (e) { console.error('[addGoalPnL] Redis write failed:', e.message); }
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  const r = getRedis();
  if (!r) return res.status(503).json({ error: 'Redis unavailable — KV credentials not configured' });

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const [rawD, rawM] = await Promise.all([
        r.get(DAILY_KEY).catch(() => null),
        r.get(MONTHLY_KEY).catch(() => null),
      ]);
      const daily   = safeParse(rawD) || { target: 0, achieved: 0, currency: 'USD' };
      const monthly = safeParse(rawM) || { target: 0, achieved: 0, currency: 'USD' };
      return res.status(200).json({ daily, monthly, derived: derivedMetrics(daily, monthly) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: set or increment ────────────────────────────────────────────────
  if (req.method === 'POST') {
    const action = req.query?.action;
    try {
      const [rawD, rawM] = await Promise.all([
        r.get(DAILY_KEY).catch(() => null),
        r.get(MONTHLY_KEY).catch(() => null),
      ]);
      let daily   = safeParse(rawD) || { target: 0, achieved: 0, currency: 'USD' };
      let monthly = safeParse(rawM) || { target: 0, achieved: 0, currency: 'USD' };
      const body  = req.body || {};

      if (action === 'add') {
        // Increment achieved values (called after a trade closes)
        if (typeof body.dailyAdd   === 'number') daily.achieved   += body.dailyAdd;
        if (typeof body.monthlyAdd === 'number') monthly.achieved += body.monthlyAdd;
      } else {
        // Set targets / achieved overrides
        if (body.dailyTarget   !== undefined) daily.target   = Number(body.dailyTarget);
        if (body.monthlyTarget !== undefined) monthly.target = Number(body.monthlyTarget);
        if (body.dailyAchieved !== undefined) daily.achieved = Number(body.dailyAchieved);
        if (body.monthlyAchieved !== undefined) monthly.achieved = Number(body.monthlyAchieved);
        if (body.currency) {
          daily.currency   = body.currency;
          monthly.currency = body.currency;
        }
      }

      // TTL: daily key expires at end of today (UTC midnight), monthly at 35 days
      const now = new Date();
      const secondsUntilMidnight = Math.floor(
        (new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) - now) / 1000
      );

      await Promise.all([
        r.set(DAILY_KEY,   JSON.stringify(daily),   { ex: Math.max(3600, secondsUntilMidnight) }),
        r.set(MONTHLY_KEY, JSON.stringify(monthly), { ex: 35 * 24 * 3600 }),
      ]);

      return res.status(200).json({
        ok: true,
        daily,
        monthly,
        derived: derivedMetrics(daily, monthly),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'GET or POST only' });
};

module.exports.addGoalPnL = addGoalPnL;
