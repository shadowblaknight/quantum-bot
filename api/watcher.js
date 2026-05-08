/* eslint-disable */
// V12 — api/watcher.js
//
// CONTINUOUS-STATE WATCHER. Replaces V11's snapshot-cron architecture.
//
// Each invocation:
//   1. Loads the bot's running mental model from Redis (per asset)
//   2. Updates with fresh tactic detection results
//   3. Tracks pending limit orders (entries waiting for price retest)
//   4. Expires setups that have aged out
//   5. Persists updated model
//
// The bot's "mental model" per asset:
//   {
//     opinions: [...],           // current detected tactics
//     pendingSetups: [...],      // setups that fired and are waiting for entry fill
//     openPosition: {...} | null,
//     recentObservations: [...], // last 100 things bot noticed (for cockpit commentary)
//     structuralContext: {...},  // long-horizon awareness (M, W, D trend state)
//     lastTickAt, lastSetupAt, etc.
//   }
//
// This file does NOT place orders. It updates the mental model and emits
// structured "intents" that execute.js consumes when trading is enabled.
// ----------------------------------------------------------------------------

const { getRedis, safeParse, getCurrentSession, applyCors } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { runForAsset } = require('./tactics-run');
const { checkCoherence } = require('./coherence-checker');
const { findSimilarTrades, getSizeMultiplier } = require('./recognition-memory');
const { getNewsContext, getNewsFeature } = require('./news-context');
const { suggestLot } = require('./sizing-engine');
const { fetchAccount, fetchPrice, fetchCandles, fetchPositions } = require('./broker');
const { atr } = require('./_lib');

// ===== Redis keys (per-asset state) =====
const STATE_KEY = (asset) => `v12:watcher:${asset}:state`;
const STRUCT_KEY = (asset) => `v12:watcher:${asset}:structural`;
const COMMENTARY_KEY = (asset) => `v12:watcher:${asset}:commentary`;
const PENDING_KEY = (asset) => `v12:watcher:${asset}:pending`;
const WATCHLIST_KEY = 'v12:watchlist';

// ===== Setup expiration by mode (in ms) =====
const SETUP_EXPIRY_MS = {
  SCALP: 30 * 60 * 1000,        // 30 min
  DAY:   4 * 60 * 60 * 1000,    // 4 hours
  SWING: 8 * 60 * 60 * 1000,    // 8 hours
};

// ===== Commentary hygiene =====
const COMMENTARY_MAX = 100;
const WATCHING_THROTTLE_MS = 5 * 60 * 1000;  // 5 min between "watching" updates

// =================================================================
// COMMENTARY EMITTER
// =================================================================

async function pushCommentary(asset, category, text, dedupKey) {
  const r = getRedis();
  if (!r) return;
  try {
    const raw = await r.get(COMMENTARY_KEY(asset)).catch(() => null);
    const lines = safeParse(raw) || [];

    // Dedup: don't push same dedupKey twice in a row
    if (dedupKey && lines.length > 0 && lines[lines.length - 1].dedupKey === dedupKey) return;

    lines.push({ ts: Date.now(), category, text, dedupKey });
    const trimmed = lines.slice(-COMMENTARY_MAX);
    await r.set(COMMENTARY_KEY(asset), JSON.stringify(trimmed), { ex: 86400 * 7 });
  } catch (_) {}
}

// =================================================================
// STRUCTURAL CONTEXT (long-horizon awareness)
// =================================================================
// On first invocation per asset, fetch monthly + weekly + daily candles and
// build the bot's "background memory of what this market looks like over time."
//
// This is the cold-start replacement Omar suggested: instead of synthetic
// backtest trades, the bot just reads the long-horizon chart and absorbs
// the structure.
//
// Re-checked once per day (not every tick — slow-changing data).
//
// Structural context:
//   - 1d trend direction over last 60 days
//   - 1w trend direction over last 30 weeks
//   - 1mn trend direction over last 24 months
//   - Major historical levels (yearly high/low, multi-year)
//   - Current ATR on each timeframe (volatility regime)

