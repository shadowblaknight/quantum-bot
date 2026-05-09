/* eslint-disable */
// V12.3 — api/events/displacement.js
//
// DISPLACEMENT detector.
//
// Displacement = a strong, fast directional move that signals institutional
// commitment. Real ICT criterion: the impulse leaves an FVG behind (price
// moved so fast that the middle candle's wicks didn't overlap the outer two).
//
// Our criteria for a displacement event:
//   1. A 3-candle window where:
//      a. All 3 candles same direction (or at minimum the middle is dominant)
//      b. Middle candle body >= 1.0 ATR
//      c. Middle candle body-to-range ratio >= 0.65 (small wicks)
//      d. There IS an FVG: candle1.high < candle3.low (bullish) OR
//         candle1.low > candle3.high (bearish)
//
// This is more restrictive than just "big candle" — it requires the
// imbalance signature that real ICT pros call "displacement."

const { makeEvent } = require('./_event');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 30 || !atr || atr <= 0) return events;

  const N = Math.min(40, candles.length - 2);
  const startIdx = candles.length - N;

  for (let i = startIdx; i < candles.length - 2; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];

    const c2Body = Math.abs(c2.close - c2.open);
    const c2Range = c2.high - c2.low;
    if (c2Range <= 0) continue;
    const c2BodyRatio = c2Body / c2Range;

    // Bullish displacement: middle candle bullish, large body, small wicks,
    // FVG between c1.high and c3.low
    if (c2.close > c2.open
        && c2Body >= atr * 1.0
        && c2BodyRatio >= 0.65
        && c1.high < c3.low) {
      events.push(makeEvent({
        type: 'displacement',
        ts: c2.time,
        timeframe,
        price: c2.close,
        direction: 'LONG',
        evidence: {
          impulseATR: c2Body / atr,
          bodyRatio: c2BodyRatio,
          fvgUpper: c3.low,
          fvgLower: c1.high,
          fvgSizeATR: (c3.low - c1.high) / atr,
          barsAgo: candles.length - 1 - (i + 1),
        },
      }));
    }

    // Bearish displacement: middle candle bearish, large body, small wicks,
    // FVG between c1.low and c3.high
    if (c2.close < c2.open
        && c2Body >= atr * 1.0
        && c2BodyRatio >= 0.65
        && c1.low > c3.high) {
      events.push(makeEvent({
        type: 'displacement',
        ts: c2.time,
        timeframe,
        price: c2.close,
        direction: 'SHORT',
        evidence: {
          impulseATR: c2Body / atr,
          bodyRatio: c2BodyRatio,
          fvgUpper: c1.low,
          fvgLower: c3.high,
          fvgSizeATR: (c1.low - c3.high) / atr,
          barsAgo: candles.length - 1 - (i + 1),
        },
      }));
    }
  }

  return events;
}

module.exports = { detect };