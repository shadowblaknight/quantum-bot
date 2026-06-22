/* eslint-disable */
// api/market-regime.js — v14 Macro Regime Engine
//
// Detects the prevailing market "regime" so the bot can turn RISK DOWN when the
// macro is dangerous — without pretending to predict headlines (no legitimate
// system does; the best fund in history is right ~51% of the time). Three levels:
//   NORMAL   — trade exactly as the user configured
//   ELEVATED — shrink size a little, widen stops a little
//   CRISIS   — shrink more, widen more (still trades a REDUCED book, never a full stop)
//
// Signals combined:
//   1. Realized volatility — current ATR vs baseline ATR across key instruments
//   2. News — high-impact keyword hits from NewsAPI in the last few hours
//   3. Manual override — the user can force a level (follow my inputs, always)
//
// CRITICAL: this NEVER replaces the user's per-instrument size/SL. It only
// produces two MULTIPLIERS — sizeMult (<=1) and slWiden (>=1) — that the rules
// engine applies ON TOP of whatever the user configured.
//
// Dual-purpose file: an HTTP handler (the dashboard polls it for the red dot)
// AND a module (rules-store reads the cached regime to modulate live signals).

const { getRedis, safeParse, atr } = require('./_lib');

const CFG_KEY = 'v13:regime:config';
const CUR_KEY = 'v13:regime:current';
const REFRESH_MS = 3 * 60 * 1000; // recompute at most every 3 minutes

// Instruments whose volatility we sample as a market-wide proxy.
const VOL_ASSETS = ['gold', 'nas100', 'btc'];

const FFCAL_KEY = 'v13:regime:ffcal';        // cached weekly calendar
const FFCAL_TTL_MS = 6 * 3600 * 1000;        // refetch the weekly file ~every 6h
// Forex Factory free weekly feed (no API key). MUST be cached: FF limits this to
// 2 downloads / 5 min, returning a "Request Denied" HTML page if exceeded.
const FFCAL_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json',
];

// Default config — all user-editable from the dashboard (follow my inputs).
const DEFAULT_CFG = {
  manualOverride: 'auto',            // auto | normal | elevated | crisis
  elevatedVolRatio: 1.6,             // current ATR / baseline ATR
  crisisVolRatio:   2.3,
  elevated: { sizeMult: 0.75, slWiden: 1.15 },
  crisis:   { sizeMult: 0.50, slWiden: 1.35 },
  newsLevel: 'elevated',             // regime floor when major news is active
  // scheduled high-impact economic events (Forex Factory calendar)
  eventLevel: 'elevated',            // regime floor near a scheduled high-impact event
  eventWindowMin: 30,                // minutes BEFORE an event we start warning
  eventAfterMin: 15,                 // minutes AFTER an event we stay warned
  ffImpacts: ['High'],               // which impacts count (High / Medium / Low)
  ffCountries: ['USD', 'EUR', 'GBP', 'JPY'], // [] = all; defaults match the traded book
  keywords: [
    'war', 'strike', 'missile', 'hormuz', 'iran', 'israel', 'invasion', 'attack',
    'fomc', 'rate decision', 'federal reserve', 'interest rate', 'cpi', 'inflation',
    'nonfarm', 'jobs report', 'recession', 'default', 'crash', 'sanctions', 'tariff',
  ],
};

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((res) => setTimeout(() => res(fallback), ms)),
  ]);
}

async function getConfig() {
  try {
    const redis = getRedis();
    const raw = redis ? await redis.get(CFG_KEY) : null;
    const stored = safeParse(raw) || {};
    return {
      ...DEFAULT_CFG, ...stored,
      elevated: { ...DEFAULT_CFG.elevated, ...(stored.elevated || {}) },
      crisis:   { ...DEFAULT_CFG.crisis,   ...(stored.crisis   || {}) },
      keywords: Array.isArray(stored.keywords) && stored.keywords.length ? stored.keywords : DEFAULT_CFG.keywords,
    };
  } catch (_) { return { ...DEFAULT_CFG }; }
}

async function saveConfig(patch) {
  const redis = getRedis();
  const cur = await getConfig();
  const next = {
    ...cur, ...patch,
    elevated: { ...cur.elevated, ...(patch.elevated || {}) },
    crisis:   { ...cur.crisis,   ...(patch.crisis   || {}) },
  };
  if (redis) { try { await redis.set(CFG_KEY, JSON.stringify(next)); } catch (_) {} }
  return next;
}

