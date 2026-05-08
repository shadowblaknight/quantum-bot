/* eslint-disable */
// V12 — api/tactics/fvg.js
//
// Fair Value Gap detector. An FVG is a 3-candle imbalance where the middle
// candle's range is so wide that the wicks of candle 1 and candle 3 don't
// overlap. This leaves a "gap" of inefficient pricing that markets often
// return to fill.
//
// Bullish FVG (LONG bias): candle1.high < candle3.low. Gap between them.
//   Expect price to return DOWN to fill, then continue UP.
// Bearish FVG (SHORT bias): candle1.low > candle3.high. Gap between them.
//   Expect price to return UP to fill, then continue DOWN.
//
// VALIDATION:
//   1. Gap size must be ≥ 0.3 × ATR (filter out tiny gaps)
//   2. Middle candle must be strong-bodied (≥ 50% body ratio)
//   3. FVG must not be fully filled yet (partially filled is OK, with reduced strength)
//   4. Must not be too old (> 100 bars stale)
//
// Output zone: { upper, lower } = the gap itself, where price is likely to retrace
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');
const { atr } = require('../_lib');

const MAX_FVG_AGE_BARS = 100;
const MIN_GAP_ATR = 0.3;
const MIN_MIDDLE_BODY_RATIO = 0.5;

function detect(candles, context = {}) {
  const tf = context.timeframe;
  if (!tf || !Array.isArray(candles) || candles.length < 20) return [];

  const atrVal = atr(candles, 14);
  if (!atrVal || !isFinite(atrVal)) return [];

  const opinions = [];
  const lastIdx = candles.length - 1;
  const startIdx = Math.max(2, lastIdx - MAX_FVG_AGE_BARS);

  // FVG pattern needs 3 candles: i-1, i, i+1 (i is the middle/impulse)
  for (let i = startIdx; i < lastIdx; i++) {
    const c1 = candles[i - 1];  // before
    const c2 = candles[i];      // middle (the impulse)
    const c3 = candles[i + 1];  // after

    // Middle candle must be strong-bodied
    const middleRange = c2.high - c2.low;
    if (middleRange <= 0) continue;
    const middleBody = Math.abs(c2.close - c2.open);
    const middleBodyRatio = middleBody / middleRange;
    if (middleBodyRatio < MIN_MIDDLE_BODY_RATIO) continue;

    // BULLISH FVG: c1.high < c3.low (price gapped UP through middle candle)
    // The gap zone is [c1.high, c3.low] — price should retrace here as support
    if (c1.high < c3.low) {
      const gapSize = c3.low - c1.high;
      if (gapSize < atrVal * MIN_GAP_ATR) continue;

      // Check fill status: how much of the gap has been mitigated since formation?
      const fillStatus = computeFillStatus(candles, i + 1, c1.high, c3.low, 'bullish');
      if (fillStatus.fullyFilled) continue;

      const op = makeOpinion({
        tactic: 'fvg',
        timeframe: tf,
        direction: 'LONG',
        level: (c1.high + c3.low) / 2,
        zone: { upper: c3.low, lower: c1.high },
        entry: c3.low,                        // top of gap = retest entry
        invalidation: c1.high - atrVal * 0.2, // bottom of gap with buffer
        targets: null,
        formedAt: new Date(c2.time).getTime(),
        strength: computeFVGStrength(gapSize, atrVal, middleBodyRatio, fillStatus.fillPercent, lastIdx - i),
        evidence: {
          type: 'bullish',
          gapUpper: c3.low,
          gapLower: c1.high,
          gapSizeATR: (gapSize / atrVal).toFixed(2),
          middleBodyRatio: middleBodyRatio.toFixed(2),
          fillPercent: fillStatus.fillPercent.toFixed(2),
          barsAgo: lastIdx - i,
        },
        description: `${tf} bullish FVG ${c1.high.toFixed(c1.high > 100 ? 2 : 5)}-${c3.low.toFixed(c3.low > 100 ? 2 : 5)}, ${(fillStatus.fillPercent * 100).toFixed(0)}% filled, ${lastIdx - i} bars ago`,
      });
      if (op) opinions.push(op);
    }

    // BEARISH FVG: c1.low > c3.high (price gapped DOWN through middle candle)
    if (c1.low > c3.high) {
      const gapSize = c1.low - c3.high;
      if (gapSize < atrVal * MIN_GAP_ATR) continue;

      const fillStatus = computeFillStatus(candles, i + 1, c3.high, c1.low, 'bearish');
      if (fillStatus.fullyFilled) continue;

      const op = makeOpinion({
        tactic: 'fvg',
        timeframe: tf,
        direction: 'SHORT',
        level: (c1.low + c3.high) / 2,
        zone: { upper: c1.low, lower: c3.high },
        entry: c3.high,
        invalidation: c1.low + atrVal * 0.2,
        targets: null,
        formedAt: new Date(c2.time).getTime(),
        strength: computeFVGStrength(gapSize, atrVal, middleBodyRatio, fillStatus.fillPercent, lastIdx - i),
        evidence: {
          type: 'bearish',
          gapUpper: c1.low,
          gapLower: c3.high,
          gapSizeATR: (gapSize / atrVal).toFixed(2),
          middleBodyRatio: middleBodyRatio.toFixed(2),
          fillPercent: fillStatus.fillPercent.toFixed(2),
          barsAgo: lastIdx - i,
        },
        description: `${tf} bearish FVG ${c3.high.toFixed(c3.high > 100 ? 2 : 5)}-${c1.low.toFixed(c1.low > 100 ? 2 : 5)}, ${(fillStatus.fillPercent * 100).toFixed(0)}% filled, ${lastIdx - i} bars ago`,
      });
      if (op) opinions.push(op);
    }
  }

  // Limit recent FVGs per direction
  const longFVGs = opinions.filter((o) => o.direction === 'LONG').sort((a, b) => b.formedAt - a.formedAt).slice(0, 4);
  const shortFVGs = opinions.filter((o) => o.direction === 'SHORT').sort((a, b) => b.formedAt - a.formedAt).slice(0, 4);

  return [...longFVGs, ...shortFVGs];
}

