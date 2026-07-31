'use strict';
/* eslint-disable */
// api/signal-quality.js  v16.0
//
// LIVE signal-quality gate: evaluates three filters at execution time and
// blocks placements that fail. Previously these were shadow-only.
//
// Gates (each independently togglable via Redis config):
//   WICK  — block when signal bar wickRatio > threshold (default 0.50)
//           Data: heavy-wick trades = 0% WR across Jul 24-31 (0W/4L)
//   SESSION — block when direction disagrees with prior session (withPrior=false)
//           Data: withPrior=false = 27.3% WR across 11 trades Jul 24-31
//   CVD   — block when CVD is low-trust AND shows counter-divergence
//           Data: lowTrust=true = 20% WR (1W/4L) across Jul 24-31
//
// Config key: v15:squality:config  (JSON, 90-day TTL)
// Quality storage: v15:squality:{dedupeKey}  (30-day TTL, for recognition memory join)
// Quality index:   v15:squality:index  (capped at 2000)

const { getRedis, safeParse } = require('./_lib');

const SQ_CONFIG_KEY  = 'v15:squality:config';
const SQ_KEY         = (id) => `v15:squality:${id}`;
const SQ_INDEX_KEY   = 'v15:squality:index';
const SQ_INDEX_CAP   = 2000;
const SQ_TTL_SEC     = 30 * 24 * 3600;
const SQ_CONFIG_TTL  = 90 * 24 * 3600;

const DEFAULT_CONFIG = {
  wickGateEnabled:    true,
  wickThreshold:      0.50,
  sessionGateEnabled: true,
  cvdGateEnabled:     true,
};

// ── Config read/write ─────────────────────────────────────────────────────────

async function getConfig() {
  const r = getRedis();
  if (!r) return DEFAULT_CONFIG;
  try {
    const raw = await r.get(SQ_CONFIG_KEY);
    const stored = safeParse(raw);
    return stored && typeof stored === 'object'
      ? { ...DEFAULT_CONFIG, ...stored }
      : DEFAULT_CONFIG;
  } catch (_) { return DEFAULT_CONFIG; }
}

async function setConfig(patch) {
  const r = getRedis();
  if (!r) return { ok: false, error: 'redis-unavailable' };
  try {
    const current = await getConfig();
    const next = { ...current, ...patch };
    await r.set(SQ_CONFIG_KEY, JSON.stringify(next), { ex: SQ_CONFIG_TTL });
    return { ok: true, config: next };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Wick ratio gate ───────────────────────────────────────────────────────────

function evalWick(p, threshold) {
  const o = parseFloat(p.barOpen),  h = parseFloat(p.barHigh);
  const l = parseFloat(p.barLow),   c = parseFloat(p.barClose);
  const hasBarData = [o,h,l,c].every(v => isFinite(v));
  if (!hasBarData) return { pass: true, wickRatio: null, hasBarData: false };

  const range = h - l;
  if (range <= 0) return { pass: true, wickRatio: null, hasBarData: true };

  const bodyTop   = Math.max(o, c);
  const bodyBot   = Math.min(o, c);
  const upperWick = h - bodyTop;
  const lowerWick = bodyBot - l;
  const wickRatio = Math.max(upperWick, lowerWick) / range;
  const pass      = wickRatio <= threshold;
  return {
    pass,
    wickRatio: Math.round(wickRatio * 10000) / 10000,
    hasBarData: true,
    blockedReason: pass ? null : `wick-${(wickRatio*100).toFixed(0)}%>threshold(${(threshold*100).toFixed(0)}%)`,
  };
}

// ── Session context gate ──────────────────────────────────────────────────────
// Fetches 4h candles and computes withPriorSession / asianPosition.
// Mirrors session-context-shadow.js logic but returns result for gating.

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function extractSessionLevels(candles, ts) {
  const d = new Date(ts);
  const signalDateStr = d.toISOString().slice(0, 10);
  const prevDateStr   = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1)
  ).toISOString().slice(0, 10);
  const signalHour    = d.getUTCHours();

  const prevDayBars = candles.filter(c => c.time.slice(0, 10) === prevDateStr);
  const asianBars   = candles.filter(c => {
    if (c.time.slice(0, 10) !== signalDateStr) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 0 && h < 7;
  });
  const londonBars  = candles.filter(c => {
    if (c.time.slice(0, 10) !== signalDateStr) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 7 && h < 12;
  });

  const hi = arr => arr.length ? Math.max(...arr.map(c => c.high)) : null;
  const lo = arr => arr.length ? Math.min(...arr.map(c => c.low))  : null;

  const asianHigh  = signalHour >= 7  ? hi(asianBars)  : null;
  const asianLow   = signalHour >= 7  ? lo(asianBars)  : null;
  const londonHigh = signalHour >= 12 ? hi(londonBars) : null;
  const londonLow  = signalHour >= 12 ? lo(londonBars) : null;

  let londonDirection = null;
  if (signalHour >= 12 && londonBars.length >= 3) {
    londonDirection = londonBars[londonBars.length-1].close > londonBars[0].open
      ? 'bull' : 'bear';
  }

  return {
    prevDayHigh: hi(prevDayBars), prevDayLow: lo(prevDayBars),
    asianHigh, asianLow, londonHigh, londonLow, londonDirection,
  };
}

