/* eslint-disable */
// V15.6 — api/entrystyle-summary.js
// GET /api/entrystyle-summary
// Reads resolved entrystyle shadow records from Redis and returns EV stats
// per template×session cell. Consumed by EntryStyleComparisonPanel in App.jsx.

const { applyCors, getRedis, safeParse } = require('./_lib');
const { ES_SHADOW_KEY, ES_SHADOW_INDEX_KEY } = require('./entrystyle-shadow');

// Only templates that genuinely branch between immediate and retest
const DIVERGE_TEMPLATES = new Set([
  'reaction', 'reaction-fvg', 'reaction-ifvg',
  'orb', 'orb-pro',
  'silver-bullet', 'unicorn', 'turtle-soup', 'judas-swing', 'am-ifvg',
]);

function emptyAgg() {
  return {
    n:             0,   // total diverge signals (resolved + open-pending)
    nResolved:     0,   // resolved (immOutcome != null and != 'no-diverge')
    immWins:       0,
    immLosses:     0,
    immOpenCount:  0,
    immTotalR:     0,
    retFills:      0,
    retWins:       0,
    retLosses:     0,
    retOpenCount:  0,
    retTotalR:     0,   // includes 0R for no-fills (used for EV per signal)
    retFillTotalR: 0,   // fills only (excluding no-fill 0R contributions)
  };
}

function accumulate(agg, rec) {
  if (!rec.entryDiverge) return;
  agg.n++;
  if (rec.resolvedAt == null || rec.immOutcome == null || rec.immOutcome === 'no-diverge') return;
  agg.nResolved++;

  // Immediate branch
  if (rec.immR > 0) agg.immWins++;
  else if (rec.immR < 0) agg.immLosses++;
  else agg.immOpenCount++;
  agg.immTotalR += rec.immR || 0;

  // Retest branch
  if (rec.retFilled) {
    agg.retFills++;
    if (rec.retR > 0) agg.retWins++;
    else if (rec.retR < 0) agg.retLosses++;
    else agg.retOpenCount++;
    agg.retFillTotalR += rec.retR || 0;
  }
  agg.retTotalR += rec.retR || 0;  // no-fill → 0R counted here
}

function buildCell(agg) {
  if (agg.nResolved === 0) return null;
  const immEV    = agg.immTotalR / agg.nResolved;
  const retestEV = agg.retTotalR / agg.nResolved;
  // "tie" when EV gap < 0.005R to avoid rounding artifacts
  const gap    = Math.abs(immEV - retestEV);
  const winner = gap < 0.005 ? 'tie' : immEV > retestEV ? 'immediate' : 'retest';
  const nClosed = agg.immWins + agg.immLosses;  // resolved, non-open immediate trades
  return {
    n:         agg.n,
    nResolved: agg.nResolved,
    immediate: {
      n:          agg.nResolved,
      wins:       agg.immWins,
      losses:     agg.immLosses,
      openCount:  agg.immOpenCount,
      winRate:    agg.nResolved > 0 ? agg.immWins / agg.nResolved : 0,
      netR:       agg.immTotalR,
      avgR:       nClosed > 0 ? agg.immTotalR / nClosed : null,  // avg of closed trades only
    },
    retest: {
      n:             agg.nResolved,
      nFilled:       agg.retFills,
      wins:          agg.retWins,
      losses:        agg.retLosses,
      openCount:     agg.retOpenCount,
      winRate:       agg.retFills > 0 ? agg.retWins / agg.retFills : 0,
      fillRate:      agg.nResolved > 0 ? agg.retFills / agg.nResolved : 0,
      netROfFills:   agg.retFillTotalR,
      avgRPerSignal: agg.nResolved > 0 ? agg.retTotalR / agg.nResolved : 0,
    },
    immEV,
    retestEV,
    winner,
  };
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    // Read index
    const rawIdx = await r.get(ES_SHADOW_INDEX_KEY).catch(() => null);
    let idx;
    try { idx = JSON.parse(rawIdx || 'null'); } catch (_) { idx = null; }
    if (!Array.isArray(idx) || idx.length === 0) {
      return res.status(200).json({ ok: false, error: 'not ready' });
    }

    // Load all records in parallel (cap at 500 most recent)
    const slice = idx.slice(0, 500);
    const records = (await Promise.all(
      slice.map(async (e) => {
        try {
          const raw = await r.get(ES_SHADOW_KEY(e.id));
          return safeParse(raw);
        } catch (_) { return null; }
      })
    )).filter(Boolean).filter((rec) => DIVERGE_TEMPLATES.has(rec.template));

    if (records.length === 0) {
      return res.status(200).json({ ok: false, error: 'not ready' });
    }

    // Aggregate by template|session
    const cells = {};
    const totalsAgg = emptyAgg();

    for (const rec of records) {
      const key = `${rec.template}|${rec.session}`;
      if (!cells[key]) cells[key] = emptyAgg();
      accumulate(cells[key], rec);
      accumulate(totalsAgg, rec);
    }

    // Build output shape
    const byTemplateSession = {};
    for (const [k, agg] of Object.entries(cells)) {
      const cell = buildCell(agg);
      if (cell) byTemplateSession[k] = cell;
    }

    const totalsCell = buildCell(totalsAgg) || {
      n: totalsAgg.n, nResolved: 0, immEV: null, retestEV: null, winner: null,
      immediate: null, retest: null,
    };

    // Collect unique templates and sessions present
    const templates = [...new Set(records.map((r) => r.template))].sort();
    const sessions  = [...new Set(records.map((r) => r.session))].sort();

    return res.status(200).json({
      ok: true,
      byTemplateSession,
      templates,
      sessions,
      totals: totalsCell,
      generatedAt: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
