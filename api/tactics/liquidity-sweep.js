/* eslint-disable */
// V12 — api/tactics/liquidity-sweep.js
//
// Liquidity Sweep detector. Price spikes past a known liquidity level (session
// high/low, swing point, or PDH/PDL), grabs the stops sitting there, then
// reverses sharply. This is the inverse of a breakout — the move past the
// level fails immediately.
//
// PATTERN:
//   1. A "level of interest" exists (session H/L, recent swing, PDH/PDL)
//   2. A candle wick exceeds that level
//   3. The candle's body closes back inside (rejection)
//   4. Price reverses at least 0.5 ATR within the next few bars
//
// Why this matters: institutions hunt stops above resistance / below support.
// A sweep that immediately reverses = "smart money took retail's stops, now
// reversing." High-probability counter-direction setup.
//
// Output direction:
//   - LONG: sweep BELOW a low (stops grabbed, reversal up expected)
//   - SHORT: sweep ABOVE a high (stops grabbed, reversal down expected)
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');
const { findSwings } = require('./trend-structure');
const { atr, sessionForHour } = require('../_lib');

const MAX_SWEEP_AGE_BARS = 12;
const MIN_REJECTION_RATIO = 0.5;     // body must close back ≥50% of the wick
const MIN_REVERSAL_ATR = 0.5;        // reversal candles must extend ≥0.5 ATR after sweep

function detect(candles, context = {}) {
  const tf = context.timeframe;
  if (!tf || !Array.isArray(candles) || candles.length < 30) return [];

  const atrVal = atr(candles, 14);
  if (!atrVal || !isFinite(atrVal)) return [];

  // Build the list of "liquidity levels" we care about for sweep detection
  const levels = collectLiquidityLevels(candles);
  if (levels.length === 0) return [];

  const opinions = [];
  const lastIdx = candles.length - 1;
  const startIdx = Math.max(0, lastIdx - MAX_SWEEP_AGE_BARS);

  for (let i = startIdx; i <= lastIdx; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range <= 0) continue;

    // Check each liquidity level for a sweep
    for (const lvl of levels) {
      // SHORT sweep: candle wicked above level, then rejected back below
      if (c.high > lvl.price && c.close < lvl.price) {
        const wickAboveLevel = c.high - lvl.price;
        const bodyToClose = lvl.price - Math.max(c.open, c.close);
        const rejectionRatio = wickAboveLevel > 0 ? Math.max(0, bodyToClose) / wickAboveLevel : 0;

        if (rejectionRatio < MIN_REJECTION_RATIO) continue;

        // Confirm reversal — at least one subsequent candle must extend down
        const reversal = checkReversal(candles, i, 'down', atrVal);
        if (!reversal.confirmed) continue;

        // Bonus: was it a session level being swept during the next session?
        const sessionBonus = computeSessionBonus(c, lvl, 'short');

        const op = makeOpinion({
          tactic: 'liquiditySweep',
          timeframe: tf,
          direction: 'SHORT',
          level: lvl.price,
          formedAt: new Date(c.time).getTime(),
          entry: c.close,
          invalidation: c.high + atrVal * 0.2,
          targets: null,
          strength: computeSweepStrength(rejectionRatio, reversal.distance, atrVal, sessionBonus, lastIdx - i),
          evidence: {
            type: 'short',
            sweptLevel: lvl.price,
            sweptLevelType: lvl.type,
            wickHigh: c.high,
            closePrice: c.close,
            rejectionRatio: rejectionRatio.toFixed(2),
            reversalATR: (reversal.distance / atrVal).toFixed(2),
            sessionBonus,
            barsAgo: lastIdx - i,
          },
          description: `${tf} sweep above ${lvl.type} (${lvl.price.toFixed(lvl.price > 100 ? 2 : 5)}) with rejection, ${lastIdx - i} bars ago`,
        });
        if (op) opinions.push(op);
      }

      // LONG sweep: candle wicked below level, then rejected back above
      if (c.low < lvl.price && c.close > lvl.price) {
        const wickBelowLevel = lvl.price - c.low;
        const bodyFromClose = Math.min(c.open, c.close) - lvl.price;
        const rejectionRatio = wickBelowLevel > 0 ? Math.max(0, bodyFromClose) / wickBelowLevel : 0;

        if (rejectionRatio < MIN_REJECTION_RATIO) continue;

        const reversal = checkReversal(candles, i, 'up', atrVal);
        if (!reversal.confirmed) continue;

        const sessionBonus = computeSessionBonus(c, lvl, 'long');

        const op = makeOpinion({
          tactic: 'liquiditySweep',
          timeframe: tf,
          direction: 'LONG',
          level: lvl.price,
          formedAt: new Date(c.time).getTime(),
          entry: c.close,
          invalidation: c.low - atrVal * 0.2,
          targets: null,
          strength: computeSweepStrength(rejectionRatio, reversal.distance, atrVal, sessionBonus, lastIdx - i),
          evidence: {
            type: 'long',
            sweptLevel: lvl.price,
            sweptLevelType: lvl.type,
            wickLow: c.low,
            closePrice: c.close,
            rejectionRatio: rejectionRatio.toFixed(2),
            reversalATR: (reversal.distance / atrVal).toFixed(2),
            sessionBonus,
            barsAgo: lastIdx - i,
          },
          description: `${tf} sweep below ${lvl.type} (${lvl.price.toFixed(lvl.price > 100 ? 2 : 5)}) with rejection, ${lastIdx - i} bars ago`,
        });
        if (op) opinions.push(op);
      }
    }
  }

  // Dedup: per direction, keep most recent
  const longSweeps = opinions.filter((o) => o.direction === 'LONG').sort((a, b) => b.formedAt - a.formedAt).slice(0, 2);
  const shortSweeps = opinions.filter((o) => o.direction === 'SHORT').sort((a, b) => b.formedAt - a.formedAt).slice(0, 2);

  return [...longSweeps, ...shortSweeps];
}

