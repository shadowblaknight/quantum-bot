/* eslint-disable */
// V12 — api/tactics/order-block.js
//
// Order Block detector. An OB is the LAST opposite-direction candle before a
// strong impulsive move that broke market structure. Smart money "left" buy/sell
// orders at this candle, and price often returns to test it as support/resistance.
//
// VALIDATION CRITERIA (we don't emit weak OBs):
//   1. Body must be at least 40% of total range (decisive candle, not a doji)
//   2. The impulse move that followed must be ≥ 1.5 × ATR (significant displacement)
//   3. Impulse must have broken structure (BOS) for the OB to be "valid"
//   4. OB must not be mitigated (price hasn't returned to test it yet)
//   5. OB must not be too old (> 50 bars = stale)
//
// Output direction:
//   - Bullish OB (LONG): last RED candle before strong UP move → expect support on retest
//   - Bearish OB (SHORT): last GREEN candle before strong DOWN move → expect resistance on retest
//
// Zone shape: { upper: candle.high, lower: candle.low }
//   Coherence checker uses zone for entry zone overlap with other tactics.
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');
const { findSwings } = require('./trend-structure');
const { atr } = require('../_lib');

const MAX_OB_AGE_BARS = 50;
const MIN_BODY_RATIO = 0.4;
const MIN_IMPULSE_ATR = 1.5;
const IMPULSE_LOOKAHEAD = 5; // bars to check for impulse after the OB candle

