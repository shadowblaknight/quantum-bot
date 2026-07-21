'use strict';
/* eslint-disable */
// api/analyst.js  v15.7
// GET  /api/analyst          → returns cached brief (if < 30 min old)
// GET  /api/analyst?refresh=1  → recomputes regardless of cache
//
// Aggregates health, performance, anomalies, and recommendations from all
// shadow systems and performance endpoints. Caches computed brief in Redis
// (30-min TTL, key v14:analyst:brief:latest). Returns _fromCache:true when served
// from cache so the UI can show the cached age.
//
// SAFETY: GET-only. No imports from execute.js or any placement module.
// No write path. The only Redis writes are the brief cache and the shadow growth
// snapshot (v14:analyst:shadow:prev-counts), both of which are analyst-internal.

const { applyCors, getRedis, safeParse, selfBase } = require('./_lib');

const CACHE_KEY        = 'v14:analyst:brief:latest';
const GROWTH_KEY       = 'v14:analyst:shadow:prev-counts';
const CACHE_TTL_SEC    = 30 * 60;   // 30 minutes
const FETCH_TIMEOUT_MS = 12_000;    // per sub-endpoint
const MIN_N            = 8;

// ── Shadow system registry ───────────────────────────────────────────────────
// These are the three dedupeKey-based systems. Regime uses signalId; handled
// separately from the regime-detector?action=shadow-summary response.
const SHADOW_SYSTEMS = [
  {
    name:          'entrystyle',
    label:         'Entry Style (imm vs retest)',
    indexKey:      'v14:entrystyle:shadow:index',
    recordKey:     (id) => `v14:entrystyle:shadow:${id}`,
    idField:       'id',           // field in index entry that is the record id
    resolvedField: 'resolvedAt',   // non-null → record is evaluated by the evaluator
    resolvedViaLedger: false,
  },
  {
    name:          'orderflow',
    label:         'Order Flow (CVD)',
    indexKey:      'v14:orderflow:shadow:index',
    recordKey:     (id) => `v14:orderflow:shadow:${id}`,
    idField:       'id',
    resolvedField: null,
    resolvedViaLedger: true,  // "resolved" means joined to a closed ledger trade
  },
  {
    name:          'sessionctx',
    label:         'Session Context (liq/Asian/London)',
    indexKey:      'v14:sessionctx:shadow:index',
    recordKey:     (id) => `v14:sessionctx:shadow:${id}`,
    idField:       'id',
    resolvedField: null,
    resolvedViaLedger: true,
  },
];