async function ensureStructuralContext(asset) {
  const r = getRedis();
  if (!r) return null;

  const raw = await r.get(STRUCT_KEY(asset)).catch(() => null);
  const cached = safeParse(raw);
  if (cached && cached.builtAt && (Date.now() - cached.builtAt < 24 * 60 * 60 * 1000)) {
    return cached;
  }

  // Build fresh
  const trendStructure = require('./tactics/trend-structure');
  const tfs = ['1d', '1w', '1mn'];
  const trends = {};
  const levels = {};

  for (const tf of tfs) {
    try {
      const r1 = await fetchCandles(asset, tf, 60);
      if (r1.candles && r1.candles.length > 10) {
        const swings = trendStructure.findSwings(r1.candles);
        const classification = trendStructure.classifyTrend(swings);
        trends[tf] = {
          direction: classification.trend,
          confidence: classification.confidence,
          evidence: classification.evidence,
        };

        // Highest high, lowest low across the full window
        const highs = r1.candles.map((c) => c.high);
        const lows = r1.candles.map((c) => c.low);
        levels[tf] = {
          high: Math.max(...highs),
          low: Math.min(...lows),
          atrValue: atr(r1.candles, 14),
        };
      }
    } catch (e) {
      trends[tf] = { error: e.message };
    }
  }

  const ctx = {
    asset,
    builtAt: Date.now(),
    trends,
    levels,
  };

  try {
    await r.set(STRUCT_KEY(asset), JSON.stringify(ctx), { ex: 7 * 86400 });
  } catch (_) {}

  return ctx;
}

// =================================================================
// PENDING SETUP TRACKING
// =================================================================
// When coherence-checker emits a TRADE setup, we don't enter market — we
// place a limit order at the planned entry price. While that limit is
// waiting, the setup is "pending."
//
// Pending setup record:
//   { id, setup, recognition, sizing, intent, plannedEntry, slPrice,
//     tpLevels, expiresAt, createdAt, status }
//
// status: 'pending' | 'filled' | 'expired' | 'invalidated' | 'cancelled'

async function getPendingSetups(asset) {
  const r = getRedis();
  if (!r) return [];
  const raw = await r.get(PENDING_KEY(asset)).catch(() => null);
  return safeParse(raw) || [];
}

async function setPendingSetups(asset, setups) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(PENDING_KEY(asset), JSON.stringify(setups), { ex: 86400 });
  } catch (_) {}
}

async function addPendingSetup(asset, pendingSetup) {
  const existing = await getPendingSetups(asset);
  existing.push(pendingSetup);
  await setPendingSetups(asset, existing);
}

async function updatePendingSetup(asset, id, updates) {
  const existing = await getPendingSetups(asset);
  const idx = existing.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  existing[idx] = { ...existing[idx], ...updates };
  await setPendingSetups(asset, existing);
  return true;
}

async function clearExpiredAndInvalidated(asset, currentPrice, atrValue) {
  const existing = await getPendingSetups(asset);
  const now = Date.now();
  const remaining = [];

  for (const p of existing) {
    if (p.status !== 'pending') {
      remaining.push(p);
      continue;
    }
    // Expired by time?
    if (now > p.expiresAt) {
      await pushCommentary(asset, 'setup-expired', `Setup expired without fill: ${p.setup.direction} @ ${p.plannedEntry.toFixed(p.plannedEntry > 100 ? 2 : 5)}`);
      remaining.push({ ...p, status: 'expired', closedAt: now });
      continue;
    }
    // Invalidated by price moving past invalidation level?
    const invalidated = p.setup.direction === 'LONG'
      ? currentPrice < p.slPrice
      : currentPrice > p.slPrice;
    if (invalidated) {
      await pushCommentary(asset, 'setup-invalidated', `Setup invalidated: price moved past SL before fill`);
      remaining.push({ ...p, status: 'invalidated', closedAt: now });
      continue;
    }
    remaining.push(p);
  }

  await setPendingSetups(asset, remaining);
  return remaining;
}