// Find liquidity levels: recent swing highs/lows + session boundaries (within candle range)
function collectLiquidityLevels(candles) {
  const swings = findSwings(candles);
  const recent = swings.slice(-10); // last 10 swings
  return recent.map((s) => ({
    type: s.type === 'HIGH' ? 'swingHigh' : 'swingLow',
    price: s.price,
  }));
  // NOTE: session H/L are computed in session-levels.js detector. We don't
  // duplicate that here — coherence checker reads both.
}

function checkReversal(candles, sweepIdx, direction, atrVal) {
  // Look at next 1-3 candles after sweep
  const lookahead = Math.min(3, candles.length - sweepIdx - 1);
  if (lookahead < 1) return { confirmed: false, distance: 0 };

  const sweepCandle = candles[sweepIdx];
  let maxDistance = 0;

  for (let j = 1; j <= lookahead; j++) {
    const c = candles[sweepIdx + j];
    if (direction === 'down') {
      const dist = sweepCandle.close - c.low;
      if (dist > maxDistance) maxDistance = dist;
    } else {
      const dist = c.high - sweepCandle.close;
      if (dist > maxDistance) maxDistance = dist;
    }
  }

  return {
    confirmed: maxDistance >= atrVal * MIN_REVERSAL_ATR,
    distance: maxDistance,
  };
}

function computeSessionBonus(candle, level, direction) {
  // If sweep happens during NY/London (high liquidity sessions), it's stronger
  const utcH = new Date(candle.time).getUTCHours();
  const session = sessionForHour(utcH);
  if (session === 'NEW_YORK' || session === 'OVERLAP' || session === 'LONDON') return 0.1;
  return 0;
}

function computeSweepStrength(rejectionRatio, reversal, atrVal, sessionBonus, ageBars) {
  const rejScore = Math.min((rejectionRatio - MIN_REJECTION_RATIO) / 0.5, 1);
  const revATR = reversal / atrVal;
  const revScore = Math.min((revATR - MIN_REVERSAL_ATR) / 1.5, 1);
  const recency = Math.max(0, 1 - ageBars / MAX_SWEEP_AGE_BARS);
  return Math.min(0.4 + rejScore * 0.25 + revScore * 0.25 + sessionBonus + recency * 0.1, 1);
}

module.exports = { detect };