// ---- Volatility signal: avg(current ATR / baseline ATR) across key assets ----
async function volSignal() {
  let _fc;
  try { ({ fetchCandles: _fc } = require('./candle-source')); } catch (_) { return null; }
  const ratios = [];
  for (const a of VOL_ASSETS) {
    try {
      const r = await withTimeout(_fc(a, '15m', 100), 1500, null);
      const candles = r && r.candles ? r.candles : null;
      if (!candles || candles.length < 60) continue;
      const recent   = atr(candles.slice(-16), 14);  // last ~16 bars
      const baseline = atr(candles.slice(-60), 14);  // longer window
      if (recent && baseline && baseline > 0) ratios.push(recent / baseline);
    } catch (_) {}
  }
  if (!ratios.length) return null;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

// ---- News signal: high-impact keyword hits in the last 6h from NewsAPI ----
async function newsSignal(keywords) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return { active: false, headlines: [], count: 0, disabled: true };
  try {
    const q = encodeURIComponent('(' + keywords.slice(0, 12).join(' OR ') + ')');
    const from = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const url = `https://newsapi.org/v2/everything?q=${q}&from=${from}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${key}`;
    const res = await withTimeout(fetch(url).then((r) => r.json()), 3000, null);
    if (!res || !Array.isArray(res.articles)) return { active: false, headlines: [], count: 0 };
    const heads = res.articles.slice(0, 6).map((a) => ({
      title: a.title, source: (a.source && a.source.name) || '', at: a.publishedAt,
    }));
    // "major news active" = several fresh high-impact headlines clustered together
    return { active: res.articles.length >= 4, headlines: heads, count: res.articles.length };
  } catch (_) { return { active: false, headlines: [], count: 0 }; }
}

// ---- Forex Factory calendar (scheduled high-impact events, no API key) ----
// Cached weekly. We never fetch per-tick — FF rate-limits to 2 downloads / 5 min,
// returning a "Request Denied" HTML page if exceeded (we guard against that).
async function getFFCalendar() {
  const redis = getRedis();
  let cached = null;
  try { cached = safeParse(redis ? await redis.get(FFCAL_KEY) : null); } catch (_) {}
  if (cached && cached.ts && (Date.now() - cached.ts) < FFCAL_TTL_MS && Array.isArray(cached.events)) {
    return cached.events;
  }
  for (const url of FFCAL_URLS) {
    try {
      const res = await withTimeout(fetch(url).then((r) => r.json()), 3500, null);
      if (Array.isArray(res) && res.length) {
        const events = res
          .filter((e) => e && e.date && e.title)
          .map((e) => ({ title: e.title, country: e.country || '', impact: e.impact || '', date: e.date }));
        try { if (redis) await redis.set(FFCAL_KEY, JSON.stringify({ ts: Date.now(), events })); } catch (_) {}
        return events;
      }
    } catch (_) { /* try next mirror */ }
  }
  // fetch failed (rate-limited / offline) → fall back to last good cache if any
  return (cached && Array.isArray(cached.events)) ? cached.events : [];
}

// From the cached calendar, find scheduled high-impact events near "now".
async function ffSignal(cfg) {
  let events;
  try { events = await getFFCalendar(); } catch (_) { events = []; }
  if (!events || !events.length) return { imminent: false, next: null, upcoming: [] };

  const now = Date.now();
  const beforeMs = (cfg.eventWindowMin || 30) * 60000;
  const afterMs  = (cfg.eventAfterMin  || 15) * 60000;
  const impacts  = (cfg.ffImpacts && cfg.ffImpacts.length) ? cfg.ffImpacts : ['High'];
  const countries = cfg.ffCountries || [];

  const rel = [];
  for (const e of events) {
    if (!impacts.includes(e.impact)) continue;
    if (countries.length && !countries.includes(e.country)) continue;
    const t = Date.parse(e.date);
    if (isNaN(t)) continue;
    rel.push({ title: e.title, country: e.country, impact: e.impact, at: e.date, minutesUntil: Math.round((t - now) / 60000) });
  }
  rel.sort((a, b) => a.minutesUntil - b.minutesUntil);

  const imminentEv = rel.find((e) => {
    const ms = e.minutesUntil * 60000;
    return ms <= beforeMs && ms >= -afterMs;
  });
  const upcoming = rel.filter((e) => (e.minutesUntil * 60000) >= -afterMs).slice(0, 5);

  return { imminent: !!imminentEv, next: imminentEv || upcoming[0] || null, upcoming };
}

const LEVEL_RANK = { normal: 0, elevated: 1, crisis: 2 };
function maxLevel(a, b) { return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b; }