// How much of the gap has been filled since it formed?
// fillPercent: 0 = untouched, 1 = fully filled (FVG dead)
function computeFillStatus(candles, fromIdx, gapLower, gapUpper, type) {
  const gapSize = gapUpper - gapLower;
  if (gapSize <= 0) return { fillPercent: 1, fullyFilled: true };

  let maxPenetration = 0;
  for (let j = fromIdx; j < candles.length; j++) {
    const c = candles[j];
    if (type === 'bullish') {
      // Bullish FVG: filled by price moving DOWN into the gap
      if (c.low < gapUpper) {
        const penetration = Math.min(gapUpper - c.low, gapSize);
        if (penetration > maxPenetration) maxPenetration = penetration;
      }
    } else {
      // Bearish FVG: filled by price moving UP into the gap
      if (c.high > gapLower) {
        const penetration = Math.min(c.high - gapLower, gapSize);
        if (penetration > maxPenetration) maxPenetration = penetration;
      }
    }
  }

  const fillPercent = Math.min(maxPenetration / gapSize, 1);
  return { fillPercent, fullyFilled: fillPercent >= 0.95 };
}

function computeFVGStrength(gapSize, atrVal, bodyRatio, fillPercent, ageBars) {
  // Bigger gap = stronger
  const sizeScore = Math.min((gapSize / atrVal - MIN_GAP_ATR) / 1.5, 1);
  // Stronger middle candle = stronger
  const bodyScore = (bodyRatio - MIN_MIDDLE_BODY_RATIO) / (1 - MIN_MIDDLE_BODY_RATIO);
  // Less filled = stronger (fresh gaps are more attractive)
  const freshScore = 1 - fillPercent;
  // Recency
  const recency = Math.max(0, 1 - ageBars / MAX_FVG_AGE_BARS);

  return Math.min(0.3 + sizeScore * 0.25 + bodyScore * 0.15 + freshScore * 0.2 + recency * 0.1, 1);
}

module.exports = { detect, computeFillStatus };