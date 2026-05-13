/* eslint-disable */
// V12.3 — api/events/session-levels.js
//
// SESSION LEVELS detector — emits liquidity reference levels.
//
// These are the price levels templates use for TP targeting. Smart money
// targets these as draws on liquidity:
//   - Previous Day High / Low (PDH / PDL)
//   - Asian High / Low (current session)
//   - London High / Low (current session)
//   - Weekly Open
//
// Each emits as a session-level event. Templates filter by direction:
//   For LONG entry: target levels ABOVE current price
//   For SHORT entry: target levels BELOW current price

const { makeEvent } = require('./_event');

// UTC windows (generous DST union)
function classifySession(date) {
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (utcMin >= 22 * 60 || utcMin < 5 * 60) return 'asian';
  if (utcMin >= 6 * 60 && utcMin < 12 * 60) return 'london';
  if (utcMin >= 12 * 60 && utcMin < 19 * 60) return 'newyork';
  return 'between';
}

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 24 || !atr || atr <= 0) return events;
  if (timeframe !== '1h') return events; // 1h is the canonical TF for session levels

  // Candle .time is an ISO string — convert to ms for arithmetic
  const nowMs = new Date(candles[candles.length - 1].time).getTime();
  const today = new Date(nowMs);
  const todayUTCDate = today.toISOString().slice(0, 10);
  const yesterday = new Date(nowMs - 86400 * 1000);
  const yesterdayUTCDate = yesterday.toISOString().slice(0, 10);

  // PDH / PDL — yesterday's high and low (UTC day boundary)
  const yesterdayCandles = candles.filter((c) => {
    return new Date(c.time).toISOString().slice(0, 10) === yesterdayUTCDate;
  });
  if (yesterdayCandles.length > 0) {
    const pdh = Math.max(...yesterdayCandles.map((c) => c.high));
    const pdl = Math.min(...yesterdayCandles.map((c) => c.low));
    const lastTime = new Date(yesterdayCandles[yesterdayCandles.length - 1].time).getTime();
    events.push(makeEvent({
      type: 'session-level',
      ts: lastTime,
      timeframe,
      price: pdh,
      direction: 'NEUTRAL',
      evidence: { kind: 'PDH', date: yesterdayUTCDate },
    }));
    events.push(makeEvent({
      type: 'session-level',
      ts: lastTime,
      timeframe,
      price: pdl,
      direction: 'NEUTRAL',
      evidence: { kind: 'PDL', date: yesterdayUTCDate },
    }));
  }

  // Today's Asian range high/low — search candles for ones in Asian session
  // that belong to today's session (which started yesterday at 22:00 UTC)
  const asianCandles = candles.filter((c) => {
    const d = new Date(c.time);
    const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (utcMin < 22 * 60 && utcMin >= 5 * 60) return false;
    // Must be from "today's session" — late yesterday OR early today
    const cDate = d.toISOString().slice(0, 10);
    if (utcMin >= 22 * 60) return cDate === yesterdayUTCDate;
    return cDate === todayUTCDate;
  });
  if (asianCandles.length > 0) {
    const ah = Math.max(...asianCandles.map((c) => c.high));
    const al = Math.min(...asianCandles.map((c) => c.low));
    const lastTime = new Date(asianCandles[asianCandles.length - 1].time).getTime();
    events.push(makeEvent({
      type: 'session-level',
      ts: lastTime,
      timeframe,
      price: ah,
      direction: 'NEUTRAL',
      evidence: { kind: 'ASIAN_HIGH' },
    }));
    events.push(makeEvent({
      type: 'session-level',
      ts: lastTime,
      timeframe,
      price: al,
      direction: 'NEUTRAL',
      evidence: { kind: 'ASIAN_LOW' },
    }));
  }

  // Today's London session H/L
  const londonCandles = candles.filter((c) => {
    const d = new Date(c.time);
    if (d.toISOString().slice(0, 10) !== todayUTCDate) return false;
    return classifySession(d) === 'london';
  });
  if (londonCandles.length > 0) {
    const lh = Math.max(...londonCandles.map((c) => c.high));
    const ll = Math.min(...londonCandles.map((c) => c.low));
    const lastTime = new Date(londonCandles[londonCandles.length - 1].time).getTime();
    events.push(makeEvent({
      type: 'session-level',
      ts: lastTime,
      timeframe,
      price: lh,
      direction: 'NEUTRAL',
      evidence: { kind: 'LONDON_HIGH' },
    }));
    events.push(makeEvent({
      type: 'session-level',
      ts: lastTime,
      timeframe,
      price: ll,
      direction: 'NEUTRAL',
      evidence: { kind: 'LONDON_LOW' },
    }));
  }

  return events;
}

module.exports = { detect };