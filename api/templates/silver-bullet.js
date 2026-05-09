/* eslint-disable */
// V12.3 — api/templates/silver-bullet.js
//
// SILVER BULLET template.
//
// Three Silver Bullet 1-hour windows (UTC, generous DST union):
//   London SB:  08:00-09:00 UTC  (03-04 NY)
//   NY AM SB:   14:00-15:00 UTC  (10-11 NY)
//   NY PM SB:   18:00-19:00 UTC  (14-15 NY)
//
// Sequence:
//   1. We are inside a Silver Bullet 1-hour window
//   2. Daily/H4 trend is clear (LONG or SHORT)
//   3. There's an unfilled or partially-filled FVG on M5 from the morning's
//      impulse (within last ~4 hours), in the same direction as bias
//   4. Price is approaching the FVG (within 0.5 ATR) or just tapped it
//
// Trade: enter at FVG zone, SL beyond FVG candle extreme, TP at next session liquidity.
//
// Difference from Judas: Silver Bullet is CONTINUATION not reversal.
// Difference from OTE: Silver Bullet is TIME-SPECIFIC.

const { buildTPs } = require('./_template');
const { findMostRecent, findAllRecent } = require('../events/_event');

function inSilverBulletWindow() {
  const d = new Date();
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();

  // London SB: 08:00-09:00 UTC
  if (utcMin >= 8 * 60 && utcMin < 9 * 60) return 'LONDON_SB';
  // NY AM SB: 14:00-15:00 UTC
  if (utcMin >= 14 * 60 && utcMin < 15 * 60) return 'NY_AM_SB';
  // NY PM SB: 18:00-19:00 UTC
  if (utcMin >= 18 * 60 && utcMin < 19 * 60) return 'NY_PM_SB';

  return null;
}

function match({ events, currentPrice, atrByTF }) {
  const sbWindow = inSilverBulletWindow();
  if (!sbWindow) return null;

  // Determine bias from H4 trend (with H1 corroboration if H4 unclear)
  const h4Trend = events.find((e) => e.type === 'trend' && e.timeframe === '4h');
  const h1Trend = events.find((e) => e.type === 'trend' && e.timeframe === '1h');

  let bias = h4Trend?.direction || 'NEUTRAL';
  if (bias === 'NEUTRAL') bias = h1Trend?.direction || 'NEUTRAL';
  if (bias === 'NEUTRAL') return null;

  // Find an unfilled M5 FVG in bias direction from last ~4 hours
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
  const m5FVGs = findAllRecent(events, 'fvg-created', 30)
    .filter((f) => f.timeframe === '5m')
    .filter((f) => f.ts >= fourHoursAgo)
    .filter((f) => f.direction === bias)
    .filter((f) => (f.evidence?.fillPercent ?? 1) < 0.5); // less than half-filled

  if (m5FVGs.length === 0) return null;

  // Pick the FVG with the highest CE that aligns with bias direction
  // (closest to current price for cleanest entry)
  const m5ATR = atrByTF['5m'] || atrByTF['15m'] || 0;
  if (m5ATR <= 0) return null;

  const candidates = m5FVGs.filter((f) => {
    const ceDist = Math.abs(f.evidence.ce - currentPrice);
    return ceDist <= m5ATR * 1.5; // price near the FVG
  });

  if (candidates.length === 0) return null;

  // Pick the best one: closest to price + most-fresh
  candidates.sort((a, b) => {
    const distA = Math.abs(a.evidence.ce - currentPrice);
    const distB = Math.abs(b.evidence.ce - currentPrice);
    return distA - distB;
  });

  const fvg = candidates[0];
  const entry = fvg.evidence.ce;
  const fvgZone = fvg.zone;

  // SL: beyond the FVG outer edge + 0.15 ATR
  const sl = bias === 'LONG'
    ? fvgZone.lower - m5ATR * 0.15
    : fvgZone.upper + m5ATR * 0.15;

  const slDist = Math.abs(entry - sl);
  const slDistATR = m5ATR > 0 ? slDist / m5ATR : 0;
  if (slDistATR > 3.0 || slDistATR < 0.3) return null;

  // TPs: session liquidity in bias direction
  const sessionLevels = events.filter((e) => e.type === 'session-level');
  const htfFVGs = events.filter(
    (e) => e.type === 'fvg-created' && (e.timeframe === '1h' || e.timeframe === '4h')
  );
  const tps = buildTPs(bias, entry, sl, sessionLevels, htfFVGs);
  if (tps.length === 0) return null;

  const windowName = sbWindow === 'LONDON_SB' ? 'London Silver Bullet'
    : sbWindow === 'NY_AM_SB' ? 'New York AM Silver Bullet'
    : 'New York PM Silver Bullet';

  return {
    templateName: 'silver-bullet',
    direction: bias,
    mode: 'DAY',
    entry,
    entryZone: fvgZone,
    sl,
    slDistance: slDist,
    slDistanceATR: slDistATR,
    tps,
    narrative: [
      `${windowName} window active.`,
      `Bias: ${bias} (H4/H1 trend confirms).`,
      `Unfilled M5 FVG identified: ${fvgZone.lower.toFixed(5)}–${fvgZone.upper.toFixed(5)}.`,
      `Fill: ${(fvg.evidence.fillPercent * 100).toFixed(0)}%, age: ${fvg.evidence.barsAgo} bars.`,
      `Entry at CE: ${entry.toFixed(5)}, SL beyond FVG at ${sl.toFixed(5)}.`,
      `Silver Bullet: ${bias.toLowerCase()} continuation.`,
    ],
    contributingEvents: [fvg, h4Trend || h1Trend].filter(Boolean),
    timeframesInPlay: ['5m', h4Trend ? '4h' : '1h'],
    formedAt: Date.now(),
  };
}

module.exports = { match, name: 'silver-bullet' };