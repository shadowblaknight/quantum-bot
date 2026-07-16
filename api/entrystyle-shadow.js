/* eslint-disable */
// V15.6 — api/entrystyle-shadow.js
// Shadow write helpers for the Immediate-vs-Retest comparison system.
// Called fire-and-forget from processSignalBackground in webhook.js.
// Writes go to Redis only; never touches live execution state.

const { getRedis, safeParse } = require('./_lib');

const ES_SHADOW_KEY       = (id) => `v14:entrystyle:shadow:${id}`;
const ES_SHADOW_INDEX_KEY = 'v14:entrystyle:shadow:index';
const ES_SHADOW_INDEX_CAP = 2000;
const ES_SHADOW_TTL_SEC   = 7 * 24 * 3600; // 7 days

function computeTPs(entry, sl, direction) {
  const dist = Math.abs(entry - sl);
  const sign = direction === 'LONG' ? 1 : -1;
  return {
    tp1: entry + sign * dist,
    tp2: entry + sign * dist * 2,
    tp3: entry + sign * dist * 3,
  };
}

function classifySessionFromTs(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 0 || day === 6)  return 'WEEKEND';
  if (h >= 23 || h < 8)       return 'ASIAN';
  if (h >= 8  && h < 13)      return 'LONDON';
  if (h >= 13 && h < 16)      return 'NY_AM';
  if (h >= 16 && h < 21)      return 'NY_PM';
  return 'OFF';
}

async function writeEntryStyleShadow(p, dedupeKey, assetId) {
  const r = getRedis();
  if (!r) return;

  const immediateEntry = parseFloat(p.immediateEntry);
  const retestEntry    = parseFloat(p.retestEntry);
  const sl             = parseFloat(p.sl);
  if (!isFinite(immediateEntry) || !isFinite(retestEntry) || !isFinite(sl)) return;

  const slDistImm    = Math.abs(immediateEntry - sl);
  const slDistRet    = Math.abs(retestEntry - sl);
  if (slDistImm === 0) return; // degenerate, skip

  const entryDiverge = Math.abs(immediateEntry - retestEntry) >= 0.1 * slDistImm;

  const immTPs = computeTPs(immediateEntry, sl, p.direction);
  const retTPs = computeTPs(retestEntry,    sl, p.direction);

  const ts = typeof p.timestamp === 'number' ? p.timestamp : parseInt(p.timestamp, 10) || Date.now();

  const record = {
    id:             dedupeKey,
    assetId,
    template:       p.template,
    session:        classifySessionFromTs(ts),
    direction:      p.direction,
    ts,
    actualStyle:    p.actualStyle || 'unknown',
    immediateEntry,
    retestEntry,
    sl,
    entryDiverge,
    slDistImm,
    slDistRet,
    immTP1:         immTPs.tp1,
    immTP2:         immTPs.tp2,
    immTP3:         immTPs.tp3,
    retTP1:         retTPs.tp1,
    retTP2:         retTPs.tp2,
    retTP3:         retTPs.tp3,
    immOutcome:     null,
    immR:           null,
    retFilled:      null,
    retOutcome:     null,
    retR:           null,
    resolvedAt:     null,
  };

  try {
    await r.set(ES_SHADOW_KEY(dedupeKey), JSON.stringify(record), { ex: ES_SHADOW_TTL_SEC });
  } catch (_) { return; }

  // Maintain newest-first index, deduped, capped
  try {
    const raw = await r.get(ES_SHADOW_INDEX_KEY).catch(() => null);
    let idx = safeParse(raw);
    if (!Array.isArray(idx)) idx = [];
    const filtered = idx.filter((e) => e.id !== dedupeKey);
    filtered.unshift({ id: dedupeKey, ts, template: p.template, assetId });
    await r.set(ES_SHADOW_INDEX_KEY, JSON.stringify(filtered.slice(0, ES_SHADOW_INDEX_CAP)), { ex: ES_SHADOW_TTL_SEC });
  } catch (_) {}
}

module.exports = { writeEntryStyleShadow, ES_SHADOW_KEY, ES_SHADOW_INDEX_KEY, ES_SHADOW_TTL_SEC };
