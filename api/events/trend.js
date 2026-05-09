/* eslint-disable */
// V12.3 — api/events/trend.js
//
// TREND BIAS detector.
//
// Emits a single "trend" event per call summarizing the current swing
// structure on the timeframe. Templates use trend events to set bias.
//
// UP    = HH+HL pattern in last 4 swings
// DOWN  = LH+LL pattern in last 4 swings
// RANGE = mixed / no clear pattern

const { makeEvent } = require('./_event');
const { detectSwings, recentSwings } = require('./_swings');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 30) return events;

  const swings = detectSwings(candles, 2);
  if (swings.length < 4) return events;

  const lastHighs = recentSwings(swings, 'high', 2);
  const lastLows = recentSwings(swings, 'low', 2);
  if (lastHighs.length < 2 || lastLows.length < 2) return events;

  const higherHighs = lastHighs[1].price > lastHighs[0].price;
  const higherLows = lastLows[1].price > lastLows[0].price;
  const lowerHighs = lastHighs[1].price < lastHighs[0].price;
  const lowerLows = lastLows[1].price < lastLows[0].price;

  let direction = 'NEUTRAL';
  let trend = 'RANGE';
  if (higherHighs && higherLows) { direction = 'LONG'; trend = 'UP'; }
  else if (lowerHighs && lowerLows) { direction = 'SHORT'; trend = 'DOWN'; }

  const lastCandle = candles[candles.length - 1];
  events.push(makeEvent({
    type: 'trend',
    ts: lastCandle.time,
    timeframe,
    price: lastCandle.close,
    direction,
    evidence: {
      trend,
      lastHighs: lastHighs.map((s) => s.price),
      lastLows: lastLows.map((s) => s.price),
      swingCount: swings.length,
    },
  }));

  return events;
}

module.exports = { detect };