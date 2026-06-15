/* eslint-disable */
// V14 — api/watcher.js
//
// CONTINUOUS-STATE WATCHER. Replaces V11's snapshot-cron architecture.
//
// v14 CHANGES (two-trader coherence — Pine is the authoritative trader):
//   1. AUTONOMOUS GENERATION GATE. The watcher's own template-matched setups are
//      only created when QB_AUTONOMOUS_ENABLED === 'true'. Default OFF, so the
//      cron watcher no longer competes with Pine by generating its own trades.
//      (State/commentary/structural context still update — useful for /api/diag.)
//   2. PINE-ORDER SHIELD. clearExpiredAndInvalidated applies only the OBJECTIVE
//      invalidations (time-expiry, SL-breach) to Pine-originated orders (v13:true).
//      The watcher's autonomous opinions (ran-away, HTF-flip, stale, KZ-closed)
//      must NEVER cancel a Pine order — Pine owns that decision. Without this the
//      watcher would silently cancel webhook orders at the broker.
//
// Each invocation:
//   1. Loads the bot's running mental model from Redis (per asset)
//   2. Updates with fresh tactic detection results
//   3. Tracks pending limit orders (entries waiting for price retest)
//   4. Expires setups that have aged out
//   5. Persists updated model
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

// v14: autonomous generation is OFF unless explicitly enabled. With it off, the
// cron watcher observes and narrates but does not place its own trades — Pine
// (via the webhook) is the sole trader. Flip QB_AUTONOMOUS_ENABLED=true to
// re-enable the legacy self-trading engine.
function isAutonomousEnabled() {
  return process.env.QB_AUTONOMOUS_ENABLED === 'true';
}

// ===== Setup expiration by mode (in ms) =====
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

async function ensureStructuralContext(asset) {
  const r = getRedis();
  if (!r) return null;

  const raw = await r.get(STRUCT_KEY(asset)).catch(() => null);
  const cached = safeParse(raw);
  if (cached && cached.builtAt && (Date.now() - cached.builtAt < 24 * 60 * 60 * 1000)) {
    return cached;
  }

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

  const ctx = { asset, builtAt: Date.now(), trends, levels };

  try {
    await r.set(STRUCT_KEY(asset), JSON.stringify(ctx), { ex: 7 * 86400 });
  } catch (_) {}

  return ctx;
}

