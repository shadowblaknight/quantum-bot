/* eslint-disable */
// V12 — api/tactics/trend-structure.js
//
// Detects trend structure: HH/HL (uptrend), LH/LL (downtrend), or transitioning.
// Built on swing fractals: a bar is a fractal high if its high > 2 bars before
// AND > 2 bars after. Same for fractal low.
//
// Output: opinions about CURRENT TREND STATE on a given timeframe, plus the
// most recent confirmed swing high/low levels (which are used by other detectors
// like BOS and Order Block).
//
// Helpers (also exported, used by other detectors):
//   findSwings(candles, lookback) → [{type, idx, price, time}]
//   classifyTrend(swings) → 'UP' | 'DOWN' | 'RANGING' | 'TRANSITION'
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');

// Find all swing highs/lows in a candle array. A 5-bar fractal: bar's high
// must exceed 2 bars before and 2 bars after.
// Returns array sorted by index (chronological).
function findSwings(candles, _lookback) {
  if (!Array.isArray(candles) || candles.length < 7) return [];
  const swings = [];
  // Need 2 bars on each side
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    const isHigh =
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high;
    const isLow =
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low;

    if (isHigh) {
      swings.push({ type: 'HIGH', idx: i, price: c.high, time: c.time });
    }
    if (isLow) {
      swings.push({ type: 'LOW', idx: i, price: c.low, time: c.time });
    }
  }
  return swings;
}

// Given recent swings, classify trend.
// UP: last 2 highs are HH AND last 2 lows are HL
// DOWN: last 2 highs are LH AND last 2 lows are LL
// RANGING: highs and lows alternating without clear direction
// TRANSITION: mixed signals
function classifyTrend(swings) {
  if (!Array.isArray(swings) || swings.length < 4) {
    return { trend: 'TRANSITION', confidence: 0, swings, evidence: 'insufficient swings' };
  }

  // Get last 2 highs and last 2 lows
  const highs = swings.filter((s) => s.type === 'HIGH').slice(-2);
  const lows = swings.filter((s) => s.type === 'LOW').slice(-2);

  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'TRANSITION', confidence: 0.2, swings, evidence: 'need at least 2 of each' };
  }

  const [h1, h2] = highs;       // h2 is more recent
  const [l1, l2] = lows;        // l2 is more recent

  const hh = h2.price > h1.price; // higher high
  const lh = h2.price < h1.price; // lower high
  const hl = l2.price > l1.price; // higher low
  const ll = l2.price < l1.price; // lower low

  if (hh && hl) {
    const strength = Math.min(
      (h2.price - h1.price) / h1.price,
      (l2.price - l1.price) / l1.price
    ) * 100;
    return { trend: 'UP', confidence: 0.8, swings, highs, lows, evidence: `HH(${h2.price.toFixed(4)}) + HL(${l2.price.toFixed(4)})`, strength };
  }
  if (lh && ll) {
    const strength = Math.min(
      (h1.price - h2.price) / h1.price,
      (l1.price - l2.price) / l1.price
    ) * 100;
    return { trend: 'DOWN', confidence: 0.8, swings, highs, lows, evidence: `LH(${h2.price.toFixed(4)}) + LL(${l2.price.toFixed(4)})`, strength };
  }
  if ((hh && ll) || (lh && hl)) {
    return { trend: 'RANGING', confidence: 0.5, swings, highs, lows, evidence: 'expanding range' };
  }
  return { trend: 'TRANSITION', confidence: 0.3, swings, highs, lows, evidence: 'mixed signals' };
}

// Main detector — emits one opinion per analyzed timeframe describing the trend
function detect(candles, context = {}) {
  const tf = context.timeframe;
  if (!tf || !Array.isArray(candles) || candles.length < 10) return [];

  const swings = findSwings(candles);
  if (swings.length === 0) return [];

  const classification = classifyTrend(swings);

  // Map trend → direction
  const dir =
    classification.trend === 'UP' ? 'LONG' :
    classification.trend === 'DOWN' ? 'SHORT' :
    'NEUTRAL';

  // Last close = current price reference
  const last = candles[candles.length - 1];
  const lastSwing = swings[swings.length - 1];

  const opinion = makeOpinion({
    tactic: 'trendStructure',
    timeframe: tf,
    direction: dir,
    level: lastSwing.price,
    formedAt: new Date(lastSwing.time).getTime(),
    strength: classification.confidence,
    evidence: {
      trend: classification.trend,
      lastHighs: classification.highs?.map((h) => h.price),
      lastLows: classification.lows?.map((l) => l.price),
      reasoning: classification.evidence,
      swingCount: swings.length,
      currentPrice: last.close,
    },
    description: `${tf} ${classification.trend.toLowerCase()} trend (${classification.evidence})`,
  });

  return opinion ? [opinion] : [];
}

module.exports = { detect, findSwings, classifyTrend };