/* eslint-disable */
// V12.3 — api/templates/unicorn.js
//
// UNICORN template.
//
// Sequence:
//   1. Daily/H4 bias clear
//   2. HTF context: price near an H1/H4 OB or FVG (price tapping HTF PD Array)
//   3. M5/M15 sweep of a swing
//   4. M5/M15 MSS in opposite direction (creates Breaker Block from swept swing)
//   5. M5/M15 displacement leaves an FVG
//   6. The Breaker Block zone and the FVG zone OVERLAP in price
//   7. Price retraces toward the overlap zone
//
// Trade: enter at overlap edge or 50% of overlap. SL beyond the swept wick.
// TP at next opposing liquidity, minimum 1:2.

const { buildTPs, structuralBuffer } = require('./_template');
const { findMostRecent, findAllRecent } = require('../events/_event');

// Compute overlap of two zones [aL, aU] and [bL, bU]
function zoneOverlap(a, b) {
  const upper = Math.min(a.upper, b.upper);
  const lower = Math.max(a.lower, b.lower);
  if (upper <= lower) return null;
  return { upper, lower };
}

function match({ events, currentPrice, atrByTF }) {
  // Step 1: bias from H1 (ICT day-trading: H1 = directional bias)
  const h1Trend = events.find((e) => e.type === 'trend' && e.timeframe === '1h');
  const bias = h1Trend?.direction || 'NEUTRAL';
  if (bias === 'NEUTRAL') return null;

  // Step 2-4: find a Breaker Block in bias direction on M5/M15, recently formed
  const breakers = findAllRecent(events, 'breaker-created', 30)
    .filter((b) => b.direction === bias)
    .filter((b) => b.timeframe === '5m' || b.timeframe === '15m');

  if (breakers.length === 0) return null;

  // Step 5-6: find an FVG that overlaps the Breaker
  for (const breaker of breakers) {
    const fvgs = findAllRecent(events, 'fvg-created', 30)
      .filter((f) => f.direction === bias)
      .filter((f) => f.timeframe === '5m' || f.timeframe === '15m')
      .filter((f) => (f.evidence?.fillPercent ?? 1) < 0.5)
      .filter((f) => Math.abs(f.ts - breaker.ts) <= 90 * 60 * 1000);

    for (const fvg of fvgs) {
      const overlap = zoneOverlap(breaker.zone, fvg.zone);
      if (!overlap) continue;

      // Found a unicorn zone
      const ltfATR = atrByTF['5m'] || atrByTF['15m'] || 0;
      if (ltfATR <= 0) continue;

      const entry = (overlap.upper + overlap.lower) / 2;

      // V12.4: SL beyond breaker's swept extreme (structural anchor).
      // Buffer uses standard formula: max(0.5×m5ATR, 0.15×h1ATR) — wider than
      // m5 wick noise AND meaningful at H1 scale.
      const sweptLevel = breaker.evidence?.sweptLevel;
      if (sweptLevel == null) continue;

      const h1ATR = atrByTF['1h'] || 0;
      const m5ATR = atrByTF['5m'] || 0;
      const buffer = structuralBuffer(m5ATR, h1ATR);

      const sl = bias === 'LONG'
        ? sweptLevel - buffer
        : sweptLevel + buffer;

      const slDist = Math.abs(entry - sl);
      const slDistATR = slDist / ltfATR;
      if (slDistATR > 3.0 || slDistATR < 0.3) continue;

      // Price must be approaching/inside the unicorn zone
      const distToZone = Math.min(
        Math.abs(currentPrice - overlap.upper),
        Math.abs(currentPrice - overlap.lower)
      );
      const inZone = currentPrice >= overlap.lower && currentPrice <= overlap.upper;
      if (!inZone && distToZone > ltfATR * 1.5) continue;

      // TPs
      const sessionLevels = events.filter((e) => e.type === 'session-level');
      const htfFVGs = events.filter(
        (e) => e.type === 'fvg-created' && e.timeframe === '1h'
      );
      const tps = buildTPs(bias, entry, sl, sessionLevels, htfFVGs);
      if (tps.length === 0) continue;

      return {
        templateName: 'unicorn',
        direction: bias,
        mode: 'DAY',
        entry,
        entryZone: overlap,
        sl,
        slDistance: slDist,
        slDistanceATR: slDistATR,
        tps,
        narrative: [
          `Bias: ${bias.toLowerCase()} (H1 trend).`,
          `Breaker Block on ${breaker.timeframe}: ${breaker.zone.lower.toFixed(5)}–${breaker.zone.upper.toFixed(5)}.`,
          `FVG on ${fvg.timeframe} overlaps the Breaker.`,
          `Unicorn Zone: ${overlap.lower.toFixed(5)}–${overlap.upper.toFixed(5)}.`,
          `Entry at zone center: ${entry.toFixed(5)}, SL beyond swept extreme at ${sl.toFixed(5)}.`,
          `Unicorn: highest-precision ICT entry — Breaker + FVG confluence.`,
        ],
        contributingEvents: [breaker, fvg, h1Trend].filter(Boolean),
        timeframesInPlay: [...new Set([breaker.timeframe, fvg.timeframe, '1h'])],
        formedAt: Math.max(breaker.ts, fvg.ts),
      };
    }
  }

  return null;
}

module.exports = { match, name: 'unicorn' };