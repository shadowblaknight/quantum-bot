/* eslint-disable */
// V12.3 — api/events/breaker.js
//
// BREAKER BLOCK detector.
//
// A Breaker Block is a failed Order Block. Sequence:
//   1. There was an OB (e.g. bullish OB at price X)
//   2. Price swept the swing extreme that anchored the OB (took out stops)
//   3. MSS confirmed the trend has flipped against the OB
//   4. The candle that DID the sweep becomes the Breaker Block — its body
//      now acts as resistance/support in the NEW direction
//
// In practical terms, after a bullish-trend MSS-down, the candle that
// made the most recent swing high (and got swept) is the bearish Breaker.
// Its body zone is now expected to reject price on a retest.
//
// The Unicorn template specifically looks for an FVG overlapping a
// Breaker — that's the "unicorn" zone.

const { makeEvent } = require('./_event');
const { detectSwings } = require('./_swings');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 40 || !atr || atr <= 0) return events;

  const swings = detectSwings(candles, 2);
  if (swings.length < 6) return events;

  // For each MSS-style break in the last 30 bars, find the swept swing
  // and locate the Breaker candle (the candle that made the swept swing).
  const N = Math.min(30, candles.length);
  const startIdx = candles.length - N;

  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    const cBody = Math.abs(c.close - c.open);
    if (cBody < atr * 0.6) continue;

    const priorSwings = swings.filter((s) => s.index < i);
    if (priorSwings.length < 4) continue;

    const last4 = priorSwings.slice(-4);
    const last4Highs = last4.filter((s) => s.type === 'high');
    const last4Lows = last4.filter((s) => s.type === 'low');
    if (last4Highs.length < 2 || last4Lows.length < 2) continue;

    const wasUp =
      last4Highs[last4Highs.length - 1].price > last4Highs[last4Highs.length - 2].price &&
      last4Lows[last4Lows.length - 1].price  > last4Lows[last4Lows.length - 2].price;

    const wasDown =
      last4Highs[last4Highs.length - 1].price < last4Highs[last4Highs.length - 2].price &&
      last4Lows[last4Lows.length - 1].price  < last4Lows[last4Lows.length - 2].price;

    // Bearish Breaker: prior trend up, MSS down. Breaker = candle of the most
    // recent swept swing high (last HH) — its body now acts as resistance.
    if (wasUp && c.close < last4Lows[last4Lows.length - 1].price && c.close < c.open) {
      const lastHH = last4Highs[last4Highs.length - 1];
      const breakerCandle = candles[lastHH.index];
      if (!breakerCandle) continue;
      const upper = Math.max(breakerCandle.open, breakerCandle.close);
      const lower = Math.min(breakerCandle.open, breakerCandle.close);

      events.push(makeEvent({
        type: 'breaker-created',
        ts: breakerCandle.time,
        timeframe,
        price: (upper + lower) / 2,
        direction: 'SHORT',
        zone: { upper, lower },
        evidence: {
          priorTrend: 'UP',
          sweptSwing: 'higherHigh',
          sweptLevel: lastHH.price,
          mssCandleClose: c.close,
          mssBarsAgo: candles.length - 1 - i,
        },
      }));
    }

    // Bullish Breaker: prior trend down, MSS up. Breaker = candle of last LL.
    if (wasDown && c.close > last4Highs[last4Highs.length - 1].price && c.close > c.open) {
      const lastLL = last4Lows[last4Lows.length - 1];
      const breakerCandle = candles[lastLL.index];
      if (!breakerCandle) continue;
      const upper = Math.max(breakerCandle.open, breakerCandle.close);
      const lower = Math.min(breakerCandle.open, breakerCandle.close);

      events.push(makeEvent({
        type: 'breaker-created',
        ts: breakerCandle.time,
        timeframe,
        price: (upper + lower) / 2,
        direction: 'LONG',
        zone: { upper, lower },
        evidence: {
          priorTrend: 'DOWN',
          sweptSwing: 'lowerLow',
          sweptLevel: lastLL.price,
          mssCandleClose: c.close,
          mssBarsAgo: candles.length - 1 - i,
        },
      }));
    }
  }

  return events;
}

module.exports = { detect };