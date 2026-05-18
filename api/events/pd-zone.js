/* eslint-disable */
// V12.4.1 — api/events/pd-zone.js
//
// PREMIUM/DISCOUNT ZONE DETECTOR
// =================================================================
// In ICT methodology, every trade must respect the current dealing range:
//   - LONG entries should be taken from DISCOUNT (lower half of range)
//   - SHORT entries should be taken from PREMIUM (upper half of range)
//
// Buying in premium = paying retail price. Selling in discount = same mistake.
// Smart money does the opposite: buys discount, sells premium.
//
// This detector computes the active dealing range from recent H1 swings
// (last ~48 hours by default) and emits a single `pd-zone` event tagging
// the current price's location. Coherence-checker uses this to filter
// out any setup that violates the premium/discount rule.
//
// Methodology source: ICT premium/discount theory (Inner Circle Trader).
// The "dealing range" is the area between the most recent significant
// swing high and swing low. The 50% line (midpoint, also called the
// equilibrium / EQ) separates premium from discount.
// =================================================================

const { makeEvent } = require('./_event');
const { detectSwings } = require('./_swings');

const LOOKBACK_HOURS = 48; // 2 days of H1 swings = current dealing range

// Equilibrium zone tolerance — within ±5% of midpoint we consider the
// price "at equilibrium" (no premium/discount bias). This prevents tiny
// crossings of the midline from flipping the filter back and forth.
const EQ_TOLERANCE_PCT = 0.05;

function detect({ candles, atr, timeframe }) {
  const events = [];
  if (!candles || candles.length < 20) return events;
  if (timeframe !== '1h') return events; // dealing range is anchored on H1

  // Use only the last LOOKBACK_HOURS candles to capture the CURRENT range
  // (not ancient swings from days/weeks ago)
  const recentCandles = candles.slice(-LOOKBACK_HOURS);
  if (recentCandles.length < 10) return events;

  // Detect swings on the recent window
  const swings = detectSwings(recentCandles, 2);
  if (swings.length < 2) return events;

  // The dealing range is bounded by the EXTREME swing high and low
  // within the lookback window.
  const swingHighs = swings.filter((s) => s.type === 'high');
  const swingLows = swings.filter((s) => s.type === 'low');
  if (swingHighs.length === 0 || swingLows.length === 0) return events;

  const rangeHigh = Math.max(...swingHighs.map((s) => s.price));
  const rangeLow = Math.min(...swingLows.map((s) => s.price));
  const rangeSize = rangeHigh - rangeLow;
  if (rangeSize <= 0) return events;

  // Sanity: range must be at least 1× H1 ATR. Otherwise it's noise.
  if (atr && rangeSize < atr * 1.0) return events;

  const midpoint = (rangeHigh + rangeLow) / 2;
  const eqUpper = midpoint + rangeSize * EQ_TOLERANCE_PCT;
  const eqLower = midpoint - rangeSize * EQ_TOLERANCE_PCT;

  // Current price = last candle close
  const lastCandle = candles[candles.length - 1];
  const currentPrice = lastCandle.close;

  // Classify location
  let location; // 'premium' | 'discount' | 'equilibrium'
  let positionPct; // 0..1 where 0=at range low, 1=at range high
  positionPct = (currentPrice - rangeLow) / rangeSize;
  if (currentPrice > eqUpper) location = 'premium';
  else if (currentPrice < eqLower) location = 'discount';
  else location = 'equilibrium';

  // Emit a single pd-zone event capturing the full range context
  events.push(makeEvent({
    type: 'pd-zone',
    ts: new Date(lastCandle.time).getTime(),
    timeframe,
    price: currentPrice,
    direction: 'NEUTRAL', // pd-zone itself is directional info, not a directional event
    evidence: {
      rangeHigh,
      rangeLow,
      midpoint,
      rangeSize,
      currentPrice,
      location,
      positionPct: +positionPct.toFixed(3),
      lookbackHours: LOOKBACK_HOURS,
      // Counts of swings the range was computed from
      swingHighCount: swingHighs.length,
      swingLowCount: swingLows.length,
    },
  }));

  return events;
}

module.exports = { detect };