/* eslint-disable */
// V12 — api/recognition-memory.js
//
// THE ADVISOR. Stores feature vectors of closed trades. When a new setup
// forms, finds the K nearest historical situations and reports their outcomes.
//
// CRITICAL DESIGN PRINCIPLES (Omar agreed in design phase):
//   - Memory NEVER gates trades. Coherence checker decides yes/no on its own.
//   - Memory advises sizing/management: "this exact picture won 11/14 → take
//     full size", "never seen this → take it but small size".
//   - Outcome-only storage. NO narrative observations (caused V11 hallucinations).
//   - Tagged with which tools/tactics were enabled (so memory comparisons are
//     apples-to-apples).
//   - News context stored alongside (so we learn news-affected behavior).
//
// FEATURE VECTOR shape (one per closed trade):
//   {
//     id, asset, direction, mode, session,
//     contributingTactics: ['orderBlock', 'bos', 'fvg'],
//     timeframesInPlay: ['1h', '4h'],
//     slDistanceATR, rMultipleAtClose,
//     newsState, highImpactWithin60min,
//     enabledTools: { ... },           // snapshot of user's tool config
//     outcome: 'WIN' | 'LOSS' | 'BREAKEVEN',
//     pnl, pnlR,
//     openedAt, closedAt, holdTimeMinutes,
//     synthetic: false,                // true if from cold-start backtest seed
//   }
//
// STORAGE in Redis:
//   v12:trades:closed:{tradeId} — individual feature vectors
//   v12:trades:index — sorted set of trade IDs by closedAt timestamp
//   v12:patterns:cache — derived "configurations" (tactic-set → outcomes), refreshed periodically
// ----------------------------------------------------------------------------

const { getRedis, safeParse } = require('./_lib');

const TRADE_KEY = (id) => `v12:trades:closed:${id}`;
const TRADE_INDEX_KEY = 'v12:trades:index';

// =================================================================
// STORE A CLOSED TRADE
// =================================================================

async function storeClosedTrade(trade) {
  if (!trade || !trade.id) return { error: 'trade missing id' };
  const r = getRedis();
  if (!r) return { error: 'redis unavailable' };

  const fv = buildFeatureVector(trade);

  try {
    await r.set(TRADE_KEY(trade.id), JSON.stringify(fv));
    // Add to index sorted by closedAt — implementation depends on Upstash; we
    // simulate with a JSON-serialized index for portability.
    const indexRaw = await r.get(TRADE_INDEX_KEY).catch(() => null);
    const index = safeParse(indexRaw) || [];
    if (!index.find((e) => e.id === trade.id)) {
      index.push({ id: trade.id, closedAt: fv.closedAt });
      // Keep most recent 1000
      index.sort((a, b) => b.closedAt - a.closedAt);
      const trimmed = index.slice(0, 1000);
      await r.set(TRADE_INDEX_KEY, JSON.stringify(trimmed));
    }
    return { ok: true, id: trade.id };
  } catch (e) {
    return { error: e.message };
  }
}

// Build feature vector from a closed trade record.
// Trade record comes from execute.js (entry context) joined with manage-trades.js (exit).
function buildFeatureVector(trade) {
  const tactics = (trade.contributingTactics || []).slice().sort();   // sorted for stable comparison
  const tfs = (trade.timeframesInPlay || []).slice().sort();

  const pnlR = trade.slDistance && trade.pnl != null
    ? trade.pnl / trade.riskDollars
    : null;

  const outcome =
    trade.pnl > 0.5 ? 'WIN' :
    trade.pnl < -0.5 ? 'LOSS' :
    'BREAKEVEN';

  const holdTimeMinutes = trade.openedAt && trade.closedAt
    ? Math.round((trade.closedAt - trade.openedAt) / 60000)
    : null;

  return {
    id: trade.id,
    asset: trade.asset,
    direction: trade.direction,
    mode: trade.mode,
    session: trade.session,
    contributingTactics: tactics,
    timeframesInPlay: tfs,
    slDistanceATR: trade.slDistanceATR,
    pnl: trade.pnl,
    pnlR,
    outcome,
    newsState: trade.newsState || 'none',
    highImpactWithin60min: trade.highImpactWithin60min || false,
    enabledTools: trade.enabledTools || null,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    holdTimeMinutes,
    synthetic: trade.synthetic || false,
  };
}

// =================================================================
// READ ALL TRADES
// =================================================================

