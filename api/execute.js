/* eslint-disable */
// V14 — api/execute.js
//
// Places limit orders for pending setups that the watcher emitted.
//
// v14 CHANGE: the autonomous placer is gated behind QB_AUTONOMOUS_ENABLED
// (default OFF). With Pine as the sole trader, this whole engine short-circuits
// — Pine orders are placed by the webhook itself (status 'placed'), never by
// execute (which only ever placed status 'pending' autonomous setups anyway).
// Flip QB_AUTONOMOUS_ENABLED=true to restore the legacy self-trading placer.
//
// CRITICAL SAFETY:
//   1. Only runs if QB_TRADING_ENABLED === 'true' AND QB_AUTONOMOUS_ENABLED === 'true'
//   2. Only places orders for pending setups that are still 'pending'
//   3. Won't place if a position already exists on that asset
//   4. Won't place if the user has paused that asset
//   5. Records the order ID so manage-trades can find it
// ----------------------------------------------------------------------------

const { getRedis, safeParse, applyCors, roundToPipSize } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { resolveSymbol } = require('./symbol-resolver');
const { fetchAccount, fetchPositions } = require('./broker');
const { getPendingSetups, updatePendingSetup, pushCommentary } = require('./watcher');
const { checkKillZone, killZoneDisplayName } = require('./kill-zones');
const { notifyTradePlaced } = require('./telegram');

