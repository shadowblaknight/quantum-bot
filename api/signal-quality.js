'use strict';
/* eslint-disable */
// api/signal-quality.js  v17.1
//
// LIVE signal-quality gate: evaluates three filters at execution time and
// blocks placements that fail. Previously these were shadow-only.
//
// Gates (each independently togglable via Redis config):
//   WICK    — block when signal bar wickRatio > threshold (default 0.50)
//             Data: heavy-wick trades = 0% WR across Jul 24-31 (0W/4L)
//   SESSION — v17: research-backed structural scoring. Pine sends structural
//             values (adrConsumed, gapAtr, ibSide, etc.); server scores
//             per-instrument. Grade BLOCK = hard reject. ADVERSE = soft
//             trigger, caps qualityTier at B. Pine not yet migrated → NEUTRAL
//             (pass, tier B max via scoreAvailable:false → hasAllData:false).
//   CVD     — block when CVD is low-trust AND shows counter-divergence
//             Data: lowTrust=true = 20% WR (1W/4L) across Jul 24-31
//
// Session score → grade:
//   ≥ 4   STRONG    pass — favorable structural context
//   2–3   FAVORABLE pass — mild positive context
//   0–1   NEUTRAL   pass — no strong signal either way
//  −1     WEAK      pass — noted but no tier penalty
//  −2,−3  ADVERSE   pass — but caps qualityTier at B
//  ≤ −4   BLOCK     fail — hard reject (all other gates irrelevant)
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

// Maps Pine script timeframe strings to MetaAPI format.
function normalizeTf(tf) {
  if (!tf) return null;
  const map = {
    '1':'1m','3':'3m','5':'5m','10':'10m','15':'15m','30':'30m','45':'45m',
    '60':'1h','120':'2h','180':'3h','240':'4h',
    'D':'1d','W':'1w','M':'1mn',
  };
  const s = String(tf).trim();
  return map[s] || (/^\d+[mhdwM]$/.test(s) ? s : null);
}

// Async so it can fall back to candle-source when the Pine alert omits OHLC.
async function evalWick(p, threshold, assetId, ts) {
  let o = parseFloat(p.barOpen),  h = parseFloat(p.barHigh);
  let l = parseFloat(p.barLow),   c = parseFloat(p.barClose);
  let hasBarData = [o, h, l, c].every(v => isFinite(v));
  let barSource = 'payload';

  // Fallback: fetch the signal bar from candle-source when payload lacks OHLC.
  // Uses the signal's own timeframe so we get the exact bar that triggered it.
  if (!hasBarData && assetId && (p.timeframe || p.tf)) {
    try {
      const { fetchCandles } = require('./candle-source');
      const tf = normalizeTf(p.timeframe || p.tf);
      if (tf) {
        const result = await withTimeout(fetchCandles(assetId, tf, 10), 5000, { candles: [] });
        const bars = (result && result.candles) || [];
        // Last bar whose open time is at or before the signal timestamp
        const bar = [...bars].reverse().find(b => new Date(b.time).getTime() <= ts);
        if (bar) {
          o = bar.open; h = bar.high; l = bar.low; c = bar.close;
          hasBarData = [o, h, l, c].every(v => isFinite(v));
          barSource = 'candle-source';
        }
      }
    } catch (_) {}
  }

  if (!hasBarData) return { pass: true, wickRatio: null, hasBarData: false };

  const range = h - l;
  if (range <= 0) return { pass: true, wickRatio: null, hasBarData: true, barSource };

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
    barSource,
    blockedReason: pass ? null : `wick-${(wickRatio*100).toFixed(0)}%>threshold(${(threshold*100).toFixed(0)}%)`,
  };
}

