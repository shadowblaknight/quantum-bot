/* eslint-disable */
// api/alexg-eligibility.js
//
// ALEX G — "Full Set & Forget" strategy — LAYER 0: ELIGIBILITY FILTER
// ============================================================================
// The universe gate. Runs BEFORE bias / AOI / entry. A pair (or instrument)
// must pass this before any other layer looks at it. This is the layer that
// stops the bot from trading chop — the exact failure that produced the
// USDJPY "souq" (three contradictory positions in a 161.4–161.9 range).
//
// MAPS DIRECTLY TO THE PDF:
//   - "Avoid Consolidating Markets ... pairs stuck in long-term consolidation
//      with no clear potential"            (Full Set & Forget, p.~6, line 192-194)
//   - "Disregard pairs consolidating for extended periods or showing no
//      potential"                          (line 93)
//        => consolidation detector (Kaufman Efficiency Ratio on D, W-aware).
//   - "Avoid Extreme Market Levels — don't trade above the highest high or
//      below the lowest low in market history"   (line 187-189)
//        => extreme-proximity guard (blocks the offending DIRECTION, not the
//           whole pair: at the top you may still short a rejection).
//   - implied "clear potential / structure"  => minimum-data + ER clarity.
//
// DESIGN NOTES:
//   - All consolidation/extreme math is NORMALISED (efficiency ratio is unitless;
//     range is measured in ATRs). So ONE set of thresholds works for forex,
//     gold, BTC and indices alike — no per-asset tuning needed at this layer.
//   - Pure functions take candle arrays and are unit-tested directly. The async
//     wrapper calls candle-source.fetchCandles, but a fetch fn can be injected
//     via opts.fetchCandlesFn (used by tests, and keeps this module decoupled).
//   - READ-ONLY. This layer trades nothing. It produces a verdict the dashboard
//     can display and the higher layers consume.
//
// OUTPUT (per asset):
//   {
//     asset, eligible,
//     flags:   { consolidating, longBlocked, shortBlocked, insufficientData },
//     metrics: { d:{...}, w:{...}|null, extreme:{...} },
//     reasons: [ "..." ],
//     evaluatedAt
//   }
// ----------------------------------------------------------------------------

const { getAssetById } = require('./asset-registry');

// candle-source is required lazily so this module loads even in environments
// where its transitive deps (_lib, symbol-resolver) aren't present (e.g. tests).
let _fetchCandlesCached = null;
function defaultFetchCandles() {
  if (!_fetchCandlesCached) {
    try { _fetchCandlesCached = require('./candle-source').fetchCandles; } catch (_) {}
  }
  return _fetchCandlesCached;
}

// ─── Tunable configuration ──────────────────────────────────────────
// These are the knobs we'll calibrate against Alex's actual pair selections.
// Defaults are deliberately conservative (better to skip a borderline pair than
// to trade chop).
const CFG = {
  dailyLookback:   120,   // D candles to fetch (~6 months of trading days)
  weeklyLookback:  60,    // W candles to fetch (~14 months)
  erLookbackD:     20,    // efficiency-ratio window on D
  erLookbackW:     12,    // efficiency-ratio window on W
  atrPeriod:       14,    // ATR period (simple mean of TRs)
  consolidationER: 0.30,  // D ER below this => consolidating (TUNABLE, the big one)
  wTrendER:        0.34,  // W ER above this => W is "clearly trending"
  rangeAtrFloor:   6.0,   // band/ATR below this corroborates a range (reported)
  extremeAtrEps:   0.5,   // within this many ATR of hist max/min => "at extreme"
  minCandlesD:     40,    // need at least this many D candles to judge at all
};

// ─── Pure math (unit-tested) ────────────────────────────────────────

// True Range series (length = candles.length-1; index i is TR of candle i+1).
function trueRanges(candles) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (![c.high, c.low, p.close].every(isFinite)) { tr.push(NaN); continue; }
    tr.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }
  return tr;
}

// Simple ATR = mean of the last `period` true ranges. Returns null if too short.
function atr(candles, period = CFG.atrPeriod) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = trueRanges(candles).filter(isFinite);
  if (tr.length < period) return null;
  const seg = tr.slice(-period);
  return seg.reduce((a, b) => a + b, 0) / seg.length;
}