async function getAllTrades(limit = 1000) {
  const r = getRedis();
  if (!r) return [];

  try {
    const indexRaw = await r.get(TRADE_INDEX_KEY).catch(() => null);
    const index = safeParse(indexRaw) || [];
    const ids = index.slice(0, limit).map((e) => e.id);

    const trades = [];
    for (const id of ids) {
      const raw = await r.get(TRADE_KEY(id)).catch(() => null);
      const t = safeParse(raw);
      if (t) trades.push(t);
    }
    return trades;
  } catch (e) {
    return [];
  }
}

// =================================================================
// KNN SEARCH — THE CORE
// =================================================================
// Given a current setup (built by coherence-checker), find the K nearest past
// closed trades by similarity.
//
// SIMILARITY DEFINITION:
//   - Same asset:           required (different markets behave differently)
//   - Same direction:       required (LONG vs SHORT are different setups)
//   - Same mode:            +0.3 if match (SCALP vs DAY vs SWING)
//   - Tactic overlap:       Jaccard similarity of contributing tactics
//   - Timeframe overlap:    Jaccard similarity of timeframes
//   - Same session:         +0.15 if match
//   - News state match:     +0.10 if both have/don't-have news
//
// Returns: { matches: [{trade, similarity}], summary: {wins, losses, ...} }

async function findSimilarTrades({ asset, direction, mode, session, contributingTactics, timeframesInPlay, newsFeature }, k = 20) {
  const all = await getAllTrades(500);

  // Pre-filter: same asset + same direction (hard constraints)
  const candidates = all.filter((t) =>
    t.asset === asset && t.direction === direction
  );

  if (candidates.length === 0) {
    return { matches: [], summary: emptySummary(), totalConsidered: 0 };
  }

  const currentTactics = new Set(contributingTactics || []);
  const currentTFs = new Set(timeframesInPlay || []);

  // Compute similarity for each candidate
  const scored = candidates.map((t) => {
    const candidateTactics = new Set(t.contributingTactics || []);
    const candidateTFs = new Set(t.timeframesInPlay || []);

    let sim = 0;
    let weight = 0;

    // Tactic overlap (Jaccard)
    const tacticInter = [...currentTactics].filter((x) => candidateTactics.has(x)).length;
    const tacticUnion = new Set([...currentTactics, ...candidateTactics]).size;
    const tacticJaccard = tacticUnion > 0 ? tacticInter / tacticUnion : 0;
    sim += tacticJaccard * 0.4;
    weight += 0.4;

    // Timeframe overlap
    const tfInter = [...currentTFs].filter((x) => candidateTFs.has(x)).length;
    const tfUnion = new Set([...currentTFs, ...candidateTFs]).size;
    const tfJaccard = tfUnion > 0 ? tfInter / tfUnion : 0;
    sim += tfJaccard * 0.2;
    weight += 0.2;

    // Mode
    if (t.mode === mode) sim += 0.15;
    weight += 0.15;

    // Session
    if (t.session === session) sim += 0.10;
    weight += 0.10;

    // News
    const currentNews = newsFeature?.highImpactWithin60min || false;
    const tradeNews = t.highImpactWithin60min || false;
    if (currentNews === tradeNews) sim += 0.10;
    weight += 0.10;

    // Synthetic trades count for less (decay over real-trade accumulation)
    const realPenalty = t.synthetic ? 0.5 : 1.0;

    return {
      trade: t,
      similarity: weight > 0 ? (sim / weight) * realPenalty : 0,
    };
  });

  // Sort by similarity desc, take top K with meaningful similarity
  // (filter out trades that are too dissimilar — they're not actually "matches")
  scored.sort((a, b) => b.similarity - a.similarity);
  const MIN_SIMILARITY = 0.35;  // below this, the trade isn't a meaningful match
  const meaningful = scored.filter((s) => s.similarity >= MIN_SIMILARITY);
  const topK = meaningful.slice(0, k);

  // Compute summary
  const summary = computeSummary(topK);

  return {
    matches: topK,
    summary,
    totalConsidered: candidates.length,
  };
}

function emptySummary() {
  return {
    matchCount: 0, wins: 0, losses: 0, breakevens: 0,
    winRate: null, avgPnL: null, avgPnLR: null,
    confidence: 'NONE', advice: 'NEW_SETUP',
  };
}

