/* eslint-disable */
// V12 — api/execute.js
//
// Places limit orders for pending setups that the watcher emitted.
//
// CRITICAL SAFETY:
//   1. Only runs if process.env.QB_TRADING_ENABLED === 'true'
//   2. Only places orders for pending setups that are still 'pending'
//   3. Won't place if a position already exists on that asset
//   4. Won't place if the user has paused that asset
//   5. Records the order ID so manage-trades can find it
//   6. Captures full feature vector at entry time (for recognition memory)
//
// ORDER TYPE: We use LIMIT orders at the planned entry price. This is
// deliberate — we don't chase price. If price doesn't return to entry within
// the setup's expiry window, the limit cancels.
//
// LIVE BEHAVIOR:
//   - Watcher detects setup, writes pending record
//   - Execute (called next tick or by event) reads pending records
//   - Execute filters: pending + still valid + position not open + asset not paused
//   - Execute places limit order via MetaAPI
//   - Execute updates pending record with brokerOrderId, status='placed'
//   - When fill occurs, MetaAPI position appears
//   - manage-trades.js picks up the position, manages TP/SL
//
// This file is INTENTIONALLY narrow. Only one job: turn 'pending' setups into
// placed limit orders.
// ----------------------------------------------------------------------------

const { getRedis, safeParse, applyCors } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { resolveSymbol } = require('./symbol-resolver');
const { fetchAccount, fetchPositions } = require('./broker');
const { getPendingSetups, updatePendingSetup, pushCommentary } = require('./watcher');
const { checkKillZone, killZoneDisplayName } = require('./kill-zones');
const { notifyTradePlaced } = require('./telegram');

// ===== Safety: trading enabled flag =====
function isTradingEnabled() {
  return process.env.QB_TRADING_ENABLED === 'true';
}

// ===== Asset paused state =====
async function isAssetPaused(asset) {
  const r = getRedis();
  if (!r) return false;
  try {
    const raw = await r.get(`v12:user:pauseOnAsset:${asset}`).catch(() => null);
    return raw === 'true' || raw === true;
  } catch (_) {
    return false;
  }
}