// =================================================================
// PENDING SETUP TRACKING
// =================================================================

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
  if (p.status === 'placed' && p.brokerOrderId) {
    const result = await cancelBrokerOrder(p.brokerOrderId);
    if (result.ok) {
      await pushCommentary(asset, 'setup-invalidated',
        `🚫 Cancelled at broker: ${p.templateName} ${p.setup.direction} @ ${p.plannedEntry.toFixed(p.plannedEntry > 100 ? 2 : 5)} — ${reason}`);
    } else {
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

  const h1Trend = freshEvents?.find((e) => e.type === 'trend' && e.timeframe === '1h')?.direction;

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

    // ── 1. Time expired ── (applies to ALL orders, including Pine)
    if (now > p.expiresAt) {
      const updated = await invalidateAndCancel(asset, p, `expired after ${Math.round((now - p.createdAt)/60000)} min`);
      remaining.push({ ...updated, status: 'expired' });
      continue;
    }

    // ── 2. Price crossed SL before fill ── (objective; applies to ALL)
    const slBreached = p.setup.direction === 'LONG'
      ? currentPrice < p.slPrice
      : currentPrice > p.slPrice;
    if (slBreached) {
      const updated = await invalidateAndCancel(asset, p, 'price moved past SL before fill');
      remaining.push(updated);
      continue;
    }

    // v14 PINE-ORDER SHIELD: Pine-originated orders (v13:true) are owned by Pine.
    // Only the objective checks above (time-expiry, SL-breach) may cancel them.
    // The watcher's autonomous OPINIONS below must not touch a Pine order — that
    // was the bug where the cron silently cancelled webhook orders at the broker.
    if (!p.v13) {
      // ── 3. Price ran 1.5+ ATR past entry IN setup direction ──
      const atrDist = atrValue * 1.5;
      const ranAway = p.setup.direction === 'LONG'
        ? currentPrice > p.plannedEntry + atrDist
        : currentPrice < p.plannedEntry - atrDist;
      if (ranAway) {
        const distAtr = Math.abs(currentPrice - p.plannedEntry) / atrValue;
        const updated = await invalidateAndCancel(asset, p,
          `price ran ${distAtr.toFixed(1)} ATR past entry without retrace`);
        remaining.push(updated);
        continue;
      }

      // ── 4. HTF bias flipped against setup direction ──
      if (h1Trend && h1Trend !== 'NEUTRAL' && h1Trend !== p.setup.direction) {
        const updated = await invalidateAndCancel(asset, p,
          `H1 trend flipped to ${h1Trend}, setup was ${p.setup.direction}`);
        remaining.push(updated);
        continue;
      }

      // ── 5. Stale + out of zone ──
      const ageMin = (now - p.createdAt) / 60000;
      const distFromEntry = Math.abs(currentPrice - p.plannedEntry);
      if (ageMin > 60 && distFromEntry > atrValue) {
        const updated = await invalidateAndCancel(asset, p,
          `stale: ${Math.round(ageMin)} min old, price ${(distFromEntry/atrValue).toFixed(1)} ATR from entry`);
        remaining.push(updated);
        continue;
      }

      // ── 6. Kill zone closed + price not near entry ──
      if (!inKZ && distFromEntry > atrValue * 0.5) {
        const updated = await invalidateAndCancel(asset, p,
          `kill zone closed (${kzName}) and price ${(distFromEntry/atrValue).toFixed(1)} ATR away`);
        remaining.push(updated);
        continue;
      }
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

  async function writeSkipState(reason, extra = {}) {
    const r = getRedis();
    if (!r) return;
    const skipState = {
      asset, ts: t0, session,
      currentPrice: null, atr: null, atrByTF: extra.atrByTF || {},
      events: [], eventCount: 0,
      coherence: { decision: 'WAIT', reasoning: reason },
      intent: { type: 'IDLE', reason },
      pendingSetups: [], myPosition: null, news: null, structural: null,
      processingMs: Date.now() - t0, skipped: reason, ...extra,
    };
    try { await r.set(STATE_KEY(asset), JSON.stringify(skipState), { ex: 86400 }); } catch (_) {}
  }

  try {
    const structural = await ensureStructuralContext(asset);

    const evResult = await runEventsForAsset({ asset });
    if (!evResult || !Array.isArray(evResult.events)) {
      await writeSkipState('no events from runEventsForAsset');
      return { asset, error: 'no events', processingMs: Date.now() - t0 };
    }

    const candleCountsByTF = {};
    for (const tf of Object.keys(evResult.candlesByTF || {})) {
      candleCountsByTF[tf] = (evResult.candlesByTF[tf] || []).length;
    }

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

    const pendingSetups = await clearExpiredAndInvalidated(asset, currentPrice, h1ATR, evResult.events);
    const activePending = pendingSetups.filter((p) => p.status === 'pending' || p.status === 'placed');

    const myPosition = openPositions.find((p) => p.assetId === asset);

    const cohResult = checkCoherence({
      events: evResult.events,
      currentPrice,
      atrByTF: evResult.atrByTF || {},
    });

    let intent = null;

    if (myPosition) {
      intent = { type: 'HOLD_POSITION', position: myPosition };
    } else if (activePending.length > 0) {
      intent = { type: 'AWAITING_FILL', pending: activePending };
    } else if (cohResult.decision === 'TRADE' && !isAutonomousEnabled()) {
      // v14: a template matched, but autonomous trading is OFF. Pine is the
      // trader — the watcher only narrates. No pending setup is generated.
      intent = { type: 'WATCHING', reason: `autonomous OFF — ${cohResult.templateName || 'template'} matched but Pine owns execution` };
    } else if (cohResult.decision === 'TRADE') {
      // Fresh template-matched setup — propose new pending entry (autonomous ON)
      const newsFeature = await getNewsFeature(asset).catch(() => ({}));

      const recognition = await findSimilarTrades({
        asset,
        direction: cohResult.setup.direction,
        mode: cohResult.setup.mode,
        session,
        contributingTactics: [cohResult.setup.templateName],
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

      await pushCommentary(asset, 'setup',
        `${cohResult.setup.templateName.toUpperCase()}: ${cohResult.setup.direction} ${cohResult.setup.mode}`,
        pendingSetup.id);
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

    const news = await getNewsContext(asset).catch(() => null);
    const state = {
      asset, ts: t0, session,
      currentPrice, atr: h1ATR, atrByTF: evResult.atrByTF,
      events: evResult.events, eventCount: evResult.events.length,
      coherence: cohResult, intent,
      pendingSetups: await getPendingSetups(asset),
      myPosition, news, structural,
      processingMs: Date.now() - t0,
    };

    const r = getRedis();
    if (r) {
      await r.set(STATE_KEY(asset), JSON.stringify(state), { ex: 86400 }).catch(() => {});
    }

    return state;
  } catch (e) {
    await writeSkipState(`exception: ${e.message}`);
    return { asset, error: e.message, processingMs: Date.now() - t0 };
  }
}

// =================================================================
// MAIN ENTRY POINT
// =================================================================

async function runWatcherTick() {
  const r = getRedis();

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

  const [account, positionsResult] = await Promise.all([
    fetchAccount().catch(() => null),
    fetchPositions().catch(() => null),
  ]);
  const positions = Array.isArray(positionsResult) ? positionsResult : [];
  const positionsAvailable = positionsResult !== null;

  const results = await Promise.all(
    watchlist.map((asset) => processAsset(asset, account, positions))
  );

  return {
    ts: Date.now(),
    session: getCurrentSession(),
    autonomousEnabled: isAutonomousEnabled(),
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
module.exports.addPendingSetup = addPendingSetup;
module.exports.clearExpiredAndInvalidated = clearExpiredAndInvalidated;
module.exports.cancelBrokerOrder = cancelBrokerOrder;
module.exports.isAutonomousEnabled = isAutonomousEnabled;
module.exports.SETUP_EXPIRY_MS = SETUP_EXPIRY_MS;