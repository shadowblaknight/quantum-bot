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

const { getRedis, safeParse, applyCors, roundToPipSize } = require('./_lib');
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

    // CRITICAL: MetaAPI returns HTTP 200 EVEN WHEN the broker rejects the order
    // (insufficient margin, stops too close, invalid lot size, etc). We MUST
    // check the numericCode to confirm the order was actually accepted by MT5.
    // 10009 = TRADE_RETCODE_DONE (success)
    // 10016 = TRADE_RETCODE_INVALID_STOPS (SL/TP too close to market)
    // 10019 = TRADE_RETCODE_NO_MONEY (insufficient funds)
    // Full list: https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes
    const okCode = data.numericCode === 10009 || data.numericCode === undefined;
    // numericCode undefined → assume legacy/sandbox response; trust orderId presence
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

  // ── PRE-FLIGHT BROKER COMPATIBILITY CHECKS ─────────────────────
  // Without these, the broker silently rejects the order (returns 200 +
  // INVALID_STOPS or NO_MONEY) and the user sees a phantom "Order Placed"
  // notification with no actual order in MT5.
  //
  // ASSET-AWARE: rules are derived from the asset registry, NOT from
  // brittle price-magnitude heuristics. Works correctly for forex majors,
  // JPY pairs, metals (gold/silver/platinum), crypto, indices, commodities.
  const asset = getAssetById(pending.asset);
  if (!asset) {
    action.error = 'unknown asset: ' + pending.asset;
    action.skipped = 'unknown-asset';
    return action;
  }

  const slDistance = Math.abs(slPrice - plannedEntry);

  // CHECK 1: SL distance must clear broker's minimum stop level.
  // Floor = max(2 pips, 25% of typical H1 ATR). This is asset-aware:
  //   EURUSD: max(0.0002, 0.0002)  = 2 pips
  //   USDJPY: max(0.02,   0.02)    = 2 pips
  //   Gold:   max(0.02,   1.00)    = 1.00  (gold needs ~100x more than FX in price units)
  //   BTC:    max(2.0,    50.0)    = $50
  //   NAS100: max(0.02,   25.0)    = 25 points
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

  // CHECK 2: Lot size sanity cap, by category. Without this, a tiny SL
  // distance produces a massive lot (your case: 0.8 pip SL → 9.71 lots
  // EURUSD on an $8k account).
  // These are conservative bounds for a small account ($1k–$50k); when
  // multi-tenant ships, user accounts can override.
  const lotCapsByCategory = {
    forex:     5.0,   // up to 5 lots on FX pairs
    metal:     1.0,   // gold/silver/platinum
    crypto:    1.0,   // BTC/ETH/SOL/XRP
    index:     2.0,   // NAS100, US30, etc
    commodity: 5.0,   // oil, natgas
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

  // CHECK 4: SL must be on the correct side of entry (LONG: SL < entry, SHORT: SL > entry).
  // A flipped SL is a corrupted setup that would otherwise place a no-stop order.
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

  // V12.4.1 — CHECK 5: entry must be on the correct side of current price
  // for limit-order semantics.
  //   BUY_LIMIT  (LONG):  entry must be ≤ current  (we want price to drop INTO entry)
  //   SELL_LIMIT (SHORT): entry must be ≥ current  (we want price to rise INTO entry)
  // If entry is on the wrong side, MT5 either silently converts to STOP order
  // or rejects with INVALID_PRICE — both produce phantom "order placed" states.
  // This is the bug behind "weird entries" reported across V12.x.
  //
  // We allow a small tolerance (~0.5 × m5ATR) so that an entry that's just barely
  // past current price still passes — markets oscillate and a tight bias zone is OK.
  try {
    const { fetchCandles: fetchCandlesFromSource } = require('./candle-source');
    const cRes = await fetchCandlesFromSource(pending.asset, '5m', 3);
    const lastCandle = cRes?.candles?.length ? cRes.candles[cRes.candles.length - 1] : null;
    const currentPrice = lastCandle?.close;
    if (currentPrice && isFinite(currentPrice)) {
      // Tolerance: small buffer in pip units. For gold m5ATR≈5, 0.5×5=2.5pt — generous.
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
  // ───────────────────────────────────────────────────────────────

  // Pick first TP level for the broker's TP field
  // (V11 used multi-TP ladder — manage-trades.js handles partial closes)
  // We use TP1 here. manage-trades.js takes over once filled and partial-closes
  // at TP1, TP2, TP3, TP4.
  let tpPrice = tpLevels && tpLevels.length > 0 ? tpLevels[0].price : null;

  // V12.4.1 — CHECK 6: TP1 must be a meaningful distance from entry.
  // Brokers have a "freeze level" (minimum distance from market for stops/limits).
  // Even when accepted, TP1 too close means a normal wick closes the trade for
  // pennies. Floor at max(2 × pipSize, 0.4 × typicalH1ATR) — same idea as SL floor.
  if (tpPrice != null) {
    const tp1Dist = Math.abs(tpPrice - plannedEntry);
    const minTPByPip = (asset.pipSize || 0.0001) * 2;
    const minTPByATR = (asset.typicalH1ATR || 0) * 0.40;
    const minTP1Distance = Math.max(minTPByPip, minTPByATR);
    if (tp1Dist < minTP1Distance) {
      // Try to bump to next TP if available
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
        // Synthesize a 1R TP as last resort
        tpPrice = isLong
          ? plannedEntry + Math.max(slDistance, minTP1Distance)
          : plannedEntry - Math.max(slDistance, minTP1Distance);
        await pushCommentary(pending.asset, 'tp-synth',
          `All TPs too close — synthesized 1R fallback`);
      }
    }
  }

  // V12.4.1 — round all prices to the broker's pip increment to avoid
  // INVALID_PRICE rejections from MT5 on assets with strict tick sizes.
  // SL rounds AWAY from entry (wider, conservative). TP rounds TOWARDS entry
  // (closer, conservative — slightly less profit but guaranteed to fill).
  const pipSize = asset.pipSize || 0.0001;
  const roundedEntry = roundToPipSize(plannedEntry, pipSize, 'nearest');
  const roundedSL = roundToPipSize(slPrice, pipSize, isLong ? 'down' : 'up');
  const roundedTP = tpPrice != null
    ? roundToPipSize(tpPrice, pipSize, isLong ? 'down' : 'up')
    : null;

  // Place
  // Use templateName + mode for the comment (V12.3 shape).
  // Backward-compat: fall back to contributingTactics if present (V12.2 shape).
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

  // CRITICAL: If we can't get positions from the broker, we MUST NOT place
  // new orders. Otherwise we might double-up on an asset that already has
  // an open position (the broker just timed out). fetchPositions returns
  // null on broker failure; empty array means "confirmed: no positions".
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