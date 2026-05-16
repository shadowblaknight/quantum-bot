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
const { runForAsset: runEventsForAsset } = require('./events-run');
const { checkCoherence } = require('./coherence-checker');
const { findSimilarTrades, getSizeMultiplier } = require('./recognition-memory');
const { getNewsContext, getNewsFeature } = require('./news-context');
const { suggestLot } = require('./sizing-engine');
const { fetchAccount, fetchPrice, fetchCandles, fetchPositions } = require('./broker');
const { atr } = require('./_lib');
const { notifySetupBrewing } = require('./telegram');

// ===== Redis keys (per-asset state) =====
const STATE_KEY = (asset) => `v12:watcher:${asset}:state`;
const STRUCT_KEY = (asset) => `v12:watcher:${asset}:structural`;
const COMMENTARY_KEY = (asset) => `v12:watcher:${asset}:commentary`;
const PENDING_KEY = (asset) => `v12:watcher:${asset}:pending`;
const WATCHLIST_KEY = 'v12:watchlist';

// ===== Setup expiration by mode (in ms) =====
// Tight expiries: ICT entry zones go stale fast. If price doesn't retrace
// within ~90 min, the setup's context has usually changed (different KZ,
// fresh swings, news, etc.) and a fresh detection should win.
const SETUP_EXPIRY_MS = {
  SCALP: 20 * 60 * 1000,        // 20 min
  DAY:   90 * 60 * 1000,        // 90 min  (was 4h — too long for ICT entries)
  SWING: 4 * 60 * 60 * 1000,    // 4 hours
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

  // Build fresh structural context using V12.3 swing utility
  // (replaces deprecated tactics/trend-structure dependency)
  const { detectSwings, recentSwings, determineTrend } = require('./events/_swings');
  const tfs = ['1d', '1w', '1mn'];
  const trends = {};
  const levels = {};

  for (const tf of tfs) {
    try {
      const r1 = await fetchCandles(asset, tf, 60);
      if (r1.candles && r1.candles.length > 10) {
        const swings = detectSwings(r1.candles, 2);
        const trendDir = determineTrend(swings); // 'UP' | 'DOWN' | 'RANGE'

        // Build evidence string in the same shape the cockpit expects
        const lastHighs = recentSwings(swings, 'high', 2);
        const lastLows = recentSwings(swings, 'low', 2);
        let evidence = `swings: ${swings.length}`;
        if (trendDir === 'UP' && lastHighs.length >= 2 && lastLows.length >= 2) {
          evidence = `HH(${lastHighs[1].price.toFixed(2)}) + HL(${lastLows[1].price.toFixed(2)})`;
        } else if (trendDir === 'DOWN' && lastHighs.length >= 2 && lastLows.length >= 2) {
          evidence = `LH(${lastHighs[1].price.toFixed(2)}) + LL(${lastLows[1].price.toFixed(2)})`;
        }

        trends[tf] = {
          direction: trendDir === 'UP' ? 'UP' : trendDir === 'DOWN' ? 'DOWN' : 'RANGE',
          confidence: trendDir === 'RANGE' ? 0.3 : 0.8,
          evidence,
        };

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

  // DEDUPLICATION GUARD
  // A given root pattern (e.g. an H1 sweep of 4704.44) keeps generating new
  // pending setups every minute as new FVGs appear in the entry zone. Without
  // dedup, dozens of duplicate orders accumulate at the broker — and if price
  // does retrace, they ALL fill at once, exploding your size.
  //
  // Rule: skip if an ACTIVE pending exists (status=pending/placed/filled) with
  //   - same templateName
  //   - same direction
  //   - entry within 0.5 ATR of the candidate
  // This catches both exact duplicates and "almost same setup, slightly
  // different FVG" cases.
  const tpriceAtr = pendingSetup.plannedEntry > 100 ? 1.5 : 0.0008; // gold vs eurusd-ish
  const activeStatuses = new Set(['pending', 'placed', 'filled']);
  const dup = existing.find((p) =>
    activeStatuses.has(p.status) &&
    p.templateName === pendingSetup.templateName &&
    p.setup?.direction === pendingSetup.setup?.direction &&
    Math.abs(p.plannedEntry - pendingSetup.plannedEntry) < tpriceAtr
  );
  if (dup) {
    await pushCommentary(asset, 'setup-dedup',
      `Skipped duplicate ${pendingSetup.templateName} ${pendingSetup.setup.direction} @ ${pendingSetup.plannedEntry.toFixed(2)} (matches existing ${dup.id})`,
      'dedup-' + pendingSetup.templateName + '-' + pendingSetup.setup.direction
    );
    return { skipped: 'duplicate', existingId: dup.id };
  }

  existing.push(pendingSetup);
  await setPendingSetups(asset, existing);
  return { added: true, id: pendingSetup.id };
}

async function updatePendingSetup(asset, id, updates) {
  const existing = await getPendingSetups(asset);
  const idx = existing.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  existing[idx] = { ...existing[idx], ...updates };
  await setPendingSetups(asset, existing);
  return true;
}

// ===== Cancel a pending order at the broker =====
// If the bot decides a setup is no longer valid AFTER the limit order is at
// MT5 (status='placed'), we have to actually cancel it on the broker — not
// just mark our internal state. Otherwise it sits there waiting to fill at
// the wrong time.
async function cancelBrokerOrder(brokerOrderId) {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region = process.env.METAAPI_REGION || 'london';
  if (!token || !accountId || !brokerOrderId) {
    return { ok: false, error: 'missing credentials or orderId' };
  }
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/trade`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'auth-token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ actionType: 'ORDER_CANCEL', orderId: String(brokerOrderId) }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `MetaAPI ${resp.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Mark a pending setup invalidated + cancel at broker if needed =====
async function invalidateAndCancel(asset, p, reason) {
  // If we already pushed the order to the broker, cancel it there.
  if (p.status === 'placed' && p.brokerOrderId) {
    const result = await cancelBrokerOrder(p.brokerOrderId);
    if (result.ok) {
      await pushCommentary(asset, 'setup-invalidated',
        `🚫 Cancelled at broker: ${p.templateName} ${p.setup.direction} @ ${p.plannedEntry.toFixed(p.plannedEntry > 100 ? 2 : 5)} — ${reason}`);
    } else {
      // Could not cancel — log but still mark internally so we don't try forever.
      await pushCommentary(asset, 'setup-cancel-failed',
        `⚠️ Cancel failed for ${p.templateName} #${p.brokerOrderId}: ${result.error} — ${reason}`);
    }
  } else {
    await pushCommentary(asset, 'setup-invalidated',
      `Setup invalidated: ${p.templateName} ${p.setup.direction} — ${reason}`);
  }
  return { ...p, status: 'invalidated', closedAt: Date.now(), invalidationReason: reason };
}

async function clearExpiredAndInvalidated(asset, currentPrice, atrValue, freshEvents) {
  const existing = await getPendingSetups(asset);
  const now = Date.now();
  const remaining = [];

  // Pull current bias TF trend from fresh events for the bias-flip check
  // V12.4: H1 is now the sole bias TF (TFlab ICT day-trading research)
  const h1Trend = freshEvents?.find((e) => e.type === 'trend' && e.timeframe === '1h')?.direction;

  // Are we currently in any kill zone? (used for stale-context check)
  let inKZ = true;
  let kzName = null;
  try {
    const { checkKillZone } = require('./kill-zones');
    const kz = checkKillZone();
    inKZ = !!kz.inKillZone;
    kzName = kz.name;
  } catch (_) {}

  for (const p of existing) {
    // Skip already-settled setups
    if (p.status !== 'pending' && p.status !== 'placed') {
      remaining.push(p);
      continue;
    }

    // ── 1. Time expired ──────────────────────────────────────────
    if (now > p.expiresAt) {
      const updated = await invalidateAndCancel(asset, p, `expired after ${Math.round((now - p.createdAt)/60000)} min`);
      remaining.push({ ...updated, status: 'expired' });
      continue;
    }

    // ── 2. Price crossed SL before fill (original behavior) ──────
    const slBreached = p.setup.direction === 'LONG'
      ? currentPrice < p.slPrice
      : currentPrice > p.slPrice;
    if (slBreached) {
      const updated = await invalidateAndCancel(asset, p, 'price moved past SL before fill');
      remaining.push(updated);
      continue;
    }

    // ── 3. Price ran 1.5+ ATR past entry IN setup direction ──────
    // For SHORT @ 4700 expecting retrace: if price drops to 4679 (1.5 ATR
    // below entry) without filling, the momentum is gone. Retracement is
    // statistically unlikely now. Kill it.
    const atrDist = atrValue * 1.5;
    const ranAway = p.setup.direction === 'LONG'
      ? currentPrice > p.plannedEntry + atrDist  // LONG limit waiting; price ran up past us
      : currentPrice < p.plannedEntry - atrDist;  // SHORT limit waiting; price ran down past us
    if (ranAway) {
      const distAtr = Math.abs(currentPrice - p.plannedEntry) / atrValue;
      const updated = await invalidateAndCancel(asset, p,
        `price ran ${distAtr.toFixed(1)} ATR past entry without retrace`);
      remaining.push(updated);
      continue;
    }

    // ── 4. HTF bias flipped against setup direction ──────────────
    // If H1 or 4h trend has now reversed, the underlying thesis is dead.
    // We only check this if the trend data is fresh (in this same tick).
    if (h1Trend && h1Trend !== 'NEUTRAL' && h1Trend !== p.setup.direction) {
      const updated = await invalidateAndCancel(asset, p,
        `H1 trend flipped to ${h1Trend}, setup was ${p.setup.direction}`);
      remaining.push(updated);
      continue;
    }

    // ── 5. Stale + out of zone ───────────────────────────────────
    // Setup is more than 60 min old AND price is more than 1 ATR away from
    // the entry zone. The context has likely moved on.
    const ageMin = (now - p.createdAt) / 60000;
    const distFromEntry = Math.abs(currentPrice - p.plannedEntry);
    if (ageMin > 60 && distFromEntry > atrValue) {
      const updated = await invalidateAndCancel(asset, p,
        `stale: ${Math.round(ageMin)} min old, price ${(distFromEntry/atrValue).toFixed(1)} ATR from entry`);
      remaining.push(updated);
      continue;
    }

    // ── 6. Kill zone closed + price not near entry ───────────────
    // If we're OFF_HOURS and price is more than 0.5 ATR from entry, kill it.
    // Don't carry stale entries across to a fresh trading window.
    if (!inKZ && distFromEntry > atrValue * 0.5) {
      const updated = await invalidateAndCancel(asset, p,
        `kill zone closed (${kzName}) and price ${(distFromEntry/atrValue).toFixed(1)} ATR away`);
      remaining.push(updated);
      continue;
    }

    // Setup is still valid — keep it
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

  // V12.4.1: helper to write a "skipped" state so /api/diag can show
  // WHY each asset isn't producing setups, instead of stale state from hours ago.
  async function writeSkipState(reason, extra = {}) {
    const r = getRedis();
    if (!r) return;
    const skipState = {
      asset,
      ts: t0,
      session,
      currentPrice: null,
      atr: null,
      atrByTF: extra.atrByTF || {},
      events: [],
      eventCount: 0,
      coherence: { decision: 'WAIT', reasoning: reason },
      intent: { type: 'IDLE', reason },
      pendingSetups: [],
      myPosition: null,
      news: null,
      structural: null,
      processingMs: Date.now() - t0,
      skipped: reason,
      ...extra,
    };
    try { await r.set(STATE_KEY(asset), JSON.stringify(skipState), { ex: 86400 }); } catch (_) {}
  }

  try {
    // 1. Ensure structural context exists (cheap if cached)
    const structural = await ensureStructuralContext(asset);

    // 2. Run all event detectors (V12.3 event-based flow)
    const evResult = await runEventsForAsset({ asset });
    if (!evResult || !Array.isArray(evResult.events)) {
      await writeSkipState('no events from runEventsForAsset');
      return { asset, error: 'no events', processingMs: Date.now() - t0 };
    }

    // V12.4.1 — diagnostic: count candles received per TF so /api/diag
    // can pinpoint when broker fetch returns empty arrays
    const candleCountsByTF = {};
    for (const tf of Object.keys(evResult.candlesByTF || {})) {
      candleCountsByTF[tf] = (evResult.candlesByTF[tf] || []).length;
    }

    // 3. Get current price + reference ATR (H1)
    // V12.4.1: derive currentPrice from the freshest candle, NOT from
    // MetaAPI's current-price endpoint. The current-price endpoint only
    // works for symbols the account is actively SUBSCRIBED to (streaming),
    // which is typically only the asset you most recently traded. This
    // silently failed for every non-gold asset across V12.1-V12.3, leaving
    // the bot effectively single-asset. Candle data comes via the
    // historical-market-data API which has no subscription requirement.
    const cByTF = evResult.candlesByTF || {};
    const newestCandle =
      (cByTF['5m']?.length && cByTF['5m'][cByTF['5m'].length - 1]) ||
      (cByTF['15m']?.length && cByTF['15m'][cByTF['15m'].length - 1]) ||
      (cByTF['1h']?.length && cByTF['1h'][cByTF['1h'].length - 1]) ||
      null;
    const currentPrice = newestCandle?.close;
    if (!currentPrice || !isFinite(currentPrice) || currentPrice <= 0) {
      await writeSkipState(
        `price unavailable — candles per TF: ${JSON.stringify(candleCountsByTF)}`,
        { candleCountsByTF, fetchErrors: evResult.errors || [] }
      );
      return { asset, error: 'price unavailable (no fresh candle close)', processingMs: Date.now() - t0, candleCountsByTF };
    }
    const h1ATR = evResult.atrByTF?.['1h'];
    if (!h1ATR) {
      await writeSkipState(
        `ATR unavailable — 1h candles count: ${candleCountsByTF['1h'] || 0}, current price: ${currentPrice}`,
        { candleCountsByTF, currentPrice, atrByTF: evResult.atrByTF }
      );
      return { asset, error: 'ATR unavailable', processingMs: Date.now() - t0, candleCountsByTF };
    }

    // 4. Clear expired/invalidated pending setups (smart auto-cancel)
    const pendingSetups = await clearExpiredAndInvalidated(asset, currentPrice, h1ATR, evResult.events);
    const activePending = pendingSetups.filter((p) => p.status === 'pending' || p.status === 'placed');

    // 5. Check for open position on this asset
    const myPosition = openPositions.find((p) => p.assetId === asset);

    // 6. Run coherence checker (V12.3 template matcher)
    const cohResult = checkCoherence({
      events: evResult.events,
      currentPrice,
      atrByTF: evResult.atrByTF || {},
    });

    // 7. Decision logic
    let intent = null;

    if (myPosition) {
      intent = { type: 'HOLD_POSITION', position: myPosition };
    } else if (activePending.length > 0) {
      intent = { type: 'AWAITING_FILL', pending: activePending };
    } else if (cohResult.decision === 'TRADE') {
      // Fresh template-matched setup — propose new pending entry
      const newsFeature = await getNewsFeature(asset).catch(() => ({}));

      // For recognition memory, use the template name + bias direction
      const recognition = await findSimilarTrades({
        asset,
        direction: cohResult.setup.direction,
        mode: cohResult.setup.mode,
        session,
        contributingTactics: [cohResult.setup.templateName], // template name as the "tactic"
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
        templateName: cohResult.setup.templateName,
        narrative: cohResult.setup.narrative,
        recognition: recognition.summary,
        sizing: {
          baseLot: sizing.suggestedLot,
          recommendedLot,
          baseRisk: sizing.riskDollars,
        },
        plannedEntry: cohResult.setup.entry,
        slPrice: cohResult.setup.sl,
        tpLevels: cohResult.setup.tps,
        newsFeature,
        createdAt: Date.now(),
        expiresAt: Date.now() + expiry,
        status: 'pending',
      };

      await addPendingSetup(asset, pendingSetup);

      intent = { type: 'NEW_PENDING', pendingSetup };

      // Commentary — use template name + narrative
      await pushCommentary(asset, 'setup',
        `${cohResult.setup.templateName.toUpperCase()}: ${cohResult.setup.direction} ${cohResult.setup.mode}`,
        pendingSetup.id);
      // Push first 2 lines of narrative as additional commentary
      for (const line of (cohResult.setup.narrative || []).slice(0, 2)) {
        await pushCommentary(asset, 'narrative', line, pendingSetup.id + '-' + Math.random());
      }
      if (recognition.summary.matchCount >= 4) {
        await pushCommentary(asset, 'recognition',
          `Configuration matches ${recognition.summary.matchCount} past trades: ${recognition.summary.wins}W/${recognition.summary.losses}L (${recognition.summary.confidence})`,
          pendingSetup.id + '-rec');
      } else if (recognition.summary.matchCount === 0) {
        await pushCommentary(asset, 'recognition',
          'New configuration — no matching past trades, taking exploratory size',
          pendingSetup.id + '-rec');
      }

      // Telegram: setup brewing
      try {
        await notifySetupBrewing({
          asset,
          direction: cohResult.setup.direction,
          mode: cohResult.setup.mode,
          entry: cohResult.setup.entry,
          sl: cohResult.setup.sl,
          atrValue: h1ATR,
          contributingTactics: [cohResult.setup.templateName],
          biasTactics: cohResult.setup.timeframesInPlay,
        });
      } catch (_) {}
    } else if (cohResult.decision === 'WAIT' && evResult.events.length > 0) {
      intent = { type: 'WATCHING', reason: cohResult.reasoning };

      // Throttled "watching" commentary
      const r = getRedis();
      if (r) {
        const lastRaw = await r.get(`v12:watcher:${asset}:lastWatchingCommentaryAt`).catch(() => null);
        const lastWatching = parseInt(lastRaw, 10) || 0;
        if (Date.now() - lastWatching > WATCHING_THROTTLE_MS) {
          await pushCommentary(asset, 'watching',
            `${evResult.events.length} events on ${asset.toUpperCase()} — no template match yet`);
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
      atr: h1ATR,
      atrByTF: evResult.atrByTF,
      events: evResult.events,
      eventCount: evResult.events.length,
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
    // V12.4.1: write a skip-state on uncaught exception so it's visible in /api/diag
    await writeSkipState(`exception: ${e.message}`);
    return { asset, error: e.message, processingMs: Date.now() - t0 };
  }
}

// =================================================================
// MAIN ENTRY POINT
// =================================================================

async function runWatcherTick() {
  const r = getRedis();

  // Watchlist — 2 assets default (V12.1: dropped BTC for proper LTF coverage on free TwelveData tier)
  let watchlist = ['gold', 'eurusd'];
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
    fetchPositions().catch(() => null),
  ]);
  // null means broker fetch failed — fall back to empty for safety
  // (watcher continues but execute will skip)
  const positions = Array.isArray(positionsResult) ? positionsResult : [];
  const positionsAvailable = positionsResult !== null;

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
module.exports.addPendingSetup = addPendingSetup;
module.exports.updatePendingSetup = updatePendingSetup;
module.exports.clearExpiredAndInvalidated = clearExpiredAndInvalidated;
module.exports.cancelBrokerOrder = cancelBrokerOrder;
module.exports.SETUP_EXPIRY_MS = SETUP_EXPIRY_MS;