function computeATR(candles, ts) {
  const bars = candles.filter(c => new Date(c.time).getTime() < ts).slice(-14);
  if (bars.length < 3) return null;
  return bars.reduce((s, b) => s + (b.high - b.low), 0) / bars.length;
}

async function evalSession(p, assetId, ts) {
  const dir = p.direction;
  try {
    const { fetchCandles } = require('./candle-source');
    const result = await withTimeout(fetchCandles(assetId, '4h', 18), 5000, { candles: [] });
    const candles = (result && result.candles) || [];
    if (candles.length < 5) return { pass: true, withPriorSession: null, asianPosition: null, reason: 'no-candle-data' };

    const levels = extractSessionLevels(candles, ts);
    const { asianHigh, asianLow, londonDirection, londonHigh, londonLow } = levels;
    const atr = computeATR(candles, ts);

    // Determine withPriorSession
    let withPriorSession = null;
    if (londonDirection) {
      withPriorSession = (dir === 'LONG' && londonDirection === 'bull')
                      || (dir === 'SHORT' && londonDirection === 'bear');
    } else if (asianHigh != null && asianLow != null) {
      const asianMid = (asianHigh + asianLow) / 2;
      if (asianHigh - asianLow > 0) {
        withPriorSession = (dir === 'LONG' && asianLow > asianLow)   // simplify: use direction vs midpoint
                        || (dir === 'SHORT' && asianHigh < asianHigh);
      }
    }
    // Re-derive withPriorSession correctly: compare trade direction to London close direction
    // or Asian session bias
    if (londonDirection) {
      withPriorSession = (dir === 'LONG' && londonDirection === 'bull')
                      || (dir === 'SHORT' && londonDirection === 'bear');
    } else if (asianHigh != null && asianLow != null) {
      // use London high/low vs Asian as momentum proxy — fallback: null (no block)
      withPriorSession = null;
    }

    // asianPosition
    let asianPosition = null;
    const testLevel = parseFloat(p.immediateEntry) || parseFloat(p.retestEntry) || parseFloat(p.entry);
    if (isFinite(testLevel) && asianHigh != null && asianLow != null) {
      if      (testLevel > asianHigh) asianPosition = 'above';
      else if (testLevel < asianLow)  asianPosition = 'below';
      else                            asianPosition = 'inside';
    }

    // liqCoincidence
    let liqCoincidence = false, nearestLevel = null, distATR = null;
    if (atr && isFinite(testLevel)) {
      const lvls = { asianHigh, asianLow, londonHigh, londonLow,
                     prevDayHigh: levels.prevDayHigh, prevDayLow: levels.prevDayLow };
      let minDist = Infinity;
      for (const [name, val] of Object.entries(lvls)) {
        if (val == null) continue;
        const d = Math.abs(testLevel - val);
        if (d < minDist) { minDist = d; nearestLevel = name; }
      }
      distATR = atr > 0 ? minDist / atr : null;
      liqCoincidence = distATR != null && distATR <= 0.25;
    }

    // Gate: block only when withPriorSession is explicitly false
    const pass = withPriorSession !== false;
    return {
      pass,
      withPriorSession,
      asianPosition,
      liqCoincidence,
      nearestLevel,
      londonDirection,
      distATR,
      blockedReason: pass ? null : `session-against-prior(london=${londonDirection})`,
    };
  } catch (e) {
    return { pass: true, withPriorSession: null, asianPosition: null, reason: `error:${e.message}` };
  }
}

// ── CVD gate ──────────────────────────────────────────────────────────────────

function evalCVD(p) {
  const parseBool = v => v === true || v === 'true';
  const lowTrust    = parseBool(p.cvdLowTrust);
  const divergence  = p.cvdDivergence || 'none';
  const confirms    = parseBool(p.cvdConfirms);
  const slope       = p.cvdSlope || 'flat';
  const hasCVDData  = p.cvdSlope != null || p.cvdLowTrust != null;

  if (!hasCVDData) return { pass: true, hasCVDData: false };

  const hasDivergence = divergence !== 'none';
  const pass = !(lowTrust && hasDivergence);
  return {
    pass,
    hasCVDData: true,
    cvdConfirms: confirms,
    cvdSlope: slope,
    cvdDivergence: divergence,
    cvdLowTrust: lowTrust,
    blockedReason: pass ? null : `cvd-low-trust+divergence(${divergence})`,
  };
}

