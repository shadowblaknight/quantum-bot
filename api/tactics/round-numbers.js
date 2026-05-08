/* eslint-disable */
// V12 — api/tactics/round-numbers.js
//
// Round number detector. Price magnetizes toward psychologically significant
// levels: 1.10 on EURUSD, 4500/4600 on gold, 80000/100000 on BTC.
//
// These are PURE REFERENCE LEVELS — direction NEUTRAL. Used by coherence
// checker as TP target candidates and as reference points for invalidation.
//
// IMPORTANT: only runs on H4+ to reduce noise. Round numbers on M5 are
// meaningless because price brushes them constantly.
//
// Step size scales with price magnitude:
//   < 1            → 0.001  (e.g., XRP 0.500, 0.600)
//   1-10           → 0.01   (e.g., EURUSD 1.05, 1.10)
//   10-100         → 0.5    (e.g., USDJPY 145, 150)
//   100-1000       → 5      (e.g., S&P 4500, 4505)
//   1000-10000     → 50     (e.g., Gold 4500, 4550, NDX 18000)
//   10000-100000   → 500    (e.g., BTC at 30000, BTC at 75000)
//   > 100000       → 1000   (e.g., BTC at 100000, 110000)
//
// We emit only round numbers within ±3 ATR of current price. Beyond that
// they're not actionable.
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');
const { atr } = require('../_lib');

function detect(candles, context = {}) {
  const tf = context.timeframe;
  // Only H4 and above — round numbers are noise on lower TFs
  if (!['4h', '1d', '1w'].includes(tf)) return [];
  if (!Array.isArray(candles) || candles.length < 20) return [];

  const atrVal = atr(candles, 14);
  if (!atrVal || !isFinite(atrVal)) return [];

  const last = candles[candles.length - 1];
  const price = last.close;
  if (!isFinite(price) || price <= 0) return [];

  const step = roundStep(price);
  if (!step) return [];

  // Find nearest round numbers above and below current price
  const opinions = [];
  const maxDistance = atrVal * 3;

  // Above
  let above = Math.ceil(price / step) * step;
  while (above - price <= maxDistance) {
    if (above > price) {
      const op = makeOpinion({
        tactic: 'roundNumber',
        timeframe: tf,
        direction: 'NEUTRAL',
        level: above,
        formedAt: Date.now(),
        strength: roundNumberStrength(above, step, atrVal, price),
        evidence: { type: 'roundAbove', step, distancePips: above - price, distanceATR: ((above - price) / atrVal).toFixed(2) },
        description: `Round number ${above.toFixed(price >= 100 ? 0 : (price >= 10 ? 2 : 4))} (${((above - price) / atrVal).toFixed(1)} ATR above)`,
      });
      if (op) opinions.push(op);
    }
    above += step;
  }

  // Below
  let below = Math.floor(price / step) * step;
  while (price - below <= maxDistance) {
    if (below < price) {
      const op = makeOpinion({
        tactic: 'roundNumber',
        timeframe: tf,
        direction: 'NEUTRAL',
        level: below,
        formedAt: Date.now(),
        strength: roundNumberStrength(below, step, atrVal, price),
        evidence: { type: 'roundBelow', step, distancePips: price - below, distanceATR: ((price - below) / atrVal).toFixed(2) },
        description: `Round number ${below.toFixed(price >= 100 ? 0 : (price >= 10 ? 2 : 4))} (${((price - below) / atrVal).toFixed(1)} ATR below)`,
      });
      if (op) opinions.push(op);
    }
    below -= step;
  }

  // Limit emission count (max 4: nearest 2 above + nearest 2 below)
  const sorted = opinions.sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price));
  return sorted.slice(0, 4);
}

function roundStep(price) {
  if (price > 100000) return 1000;
  if (price > 10000) return 500;
  if (price > 1000) return 50;
  if (price > 100) return 5;
  if (price > 10) return 0.5;
  if (price > 1) return 0.01;
  return 0.001;
}

// Bigger round numbers (e.g., 100000 vs 75500) have stronger magnetic effect
// We approximate this: a level that's a "10x" of the step gets bonus strength
function roundNumberStrength(level, step, atrVal, price) {
  let baseStrength = 0.5;

  // Is this a "big" round number (multiple of 10x step)?
  if (level % (step * 10) === 0) baseStrength = 0.7;
  if (level % (step * 100) === 0) baseStrength = 0.8;

  // Closer = stronger (more actionable)
  const distance = Math.abs(level - price);
  const distanceATR = distance / atrVal;
  const proximityBonus = distanceATR < 1 ? 0.1 : distanceATR < 2 ? 0.05 : 0;

  return Math.min(baseStrength + proximityBonus, 1);
}

module.exports = { detect, roundStep };