/* eslint-disable */
// api/orderflow-shadow.js  v15.7
// Stores the CVD orderflow snapshot attached to each signal.
// Called fire-and-forget from processSignalBackground in webhook.js (Phase 3).
// Writes go to Redis only; never touches live execution state.

const { getRedis, safeParse } = require('./_lib');

const OF_SHADOW_KEY       = (id) => `v14:orderflow:shadow:${id}`;
const OF_SHADOW_INDEX_KEY = 'v14:orderflow:shadow:index';
const OF_SHADOW_INDEX_CAP = 5000;
const OF_SHADOW_TTL_SEC   = 30 * 24 * 3600; // 30 days

function classifySessionFromTs(ts) {
  const d   = new Date(ts);
  const day = d.getUTCDay();
  const h   = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 0 || day === 6) return 'WEEKEND';
  if (h >= 23 || h < 8)      return 'ASIAN';
  if (h >= 8  && h < 13)     return 'LONDON';
  if (h >= 13 && h < 16)     return 'NY_AM';
  if (h >= 16 && h < 21)     return 'NY_PM';
  return 'OFF';
}

async function writeOrderflowShadow(p, dedupeKey, assetId) {
  const r = getRedis();
  if (!r) return;

  // cvdConfirms and cvdLowTrust arrive as JSON booleans from Pine str.tostring().
  // Accept both boolean and string "true"/"false" defensively.
  const parseBool = (v) => v === true || v === 'true';

  const ts = typeof p.timestamp === 'number' ? p.timestamp
           : parseInt(p.timestamp, 10) || Date.now();

  const record = {
    id:           dedupeKey,
    assetId,
    template:     p.template   || 'unknown',
    direction:    p.direction  || null,
    htfTier:      p.htfTier    || null,
    session:      classifySessionFromTs(ts),
    ts,
    cvdSlope:     p.cvdSlope      || 'flat',
    cvdConfirms:  parseBool(p.cvdConfirms),
    cvdDivergence: p.cvdDivergence || 'none',
    cvdLowTrust:  parseBool(p.cvdLowTrust),
  };

  try {
    await r.set(OF_SHADOW_KEY(dedupeKey), JSON.stringify(record), { ex: OF_SHADOW_TTL_SEC });
  } catch (_) { return; }

  try {
    const raw = await r.get(OF_SHADOW_INDEX_KEY).catch(() => null);
    let idx = safeParse(raw);
    if (!Array.isArray(idx)) idx = [];
    const filtered = idx.filter((e) => e.id !== dedupeKey);
    filtered.unshift({ id: dedupeKey, ts, template: p.template, assetId });
    await r.set(OF_SHADOW_INDEX_KEY, JSON.stringify(filtered.slice(0, OF_SHADOW_INDEX_CAP)), { ex: OF_SHADOW_TTL_SEC });
  } catch (_) {}
}

module.exports = { writeOrderflowShadow, OF_SHADOW_KEY, OF_SHADOW_INDEX_KEY, OF_SHADOW_TTL_SEC };