// ── Main evaluator ────────────────────────────────────────────────────────────

async function evaluateSignalQuality(p, assetId, dedupeKey) {
  const cfg = await getConfig();
  const ts  = typeof p.timestamp === 'number' ? p.timestamp
            : parseInt(p.timestamp, 10) || Date.now();

  const [wickResult, sessionResult, cvdResult] = await Promise.all([
    Promise.resolve(evalWick(p, cfg.wickThreshold)),
    cfg.sessionGateEnabled ? evalSession(p, assetId, ts) : Promise.resolve({ pass: true }),
    Promise.resolve(evalCVD(p)),
  ]);

  const gates = [];
  if (cfg.wickGateEnabled    && !wickResult.pass)    gates.push(wickResult.blockedReason);
  if (cfg.sessionGateEnabled && !sessionResult.pass) gates.push(sessionResult.blockedReason);
  if (cfg.cvdGateEnabled     && !cvdResult.pass)     gates.push(cvdResult.blockedReason);

  const pass      = gates.length === 0;
  const blockedBy = gates.length ? gates.join(';') : null;

  // Quality tier aligned with gate results (not a green-flag count):
  //   A = all enabled gates pass AND full data present (highest confidence)
  //   B = all enabled gates pass BUT some data was missing (passes, less certain)
  //   C = exactly 1 enabled gate triggered (blocked)
  //   D = 2 or more enabled gates triggered (blocked)
  // This means Tier A/B always pass execution; Tier C/D always block it.
  const wickTriggered    = cfg.wickGateEnabled    && !wickResult.pass;
  const sessionTriggered = cfg.sessionGateEnabled && !sessionResult.pass;
  const cvdTriggered     = cfg.cvdGateEnabled     && !cvdResult.pass;
  const triggeredCount   = [wickTriggered, sessionTriggered, cvdTriggered].filter(Boolean).length;
  const hasAllData       = wickResult.hasBarData
                        && sessionResult.withPriorSession !== null
                        && cvdResult.hasCVDData;
  const qualityTier = triggeredCount >= 2 ? 'D'
                    : triggeredCount === 1 ? 'C'
                    : hasAllData           ? 'A'
                    : 'B';

  const quality = {
    pass,
    blockedBy,
    qualityTier,
    config: { wickGateEnabled: cfg.wickGateEnabled, sessionGateEnabled: cfg.sessionGateEnabled, cvdGateEnabled: cfg.cvdGateEnabled },
    wick:    { enabled: cfg.wickGateEnabled,    ...wickResult },
    session: { enabled: cfg.sessionGateEnabled, ...sessionResult },
    cvd:     { enabled: cfg.cvdGateEnabled,     ...cvdResult },
    ts,
    assetId,
    template:  p.template  || null,
    direction: p.direction || null,
  };

  // Store for recognition memory join
  if (dedupeKey) {
    try {
      const r = getRedis();
      if (r) {
        await r.set(SQ_KEY(dedupeKey), JSON.stringify(quality), { ex: SQ_TTL_SEC });
        const raw = await r.get(SQ_INDEX_KEY).catch(() => null);
        let idx = safeParse(raw);
        if (!Array.isArray(idx)) idx = [];
        idx = idx.filter(e => e.id !== dedupeKey);
        idx.unshift({ id: dedupeKey, ts, assetId, template: p.template, pass, qualityTier, blockedBy });
        await r.set(SQ_INDEX_KEY, JSON.stringify(idx.slice(0, SQ_INDEX_CAP)), { ex: SQ_TTL_SEC });
      }
    } catch (_) {}
  }

  return quality;
}

// ── Quality lookup for recognition memory ────────────────────────────────────
// Called by recognition-memory.js when storing a closed trade. Fuzzy-joins by
// assetId + template + timestamp window (±15 min) to find the quality record.

async function lookupQualityForTrade(assetId, template, openedAt) {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(SQ_INDEX_KEY).catch(() => null);
    const idx = safeParse(raw);
    if (!Array.isArray(idx)) return null;
    const match = idx.find(e =>
      e.assetId === assetId &&
      e.template === template &&
      Math.abs(e.ts - openedAt) < 900_000   // 15-min window
    );
    if (!match) return null;
    const recRaw = await r.get(SQ_KEY(match.id)).catch(() => null);
    return safeParse(recRaw) || null;
  } catch (_) { return null; }
}

module.exports = {
  evaluateSignalQuality,
  lookupQualityForTrade,
  getConfig,
  setConfig,
  SQ_CONFIG_KEY,
  SQ_KEY,
  SQ_INDEX_KEY,
};
