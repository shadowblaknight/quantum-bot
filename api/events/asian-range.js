/* eslint-disable */
// V12.3 — api/events/asian-range.js
//
// ASIAN RANGE detector.
//
// Asian session = 20:00 NY → 00:00 NY = 01:00 UTC → 05:00 UTC (EST baseline)
// Generous union: 22:00 UTC previous day → 05:00 UTC current day.
//
// We emit ONE event when the Asian session has fully closed (after 05:00 UTC),
// reporting the range high + low that day. This is the prerequisite for
// the Judas Swing template — without an Asian range, no Judas.
//
// Quality filter: range must be >= 0.5 ATR and <= 5.0 ATR (filter out
// wild news days and ultra-quiet days where the model breaks down).

const { makeEvent } = require('./_event');

// Asian session window in UTC (covers EST/EDT generously)
function isInAsianSession(date) {
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  // 22:00-23:59 UTC previous day OR 00:00-05:00 UTC current day
  return utcMin >= 22 * 60 || utcMin < 5 * 60;
}

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 30 || !atr || atr <= 0) return events;

  // Only meaningful on 15m or 1h timeframes
  if (timeframe !== '15m' && timeframe !== '1h') return events;

  // Group candles by UTC date (which Asian session each one belongs to)
  // Asian session for date D = 22:00 UTC (D-1) → 05:00 UTC D
  // We attribute each candle to "the Asian session ending today" if it's
  // within the window.

  const sessionsByDate = new Map();
  for (const c of candles) {
    const d = new Date(c.time);
    if (!isInAsianSession(d)) continue;

    // Determine the "session end date" — i.e., the UTC date when the
    // 05:00 cutoff falls. If the candle is between 22:00-23:59 UTC,
    // the session ends on the NEXT UTC date.
    const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    const sessionEnd = new Date(d);
    if (utcMin >= 22 * 60) sessionEnd.setUTCDate(d.getUTCDate() + 1);
    const dateKey = sessionEnd.toISOString().slice(0, 10);

    if (!sessionsByDate.has(dateKey)) {
      sessionsByDate.set(dateKey, []);
    }
    sessionsByDate.get(dateKey).push(c);
  }

  // For each session, emit an asian-range-formed event using the LAST candle
  // of the session as the timestamp (range is "known" once session closes).
  const now = Date.now();
  for (const [dateKey, sessionCandles] of sessionsByDate) {
    if (sessionCandles.length < 4) continue; // need a meaningful session

    const high = Math.max(...sessionCandles.map((c) => c.high));
    const low = Math.min(...sessionCandles.map((c) => c.low));
    const range = high - low;
    const rangeATR = range / atr;

    // Only emit if range is reasonable
    if (rangeATR < 0.5 || rangeATR > 5.0) continue;

    // Last candle of the session (chronologically)
    const lastCandle = sessionCandles[sessionCandles.length - 1];

    // Only emit if session has actually ended (last candle close + 15min < now)
    if (lastCandle.time + 15 * 60 * 1000 > now) continue;

    events.push(makeEvent({
      type: 'asian-range-formed',
      ts: lastCandle.time,
      timeframe,
      price: (high + low) / 2,
      direction: 'NEUTRAL',
      zone: { upper: high, lower: low },
      evidence: {
        high,
        low,
        midpoint: (high + low) / 2,
        rangeATR,
        candleCount: sessionCandles.length,
        sessionDate: dateKey,
      },
    }));
  }

  return events;
}

module.exports = { detect, isInAsianSession };