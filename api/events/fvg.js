/* eslint-disable */
// V12.3 — api/events/fvg.js
//
// FAIR VALUE GAP detector — emits creation events.
//
// 3-candle imbalance:
//   Bullish FVG: candle1.high < candle3.low (gap up between c1 high and c3 low)
//   Bearish FVG: candle1.low > candle3.high (gap down)
//
// Quality requirements:
//   - Middle candle body >= 0.5 ATR (this is the imbalance generator)
//   - Gap size >= 0.15 ATR (filter micro-gaps)
//   - Track fill % so templates can prefer unfilled FVGs
//
// We compute the 50% midpoint (CE = Consequent Encroachment) as the
// "real" entry trigger per ICT methodology.

const { makeEvent } = require('./_event');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 30 || !atr || atr <= 0) return events;

  const N = Math.min(60, candles.length - 2);
  const startIdx = candles.length - N;

  for (let i = startIdx; i < candles.length - 2; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];

    const c2Body = Math.abs(c2.close - c2.open);
    if (c2Body < atr * 0.5) continue;

    // Bullish FVG
    if (c1.high < c3.low) {
      const gapSize = c3.low - c1.high;
      if (gapSize < atr * 0.15) continue;

      // Compute fill % using all candles AFTER c3
      const upper = c3.low;
      const lower = c1.high;
      const ce = (upper + lower) / 2;
      let lowestRetest = upper;
      for (let k = i + 3; k < candles.length; k++) {
        if (candles[k].low < lowestRetest) lowestRetest = candles[k].low;
      }
      const fillAmount = Math.max(0, upper - Math.max(lower, lowestRetest));
      const fillPercent = fillAmount / gapSize;

      events.push(makeEvent({
        type: 'fvg-created',
        ts: c2.time,
        timeframe,
        price: ce,
        direction: 'LONG',
        zone: { upper, lower },
        evidence: {
          ce,
          gapSize,
          gapSizeATR: gapSize / atr,
          c2BodyATR: c2Body / atr,
          fillPercent,
          barsAgo: candles.length - 1 - (i + 1),
        },
      }));
    }

    // Bearish FVG
    if (c1.low > c3.high) {
      const gapSize = c1.low - c3.high;
      if (gapSize < atr * 0.15) continue;

      const upper = c1.low;
      const lower = c3.high;
      const ce = (upper + lower) / 2;
      let highestRetest = lower;
      for (let k = i + 3; k < candles.length; k++) {
        if (candles[k].high > highestRetest) highestRetest = candles[k].high;
      }
      const fillAmount = Math.max(0, Math.min(upper, highestRetest) - lower);
      const fillPercent = fillAmount / gapSize;

      events.push(makeEvent({
        type: 'fvg-created',
        ts: c2.time,
        timeframe,
        price: ce,
        direction: 'SHORT',
        zone: { upper, lower },
        evidence: {
          ce,
          gapSize,
          gapSizeATR: gapSize / atr,
          c2BodyATR: c2Body / atr,
          fillPercent,
          barsAgo: candles.length - 1 - (i + 1),
        },
      }));
    }
  }

  return events;
}

module.exports = { detect };