// ===== Place a limit order via MetaAPI =====
async function placeLimitOrder(brokerSymbol, direction, lot, entryPrice, slPrice, tpPrice, comment) {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region = process.env.METAAPI_REGION || 'london';
  if (!token || !accountId) {
    return { ok: false, error: 'MetaAPI credentials missing' };
  }

  // Order action: BUY_LIMIT or SELL_LIMIT
  // BUY_LIMIT: pending order to buy at entryPrice (price must come down to it)
  // SELL_LIMIT: pending order to sell at entryPrice (price must come up to it)
  const actionType = direction === 'LONG' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';

  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/trade`;
  const payload = {
    actionType,
    symbol: brokerSymbol,
    volume: lot,
    openPrice: entryPrice,
    stopLoss: slPrice,
    takeProfit: tpPrice,
    comment: comment || 'QB-V12',
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'auth-token': token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `MetaAPI ${resp.status}: ${txt.slice(0, 300)}` };
    }
    const data = await resp.json();
    return { ok: true, orderId: data.orderId || data.id || null, response: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Process pending setups for one asset =====
async function processAsset(asset, openPositions) {
  const result = { asset, actions: [] };

  // Skip if position already open
  const myPosition = openPositions.find((p) => p.assetId === asset);
  if (myPosition) {
    return { ...result, skipped: 'position-already-open', positionTicket: myPosition.id };
  }

  // Skip if user paused this asset
  if (await isAssetPaused(asset)) {
    return { ...result, skipped: 'asset-paused' };
  }

  const pendingList = await getPendingSetups(asset);
  const placeable = pendingList.filter((p) => p.status === 'pending');
  if (placeable.length === 0) {
    return { ...result, skipped: 'no-pending' };
  }

  // Resolve broker symbol once
  const brokerSymbol = await resolveSymbol(asset);
  if (!brokerSymbol) {
    return { ...result, error: 'cannot resolve broker symbol' };
  }

  // For each pending setup, try to place
  for (const pending of placeable) {
    const action = await tryPlace(pending, brokerSymbol);
    result.actions.push(action);
    // Only place ONE order per asset per tick — we want to be conservative
    if (action.placed) break;
  }

  return result;
}

async function tryPlace(pending, brokerSymbol) {
  const action = { id: pending.id, attempted: true, placed: false };

  if (!isTradingEnabled()) {
    action.skipped = 'trading-disabled';
    return action;
  }

  // SOFT KILL ZONE GATE — limit orders are only placed inside a kill zone.
  // The setup itself was created by the watcher (which runs 24/7); this
  // guard prevents the order from being filled outside of high-liquidity
  // institutional windows. Pending setups carried into a KZ will be
  // executed when the gate opens.
  const kz = checkKillZone();
  if (!kz.inKillZone) {
    action.skipped = 'outside-kill-zone';
    action.killZoneStatus = kz;
    return action;
  }

  // Validate setup
  const { setup, sizing, plannedEntry, slPrice, tpLevels } = pending;
  if (!setup || !plannedEntry || !slPrice || !sizing?.recommendedLot) {
    action.error = 'invalid pending setup';
    return action;
  }

  // Pick first TP level for the broker's TP field
  // (V11 used multi-TP ladder — manage-trades.js handles partial closes)
  // We use TP1 here. manage-trades.js takes over once filled and partial-closes
  // at TP1, TP2, TP3, TP4.
  const tpPrice = tpLevels && tpLevels.length > 0 ? tpLevels[0].price : null;

  // Place
  // Use templateName + mode for the comment (V12.3 shape).
  // Backward-compat: fall back to contributingTactics if present (V12.2 shape).
  const commentLabel = setup.templateName
    || (Array.isArray(setup.contributingTactics) ? setup.contributingTactics.join('+') : 'setup');
  const placement = await placeLimitOrder(
    brokerSymbol,
    setup.direction,
    sizing.recommendedLot,
    plannedEntry,
    slPrice,
    tpPrice,
    `QB-V12-${setup.mode || 'DAY'}-${commentLabel}`.slice(0, 64),
  );

  if (placement.ok) {
    await updatePendingSetup(pending.asset, pending.id, {
      status: 'placed',
      brokerOrderId: placement.orderId,
      placedAt: Date.now(),
      placedKillZone: kz.name,
    });
    await pushCommentary(pending.asset, 'order-placed',
      `Limit order placed in ${killZoneDisplayName(kz.name)}: ${setup.direction} ${sizing.recommendedLot} lot @ ${plannedEntry.toFixed(plannedEntry > 100 ? 2 : 5)}, SL ${slPrice.toFixed(slPrice > 100 ? 2 : 5)}`);

    // Telegram: trade placed
    try {
      await notifyTradePlaced({
        asset: pending.asset,
        direction: setup.direction,
        lot: sizing.recommendedLot,
        entry: plannedEntry,
        sl: slPrice,
        tpLevels: tpLevels || [],
        riskDollars: sizing.baseRisk,
        brokerOrderId: placement.orderId,
      });
    } catch (_) {}

    action.placed = true;
    action.brokerOrderId = placement.orderId;
    action.killZone = kz.name;
  } else {
    await updatePendingSetup(pending.asset, pending.id, {
      status: 'place-failed',
      placeError: placement.error,
      lastAttemptAt: Date.now(),
    });
    await pushCommentary(pending.asset, 'order-failed',
      `Failed to place order: ${placement.error?.slice(0, 100)}`);
    action.error = placement.error;
  }

  return action;
}

// =================================================================
// MAIN ENTRY POINT
// =================================================================

async function runExecuteTick() {
  if (!isTradingEnabled()) {
    return {
      ts: Date.now(),
      tradingEnabled: false,
      message: 'Trading disabled. Set QB_TRADING_ENABLED=true in env to enable.',
    };
  }

  const r = getRedis();
  let watchlist = ['gold', 'eurusd'];
  if (r) {
    try {
      const raw = await r.get('v12:watchlist').catch(() => null);
      const parsed = safeParse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        watchlist = parsed.filter((a) => getAssetById(a));
      }
    } catch (_) {}
  }

  const positionsResult = await fetchPositions().catch(() => []);
  const positions = Array.isArray(positionsResult) ? positionsResult : [];

  const results = await Promise.all(
    watchlist.map((asset) => processAsset(asset, positions))
  );

  const kz = checkKillZone();
  return {
    ts: Date.now(),
    tradingEnabled: true,
    killZone: kz,
    watchlist,
    openPositions: positions.length,
    results,
    placedCount: results.reduce((sum, r) => sum + (r.actions || []).filter((a) => a.placed).length, 0),
    skippedKZCount: results.reduce((sum, r) => sum + (r.actions || []).filter((a) => a.skipped === 'outside-kill-zone').length, 0),
  };
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const result = await runExecuteTick();
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.runExecuteTick = runExecuteTick;
module.exports.placeLimitOrder = placeLimitOrder;
module.exports.isTradingEnabled = isTradingEnabled;