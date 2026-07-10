/* eslint-disable */
// api/regime-detector.js — Phase 1 Regime Detector (SHADOW MODE)
//
// PURPOSE: classify market conditions per incoming signal and record what the
// detector WOULD do — WITHOUT changing any execution.  The shadow log is read
// back via ?action=shadow-summary to validate the detector against real ledger
// outcomes before Phase 2 (actual gating) is built.
//
// ARCHITECTURE:
//   assessRegime({ assetId, template, nowTs }) → classification + intended action
//   writeShadowLog(...)                        → Redis v14:regime:shadow:{signalId}
//   HTTP handler                               → ?action=shadow-summary
//
// DATA SOURCES:
//   News    → getNewsContext() (news-context.js) via FF calendar (cached 1h, no key)
//   Macro   → VIX from FRED series VIXCLS (daily cache, key in FRED_KEY const)
//   Inst.   → per-asset ATR + range ratio via candle-source.js (MetaAPI)
//
// NOTE: market-regime.js (NORMAL/ELEVATED/CRISIS, sizeMult/slWiden) is a separate
// system and is UNTOUCHED. This module focuses on REGIME CLASSIFICATION for
// template-level gating, which is a different layer.
// ─────────────────────────────────────────────────────────────────────────────

const { getRedis, safeParse, atr } = require('./_lib');

// ═══════════════════════════════════════════════════════════════════════
//  EDITABLE CONFIG — tune these without touching logic
// ═══════════════════════════════════════════════════════════════════════

// Template → category. Category drives the action lookup in REGIME_ACTIONS.
// Add new templates here; default is 'continuation' if unmapped.
const TEMPLATE_CATEGORY = {
  'orb':              'breakout',
  'orb-pro':          'breakout',
  'silver-bullet':    'breakout',
  'unicorn':          'breakout',
  'turtle-soup':      'reversal',
  'judas-swing':      'reversal',
  'reaction':         'reversal',
  'reaction-fvg':     'reversal',
  'reaction-ifvg':    'reversal',
  'am-ifvg':          'reversal',
  'ote-continuation': 'continuation',
};

// Regime → category → { wouldAction, wouldSizeMult }
// wouldAction: 'allow' | 'cut-size' | 'skip' | 'block'
// wouldSizeMult: 0.0 = would not trade; 0.5 = would trade half size; 1.0 = full size
const REGIME_ACTIONS = {
  'NEWS-BLOCKED': {
    breakout:     { wouldAction: 'block',    wouldSizeMult: 0 },
    reversal:     { wouldAction: 'block',    wouldSizeMult: 0 },
    continuation: { wouldAction: 'block',    wouldSizeMult: 0 },
    default:      { wouldAction: 'block',    wouldSizeMult: 0 },
  },
  'ERRATIC': {
    breakout:     { wouldAction: 'skip',     wouldSizeMult: 0   },
    reversal:     { wouldAction: 'cut-size', wouldSizeMult: 0.5 },
    continuation: { wouldAction: 'cut-size', wouldSizeMult: 0.5 },
    default:      { wouldAction: 'cut-size', wouldSizeMult: 0.5 },
  },
  'CHOPPY': {
    breakout:     { wouldAction: 'skip',  wouldSizeMult: 0   },
    reversal:     { wouldAction: 'allow', wouldSizeMult: 1.0 },
    continuation: { wouldAction: 'allow', wouldSizeMult: 1.0 },
    default:      { wouldAction: 'allow', wouldSizeMult: 1.0 },
  },
  'TRENDING': {
    breakout:     { wouldAction: 'allow', wouldSizeMult: 1.0 },
    reversal:     { wouldAction: 'allow', wouldSizeMult: 1.0 },
    continuation: { wouldAction: 'allow', wouldSizeMult: 1.0 },
    default:      { wouldAction: 'allow', wouldSizeMult: 1.0 },
  },
  'NORMAL': {
    default:      { wouldAction: 'allow', wouldSizeMult: 1.0 },
  },
};

// Vol thresholds — all tunable
const THRESHOLDS = {
  vix: { calm: 15, stressed: 20 },           // calm < 15 ≤ normal ≤ 20 < stressed
  atrRatio: { narrow: 0.70, wide: 1.80 },    // ratio of recent 20-bar ATR vs 80-bar ATR
  rangeRatio: { narrow: 0.50, wide: 2.00 },  // last bar range vs 20-bar avg range
};