// ── Session context gate v2: structural scoring ───────────────────────────────
// Activated when Pine sends the new structural fields (adrConsumed, gapAtr, etc.).
// Each check adds/subtracts from sessionScore; final score maps to a grade.
//
// Research sources: arxiv 2605.04004 (MNQ falsification study), tradingstats.net
// (11yr IB data), nqstats.com (IB context +27-28pp edge), Lucey & Tully 2006
// (gold Monday weakness), Quantpedia/Gemini (BTC hourly seasonality),
// Sprott Money (gold 54yr London bias).

// Reversal/exhaustion templates benefit from high ADR — exhaustion is the edge.
// Momentum/continuation templates need room to run — high ADR is a headwind.
const REVERSAL_TEMPLATES = new Set([
  'reaction', 'reaction-fvg', 'reaction-ifvg',
  'gold-reaction',                // psych bounce — best at 90-100% ADR
]);
const SWEEP_TEMPLATES = new Set([
  'judas-swing', 'gold-judas',   // fires at London open while ADR still building
]);

function evalSessionStructural(p, assetId, dir) {
  const isLong = dir === 'LONG';
  let sessionScore = 0;
  const checks = [];
  const template = p.template || '';
  const isReversal = REVERSAL_TEMPLATES.has(template);
  const isSweep    = SWEEP_TEMPLATES.has(template);

  const adrConsumed = p.adrConsumed != null ? parseFloat(p.adrConsumed)    : null;
  const gapAtr      = p.gapAtr      != null ? parseFloat(p.gapAtr)         : null;
  const gapDir      = p.gapDir      != null ? parseInt(p.gapDir, 10)       : null;
  const priorDayPos = p.priorDayPos != null ? parseInt(p.priorDayPos, 10)  : null;
  const hourUtc     = p.hourUtc     != null ? parseInt(p.hourUtc, 10)      : null;
  const dayOfWeek   = p.dayOfWeek   != null ? parseInt(p.dayOfWeek, 10)    : null;
  // "null" string → Pine sends when IB is not yet complete; treat as absent
  const ibSide      = (p.ibSide && p.ibSide !== 'null') ? p.ibSide : null;
  // -1 → Pine sentinel for "IB not complete"; treat as absent
  const ibPosition  = (p.ibPosition != null && parseFloat(p.ibPosition) >= 0) ? parseFloat(p.ibPosition) : null;
  const first15mDir = p.first15mDir != null ? parseInt(p.first15mDir, 10)  : null;
  const nearKeyTime = p.nearKeyTime === true || p.nearKeyTime === 'true';

  // ── ADR consumed — template-aware scoring ────────────────────────────────
  // Reversal setups (psych, reaction-ifvg) BENEFIT from exhaustion — the liquidity grab
  // at 90-100% ADR is precisely the edge. Momentum/FVG setups need room to run.
  if (adrConsumed != null) {
    if (isReversal) {
      // High ADR = exhaustion = liquidity grab opportunity for reversal templates
      if (adrConsumed >= 0.90 && adrConsumed < 1.50) {
        sessionScore += 2; checks.push({ name: 'adr-exhaustion-reversal', delta: +2, v: adrConsumed });
      } else if (adrConsumed >= 0.75) {
        sessionScore += 1; checks.push({ name: 'adr-highprob-reversal', delta: +1, v: adrConsumed });
      } else if (adrConsumed < 0.40) {
        sessionScore -= 1; checks.push({ name: 'adr-fresh-reversal', delta: -1, v: adrConsumed });
      }
      // News extension (150%+) and outlier (250%+) are neutral for reversals — Pine already blocked or allowed
    } else if (isSweep) {
      // Sweep templates fire at London open while ADR is still building — neutral at high ADR
      if (adrConsumed < 0.40) {
        sessionScore += 1; checks.push({ name: 'adr-room', delta: +1, v: adrConsumed });
      }
      // No penalty — Pine gate already blocked judas above 90%
    } else {
      // Momentum/FVG/continuation: needs room, penalise high ADR
      if (adrConsumed < 0.40) {
        sessionScore += 1; checks.push({ name: 'adr-room',      delta: +1, v: adrConsumed });
      } else if (adrConsumed > 0.85) {
        sessionScore -= 2; checks.push({ name: 'adr-exhausted', delta: -2, v: adrConsumed });
      } else if (adrConsumed > 0.70) {
        sessionScore -= 1; checks.push({ name: 'adr-tight',     delta: -1, v: adrConsumed });
      }
    }
  }

  // ── Universal: prior day structural position ──────────────────────────────
  if (priorDayPos != null) {
    const aligned = isLong ? priorDayPos > 0 : priorDayPos < 0;
    const against = isLong ? priorDayPos < 0 : priorDayPos > 0;
    if (aligned)      { sessionScore += 1; checks.push({ name: 'prior-day-aligned', delta: +1, v: priorDayPos }); }
    else if (against) { sessionScore -= 1; checks.push({ name: 'prior-day-against', delta: -1, v: priorDayPos }); }
  }

  // ── Gold-specific ─────────────────────────────────────────────────────────
  if (assetId === 'gold') {
    if (nearKeyTime) {
      // LBMA AM fix (10:30 GMT) or COMEX open (13:30 UTC) — institutional liquidity windows
      sessionScore += 1; checks.push({ name: 'gold-key-time', delta: +1 });
    }
    if (dayOfWeek === 1) {
      // Lucey & Tully (2006): GARCH-confirmed Monday gold weakness
      sessionScore -= 1; checks.push({ name: 'gold-monday', delta: -1 });
    }
    // Gold daytime exhaustion applies to momentum templates only — reversals thrive at exhaustion
    if (!isReversal && adrConsumed != null && adrConsumed > 0.85) {
      // 54-yr structural pattern (Sprott Money): London/NY is distribution window for gold
      sessionScore -= 1; checks.push({ name: 'gold-daytime-exhaustion', delta: -1, v: adrConsumed });
    }
  }

  // ── Indices: NAS100 / US500 ───────────────────────────────────────────────
  if (assetId === 'nas100' || assetId === 'us500') {
    // Gap size vs ATR — most robustly quantified index signal (tradingstats.net, 2791 NQ days)
    if (gapAtr != null && gapDir != null) {
      if (gapAtr > 1.2) {
        // Large gap (>1.2x ATR): 80%+ continue in gap direction
        const delta = gapDir === 1 ? +2 : -2;
        sessionScore += delta;
        checks.push({ name: gapDir === 1 ? 'large-gap-aligned' : 'large-gap-against', delta, v: gapAtr });
      } else if (gapAtr < 0.3) {
        // Tiny gap (<0.3x ATR): 77-90% fill → fill moves AGAINST gap direction
        // gap opposite signal → fill moves toward signal (+1); gap with signal → fill against (-1)
        const delta = gapDir === -1 ? +1 : gapDir === 1 ? -1 : 0;
        if (delta !== 0) checks.push({ name: delta > 0 ? 'small-gap-fill-aligned' : 'small-gap-fill-against', delta, v: gapAtr });
        sessionScore += delta;
      }
    }

    // IB context: close above IB mid + low first → 74% → 84% IB high breaks (nqstats.com, 10yr)
    if (ibSide != null && ibPosition != null) {
      const ibAligned = (isLong  && ibSide === 'low_first'  && ibPosition > 0.5)
                     || (!isLong && ibSide === 'high_first' && ibPosition < 0.5);
      const ibAgainst = (isLong  && ibSide === 'high_first')
                     || (!isLong && ibSide === 'low_first');
      if (ibAligned)      { sessionScore += 2; checks.push({ name: 'ib-aligned', delta: +2, ibSide, ibPosition }); }
      else if (ibAgainst) { sessionScore -= 1; checks.push({ name: 'ib-against', delta: -1, ibSide, ibPosition }); }
      else                { checks.push({ name: 'ib-neutral', delta: 0, ibSide, ibPosition }); }
    }

    // First 15-min candle direction: 70% predictive for day close (tradethatswing.com)
    if (first15mDir != null && first15mDir !== 0) {
      const aligned = (isLong && first15mDir === 1) || (!isLong && first15mDir === -1);
      const delta = aligned ? +1 : -1;
      sessionScore += delta;
      checks.push({ name: aligned ? 'first15m-aligned' : 'first15m-against', delta, v: first15mDir });
    }
  }

  // ── BTC-specific ──────────────────────────────────────────────────────────
  if (assetId === 'btc') {
    if (dayOfWeek === 1) {
      // Monday: consistently best day (multiple academic papers)
      sessionScore += 1; checks.push({ name: 'btc-monday', delta: +1 });
    } else if (dayOfWeek === 0 || dayOfWeek === 4) {
      // Sunday / Thursday: worst days (ScienceDirect, multiple studies)
      sessionScore -= 1; checks.push({ name: 'btc-weak-day', delta: -1, v: dayOfWeek });
    }
    if (hourUtc === 22 || hourUtc === 23) {
      // Quantpedia / Gemini 2015-2022: 40.6% annualised edge, highest of any hour
      sessionScore += 1; checks.push({ name: 'btc-peak-hour', delta: +1, v: hourUtc });
    } else if (hourUtc === 3 || hourUtc === 4) {
      // Documented weakest window (same dataset)
      sessionScore -= 1; checks.push({ name: 'btc-weak-hour', delta: -1, v: hourUtc });
    }
  }

  // ── Score → grade ─────────────────────────────────────────────────────────
  const grade = sessionScore >= 4   ? 'STRONG'
              : sessionScore >= 2   ? 'FAVORABLE'
              : sessionScore >= 0   ? 'NEUTRAL'
              : sessionScore === -1 ? 'WEAK'
              : sessionScore >= -3  ? 'ADVERSE'
              :                      'BLOCK';

  const pass = grade !== 'BLOCK';
  const adverseChecks = checks.filter(c => c.delta < 0).map(c => c.name);

  return {
    pass,
    grade,
    sessionScore,
    checks,
    scoreAvailable: true,
    withPriorSession: null,    // deprecated — kept for schema compat
    asianPosition:   null,
    liqCoincidence:  false,
    nearestLevel:    null,
    londonDirection: null,
    distATR:         null,
    blockedReason: !pass
      ? `session-block(score=${sessionScore},checks=${adverseChecks.join(',')})`
      : null,
    adverseReason: grade === 'ADVERSE'
      ? `session-adverse(score=${sessionScore},checks=${adverseChecks.join(',')})`
      : null,
  };
}

