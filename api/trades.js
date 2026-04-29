/* eslint-disable */
// V10 — api/trades.js
// Replaces V9's binary "crown" system with Bayesian Beta-distribution scoring.
// Aggregates trade outcomes both at the raw-tactic level (V9 archive, preserved)
// and at the family level (V10 primary).
//
// Storage:
//   v10:family:{sym}:{family}        -> { wins, losses, totalPnl, regimes:{}, sessions:{}, trades:[...] }
//   v10:family-global:{family}       -> aggregated across all symbols
//   v9:strat:{sym}:{strat}           -> V9 archive — left untouched, written-through for backward compat
//
// Endpoints:
//   GET  /api/trades?action=lab                       -> full lab snapshot (families + V9 archive view)
//   GET  /api/trades?action=family&sym=X              -> single symbol family stats
//   GET  /api/trades?action=universe                  -> family stats across all symbols
//   GET  /api/trades?action=set-config                -> noop placeholder for V9 compat
//   POST /api/trades                                  -> record a closed trade
//   POST /api/trades?action=migrate-v9                -> one-time V9 -> V10 family rollup
//   POST /api/trades?action=set-config                -> persist user instruments/sessions/risk

const {
  getRedis, applyCors, normSym, instCategory, safeParse,
  TACTIC_FAMILY_MAP, FAMILY_META, tacticFamily,
  betaMean, betaCI, betaSample,
} = require('./_lib');

const FAMILIES = Object.keys(FAMILY_META).filter(f => f !== 'UNKNOWN');

// === Family record helpers ===
function emptyFamilyRecord() {
  return {
    wins: 0, losses: 0, totalPnl: 0,
    regimes:  {},   // { TRENDING: n, RANGING: n, ... }
    sessions: {},   // { LONDON: n, NY: n, OVERLAP: n, ASIAN: n }
    rawTactics: {}, // { 'TREND_H4+MOM_S': n }  -- track which raw tactics rolled up
    trades:   [],   // last 50 trades only -- avoid unbounded growth
    firstSeen: new Date().toISOString(),
    lastUpdate: null,
  };
}

async function getFamilyRecord(sym, family) {
  const r = getRedis(); if (!r) return emptyFamilyRecord();
  const raw = await r.get('v10:family:' + sym + ':' + family).catch(() => null);
  const data = safeParse(raw);
  return (data && typeof data === 'object') ? data : emptyFamilyRecord();
}

async function saveFamilyRecord(sym, family, record) {
  const r = getRedis(); if (!r) return false;
  return await r.set('v10:family:' + sym + ':' + family, JSON.stringify(record)).catch(() => false);
}

// === V9 archive helpers (preserved for nostalgia + backward compat) ===
async function getV9Record(sym, strat) {
  const r = getRedis(); if (!r) return null;
  const raw = await r.get('v9:strat:' + sym + ':' + strat).catch(() => null);
  return safeParse(raw);
}

async function saveV9Record(sym, strat, record) {
  const r = getRedis(); if (!r) return false;
  return await r.set('v9:strat:' + sym + ':' + strat, JSON.stringify(record)).catch(() => false);
}

