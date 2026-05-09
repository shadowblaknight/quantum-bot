/* eslint-disable */
// V12.3 — api/events/mss.js
//
// MARKET STRUCTURE SHIFT detector.
//
// CRITICAL: MSS is REVERSAL-only. It signals trend change.
// BOS is CONTINUATION-only. They are different events with different
// trade implications and live in separate detector files.
//
// MSS rules (research-confirmed across 7+ ICT sources):
//   1. There must be a prior trend (HH+HL bullish, or LH+LL bearish)
//   2. A candle CLOSE breaks the most recent counter-trend swing
//      (bullish trend → break of last HL = bearish MSS, etc.)
//   3. The break must be with displacement (large body candle, not a slow drift)
//   4. The break must close past the swing — wicks don't count
//
// Bullish MSS = price was in DOWNTREND (LH+LL), now closes ABOVE a recent LH
//               → reversal up
// Bearish MSS = price was in UPTREND (HH+HL), now closes BELOW a recent HL
//               → reversal down

const { makeEvent } = require('./_event');
const { detectSwings } = require('./_swings');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 40 || !atr || atr <= 0) return events;

  const swings = detectSwings(candles, 2);
  if (swings.length < 6) return events;

  // Look at the last 30 candles for breaks
  const N = Math.min(30, candles.length);
  const startIdx = candles.length - N;

  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    const cBody = Math.abs(c.close - c.open);

    // Need decent displacement on the breaking candle
    if (cBody < atr * 0.6) continue;

    // What swings existed BEFORE this candle?
    const priorSwings = swings.filter((s) => s.index < i);
    if (priorSwings.length < 4) continue;

    // Look at last 4 swings to determine the trend BEFORE this break
    const last4 = priorSwings.slice(-4);
    const last4Highs = last4.filter((s) => s.type === 'high');
    const last4Lows = last4.filter((s) => s.type === 'low');
    if (last4Highs.length < 2 || last4Lows.length < 2) continue;

    // Was the prior structure UPTREND? (HH+HL)
    const wasUp =
      last4Highs[last4Highs.length - 1].price > last4Highs[last4Highs.length - 2].price &&
      last4Lows[last4Lows.length - 1].price  > last4Lows[last4Lows.length - 2].price;

    // Was it DOWNTREND? (LH+LL)
    const wasDown =
      last4Highs[last4Highs.length - 1].price < last4Highs[last4Highs.length - 2].price &&
      last4Lows[last4Lows.length - 1].price  < last4Lows[last4Lows.length - 2].price;

    // Bearish MSS: prior trend was UP, this candle CLOSES below the most recent HL
    if (wasUp) {
      const lastHL = last4Lows[last4Lows.length - 1];
      if (c.close < lastHL.price && c.close < c.open) {
        events.push(makeEvent({
          type: 'mss',
          ts: c.time,
          timeframe,
          price: lastHL.price,
          direction: 'SHORT',
          evidence: {
            priorTrend: 'UP',
            brokenSwing: 'higherLow',
            brokenLevel: lastHL.price,
            closePrice: c.close,
            displacementATR: cBody / atr,
            barsAgo: candles.length - 1 - i,
          },
        }));
      }
    }

    // Bullish MSS: prior trend was DOWN, this candle CLOSES above the most recent LH
    if (wasDown) {
      const lastLH = last4Highs[last4Highs.length - 1];
      if (c.close > lastLH.price && c.close > c.open) {
        events.push(makeEvent({
          type: 'mss',
          ts: c.time,
          timeframe,
          price: lastLH.price,
          direction: 'LONG',
          evidence: {
            priorTrend: 'DOWN',
            brokenSwing: 'lowerHigh',
            brokenLevel: lastLH.price,
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