// withTimeout is used by evalWick's candle fallback — keep it.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function evalSession(p, assetId) {
  const dir = p.direction;

  // Structural path — Pine sends the new fields (adrConsumed / gapAtr / priorDayPos).
  if (p.adrConsumed != null || p.gapAtr != null || p.priorDayPos != null) {
    return evalSessionStructural(p, assetId, dir);
  }

  // Pine script not yet updated to Phase 2 payload — pass with neutral grade.
  // scoreAvailable: false → hasAllData = false → tier caps at B (never A).
  return {
    pass: true, grade: 'NEUTRAL', sessionScore: 0, checks: [],
    scoreAvailable: false, withPriorSession: null, asianPosition: null,
    liqCoincidence: false, nearestLevel: null, londonDirection: null, distATR: null,
    blockedReason: null, adverseReason: null, reason: 'pine-not-migrated',
  };
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
    evalWick(p, cfg.wickThreshold, assetId, ts),
    cfg.sessionGateEnabled ? evalSession(p, assetId) : Promise.resolve({ pass: true }),
    Promise.resolve(evalCVD(p)),
  ]);

  // Hard triggers — block execution
  const gates = [];
  if (cfg.wickGateEnabled    && !wickResult.pass)    gates.push(wickResult.blockedReason);
  if (cfg.sessionGateEnabled && !sessionResult.pass) gates.push(sessionResult.blockedReason);
  if (cfg.cvdGateEnabled     && !cvdResult.pass)     gates.push(cvdResult.blockedReason);

  const pass      = gates.length === 0;
  const blockedBy = gates.length ? gates.join(';') : null;

  // Soft adverse context — passes but reduces tier
  const sessionGrade       = (sessionResult && sessionResult.grade) || null;
  const sessionSoftTrigger = cfg.sessionGateEnabled && sessionGrade === 'ADVERSE';
  const adverseReasons     = [];
  if (sessionSoftTrigger && sessionResult.adverseReason) adverseReasons.push(sessionResult.adverseReason);
  const adverseBy = adverseReasons.length ? adverseReasons.join(';') : null;

  // Quality tier:
  //   A = all hard gates pass + full data present + no ADVERSE context
  //   B = all hard gates pass + (data missing OR ADVERSE session context)
  //   C = exactly 1 hard gate triggered
  //   D = 2 or more hard gates triggered
  // Tier A/B always pass execution; Tier C/D always block it.
  // ADVERSE session grade caps tier at B — signal is allowed but flagged as low-confidence.
  const wickTriggered    = cfg.wickGateEnabled    && !wickResult.pass;
  const sessionTriggered = cfg.sessionGateEnabled && !sessionResult.pass;
  const cvdTriggered     = cfg.cvdGateEnabled     && !cvdResult.pass;
  const triggeredCount   = [wickTriggered, sessionTriggered, cvdTriggered].filter(Boolean).length;
  const hasAllData       = wickResult.hasBarData
                        && (sessionResult.scoreAvailable === true || sessionResult.withPriorSession !== null)
                        && cvdResult.hasCVDData;
  const qualityTier = triggeredCount >= 2  ? 'D'
                    : triggeredCount === 1  ? 'C'
                    : sessionSoftTrigger    ? 'B'   // ADVERSE: cannot reach Tier A
                    : hasAllData            ? 'A'
                    : 'B';

  const quality = {
    pass,
    blockedBy,
    adverseBy,
    qualityTier,
    sessionGrade,
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
        idx.unshift({ id: dedupeKey, ts, assetId, template: p.template, pass, qualityTier, blockedBy, adverseBy, sessionGrade });
        await r.set(SQ_INDEX_KEY, JSON.stringify(idx.slice(0, SQ_INDEX_CAP)), { ex: SQ_TTL_SEC });
      }
    } catch (_) {}
  }

  return quality;
}