// === Record a closed trade — primary write path ===
async function recordTrade({ symbol, strategy, pnl, won, positionId, session, regime, family, opened, closed }) {
  if (!symbol || !strategy) return { error: 'symbol + strategy required' };
  const sym = normSym(symbol);
  const fam = family || tacticFamily(strategy);
  const ts  = new Date().toISOString();

  // 1. Idempotency check at family level
  const famRec = await getFamilyRecord(sym, fam);
  if (positionId) {
    const dup = (famRec.trades || []).some(t => String(t.positionId) === String(positionId));
    if (dup) return { skipped: true, reason: 'positionId already recorded', positionId };
  }

  // 2. Update family record
  if (won) famRec.wins += 1; else famRec.losses += 1;
  famRec.totalPnl = (famRec.totalPnl || 0) + (pnl || 0);
  if (regime)  famRec.regimes[regime]   = (famRec.regimes[regime]  || 0) + 1;
  if (session) famRec.sessions[session] = (famRec.sessions[session] || 0) + 1;
  famRec.rawTactics[strategy] = (famRec.rawTactics[strategy] || 0) + 1;
  famRec.trades = (famRec.trades || []).concat({
    ts, positionId: positionId || null, pnl, won, regime, session, rawTactic: strategy,
    opened: opened || null, closed: closed || null,
  }).slice(-50);
  famRec.lastUpdate = ts;
  await saveFamilyRecord(sym, fam, famRec);

  // 3. Write-through to V9 archive (preserves 3 weeks of testing data with the same dedup logic)
  const v9rec = (await getV9Record(sym, strategy)) || {
    wins: 0, losses: 0, totalPnl: 0, trades: [], firstSeen: ts, family: fam,
  };
  if (positionId && (v9rec.trades || []).some(t => String(t.positionId) === String(positionId))) {
    // already in v9 too, skip
  } else {
    if (won) v9rec.wins += 1; else v9rec.losses += 1;
    v9rec.totalPnl = (v9rec.totalPnl || 0) + (pnl || 0);
    v9rec.trades = (v9rec.trades || []).concat({ ts, positionId: positionId || null, pnl, won, session }).slice(-100);
    v9rec.lastUpdate = ts;
    v9rec.family = fam;
    await saveV9Record(sym, strategy, v9rec);
  }

  return {
    recorded: true,
    family: fam,
    familyMean: betaMean(famRec.wins, famRec.losses),
    familyCI: betaCI(famRec.wins, famRec.losses),
    totalTrades: famRec.wins + famRec.losses,
  };
}

// === Read paths ===
async function readFamilyForSymbol(sym) {
  const out = {};
  for (const fam of FAMILIES) {
    const rec = await getFamilyRecord(sym, fam);
    const total = (rec.wins || 0) + (rec.losses || 0);
    if (total > 0) {
      const mean = betaMean(rec.wins, rec.losses);
      const ci = betaCI(rec.wins, rec.losses);
      out[fam] = {
        ...rec,
        total,
        winRate:    Math.round(mean * 100),
        confidence: Math.round((1 - (ci[1] - ci[0])) * 100),  // tighter CI = more confidence
        ci: [Math.round(ci[0] * 100), Math.round(ci[1] * 100)],
        expectancy: total > 0 ? rec.totalPnl / total : 0,
        meta: FAMILY_META[fam],
      };
    } else {
      out[fam] = { wins: 0, losses: 0, total: 0, totalPnl: 0, meta: FAMILY_META[fam] };
    }
  }
  return out;
}

async function readUniverse() {
  const r = getRedis(); if (!r) return {};
  // Scan all v10:family:* keys
  const keys = [];
  let cursor = 0;
  do {
    const result = await r.scan(cursor, { match: 'v10:family:*', count: 200 }).catch(() => [0, []]);
    cursor = parseInt(result[0], 10);
    keys.push(...result[1]);
  } while (cursor !== 0);

  // Group by symbol
  const out = {};
  for (const k of keys) {
    // v10:family:XAUUSD:TREND
    const parts = k.split(':');
    if (parts.length !== 4) continue;
    const sym = parts[2], fam = parts[3];
    if (!out[sym]) out[sym] = {};
    const rec = safeParse(await r.get(k).catch(() => null));
    if (rec) {
      const total = (rec.wins || 0) + (rec.losses || 0);
      const mean = total > 0 ? betaMean(rec.wins, rec.losses) : 0.5;
      const ci = betaCI(rec.wins || 0, rec.losses || 0);
      out[sym][fam] = {
        wins: rec.wins || 0,
        losses: rec.losses || 0,
        total,
        totalPnl: rec.totalPnl || 0,
        winRate: Math.round(mean * 100),
        ci: [Math.round(ci[0] * 100), Math.round(ci[1] * 100)],
        expectancy: total > 0 ? rec.totalPnl / total : 0,
        meta: FAMILY_META[fam],
      };
    }
  }
  return out;
}

// V9 archive read — list every raw strategy we know about, with its family classification
async function readV9Archive() {
  const r = getRedis(); if (!r) return [];
  const keys = [];
  let cursor = 0;
  do {
    const result = await r.scan(cursor, { match: 'v9:strat:*', count: 200 }).catch(() => [0, []]);
    cursor = parseInt(result[0], 10);
    keys.push(...result[1]);
  } while (cursor !== 0);

  const out = [];
  for (const k of keys) {
    const parts = k.split(':');
    if (parts.length !== 4) continue;
    const sym = parts[2], strat = parts[3];
    const rec = safeParse(await r.get(k).catch(() => null));
    if (rec) {
      const total = (rec.wins || 0) + (rec.losses || 0);
      out.push({
        symbol: sym,
        strategy: strat,
        family: rec.family || tacticFamily(strat),
        wins: rec.wins || 0,
        losses: rec.losses || 0,
        totalPnl: rec.totalPnl || 0,
        total,
        winRate: total > 0 ? Math.round((rec.wins / total) * 100) : null,
      });
    }
  }
  return out;
}

