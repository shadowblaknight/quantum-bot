/* eslint-disable */
// V12 — api/state.js
//
// READ endpoint for the cockpit. Returns the watcher's mental model +
// commentary + news context for one asset.
//
// Cockpit polls every 10-30s.
// ----------------------------------------------------------------------------

const { getRedis, safeParse, applyCors, getCurrentSession } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { getNewsContext } = require('./news-context');

// These keys must match watcher.js
const STATE_KEY = (asset) => `v12:watcher:${asset}:state`;
const STRUCT_KEY = (asset) => `v12:watcher:${asset}:structural`;
const COMMENTARY_KEY = (asset) => `v12:watcher:${asset}:commentary`;
const PENDING_KEY = (asset) => `v12:watcher:${asset}:pending`;

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  try {
    const asset = req.query.asset;
    if (!asset) return res.status(400).json({ error: 'asset required' });
    if (!getAssetById(asset)) return res.status(400).json({ error: 'unknown asset' });

    const r = getRedis();
    if (!r) return res.status(500).json({ error: 'redis unavailable' });

    const [stateRaw, structRaw, commentaryRaw, pendingRaw] = await Promise.all([
      r.get(STATE_KEY(asset)).catch(() => null),
      r.get(STRUCT_KEY(asset)).catch(() => null),
      r.get(COMMENTARY_KEY(asset)).catch(() => null),
      r.get(PENDING_KEY(asset)).catch(() => null),
    ]);

    const state = safeParse(stateRaw);
    const structural = safeParse(structRaw);
    const commentary = safeParse(commentaryRaw) || [];
    const pending = safeParse(pendingRaw) || [];
    const news = await getNewsContext(asset).catch(() => null);

    return res.status(200).json({
      asset,
      ts: Date.now(),
      session: getCurrentSession(),
      state,
      structural,
      commentary,
      pending: pending.filter((p) => p.status === 'pending' || p.status === 'placed'),
      news,
      lastTickAt: state?.ts || null,
      lastTickAge: state?.ts ? Date.now() - state.ts : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};