// ═══════════════════════════════════════════════════════════════════════
//  STORAGE KEYS
// ═══════════════════════════════════════════════════════════════════════

const SHADOW_KEY       = (id) => `v14:regime:shadow:${id}`;
const SHADOW_INDEX_KEY = 'v14:regime:shadow:index';
const SHADOW_INDEX_CAP = 2000;
const SHADOW_TTL_SEC   = 90 * 24 * 3600; // 90 days — long enough to cross-ref ledger

const VIX_CACHE_KEY    = 'v14:regime:vix:cache';
const VIX_CACHE_TTL_SEC = 24 * 3600; // one FRED pull per day is plenty

const LEDGER_TRADE_KEY = (id) => `v14:ledger:trade:${id}`;
const LEDGER_INDEX_KEY = 'v14:ledger:index';

// FRED key is public (free tier, no credential). VIXCLS = CBOE Volatility Index (daily).
// limit=5 so weekends/holidays where value='.' don't leave us with nothing.
const FRED_VIX_URL = 'https://api.stlouisfed.org/fred/series/observations'
  + '?series_id=VIXCLS&api_key=6ea866d906a96ca293231d54a2746251'
  + '&sort_order=desc&limit=5&file_type=json';

// ═══════════════════════════════════════════════════════════════════════
//  SHARED HELPER
// ═══════════════════════════════════════════════════════════════════════

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════
//  SIGNAL A — NEWS STATE
// ═══════════════════════════════════════════════════════════════════════
// Maps news-context.js state → 'imminent' | 'near' | 'clear'.
//   imminent : event ≤30min (live or scheduled within 30min)  → NEWS-BLOCKED
//   near     : event 30–60min out                             → noted in reasons, not blocking
//   clear    : nothing within 60min

