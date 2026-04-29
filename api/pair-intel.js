/* eslint-disable */
// V10 — api/pair-intel.js
// Pair Intelligence Engine.
//
// Hourly scan: scores every major + commodity pair 0-100 based on:
//   - Current regime (trending pairs score higher when our crowned families fit)
//   - Recent realized volatility (ATR percentile)
//   - Active session match
//   - Historical family performance on this pair
//   - Divergence flag (if pair just broke out vs correlated peers)
//
// Output per pair:
//   { sym, score, regime, recommendation, reasons:[], badges:[] }
//
// Recommendations: AVOID / NEUTRAL / FAVORED / NEW (not currently in user's instruments)

const {
  getRedis, applyCors, normSym, instCategory, safeParse, selfBase, betaMean,
} = require('./_lib');
const { getRegimeFor } = require('./regime');

// Universe of tradeable pairs we score every hour
const UNIVERSE = [
  'XAUUSD', 'XAGUSD',
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'NZDUSD', 'USDCAD',
  'EURJPY', 'GBPJPY', 'EURGBP', 'AUDJPY', 'CADJPY', 'CHFJPY',
  'EURAUD', 'EURNZD', 'EURCAD', 'GBPAUD', 'GBPCAD', 'GBPNZD',
  'AUDCAD', 'AUDNZD', 'NZDCAD',
  'BTCUSD', 'ETHUSD',
  'NAS100', 'US30', 'SPX500',
];

// Correlation clusters — pairs that move together. Max 1 open position per cluster.
const CORRELATION_CLUSTERS = {
  'USD_LONG_EUR':   ['EURUSD', 'GBPUSD', 'EURGBP'],          // long-EUR vs USD
  'USD_LONG_AUD':   ['AUDUSD', 'NZDUSD'],                    // commodity FX
  'USD_LONG_CAD':   ['USDCAD', 'AUDCAD', 'NZDCAD'],
  'JPY_CROSSES':    ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'CHFJPY'],
  'GOLD_SILVER':    ['XAUUSD', 'XAGUSD'],                    // both precious metals
  'INDICES':        ['NAS100', 'US30', 'SPX500'],
  'CRYPTO':         ['BTCUSD', 'ETHUSD'],
};

// Find which cluster a symbol belongs to (for correlation cap enforcement)
function clusterFor(sym) {
  const s = normSym(sym);
  for (const [name, members] of Object.entries(CORRELATION_CLUSTERS)) {
    if (members.includes(s)) return name;
  }
  return null;
}

// Load family stats for a symbol (built by trades.js V10)
async function loadFamilyStats(sym) {
  const r = getRedis(); if (!r) return {};
  const families = ['TREND', 'REVERSION', 'STRUCTURE', 'BREAKOUT', 'RANGE', 'NEWS'];
  const out = {};
  for (const fam of families) {
    const raw = await r.get('v10:family:' + sym + ':' + fam).catch(() => null);
    if (raw) {
      const data = safeParse(raw);
      if (data) out[fam] = data;
    }
  }
  return out;
}

