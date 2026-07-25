'use strict';
/* eslint-disable */
// api/wickratio-shadow.js  v15.8
// Captures the signal bar's wick structure at the moment a Pine alert fires.
//
// Pine scripts must emit barOpen / barHigh / barLow / barClose in the payload
// for this to compute a real wickRatio. Until the Pine update is deployed,
// records are stored with wickRatio:null, hasBarData:false — the shadow still
// accumulates so coverage can be measured forward from the Pine update date.
//
// wickRatio = max(upper_wick, lower_wick) / range
//   = 0 when no wicks (full body bar)
//   = 1 when no body (full doji wick bar)
//
// SAFETY: write-only — never reads or touches trade pnl / outcome / prices.
// Must be registered via _waitUntil in the main webhook handler (G3 guardrail).
// Typed errors go to v14:wickratio:errors (capped list, never surfaces to user).

const { getRedis, safeParse } = require('./_lib');

const WR_SHADOW_KEY       = (id) => `v14:wickratio:shadow:${id}`;
const WR_SHADOW_INDEX_KEY = 'v14:wickratio:shadow:index';
const WR_SHADOW_INDEX_CAP = 5000;
const WR_SHADOW_TTL_SEC   = 30 * 24 * 3600; // 30 days
const WR_ERRORS_KEY       = 'v14:wickratio:errors';
const WR_ERRORS_CAP       = 20;

function classifySessionFromTs(ts) {
  const d = new Date(ts);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return 'WEEKEND';
  if (h >= 23 || h < 8)      return 'ASIAN';
  if (h >= 8  && h < 13)     return 'LONDON';
  if (h >= 13 && h < 16)     return 'NY_AM';
  if (h >= 16 && h < 21)     return 'NY_PM';
  return 'OFF';
}

function computeWickRatio(o, h, l, c) {
  const range = h - l;
  if (range <= 0) return null;
  const bodyTop    = Math.max(o, c);
  const bodyBot    = Math.min(o, c);
  const upperWick  = h - bodyTop;
  const lowerWick  = bodyBot - l;
  return Math.round(Math.max(upperWick, lowerWick) / range * 10000) / 10000;
}

async function pushError(r, code, msg) {
  try {
    const entry = JSON.stringify({ ts: Date.now(), code, msg });
    await r.lpush(WR_ERRORS_KEY, entry);
    await r.ltrim(WR_ERRORS_KEY, 0, WR_ERRORS_CAP - 1);
  } catch (_) {}
}

async function writeWickRatioShadow(p, dedupeKey, assetId) {
  const r = getRedis();
  if (!r) return;

  const ts = typeof p.timestamp === 'number' ? p.timestamp
           : parseInt(p.timestamp, 10) || Date.now();

  // Parse OHLC — present only after Pine scripts are updated to emit them.
  const barOpen  = p.barOpen  != null ? parseFloat(p.barOpen)  : null;
  const barHigh  = p.barHigh  != null ? parseFloat(p.barHigh)  : null;
  const barLow   = p.barLow   != null ? parseFloat(p.barLow)   : null;
  const barClose = p.barClose != null ? parseFloat(p.barClose) : null;
  const hasBarData = [barOpen, barHigh, barLow, barClose].every(v => v != null && isFinite(v));

  let wickRatio = null;
  if (hasBarData) {
    wickRatio = computeWickRatio(barOpen, barHigh, barLow, barClose);
    if (wickRatio === null) {
      await pushError(r, 'zero-range', `range=0 for ${assetId} dedupeKey=${dedupeKey}`);
    }
  }

  const record = {
    id:        dedupeKey,
    assetId,
    template:  p.template  || 'unknown',
    direction: p.direction || null,
    htfTier:   p.htfTier   || null,
    session:   classifySessionFromTs(ts),
    ts,
    hasBarData,
    barOpen:   hasBarData ? barOpen  : null,
    barHigh:   hasBarData ? barHigh  : null,
    barLow:    hasBarData ? barLow   : null,
    barClose:  hasBarData ? barClose : null,
    wickRatio,
  };

  try {
    await r.set(WR_SHADOW_KEY(dedupeKey), JSON.stringify(record), { ex: WR_SHADOW_TTL_SEC });
  } catch (e) {
    await pushError(r, 'write-failed', String(e && e.message));
    return;
  }

  try {
    const raw = await r.get(WR_SHADOW_INDEX_KEY).catch(() => null);
    let idx = safeParse(raw);
    if (!Array.isArray(idx)) idx = [];
    const filtered = idx.filter((e) => e.id !== dedupeKey);
    filtered.unshift({ id: dedupeKey, ts, template: p.template, assetId, hasBarData });
    await r.set(WR_SHADOW_INDEX_KEY, JSON.stringify(filtered.slice(0, WR_SHADOW_INDEX_CAP)), { ex: WR_SHADOW_TTL_SEC });
  } catch (_) {}
}

module.exports = { writeWickRatioShadow, WR_SHADOW_KEY, WR_SHADOW_INDEX_KEY, WR_SHADOW_TTL_SEC };