// =================================================================
// MAIN: PROCESS ONE ASSET
// =================================================================

async function processAsset(asset, account, openPositions) {
  const t0 = Date.now();
  const session = getCurrentSession();

  try {
    // 1. Ensure structural context exists (cheap if cached)
    const structural = await ensureStructuralContext(asset);

    // 2. Run all detectors
    const tacticsResult = await runForAsset({ asset });
    if (!tacticsResult || !tacticsResult.opinions) {
      return { asset, error: 'no opinions', processingMs: Date.now() - t0 };
    }

    // 3. Get current price + ATR
    const priceResult = await fetchPrice(asset);
    const currentPrice = priceResult?.price;
    if (!currentPrice) {
      return { asset, error: 'price unavailable', processingMs: Date.now() - t0 };
    }
    const candlesH1 = await fetchCandles(asset, '1h', 50);
    const atrValue = atr(candlesH1.candles || [], 14);
    if (!atrValue) {
      return { asset, error: 'ATR unavailable', processingMs: Date.now() - t0 };
    }

    // 4. Clear expired/invalidated pending setups
    const pendingSetups = await clearExpiredAndInvalidated(asset, currentPrice, atrValue);
    const activePending = pendingSetups.filter((p) => p.status === 'pending');

    // 5. Check for open position on this asset
    const myPosition = openPositions.find((p) => p.assetId === asset);

    // 6. Run coherence checker
    const cohResult = checkCoherence(tacticsResult.opinions, currentPrice, atrValue);

    // 7. Decision logic
    let intent = null;

    if (myPosition) {
      // Position open — bot just watches, doesn't propose new entries
      intent = { type: 'HOLD_POSITION', position: myPosition };
    } else if (activePending.length > 0) {
      // Already have a pending setup — don't queue another
      intent = { type: 'AWAITING_FILL', pending: activePending };
    } else if (cohResult.decision === 'TRADE') {
      // Fresh setup — consult recognition + propose new pending entry
      const newsFeature = await getNewsFeature(asset).catch(() => ({}));
      const recognition = await findSimilarTrades({
        asset,
        direction: cohResult.setup.direction,
        mode: cohResult.setup.mode,
        session,
        contributingTactics: cohResult.setup.contributingTactics,
        timeframesInPlay: cohResult.setup.timeframesInPlay,
        newsFeature,
      });

      const balance = account?.balance || 10000;
      const sizing = suggestLot({
        assetId: asset,
        slDistance: cohResult.setup.slDistance,
        capital: balance,
        riskPercent: 0.01,
      });

      const recMultiplier = getSizeMultiplier(recognition.summary.advice);
      const recommendedLot = Math.max(0.01, Math.round(sizing.suggestedLot * recMultiplier * 100) / 100);

      const expiry = SETUP_EXPIRY_MS[cohResult.setup.mode] || SETUP_EXPIRY_MS.DAY;
      const pendingSetup = {
        id: `setup_${asset}_${Date.now()}`,
        asset,
        setup: cohResult.setup,
        recognition: recognition.summary,
        sizing: {
          baseLot: sizing.suggestedLot,
          recommendedLot,
          baseRisk: sizing.riskDollars,
        },
        plannedEntry: cohResult.setup.entry,
        slPrice: cohResult.setup.sl,
        tpLevels: cohResult.setup.targets,
        newsFeature,
        createdAt: Date.now(),
        expiresAt: Date.now() + expiry,
        status: 'pending',
      };

      await addPendingSetup(asset, pendingSetup);

      intent = { type: 'NEW_PENDING', pendingSetup };

      // Commentary
      await pushCommentary(asset, 'setup',
        `${cohResult.setup.direction} ${cohResult.setup.mode} setup forming — ${cohResult.setup.contributingTactics.join(' + ')}`,
        pendingSetup.id);
      if (recognition.summary.matchCount >= 4) {
        await pushCommentary(asset, 'recognition',
          `Configuration matches ${recognition.summary.matchCount} past trades: ${recognition.summary.wins}W/${recognition.summary.losses}L (${recognition.summary.confidence})`,
          pendingSetup.id + '-rec');
      } else if (recognition.summary.matchCount === 0) {
        await pushCommentary(asset, 'recognition',
          'New configuration — no matching past trades, taking exploratory size',
          pendingSetup.id + '-rec');
      }
    } else if (cohResult.decision === 'WAIT' && cohResult.opinionCount > 0) {
      intent = { type: 'WATCHING', reason: cohResult.reasoning };

      // Throttled "watching" commentary
      const r = getRedis();
      if (r) {
        const lastRaw = await r.get(`v12:watcher:${asset}:lastWatchingCommentaryAt`).catch(() => null);
        const lastWatching = parseInt(lastRaw, 10) || 0;
        if (Date.now() - lastWatching > WATCHING_THROTTLE_MS) {
          await pushCommentary(asset, 'watching',
            `${cohResult.opinionCount} observations on ${asset.toUpperCase()} — ${cohResult.reasoning}`);
          await r.set(`v12:watcher:${asset}:lastWatchingCommentaryAt`, String(Date.now()), { ex: 86400 }).catch(() => {});
        }
      }
    } else {
      intent = { type: 'IDLE' };
    }

    // 8. Build complete state snapshot
    const news = await getNewsContext(asset).catch(() => null);
    const state = {
      asset,
      ts: t0,
      session,
      currentPrice,
      atr: atrValue,
      opinions: tacticsResult.opinions,
      opinionCount: tacticsResult.opinions.length,
      coherence: cohResult,
      intent,
      pendingSetups: await getPendingSetups(asset),
      myPosition,
      news,
      structural,
      processingMs: Date.now() - t0,
    };

    // 9. Persist state
    const r = getRedis();
    if (r) {
      await r.set(STATE_KEY(asset), JSON.stringify(state), { ex: 86400 }).catch(() => {});
    }

    return state;
  } catch (e) {
    return { asset, error: e.message, processingMs: Date.now() - t0 };
  }
}

