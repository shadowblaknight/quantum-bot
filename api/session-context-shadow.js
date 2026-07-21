'use strict';
/* eslint-disable */
// api/session-context-shadow.js  v15.7
// Captures session-level context at signal time for each fired trade.
// Called fire-and-forget from processSignalBackground (Phase 4) in webhook.js.
// Writes go to Redis only; never touches live execution state; cannot gate trades.
//
// Stored fields:
//   asianHigh/Low, londonHigh/Low, prevDayHigh/Low — only for completed sessions
//   asianPosition: 'inside' | 'above' | 'below'  (where is testLevel vs Asian range)
//   londonDirection: 'bull' | 'bear' | null        (London close vs open, if available)
//   withPriorSession: true/false/null              (trade direction agrees with prior session)
//   nearestLevel, distATR, liqCoincidence          (0.25 ATR threshold test)
//   orbEntryP: retestEntry from payload, for orb/orb-pro when Pine provides it
//   testLevel: the price used for the coincidence test
//
// Session boundaries (UTC):
//   Asian  00:00–07:00  available if signal UTC hour ≥ 7
//   London 07:00–12:00  available if signal UTC hour ≥ 12
//   prevDay full prior UTC day — always available

const { getRedis, safeParse } = require('./_lib');

const SC_SHADOW_KEY       = (id) => `v14:sessionctx:shadow:${id}`;
const SC_SHADOW_INDEX_KEY = 'v14:sessionctx:shadow:index';
const SC_SHADOW_INDEX_CAP = 5000;
const SC_SHADOW_TTL_SEC   = 30 * 24 * 3600; // 30 days

const LIQ_THRESHOLD = 0.25; // ATR multiplier for coincidence test

// ── Session level extraction from H1 candles ─────────────────────────────────
// Each candle: { time: ISO-string, open, high, low, close, volume }
// H1 candles cover one hour per bar. We only use sessions that CLOSED before ts.

function extractSessionLevels(candles, ts) {
  const signalDate = new Date(ts);
  const signalHour = signalDate.getUTCHours();
  const signalDateStr = signalDate.toISOString().slice(0, 10); // 'YYYY-MM-DD'

  // Previous day: full UTC day before signal date
  const prevDateStr = new Date(
    Date.UTC(signalDate.getUTCFullYear(), signalDate.getUTCMonth(), signalDate.getUTCDate() - 1)
  ).toISOString().slice(0, 10);

  const prevDayBars  = candles.filter(c => c.time.slice(0, 10) === prevDateStr);
  const asianBars    = candles.filter(c => {
    if (c.time.slice(0, 10) !== signalDateStr) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 0 && h < 7;
  });
  const londonBars   = candles.filter(c => {
    if (c.time.slice(0, 10) !== signalDateStr) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 7 && h < 12;
  });

  const hi  = (arr) => arr.length ? Math.max(...arr.map(c => c.high))  : null;
  const lo  = (arr) => arr.length ? Math.min(...arr.map(c => c.low))   : null;

  const prevDayHigh = hi(prevDayBars);
  const prevDayLow  = lo(prevDayBars);

  // Asian: only if signal is at or after 07:00 UTC
  const asianHigh = signalHour >= 7  ? hi(asianBars)   : null;
  const asianLow  = signalHour >= 7  ? lo(asianBars)   : null;

  // London: only if signal is at or after 12:00 UTC
  const londonHigh = signalHour >= 12 ? hi(londonBars)  : null;
  const londonLow  = signalHour >= 12 ? lo(londonBars)  : null;

  // London direction: first London bar open → last London bar close
  let londonDirection = null;
  if (signalHour >= 12 && londonBars.length >= 3) {
    const lonOpen  = londonBars[0].open;
    const lonClose = londonBars[londonBars.length - 1].close;
    londonDirection = lonClose > lonOpen ? 'bull' : 'bear';
  }

  return { prevDayHigh, prevDayLow, asianHigh, asianLow, londonHigh, londonLow, londonDirection };
}

// ── h1ATR: average of (high−low) over the 14 H1 bars immediately before signal ─
function computeH1ATR(candles, ts) {
  const bars = candles
    .filter(c => new Date(c.time).getTime() < ts)
    .slice(-14);
  if (bars.length < 3) return null;
  return bars.reduce((s, b) => s + (b.high - b.low), 0) / bars.length;
}

