/* eslint-disable */
// V12.3 — api/events/_swings.js
//
// Swing point detector. Pure function. No I/O.
//
// A swing high = candle whose high is greater than the highs of N candles
// on each side. A swing low = candle whose low is less than the lows of
// N candles on each side. Default N=2 (5-bar fractal).
//
// Returns swings in chronological order with index, ts, price, type.

function detectSwings(candles, lookback = 2) {
  const swings = [];
  if (!candles || candles.length < lookback * 2 + 1) return swings;

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high) isHigh = false;
      if (candles[i + j].high >= c.high) isHigh = false;
      if (candles[i - j].low <= c.low) isLow = false;
      if (candles[i + j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) swings.push({ index: i, ts: c.time, price: c.high, type: 'high' });
    if (isLow)  swings.push({ index: i, ts: c.time, price: c.low,  type: 'low' });
  }

  return swings;
}

// Get the most recent N swings of a specific type
function recentSwings(swings, type, n = 5) {
  return swings
    .filter((s) => s.type === type)
    .slice(-n);
}

// Determine if the swing structure shows an uptrend or downtrend
// Strategy: look at the MOST RECENT swing extreme (high or low) and ask
// "is it higher or lower than the previous same-type swing?"
// - Most recent swing was a HIGHER HIGH → UP bias
// - Most recent swing was a LOWER LOW  → DOWN bias
// - Most recent swing was a LOWER HIGH → DOWN bias (rejection at lower level)
// - Most recent swing was a HIGHER LOW → UP bias (support holding higher)
// This matches how ICT pros read structure — the FRESH break dominates,
// not the slow consensus of multiple swings.
function determineTrend(swings) {
  if (!swings || swings.length < 3) return 'RANGE';

  // Sort swings by index (chronological) — they should already be sorted
  const sorted = [...swings].sort((a, b) => a.index - b.index);
  const lastSwing = sorted[sorted.length - 1];
  if (!lastSwing) return 'RANGE';

  // Find the previous swing of the SAME type as the last swing
  let prevSameType = null;
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i].type === lastSwing.type) {
      prevSameType = sorted[i];
      break;
    }
  }
  if (!prevSameType) return 'RANGE';

  // Compare
  if (lastSwing.type === 'high') {
    return lastSwing.price > prevSameType.price ? 'UP' : 'DOWN';
  } else {
    // last swing is a low
    return lastSwing.price < prevSameType.price ? 'DOWN' : 'UP';
  }
}

module.exports = {
  detectSwings,
  recentSwings,
  determineTrend,
};