// =================================================================
// MAIN ENTRY POINT
// =================================================================

async function runWatcherTick() {
  const r = getRedis();

  // Watchlist
  let watchlist = ['gold', 'btc', 'eurusd'];
  if (r) {
    try {
      const raw = await r.get(WATCHLIST_KEY).catch(() => null);
      const parsed = safeParse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        watchlist = parsed.filter((a) => getAssetById(a));
      }
    } catch (_) {}
  }

  // Account + positions (one fetch, used for all assets)
  const [account, positionsResult] = await Promise.all([
    fetchAccount().catch(() => null),
    fetchPositions().catch(() => []),
  ]);
  const positions = Array.isArray(positionsResult) ? positionsResult : [];

  // Process each asset
  const results = await Promise.all(
    watchlist.map((asset) => processAsset(asset, account, positions))
  );

  return {
    ts: Date.now(),
    session: getCurrentSession(),
    watchlist,
    accountBalance: account?.balance || null,
    accountEquity: account?.equity || null,
    openPositions: positions.length,
    results,
    summary: {
      total: results.length,
      newPending: results.filter((r) => r.intent?.type === 'NEW_PENDING').length,
      awaiting: results.filter((r) => r.intent?.type === 'AWAITING_FILL').length,
      holding: results.filter((r) => r.intent?.type === 'HOLD_POSITION').length,
      watching: results.filter((r) => r.intent?.type === 'WATCHING').length,
      idle: results.filter((r) => r.intent?.type === 'IDLE').length,
      errors: results.filter((r) => r.error).length,
    },
  };
}

// HTTP handler — called by cron + manual debug
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const result = await runWatcherTick();
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.runWatcherTick = runWatcherTick;
module.exports.processAsset = processAsset;
module.exports.pushCommentary = pushCommentary;
module.exports.getPendingSetups = getPendingSetups;
module.exports.updatePendingSetup = updatePendingSetup;
module.exports.SETUP_EXPIRY_MS = SETUP_EXPIRY_MS;