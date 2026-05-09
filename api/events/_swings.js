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
// Simple HH+HL = UP, LH+LL = DOWN, mixed = RANGE
function determineTrend(swings) {
  const highs = recentSwings(swings, 'high', 2);
  const lows = recentSwings(swings, 'low', 2);
  if (highs.length < 2 || lows.length < 2) return 'RANGE';

  const higherHighs = highs[1].price > highs[0].price;
  const higherLows  = lows[1].price  > lows[0].price;
  const lowerHighs  = highs[1].price < highs[0].price;
  const lowerLows   = lows[1].price  < lows[0].price;

  if (higherHighs && higherLows) return 'UP';
  if (lowerHighs && lowerLows)   return 'DOWN';
  return 'RANGE';
}

module.exports = {
  detectSwings,
  recentSwings,
  determineTrend,
};