// ── Safe fetch with timeout ──────────────────────────────────────────────────
async function fetchEndpoint(path) {
  const base = selfBase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/${path}`, {
      signal:  ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, _unavailable: true };
    const data = await res.json();
    if (!data) return { ok: false, error: 'empty response', _unavailable: true };
    return data;
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.message || 'fetch-error', _unavailable: true };
  }
}

// ── Ledger loader ────────────────────────────────────────────────────────────
async function loadLedger(r) {
  const idxRaw = await r.get('v14:ledger:index').catch(() => null);
  const index  = safeParse(idxRaw) || [];
  if (!index.length) return [];
  try {
    const pipe    = r.pipeline();
    for (const e of index) pipe.get(`v14:ledger:trade:${e.id}`);
    const results = await pipe.exec();
    return results
      .map(raw => {
        const v = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
        return (v && typeof v === 'object') ? v : null;
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// ── A. Shadow health ─────────────────────────────────────────────────────────
async function computeShadowHealth(r, ledger, summaries) {
  const now          = Date.now();
  const closedKeys   = new Set(
    ledger
      .filter(t => t.outcome && t.outcome !== 'OPEN' && t.dedupeKey)
      .map(t => t.dedupeKey)
  );
  const health = {};

  for (const sys of SHADOW_SYSTEMS) {
    const idxRaw = await r.get(sys.indexKey).catch(() => null);
    const idx    = safeParse(idxRaw) || [];
    const written    = idx.length;
    const lastEntry  = idx[0] || null;   // index is newest-first
    const lastWriteTs = lastEntry?.ts || null;
    const ageMs      = lastWriteTs ? now - lastWriteTs : null;

    // Sample up to 200 records to count joined + resolved
    let joined = 0, resolved = 0;
    const sampleIds = idx.slice(0, 200).map(e => e[sys.idField]);
    if (sampleIds.length > 0) {
      try {
        const pipe  = r.pipeline();
        for (const id of sampleIds) pipe.get(sys.recordKey(id));
        const raws  = await pipe.exec();
        for (const raw of raws) {
          const rec = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null;
          if (!rec) continue;
          const key = rec.id;
          if (closedKeys.has(key)) joined++;
          if (sys.resolvedViaLedger) {
            if (closedKeys.has(key)) resolved++;
          } else if (sys.resolvedField && rec[sys.resolvedField] != null) {
            resolved++;
          }
        }
      } catch (_) {}
    }

    // Compute "how many more resolved records before first n=8 verdict"
    let maxBucketN     = 0;
    let neededForVerdict = null;
    const sm = summaries[sys.name];
    if (sm && !sm._unavailable) {
      if (sys.name === 'entrystyle' && sm.byTemplateSession) {
        for (const cell of Object.values(sm.byTemplateSession)) {
          if ((cell?.nResolved || 0) > maxBucketN) maxBucketN = cell.nResolved;
        }
      } else if (sys.name === 'orderflow' && sm.byConfirms) {
        const cands = [
          sm.byConfirms?.confirmed?.n,
          sm.byConfirms?.unconfirmed?.n,
        ];
        for (const n of cands) if (n > maxBucketN) maxBucketN = n;
      } else if (sys.name === 'sessionctx') {
        const cands = [
          sm.byLiqCoincidence?.coincident?.n,
          sm.byLiqCoincidence?.nonCoincident?.n,
          sm.byWithPriorSession?.withSession?.n,
          sm.byWithPriorSession?.againstSession?.n,
        ];
        for (const n of cands) if (n != null && n > maxBucketN) maxBucketN = n;
      }
      neededForVerdict = Math.max(0, MIN_N - maxBucketN);
    }

    // Status classification
    let status, statusCode;
    if (written === 0) {
      status     = 'WRITE BROKEN — Pine not emitting, or alerts not recreated';
      statusCode = 'broken-write';
    } else if (ageMs != null && ageMs > 48 * 3600_000) {
      status     = `STALE — no signals in ${Math.round(ageMs / 3600_000)}h`;
      statusCode = 'stale';
    } else if (written > 0 && joined === 0) {
      status     = 'JOIN BROKEN — dedupeKey missing on historical trades (new trades will populate)';
      statusCode = 'broken-join';
    } else if (sys.resolvedField && joined > 0 && resolved === 0) {
      status     = 'EVALUATOR NOT RUNNING';
      statusCode = 'no-evaluator';
    } else {
      status     = 'HEALTHY — collecting';
      statusCode = 'healthy';
    }

    health[sys.name] = {
      label: sys.label,
      written,
      joined,
      resolved,
      lastWriteTs,
      ageHours:        ageMs != null ? Math.round(ageMs / 360_000) / 10 : null,
      status,
      statusCode,
      maxBucketN,
      neededForVerdict,
    };
  }

  // Regime: derive from regime shadow-summary response (different join logic)
  const regSm = summaries.regime;
  const regIdxRaw = await r.get('v14:regime:shadow:index').catch(() => null);
  const regIdx    = safeParse(regIdxRaw) || [];
  const regLast   = regIdx[0] || null;
  const regLastTs = regLast?.ts || null;
  const regAgeMs  = regLastTs ? now - regLastTs : null;

  let regStatus = 'HEALTHY — collecting';
  let regCode   = 'healthy';
  if (regIdx.length === 0) {
    regStatus = 'WRITE BROKEN — regime detector not called on signals';
    regCode   = 'broken-write';
  } else if (regAgeMs != null && regAgeMs > 48 * 3600_000) {
    regStatus = `STALE — no signals in ${Math.round(regAgeMs / 3600_000)}h`;
    regCode   = 'stale';
  }

  const regMatched = regSm?.matchedToLedger ?? 0;
  // Largest bucket from byRegime
  let regMaxN = 0;
  if (regSm?.byRegime) {
    for (const row of regSm.byRegime) {
      if ((row?.trades?.length || row?.total || 0) > regMaxN) {
        regMaxN = row?.trades?.length || row?.total || 0;
      }
    }
  }

  health.regime = {
    label:           'Regime Detector',
    written:         regIdx.length,
    joined:          regMatched,
    resolved:        regMatched,
    lastWriteTs:     regLastTs,
    ageHours:        regAgeMs != null ? Math.round(regAgeMs / 360_000) / 10 : null,
    status:          regStatus,
    statusCode:      regCode,
    maxBucketN:      regMaxN,
    neededForVerdict: Math.max(0, MIN_N - regMaxN),
  };

  return health;
}

// ── C. Anomaly detection ─────────────────────────────────────────────────────
function computeAnomalies(ledger, rankingData) {
  const anomalies = [];

  // 1. Reconciliation math
  if (rankingData?.ok && rankingData.reconciliation) {
    const rec = rankingData.reconciliation;
    const sumParts   = (rec.matched || 0) + (rec.ledgerOnly || 0) + (rec.recogOnly || 0);
    const sumRankable = (rec.rankable || 0) + (rec.filteredOut || 0);
    if (rec.total != null && sumParts !== rec.total) {
      anomalies.push({
        code:     'recon-total-mismatch',
        severity: 'warn',
        message:  `Reconciliation total mismatch: matched(${rec.matched})+ledgerOnly(${rec.ledgerOnly})+recogOnly(${rec.recogOnly})=${sumParts} ≠ reported total ${rec.total}`,
      });
    }
    if (rec.total != null && sumRankable !== rec.total) {
      anomalies.push({
        code:     'recon-rankable-mismatch',
        severity: 'warn',
        message:  `Reconciliation rankable(${rec.rankable})+filteredOut(${rec.filteredOut})=${sumRankable} ≠ total ${rec.total}`,
      });
    }
  }

  // 2. Ledger records missing dedupeKey
  const missingDedupe = ledger.filter(t => !t.dedupeKey).length;
  if (missingDedupe > 0) {
    anomalies.push({
      code:     'missing-dedupe-key',
      severity: 'info',
      message:  `${missingDedupe} of ${ledger.length} ledger records have no dedupeKey — cannot join to any shadow system (pre-fix trades)`,
    });
  }

  // 3. |actualEntry − plannedEntry| > 0.5 × |plannedEntry − sl| → possible anchor issue
  const anchor = ledger.filter(t => {
    if (t.actualEntry == null || t.plannedEntry == null || t.sl == null) return false;
    const slDist    = Math.abs(t.plannedEntry - t.sl);
    const entryGap  = Math.abs(t.actualEntry  - t.plannedEntry);
    return slDist > 0 && entryGap > 0.5 * slDist;
  });
  if (anchor.length > 0) {
    anomalies.push({
      code:     'entry-anchor-gap',
      severity: 'warn',
      message:  `${anchor.length} trade(s) where |actualEntry−plannedEntry| > 0.5× SL distance — possible anchor or sizing issue`,
      tradeIds: anchor.slice(0, 5).map(t => t.id),
    });
  }

  // 4. Templates with recog signals but zero ledger records
  if (rankingData?.ok && rankingData.trades) {
    const byTemplate = {};
    for (const t of rankingData.trades) {
      const tmpl = t.template;
      if (!tmpl || tmpl === 'unknown') continue;
      if (!byTemplate[tmpl]) byTemplate[tmpl] = { hasLedger: false, hasRecog: false };
      if (t._source === 'ledger' || t._source === 'both') byTemplate[tmpl].hasLedger = true;
      if (t._source === 'recog'  || t._source === 'both') byTemplate[tmpl].hasRecog  = true;
    }
    const firesNoTrade = Object.entries(byTemplate)
      .filter(([, s]) => s.hasRecog && !s.hasLedger)
      .map(([tmpl]) => tmpl);
    if (firesNoTrade.length > 0) {
      anomalies.push({
        code:      'fires-no-trades',
        severity:  'warn',
        message:   `Template(s) have recognition signals but zero ledger records (signals fired, no fill): ${firesNoTrade.join(', ')}`,
        templates: firesNoTrade,
      });
    }
  }

  // 5. Accepted templates with zero trades ever
  const ACCEPTED = [
    'silver-bullet', 'unicorn', 'turtle-soup', 'judas-swing', 'ote-continuation',
    'am-ifvg', 'orb', 'orb-pro', 'reaction', 'reaction-fvg', 'reaction-ifvg',
  ];
  if (rankingData?.ok && rankingData.trades) {
    const seen = new Set(rankingData.trades.map(t => t.template).filter(Boolean));
    const dead = ACCEPTED.filter(tmpl => !seen.has(tmpl));
    if (dead.length > 0) {
      anomalies.push({
        code:      'dead-template',
        severity:  'info',
        message:   `Template(s) in acceptedTemplates with zero recorded trades: ${dead.join(', ')}`,
        templates: dead,
      });
    }
  }

  // 7. pnlR sign disagrees with netPnl sign (WIN recorded as LOSS or vice versa)
  const signMismatch = ledger.filter(t => {
    if (t.pnlR == null || t.netPnl == null || t.pnlR === 0 || t.netPnl === 0) return false;
    return (t.pnlR > 0) !== (t.netPnl > 0);
  });
  if (signMismatch.length > 0) {
    anomalies.push({
      code:     'pnlr-sign-mismatch',
      severity: 'warn',
      message:  `${signMismatch.length} trade(s) where pnlR and netPnl have opposite signs (win/loss direction mismatch)`,
      tradeIds: signMismatch.slice(0, 5).map(t => t.id),
    });
  }

  return anomalies;
}

// ── Anomaly 6: Shadow index growth check ─────────────────────────────────────
async function checkShadowGrowth(r) {
  const prevRaw = await r.get(GROWTH_KEY).catch(() => null);
  const prev    = safeParse(prevRaw) || {};
  const current = {};
  const anomalies = [];

  for (const sys of [...SHADOW_SYSTEMS, { name: 'regime', indexKey: 'v14:regime:shadow:index' }]) {
    const idxRaw = await r.get(sys.indexKey).catch(() => null);
    const idx    = safeParse(idxRaw) || [];
    current[sys.name] = { len: idx.length, lastTs: idx[0]?.ts || null };

    if (prev[sys.name] != null && prev[sys.name].len === idx.length && idx.length > 0) {
      const lastTs = idx[0]?.ts || null;
      const ageH   = lastTs ? Math.round((Date.now() - lastTs) / 3600_000) : null;
      if (ageH != null && ageH >= 48) {
        anomalies.push({
          code:     'shadow-not-growing',
          severity: 'warn',
          message:  `Shadow index for "${sys.name}" unchanged since last analyst check (${idx.length} records, last signal ${ageH}h ago)`,
        });
      }
    }
  }

  await r.set(GROWTH_KEY, JSON.stringify(current), { ex: CACHE_TTL_SEC * 6 }).catch(() => {});
  return anomalies;
}

// ── D. Recommendations ───────────────────────────────────────────────────────
function computeRecommendations(perfAnalysis, shadowHealth, anomalies) {
  const recs = [];

  // From perf-analysis bleeders
  for (const b of (perfAnalysis?.bleeders || [])) {
    if (b.n < MIN_N) continue;  // never recommend from sub-8 bucket
    const tag = b.n >= MIN_N && b.wrVsBE != null ? 'CONFIRMED' : 'SUGGESTIVE';
    recs.push({
      type:    'bleeder',
      tag,
      message: `Bleeder: ${b.template}${b.tier ? '×' + b.tier : ''}${b.session ? '×' + b.session : ''} — n=${b.n}, WR=${pct(b.winRate)}, BE=${pct(b.breakEvenWR)}, net=${usd(b.netPnl)}. Consider restricting.`,
      evidence: { n: b.n, winRate: b.winRate, breakEvenWR: b.breakEvenWR, netPnl: b.netPnl },
    });
  }

  // From perf-analysis keepers
  for (const k of (perfAnalysis?.keepers || [])) {
    if (k.n < MIN_N) continue;
    recs.push({
      type:    'keeper',
      tag:     'CONFIRMED',
      message: `Keeper: ${k.template}${k.tier ? '×' + k.tier : ''}${k.session ? '×' + k.session : ''} — n=${k.n}, WR=${pct(k.winRate)}, net=${usd(k.netPnl)}. Protect this setup.`,
      evidence: { n: k.n, winRate: k.winRate, netPnl: k.netPnl },
    });
  }

  // From shadow health issues
  for (const [sysName, h] of Object.entries(shadowHealth || {})) {
    if (h.statusCode !== 'healthy') {
      recs.push({
        type:    'shadow-health',
        tag:     'CONFIRMED',
        message: `Shadow system "${h.label}" is unhealthy: ${h.status}. Fix before it wastes another accumulation week.`,
        evidence: { written: h.written, joined: h.joined, resolved: h.resolved, ageHours: h.ageHours },
      });
    }
  }

  // Dead templates
  const deadAnomaly = anomalies.find(a => a.code === 'dead-template');
  if (deadAnomaly) {
    recs.push({
      type:    'dead-template',
      tag:     'CONFIRMED',
      message: `Template(s) ${(deadAnomaly.templates || []).join(', ')} have zero recorded trades. Verify TradingView alerts are created and active.`,
      evidence: { templates: deadAnomaly.templates || [] },
    });
  }

  // Fires but never fills
  const firesAnomaly = anomalies.find(a => a.code === 'fires-no-trades');
  if (firesAnomaly) {
    recs.push({
      type:    'fires-no-trades',
      tag:     'CONFIRMED',
      message: `Template(s) ${(firesAnomaly.templates || []).join(', ')} fire signals but have no ledger fills. Check broker routing or instrument rules.`,
      evidence: { templates: firesAnomaly.templates || [] },
    });
  }

  return recs;
}

function pct(v) { return v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`; }
function usd(v) { return v == null || !isFinite(v) ? '—' : `$${v.toFixed(2)}`; }

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    const refresh = req.query?.refresh === '1';

    // Serve from cache unless refresh requested
    if (!refresh) {
      const cached = await r.get(CACHE_KEY).catch(() => null);
      const brief  = cached ? (typeof cached === 'string' ? safeParse(cached) : cached) : null;
      if (brief?.generatedAt && (Date.now() - brief.generatedAt) < CACHE_TTL_SEC * 1000) {
        return res.status(200).json({ ...brief, _fromCache: true });
      }
    }

    // ── Load in parallel ──────────────────────────────────────────────────────
    const [
      ledger,
      perfAnalysis,
      perfRanking,
      entrystyleSummary,
      orderflowSummary,
      sessionCtxSummary,
      regimeSummary,
    ] = await Promise.all([
      loadLedger(r).catch(() => []),
      fetchEndpoint('perf-analysis'),
      fetchEndpoint('perf-ranking'),
      fetchEndpoint('entrystyle-summary'),
      fetchEndpoint('orderflow-summary'),
      fetchEndpoint('session-context-summary'),
      fetchEndpoint('regime-detector?action=shadow-summary'),
    ]);

    const summaries = {
      entrystyle: entrystyleSummary,
      orderflow:  orderflowSummary,
      sessionctx: sessionCtxSummary,
      regime:     regimeSummary,
    };

    // ── A. Shadow health ──────────────────────────────────────────────────────
    const shadowHealth = await computeShadowHealth(r, ledger, summaries);

    // ── Anomaly 6: growth check ───────────────────────────────────────────────
    const growthAnomalies = await checkShadowGrowth(r);

    // ── C. Anomaly detection ──────────────────────────────────────────────────
    const baseAnomalies = computeAnomalies(ledger, perfRanking);
    const anomalies     = [...baseAnomalies, ...growthAnomalies];

    // ── B. Performance ────────────────────────────────────────────────────────
    // Template stats (netPnl ranking + profitFactor ranking) from perf-ranking trades
    const templateAgg = {};
    if (perfRanking?.ok && Array.isArray(perfRanking.trades)) {
      for (const t of perfRanking.trades) {
        const tmpl = t.template;
        if (!tmpl || tmpl === 'unknown') continue;
        if (!templateAgg[tmpl]) templateAgg[tmpl] = { n: 0, wins: 0, netPnl: 0, winPnl: 0, lossPnl: 0 };
        const s = templateAgg[tmpl];
        s.n++;
        s.netPnl += t.netPnl || 0;
        if (t.outcome === 'WIN')  { s.wins++;  s.winPnl  += t.netPnl || 0; }
        if (t.outcome === 'LOSS') {             s.lossPnl += Math.abs(t.netPnl || 0); }
      }
    }
    for (const s of Object.values(templateAgg)) {
      s.winRate      = s.n > 0 ? s.wins / s.n : 0;
      s.profitFactor = s.lossPnl > 0 ? s.winPnl / s.lossPnl : (s.winPnl > 0 ? 99 : null);
    }
    const tmplByNetPnl = Object.entries(templateAgg)
      .filter(([, s]) => s.n >= MIN_N)
      .sort(([, a], [, b]) => b.netPnl - a.netPnl)
      .map(([tmpl, s]) => ({ template: tmpl, ...s }));
    const tmplByPF = Object.entries(templateAgg)
      .filter(([, s]) => s.n >= MIN_N && s.profitFactor != null)
      .sort(([, a], [, b]) => (b.profitFactor || 0) - (a.profitFactor || 0))
      .map(([tmpl, s]) => ({ template: tmpl, ...s }));

    // ── D. Recommendations ────────────────────────────────────────────────────
    const recommendations = computeRecommendations(perfAnalysis, shadowHealth, anomalies);

    // ── Source availability map ───────────────────────────────────────────────
    const sources = {
      perfAnalysis:     { available: !perfAnalysis._unavailable,    error: perfAnalysis._unavailable    ? perfAnalysis.error    : null },
      perfRanking:      { available: !perfRanking._unavailable,     error: perfRanking._unavailable     ? perfRanking.error     : null },
      entrystyle:       { available: !entrystyleSummary._unavailable, error: entrystyleSummary._unavailable ? entrystyleSummary.error : null },
      orderflow:        { available: !orderflowSummary._unavailable,  error: orderflowSummary._unavailable  ? orderflowSummary.error  : null },
      sessionCtx:       { available: !sessionCtxSummary._unavailable, error: sessionCtxSummary._unavailable ? sessionCtxSummary.error : null },
      regime:           { available: !regimeSummary._unavailable,     error: regimeSummary._unavailable     ? regimeSummary.error     : null },
    };

    // ── Assemble brief ────────────────────────────────────────────────────────
    const brief = {
      ok:           true,
      generatedAt:  Date.now(),
      cacheTtlSec:  CACHE_TTL_SEC,
      sources,
      ledgerTotal:  ledger.length,
      shadowHealth,
      perf: {
        available:          !perfAnalysis._unavailable,
        error:              perfAnalysis._unavailable ? perfAnalysis.error : null,
        keepers:            perfAnalysis?.keepers   || [],
        bleeders:           perfAnalysis?.bleeders  || [],
        collecting:         perfAnalysis?.watchlist || [],
        reconciliation:     perfRanking?.reconciliation || null,
        templateRankByNetPnl: tmplByNetPnl,
        templateRankByPF:     tmplByPF,
      },
      anomalies,
      recommendations,
    };

    // ── Write cache ───────────────────────────────────────────────────────────
    await r.set(CACHE_KEY, JSON.stringify(brief), { ex: CACHE_TTL_SEC }).catch(() => {});

    return res.status(200).json(brief);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