async function computeRegime() {
  const cfg = await getConfig();
  const reasons = [];
  let level = 'normal';

  const vr = await volSignal();
  if (vr != null) {
    if (vr >= cfg.crisisVolRatio)        { level = maxLevel(level, 'crisis');   reasons.push(`volatility ${vr.toFixed(2)}x baseline (crisis)`); }
    else if (vr >= cfg.elevatedVolRatio) { level = maxLevel(level, 'elevated'); reasons.push(`volatility ${vr.toFixed(2)}x baseline (elevated)`); }
  }

  const news = await newsSignal(cfg.keywords);
  if (news.active) { level = maxLevel(level, cfg.newsLevel); reasons.push(`${news.count} high-impact headlines (6h)`); }

  const ff = await ffSignal(cfg);
  if (ff.imminent && ff.next) {
    level = maxLevel(level, cfg.eventLevel);
    const m = ff.next.minutesUntil;
    const when = m > 0 ? `in ${m}m` : m === 0 ? 'now' : `${-m}m ago`;
    reasons.push(`${ff.next.title} (${ff.next.country}) ${when}`);
  }

  const autoLevel = level;
  if (cfg.manualOverride && cfg.manualOverride !== 'auto') {
    level = cfg.manualOverride;
    reasons.unshift(`manual override → ${level.toUpperCase()}`);
  }

  const mult = level === 'crisis' ? cfg.crisis
             : level === 'elevated' ? cfg.elevated
             : { sizeMult: 1.0, slWiden: 1.0 };

  return {
    level,
    autoLevel,
    manualOverride: cfg.manualOverride || 'auto',
    sizeMult: Number(mult.sizeMult) || 1.0,
    slWiden:  Number(mult.slWiden)  || 1.0,
    volRatio: vr != null ? Math.round(vr * 100) / 100 : null,
    newsActive: news.active,
    headlines: news.headlines || [],
    eventImminent: ff.imminent,
    nextEvent: ff.next,
    upcomingEvents: ff.upcoming || [],
    reasons,
    ts: Date.now(),
  };
}

async function refreshRegime() {
  const cur = await computeRegime();
  try { const redis = getRedis(); if (redis) await redis.set(CUR_KEY, JSON.stringify(cur)); } catch (_) {}
  return cur;
}

const SAFE_DEFAULT = { level: 'normal', autoLevel: 'normal', manualOverride: 'auto',
  sizeMult: 1.0, slWiden: 1.0, volRatio: null, newsActive: false, headlines: [],
  eventImminent: false, nextEvent: null, upcomingEvents: [], reasons: [], ts: 0 };

// Refreshing read (dashboard) — returns cache, recomputes if stale.
async function getRegime() {
  try {
    const redis = getRedis();
    const raw = redis ? await redis.get(CUR_KEY) : null;
    const cur = safeParse(raw);
    if (cur && cur.ts && (Date.now() - cur.ts) < REFRESH_MS) return cur;
    return await withTimeout(refreshRegime(), 4500, cur || SAFE_DEFAULT);
  } catch (_) { return SAFE_DEFAULT; }
}

// Cache-only read (hot path / live signals) — NEVER blocks on a fetch, so it can
// never add latency or stall trade placement. Falls back to NORMAL (no modulation).
async function getRegimeFast() {
  try {
    const redis = getRedis();
    const raw = redis ? await redis.get(CUR_KEY) : null;
    const cur = safeParse(raw);
    if (cur && cur.level) return cur;
  } catch (_) {}
  return SAFE_DEFAULT;
}

// ---- HTTP handler (the dashboard polls this) ----
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query && req.query.action) || '';
  try {
    if (req.method === 'POST' && action === 'set-override') {
      const body = (req.body && typeof req.body === 'object') ? req.body : (safeParse(req.body) || {});
      const mode = ['auto', 'normal', 'elevated', 'crisis'].includes(body.mode) ? body.mode : 'auto';
      await saveConfig({ manualOverride: mode });
      const regime = await refreshRegime();
      return res.status(200).json({ ok: true, regime, config: await getConfig() });
    }
    if (req.method === 'POST' && action === 'set-config') {
      const body = (req.body && typeof req.body === 'object') ? req.body : (safeParse(req.body) || {});
      const config = await saveConfig(body);
      const regime = await refreshRegime();
      return res.status(200).json({ ok: true, regime, config });
    }
    const regime = action === 'refresh' ? await refreshRegime() : await getRegime();
    return res.status(200).json({ ok: true, regime, config: await getConfig() });
  } catch (e) {
    return res.status(200).json({ ok: false, error: (e && e.message) || 'regime-error', regime: SAFE_DEFAULT });
  }
};

module.exports.getRegime = getRegime;
module.exports.getRegimeFast = getRegimeFast;
module.exports.refreshRegime = refreshRegime;
module.exports.computeRegime = computeRegime;
module.exports.getConfig = getConfig;