/* eslint-disable */
// V12.3 — api/templates/judas-swing.js
//
// JUDAS SWING template.
//
// Sequence the bot must recognize:
//   1. asian-range-formed event from today's session
//   2. We are inside London Kill Zone window (06:00-10:00 UTC)
//   3. A sweep event on M5 or M15 of the Asian high OR Asian low,
//      occurring AFTER the Asian range formed AND inside the KZ
//   4. A displacement event on M5 or M15 in the OPPOSITE direction of the sweep,
//      occurring AFTER the sweep
//   5. An MSS event on M5 or M15 confirming the new direction,
//      occurring AFTER the displacement
//   6. An FVG or OB created by the displacement (entry zone)
//
// Direction logic:
//   - Sweep BELOW Asian low → reversal direction = LONG
//   - Sweep ABOVE Asian high → reversal direction = SHORT
//
// (Daily bias is informational — Judas Swing IS the bias-discovery moment.)

const { buildTPs, structuralBuffer } = require('./_template');
const { findMostRecent, findAllRecent } = require('../events/_event');
const { checkKillZone } = require('../kill-zones');

function match({ events, currentPrice, atrByTF }) {
  // Step 1: must be inside London KZ
  const kz = checkKillZone();
  if (kz.name !== 'LONDON') return null;

  // Step 2: must have an Asian range from today
  const asianRange = findMostRecent(events, 'asian-range-formed');
  if (!asianRange) return null;

  const todayKey = new Date().toISOString().slice(0, 10);
  const arDateKey = asianRange.evidence?.sessionDate;
  if (arDateKey !== todayKey) return null;

  const asianHigh = asianRange.zone.upper;
  const asianLow = asianRange.zone.lower;

  // Step 3: sweep AFTER asian range formed, of asianHigh OR asianLow,
  //         on M5 or M15
  const sweeps = findAllRecent(events, 'sweep', 30)
    .filter((s) => (s.timeframe === '5m' || s.timeframe === '15m'))
    .filter((s) => s.ts > asianRange.ts);

  let validSweep = null;
  let reversalDirection = null;

  for (const s of sweeps) {
    // Check if it swept Asian high (looking for short reversal)
    const sweptLevel = s.evidence?.sweptLevel;
    if (sweptLevel == null) continue;
    const sweptHigh = Math.abs(sweptLevel - asianHigh) < (atrByTF[s.timeframe] || 1) * 0.5;
    const sweptLow = Math.abs(sweptLevel - asianLow) < (atrByTF[s.timeframe] || 1) * 0.5;
    if (!sweptHigh && !sweptLow) continue;

    // Sweep direction tells us the expected reversal
    // sweep.direction = 'SHORT' means the wick went above and closed back below = reversal SHORT
    // sweep.direction = 'LONG' means wick went below and closed back above = reversal LONG
    if (sweptHigh && s.direction === 'SHORT') {
      validSweep = s;
      reversalDirection = 'SHORT';
      break;
    }
    if (sweptLow && s.direction === 'LONG') {
      validSweep = s;
      reversalDirection = 'LONG';
      break;
    }
  }

  if (!validSweep) return null;

  // Step 4: displacement in reversal direction AFTER the sweep
  const displacements = findAllRecent(events, 'displacement', 30)
    .filter((d) => d.ts >= validSweep.ts)
    .filter((d) => d.direction === reversalDirection)
    .filter((d) => d.timeframe === '5m' || d.timeframe === '15m');

  if (displacements.length === 0) return null;
  const validDisplacement = displacements[0]; // most recent

  // Step 5: MSS in reversal direction AFTER displacement
  const mssEvents = findAllRecent(events, 'mss', 30)
    .filter((m) => m.ts >= validDisplacement.ts)
    .filter((m) => m.direction === reversalDirection)
    .filter((m) => m.timeframe === '5m' || m.timeframe === '15m');

  if (mssEvents.length === 0) return null;
  const validMSS = mssEvents[0];

  // Step 6: find FVG or OB created by the displacement
  // FVG match: same direction, ts close to displacement ts, on the same TF
  const fvgs = findAllRecent(events, 'fvg-created', 30)
    .filter((f) => f.direction === reversalDirection)
    .filter((f) => Math.abs(f.ts - validDisplacement.ts) <= 90 * 60 * 1000); // within 90 min (HTF candles span 30-60 min)

  const obs = findAllRecent(events, 'ob-created', 30)
    .filter((o) => o.direction === reversalDirection)
    .filter((o) => Math.abs(o.ts - validDisplacement.ts) <= 90 * 60 * 1000)
    .filter((o) => !o.evidence?.tested); // prefer untested OBs

  // Prefer FVG (CE entry), fall back to OB
  let entryZone = null;
  let entryEventDescription = null;

  if (fvgs.length > 0) {
    const fvg = fvgs[0];
    entryZone = fvg.zone;
    entryEventDescription = `${fvg.timeframe} FVG`;
  } else if (obs.length > 0) {
    const ob = obs[0];
    entryZone = ob.zone;
    entryEventDescription = `${ob.timeframe} OB`;
  } else {
    return null; // no entry zone
  }

  // Compute entry as the CE (50% midpoint) of the zone
  const entry = (entryZone.upper + entryZone.lower) / 2;

  // V12.4: SL beyond the swept extreme (structural anchor).
  // Buffer uses standard formula: max(0.5×m5ATR, 0.15×h1ATR).
  const m5ATR = atrByTF['5m'] || 0;
  const h1ATR = atrByTF['1h'] || 0;
  const ltfATR = m5ATR || atrByTF['15m'] || 0;
  const buffer = structuralBuffer(m5ATR, h1ATR);

  const sweepWick = reversalDirection === 'SHORT'
    ? validSweep.evidence?.wickHigh
    : validSweep.evidence?.wickLow;
  if (sweepWick == null) return null;

  const sl = reversalDirection === 'SHORT'
    ? sweepWick + buffer
    : sweepWick - buffer;

  const slDist = Math.abs(entry - sl);
  const slDistATR = ltfATR > 0 ? slDist / ltfATR : 0;
  if (slDistATR > 3.0 || slDistATR < 0.3) return null; // setup invalid

  // TPs: opposite end of Asian range, then PDH/PDL
  const sessionLevels = events.filter((e) => e.type === 'session-level');
  const oppEnd = reversalDirection === 'SHORT' ? asianLow : asianHigh;
  const explicitTargets = [{
    price: oppEnd,
    label: 'Asian opposing extreme',
    source: 'asian-range',
    rMultiple: Math.abs(oppEnd - entry) / slDist,
  }];

  // Add PDH/PDL aligned with direction
  const pdhEvent = sessionLevels.find((e) => e.evidence?.kind === 'PDH');
  const pdlEvent = sessionLevels.find((e) => e.evidence?.kind === 'PDL');
  const pdTarget = reversalDirection === 'SHORT' ? pdlEvent : pdhEvent;
  if (pdTarget) {
    explicitTargets.push({
      price: pdTarget.price,
      label: pdTarget.evidence.kind,
      source: 'PD',
      rMultiple: Math.abs(pdTarget.price - entry) / slDist,
    });
  }

  const htfFVGs = events.filter(
    (e) => e.type === 'fvg-created' && e.timeframe === '1h'
  );
  const tps = buildTPs(reversalDirection, entry, sl, [...sessionLevels, ...explicitTargets], htfFVGs);
  if (tps.length === 0) return null;

  return {
    templateName: 'judas-swing',
    direction: reversalDirection,
    mode: 'DAY',
    entry,
    entryZone,
    sl,
    slDistance: slDist,
    slDistanceATR: slDistATR,
    tps,
    narrative: [
      `Asian range identified: high ${asianHigh.toFixed(5)}, low ${asianLow.toFixed(5)}`,
      `London Kill Zone open. Watching for manipulation.`,
      `${reversalDirection === 'SHORT' ? 'Asian high' : 'Asian low'} swept on ${validSweep.timeframe} — institutional liquidity grab.`,
      `Displacement ${reversalDirection.toLowerCase()} on ${validDisplacement.timeframe} — institutional commitment confirmed.`,
      `MSS confirmed on ${validMSS.timeframe} — structure has flipped.`,
      `Entry zone: ${entryEventDescription} at ${entryZone.lower.toFixed(5)}–${entryZone.upper.toFixed(5)}.`,
      `Judas Swing: ${reversalDirection.toLowerCase()} from ${entry.toFixed(5)}, SL ${sl.toFixed(5)}.`,
    ],
    contributingEvents: [asianRange, validSweep, validDisplacement, validMSS],
    timeframesInPlay: [...new Set([validSweep.timeframe, validDisplacement.timeframe, validMSS.timeframe])],
    formedAt: validMSS.ts,
  };
}

module.exports = { match, name: 'judas-swing' };