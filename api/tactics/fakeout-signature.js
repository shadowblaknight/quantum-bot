/* eslint-disable */
// V12 — api/tactics/fakeout-signature.js
//
// Fakeout detector. A fakeout is when price BREAKS a known level (looks like a
// breakout), then within a few bars REVERSES back through the level, trapping
// breakout traders. This is a counter-trend setup with relatively low hit rate
// (you said: low percentage but real).
//
// PATTERN:
//   1. Price breaks past a level (swing high, prior day high, etc.)
//   2. Initial close confirms the break (looks like real breakout)
//   3. Within next 3-5 bars, price reverses and closes back through the level
//   4. Volume on the failed breakout was high (people piled in then bailed)
//
// We're conservative here — high false-positive rate if loose. Strict criteria:
//   - Need ≥ 2 confirming candles AFTER reversal
//   - Reversal candle must have strong body (≥ 60% body ratio)
//   - Original break must have been at least 0.5 ATR past the level
//
// Direction: opposite of the failed break.
//   - SHORT fakeout: failed bullish breakout → expect price to reverse DOWN
//   - LONG fakeout: failed bearish breakout → expect price to reverse UP
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');
const { findSwings } = require('./trend-structure');
const { atr } = require('../_lib');

const MAX_FAKEOUT_AGE_BARS = 15;
const MIN_BREAK_ATR = 0.5;
const MIN_REVERSAL_BODY_RATIO = 0.6;
const MAX_BARS_TO_REVERSE = 5;
const MIN_CONFIRMATIONS = 2;

function detect(candles, context = {}) {
  const tf = context.timeframe;
  if (!tf || !Array.isArray(candles) || candles.length < 30) return [];

  const atrVal = atr(candles, 14);
  if (!atrVal || !isFinite(atrVal)) return [];

  const swings = findSwings(candles);
  if (swings.length < 2) return [];

  const opinions = [];
  const lastIdx = candles.length - 1;
  const startIdx = Math.max(0, lastIdx - MAX_FAKEOUT_AGE_BARS);

  // For each candle in our window, check if it CLOSED PAST a swing level
  // (potential breakout), then look for reversal within the next bars
  for (let i = startIdx; i < lastIdx - MIN_CONFIRMATIONS; i++) {
    const breakCandle = candles[i];

    // Find the most recent swing BEFORE this candle
    const priorSwings = swings.filter((s) => s.idx < i);
    if (priorSwings.length === 0) continue;

    // Check bullish fakeout: closed above a swing high, then reversed
    const recentHighs = priorSwings.filter((s) => s.type === 'HIGH').slice(-1);
    if (recentHighs.length > 0) {
      const swingHigh = recentHighs[0];
      if (
        breakCandle.close > swingHigh.price &&
        breakCandle.close - swingHigh.price >= atrVal * MIN_BREAK_ATR
      ) {
        // Look for reversal in next MAX_BARS_TO_REVERSE candles
        const reversal = findReversal(candles, i, swingHigh.price, 'bullish-failed', atrVal);
        if (reversal) {
          const op = makeOpinion({
            tactic: 'fakeout',
            timeframe: tf,
            direction: 'SHORT',  // failed bullish breakout = short bias
            level: swingHigh.price,
            formedAt: new Date(reversal.candle.time).getTime(),
            entry: reversal.candle.close,
            invalidation: reversal.maxAfterBreak + atrVal * 0.2,
            targets: null,
            strength: computeFakeoutStrength(reversal, breakCandle, swingHigh, atrVal),
            evidence: {
              type: 'failedBullish',
              brokenLevel: swingHigh.price,
              breakHigh: breakCandle.close,
              reversalCandle: reversal.idx - i,
              confirmations: reversal.confirmations,
              barsAgo: lastIdx - reversal.idx,
            },
            description: `${tf} failed bullish breakout @ ${swingHigh.price.toFixed(swingHigh.price > 100 ? 2 : 5)}, ${reversal.confirmations} bars confirmed`,
          });
          if (op) opinions.push(op);
        }
      }
    }

    // Check bearish fakeout: closed below a swing low, then reversed
    const recentLows = priorSwings.filter((s) => s.type === 'LOW').slice(-1);
    if (recentLows.length > 0) {
      const swingLow = recentLows[0];
      if (
        breakCandle.close < swingLow.price &&
        swingLow.price - breakCandle.close >= atrVal * MIN_BREAK_ATR
      ) {
        const reversal = findReversal(candles, i, swingLow.price, 'bearish-failed', atrVal);
        if (reversal) {
          const op = makeOpinion({
            tactic: 'fakeout',
            timeframe: tf,
            direction: 'LONG',
            level: swingLow.price,
            formedAt: new Date(reversal.candle.time).getTime(),
            entry: reversal.candle.close,
            invalidation: reversal.minAfterBreak - atrVal * 0.2,
            targets: null,
            strength: computeFakeoutStrength(reversal, breakCandle, swingLow, atrVal),
            evidence: {
              type: 'failedBearish',
              brokenLevel: swingLow.price,
              breakLow: breakCandle.close,
              reversalCandle: reversal.idx - i,
              confirmations: reversal.confirmations,
              barsAgo: lastIdx - reversal.idx,
            },
            description: `${tf} failed bearish breakout @ ${swingLow.price.toFixed(swingLow.price > 100 ? 2 : 5)}, ${reversal.confirmations} bars confirmed`,
          });
          if (op) opinions.push(op);
        }
      }
    }
  }

  // Dedup, return most recent per direction
  const longs = opinions.filter((o) => o.direction === 'LONG').sort((a, b) => b.formedAt - a.formedAt).slice(0, 1);
  const shorts = opinions.filter((o) => o.direction === 'SHORT').sort((a, b) => b.formedAt - a.formedAt).slice(0, 1);

  return [...longs, ...shorts];
}

