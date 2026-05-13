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
const { detectSwings, recentSwings, determineTrend } = require('./_swings');

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 30) return events;

  const swings = detectSwings(candles, 2);
  if (swings.length < 3) return events;

  // New logic: most recent swing extreme dominates
  const trend = determineTrend(swings);

  let direction = 'NEUTRAL';
  if (trend === 'UP') direction = 'LONG';
  else if (trend === 'DOWN') direction = 'SHORT';

  // Build evidence: show what most-recent swings look like
  const lastHighs = recentSwings(swings, 'high', 2);
  const lastLows = recentSwings(swings, 'low', 2);

  const lastCandle = candles[candles.length - 1];
  events.push(makeEvent({
    type: 'trend',
    ts: new Date(lastCandle.time).getTime(),
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