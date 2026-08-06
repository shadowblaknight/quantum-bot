'use strict';
/* eslint-disable */
// api/signal-quality-summary.js  v16.0
//
// GET  /api/signal-quality-summary  — combined signal quality panel data
//      Returns: config, tierStats (A/B/C/D WR), recent signal log
//
// POST /api/signal-quality-summary  — update gate config
//      Body: { wickGateEnabled?, sessionGateEnabled?, cvdGateEnabled?, wickThreshold? }
//
// G6 GUARDRAIL: POST writes gating flags only. Never places, closes, or modifies trades.

const { applyCors, getRedis, safeParse } = require('./_lib');
const { getConfig, setConfig, SQ_INDEX_KEY, SQ_KEY } = require('./signal-quality');
const { getAllTrades } = require('./recognition-memory');

const JOIN_TOL = 900_000; // 15-min fuzzy window (ORB signal-to-fill gap)
const MIN_N    = 3;       // minimum trades for a tier stat to be shown

function wrStats(trades) {
  const n      = trades.length;
  const wins   = trades.filter(t => t.outcome === 'WIN').length;
  const losses = trades.filter(t => t.outcome === 'LOSS').length;
  const pnl    = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  return { n, wins, losses, winRate: n > 0 ? wins / n : null, pnl };
}

async function loadSQIndex(r) {
  const raw = await r.get(SQ_INDEX_KEY).catch(() => null);
  const idx = safeParse(raw);
  return Array.isArray(idx) ? idx : [];
}

async function loadSQRecord(r, id) {
  const raw = await r.get(SQ_KEY(id)).catch(() => null);
  return safeParse(raw) || null;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // ── POST — update config ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    const allowed = ['wickGateEnabled', 'sessionGateEnabled', 'cvdGateEnabled', 'wickThreshold'];
    const patch = {};
    for (const k of allowed) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: 'no valid config fields in body' });
    }
    const result = await setConfig(patch);
    return res.status(result.ok ? 200 : 503).json(result);
  }

  // ── GET — summary data ─────────────────────────────────────────────────────
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    const [config, sqIndex, allTrades] = await Promise.all([
      getConfig(),
      loadSQIndex(r),
      getAllTrades(1000).catch(() => []),
    ]);

    // Load full SQ records for recent signals (up to 100 for display)
    const recentIdx  = sqIndex.slice(0, 100);
    const sqRecords  = await Promise.all(recentIdx.map(e => loadSQRecord(r, e.id)));
    const sqRecordMap = new Map();
    for (let i = 0; i < recentIdx.length; i++) {
      if (sqRecords[i]) sqRecordMap.set(recentIdx[i].id, sqRecords[i]);
    }

    // Build recent signal log (all from SQ index, up to 50 most recent)
    const recentSignals = recentIdx.slice(0, 50).map(e => {
      const rec = sqRecordMap.get(e.id);
      return {
        id:             e.id,
        ts:             e.ts,
        assetId:        e.assetId,
        template:       e.template,
        direction:      rec?.direction || null,
        pass:           e.pass,
        qualityTier:    e.qualityTier,
        blockedBy:      e.blockedBy  || null,
        adverseBy:      e.adverseBy  || null,
        wickRatio:      rec?.wick?.wickRatio ?? null,
        // Session v17 structural scoring
        sessionGrade:   e.sessionGrade || rec?.session?.grade || null,
        sessionScore:   rec?.session?.sessionScore ?? null,
        sessionChecks:  rec?.session?.checks       || null,
        scoreAvailable: rec?.session?.scoreAvailable ?? null,
        // Legacy field — kept so sparklines work for signals recorded before v17
        withPriorSession: rec?.session?.withPriorSession ?? null,
        cvdLowTrust:    rec?.cvd?.cvdLowTrust  ?? null,
        cvdDivergence:  rec?.cvd?.cvdDivergence ?? null,
      };
    });

    // Fuzzy-join closed recognition memory trades with SQ records
    const closedTrades = allTrades.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
    const sqAll        = sqIndex; // full index for join

    const joined = closedTrades.map(trade => {
      // Skip template filter when trade.template is null (reconstructed trades).
      // Asset + 15-min window is unambiguous: one position per asset at a time.
      const match = sqAll.find(e =>
        e.assetId === trade.asset &&
        (trade.template == null || e.template === trade.template) &&
        Math.abs(e.ts - trade.openedAt) < JOIN_TOL
      );
      return {
        ...trade,
        qualityTier:      trade.qualityTier || match?.qualityTier || null,
        blockedBy:        match?.blockedBy   || null,
        hasSQRecord:      !!match,
      };
    });

    // WR stats by quality tier
    const byTier = { A: [], B: [], C: [], D: [], unknown: [] };
    for (const t of joined) {
      const k = t.qualityTier || 'unknown';
      if (byTier[k]) byTier[k].push(t);
      else byTier.unknown.push(t);
    }

    const tierStats = {};
    for (const [tier, trades] of Object.entries(byTier)) {
      const st = wrStats(trades);
      tierStats[tier] = {
        ...st,
        label: {
          A: 'all gates pass + full data (highest confidence)',
          B: 'passes gate — missing some data (benefit of doubt)',
          C: '1 gate triggered → blocked',
          D: '2+ gates triggered → blocked',
          unknown: 'no quality record (pre-v16 or shadow join miss)',
        }[tier] || tier,
      };
    }

    // WR stats: passed vs blocked
    const passed  = joined.filter(t => !t.blockedBy);
    const blocked = joined.filter(t =>  t.blockedBy);

    // Gate coverage: how many SQ index entries vs closed trades
    const sqCoverage = {
      totalClosedTrades: closedTrades.length,
      withSQRecord:      joined.filter(t => t.hasSQRecord).length,
      totalSQSignals:    sqIndex.length,
      passedSignals:     sqIndex.filter(e => e.pass).length,
      blockedSignals:    sqIndex.filter(e => !e.pass).length,
    };

    return res.status(200).json({
      ok:          true,
      generatedAt: Date.now(),
      config,
      sqCoverage,
      tierStats,
      passedVsBlocked: {
        passed:  wrStats(passed),
        blocked: wrStats(blocked),
      },
      recentSignals,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
