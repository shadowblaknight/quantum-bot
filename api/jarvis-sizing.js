/* eslint-disable */
// api/jarvis-sizing.js  v1.0 — JARVIS Goal-Driven Sizing Calculator
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jarvis-sizing
//   ?equity=50000&dailyTarget=1000&achieved=350&winRate=0.62&avgR=1.8&drawdown=0.8
//
// POST /api/jarvis-sizing
//   body: same fields as query params
//
// Returns:
//   { tierBMultiplier, tierAMultiplier, maxTrades, minKNN, intensity,
//     mode, reasoning, safe, warnings }
//
// Formula:
//   1R baseline  = equity × 2% (rules-store default maxRiskPerTradePct)
//   needed/session = (dailyTarget - achieved) / sessionsLeft
//   ideal_pnl_per_trade = avgR × WR × 1R
//   multiplier = needed / ideal_pnl_per_trade
//   Clamped: [0.5 … 2.5]
//   If drawdown > 2% → cap 0.75×
//   If drawdown > 3.5% → recommend defensive mode, cap 0.5×
//   Tier A (reaction/LTF templates) always 25% smaller than Tier B
// ─────────────────────────────────────────────────────────────────────────────

const { applyCors, getRedis, safeParse } = require('./_lib');

const RULES_KEY             = 'v13:pilot:rules';
const DEFAULT_RISK_PCT      = 0.02;  // 2% of equity per 1R
const DEFAULT_WIN_RATE      = 0.55;  // fallback if not provided
const DEFAULT_AVG_R         = 1.6;   // fallback if not provided
const DEFAULT_SESSIONS_LEFT = 2;     // morning + afternoon if no data

// Kill zones per day  (approximate — JARVIS uses this for session count)
// 3 sessions x 5 trading days = 15 opportunities/week
const SESSIONS_PER_DAY = 3;

