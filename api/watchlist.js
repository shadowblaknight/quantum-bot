/* eslint-disable */
// V12.3 — api/watchlist.js
//
// Read or update the watcher's watchlist. The watchlist is the array of asset
// IDs the watcher processes each cron tick. Persisted in Redis.
//
//   GET  /api/watchlist          → { watchlist: ['gold','eurusd',...] }
//   POST /api/watchlist {assets:[...]}  → { ok:true, watchlist:[...] }
//
// Each asset ID is validated against the registry.
// ----------------------------------------------------------------------------

const { applyCors, getRedis, safeParse } = require('./_lib');
const { getAssetById } = require('./asset-registry');

const WATCHLIST_KEY = 'v12:watchlist';

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const r = getRedis();
  if (!r) return res.status(500).json({ error: 'redis unavailable' });

  try {
    if (req.method === 'GET') {
      const raw = await r.get(WATCHLIST_KEY).catch(() => null);
      const parsed = safeParse(raw);
      const watchlist = Array.isArray(parsed) ? parsed.filter((a) => getAssetById(a)) : ['gold', 'eurusd'];
      return res.status(200).json({ watchlist });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      const assets = body?.assets;
      if (!Array.isArray(assets) || assets.length === 0) {
        return res.status(400).json({ error: 'assets must be a non-empty array of asset IDs' });
      }
      if (assets.length > 12) {
        return res.status(400).json({ error: 'maximum 12 assets per watchlist (TwelveData cost)' });
      }
      const unknown = assets.filter((a) => !getAssetById(a));
      if (unknown.length > 0) {
        return res.status(400).json({ error: 'unknown asset IDs: ' + unknown.join(', ') });
      }
      const dedup = [...new Set(assets)];
      await r.set(WATCHLIST_KEY, JSON.stringify(dedup), { ex: 86400 * 30 });
      return res.status(200).json({ ok: true, watchlist: dedup });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};