// Kaufman Efficiency Ratio over the last `lookback` closes.
//   net directional move / total path travelled.  0 = pure chop, 1 = pure trend.
function efficiencyRatio(closes, lookback) {
  if (!Array.isArray(closes) || closes.length < lookback + 1) return null;
  const seg = closes.slice(-(lookback + 1));
  const net = Math.abs(seg[seg.length - 1] - seg[0]);
  let path = 0;
  for (let i = 1; i < seg.length; i++) path += Math.abs(seg[i] - seg[i - 1]);
  if (path <= 0) return 0;
  return net / path;
}

// (high-low span over the last `lookback` candles) expressed in ATRs.
function bandInAtr(candles, lookback, atrVal) {
  if (!atrVal || !isFinite(atrVal) || atrVal <= 0) return null;
  const seg = candles.slice(-lookback);
  if (!seg.length) return null;
  let maxH = -Infinity, minL = Infinity;
  for (const c of seg) { if (c.high > maxH) maxH = c.high; if (c.low < minL) minL = c.low; }
  return (maxH - minL) / atrVal;
}

// Where current price sits vs the full available history of this series.
function extremeProximity(candles, currentPrice, atrVal) {
  let maxH = -Infinity, minL = Infinity;
  for (const c of candles) { if (c.high > maxH) maxH = c.high; if (c.low < minL) minL = c.low; }
  const eps = (atrVal && isFinite(atrVal)) ? CFG.extremeAtrEps * atrVal : 0;
  return {
    maxH, minL,
    nearHigh: currentPrice >= maxH - eps,   // no room above to buy into
    nearLow:  currentPrice <= minL + eps,   // no room below to sell into
    beyondHigh: currentPrice >= maxH,
    beyondLow:  currentPrice <= minL,
  };
}

// Assess one timeframe's structure (D or W).
function assessTimeframe(candles, label, erLookback) {
  if (!Array.isArray(candles) || candles.length < erLookback + 1) {
    return { ok: false, reason: `insufficient ${label} data (${candles ? candles.length : 0} candles)` };
  }
  const closes = candles.map((c) => c.close);
  const atrVal = atr(candles);
  const er = efficiencyRatio(closes, erLookback);
  const band = bandInAtr(candles, erLookback, atrVal);
  const currentPrice = closes[closes.length - 1];
  const net = closes[closes.length - 1] - closes[closes.length - 1 - erLookback];
  return {
    ok: true,
    atr: atrVal,
    er,
    bandAtr: band,
    currentPrice,
    trend: net > 0 ? 'up' : net < 0 ? 'down' : 'flat',
    consolidating: er != null && er < CFG.consolidationER,
  };
}

// ─── Core evaluation ────────────────────────────────────────────────

function notEligible(asset, reason, extra = {}) {
  return {
    asset,
    eligible: false,
    flags: { consolidating: false, longBlocked: false, shortBlocked: false, insufficientData: true, ...(extra.flags || {}) },
    metrics: extra.metrics || { d: null, w: null, extreme: null },
    reasons: [reason],
    evaluatedAt: Date.now(),
  };
}

