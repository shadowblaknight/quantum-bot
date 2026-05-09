/* eslint-disable */
// V12.3 — api/events/sweep.js
//
// LIQUIDITY SWEEP detector.
//
// A sweep happens when:
//   1. Price wicks beyond a recent swing high (sells liquidity above) or
//      swing low (buy liquidity below)
//   2. Within the same candle (or within 2 candles), price CLOSES back
//      inside the swing range
//   3. The wick excursion is meaningful (>= 0.2 ATR) — not just noise
//
// SHORT sweep = wick ABOVE recent swing high + close back below = sell signal
// LONG sweep  = wick BELOW recent swing low + close back above  = buy signal
//
// We emit the event keyed to the candle that DID the sweep (when it closed).

const { makeEvent } = require('./_event');
const { detectSwings, recentSwings } = require('./_swings');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 30 || !atr || atr <= 0) return events;

  const swings = detectSwings(candles, 2);
  if (swings.length < 4) return events;

  // Look at the last 30 candles for sweep activity
  const N = Math.min(30, candles.length);
  const startIdx = candles.length - N;

  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];

    // What swings existed BEFORE this candle? (don't look at swings that
    // formed after — they include this candle's wick)
    const priorSwings = swings.filter((s) => s.index < i - 2);
    if (priorSwings.length === 0) continue;

    // Recent swing highs and lows (last 5 of each)
    const recentHighs = recentSwings(priorSwings, 'high', 5);
    const recentLows = recentSwings(priorSwings, 'low', 5);

    // SHORT sweep: did this candle wick ABOVE any recent swing high
    // and close back BELOW that swing high?
    for (const swing of recentHighs) {
      if (c.high > swing.price && c.close < swing.price) {
        const wickExcursion = c.high - swing.price;
        if (wickExcursion >= atr * 0.2) {
          events.push(makeEvent({
            type: 'sweep',
            ts: c.time,
            timeframe,
            price: swing.price,
            direction: 'SHORT', // sweep direction → expect short to follow
            evidence: {
              sweptLevel: swing.price,
              sweptLevelType: 'swingHigh',
              wickHigh: c.high,
              closePrice: c.close,
              wickExcursion,
              wickExcursionATR: wickExcursion / atr,
              barsAgo: candles.length - 1 - i,
            },
          }));
          break; // one sweep event per candle is enough
        }
      }
    }

    // LONG sweep: did this candle wick BELOW any recent swing low
    // and close back ABOVE that swing low?
    for (const swing of recentLows) {
      if (c.low < swing.price && c.close > swing.price) {
        const wickExcursion = swing.price - c.low;
        if (wickExcursion >= atr * 0.2) {
          events.push(makeEvent({
            type: 'sweep',
            ts: c.time,
            timeframe,
            price: swing.price,
            direction: 'LONG',
            evidence: {
              sweptLevel: swing.price,
              sweptLevelType: 'swingLow',
              wickLow: c.low,
              closePrice: c.close,
              wickExcursion,
              wickExcursionATR: wickExcursion / atr,
              barsAgo: candles.length - 1 - i,
            },
          }));
          break;
        }
      }
    }
  }

  return events;
}

module.exports = { detect };