// ─── Core sizing engine ───────────────────────────────────────────────────────
function computeSizing(params, rulesDefaults) {
  const {
    equity       = 0,
    dailyTarget  = 1000,
    achieved     = 0,
    winRate      = DEFAULT_WIN_RATE,
    avgR         = DEFAULT_AVG_R,
    sessionsLeft = DEFAULT_SESSIONS_LEFT,
    drawdownPct  = 0,      // current drawdown as percentage (e.g. 1.5 = 1.5%)
  } = params;

  const riskPct    = rulesDefaults?.maxRiskPerTradePct != null
    ? rulesDefaults.maxRiskPerTradePct / 100
    : DEFAULT_RISK_PCT;
  const baseRisk   = equity > 0 ? equity * riskPct : 1000; // 1R dollar amount

  const remaining   = Math.max(0, dailyTarget - achieved);
  const sessions    = Math.max(1, sessionsLeft);
  const neededPerSession = remaining / sessions;

  // Expected PnL per trade at current stats, at 1× lot
  const expectedPerTrade = baseRisk * avgR * winRate;
  const expectedPerSession = expectedPerTrade * 3; // ~3 trades per session avg

  const rawMultiplier = expectedPerSession > 0
    ? neededPerSession / expectedPerSession
    : 1.0;

  const warnings = [];
  let tierBMult, tierAMult, mode, minKNN, maxTrades, intensity;

  // ── Safety guardrails ─────────────────────────────────────────────────────
  if (drawdownPct > 3.5) {
    tierBMult = 0.50; tierAMult = 0.25;
    mode      = 'defensive';
    minKNN    = 85;
    maxTrades = 1;
    intensity = 0.5;
    warnings.push('Drawdown exceeds 3.5% — hard defensive mode. Only 1 trade, high-confidence setups only.');
  } else if (drawdownPct > 2.0) {
    tierBMult = Math.min(0.75, rawMultiplier);
    tierAMult = +(tierBMult * 0.75).toFixed(2);
    mode      = 'active';
    minKNN    = 80;
    maxTrades = 2;
    intensity = tierBMult;
    warnings.push(`Drawdown at ${drawdownPct.toFixed(1)}% — sizing capped at 0.75× until recovered.`);
  } else if (remaining <= 0) {
    tierBMult = 0.50; tierAMult = 0.38;
    mode      = 'active';
    minKNN    = 75;
    maxTrades = 2;
    intensity = 0.5;
    warnings.push('Daily target already reached — reduced sizing to protect gains.');
  } else {
    const clamped = Math.max(0.5, Math.min(2.5, rawMultiplier));
    tierBMult = +clamped.toFixed(2);
    tierAMult = +(clamped * 0.75).toFixed(2);
    mode      = clamped >= 2.0 ? 'aggressive' : 'active';
    // Raise KNN threshold proportionally when we need to push harder
    minKNN    = clamped >= 1.8 ? 82 : clamped >= 1.3 ? 78 : 72;
    maxTrades = clamped >= 2.0 ? 5 : clamped >= 1.3 ? 4 : 3;
    intensity = tierBMult;
  }

  if (rawMultiplier > 2.5) {
    warnings.push(`Raw multiplier ${rawMultiplier.toFixed(2)}× exceeds cap of 2.5×. Goal may require extending to tomorrow's sessions.`);
  }
  if (winRate < 0.45) {
    warnings.push(`Win rate ${(winRate * 100).toFixed(0)}% is below threshold. Avoid aggressive sizing until equity curve recovers.`);
    tierBMult = Math.min(tierBMult, 0.75);
    tierAMult = Math.min(tierAMult, 0.56);
  }

  const safe = drawdownPct <= 2.0 && winRate >= 0.45 && rawMultiplier <= 2.5;

  // ── Speech generation ─────────────────────────────────────────────────────
  const goalStatus = remaining <= 0
    ? `You have already hit your $${dailyTarget} daily target`
    : `You need $${remaining.toFixed(0)} more to hit your $${dailyTarget} target`;

  const lines = [
    `${goalStatus}.`,
    `With ${sessions} session${sessions !== 1 ? 's' : ''} left and your recent win rate of ${(winRate * 100).toFixed(0)}% at ${avgR.toFixed(1)}R average, I calculate:`,
    `Tier-B at ${tierBMult}× and Tier-A at ${tierAMult}×.`,
    drawdownPct > 0 ? `Current drawdown is ${drawdownPct.toFixed(1)}%.` : null,
    warnings.length > 0 ? `Note: ${warnings[0]}` : null,
  ].filter(Boolean).join(' ');

  return {
    tierBMultiplier: tierBMult,
    tierAMultiplier: tierAMult,
    maxTrades,
    minKNN,
    intensity,
    mode,
    safe,
    warnings,
    speech: lines,
    debug: {
      baseRisk:          +baseRisk.toFixed(2),
      riskPct:           +(riskPct * 100).toFixed(2),
      neededPerSession:  +neededPerSession.toFixed(2),
      expectedPerSession:+expectedPerSession.toFixed(2),
      rawMultiplier:     +rawMultiplier.toFixed(4),
      equity,
      dailyTarget,
      achieved,
      remaining,
      winRate,
      avgR,
      sessions,
      drawdownPct,
    },
  };
}

// Parse numeric params from query string or body
function parseParams(source) {
  return {
    equity:       parseFloat(source.equity)       || 0,
    dailyTarget:  parseFloat(source.dailyTarget)  || 1000,
    achieved:     parseFloat(source.achieved)     || 0,
    winRate:      parseFloat(source.winRate)      || DEFAULT_WIN_RATE,
    avgR:         parseFloat(source.avgR)         || DEFAULT_AVG_R,
    sessionsLeft: parseInt(source.sessionsLeft)   || DEFAULT_SESSIONS_LEFT,
    drawdownPct:  parseFloat(source.drawdownPct)  || 0,
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({ error: 'GET or POST only' });

  const r = getRedis();

  const source = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const params  = parseParams(source);

  // Pull rules defaults from Redis if equity not provided and Redis is available
  let rulesDefaults = {};
  if (r) {
    try {
      const raw = await r.get(RULES_KEY).catch(() => null);
      rulesDefaults = safeParse(raw) || {};
    } catch (_) {}
  }

  // If no equity provided, try to read it from rules defaults or return error
  if (!params.equity && rulesDefaults.accountEquity) {
    params.equity = rulesDefaults.accountEquity;
  }
  if (!params.equity) {
    // Return a default sizing using $10,000 placeholder equity
    params.equity = 10000;
    // eslint-disable-next-line no-console
  }

  const result = computeSizing(params, rulesDefaults);

  return res.status(200).json(result);
};

// Export the engine for direct use in jarvis.js without HTTP roundtrip
module.exports.computeSizing = computeSizing;
module.exports.parseParams   = parseParams;