async function getNewsState(assetId) {
  try {
    const { getNewsContext } = require('./news-context');
    const ctx = await withTimeout(getNewsContext(assetId), 2000, null);
    if (!ctx) return 'clear';

    if (ctx.state === 'live' || ctx.state === 'imminent') return 'imminent';

    if (ctx.state === 'scheduled') {
      // Check if any scheduled (>30min) event is within the 60min near-window
      const events = (ctx.events && ctx.events.today) || [];
      const nearEvent = events.find((e) => e.minsUntil != null && e.minsUntil <= 60);
      return nearEvent ? 'near' : 'clear';
    }

    return 'clear';
  } catch (_) {
    return 'clear'; // safest fallback — don't block on news fetch failure
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  SIGNAL B — MACRO VOL (VIX)
// ═══════════════════════════════════════════════════════════════════════
// Cached daily. Falls back gracefully when FRED is unreachable.

async function getVixCached() {
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(VIX_CACHE_KEY);
      const cached = safeParse(raw);
      if (cached && cached.vix != null && cached.ts &&
          (Date.now() - cached.ts) < VIX_CACHE_TTL_SEC * 1000) {
        return { vix: cached.vix, date: cached.date, source: 'cache' };
      }
    } catch (_) {}
  }

  // Fetch fresh from FRED
  try {
    const res = await withTimeout(fetch(FRED_VIX_URL).then((r) => r.json()), 4000, null);
    if (!res || !Array.isArray(res.observations)) return null;

    // Most-recent non-missing observation (VIXCLS is '.' on non-trading days)
    const obs = res.observations.find((o) => o.value && o.value !== '.');
    if (!obs) return null;

    const vix = parseFloat(obs.value);
    if (!isFinite(vix)) return null;

    if (redis) {
      try {
        await redis.set(VIX_CACHE_KEY,
          JSON.stringify({ vix, date: obs.date, ts: Date.now() }),
          { ex: VIX_CACHE_TTL_SEC });
      } catch (_) {}
    }
    return { vix, date: obs.date, source: 'fred' };
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  SIGNAL C — INSTRUMENT VOL
// ═══════════════════════════════════════════════════════════════════════
// atrRatio  = recent 20-bar ATR(14) / baseline 80-bar ATR(14)
//             > THRESHOLDS.atrRatio.wide  → expanding (erratic)
//             < THRESHOLDS.atrRatio.narrow → contracting (choppy)
// rangeRatio = last bar range / avg range of prior 20 bars
//             > THRESHOLDS.rangeRatio.wide → spike (erratic)
//             < THRESHOLDS.rangeRatio.narrow → inside-bar territory (choppy)

async function getInstrumentVol(assetId) {
  let fetchCandles;
  try { ({ fetchCandles } = require('./candle-source')); } catch (_) {
    return { atrRatio: null, rangeRatio: null, label: 'unknown', reason: 'candle-source-unavailable' };
  }

  try {
    const result = await withTimeout(fetchCandles(assetId, '5m', 100), 2000, null);
    const candles = result && result.candles ? result.candles : null;
    if (!candles || candles.length < 40) {
      return { atrRatio: null, rangeRatio: null, label: 'unknown', reason: 'insufficient-candles' };
    }

    // ATR ratio: recent 20 bars vs baseline 80 bars (Wilder from _lib)
    const recentATR   = atr(candles.slice(-20), 14);
    const baselineATR = atr(candles.slice(-80), 14);
    const atrRatio    = (recentATR && baselineATR && baselineATR > 0)
      ? recentATR / baselineATR : null;

    // Range ratio: last bar range vs 20-bar average range
    const recent20   = candles.slice(-21, -1); // prior 20, not the current bar
    const avgRange   = recent20.length > 0
      ? recent20.reduce((s, c) => s + (c.high - c.low), 0) / recent20.length
      : 0;
    const lastBar    = candles[candles.length - 1];
    const lastRange  = lastBar.high - lastBar.low;
    const rangeRatio = (avgRange > 0 && isFinite(lastRange)) ? lastRange / avgRange : null;

    // Classify
    const { narrow: aN, wide: aW } = THRESHOLDS.atrRatio;
    const { narrow: rN, wide: rW } = THRESHOLDS.rangeRatio;
    let label = 'normal';
    if ((atrRatio != null && atrRatio > aW) || (rangeRatio != null && rangeRatio > rW)) {
      label = 'wide';
    } else if ((atrRatio != null && atrRatio < aN) || (rangeRatio != null && rangeRatio < rN)) {
      label = 'narrow';
    }

    return {
      atrRatio:   atrRatio   != null ? +atrRatio.toFixed(2)   : null,
      rangeRatio: rangeRatio != null ? +rangeRatio.toFixed(2) : null,
      label,
    };
  } catch (_) {
    return { atrRatio: null, rangeRatio: null, label: 'unknown', reason: 'fetch-error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  COMBINE → REGIME LABEL
// ═══════════════════════════════════════════════════════════════════════
// Priority order (highest wins):
//   1. NEWS-BLOCKED  — event ≤30min; overrides everything
//   2. ERRATIC       — VIX stressed OR vol spiking; something is moving dangerously
//   3. CHOPPY        — VIX calm AND vol contracting AND no catalyst; grind risk
//   4. TRENDING      — VIX normal AND vol expanding (confirming direction)
//   5. NORMAL        — default when no signal is clear

function classifyRegime({ newsState, vixData, instrumentVol }) {
  const reasons = [];
  const vix  = vixData ? vixData.vix : null;

  const { calm: vCalm, stressed: vStressed } = THRESHOLDS.vix;
  const macroVol = vix == null ? 'unknown'
    : vix < vCalm    ? 'calm'
    : vix <= vStressed ? 'normal'
    :                    'stressed';

  // 1. NEWS-BLOCKED
  if (newsState === 'imminent') {
    reasons.push('high-impact economic event ≤30min');
    return { regime: 'NEWS-BLOCKED', macroVol, reasons };
  }
  if (newsState === 'near') {
    reasons.push(`high-impact event 30–60min out${vixData ? '' : ''}`);
    // "near" doesn't change regime — just shows up in reasons
  }

  const iv = instrumentVol || {};
  const ivWide   = iv.label === 'wide';
  const ivNarrow = iv.label === 'narrow';

  // 2. ERRATIC
  if (macroVol === 'stressed' || ivWide) {
    if (macroVol === 'stressed') reasons.push(`VIX ${vix.toFixed(1)} > ${vStressed} (macro stressed)`);
    if (ivWide) {
      if (iv.atrRatio != null && iv.atrRatio > THRESHOLDS.atrRatio.wide)
        reasons.push(`ATR ratio ${iv.atrRatio}× (vol expanding fast)`);
      if (iv.rangeRatio != null && iv.rangeRatio > THRESHOLDS.rangeRatio.wide)
        reasons.push(`range ratio ${iv.rangeRatio}× (spike bar)`);
    }
    return { regime: 'ERRATIC', macroVol, reasons };
  }

  // 3. CHOPPY — calm macro OR contracting vol, no catalyst
  if ((macroVol === 'calm' || ivNarrow) && newsState === 'clear') {
    if (macroVol === 'calm') reasons.push(`VIX ${vix != null ? vix.toFixed(1) : '?'} < ${vCalm} (market calm)`);
    if (ivNarrow) {
      if (iv.atrRatio != null) reasons.push(`ATR ratio ${iv.atrRatio}× (vol contracting)`);
      if (iv.rangeRatio != null && iv.rangeRatio < THRESHOLDS.rangeRatio.narrow)
        reasons.push(`range ratio ${iv.rangeRatio}× (inside/narrow bar)`);
    }
    return { regime: 'CHOPPY', macroVol, reasons };
  }

  // 4. TRENDING — normal macro, vol steady to rising, no extreme
  const ivNormal = iv.label === 'normal' || iv.label === 'unknown';
  const normalMacro = macroVol === 'normal';
  if (normalMacro || (ivNormal && macroVol !== 'unknown')) {
    if (normalMacro && vix != null)
      reasons.push(`VIX ${vix.toFixed(1)} (${vCalm}–${vStressed} range)`);
    if (ivNormal && iv.atrRatio != null)
      reasons.push(`ATR ratio ${iv.atrRatio}× (vol steady)`);
    return { regime: 'TRENDING', macroVol, reasons };
  }

  // 5. NORMAL — fallback
  reasons.push('no extreme signals — default regime');
  return { regime: 'NORMAL', macroVol, reasons };
}

// ═══════════════════════════════════════════════════════════════════════
//  ACTION LOOKUP
// ═══════════════════════════════════════════════════════════════════════

function getWouldAction(regime, template) {
  const category = TEMPLATE_CATEGORY[template] || 'continuation';
  const regimeMap = REGIME_ACTIONS[regime] || REGIME_ACTIONS['NORMAL'];
  return regimeMap[category] || regimeMap['default'] || { wouldAction: 'allow', wouldSizeMult: 1.0 };
}

// ═══════════════════════════════════════════════════════════════════════
//  PUBLIC: assessRegime
// ═══════════════════════════════════════════════════════════════════════
// Called from webhook.js processSignalBackground (shadow only, Phase 1).
// All three signals are fetched in parallel — total latency is bounded
// by the slowest of the three (instrument vol from MetaAPI, ~1–2s warm cache).

async function assessRegime({ assetId, template, nowTs = Date.now() }) {
  const [newsState, vixData, instrumentVol] = await Promise.all([
    getNewsState(assetId),
    getVixCached(),
    getInstrumentVol(assetId),
  ]);

  const { regime, macroVol, reasons } = classifyRegime({ newsState, vixData, instrumentVol });
  const { wouldAction, wouldSizeMult } = getWouldAction(regime, template);

  return {
    regime,
    newsState,
    macroVol,
    vix: vixData ? vixData.vix : null,
    vixDate: vixData ? vixData.date : null,
    instrumentVol,
    wouldAction,
    wouldSizeMult,
    reasons,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  PUBLIC: writeShadowLog
// ═══════════════════════════════════════════════════════════════════════
// Writes one record + maintains the index. Fire-and-forget safe (never throws).

async function writeShadowLog({ signalId, assetId, template, direction, ts,
    regime, newsState, macroVol, vix, vixDate, instrumentVol,
    wouldAction, wouldSizeMult, reasons }) {
  const redis = getRedis();
  if (!redis) return;

  const record = {
    signalId, assetId, template, direction, ts,
    regime, newsState, macroVol, vix, vixDate,
    instrumentVol, wouldAction, wouldSizeMult, reasons,
    actualAction: 'traded-normally', // Phase 1: always — changed in Phase 2
    loggedAt: Date.now(),
  };

  try {
    await redis.set(SHADOW_KEY(signalId), JSON.stringify(record), { ex: SHADOW_TTL_SEC });

    // Maintain sorted index (newest first, capped)
    const indexRaw = await redis.get(SHADOW_INDEX_KEY).catch(() => null);
    const index = safeParse(indexRaw) || [];
    const next = index.filter((e) => e.signalId !== signalId);
    next.push({ signalId, ts, assetId, template, direction, regime, wouldAction });
    next.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    await redis.set(SHADOW_INDEX_KEY, JSON.stringify(next.slice(0, SHADOW_INDEX_CAP)));
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
//  SHADOW-SUMMARY: cross-reference shadow log with ledger outcomes
// ═══════════════════════════════════════════════════════════════════════
// For each regime label, shows:
//   • how many signals were tagged
//   • for each would-action (block/skip/cut-size/allow):
//       – matched ledger trades (within 15-min window by asset+template+direction+time)
//       – actual P&L of those trades
//
// This is the Phase 1 validation view: "CHOPPY→skip-ORB: 8 trades, net -$45.20 —
// detector would have saved this."

async function computeShadowSummary({ since, until } = {}) {
  const redis = getRedis();
  if (!redis) return { error: 'redis-unavailable' };

  const sinceMs = since ? new Date(since).getTime() : Date.now() - 30 * 24 * 3600 * 1000;
  const untilMs = until ? new Date(until).getTime() : Date.now();

  // 1. Shadow index + filter to period
  const shadowIndexRaw = await redis.get(SHADOW_INDEX_KEY).catch(() => null);
  const shadowIndex = (safeParse(shadowIndexRaw) || [])
    .filter((e) => (e.ts || 0) >= sinceMs && (e.ts || 0) <= untilMs);

  if (!shadowIndex.length) {
    return {
      ok: true,
      period: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
      totalShadowed: 0, matchedToLedger: 0, byRegime: [],
      note: 'no shadow records yet — records accumulate as live signals arrive',
    };
  }

  // 2. Batch-fetch shadow records
  const shadowPipe = redis.pipeline();
  for (const e of shadowIndex) shadowPipe.get(SHADOW_KEY(e.signalId));
  const shadowRaws = await shadowPipe.exec().catch(() => []);
  const shadowRecords = shadowRaws
    .map((raw) => {
      const v = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
      return (v && typeof v === 'object') ? v : null;
    })
    .filter(Boolean);

  // 3. Ledger index + batch-fetch trades in a wider window for matching
  const ledgerIndexRaw = await redis.get(LEDGER_INDEX_KEY).catch(() => null);
  const ledgerSlice = (safeParse(ledgerIndexRaw) || []).filter((e) => {
    const t = e.closedAt ? new Date(e.closedAt).getTime() : 0;
    return t >= sinceMs - 60 * 60 * 1000 && t <= untilMs + 4 * 60 * 60 * 1000;
  });

  const ledgerPipe = redis.pipeline();
  for (const e of ledgerSlice) ledgerPipe.get(LEDGER_TRADE_KEY(e.id));
  const ledgerRaws = await ledgerPipe.exec().catch(() => []);
  const ledgerRecords = ledgerRaws
    .map((raw) => {
      const v = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
      return (v && typeof v === 'object') ? v : null;
    })
    .filter(Boolean);

  // 4. Match each shadow record to a ledger trade (asset + template + direction + ±15min)
  const MATCH_WINDOW_MS = 15 * 60 * 1000;
  const paired = shadowRecords.map((sr) => {
    const signalTs = sr.ts || 0;
    const match = ledgerRecords.find((lr) =>
      lr.asset === sr.assetId &&
      lr.template === sr.template &&
      lr.direction === sr.direction &&
      lr.openedAt &&
      Math.abs(new Date(lr.openedAt).getTime() - signalTs) < MATCH_WINDOW_MS
    );
    return { shadow: sr, ledger: match || null };
  });

  // 5. Group by regime × wouldAction and aggregate P&L
  const byRegime = {};
  for (const { shadow: sr, ledger: lr } of paired) {
    const rk = sr.regime || 'UNKNOWN';
    if (!byRegime[rk]) byRegime[rk] = {
      regime: rk, signals: 0, matchedToLedger: 0, byAction: {},
    };
    const g = byRegime[rk];
    g.signals++;

    const wa = sr.wouldAction || 'allow';
    if (!g.byAction[wa]) g.byAction[wa] = {
      wouldAction: wa, signals: 0,
      matchedCount: 0, netPnl: 0, wins: 0, losses: 0, breakevens: 0,
    };
    const ag = g.byAction[wa];
    ag.signals++;

    if (lr) {
      g.matchedToLedger++;
      ag.matchedCount++;
      ag.netPnl  += lr.netPnl || 0;
      if (lr.outcome === 'WIN')       ag.wins++;
      else if (lr.outcome === 'LOSS') ag.losses++;
      else                            ag.breakevens++;
    }
  }

  // Round P&L values for display
  for (const g of Object.values(byRegime)) {
    for (const ag of Object.values(g.byAction)) {
      ag.netPnl = Math.round(ag.netPnl * 100) / 100;
    }
    // Summary: "would have saved" = net P&L of skipped/blocked trades (negative = good save)
    const gated = Object.values(g.byAction).filter((a) =>
      a.wouldAction === 'block' || a.wouldAction === 'skip'
    );
    g.gatedNetPnl     = Math.round(gated.reduce((s, a) => s + a.netPnl, 0) * 100) / 100;
    g.gatedTrades     = gated.reduce((s, a) => s + a.matchedCount, 0);
    g.detectorWouldHaveSaved = g.gatedNetPnl < 0
      ? Math.abs(g.gatedNetPnl)  // negative P&L on gated trades = money saved
      : -g.gatedNetPnl;           // positive P&L on gated trades = money missed
  }

  const totalMatched = paired.filter((p) => p.ledger).length;

  return {
    ok: true,
    period: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    totalShadowed: shadowRecords.length,
    matchedToLedger: totalMatched,
    unmatchedNote: totalMatched < shadowRecords.length
      ? `${shadowRecords.length - totalMatched} shadow records have no matching ledger trade yet (trade may be open, or opened >15min after signal)`
      : null,
    byRegime: Object.values(byRegime).sort((a, b) => b.signals - a.signals),
    howToRead: {
      gatedNetPnl:              'net P&L of trades detector would have blocked/skipped',
      detectorWouldHaveSaved:   '>0 = detector saves this much; <0 = detector would have missed profits',
      byAction:                 'breakdown by what the detector would have done for each template category',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  HTTP HANDLER  (/api/regime-detector)
// ═══════════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q      = (req.query && typeof req.query === 'object') ? req.query : {};
  const action = String(q.action || 'shadow-summary');

  try {
    if (action === 'shadow-summary') {
      const summary = await computeShadowSummary({
        since: q.since ? String(q.since) : undefined,
        until: q.until ? String(q.until) : undefined,
      });
      return res.status(200).json(summary);
    }

    if (action === 'assess') {
      // Ad-hoc probe: ?action=assess&asset=gold&template=orb
      const assetId  = String(q.asset  || '');
      const template = String(q.template || 'orb');
      if (!assetId) return res.status(400).json({ error: 'asset required' });
      const result = await assessRegime({ assetId, template, nowTs: Date.now() });
      return res.status(200).json({ ok: true, ...result });
    }

    if (action === 'vix') {
      // Quick VIX probe — useful for confirming FRED fetch works
      const data = await getVixCached();
      return res.status(200).json({ ok: true, vixData: data });
    }

    if (action === 'thresholds') {
      // Expose current thresholds + action map for dashboard display
      return res.status(200).json({
        ok: true,
        THRESHOLDS,
        TEMPLATE_CATEGORY,
        REGIME_ACTIONS,
      });
    }

    return res.status(400).json({
      error: 'unknown action',
      valid: ['shadow-summary', 'assess', 'vix', 'thresholds'],
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || 'regime-detector-error' });
  }
};

module.exports.assessRegime   = assessRegime;
module.exports.writeShadowLog = writeShadowLog;
module.exports.computeShadowSummary = computeShadowSummary;
module.exports.getVixCached   = getVixCached;
module.exports.REGIME_ACTIONS = REGIME_ACTIONS;
module.exports.TEMPLATE_CATEGORY = TEMPLATE_CATEGORY;
module.exports.THRESHOLDS     = THRESHOLDS;