// Score a single pair
async function scorePair(sym) {
  const reasons = [];
  const badges = [];
  let score = 50; // neutral baseline

  // 1. Regime + chaos
  const reg = await getRegimeFor(sym).catch(() => null);
  const regimeName = reg && reg.regime ? reg.regime : 'UNKNOWN';
  if (regimeName === 'TRENDING') { score += 15; reasons.push('Trending regime'); badges.push({ label: 'TRENDING', color: '#3b82f6' }); }
  else if (regimeName === 'RANGING') { score += 8; reasons.push('Range-bound (good for reversion)'); badges.push({ label: 'RANGING', color: '#10b981' }); }
  else if (regimeName === 'VOLATILE') { score -= 5; reasons.push('Volatile -- caution'); badges.push({ label: 'VOLATILE', color: '#ef4444' }); }
  else if (regimeName === 'QUIET') { score -= 3; reasons.push('Quiet (low ATR)'); badges.push({ label: 'QUIET', color: '#94a3b8' }); }
  else if (regimeName === 'MIXED') { score -= 8; reasons.push('No clear regime'); }

  if (reg && reg.chaos && reg.chaos.chaos) {
    score -= 25;
    reasons.push('CHAOS detected (1m/1h ATR ratio ' + reg.chaos.ratio + 'x) -- avoid');
    badges.push({ label: 'CHAOS', color: '#dc2626' });
  }

  // 2. Family stats — best family on this pair
  const stats = await loadFamilyStats(sym);
  let bestFamily = null;
  let bestWR = 0;
  let totalTrades = 0;
  for (const [fam, s] of Object.entries(stats)) {
    const t = (s.wins || 0) + (s.losses || 0);
    totalTrades += t;
    if (t >= 3) {
      const wr = betaMean(s.wins, s.losses) * 100;
      if (wr > bestWR) { bestWR = wr; bestFamily = fam; }
    }
  }
  if (bestFamily && bestWR >= 60) { score += 15; reasons.push(bestFamily + ' family ' + Math.round(bestWR) + '% WR'); }
  else if (bestFamily && bestWR >= 50) { score += 5; reasons.push(bestFamily + ' family ' + Math.round(bestWR) + '% WR'); }
  else if (totalTrades >= 10 && bestWR < 45) { score -= 10; reasons.push('All families underperforming'); }
  if (totalTrades < 5) { score -= 5; reasons.push('Untested (' + totalTrades + ' trades)'); badges.push({ label: 'NEW', color: '#a855f7' }); }

  // 3. Session match — UTC hour gives expected session
  const utcH = new Date().getUTCHours();
  const cat = instCategory(sym);
  if (cat === 'CRYPTO') {
    if (utcH >= 7 && utcH < 23) { /* always good */ } else { score -= 10; reasons.push('Outside crypto hours'); }
  } else {
    if (utcH >= 8 && utcH < 18) {
      if (utcH >= 13 && utcH < 16) { score += 5; reasons.push('London/NY overlap'); }
      else if (utcH >= 8 && utcH < 13) { score += 3; reasons.push('London session'); }
      else if (utcH >= 16 && utcH < 18) { score += 1; reasons.push('Early NY'); }
    } else { score -= 15; reasons.push('Outside trading window'); }
  }

  score = Math.max(0, Math.min(100, score));

  // Recommendation tier
  let recommendation = 'NEUTRAL';
  if (score >= 70) recommendation = 'FAVORED';
  else if (score >= 50) recommendation = 'NEUTRAL';
  else if (score >= 30) recommendation = 'CAUTION';
  else recommendation = 'AVOID';

  return {
    sym: normSym(sym),
    score,
    regime: regimeName,
    recommendation,
    bestFamily,
    bestWR: Math.round(bestWR),
    totalTrades,
    chaos: reg && reg.chaos ? reg.chaos : null,
    cluster: clusterFor(sym),
    reasons,
    badges,
    ts: Date.now(),
  };
}

// Score the whole universe — used for hourly cron and the Live page recommendations widget
async function scoreUniverse(userInstruments) {
  const userSet = new Set((userInstruments || []).map(normSym));
  // Score in batches of 5 (parallel-ish, but not too many concurrent broker calls)
  const results = [];
  for (let i = 0; i < UNIVERSE.length; i += 5) {
    const batch = UNIVERSE.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(scorePair));
    results.push(...batchResults);
  }
  // Mark which ones are user's current instruments
  for (const r of results) r.inUserSet = userSet.has(r.sym);
  // Sort by score desc
  results.sort((a, b) => b.score - a.score);
  return results;
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    const action = String(req.query.action || 'universe');

    if (action === 'pair') {
      const sym = String(req.query.symbol || '').toUpperCase();
      if (!sym) return res.status(400).json({ error: 'symbol required' });
      return res.status(200).json(await scorePair(sym));
    }

    if (action === 'universe') {
      // Try cached first
      const r = getRedis();
      if (r) {
        const cached = await r.get('v10:pair-intel:universe').catch(() => null);
        if (cached) {
          const parsed = safeParse(cached);
          if (parsed && parsed.ts && Date.now() - parsed.ts < 30 * 60 * 1000) {
            return res.status(200).json(parsed);
          }
        }
      }
      // Otherwise compute fresh (slow — only do this if cache is empty/stale)
      const userInstr = String(req.query.userInstruments || '').split(',').filter(Boolean);
      const results = await scoreUniverse(userInstr);
      const out = { universe: results, ts: Date.now() };
      if (r) await r.set('v10:pair-intel:universe', JSON.stringify(out), { ex: 60 * 60 }).catch(() => {});
      return res.status(200).json(out);
    }

    if (action === 'cluster') {
      const sym = String(req.query.symbol || '').toUpperCase();
      return res.status(200).json({ sym: normSym(sym), cluster: clusterFor(sym) });
    }
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    if (body && body.action === 'rescan') {
      // Force fresh scan and cache
      const userInstr = body.userInstruments || [];
      const results = await scoreUniverse(userInstr);
      const out = { universe: results, ts: Date.now() };
      const r = getRedis();
      if (r) await r.set('v10:pair-intel:universe', JSON.stringify(out), { ex: 60 * 60 }).catch(() => {});
      return res.status(200).json(out);
    }
  }

  return res.status(400).json({ error: 'Invalid request' });
};

module.exports.scorePair      = scorePair;
module.exports.scoreUniverse  = scoreUniverse;
module.exports.clusterFor     = clusterFor;
module.exports.UNIVERSE       = UNIVERSE;
module.exports.CORRELATION_CLUSTERS = CORRELATION_CLUSTERS;