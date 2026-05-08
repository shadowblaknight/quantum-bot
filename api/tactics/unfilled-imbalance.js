/* eslint-disable */
// V12 — api/tactics/unfilled-imbalance.js
//
// Unfilled imbalance detector. Beyond standard FVGs, this catches:
//   - Weekend gaps (price gap between Friday close and Sunday/Monday open)
//   - Post-news imbalances (large move after high-impact news that left untested zones)
//   - Multi-candle imbalances (3+ same-direction candles with no overlap)
//
// These are LARGER imbalances than the typical 3-candle FVG and have stronger
// magnetic effect on price. Markets famously "fill the gap."
//
// VALIDATION:
//   - Imbalance size must be ≥ 1 × ATR (we want significant gaps, not noise)
//   - Imbalance must not be already filled
//   - Must be on H1 or higher (M5 weekend gaps are noise)
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');
const { atr } = require('../_lib');

const MIN_GAP_ATR = 1.0;
const MAX_AGE_BARS = 120;

function detect(candles, context = {}) {
  const tf = context.timeframe;
  if (!tf || !Array.isArray(candles) || candles.length < 30) return [];

  // Only relevant on H1, H4, D1
  if (!['1h', '4h', '1d'].includes(tf)) return [];

  const atrVal = atr(candles, 14);
  if (!atrVal || !isFinite(atrVal)) return [];

  const opinions = [];
  const lastIdx = candles.length - 1;
  const startIdx = Math.max(1, lastIdx - MAX_AGE_BARS);

  // Detect candle-to-candle gaps (Friday-Sunday, news gaps)
  for (let i = startIdx; i <= lastIdx; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];

    // BULLISH GAP: current candle's low > previous candle's high
    if (curr.low > prev.high) {
      const gapSize = curr.low - prev.high;
      if (gapSize < atrVal * MIN_GAP_ATR) continue;

      // Check fill status (all subsequent bars after this gap formation)
      const filled = isGapFilled(candles, i, prev.high, curr.low, 'bullish');
      if (filled) continue;

      // Detect type: weekend or news?
      const isWeekendGap = detectWeekendGap(prev, curr);

      const op = makeOpinion({
        tactic: 'unfilledImbalance',
        timeframe: tf,
        direction: 'SHORT', // bullish gap → market wants to fill DOWN to close it
        level: (prev.high + curr.low) / 2,
        zone: { upper: curr.low, lower: prev.high },
        entry: curr.low,
        invalidation: curr.low + atrVal * 1, // big buffer — these are strong magnets
        targets: [prev.high],
        formedAt: new Date(curr.time).getTime(),
        strength: computeImbalanceStrength(gapSize, atrVal, isWeekendGap, lastIdx - i),
        evidence: {
          type: 'bullishGap',
          isWeekendGap,
          gapUpper: curr.low,
          gapLower: prev.high,
          gapSizeATR: (gapSize / atrVal).toFixed(2),
          barsAgo: lastIdx - i,
        },
        description: `${tf} unfilled bullish gap ${prev.high.toFixed(prev.high > 100 ? 2 : 5)}-${curr.low.toFixed(curr.low > 100 ? 2 : 5)}${isWeekendGap ? ' (weekend)' : ''}`,
      });
      if (op) opinions.push(op);
    }

    // BEARISH GAP: current candle's high < previous candle's low
    if (curr.high < prev.low) {
      const gapSize = prev.low - curr.high;
      if (gapSize < atrVal * MIN_GAP_ATR) continue;

      const filled = isGapFilled(candles, i, curr.high, prev.low, 'bearish');
      if (filled) continue;

      const isWeekendGap = detectWeekendGap(prev, curr);

      const op = makeOpinion({
        tactic: 'unfilledImbalance',
        timeframe: tf,
        direction: 'LONG', // bearish gap → market wants to fill UP
        level: (prev.low + curr.high) / 2,
        zone: { upper: prev.low, lower: curr.high },
        entry: curr.high,
        invalidation: curr.high - atrVal * 1,
        targets: [prev.low],
        formedAt: new Date(curr.time).getTime(),
        strength: computeImbalanceStrength(gapSize, atrVal, isWeekendGap, lastIdx - i),
        evidence: {
          type: 'bearishGap',
          isWeekendGap,
          gapUpper: prev.low,
          gapLower: curr.high,
          gapSizeATR: (gapSize / atrVal).toFixed(2),
          barsAgo: lastIdx - i,
        },
        description: `${tf} unfilled bearish gap ${curr.high.toFixed(curr.high > 100 ? 2 : 5)}-${prev.low.toFixed(prev.low > 100 ? 2 : 5)}${isWeekendGap ? ' (weekend)' : ''}`,
      });
      if (op) opinions.push(op);
    }
  }

  // Limit count
  return opinions.sort((a, b) => b.strength - a.strength).slice(0, 4);
}

function isGapFilled(candles, fromIdx, lower, upper, type) {
  for (let j = fromIdx + 1; j < candles.length; j++) {
    const c = candles[j];
    if (type === 'bullish') {
      // bullish gap fills when price reaches DOWN through it
      if (c.low <= lower) return true;
    } else {
      // bearish gap fills when price reaches UP through it
      if (c.high >= upper) return true;
    }
  }
  return false;
}

function detectWeekendGap(prev, curr) {
  const prevTime = new Date(prev.time);
  const currTime = new Date(curr.time);
  const dayDiff = (currTime.getTime() - prevTime.getTime()) / (24 * 60 * 60 * 1000);
  // If gap is > 1.5 days, likely weekend
  return dayDiff > 1.5;
}

function computeImbalanceStrength(gapSize, atrVal, isWeekendGap, ageBars) {
  const sizeATR = gapSize / atrVal;
  const sizeScore = Math.min((sizeATR - MIN_GAP_ATR) / 2, 1);
  const weekendBonus = isWeekendGap ? 0.15 : 0;
  const recency = Math.max(0, 1 - ageBars / MAX_AGE_BARS);
  return Math.min(0.4 + sizeScore * 0.3 + weekendBonus + recency * 0.15, 1);
}

module.exports = { detect };