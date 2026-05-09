/* eslint-disable */
// V12.3 — api/templates/turtle-soup.js
//
// TURTLE SOUP template.
//
// Sequence:
//   1. Identify HTF liquidity level — PDH, PDL, or H1/H4 swing high/low
//   2. Sweep event on H1 (or M15) of that level — wick beyond, close back inside
//   3. Displacement on M5/M15 in opposite direction
//   4. MSS confirming reversal on M5/M15
//   5. FVG or OB created by displacement (entry zone)
//
// Difference from Judas Swing:
//   - Turtle Soup uses HTF liquidity (PDH/PDL/H1 swings), not Asian range
//   - Turtle Soup is NOT time-restricted to London KZ (any KZ works)
//   - Cleaner during kill zones but doesn't require them

const { buildTPs } = require('./_template');
const { findMostRecent, findAllRecent } = require('../events/_event');

function match({ events, currentPrice, atrByTF }) {
  // Step 1: find an HTF sweep — H1 sweep, OR a sweep of PDH/PDL on any TF
  const sessionLevels = events.filter((e) => e.type === 'session-level');
  const pdh = sessionLevels.find((e) => e.evidence?.kind === 'PDH');
  const pdl = sessionLevels.find((e) => e.evidence?.kind === 'PDL');

  // Find sweeps in last 4 hours on H1, or sweeps of PDH/PDL on M15/H1
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
  const recentSweeps = findAllRecent(events, 'sweep', 50)
    .filter((s) => s.ts >= fourHoursAgo);

  let htfSweep = null;
  let reversalDirection = null;

  // Prefer H1 sweep (genuinely HTF)
  for (const s of recentSweeps) {
    if (s.timeframe !== '1h') continue;
    htfSweep = s;
    reversalDirection = s.direction;
    break;
  }

  // Fall back to PDH/PDL sweeps on M15
  if (!htfSweep) {
    const m15ATR = atrByTF['15m'] || 0;
    for (const s of recentSweeps) {
      if (s.timeframe !== '15m') continue;
      const sweptLevel = s.evidence?.sweptLevel;
      if (sweptLevel == null) continue;

      const sweptPDH = pdh && Math.abs(sweptLevel - pdh.price) < m15ATR * 0.5;
      const sweptPDL = pdl && Math.abs(sweptLevel - pdl.price) < m15ATR * 0.5;

      if ((sweptPDH && s.direction === 'SHORT') || (sweptPDL && s.direction === 'LONG')) {
        htfSweep = s;
        reversalDirection = s.direction;
        break;
      }
    }
  }

  if (!htfSweep) return null;

  // Step 2: displacement on M5/M15 in reversal direction AFTER the sweep
  const displacements = findAllRecent(events, 'displacement', 30)
    .filter((d) => d.ts > htfSweep.ts)
    .filter((d) => d.direction === reversalDirection)
    .filter((d) => d.timeframe === '5m' || d.timeframe === '15m');

  if (displacements.length === 0) return null;
  const validDisplacement = displacements[0];

  // Step 3: MSS on M5/M15 in reversal direction AFTER displacement
  const mssEvents = findAllRecent(events, 'mss', 30)
    .filter((m) => m.ts >= validDisplacement.ts)
    .filter((m) => m.direction === reversalDirection)
    .filter((m) => m.timeframe === '5m' || m.timeframe === '15m');

  if (mssEvents.length === 0) return null;
  const validMSS = mssEvents[0];

  // Step 4: find FVG or OB from displacement
  const fvgs = findAllRecent(events, 'fvg-created', 30)
    .filter((f) => f.direction === reversalDirection)
    .filter((f) => Math.abs(f.ts - validDisplacement.ts) <= 30 * 60 * 1000);

  const obs = findAllRecent(events, 'ob-created', 30)
    .filter((o) => o.direction === reversalDirection)
    .filter((o) => Math.abs(o.ts - validDisplacement.ts) <= 30 * 60 * 1000)
    .filter((o) => !o.evidence?.tested);

  let entryZone = null;
  let entryDescription = null;
  if (fvgs.length > 0) {
    entryZone = fvgs[0].zone;
    entryDescription = `${fvgs[0].timeframe} FVG`;
  } else if (obs.length > 0) {
    entryZone = obs[0].zone;
    entryDescription = `${obs[0].timeframe} OB`;
  } else {
    return null;
  }

  const entry = (entryZone.upper + entryZone.lower) / 2;

  // SL beyond the swept extreme
  const ltfATR = atrByTF['5m'] || atrByTF['15m'] || 0;
  const sweepWick = reversalDirection === 'SHORT'
    ? htfSweep.evidence?.wickHigh
    : htfSweep.evidence?.wickLow;
  if (sweepWick == null) return null;

  const sl = reversalDirection === 'SHORT'
    ? sweepWick + ltfATR * 0.15
    : sweepWick - ltfATR * 0.15;

  const slDist = Math.abs(entry - sl);
  const slDistATR = ltfATR > 0 ? slDist / ltfATR : 0;
  if (slDistATR > 3.0 || slDistATR < 0.3) return null;

  // TPs: opposing PDH/PDL, then HTF FVG magnets
  const htfFVGs = events.filter(
    (e) => e.type === 'fvg-created' && (e.timeframe === '1h' || e.timeframe === '4h')
  );
  const tps = buildTPs(reversalDirection, entry, sl, sessionLevels, htfFVGs);
  if (tps.length === 0) return null;

  const sweptName = htfSweep.evidence?.sweptLevelType === 'swingHigh' ? 'swing high' : 'swing low';

  return {
    templateName: 'turtle-soup',
    direction: reversalDirection,
    mode: 'DAY',
    entry,
    entryZone,
    sl,
    slDistance: slDist,
    slDistanceATR: slDistATR,
    tps,
    narrative: [
      `HTF ${htfSweep.timeframe} ${sweptName} swept at ${htfSweep.evidence.sweptLevel.toFixed(5)} — failed breakout.`,
      `Displacement ${reversalDirection.toLowerCase()} on ${validDisplacement.timeframe}.`,
      `MSS confirmed on ${validMSS.timeframe} — reversal in motion.`,
      `Entry zone: ${entryDescription} at ${entryZone.lower.toFixed(5)}–${entryZone.upper.toFixed(5)}.`,
      `Turtle Soup: ${reversalDirection.toLowerCase()} from failed HTF breakout.`,
    ],
    contributingEvents: [htfSweep, validDisplacement, validMSS],
    timeframesInPlay: [...new Set([htfSweep.timeframe, validDisplacement.timeframe, validMSS.timeframe])],
    formedAt: validMSS.ts,
  };
}

module.exports = { match, name: 'turtle-soup' };