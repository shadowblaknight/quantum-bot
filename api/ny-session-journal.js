'use strict';
/* eslint-disable */
// api/ny-session-journal.js  v16.1
//
// NY Open Specialist — daily session journal per instrument.
//
// Writes one record per (date × asset) at signal time, updates outcome at close.
// After 14 closed sessions per asset the context-matcher activates: finds past
// sessions with a similar fingerprint and returns a predicted WR.
//
// NY Open Specialist scope:
//   Assets    : gold, us500, nas100
//   Templates : orb, orb-pro, am-ifvg, silver-bullet
//   Window    : 13:00–16:00 UTC
//
// Redis keys:
//   v16:ny:session:{date}:{asset}  — per-session record
//   v16:ny:session:index           — [{date,asset,ts}] newest-first, cap 540
//
// GUARDRAILS: read/write journal only — no trade placement, no price changes.
// All callers are fire-and-forget wrapped in try/catch.

const { getRedis, safeParse } = require('./_lib');

const NY_ASSETS    = new Set(['gold', 'us500', 'nas100']);
const NY_TEMPLATES = new Set(['orb', 'orb-pro', 'am-ifvg', 'silver-bullet']);
const NY_UTC_START = 13 * 60;   // 13:00 UTC
const NY_UTC_END   = 16 * 60;   // 16:00 UTC
const MATCH_MIN    = 14;        // sessions before matcher activates per asset

const SESSION_KEY = (date, asset) => `v16:ny:session:${date}:${asset}`;
const INDEX_KEY   = 'v16:ny:session:index';
const INDEX_CAP   = 540;        // ~6 months × 3 assets × ~5 days/wk

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(ts) {
  return new Date(ts || Date.now()).toISOString().slice(0, 10);
}

