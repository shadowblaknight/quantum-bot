/* eslint-disable */
// V12.3 — api/events/bos.js
//
// BREAK OF STRUCTURE detector.
//
// CRITICAL: BOS is CONTINUATION-only. It confirms an existing trend.
// MSS handles reversal-against-trend events (separate file).
//
// BOS rules:
//   1. There must be a prior trend (HH+HL bullish, or LH+LL bearish)
//   2. A candle CLOSES through the most recent same-direction swing extreme
//      (bullish trend → break above the last HH = bullish BOS confirms continuation)
//   3. Close must be with displacement (large body, not a wick-only break)
//
// Bullish BOS = uptrend already → price closes ABOVE the last HH
// Bearish BOS = downtrend already → price closes BELOW the last LL

const { makeEvent } = require('./_event');
const { detectSwings } = require('./_swings');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 40 || !atr || atr <= 0) return events;

  const swings = detectSwings(candles, 2);
  if (swings.length < 6) return events;

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

    const isUp =
      last4Highs[last4Highs.length - 1].price > last4Highs[last4Highs.length - 2].price &&
      last4Lows[last4Lows.length - 1].price  > last4Lows[last4Lows.length - 2].price;

    const isDown =
      last4Highs[last4Highs.length - 1].price < last4Highs[last4Highs.length - 2].price &&
      last4Lows[last4Lows.length - 1].price  < last4Lows[last4Lows.length - 2].price;

    // Bullish BOS: prior trend UP, candle closes ABOVE last HH
    if (isUp) {
      const lastHH = last4Highs[last4Highs.length - 1];
      if (c.close > lastHH.price && c.close > c.open) {
        events.push(makeEvent({
          type: 'bos',
          ts: c.time,
          timeframe,
          price: lastHH.price,
          direction: 'LONG',
          evidence: {
            priorTrend: 'UP',
            brokenSwing: 'higherHigh',
            brokenLevel: lastHH.price,
            closePrice: c.close,
            displacementATR: cBody / atr,
            barsAgo: candles.length - 1 - i,
          },
        }));
      }
    }

    // Bearish BOS: prior trend DOWN, candle closes BELOW last LL
    if (isDown) {
      const lastLL = last4Lows[last4Lows.length - 1];
      if (c.close < lastLL.price && c.close < c.open) {
        events.push(makeEvent({
          type: 'bos',
          ts: c.time,
          timeframe,
          price: lastLL.price,
          direction: 'SHORT',
          evidence: {
            priorTrend: 'DOWN',
            brokenSwing: 'lowerLow',
            brokenLevel: lastLL.price,
            closePrice: c.close,
            displacementATR: cBody / atr,
            barsAgo: candles.length - 1 - i,
          },
        }));
      }
    }
  }

  return events;
}

module.exports = { detect };