// ── Quality lookup for recognition memory ────────────────────────────────────
// Called by recognition-memory.js when storing a closed trade.
// Tries direct lookup by dedupeKey first (exact, no timing issues — works for
// limit orders that fill hours after the signal). Falls back to the ±15-min
// fuzzy timestamp join for older trades that predate dedupeKey propagation.

async function lookupQualityForTrade(assetId, template, openedAt, dedupeKey = null) {
  const r = getRedis();
  if (!r) return null;
  try {
    if (dedupeKey) {
      const direct = safeParse(await r.get(SQ_KEY(dedupeKey)).catch(() => null));
      if (direct) return { ...direct, _dedupeKey: dedupeKey };
    }
    const raw = await r.get(SQ_INDEX_KEY).catch(() => null);
    const idx = safeParse(raw);
    if (!Array.isArray(idx)) return null;
    // When template is null (reconstructed trade), skip template filter — asset + time window
    // is unambiguous since only one position per asset is allowed at a time.
    const match = idx.find(e =>
      e.assetId === assetId &&
      (template == null || e.template === template) &&
      Math.abs(e.ts - openedAt) < 900_000   // 15-min window (fallback)
    );
    if (!match) return null;
    const recRaw = await r.get(SQ_KEY(match.id)).catch(() => null);
    const rec = safeParse(recRaw);
    if (!rec) return null;
    // Attach index metadata so callers can retrieve template + dedupeKey
    return { ...rec, _template: match.template, _dedupeKey: match.id };
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
