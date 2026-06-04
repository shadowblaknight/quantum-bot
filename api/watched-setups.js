/* eslint-disable */
// api/watched-setups.js  (Pilot Dashboard v1.2 — adds HTTP endpoint)
//
// CHANGE FROM v1.1: same module exports (addWatchedSetup, updateWatchedSetup,
// etc.) so webhook.js + cron keep working unchanged. Adds default export
// (HTTP handler) so the frontend dashboard can GET this endpoint.
//
// HTTP behavior:
//   GET  /api/watched-setups                 → { list: [active setups], total, alerted, expired }
//   GET  /api/watched-setups?asset=gold      → filter by asset
//   GET  /api/watched-setups?action=cancel&id=watch_xxx → cancel a watch
//   POST /api/watched-setups  (with body action=cancel + id) → cancel
//
// All existing webhook.js and watched-setups-checker.js imports continue to work.
// ----------------------------------------------------------------------------

const { getRedis, safeParse, applyCors } = require('./_lib');

const WATCHED_KEY = 'v13:pilot:watched-setups';
const TTL_SECONDS = 86400;
const MAX_WATCHED = 100;
const DEFAULT_EXPIRY_MS = 90 * 60 * 1000;

async function getAllWatched() {
  const r = getRedis();
  if (!r) return [];
  try {
    const raw = await r.get(WATCHED_KEY);
    const arr = safeParse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[watched-setups] getAll error:', e.message);
    return [];
  }
}

async function setAllWatched(list) {
  const r = getRedis();
  if (!r) return false;
  try {
    const trimmed = list.length > MAX_WATCHED ? list.slice(-MAX_WATCHED) : list;
    await r.set(WATCHED_KEY, JSON.stringify(trimmed), { ex: TTL_SECONDS });
    return true;
  } catch (e) {
    console.error('[watched-setups] setAll error:', e.message);
    return false;
  }
}

async function addWatchedSetup(setup) {
  if (!setup || !setup.id || !setup.asset) {
    return { ok: false, error: 'invalid setup (missing id or asset)' };
  }
  const list = await getAllWatched();
  const filtered = list.filter((s) => s.id !== setup.id);
  filtered.push({
    ...setup,
    status: setup.status || 'watching',
    createdAt: setup.createdAt || Date.now(),
    expiresAt: setup.expiresAt || Date.now() + DEFAULT_EXPIRY_MS,
    alertedAt: setup.alertedAt || null,
  });
  const ok = await setAllWatched(filtered);
  return { ok, id: setup.id };
}

async function updateWatchedSetup(id, patch) {
  if (!id || !patch) return { ok: false, error: 'invalid input' };
  const list = await getAllWatched();
  let found = false;
  const next = list.map((s) => {
    if (s.id === id) { found = true; return { ...s, ...patch }; }
    return s;
  });
  if (!found) return { ok: false, error: 'not-found' };
  const ok = await setAllWatched(next);
  return { ok };
}

async function removeWatchedSetup(id) {
  const list = await getAllWatched();
  const next = list.filter((s) => s.id !== id);
  const ok = await setAllWatched(next);
  return { ok };
}

async function getActiveWatched(assetId) {
  const list = await getAllWatched();
  const now = Date.now();
  return list.filter((s) => {
    if (s.status === 'expired' || s.status === 'placed' || s.status === 'cancelled') return false;
    if (s.expiresAt && now > s.expiresAt) return false;
    if (assetId && s.asset !== assetId) return false;
    return true;
  });
}

async function pruneExpired() {
  const list = await getAllWatched();
  const now = Date.now();
  let changed = false;
  const next = list.map((s) => {
    if (s.expiresAt && now > s.expiresAt && s.status !== 'expired' && s.status !== 'placed') {
      changed = true;
      return { ...s, status: 'expired', expiredAt: now };
    }
    return s;
  });
  if (changed) await setAllWatched(next);
  return next.filter((s) => s.status === 'expired').length;
}

function priceInZone(currentPrice, setup) {
  if (!isFinite(currentPrice)) return false;
  if (isFinite(setup.zoneUpper) && isFinite(setup.zoneLower)) {
    return currentPrice >= setup.zoneLower && currentPrice <= setup.zoneUpper;
  }
  if (isFinite(setup.entry)) {
    const tolerance = setup.entry * 0.001;
    return Math.abs(currentPrice - setup.entry) <= tolerance;
  }
  return false;
}

// ── HTTP handler (default export) ────────────────────────────────────
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const action = (req.query?.action || '').toLowerCase();
    const asset  = req.query?.asset;
    const id     = req.query?.id;

    // POST/GET cancel
    if (action === 'cancel') {
      if (!id) return res.status(400).json({ error: 'id required for cancel' });
      const r = await updateWatchedSetup(id, { status: 'cancelled', cancelledAt: Date.now() });
      return res.status(200).json(r);
    }

    if (action === 'remove') {
      if (!id) return res.status(400).json({ error: 'id required for remove' });
      const r = await removeWatchedSetup(id);
      return res.status(200).json(r);
    }

    // Default: list active (and recent) setups
    await pruneExpired();
    const all = await getAllWatched();
    const filtered = asset ? all.filter((s) => s.asset === asset) : all;
    const list = filtered
      .filter((s) => s.status !== 'expired' && s.status !== 'cancelled')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return res.status(200).json({
      list,
      total:    list.length,
      watching: list.filter((s) => s.status === 'watching').length,
      alerted:  list.filter((s) => s.status === 'alerted').length,
      asset:    asset || null,
      updatedAt: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'watched-setups handler error' });
  }
};

// ── Module exports (for webhook.js + cron) ───────────────────────────
module.exports.getAllWatched       = getAllWatched;
module.exports.getActiveWatched    = getActiveWatched;
module.exports.addWatchedSetup     = addWatchedSetup;
module.exports.updateWatchedSetup  = updateWatchedSetup;
module.exports.removeWatchedSetup  = removeWatchedSetup;
module.exports.pruneExpired        = pruneExpired;
module.exports.priceInZone         = priceInZone;