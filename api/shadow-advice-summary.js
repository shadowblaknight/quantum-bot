'use strict';
/* eslint-disable */
// api/shadow-advice-summary.js
// GET /api/shadow-advice-summary
//
// Read-only analysis of the recognition-memory shadow log (v14:shadow:advice:*).
// Reports confidence-label / advisorMultiplier / (asset×direction) outcome breakdowns
// over RESOLVED records only (those with closedAt stamped by manage-trades.js).
//
// n ≥ 8 gate on every bucket: results below threshold have winRate/avgR/netPnl nulled
// and carry insufficient:true — they are not greyed, they are withheld.
//
// 30-min cache at v14:shadow-advice:summary:latest.  ?refresh=1 bypasses.
//
// SAFETY: GET-only. No imports from execute.js or any placement module.
// The advisor is in SHADOW MODE (recMultiplier hardcoded to 1.0 in watcher.js);
// this endpoint merely reports what the shadow log has accumulated.

const { applyCors, getRedis, safeParse } = require('./_lib');

const INDEX_KEY  = 'v14:shadow:index';
const ADVICE_KEY = (setupId) => `v14:shadow:advice:${setupId}`;
const CACHE_KEY  = 'v14:shadow-advice:summary:latest';
const CACHE_TTL  = 30 * 60;   // 30 minutes (seconds)
const MIN_N      = 8;

function mkStat() {
  return { n: 0, wins: 0, netPnl: 0, rSum: 0, rCount: 0 };
}

function addTo(st, rec) {
  st.n++;
  if (rec.outcome === 'WIN') st.wins++;
  st.netPnl += rec.netPnl || 0;
  if (rec.pnlR != null) { st.rSum += rec.pnlR; st.rCount++; }
}

function finalize(st) {
  const raw = {
    n:       st.n,
    wins:    st.wins,
    winRate: st.n > 0 ? st.wins / st.n : null,
    netPnl:  Math.round(st.netPnl * 100) / 100,
    avgR:    st.rCount > 0 ? Math.round(st.rSum / st.rCount * 100) / 100 : null,
  };
  if (raw.n < MIN_N) {
    return { ...raw, winRate: null, avgR: null, netPnl: null, insufficient: true };
  }
  return raw;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    const refresh = req.query?.refresh === '1';

    if (!refresh) {
      const cached = await r.get(CACHE_KEY).catch(() => null);
      const c = cached ? (typeof cached === 'string' ? safeParse(cached) : cached) : null;
      if (c?.generatedAt && (Date.now() - c.generatedAt) < CACHE_TTL * 1000) {
        return res.status(200).json({ ...c, _fromCache: true });
      }
    }

    // ── Load index (Redis LPUSH list, newest-first, capped at 500) ──────────
    const rawEntries = await r.lrange(INDEX_KEY, 0, 499).catch(() => []);
    const indexEntries = (rawEntries || [])
      .map(e => typeof e === 'string' ? safeParse(e) : e)
      .filter(e => e && e.setupId);

    if (indexEntries.length === 0) {
      const out = {
        ok: true, generatedAt: Date.now(), minN: MIN_N,
        coverage: { written: 0, resolved: 0, open: 0 },
        byConfidence: {}, byMultiplierBucket: {}, byAssetDirection: {},
        shadowMode: true, recMultiplier: 1.0,
      };
      await r.set(CACHE_KEY, JSON.stringify(out), { ex: CACHE_TTL }).catch(() => {});
      return res.status(200).json(out);
    }

    // ── Pipeline-fetch all advice records ────────────────────────────────────
    const pipe = r.pipeline();
    for (const e of indexEntries) pipe.get(ADVICE_KEY(e.setupId));
    const raws = await pipe.exec().catch(() => []);

    const records = (raws || [])
      .map(raw => raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null)
      .filter(Boolean);

    const resolved = records.filter(rec => rec.closedAt != null && rec.outcome != null);
    const open     = records.filter(rec => !rec.closedAt);

    // ── a. By confidence label ────────────────────────────────────────────────
    const confAgg = {};
    for (const rec of resolved) {
      const k = rec.confidence || 'unknown';
      if (!confAgg[k]) confAgg[k] = mkStat();
      addTo(confAgg[k], rec);
    }
    const byConfidence = {};
    for (const [k, st] of Object.entries(confAgg)) byConfidence[k] = finalize(st);

    // ── b. By advisorMultiplier bucket ────────────────────────────────────────
    const multAgg = {};
    for (const rec of resolved) {
      const m = rec.advisorMultiplier;
      const k = m != null ? String(m) : 'unknown';
      if (!multAgg[k]) multAgg[k] = mkStat();
      addTo(multAgg[k], rec);
    }
    const byMultiplierBucket = {};
    for (const [k, st] of Object.entries(multAgg)) byMultiplierBucket[k] = finalize(st);

    // ── c. Per (asset, direction) ─────────────────────────────────────────────
    const adAgg = {};
    for (const rec of resolved) {
      const k = `${rec.asset || '?'}:${rec.direction || '?'}`;
      if (!adAgg[k]) adAgg[k] = mkStat();
      addTo(adAgg[k], rec);
    }
    const byAssetDirection = {};
    for (const [k, st] of Object.entries(adAgg)) byAssetDirection[k] = finalize(st);

    // ── d. Coverage ───────────────────────────────────────────────────────────
    const coverage = {
      written:  indexEntries.length,
      resolved: resolved.length,
      open:     open.length,
    };

    const out = {
      ok:                true,
      generatedAt:       Date.now(),
      minN:              MIN_N,
      coverage,
      byConfidence,
      byMultiplierBucket,
      byAssetDirection,
      shadowMode:        true,
      recMultiplier:     1.0,
    };

    await r.set(CACHE_KEY, JSON.stringify(out), { ex: CACHE_TTL }).catch(() => {});
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