// ── Find nearest completed session level to testLevel ────────────────────────
function findNearest(testLevel, levels, h1ATR) {
  let nearestName = null, minDist = Infinity;
  for (const [name, val] of Object.entries(levels)) {
    if (val == null) continue;
    const d = Math.abs(testLevel - val);
    if (d < minDist) { minDist = d; nearestName = name; }
  }
  const distATR = (h1ATR > 0 && minDist < Infinity) ? minDist / h1ATR : null;
  const liqCoincidence = distATR != null ? distATR <= LIQ_THRESHOLD : false;
  return { nearestLevel: nearestName, distATR, liqCoincidence };
}

// ── Main writer ───────────────────────────────────────────────────────────────
async function writeSessionCtxShadow(p, dedupeKey, assetId) {
  const r = getRedis();
  if (!r) return;

  const ts = typeof p.timestamp === 'number' ? p.timestamp
           : parseInt(p.timestamp, 10) || Date.now();

  // Fetch H1 candles covering 3 days (72 bars) — enough for prevDay + today's sessions
  let candles = [];
  try {
    const { fetchCandles } = require('./candle-source');
    const result = await fetchCandles(assetId, '1h', 72);
    candles = (result && result.candles) ? result.candles : [];
  } catch (_) {}

  if (candles.length < 5) return; // not enough data to compute any level

  // Compute session levels
  const { prevDayHigh, prevDayLow, asianHigh, asianLow, londonHigh, londonLow, londonDirection }
    = extractSessionLevels(candles, ts);

  // h1ATR
  const h1ATR = computeH1ATR(candles, ts);

  // Test level: prefer orbEntryP (retestEntry) for orb/orb-pro — this IS the OR edge.
  // Fall back to immediateEntry, then p.entry.
  const isOrb = p.template === 'orb' || p.template === 'orb-pro';
  const _retE  = parseFloat(p.retestEntry);
  const _immE  = parseFloat(p.immediateEntry);
  const _pE    = parseFloat(p.entry);
  const orbEntryP = isOrb && isFinite(_retE) ? _retE : null;
  const testLevel = orbEntryP != null    ? orbEntryP
                  : isFinite(_immE)      ? _immE
                  : isFinite(_pE)        ? _pE
                  : null;

  if (testLevel == null) return;

  // Nearest level and coincidence
  const levels = { prevDayHigh, prevDayLow, asianHigh, asianLow, londonHigh, londonLow };
  const { nearestLevel, distATR, liqCoincidence } = h1ATR
    ? findNearest(testLevel, levels, h1ATR)
    : { nearestLevel: null, distATR: null, liqCoincidence: false };

  // Asian position
  let asianPosition = null;
  if (asianHigh != null && asianLow != null) {
    if      (testLevel > asianHigh) asianPosition = 'above';
    else if (testLevel < asianLow)  asianPosition = 'below';
    else                            asianPosition = 'inside';
  }

  // withPriorSession: direction agrees with the most-recent completed session
  let withPriorSession = null;
  const dir = p.direction;
  if (londonDirection) {
    withPriorSession = (dir === 'LONG'  && londonDirection === 'bull')
                    || (dir === 'SHORT' && londonDirection === 'bear');
  } else if (asianPosition) {
    withPriorSession = (dir === 'LONG'  && asianPosition === 'above')
                    || (dir === 'SHORT' && asianPosition === 'below');
  }

  const record = {
    id:              dedupeKey,
    assetId,
    template:        p.template    || 'unknown',
    direction:       dir           || null,
    htfTier:         p.htfTier     || null,
    ts,
    testLevel,
    orbEntryP,
    prevDayHigh,    prevDayLow,
    asianHigh,      asianLow,
    londonHigh,     londonLow,
    londonDirection,
    h1ATR,
    nearestLevel,
    distATR,
    liqCoincidence,
    asianPosition,
    withPriorSession,
  };

  try {
    await r.set(SC_SHADOW_KEY(dedupeKey), JSON.stringify(record), { ex: SC_SHADOW_TTL_SEC });
  } catch (_) { return; }

  try {
    const raw = await r.get(SC_SHADOW_INDEX_KEY).catch(() => null);
    let idx = safeParse(raw);
    if (!Array.isArray(idx)) idx = [];
    const filtered = idx.filter(e => e.id !== dedupeKey);
    filtered.unshift({ id: dedupeKey, ts, template: p.template, assetId });
    await r.set(
      SC_SHADOW_INDEX_KEY,
      JSON.stringify(filtered.slice(0, SC_SHADOW_INDEX_CAP)),
      { ex: SC_SHADOW_TTL_SEC }
    );
  } catch (_) {}
}

module.exports = { writeSessionCtxShadow, SC_SHADOW_KEY, SC_SHADOW_INDEX_KEY, SC_SHADOW_TTL_SEC };
