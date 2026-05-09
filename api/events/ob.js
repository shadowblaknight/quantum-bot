/* eslint-disable */
// V12.3 — api/events/ob.js
//
// ORDER BLOCK detector.
//
// Order Block = last opposite-color candle before a strong impulse move.
// We emit OB events that templates can correlate with sweep + displacement
// events that occurred near the same time.
//
// Detection:
//   1. Find a displacement candle (large body, > 1.0 ATR)
//   2. The OB is the IMMEDIATELY PRECEDING candle of the opposite color
//   3. OB zone = body of that candle (open to close, NOT including wicks)
//   4. OB is "untested" if no candle since has touched the zone
//
// Real ICT pros require the OB to come AFTER a liquidity sweep. We don't
// enforce that in the detector — templates do that linkage by checking
// for a sweep event near the same time.

const { makeEvent } = require('./_event');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 30 || !atr || atr <= 0) return events;

  const N = Math.min(50, candles.length - 1);
  const startIdx = candles.length - N;

  for (let i = startIdx + 1; i < candles.length; i++) {
    const impulse = candles[i];
    const ob = candles[i - 1];

    const impulseBody = Math.abs(impulse.close - impulse.open);
    if (impulseBody < atr * 1.0) continue;

    const obBody = Math.abs(ob.close - ob.open);
    const obRange = ob.high - ob.low;
    if (obRange <= 0) continue;
    const obBodyRatio = obBody / obRange;
    if (obBodyRatio < 0.3) continue; // need a real candle, not a doji

    // Bullish impulse → OB should be a bearish (down-close) candle
    if (impulse.close > impulse.open && ob.close < ob.open) {
      const upper = Math.max(ob.open, ob.close);
      const lower = Math.min(ob.open, ob.close);

      // Has it been tested (any candle traded into the body since)?
      let tested = false;
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k].low <= upper && candles[k].high >= lower) { tested = true; break; }
      }

      events.push(makeEvent({
        type: 'ob-created',
        ts: ob.time,
        timeframe,
        price: (upper + lower) / 2,
        direction: 'LONG',
        zone: { upper, lower },
        evidence: {
          obBodyRatio,
          impulseATR: impulseBody / atr,
          tested,
          barsAgo: candles.length - 1 - (i - 1),
        },
      }));
    }

    // Bearish impulse → OB should be a bullish (up-close) candle
    if (impulse.close < impulse.open && ob.close > ob.open) {
      const upper = Math.max(ob.open, ob.close);
      const lower = Math.min(ob.open, ob.close);

      let tested = false;
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k].low <= upper && candles[k].high >= lower) { tested = true; break; }
      }

      events.push(makeEvent({
        type: 'ob-created',
        ts: ob.time,
        timeframe,
        price: (upper + lower) / 2,
        direction: 'SHORT',
        zone: { upper, lower },
        evidence: {
          obBodyRatio,
          impulseATR: impulseBody / atr,
          tested,
          barsAgo: candles.length - 1 - (i - 1),
        },
      }));
    }
  }

  return events;
}

module.exports = { detect };