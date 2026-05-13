/* eslint-disable */
// V12.3 — api/events/_event.js
//
// EVENT CONTRACT — every event-emitting detector returns an array of events
// that share this shape. Templates read these events to recognize named
// ICT setups.
//
// Philosophy: events describe what happened, when, where. They do NOT score.
// Templates judge whether a recent sequence of events matches a named setup.
// If you find yourself adding a "strength" or "confidence" field, stop —
// that's scoring re-entering through the back door.
//
// EVENT TYPES (canonical names — templates reference these):
//   sweep                — liquidity taken (level, side, wick, close-back)
//   displacement         — strong directional candle(s) (dir, atrMagnitude)
//   mss                  — market structure shift, REVERSAL only
//   bos                  — break of structure, CONTINUATION only
//   fvg-created          — fair value gap formed (zone, displacement-linked)
//   ob-created           — order block (zone, sweep-linked, displacement-linked)
//   breaker-created      — breaker block (failed-OB, sweep+MSS-linked)
//   asian-range-formed   — Asian range solidified (high, low, ATR-relative)
//   htf-pd-tap           — price tapping a known HTF OB or FVG
//   ote-zone-entered     — price inside 62-79% fib of recent impulse
//   pd-zone              — premium/discount of dealing range (continuous tag)
//
// EVENT SHAPE:
//   {
//     type: <string>,             // see canonical list above
//     ts: <number>,               // milliseconds (event time, NOT detection time)
//     timeframe: <string>,        // '5m' | '15m' | '1h' | '4h' | '1d'
//     price: <number?>,           // central reference price for the event
//     direction: <string?>,       // 'LONG' | 'SHORT' | 'NEUTRAL' (event direction)
//     zone: { upper, lower }?,    // for zone-based events (FVG, OB, breaker)
//     refers: [<event-id>]?,      // links to other events (e.g. FVG refers to displacement)
//     id: <string>,               // unique within-tick identifier
//     evidence: { ... }           // detector-specific raw data
//   }

function makeEvent({
  type,
  ts,
  timeframe,
  price = null,
  direction = null,
  zone = null,
  refers = null,
  evidence = null,
}) {
  // CRITICAL: ts is always a number (ms timestamp).
  // Candles from the data source store time as ISO strings, but events
  // need numeric ts for arithmetic comparisons in templates
  // (e.g. "is this sweep within 4 hours?" — needs ts - Date.now()).
  let normalizedTs = ts;
  if (typeof ts === 'string') {
    normalizedTs = new Date(ts).getTime();
  }
  if (!Number.isFinite(normalizedTs)) {
    normalizedTs = Date.now();
  }

  return {
    type,
    ts: normalizedTs,
    timeframe,
    price,
    direction,
    zone,
    refers,
    id: `${type}_${timeframe}_${normalizedTs}_${Math.random().toString(36).slice(2, 6)}`,
    evidence,
  };
}

// Sort events by ts ascending — most template matchers need chronological order
function sortByTs(events) {
  return [...events].sort((a, b) => a.ts - b.ts);
}

// Filter events within a time window (ms-based)
// Used by templates to look at "recent" events only
function recentEvents(events, withinMs) {
  const cutoff = Date.now() - withinMs;
  return events.filter((e) => e.ts >= cutoff);
}

// Find the most recent event of a given type
function findMostRecent(events, type) {
  const matching = events.filter((e) => e.type === type);
  if (matching.length === 0) return null;
  return matching.reduce((latest, e) => (e.ts > latest.ts ? e : latest), matching[0]);
}

// Find events of given type ordered most-recent first
function findAllRecent(events, type, limit = 10) {
  return events
    .filter((e) => e.type === type)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

module.exports = {
  makeEvent,
  sortByTs,
  recentEvents,
  findMostRecent,
  findAllRecent,
};