// Look for reversal candle within MAX_BARS_TO_REVERSE after the break.
// Returns reversal info if confirmed, null otherwise.
function findReversal(candles, breakIdx, level, type, atrVal) {
  const breakCandle = candles[breakIdx];
  let maxAfterBreak = breakCandle.high;
  let minAfterBreak = breakCandle.low;

  for (let j = breakIdx + 1; j <= Math.min(breakIdx + MAX_BARS_TO_REVERSE, candles.length - 1); j++) {
    const c = candles[j];
    if (c.high > maxAfterBreak) maxAfterBreak = c.high;
    if (c.low < minAfterBreak) minAfterBreak = c.low;

    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = Math.abs(c.close - c.open);
    const bodyRatio = body / range;

    if (type === 'bullish-failed') {
      // Reversal candle: closes BACK below the level with strong body
      if (c.close < level && bodyRatio >= MIN_REVERSAL_BODY_RATIO) {
        // Confirm: at least MIN_CONFIRMATIONS more bars stay below level
        let confirmations = 1;
        for (let k = j + 1; k < Math.min(j + 1 + MIN_CONFIRMATIONS, candles.length); k++) {
          if (candles[k].close < level) confirmations++;
        }
        if (confirmations >= MIN_CONFIRMATIONS) {
          return { idx: j, candle: c, confirmations, maxAfterBreak, minAfterBreak };
        }
      }
    } else if (type === 'bearish-failed') {
      if (c.close > level && bodyRatio >= MIN_REVERSAL_BODY_RATIO) {
        let confirmations = 1;
        for (let k = j + 1; k < Math.min(j + 1 + MIN_CONFIRMATIONS, candles.length); k++) {
          if (candles[k].close > level) confirmations++;
        }
        if (confirmations >= MIN_CONFIRMATIONS) {
          return { idx: j, candle: c, confirmations, maxAfterBreak, minAfterBreak };
        }
      }
    }
  }
  return null;
}

function computeFakeoutStrength(reversal, breakCandle, swing, atrVal) {
  // Stronger if more confirmations
  const confScore = Math.min(reversal.confirmations / 4, 1);
  // Stronger if break was bigger (more trapped traders)
  const breakSize = Math.abs(breakCandle.close - swing.price) / atrVal;
  const breakScore = Math.min(breakSize / 2, 1);
  // Stronger if reversal candle had strong body
  const range = reversal.candle.high - reversal.candle.low;
  const body = Math.abs(reversal.candle.close - reversal.candle.open);
  const bodyRatio = range > 0 ? body / range : 0;
  return Math.min(0.35 + confScore * 0.25 + breakScore * 0.2 + bodyRatio * 0.2, 1);
}

module.exports = { detect };