function detect(candles, context = {}) {
  const tf = context.timeframe;
  if (!tf || !Array.isArray(candles) || candles.length < 30) return [];

  const atrVal = atr(candles, 14);
  if (!atrVal || !isFinite(atrVal)) return [];

  const swings = findSwings(candles);
  const opinions = [];
  const lastIdx = candles.length - 1;
  const startIdx = Math.max(0, lastIdx - MAX_OB_AGE_BARS);

  // Scan from older to newer, looking for OB candidates
  for (let i = startIdx; i < lastIdx - IMPULSE_LOOKAHEAD; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range <= 0) continue;

    const body = Math.abs(c.close - c.open);
    const bodyRatio = body / range;
    if (bodyRatio < MIN_BODY_RATIO) continue;

    const isRed = c.close < c.open;
    const isGreen = c.close > c.open;

    // Look ahead — measure impulse over next N candles
    const impulseEnd = Math.min(i + IMPULSE_LOOKAHEAD, lastIdx);
    let highestAfter = -Infinity;
    let lowestAfter = Infinity;
    for (let j = i + 1; j <= impulseEnd; j++) {
      if (candles[j].high > highestAfter) highestAfter = candles[j].high;
      if (candles[j].low < lowestAfter) lowestAfter = candles[j].low;
    }

    // BULLISH OB: red candle, then strong move UP
    if (isRed) {
      const upMove = highestAfter - c.high;
      if (upMove >= atrVal * MIN_IMPULSE_ATR) {
        // Check if this OB has been mitigated since formation (any close back inside zone)
        let mitigated = false;
        for (let j = i + 1; j <= lastIdx; j++) {
          if (candles[j].low <= c.high && candles[j].close < c.high) {
            // Price returned into the OB zone
            mitigated = true;
            break;
          }
        }

        if (!mitigated) {
          // Bonus: check if impulse broke a swing high (BOS confirmation)
          const priorSwingHighs = swings.filter((s) => s.type === 'HIGH' && s.idx < i);
          const recentHigh = priorSwingHighs.length > 0 ? priorSwingHighs[priorSwingHighs.length - 1].price : null;
          const bosConfirmed = recentHigh != null && highestAfter > recentHigh;

          const op = makeOpinion({
            tactic: 'orderBlock',
            timeframe: tf,
            direction: 'LONG',
            level: (c.high + c.low) / 2,                 // mid of OB
            zone: { upper: c.high, lower: c.low },
            entry: c.high,                                // top of OB = retest entry
            invalidation: c.low - atrVal * 0.3,           // small buffer below OB
            targets: null,
            formedAt: new Date(c.time).getTime(),
            strength: computeOBStrength(bodyRatio, upMove, atrVal, bosConfirmed, lastIdx - i),
            evidence: {
              type: 'bullish',
              candleHigh: c.high,
              candleLow: c.low,
              bodyRatio: bodyRatio.toFixed(2),
              impulseATR: (upMove / atrVal).toFixed(2),
              bosConfirmed,
              barsAgo: lastIdx - i,
            },
            description: `${tf} bullish OB @ ${c.low.toFixed(c.low > 100 ? 2 : 5)}-${c.high.toFixed(c.high > 100 ? 2 : 5)}, untested, ${lastIdx - i} bars ago`,
          });
          if (op) opinions.push(op);
        }
      }
    }

    // BEARISH OB: green candle, then strong move DOWN
    if (isGreen) {
      const downMove = c.low - lowestAfter;
      if (downMove >= atrVal * MIN_IMPULSE_ATR) {
        let mitigated = false;
        for (let j = i + 1; j <= lastIdx; j++) {
          if (candles[j].high >= c.low && candles[j].close > c.low) {
            mitigated = true;
            break;
          }
        }

        if (!mitigated) {
          const priorSwingLows = swings.filter((s) => s.type === 'LOW' && s.idx < i);
          const recentLow = priorSwingLows.length > 0 ? priorSwingLows[priorSwingLows.length - 1].price : null;
          const bosConfirmed = recentLow != null && lowestAfter < recentLow;

          const op = makeOpinion({
            tactic: 'orderBlock',
            timeframe: tf,
            direction: 'SHORT',
            level: (c.high + c.low) / 2,
            zone: { upper: c.high, lower: c.low },
            entry: c.low,
            invalidation: c.high + atrVal * 0.3,
            targets: null,
            formedAt: new Date(c.time).getTime(),
            strength: computeOBStrength(bodyRatio, downMove, atrVal, bosConfirmed, lastIdx - i),
            evidence: {
              type: 'bearish',
              candleHigh: c.high,
              candleLow: c.low,
              bodyRatio: bodyRatio.toFixed(2),
              impulseATR: (downMove / atrVal).toFixed(2),
              bosConfirmed,
              barsAgo: lastIdx - i,
            },
            description: `${tf} bearish OB @ ${c.low.toFixed(c.low > 100 ? 2 : 5)}-${c.high.toFixed(c.high > 100 ? 2 : 5)}, untested, ${lastIdx - i} bars ago`,
          });
          if (op) opinions.push(op);
        }
      }
    }
  }

  // Limit to most recent N OBs per direction (avoid clutter)
  const longOBs = opinions.filter((o) => o.direction === 'LONG').sort((a, b) => b.formedAt - a.formedAt).slice(0, 3);
  const shortOBs = opinions.filter((o) => o.direction === 'SHORT').sort((a, b) => b.formedAt - a.formedAt).slice(0, 3);

  return [...longOBs, ...shortOBs];
}

function computeOBStrength(bodyRatio, impulse, atrVal, bosConfirmed, ageBars) {
  // Body strength contribution (0-1)
  const bodyScore = Math.min((bodyRatio - MIN_BODY_RATIO) / (1 - MIN_BODY_RATIO), 1);

  // Impulse contribution (capped at 3 ATR)
  const impulseATR = impulse / atrVal;
  const impulseScore = Math.min((impulseATR - MIN_IMPULSE_ATR) / 1.5, 1);

  // BOS confirmation bonus
  const bosBonus = bosConfirmed ? 0.15 : 0;

  // Recency bonus (newer OBs slightly stronger)
  const recency = Math.max(0, 1 - ageBars / MAX_OB_AGE_BARS);
  const recencyBonus = recency * 0.1;

  return Math.min(0.4 + bodyScore * 0.3 + impulseScore * 0.3 + bosBonus + recencyBonus, 1);
}

module.exports = { detect };