function utcMinOfDay(ts) {
  const d = new Date(ts || Date.now());
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function vixToRegime(vix) {
  if (vix == null) return null;
  if (vix < 15)   return 'calm';
  if (vix < 20)   return 'normal';
  if (vix < 30)   return 'stressed';
  return 'extreme';
}

// ── Public: is this signal in-scope for the NY specialist? ───────────────────

function isNYSpecialistSignal(assetId, template, ts) {
  if (!NY_ASSETS.has(assetId))    return false;
  if (!NY_TEMPLATES.has(template)) return false;
  const min = utcMinOfDay(ts || Date.now());
  return min >= NY_UTC_START && min < NY_UTC_END;
}

// Like isNYSpecialistSignal but without the time-window check.
// Used when updating outcome at trade close: fill time may be outside 13-16 UTC
// (limit orders), but the session record was written at signal time so we still
// need to update it.
function isNYSpecialistTrade(assetId, template) {
  return NY_ASSETS.has(assetId) && NY_TEMPLATES.has(template);
}

// ── VIX reader ────────────────────────────────────────────────────────────────

async function _getVix(r) {
  try {
    const raw = await r.get('v14:regime:vix:cache').catch(() => null);
    const v = safeParse(raw);
    if (!v) return { vix: null, vixRegime: null };
    const vix = v.value ?? v.vix ?? null;
    return { vix, vixRegime: vixToRegime(vix) };
  } catch (_) { return { vix: null, vixRegime: null }; }
}

// ── News context reader ───────────────────────────────────────────────────────

async function _getNews(assetId) {
  try {
    const { getNewsContext } = require('./news-context');
    const ctx = await Promise.race([
      getNewsContext(assetId),
      new Promise(r => setTimeout(() => r(null), 1500)),
    ]);
    if (!ctx) return { hasMajorNews: false, newsState: 'unknown', newsEvents: [] };
    const events   = (ctx.events && ctx.events.today) || [];
    const highImp  = events.filter(e => e.impact === 'High');
    const hasMajorNews = ctx.state === 'live' || ctx.state === 'imminent' || highImp.length > 0;
    return {
      hasMajorNews,
      newsState:  ctx.state || 'clear',
      newsEvents: highImp.map(e => ({ name: e.name, minsUntil: e.minsUntil })).slice(0, 3),
    };
  } catch (_) { return { hasMajorNews: false, newsState: 'unknown', newsEvents: [] }; }
}

// ── Session bias from signal context ─────────────────────────────────────────
// withPriorSession: true  = London supported this direction  → sessionBias = direction
// withPriorSession: false = London was against this direction → sessionBias = opposite

function _sessionBias(direction, withPriorSession) {
  if (withPriorSession == null) return null;
  const isLong = direction === 'LONG';
  return withPriorSession ? (isLong ? 'bull' : 'bear') : (isLong ? 'bear' : 'bull');
}

// ── Index management ──────────────────────────────────────────────────────────

async function _addToIndex(r, date, asset, ts) {
  try {
    const raw   = await r.get(INDEX_KEY).catch(() => null);
    const index = safeParse(raw) || [];
    if (!index.find(e => e.date === date && e.asset === asset)) {
      index.unshift({ date, asset, ts });
      if (index.length > INDEX_CAP) index.splice(INDEX_CAP);
      await r.set(INDEX_KEY, JSON.stringify(index));
    }
  } catch (_) {}
}

// ── Context matcher ───────────────────────────────────────────────────────────

function _score(past, fp) {
  let s = 0;
  if (fp.sessionBias  && past.sessionBias  === fp.sessionBias)  s += 3;
  if (fp.cvdTrend     && past.cvdTrend     === fp.cvdTrend)     s += 2;
  if (fp.vixRegime    && past.vixRegime    === fp.vixRegime)    s += 2;
  if (fp.cvdLowTrust  != null && past.cvdLowTrust === fp.cvdLowTrust)  s += 1;
  if (past.hasMajorNews === fp.hasMajorNews)                     s += 2;
  return s;
}

async function _match(r, assetId, fingerprint) {
  try {
    const indexRaw = await r.get(INDEX_KEY).catch(() => null);
    const allIdx   = (safeParse(indexRaw) || []).filter(e => e.asset === assetId);

    if (allIdx.length < MATCH_MIN) {
      return { active: false, need: MATCH_MIN - allIdx.length };
    }

    const raws    = await Promise.all(allIdx.map(e => r.get(SESSION_KEY(e.date, e.asset)).catch(() => null)));
    const sessions = raws.map(raw => safeParse(raw)).filter(Boolean);
    const closed   = sessions.filter(s => s.outcome === 'WIN' || s.outcome === 'LOSS');

    if (closed.length < MATCH_MIN) {
      return { active: false, need: MATCH_MIN - closed.length };
    }

    const scored = closed
      .map(s => ({ ...s, _score: _score(s, fingerprint) }))
      .filter(s => s._score >= 5)
      .sort((a, b) => b._score - a._score)
      .slice(0, 10);

    if (!scored.length) return { active: true, matchedSessions: 0, matchWR: null };

    const wins   = scored.filter(s => s.outcome === 'WIN').length;
    const matchWR = wins / scored.length;
    const avgPnl  = scored.reduce((sum, s) => sum + (s.pnl || 0), 0) / scored.length;

    return {
      active:          true,
      matchedSessions: scored.length,
      matchWR:         Math.round(matchWR * 1000) / 10,
      wins,
      losses:          scored.length - wins,
      avgPnl:          Math.round(avgPnl * 100) / 100,
      topContext:      scored.slice(0, 3).map(s => ({
        date:         s.date,
        outcome:      s.outcome,
        pnl:          s.pnl,
        sessionBias:  s.sessionBias,
        vixRegime:    s.vixRegime,
        hasMajorNews: s.hasMajorNews,
        template:     s.lastSignalTemplate || null,
      })),
    };
  } catch (_) { return null; }
}

// ── Public: record a qualifying signal ───────────────────────────────────────
// Called from webhook.js after signal quality gate passes.
// Returns context match result (may be null if not enough data yet).

async function recordNYSignal(p, assetId, sqResult) {
  try {
    const r = getRedis();
    if (!r) return null;

    const ts   = typeof p.timestamp === 'number' ? p.timestamp : parseInt(p.timestamp, 10) || Date.now();
    const date = isoDate(ts);

    const withPriorSession = sqResult?.session?.withPriorSession ?? sqResult?.withPriorSession ?? null;
    const sessionBias = _sessionBias(p.direction, withPriorSession);

    const [vixCtx, newsCtx] = await Promise.all([_getVix(r), _getNews(assetId)]);

    const fingerprint = {
      sessionBias,
      cvdTrend:    p.cvdSlope     || null,
      cvdLowTrust: p.cvdLowTrust  ?? null,
      vixRegime:   vixCtx.vixRegime,
      hasMajorNews: newsCtx.hasMajorNews,
    };

    // Seed session record if it doesn't exist yet
    const key      = SESSION_KEY(date, assetId);
    const existing = safeParse(await r.get(key).catch(() => null));
    if (!existing) {
      const record = {
        date, asset: assetId, ts,
        ...fingerprint,
        vixLevel:   vixCtx.vix,
        newsState:  newsCtx.newsState,
        newsEvents: newsCtx.newsEvents,
        signals:    [],
        outcome:    'no-signal',
        pnl:        null,
        closedAt:   null,
        lastSignalTemplate:  null,
        lastSignalDirection: null,
      };
      await r.set(key, JSON.stringify(record));
      await _addToIndex(r, date, assetId, ts);
    }

    // Append signal entry
    const rec = safeParse(await r.get(key).catch(() => null));
    if (rec) {
      rec.signals = rec.signals || [];
      rec.signals.push({
        ts, template: p.template, direction: p.direction,
        qualityTier:   sqResult?.qualityTier || null,
        cvdSlope:      p.cvdSlope     || null,
        cvdDivergence: p.cvdDivergence || null,
      });
      rec.outcome              = 'open';
      rec.lastSignalTemplate   = p.template;
      rec.lastSignalDirection  = p.direction;
      await r.set(key, JSON.stringify(rec));
    }

    return _match(r, assetId, fingerprint);
  } catch (_) { return null; }
}

// ── Public: update outcome when trade closes ──────────────────────────────────
// Called from recognition-memory.js → storeClosedTrade.

async function updateNYOutcome(assetId, openedAt, outcome, pnl) {
  try {
    const r = getRedis();
    if (!r) return;
    const date = isoDate(openedAt);
    const key  = SESSION_KEY(date, assetId);
    const rec  = safeParse(await r.get(key).catch(() => null));
    if (!rec) return;
    if (rec.outcome === 'WIN' || rec.outcome === 'LOSS') return; // already terminal
    const updated = { ...rec, outcome, pnl: pnl ?? rec.pnl, closedAt: Date.now() };
    await r.set(key, JSON.stringify(updated));
  } catch (_) {}
}

// ── Public: panel data ────────────────────────────────────────────────────────

async function getNYPanelData() {
  const r = getRedis();
  if (!r) return null;

  try {
    const indexRaw = await r.get(INDEX_KEY).catch(() => null);
    const index    = safeParse(indexRaw) || [];

    // Today and NY Open countdown
    const now          = new Date();
    const today        = isoDate(Date.now());
    const todayNYOpen  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 0, 0);
    const minsToOpen   = Math.round((todayNYOpen - Date.now()) / 60000);
    const utcMin       = utcMinOfDay(Date.now());
    const nyIsLive     = utcMin >= NY_UTC_START && utcMin < NY_UTC_END;
    const nyOpenStatus = nyIsLive ? 'LIVE' : minsToOpen > 0 ? `in ${minsToOpen}m` : 'closed';

    // Today's status per asset (load in parallel)
    const todayStatus = {};
    await Promise.all([...NY_ASSETS].map(async asset => {
      const raw = await r.get(SESSION_KEY(today, asset)).catch(() => null);
      todayStatus[asset] = safeParse(raw) || null;
    }));

    // Recent 45 sessions (up to last ~3 weeks × 3 assets)
    const recent45  = index.slice(0, 45);
    const recRaws   = await Promise.all(recent45.map(e => r.get(SESSION_KEY(e.date, e.asset)).catch(() => null)));
    const recentSessions = recRaws.map(raw => safeParse(raw)).filter(Boolean);

    // Per-asset stats over those recent sessions
    const stats = {};
    for (const asset of NY_ASSETS) {
      const closed = recentSessions.filter(s => s.asset === asset && (s.outcome === 'WIN' || s.outcome === 'LOSS'));
      const wins   = closed.filter(s => s.outcome === 'WIN').length;
      const pnl    = closed.reduce((acc, s) => acc + (s.pnl || 0), 0);
      stats[asset] = {
        n:       closed.length,
        wins,
        losses:  closed.length - wins,
        winRate: closed.length > 0 ? Math.round(wins / closed.length * 1000) / 10 : null,
        pnl:     Math.round(pnl * 100) / 100,
        signalRate: recentSessions.filter(s => s.asset === asset && s.outcome !== 'no-signal').length,
      };
    }

    // Context matcher state (how many sessions needed per asset)
    const matcherState = {};
    for (const asset of NY_ASSETS) {
      const assetClosed = recentSessions.filter(s => s.asset === asset && (s.outcome === 'WIN' || s.outcome === 'LOSS'));
      matcherState[asset] = {
        closed:   assetClosed.length,
        active:   assetClosed.length >= MATCH_MIN,
        need:     Math.max(0, MATCH_MIN - assetClosed.length),
      };
    }

    return {
      ok:           true,
      generatedAt:  Date.now(),
      today,
      nyOpenStatus,
      minsToOpen,
      nyIsLive,
      todayStatus,
      recentSessions,
      stats,
      matcherState,
      totalSessions: index.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  isNYSpecialistSignal,
  isNYSpecialistTrade,
  recordNYSignal,
  updateNYOutcome,
  getNYPanelData,
};
