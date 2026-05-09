/* eslint-disable */
// V12.3 — api/templates/_template.js
//
// TEMPLATE CONTRACT.
//
// Each template is a pure function that examines an event list and decides:
//   - Does the recent event sequence match this named ICT setup?
//   - If yes, return a setup descriptor (entry, SL, TPs, narrative)
//   - If no, return null
//
// Templates do NOT score. They either recognize the pattern or they don't.
//
// SETUP DESCRIPTOR shape (what templates return on match):
//   {
//     templateName: 'judas-swing' | 'silver-bullet' | 'turtle-soup' | 'ote-continuation' | 'unicorn',
//     direction: 'LONG' | 'SHORT',
//     mode: 'DAY' | 'SCALP' | 'SWING',
//     entry: <number>,
//     entryZone: { upper, lower },
//     sl: <number>,
//     tps: [{ price, label, source }],
//     narrative: [<string>],            // human-readable story, line by line
//     contributingEvents: [<event>],    // the events that matched
//     timeframesInPlay: [<tf>],
//     formedAt: <ts>,
//   }

// Helper: nearest SL beyond a given level + small ATR buffer
function slBeyond(direction, swingExtreme, atrValue, multiplier = 0.15) {
  if (direction === 'LONG') return swingExtreme - atrValue * multiplier;
  return swingExtreme + atrValue * multiplier;
}

// Helper: build R-multiple targets
function rMultipleTargets(direction, entry, sl, multipliers = [1, 2, 3, 4]) {
  const slDist = Math.abs(entry - sl);
  return multipliers.map((r, i) => ({
    price: direction === 'LONG' ? entry + slDist * r : entry - slDist * r,
    label: `TP${i + 1}`,
    source: `${r}R`,
    rMultiple: r,
  }));
}

// Helper: build TP list using session levels first, then R-fallback
function buildTPs(direction, entry, sl, sessionLevelEvents, opposingFVGEvents) {
  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) return [];

  const targets = [];

  // Session levels in the trade direction
  for (const ev of sessionLevelEvents) {
    const lvl = ev.price;
    if (lvl == null) continue;
    const inDir = direction === 'LONG' ? lvl > entry : lvl < entry;
    if (!inDir) continue;
    const r = Math.abs(lvl - entry) / slDist;
    if (r >= 0.8 && r <= 8) {
      targets.push({
        price: lvl,
        label: ev.evidence?.kind || 'session-level',
        source: ev.evidence?.kind || 'session',
        rMultiple: r,
      });
    }
  }

  // HTF FVG magnets
  for (const ev of opposingFVGEvents) {
    if (ev.direction !== direction) continue;
    const lvl = ev.price;
    if (lvl == null) continue;
    const inDir = direction === 'LONG' ? lvl > entry : lvl < entry;
    if (!inDir) continue;
    const r = Math.abs(lvl - entry) / slDist;
    if (r >= 0.8 && r <= 8) {
      const dup = targets.some((t) => Math.abs(t.price - lvl) < slDist * 0.2);
      if (!dup) {
        targets.push({
          price: lvl,
          label: `${ev.timeframe} FVG`,
          source: `${ev.timeframe} FVG`,
          rMultiple: r,
        });
      }
    }
  }

  // R-multiple fallbacks
  const baseRs = [1.0, 2.0, 3.0, 4.0];
  for (const r of baseRs) {
    if (targets.length >= 4) break;
    const px = direction === 'LONG' ? entry + slDist * r : entry - slDist * r;
    const tooClose = targets.some((t) => Math.abs(t.rMultiple - r) < 0.3);
    if (!tooClose) {
      targets.push({
        price: px,
        label: `${r}R`,
        source: 'R-fallback',
        rMultiple: r,
      });
    }
  }

  targets.sort((a, b) => a.rMultiple - b.rMultiple);
  return targets.slice(0, 4);
}

module.exports = {
  slBeyond,
  rMultipleTargets,
  buildTPs,
};