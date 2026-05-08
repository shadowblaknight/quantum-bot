/* eslint-disable */
// V12 — api/tactics/bos.js
//
// Break of Structure detector. A BOS occurs when a candle CLOSES (not just
// wicks) beyond the most recent swing high (bullish BOS) or swing low (bearish
// BOS), AND that close shows meaningful displacement (not a tiny pip break).
//
// Why displacement matters: a wick or tiny break is often a fake. A real BOS
// has a strong-bodied candle with momentum.
//
// Output: one opinion when a recent BOS is detected, with:
//   - direction: LONG (bullish BOS) or SHORT (bearish BOS)
//   - level: the broken swing level
//   - invalidation: opposite swing level (if price reclaims, BOS is invalidated)
//
// Stale BOS rule: if BOS happened > 20 bars ago, we don't emit (it's "old news").
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');
const { findSwings } = require('./trend-structure');
const { atr } = require('../_lib');

const MAX_BOS_AGE_BARS = 20;       // BOS older than this isn't actionable
const MIN_DISPLACEMENT_ATR = 0.5;  // close must extend ≥ 0.5 ATR past broken level

function detect(candles, context = {}) {
  const tf = context.timeframe;
  if (!tf || !Array.isArray(candles) || candles.length < 30) return [];

  const swings = findSwings(candles);
  if (swings.length < 2) return [];

  const atrVal = atr(candles, 14);
  if (!atrVal || !isFinite(atrVal)) return [];

  // Look at the most recent N bars and check if any of them broke a swing
  const opinions = [];
  const seen = new Set(); // dedup: only one BOS opinion per direction per detection

  // Walk recent candles, find which one broke the most recent prior swing
  // We're looking for the most recent BOS within MAX_BOS_AGE_BARS
  const startIdx = Math.max(0, candles.length - MAX_BOS_AGE_BARS);

  for (let i = candles.length - 1; i >= startIdx; i--) {
    const candle = candles[i];

    // Find the most recent swing of each type that's BEFORE this candle
    const priorSwings = swings.filter((s) => s.idx < i);
    if (priorSwings.length === 0) continue;

    const recentHighs = priorSwings.filter((s) => s.type === 'HIGH').slice(-1);
    const recentLows = priorSwings.filter((s) => s.type === 'LOW').slice(-1);

    // Check bullish BOS: did this candle close above most recent swing high?
    if (recentHighs.length > 0 && !seen.has('LONG')) {
      const swingHigh = recentHighs[0];
      if (
        candle.close > swingHigh.price &&
        candle.close - swingHigh.price >= atrVal * MIN_DISPLACEMENT_ATR
      ) {
        // Bullish BOS confirmed
        // Invalidation = most recent swing low BEFORE the BOS
        const invalidationLow = priorSwings.filter((s) => s.type === 'LOW').slice(-1)[0];

        const op = makeOpinion({
          tactic: 'bos',
          timeframe: tf,
          direction: 'LONG',
          level: swingHigh.price,
          formedAt: new Date(candle.time).getTime(),
          entry: candle.close,
          invalidation: invalidationLow ? invalidationLow.price : swingHigh.price * 0.99,
          targets: null,  // BOS doesn't dictate targets — coherence checker uses other tactics for that
          strength: computeBosStrength(candle, swingHigh, atrVal),
          evidence: {
            brokenLevel: swingHigh.price,
            closePrice: candle.close,
            displacementATR: ((candle.close - swingHigh.price) / atrVal).toFixed(2),
            barsAgo: candles.length - 1 - i,
          },
          description: `${tf} bullish BOS @ ${swingHigh.price.toFixed(swingHigh.price > 100 ? 2 : 5)}, ${candles.length - 1 - i} bars ago`,
        });
        if (op) opinions.push(op);
        seen.add('LONG');
      }
    }

    // Check bearish BOS: did this candle close below most recent swing low?
    if (recentLows.length > 0 && !seen.has('SHORT')) {
      const swingLow = recentLows[0];
      if (
        candle.close < swingLow.price &&
        swingLow.price - candle.close >= atrVal * MIN_DISPLACEMENT_ATR
      ) {
        const invalidationHigh = priorSwings.filter((s) => s.type === 'HIGH').slice(-1)[0];

        const op = makeOpinion({
          tactic: 'bos',
          timeframe: tf,
          direction: 'SHORT',
          level: swingLow.price,
          formedAt: new Date(candle.time).getTime(),
          entry: candle.close,
          invalidation: invalidationHigh ? invalidationHigh.price : swingLow.price * 1.01,
          targets: null,
          strength: computeBosStrength(candle, swingLow, atrVal),
          evidence: {
            brokenLevel: swingLow.price,
            closePrice: candle.close,
            displacementATR: ((swingLow.price - candle.close) / atrVal).toFixed(2),
            barsAgo: candles.length - 1 - i,
          },
          description: `${tf} bearish BOS @ ${swingLow.price.toFixed(swingLow.price > 100 ? 2 : 5)}, ${candles.length - 1 - i} bars ago`,
        });
        if (op) opinions.push(op);
        seen.add('SHORT');
      }
    }

    if (seen.size === 2) break; // got both directions, stop scanning
  }

  return opinions;
}

// BOS strength: based on candle body strength + displacement size
function computeBosStrength(candle, swing, atrVal) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0.4;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;       // 0-1, higher = more decisive

  const displacement = Math.abs(candle.close - swing.price);
  const displacementATR = displacement / atrVal;
  const displacementScore = Math.min(displacementATR / 2, 1); // 2 ATR displacement = max

  // Combine: 60% displacement, 40% body strength
  return 0.4 + 0.6 * (displacementScore * 0.6 + bodyRatio * 0.4);
}

module.exports = { detect };