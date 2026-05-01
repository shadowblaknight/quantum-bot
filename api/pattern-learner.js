/* eslint-disable */
// V11 — api/pattern-learner.js
// Runs end-of-day. Reads closed-trade records from Redis (v11:closed:{date}),
// finds patterns where wins/losses correlate with feature combinations, and
// stores the result for the AI to read on subsequent calls.
//
// Two pattern tiers:
//   1. TIGHT — multi-dimension signature (symbol/family/mode/session/regime/aligned)
//      Needs ≥6 matching trades to claim a pattern.
//   2. LOOSE — single-dimension breakdown (e.g. session-only, regime-only)
//      Needs ≥10 matching trades.
//
// Output stored at v11:patterns:latest, AI reads on every call.

const { getRedis, normSym, safeParse } = require('./_lib');

// =================================================================
// Read recent closed trades from Redis
// =================================================================
async function readClosedTrades(days) {
  const r = getRedis();
  if (!r) return [];
  const all = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = 'v11:closed:' + d.toISOString().slice(0, 10);
    const raw = await r.get(key).catch(() => null);
    const arr = safeParse(raw);
    if (Array.isArray(arr)) all.push(...arr);
  }
  return all;
}

// =================================================================
// Wilson score interval lower bound — better than raw WR for small samples
// =================================================================
function wilsonLower(wins, n, z = 1.645) {  // 90% CI lower bound
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

// =================================================================
// TIGHT PATTERNS — multi-dimensional signature
// =================================================================
function findTightPatterns(trades, minN = 6) {
  // Build signature for each trade
  const groups = {};
  for (const t of trades) {
    if (!t.symbol || !t.family || !t.mode) continue;
    const sig = [
      normSym(t.symbol),
      t.family,
      t.mode,
      t.session || 'NULL',
      t.regime || 'NULL',
      t.h1h4Aligned === true ? 'aligned' : t.h1h4Aligned === false ? 'unaligned' : 'unk',
    ].join('/');
    if (!groups[sig]) groups[sig] = { signature: sig, n: 0, wins: 0, totalPnl: 0, sumR: 0, examples: [] };
    groups[sig].n += 1;
    if (t.won) groups[sig].wins += 1;
    groups[sig].totalPnl += t.pnl || 0;
    // R-multiple = actual pnl / dollar-value-of-1R-loss.
    // 1R-dollar = volume × pipsToSL × dollarPerPipPerLot
    // dollarPerPipPerLot is category-specific:
    //   FOREX (non-JPY): 1 lot = 100k units, 1 pip = 0.0001 → $10/pip/lot
    //   FOREX JPY:       1 lot = 100k units, 1 pip = 0.01   → ~$0.67/pip/lot at 150 USDJPY (but bot uses ~$10 approximation)
    //   GOLD:            1 lot = 100 oz,     1 pip = 0.01   → $1/pip/lot
    //   CRYPTO BTC:      1 lot = 1 BTC,      1 pip = $1     → $1/pip/lot
    //   INDEX:           1 lot = 1 contract, 1 pip = 1 pt   → $1/pip/lot (varies but close)
    let dollarPerPipPerLot = 10;  // forex default
    const sym = (t.symbol || '').toUpperCase();
    if (/XAU|GOLD/.test(sym))                  dollarPerPipPerLot = 1;
    else if (/XAG|SILVER/.test(sym))           dollarPerPipPerLot = 5;
    else if (/BTC|ETH|XRP|SOL/.test(sym))      dollarPerPipPerLot = 1;
    else if (/NAS|SPX|US30|GER|UK100|JP225/.test(sym)) dollarPerPipPerLot = 1;
    // JPY pairs use different math but for our coarse R approximation, $10/lot is close enough
    const oneRDollar = (t.slPips || 0) * (t.volume || 0) * dollarPerPipPerLot;
    const rMult = oneRDollar > 0 ? (t.pnl || 0) / oneRDollar : (t.won ? 1 : -1);
    groups[sig].sumR += rMult;
    if (groups[sig].examples.length < 3) groups[sig].examples.push(t.positionId);
  }

  const patterns = [];
  for (const sig in groups) {
    const g = groups[sig];
    if (g.n < minN) continue;
    const wr = (g.wins / g.n) * 100;
    const wrLower = wilsonLower(g.wins, g.n) * 100;
    const expectancyR = g.sumR / g.n;
    const avgPnl = g.totalPnl / g.n;
    let recommendation = 'NEUTRAL';
    if (wrLower >= 50 && expectancyR > 0.2) recommendation = 'PRIORITIZE';
    else if (wrLower < 30 || expectancyR < -0.3) recommendation = 'AVOID';
    patterns.push({
      signature: sig,
      n: g.n,
      wins: g.wins,
      wr: Math.round(wr * 10) / 10,
      wrLower: Math.round(wrLower * 10) / 10,
      expectancyR: Math.round(expectancyR * 100) / 100,
      avgPnl: Math.round(avgPnl * 100) / 100,
      recommendation,
    });
  }
  return patterns.sort((a, b) => b.expectancyR - a.expectancyR);
}

// =================================================================
// LOOSE PATTERNS — single-dimension breakdowns
// =================================================================
// For each (symbol, dimension), break down WR by dimension value.
// Dimensions: session, regime, family, mode, chaos, setupPattern, h1h4Aligned

function findLoosePatterns(trades, minN = 10) {
  const dimensions = ['session', 'regime', 'family', 'mode', 'setupPattern'];
  // First group by symbol
  const bySymbol = {};
  for (const t of trades) {
    if (!t.symbol) continue;
    const s = normSym(t.symbol);
    if (!bySymbol[s]) bySymbol[s] = [];
    bySymbol[s].push(t);
  }

  const patterns = [];
  for (const sym in bySymbol) {
    const symTrades = bySymbol[sym];
    if (symTrades.length < minN) continue;

    for (const dim of dimensions) {
      const breakdown = {};
      for (const t of symTrades) {
        const v = t[dim];
        const key = v === null || v === undefined ? 'NULL' : String(v);
        if (!breakdown[key]) breakdown[key] = { n: 0, wins: 0, totalPnl: 0 };
        breakdown[key].n += 1;
        if (t.won) breakdown[key].wins += 1;
        breakdown[key].totalPnl += t.pnl || 0;
      }
      // Annotate with WR + lower CI
      const annotated = {};
      let bestKey = null, worstKey = null;
      let bestWr = -1, worstWr = 101;
      for (const k in breakdown) {
        const b = breakdown[k];
        if (b.n < 3) continue;  // too few to characterize that bucket
        const wr = (b.wins / b.n) * 100;
        annotated[k] = { n: b.n, wr: Math.round(wr * 10) / 10, totalPnl: Math.round(b.totalPnl * 100) / 100 };
        if (wr > bestWr) { bestWr = wr; bestKey = k; }
        if (wr < worstWr) { worstWr = wr; worstKey = k; }
      }
      const keys = Object.keys(annotated);
      if (keys.length < 2) continue;  // need at least 2 buckets to compare
      const spread = bestWr - worstWr;
      if (spread < 20) continue;  // bucket WR spread too small to be meaningful
      patterns.push({
        symbol: sym,
        dimension: dim,
        breakdown: annotated,
        bestBucket: bestKey,
        worstBucket: worstKey,
        spread: Math.round(spread * 10) / 10,
        recommendation: 'Prefer ' + bestKey + ' (' + Math.round(bestWr) + '% WR), avoid ' + worstKey + ' (' + Math.round(worstWr) + '% WR)',
      });
    }
  }
  return patterns;
}

// =================================================================
// MAIN — analyze + write
// =================================================================
async function runPatternLearner(daysBack = 30) {
  const trades = await readClosedTrades(daysBack);
  if (trades.length === 0) {
    return {
      ts: Date.now(),
      totalTrades: 0,
      message: 'No closed trades yet — pattern learning needs at least one closed trade.',
      tight: [], loose: [], avoid: [],
    };
  }

  const tight = findTightPatterns(trades, 6);
  const loose = findLoosePatterns(trades, 10);

  // Categorize tight patterns
  const prioritize = tight.filter(p => p.recommendation === 'PRIORITIZE');
  const avoid      = tight.filter(p => p.recommendation === 'AVOID');
  const neutral    = tight.filter(p => p.recommendation === 'NEUTRAL');

  const result = {
    ts: Date.now(),
    daysBack,
    totalTrades: trades.length,
    wins: trades.filter(t => t.won).length,
    losses: trades.filter(t => !t.won).length,
    overallWR: trades.length > 0 ? Math.round((trades.filter(t => t.won).length / trades.length) * 1000) / 10 : 0,
    tight: prioritize,
    avoid: avoid,
    neutral: neutral.slice(0, 10),  // cap
    loose: loose,
  };

  // Persist
  const r = getRedis();
  if (r) {
    await r.set('v11:patterns:latest', JSON.stringify(result), { ex: 7 * 24 * 60 * 60 }).catch(() => {});
  }
  return result;
}

// Read by AI for inclusion in prompt
async function readPatternsForAI() {
  const r = getRedis();
  if (!r) return null;
  const raw = await r.get('v11:patterns:latest').catch(() => null);
  return safeParse(raw);
}

// =================================================================
// HTTP handler
// =================================================================
module.exports = async (req, res) => {
  const action = String(req.query.action || 'read');
  if (action === 'run') {
    const days = parseInt(req.query.days || '30', 10);
    const result = await runPatternLearner(days);
    return res.status(200).json(result);
  }
  // default: read latest cached
  const latest = await readPatternsForAI();
  return res.status(200).json(latest || { message: 'No pattern data yet. Run /api/pattern-learner?action=run to compute.' });
};

module.exports.runPatternLearner   = runPatternLearner;
module.exports.readPatternsForAI   = readPatternsForAI;
module.exports.readClosedTrades    = readClosedTrades;
module.exports.findTightPatterns   = findTightPatterns;
module.exports.findLoosePatterns   = findLoosePatterns;