async function evaluateEligibility(asset, opts = {}) {
  const fc = opts.fetchCandlesFn || defaultFetchCandles();
  if (typeof fc !== 'function') {
    return notEligible(asset, 'candle source unavailable');
  }

  let dRes, wRes;
  try {
    [dRes, wRes] = await Promise.all([
      fc(asset, '1d', CFG.dailyLookback),
      fc(asset, '1w', CFG.weeklyLookback),
    ]);
  } catch (e) {
    return notEligible(asset, 'candle fetch threw: ' + e.message);
  }

  const d = (dRes && dRes.candles) || [];
  const w = (wRes && wRes.candles) || [];

  if (d.length < CFG.minCandlesD) {
    return notEligible(asset, `insufficient daily history (${d.length} < ${CFG.minCandlesD})`);
  }

  const dA = assessTimeframe(d, '1d', CFG.erLookbackD);
  const wA = assessTimeframe(w, '1w', CFG.erLookbackW);
  if (!dA.ok) return notEligible(asset, dA.reason);

  // ── Consolidation (PDF lines 93, 192-194) ──────────────────────────
  // Primary signal = Daily ER. Weekly disambiguates: if the Daily is choppy
  // but the Weekly is clearly trending, the Daily chop is likely a retracement
  // (a setup), not dead consolidation — so we DON'T skip. If both are flat, or
  // the Weekly is unknown, we skip (conservative).
  const dChop = dA.consolidating;
  const wTrending = wA.ok && wA.er != null && wA.er >= CFG.wTrendER;
  let consolidating;
  if (dChop && wTrending) consolidating = false;       // D chop within W trend => allowed (retracement)
  else consolidating = dChop;                          // else trust the D read

  // ── Extreme levels (PDF lines 187-189) ─────────────────────────────
  // Use the longest series we have (Weekly preferred) as a proxy for "market
  // history". Block only the offending DIRECTION, never the whole pair.
  const extSeries = wA.ok ? w : d;
  const extAtr = wA.ok ? wA.atr : dA.atr;
  const ext = extremeProximity(extSeries, dA.currentPrice, extAtr);
  const longBlocked = ext.nearHigh;
  const shortBlocked = ext.nearLow;

  const reasons = [];
  if (consolidating) reasons.push(`consolidating: Daily ER ${fmt(dA.er)} < ${CFG.consolidationER}${wTrending ? '' : (wA.ok ? ` (Weekly ER ${fmt(wA.er)})` : ' (no weekly data)')}`);
  if (dChop && wTrending) reasons.push(`Daily choppy but Weekly trending (ER ${fmt(wA.er)}) — treated as retracement, not skipped`);
  if (longBlocked) reasons.push(`at top of history (price ${fmt(dA.currentPrice)} ~ max ${fmt(ext.maxH)}) — longs blocked`);
  if (shortBlocked) reasons.push(`at bottom of history (price ${fmt(dA.currentPrice)} ~ min ${fmt(ext.minL)}) — shorts blocked`);
  if (!consolidating && !longBlocked && !shortBlocked) reasons.push(`clear: Daily ER ${fmt(dA.er)}, trend ${dA.trend}${wA.ok ? `, Weekly ER ${fmt(wA.er)} (${wA.trend})` : ''}`);

  // Pair is eligible unless it's consolidating, or both directions are blocked.
  const eligible = !consolidating && !(longBlocked && shortBlocked);

  return {
    asset,
    eligible,
    flags: {
      consolidating,
      longBlocked,
      shortBlocked,
      insufficientData: false,
    },
    metrics: {
      d: { er: round(dA.er), atr: round(dA.atr), bandAtr: round(dA.bandAtr), trend: dA.trend, currentPrice: dA.currentPrice },
      w: wA.ok ? { er: round(wA.er), atr: round(wA.atr), bandAtr: round(wA.bandAtr), trend: wA.trend } : null,
      extreme: { source: wA.ok ? '1w' : '1d', maxH: ext.maxH, minL: ext.minL, nearHigh: ext.nearHigh, nearLow: ext.nearLow },
    },
    reasons,
    evaluatedAt: Date.now(),
  };
}

// Batch over a watchlist.
async function evaluateUniverse(assets, opts = {}) {
  const list = (assets && assets.length) ? assets : ['gold', 'eurusd', 'gbpusd', 'usdjpy', 'nas100', 'us500', 'btc'];
  const settled = await Promise.all(list.map(async (a) => {
    try { return [a, await evaluateEligibility(a, opts)]; }
    catch (e) { return [a, notEligible(a, 'evaluation threw: ' + e.message)]; }
  }));
  const results = {};
  let eligibleCount = 0;
  for (const [a, v] of settled) { results[a] = v; if (v.eligible) eligibleCount++; }
  return { ok: true, results, eligibleCount, requested: list.length, evaluatedAt: Date.now() };
}

// ─── small helpers ──────────────────────────────────────────────────
function round(x) { return (x == null || !isFinite(x)) ? null : Math.round(x * 1e4) / 1e4; }
function fmt(x) { return (x == null || !isFinite(x)) ? 'n/a' : (Math.round(x * 100) / 100).toString(); }

// ─── HTTP handler (read-only; for the dashboard) ────────────────────
//   GET /api/alexg-eligibility?asset=usdjpy   → single verdict
//   GET /api/alexg-eligibility                → batch over default watchlist
//   GET /api/alexg-eligibility?assets=a,b,c   → batch over given list
module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (q.asset) {
      if (!getAssetById(q.asset)) return res.status(400).json({ ok: false, error: 'unknown asset' });
      const verdict = await evaluateEligibility(q.asset);
      return res.status(200).json({ ok: true, verdict });
    }
    const assets = q.assets ? String(q.assets).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
    const batch = await evaluateUniverse(assets);
    return res.status(200).json(batch);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.evaluateEligibility = evaluateEligibility;
module.exports.evaluateUniverse = evaluateUniverse;
module.exports.trueRanges = trueRanges;
module.exports.atr = atr;
module.exports.efficiencyRatio = efficiencyRatio;
module.exports.bandInAtr = bandInAtr;
module.exports.extremeProximity = extremeProximity;
module.exports.assessTimeframe = assessTimeframe;
module.exports.CFG = CFG;