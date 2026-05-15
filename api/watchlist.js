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
const { getAssetById, getAssetBySymbol, matchBrokerSymbol } = require('./asset-registry');

const WATCHLIST_KEY = 'v12:watchlist';

// V12.4.1: resolve any user-typed token (id, alias, or fuzzy form) to a
// canonical asset ID. Returns null if no match. This makes the watchlist
// forgiving — users can type "sp500" or "SPX500" and have it resolve to "us500".
function resolveToAssetId(token) {
  if (!token || typeof token !== 'string') return null;
  const t = token.trim().toLowerCase();
  if (getAssetById(t)) return t;                                  // exact id
  const byAlias = getAssetBySymbol(token);                        // exact alias
  if (byAlias) return byAlias.id;
  const fuzzy = matchBrokerSymbol(token);                         // fuzzy fallback
  if (fuzzy?.asset) return fuzzy.asset.id;
  return null;
}

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
        return res.status(400).json({ error: 'assets must be a non-empty array of asset IDs or symbols' });
      }
      if (assets.length > 12) {
        return res.status(400).json({ error: 'maximum 12 assets per watchlist' });
      }
      // V12.4.1: resolve aliases to canonical IDs (e.g., "sp500" → "us500")
      const resolved = [];
      const unknown = [];
      for (const a of assets) {
        const id = resolveToAssetId(a);
        if (id) resolved.push(id);
        else unknown.push(a);
      }
      if (unknown.length > 0) {
        return res.status(400).json({ error: 'unknown asset IDs or symbols: ' + unknown.join(', ') });
      }
      const dedup = [...new Set(resolved)];
      await r.set(WATCHLIST_KEY, JSON.stringify(dedup), { ex: 86400 * 30 });
      return res.status(200).json({ ok: true, watchlist: dedup });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};