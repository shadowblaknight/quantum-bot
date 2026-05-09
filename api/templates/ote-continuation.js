/* eslint-disable */
// V12.3 — api/templates/ote-continuation.js
//
// OTE CONTINUATION template.
//
// Sequence:
//   1. H1 (or H4) trend established — clear LONG or SHORT
//   2. Recent impulse leg on H1 — clear swing low → high (LONG) or high → low (SHORT)
//   3. Price retraces into 62-79% Fibonacci zone (ote-zone-entered event present)
//   4. Bonus: an OB or FVG aligned with bias inside the OTE band
//   5. M5 reaction at OTE — typically MSS in bias direction, or rejection candle
//
// Trade: enter at 0.705 (sweet spot) or wherever OB/FVG intersects.
// SL beyond the impulse origin (the 100% retracement = the swing extreme).
// TP at -0.27 fib extension first, then -0.62 / opposing range extreme.

const { buildTPs } = require('./_template');
const { findMostRecent, findAllRecent } = require('../events/_event');

function match({ events, currentPrice, atrByTF }) {
  // Step 1: H1 trend must be clear
  const h1Trend = events.find((e) => e.type === 'trend' && e.timeframe === '1h');
  if (!h1Trend || h1Trend.direction === 'NEUTRAL') return null;
  const bias = h1Trend.direction;

  // Optional H4 corroboration — strict check: if H4 trend exists and disagrees, reject
  const h4Trend = events.find((e) => e.type === 'trend' && e.timeframe === '4h');
  if (h4Trend && h4Trend.direction !== 'NEUTRAL' && h4Trend.direction !== bias) return null;

  // Step 2: ote-zone-entered event on H1 in bias direction
  const oteZones = findAllRecent(events, 'ote-zone-entered', 5)
    .filter((o) => o.timeframe === '1h')
    .filter((o) => o.direction === bias);

  if (oteZones.length === 0) return null;
  const ote = oteZones[0];

  // Step 3: price must currently BE in the OTE zone
  if (currentPrice < ote.zone.lower || currentPrice > ote.zone.upper) return null;

  // Step 4: prefer entries with OB or FVG inside the OTE band
  const obsInZone = findAllRecent(events, 'ob-created', 30)
    .filter((o) => o.direction === bias)
    .filter((o) => (o.timeframe === '15m' || o.timeframe === '1h'))
    .filter((o) => !o.evidence?.tested)
    .filter((o) => o.zone.upper >= ote.zone.lower && o.zone.lower <= ote.zone.upper);

  const fvgsInZone = findAllRecent(events, 'fvg-created', 30)
    .filter((f) => f.direction === bias)
    .filter((f) => (f.timeframe === '15m' || f.timeframe === '1h'))
    .filter((f) => (f.evidence?.fillPercent ?? 1) < 0.5)
    .filter((f) => f.zone.upper >= ote.zone.lower && f.zone.lower <= ote.zone.upper);

  // Compute entry: prefer OB/FVG midpoint if available, else 0.705 sweet spot
  let entry = ote.evidence.sweetSpot;
  let entryZone = ote.zone;
  let entrySource = '0.705 sweet spot';

  if (obsInZone.length > 0) {
    const ob = obsInZone[0];
    entry = (ob.zone.upper + ob.zone.lower) / 2;
    entryZone = ob.zone;
    entrySource = `${ob.timeframe} OB inside OTE`;
  } else if (fvgsInZone.length > 0) {
    const fvg = fvgsInZone[0];
    entry = fvg.evidence.ce;
    entryZone = fvg.zone;
    entrySource = `${fvg.timeframe} FVG inside OTE (CE)`;
  }

  // SL beyond the impulse origin (the 100% retracement)
  const h1ATR = atrByTF['1h'] || 0;
  const slBeyond = ote.evidence.slBeyond; // = impulseFrom price
  const sl = bias === 'LONG'
    ? slBeyond - h1ATR * 0.15
    : slBeyond + h1ATR * 0.15;

  const slDist = Math.abs(entry - sl);
  const slDistATR = h1ATR > 0 ? slDist / h1ATR : 0;
  if (slDistATR > 5.0 || slDistATR < 0.3) return null;

  // TPs: -0.27 and -0.62 fib extensions, plus session liquidity, plus R-fallback
  // Compute fib extension targets
  const impulseRange = Math.abs(ote.evidence.impulseTo - ote.evidence.impulseFrom);
  const ext027 = bias === 'LONG'
    ? ote.evidence.impulseTo + impulseRange * 0.27
    : ote.evidence.impulseTo - impulseRange * 0.27;
  const ext062 = bias === 'LONG'
    ? ote.evidence.impulseTo + impulseRange * 0.62
    : ote.evidence.impulseTo - impulseRange * 0.62;

  // Build session-level + extension target list
  const sessionLevels = events.filter((e) => e.type === 'session-level');
  const extensionLevels = [
    {
      type: 'session-level',
      ts: Date.now(),
      timeframe: '1h',
      price: ext027,
      direction: 'NEUTRAL',
      evidence: { kind: '-0.27 ext' },
    },
    {
      type: 'session-level',
      ts: Date.now(),
      timeframe: '1h',
      price: ext062,
      direction: 'NEUTRAL',
      evidence: { kind: '-0.62 ext' },
    },
  ];

  const htfFVGs = events.filter(
    (e) => e.type === 'fvg-created' && (e.timeframe === '1h' || e.timeframe === '4h')
  );

  const tps = buildTPs(bias, entry, sl, [...sessionLevels, ...extensionLevels], htfFVGs);
  if (tps.length === 0) return null;

  return {
    templateName: 'ote-continuation',
    direction: bias,
    mode: 'DAY',
    entry,
    entryZone,
    sl,
    slDistance: slDist,
    slDistanceATR: slDistATR,
    tps,
    narrative: [
      `H1 trend: ${bias.toLowerCase()} (${h1Trend.evidence.trend}).`,
      h4Trend ? `H4 corroborates ${h4Trend.evidence.trend.toLowerCase()}.` : `H4 unclear, using H1 alone.`,
      `Impulse identified: ${ote.evidence.impulseFrom.toFixed(5)} → ${ote.evidence.impulseTo.toFixed(5)} (${ote.evidence.impulseRangeATR.toFixed(1)} ATR).`,
      `Price in OTE zone: ${ote.zone.lower.toFixed(5)}–${ote.zone.upper.toFixed(5)}, sweet spot ${ote.evidence.sweetSpot.toFixed(5)}.`,
      `Entry: ${entrySource} at ${entry.toFixed(5)}.`,
      `OTE Continuation: ${bias.toLowerCase()} pullback in established trend.`,
    ],
    contributingEvents: [h1Trend, ote, ...obsInZone.slice(0, 1), ...fvgsInZone.slice(0, 1)].filter(Boolean),
    timeframesInPlay: ['1h', h4Trend ? '4h' : null, '15m'].filter(Boolean),
    formedAt: ote.ts,
  };
}

module.exports = { match, name: 'ote-continuation' };