function computeSummary(topK) {
  if (topK.length === 0) return emptySummary();

  const wins = topK.filter((m) => m.trade.outcome === 'WIN').length;
  const losses = topK.filter((m) => m.trade.outcome === 'LOSS').length;
  const breakevens = topK.filter((m) => m.trade.outcome === 'BREAKEVEN').length;
  const matchCount = topK.length;

  const winRate = matchCount > 0 ? wins / matchCount : null;
  const avgPnL = topK.reduce((s, m) => s + (m.trade.pnl || 0), 0) / matchCount;
  const avgPnLR = topK.reduce((s, m) => s + (m.trade.pnlR || 0), 0) / matchCount;

  // Confidence label based on match quality and quantity
  // - HIGH: >= 8 matches, win rate >= 0.65
  // - MED-HIGH: >= 6 matches, win rate >= 0.55
  // - MED: >= 4 matches, win rate >= 0.45
  // - LOW: < 4 matches OR win rate < 0.40
  // - AVOID: >= 5 matches AND win rate < 0.30
  let confidence = 'LOW';
  let advice = 'NEUTRAL';

  if (matchCount >= 5 && winRate < 0.30) {
    confidence = 'AVOID';
    advice = 'AVOID';
  } else if (matchCount >= 8 && winRate >= 0.65) {
    confidence = 'HIGH';
    advice = 'TAKE_AGGRESSIVE';
  } else if (matchCount >= 6 && winRate >= 0.55) {
    confidence = 'MED_HIGH';
    advice = 'TAKE_NORMAL';
  } else if (matchCount >= 4 && winRate >= 0.45) {
    confidence = 'MED';
    advice = 'TAKE_REDUCED';
  } else if (matchCount < 4) {
    confidence = 'NEW_SETUP';
    advice = 'TAKE_SMALL';
  } else {
    confidence = 'LOW';
    advice = 'TAKE_REDUCED';
  }

  return {
    matchCount,
    wins,
    losses,
    breakevens,
    winRate,
    avgPnL,
    avgPnLR,
    confidence,
    advice,
  };
}

// =================================================================
// SIZE MULTIPLIER (advisor → sizing)
// =================================================================
// Convert recognition advice into a sizing multiplier the cockpit can apply
// to the bot's suggested lot.

function getSizeMultiplier(advice) {
  switch (advice) {
    case 'TAKE_AGGRESSIVE': return 1.5;   // bot suggests 0.04 → with high confidence, suggest 0.06
    case 'TAKE_NORMAL':     return 1.0;
    case 'TAKE_REDUCED':    return 0.7;
    case 'TAKE_SMALL':      return 0.5;   // unfamiliar setup
    case 'AVOID':           return 0.3;   // user can still take, but bot strongly suggests very small
    default:                return 1.0;
  }
}

// =================================================================
// HTTP HANDLER
// =================================================================

module.exports = async (req, res) => {
  try {
    const action = String(req.query.action || 'list');

    if (action === 'list') {
      const limit = parseInt(req.query.limit || '50', 10);
      const trades = await getAllTrades(limit);
      return res.status(200).json({ count: trades.length, trades });
    }

    if (action === 'similar') {
      const asset = req.query.asset;
      const direction = req.query.direction;
      if (!asset || !direction) return res.status(400).json({ error: 'asset and direction required' });
      const result = await findSimilarTrades({
        asset,
        direction,
        mode: req.query.mode || 'DAY',
        session: req.query.session || 'NEW_YORK',
        contributingTactics: (req.query.tactics || '').split(',').filter(Boolean),
        timeframesInPlay: (req.query.tfs || '').split(',').filter(Boolean),
      });
      return res.status(200).json(result);
    }

    if (action === 'stats') {
      const trades = await getAllTrades(1000);
      const wins = trades.filter((t) => t.outcome === 'WIN').length;
      const losses = trades.filter((t) => t.outcome === 'LOSS').length;
      return res.status(200).json({
        totalTrades: trades.length,
        wins, losses,
        winRate: trades.length > 0 ? wins / trades.length : null,
        synthetic: trades.filter((t) => t.synthetic).length,
        real: trades.filter((t) => !t.synthetic).length,
      });
    }

    return res.status(400).json({ error: 'unknown action', validActions: ['list', 'similar', 'stats'] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.storeClosedTrade = storeClosedTrade;
module.exports.findSimilarTrades = findSimilarTrades;
module.exports.getAllTrades = getAllTrades;
module.exports.getSizeMultiplier = getSizeMultiplier;
module.exports.buildFeatureVector = buildFeatureVector;