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

// V12.4: Standard structural-SL buffer.
// Real ICT principle (per IOFED docs): "Stop too tight. The stop must sit
// beyond the MSS swing — not at the IOFED itself. Stops parked at the IOFED
// get stopped out on the second test."
//
// Buffer must clear M5 wick noise AND be meaningful at H1 scale:
//   max(0.5 × m5ATR, 0.15 × h1ATR)
//
// For EURUSD (m5ATR≈0.0002, h1ATR≈0.0009) → ~1.35 pips
// For gold   (m5ATR≈1.5,    h1ATR≈5)      → ~0.75 pts
// For NAS100 (m5ATR≈15,     h1ATR≈60)     → ~9 pts
function structuralBuffer(m5ATR, h1ATR) {
  const m5 = m5ATR || 0;
  const h1 = h1ATR || 0;
  return Math.max(m5 * 0.5, h1 * 0.15);
}

// V12.4: Find a structural SL anchor for a setup that doesn't have one built in.
// Used primarily by Silver Bullet which historically anchored to LTF FVG edge.
//
// Real ICT: SL goes beyond the SWEPT EXTREME (the liquidity that was grabbed
// before the displacement). We search recent M15/H1 sweep events whose wick
// extends in the SL direction past the entry by at least `minDistance`.
//
// Returns: { sl, anchorPrice, anchorEvent } or null if no structural anchor exists.
// When null, the template should REJECT the setup — no structural anchor means
// it's not a real ICT entry, just a random FVG.
function findStructuralSL({ events, bias, entry, m5ATR, h1ATR, lookbackHours = 6, minDistance = null }) {
  if (!events || !bias || entry == null || !h1ATR) return null;

  const since = Date.now() - lookbackHours * 60 * 60 * 1000;
  // Minimum distance from entry to anchor — prevents anchor being too close.
  // Default: max(0.5 × h1ATR, 2 × m5ATR) — generous enough to clear pip-minimum
  // SL distance on most brokers.
  const minDist = minDistance != null
    ? minDistance
    : Math.max(0.5 * h1ATR, 2 * (m5ATR || 0));

  // Candidate sweep events on M15 or H1 (the structural timeframes)
  const candidates = events
    .filter((e) => e.type === 'sweep')
    .filter((e) => e.ts >= since)
    .filter((e) => e.timeframe === '15m' || e.timeframe === '1h');

  if (candidates.length === 0) return null;

  const buffer = structuralBuffer(m5ATR, h1ATR);

  if (bias === 'SHORT') {
    // Want a sweep that grabbed buyside liquidity ABOVE entry
    const above = candidates
      .map((e) => ({ event: e, price: e.evidence?.wickHigh }))
      .filter((c) => c.price != null && c.price > entry + minDist);
    if (above.length === 0) return null;
    // Nearest swept high (smallest above entry — closest to price)
    above.sort((a, b) => a.price - b.price);
    const nearest = above[0];
    return {
      sl: nearest.price + buffer,
      anchorPrice: nearest.price,
      anchorEvent: nearest.event,
    };
  }

  if (bias === 'LONG') {
    // Want a sweep that grabbed sellside liquidity BELOW entry
    const below = candidates
      .map((e) => ({ event: e, price: e.evidence?.wickLow }))
      .filter((c) => c.price != null && c.price < entry - minDist);
    if (below.length === 0) return null;
    // Nearest swept low (largest below entry — closest to price)
    below.sort((a, b) => b.price - a.price);
    const nearest = below[0];
    return {
      sl: nearest.price - buffer,
      anchorPrice: nearest.price,
      anchorEvent: nearest.event,
    };
  }

  return null;
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
  structuralBuffer,
  findStructuralSL,
};