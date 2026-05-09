/* eslint-disable */
// V12.3 — api/events/ote-zone.js
//
// OTE (Optimal Trade Entry) zone detector.
//
// In ICT methodology, the OTE zone is the 62%-79% Fibonacci retracement
// of a clear impulse leg. The 0.705 level is the "sweet spot."
//
// We emit ote-zone events when price is currently inside the OTE band
// of the most recent clear impulse. Templates use this to find
// continuation entries.
//
// Bullish OTE: impulse is up (low → high), price retraces into 62-79%
//              of that range from the high. Looking for buys.
// Bearish OTE: impulse is down (high → low), price retraces into 62-79%
//              from the low. Looking for sells.
//
// Required: the impulse must be "real" — at least 3 ATR of move.

const { makeEvent } = require('./_event');
const { detectSwings, recentSwings } = require('./_swings');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 30 || !atr || atr <= 0) return events;

  const swings = detectSwings(candles, 2);
  if (swings.length < 3) return events;

  const lastCandle = candles[candles.length - 1];
  const currentPrice = lastCandle.close;

  // Find the most recent clear impulse:
  //   - Most recent swing high and most recent swing low
  //   - The MORE RECENT of these two anchors the "from" of the impulse
  //   - The OLDER one anchors the "to"
  const lastHighs = recentSwings(swings, 'high', 1);
  const lastLows = recentSwings(swings, 'low', 1);
  if (lastHighs.length === 0 || lastLows.length === 0) return events;

  const lastHigh = lastHighs[0];
  const lastLow = lastLows[0];

  // Determine impulse direction by which swing is more recent
  let impulseFrom, impulseTo, impulseDir;
  if (lastHigh.index > lastLow.index) {
    // Last move was UP (low → high)
    impulseFrom = lastLow;
    impulseTo = lastHigh;
    impulseDir = 'LONG';
  } else {
    // Last move was DOWN (high → low)
    impulseFrom = lastHigh;
    impulseTo = lastLow;
    impulseDir = 'SHORT';
  }

  const impulseRange = Math.abs(impulseTo.price - impulseFrom.price);
  if (impulseRange < atr * 3) return events;

  // Compute OTE band
  const ote62 = impulseDir === 'LONG'
    ? impulseTo.price - impulseRange * 0.62
    : impulseTo.price + impulseRange * 0.62;
  const ote705 = impulseDir === 'LONG'
    ? impulseTo.price - impulseRange * 0.705
    : impulseTo.price + impulseRange * 0.705;
  const ote79 = impulseDir === 'LONG'
    ? impulseTo.price - impulseRange * 0.79
    : impulseTo.price + impulseRange * 0.79;

  const upper = Math.max(ote62, ote79);
  const lower = Math.min(ote62, ote79);

  // Is current price inside OTE band?
  if (currentPrice < lower || currentPrice > upper) return events;

  events.push(makeEvent({
    type: 'ote-zone-entered',
    ts: lastCandle.time,
    timeframe,
    price: ote705,
    direction: impulseDir,
    zone: { upper, lower },
    evidence: {
      impulseFrom: impulseFrom.price,
      impulseTo: impulseTo.price,
      impulseDir,
      impulseRangeATR: impulseRange / atr,
      sweetSpot: ote705,
      ote62,
      ote79,
      currentPrice,
      slBeyond: impulseFrom.price, // SL goes beyond the swing that started the impulse
    },
  }));

  return events;
}

module.exports = { detect };