// ===== Safety: trading enabled flags =====
function isTradingEnabled() {
  return process.env.QB_TRADING_ENABLED === 'true';
}
// v14: autonomous placement gate. Default OFF — Pine (webhook) is the trader.
function isAutonomousEnabled() {
  return process.env.QB_AUTONOMOUS_ENABLED === 'true';
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

    const okCode = data.numericCode === 10009 || data.numericCode === undefined;
    const hasOrderId = !!(data.orderId || data.id);
    if (!okCode || (!hasOrderId && data.numericCode !== undefined)) {
      return {
        ok: false,
        error: `broker rejected order: ${data.stringCode || 'code ' + data.numericCode}: ${data.message || ''}`.slice(0, 300),
        response: data,
      };
    }
    return { ok: true, orderId: data.orderId || data.id || null, response: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Process pending setups for one asset =====
async function processAsset(asset, openPositions) {
  const result = { asset, actions: [] };

  const myPosition = openPositions.find((p) => p.assetId === asset);
  if (myPosition) {
    return { ...result, skipped: 'position-already-open', positionTicket: myPosition.id };
  }

  if (await isAssetPaused(asset)) {
    return { ...result, skipped: 'asset-paused' };
  }

  const pendingList = await getPendingSetups(asset);
  const placeable = pendingList.filter((p) => p.status === 'pending');
  if (placeable.length === 0) {
    return { ...result, skipped: 'no-pending' };
  }

  const brokerSymbol = await resolveSymbol(asset);
  if (!brokerSymbol) {
    return { ...result, error: 'cannot resolve broker symbol' };
  }

  for (const pending of placeable) {
    const action = await tryPlace(pending, brokerSymbol);
    result.actions.push(action);
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

  const kz = checkKillZone();
  if (!kz.inKillZone) {
    action.skipped = 'outside-kill-zone';
    action.killZoneStatus = kz;
    return action;
  }

  const { setup, sizing, plannedEntry, slPrice, tpLevels } = pending;
  if (!setup || !plannedEntry || !slPrice || !sizing?.recommendedLot) {
    action.error = 'invalid pending setup';
    return action;
  }

  const asset = getAssetById(pending.asset);
  if (!asset) {
    action.error = 'unknown asset: ' + pending.asset;
    action.skipped = 'unknown-asset';
    return action;
  }

  const slDistance = Math.abs(slPrice - plannedEntry);

  // CHECK 1: SL distance must clear broker's minimum stop level.
  const minByPip = (asset.pipSize || 0.0001) * 2;
  const minByATR = (asset.typicalH1ATR || 0) * 0.50;
  const minSLDistance = Math.max(minByPip, minByATR);

  if (slDistance < minSLDistance) {
    const slPips = slDistance / (asset.pipSize || 0.0001);
    action.error = `SL distance ${slDistance.toFixed(asset.pipSize < 0.01 ? 5 : 2)} (~${slPips.toFixed(1)} pips) below minimum ${minSLDistance.toFixed(asset.pipSize < 0.01 ? 5 : 2)} for ${asset.name}`;
    action.skipped = 'sl-too-tight';
    await updatePendingSetup(pending.asset, pending.id, {
      status: 'rejected-validation',
      placeError: action.error,
      lastAttemptAt: Date.now(),
    });
    await pushCommentary(pending.asset, 'order-rejected',
      `❌ Rejected before sending: ${action.error}`);
    return action;
  }

  // CHECK 2: Lot size sanity cap, by category.
  const lotCapsByCategory = {
    forex:     5.0,
    metal:     1.0,
    crypto:    1.0,
    index:     2.0,
    commodity: 5.0,
  };
  const maxLotByAsset = lotCapsByCategory[asset.category] || 1.0;
  if (sizing.recommendedLot > maxLotByAsset) {
    action.error = `lot ${sizing.recommendedLot} exceeds max ${maxLotByAsset} for ${asset.category} (tight SL produces oversized position)`;
    action.skipped = 'lot-too-large';
    await updatePendingSetup(pending.asset, pending.id, {
      status: 'rejected-validation',
      placeError: action.error,
      lastAttemptAt: Date.now(),
    });
    await pushCommentary(pending.asset, 'order-rejected',
      `❌ Rejected: lot ${sizing.recommendedLot} > max ${maxLotByAsset} for ${asset.name}. Likely tight-SL artifact.`);
    return action;
  }

  // CHECK 3: All TPs must be on the profit side of entry
  if (tpLevels && tpLevels.length > 0) {
    const isLong = setup.direction === 'LONG';
    const badTPs = tpLevels.filter((tp) => isLong ? tp.price <= plannedEntry : tp.price >= plannedEntry);
    if (badTPs.length > 0) {
      action.error = `${badTPs.length} TP level(s) on wrong side of entry — corrupted setup`;
      action.skipped = 'bad-tp-direction';
      await updatePendingSetup(pending.asset, pending.id, {
        status: 'rejected-validation',
        placeError: action.error,
        lastAttemptAt: Date.now(),
      });
      await pushCommentary(pending.asset, 'order-rejected',
        `❌ Rejected: ${action.error}`);
      return action;
    }
  }

  // CHECK 4: SL must be on the correct side of entry.
  const isLong = setup.direction === 'LONG';
  const slOnWrongSide = isLong ? slPrice >= plannedEntry : slPrice <= plannedEntry;
  if (slOnWrongSide) {
    action.error = `SL on wrong side of entry for ${setup.direction} (entry=${plannedEntry}, SL=${slPrice}) — corrupted setup`;
    action.skipped = 'bad-sl-direction';
    await updatePendingSetup(pending.asset, pending.id, {
      status: 'rejected-validation',
      placeError: action.error,
      lastAttemptAt: Date.now(),
    });
    await pushCommentary(pending.asset, 'order-rejected',
      `❌ Rejected: ${action.error}`);
    return action;
  }

  // CHECK 5: entry must be on the correct side of current price for limit semantics.
  try {
    const { fetchCandles: fetchCandlesFromSource } = require('./candle-source');
    const cRes = await fetchCandlesFromSource(pending.asset, '5m', 3);
    const lastCandle = cRes?.candles?.length ? cRes.candles[cRes.candles.length - 1] : null;
    const currentPrice = lastCandle?.close;
    if (currentPrice && isFinite(currentPrice)) {
      const m5HighLow = lastCandle.high - lastCandle.low;
      const tolerance = Math.max(m5HighLow * 0.5, (asset.pipSize || 0.0001) * 5);
      const entryOnWrongSide = isLong
        ? plannedEntry > currentPrice + tolerance
        : plannedEntry < currentPrice - tolerance;
      if (entryOnWrongSide) {
        const dir = isLong ? 'above' : 'below';
        action.error =
          `Entry ${plannedEntry} is ${dir} current ${currentPrice.toFixed(asset.pipSize < 0.01 ? 5 : 2)} — ` +
          `${isLong ? 'BUY_LIMIT requires entry ≤ current' : 'SELL_LIMIT requires entry ≥ current'} ` +
          `(market moved past the entry zone)`;
        action.skipped = 'entry-wrong-side-of-market';
        await updatePendingSetup(pending.asset, pending.id, {
          status: 'invalidated',
          invalidationReason: action.error,
          lastAttemptAt: Date.now(),
        });
        await pushCommentary(pending.asset, 'order-rejected',
          `❌ Rejected: market moved past entry — setup invalidated`);
        return action;
      }
    }
  } catch (_) {
    // If candle fetch fails, fall through and let MT5 reject if entry is bad.
  }

  // v14 all-or-nothing: broker TP parks at the LAST configured target so the full
  // position rides there; SL ratchets to earlier TPs in manage-trades (no partials).
  let tpPrice = tpLevels && tpLevels.length > 0 ? tpLevels[tpLevels.length - 1].price : null;

  // CHECK 6: TP1 must be a meaningful distance from entry.
  if (tpPrice != null) {
    const tp1Dist = Math.abs(tpPrice - plannedEntry);
    const minTPByPip = (asset.pipSize || 0.0001) * 2;
    const minTPByATR = (asset.typicalH1ATR || 0) * 0.40;
    const minTP1Distance = Math.max(minTPByPip, minTPByATR);
    if (tp1Dist < minTP1Distance) {
      let promoted = null;
      for (let i = 1; i < tpLevels.length; i++) {
        const candDist = Math.abs(tpLevels[i].price - plannedEntry);
        if (candDist >= minTP1Distance) { promoted = tpLevels[i]; break; }
      }
      if (promoted) {
        tpPrice = promoted.price;
        await pushCommentary(pending.asset, 'tp-promoted',
          `TP1 too close (${tp1Dist.toFixed(asset.pipSize < 0.01 ? 5 : 2)}); promoted to ${promoted.label}`);
      } else {
        tpPrice = isLong
          ? plannedEntry + Math.max(slDistance, minTP1Distance)
          : plannedEntry - Math.max(slDistance, minTP1Distance);
        await pushCommentary(pending.asset, 'tp-synth',
          `All TPs too close — synthesized 1R fallback`);
      }
    }
  }

  const pipSize = asset.pipSize || 0.0001;
  const roundedEntry = roundToPipSize(plannedEntry, pipSize, 'nearest');
  const roundedSL = roundToPipSize(slPrice, pipSize, isLong ? 'down' : 'up');
  const roundedTP = tpPrice != null
    ? roundToPipSize(tpPrice, pipSize, isLong ? 'down' : 'up')
    : null;

  const commentLabel = setup.templateName
    || (Array.isArray(setup.contributingTactics) ? setup.contributingTactics.join('+') : 'setup');
  const placement = await placeLimitOrder(
    brokerSymbol,
    setup.direction,
    sizing.recommendedLot,
    roundedEntry,
    roundedSL,
    roundedTP,
    `QB-V12-${setup.mode || 'DAY'}-${commentLabel}`.slice(0, 64),
  );

  if (placement.ok) {
    await updatePendingSetup(pending.asset, pending.id, {
      status: 'placed',
      brokerOrderId: placement.orderId,
      placedAt: Date.now(),
      placedKillZone: kz.name,
      placedEntry: roundedEntry,
      placedSL: roundedSL,
      placedTP: roundedTP,
    });
    await pushCommentary(pending.asset, 'order-placed',
      `Limit order placed in ${killZoneDisplayName(kz.name)}: ${setup.direction} ${sizing.recommendedLot} lot @ ${roundedEntry.toFixed(roundedEntry > 100 ? 2 : 5)}, SL ${roundedSL.toFixed(roundedSL > 100 ? 2 : 5)}`);

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
        template: setup.templateName,
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

  // v14: Pine is the trader by default. The autonomous placer only runs when
  // explicitly enabled — otherwise this is a no-op (Pine orders are placed by
  // the webhook directly, never here).
  if (!isAutonomousEnabled()) {
    return {
      ts: Date.now(),
      tradingEnabled: true,
      autonomousEnabled: false,
      skipped: 'autonomous-disabled',
      message: 'Autonomous placement off — Pine (webhook) is the trader. Set QB_AUTONOMOUS_ENABLED=true to enable the legacy self-trading engine.',
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

  const positions = await fetchPositions();
  if (positions === null) {
    console.warn('[execute] broker positions fetch failed — skipping tick to avoid duplicate orders');
    return {
      ts: Date.now(),
      tradingEnabled: true,
      skipped: 'broker-positions-unavailable',
      watchlist,
    };
  }

  const results = await Promise.all(
    watchlist.map((asset) => processAsset(asset, positions))
  );

  const kz = checkKillZone();
  return {
    ts: Date.now(),
    tradingEnabled: true,
    autonomousEnabled: true,
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
module.exports.processAsset = processAsset;
module.exports.tryPlace = tryPlace;
module.exports.placeLimitOrder = placeLimitOrder;
module.exports.isTradingEnabled = isTradingEnabled;
module.exports.isAutonomousEnabled = isAutonomousEnabled;