// === Migration: V9 -> V10 family rollup (one-time, idempotent) ===
async function migrateV9ToV10() {
  const r = getRedis(); if (!r) return { error: 'no redis' };
  const v9items = await readV9Archive();
  let migrated = 0, skipped = 0;
  for (const item of v9items) {
    const fam = item.family;
    if (!fam || fam === 'UNKNOWN') { skipped++; continue; }
    const famRec = await getFamilyRecord(item.symbol, fam);
    // Idempotency: track which V9 strats have already been migrated using a marker
    famRec._migratedFrom = famRec._migratedFrom || {};
    if (famRec._migratedFrom[item.strategy]) { skipped++; continue; }
    famRec._migratedFrom[item.strategy] = { wins: item.wins, losses: item.losses, pnl: item.totalPnl, ts: Date.now() };
    famRec.wins   += item.wins;
    famRec.losses += item.losses;
    famRec.totalPnl = (famRec.totalPnl || 0) + (item.totalPnl || 0);
    famRec.rawTactics[item.strategy] = (famRec.rawTactics[item.strategy] || 0) + (item.wins + item.losses);
    famRec.lastUpdate = new Date().toISOString();
    await saveFamilyRecord(item.symbol, fam, famRec);
    migrated++;
  }
  return { migrated, skipped, totalV9Records: v9items.length };
}

// === User config (instruments / sessions / riskMode) — V9 compat ===
async function setConfig(body) {
  const r = getRedis(); if (!r) return { error: 'no redis' };
  await r.set('v9:config', JSON.stringify({
    instruments: body.instruments || [],
    sessions:    body.sessions    || ['LONDON', 'NEW YORK'],
    riskMode:    body.riskMode    || 'TEST',
    updated:     Date.now(),
  })).catch(() => {});
  return { saved: true };
}

async function getConfig() {
  const r = getRedis(); if (!r) return {};
  const raw = await r.get('v9:config').catch(() => null);
  return safeParse(raw) || {};
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // POST handlers
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    if (!body) return res.status(400).json({ error: 'Invalid body' });

    if (body.action === 'set-config') {
      return res.status(200).json(await setConfig(body));
    }
    if (body.action === 'migrate-v9') {
      return res.status(200).json(await migrateV9ToV10());
    }
    // Default: record a closed trade
    return res.status(200).json(await recordTrade(body));
  }

  // GET handlers
  if (req.method === 'GET') {
    const action = String(req.query.action || 'lab');

    if (action === 'set-config') {
      // V9 frontend sometimes hits this as GET — noop with current config
      return res.status(200).json(await getConfig());
    }
    if (action === 'config') {
      return res.status(200).json(await getConfig());
    }
    if (action === 'family') {
      const sym = String(req.query.sym || req.query.symbol || '').toUpperCase();
      if (!sym) return res.status(400).json({ error: 'sym required' });
      return res.status(200).json(await readFamilyForSymbol(sym));
    }
    if (action === 'universe') {
      return res.status(200).json(await readUniverse());
    }
    if (action === 'v9-archive') {
      return res.status(200).json(await readV9Archive());
    }
    if (action === 'lab') {
      // Combined view used by frontend
      const [universe, archive, config] = await Promise.all([
        readUniverse(),
        readV9Archive(),
        getConfig(),
      ]);
      return res.status(200).json({ universe, archive, config, ts: Date.now() });
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports.recordTrade           = recordTrade;
module.exports.getFamilyRecord       = getFamilyRecord;
module.exports.readFamilyForSymbol   = readFamilyForSymbol;
module.exports.readUniverse          = readUniverse;
module.exports.readV9Archive         = readV9Archive;
module.exports.migrateV9ToV10        = migrateV9ToV10;
module.exports.FAMILIES              = FAMILIES;