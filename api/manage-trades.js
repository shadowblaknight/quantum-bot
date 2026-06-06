/* eslint-disable */
// V13 — api/manage-trades.js  (v1.3 — adds missing addDailyPnL call)
//
// v1.3 CHANGE (one-line fix that unbroke daily P&L):
//   v1.2 stored closed trades into recognition memory via storeClosedTrade()
//   but NEVER called addDailyPnL(). The dashboard's "Today realized P&L"
//   reads from v13:pilot:daily-pnl:YYYY-MM-DD which was never written.
//   Now: each closed trade contributes its totalPnL to today's daily-pnl key.
//
// v1.2 behavior (unchanged):
//   - At TP1 hit: close 33% of original lot, move SL to TP1
//   - At TP2 hit: close 33% of original lot, move SL to TP2
//   - At TP3 hit: close remaining 34%, position fully closed
//   - When SL hit: position closes naturally
//   - Trailing: once 2R+ in profit AND 2 TPs hit, also enable trailing stop at 1 ATR
// ----------------------------------------------------------------------------

const { getRedis, safeParse, applyCors, atr, getCurrentSession, roundToPipSize } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { resolveSymbol, resolveAsset } = require('./symbol-resolver');
const { fetchPositions, fetchCandles } = require('./broker');
const { getPendingSetups, updatePendingSetup, pushCommentary } = require('./watcher');
const { storeClosedTrade } = require('./recognition-memory');
const { addDailyPnL } = require('./rules-store');   // v1.3: NEW import
const { notifyTPHit, notifySLHit, notifyTradeClosed } = require('./telegram');
const { checkAllWatchedSetups } = require('./watched-setups-checker');

// ===== Position management state =====
const POSITION_STATE_KEY = (positionId) => `v12:position:${positionId}:state`;

// ===== Trading enabled gate =====
function isTradingEnabled() {
  return process.env.QB_TRADING_ENABLED === 'true';
}

// =================================================================
// $ ESTIMATION FROM PRICE DISTANCE
// =================================================================

function estimateDollarsFromDistance(assetId, distance, lot) {
  const meta = getAssetById(assetId);
  if (!meta || !meta.pipSize || !meta.dollarPerPipPerLot) return null;
  const pips = Math.abs(distance) / meta.pipSize;
  return pips * meta.dollarPerPipPerLot * lot;
}

function signedDollarsForLeg(assetId, entryPrice, exitPrice, direction, lot) {
  const meta = getAssetById(assetId);
  if (!meta || !meta.pipSize || !meta.dollarPerPipPerLot) return null;
  const isLong = direction === 'LONG';
  const signedDistance = isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  const signedPips = signedDistance / meta.pipSize;
  return signedPips * meta.dollarPerPipPerLot * lot;
}

// ===== MetaAPI: modify position SL/TP =====
async function modifyPosition(positionId, slPrice, tpPrice, assetId) {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region = process.env.METAAPI_REGION || 'london';
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/trade`;

  let sl = slPrice, tp = tpPrice;
  if (assetId) {
    const meta = getAssetById(assetId);
    if (meta && meta.pipSize) {
      sl = roundToPipSize(slPrice, meta.pipSize, 'nearest');
      tp = roundToPipSize(tpPrice, meta.pipSize, 'nearest');
    }
  }

  const payload = {
    actionType: 'POSITION_MODIFY',
    positionId,
    stopLoss: sl,
    takeProfit: tp,
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'auth-token': token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `modify ${resp.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== MetaAPI: partial close =====
async function partialClose(positionId, lotToClose) {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region = process.env.METAAPI_REGION || 'london';
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/trade`;
  const payload = {
    actionType: 'POSITION_PARTIAL',
    positionId,
    volume: lotToClose,
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'auth-token': token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `partial ${resp.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Get historical closed trades from MetaAPI for the past 24h =====
async function fetchClosedTradesRecent() {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region = process.env.METAAPI_REGION || 'london';
  const since = new Date(Date.now() - 86400000).toISOString();
  const until = new Date().toISOString();
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time/${since}/${until}`;
  try {
    const resp = await fetch(url, { headers: { 'auth-token': token, 'Accept': 'application/json' } });
    if (!resp.ok) return [];
    const deals = await resp.json();
    return Array.isArray(deals) ? deals : [];
  } catch (_) {
    return [];
  }
}

// =================================================================
// POSITION STATE TRACKING
// =================================================================

async function getPositionState(positionId) {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(POSITION_STATE_KEY(positionId)).catch(() => null);
    return safeParse(raw);
  } catch (_) {
    return null;
  }
}

async function setPositionState(positionId, state) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(POSITION_STATE_KEY(positionId), JSON.stringify(state), { ex: 86400 * 7 });
  } catch (_) {}
}

// =================================================================
// MANAGE A SINGLE POSITION
// =================================================================

async function managePosition(position) {
  if (!isTradingEnabled()) return { id: position.id, skipped: 'trading-disabled' };

  if (!position.comment || !(position.comment.startsWith('QB-V12-') || position.comment.startsWith('QB-V13-'))) {
    return { id: position.id, skipped: 'not-managed-position' };
  }

  const asset = position.assetId || await resolveAsset(position.symbol);
  if (!asset) return { id: position.id, error: 'cannot resolve asset' };

  const isLong = position.type === 'POSITION_TYPE_BUY' || position.direction === 'LONG';
  const direction = isLong ? 'LONG' : 'SHORT';

  const pendingList = await getPendingSetups(asset);

  let matchedPending = pendingList.find((p) =>
    p.positionId && p.positionId === position.id &&
    (p.status === 'placed' || p.status === 'filled')
  );

  if (!matchedPending) {
    const isGold = position.openPrice > 100;
    const priceTolerance = isGold ? 2.0 : position.openPrice * 0.0005;

    matchedPending = pendingList.find((p) => {
      if (p.status !== 'placed' && p.status !== 'filled') return false;
      if (p.setup.direction !== direction) return false;
      if (Math.abs(p.plannedEntry - position.openPrice) > priceTolerance) return false;

      const entry = position.openPrice;
      const tps = p.tpLevels || [];
      if (tps.length === 0) return false;
      const tpsCorrectSide = tps.every((tp) =>
        isLong ? tp.price > entry : tp.price < entry
      );
      if (!tpsCorrectSide) return false;

      return true;
    });
  }

  if (matchedPending && matchedPending.status === 'placed') {
    await updatePendingSetup(asset, matchedPending.id, {
      status: 'filled',
      filledAt: Date.now(),
      actualEntry: position.openPrice,
      positionId: position.id,
    });
    await pushCommentary(asset, 'fill',
      `Order filled: ${direction} ${position.volume} lot @ ${position.openPrice.toFixed(position.openPrice > 100 ? 2 : 5)}`);
  }

  if (!matchedPending) {
    return { id: position.id, error: 'no matching pending setup found', positionId: position.id };
  }

  let state = await getPositionState(position.id);
  if (!state) {
    state = {
      positionId: position.id,
      asset,
      direction,
      originalLot: position.volume,
      entry: position.openPrice,
      pendingId: matchedPending.id,
      tpsHit: [],
      slMoves: [],
      partialCloses: [],
      createdAt: Date.now(),
    };
    await setPositionState(position.id, state);
  }

  const tpLevels = matchedPending.tpLevels || [];
  if (tpLevels.length === 0) {
    return { id: position.id, error: 'no TP levels in pending setup' };
  }

  const currentPrice = position.currentPrice || position.openPrice;
  const actions = [];

  // ─── TP HIT DETECTION ────────────────────────────────────────────
  for (let i = 0; i < tpLevels.length && i < 3; i++) {
    const tpName = `TP${i + 1}`;
    if (state.tpsHit.includes(tpName)) continue;

    const tpPrice = tpLevels[i].price;

    const tpOnProfitSide = isLong ? tpPrice > state.entry : tpPrice < state.entry;
    if (!tpOnProfitSide) {
      actions.push({ action: 'tp-skipped', tpName, reason: 'tp-on-loss-side', tpPrice, entry: state.entry });
      continue;
    }

    const hit = isLong ? currentPrice >= tpPrice : currentPrice <= tpPrice;
    if (!hit) continue;

    const closingFinalTP = (i === 2) || (i === tpLevels.length - 1);
    let lotToClose;
    if (closingFinalTP) {
      lotToClose = position.volume;
    } else {
      lotToClose = Math.max(0.01, Math.round(state.originalLot * 0.33 * 100) / 100);
      if (lotToClose > position.volume) lotToClose = position.volume;
    }

    const closeResult = await partialClose(position.id, lotToClose);
    if (closeResult.ok) {
      state.tpsHit.push(tpName);
      state.partialCloses.push({ tpName, lotClosed: lotToClose, atPrice: tpPrice, ts: Date.now() });
      actions.push({ action: 'partial-close', tpName, lotClosed: lotToClose, ok: true });

      await pushCommentary(asset, 'tp-hit',
        `${tpName} hit @ ${tpPrice.toFixed(tpPrice > 100 ? 2 : 5)} — closed ${lotToClose} lot (33% of ${state.originalLot})`);

      const dollarsThisLeg = signedDollarsForLeg(asset, state.entry, tpPrice, direction, lotToClose);
      const cumulativeDollars = (state.partialCloses || []).reduce((sum, pc) => {
        const d = signedDollarsForLeg(asset, state.entry, pc.atPrice, direction, pc.lotClosed) || 0;
        return sum + d;
      }, 0);

      let newSL = null;
      if (!closingFinalTP) {
        newSL = tpPrice;
        const nextTPPrice = tpLevels[i + 1] ? tpLevels[i + 1].price : null;
        const modifyResult = await modifyPosition(position.id, newSL, nextTPPrice, asset);
        if (modifyResult.ok) {
          state.slMoves.push({ atTP: tpName, newSL, ts: Date.now() });
          actions.push({ action: 'sl-move', newSL, ok: true });
          await pushCommentary(asset, 'sl-moved',
            `SL moved to ${tpName} @ ${newSL.toFixed(newSL > 100 ? 2 : 5)} (locks in ${tpName} profit on remaining)`);
        } else {
          actions.push({ action: 'sl-move', error: modifyResult.error, attemptedSL: newSL });
          await pushCommentary(asset, 'sl-move-rejected',
            `SL move to ${tpName} rejected by broker: ${modifyResult.error.slice(0, 80)}`);
        }
      }

      if (!closingFinalTP) {
        try {
          await notifyTPHit({
            asset,
            direction,
            tpName,
            tpPrice,
            lotClosed: lotToClose,
            dollarsSecured: dollarsThisLeg,
            cumulativeDollars,
            slMovedTo: newSL,
            dedupeKey: `tphit:${position.id}:${tpName}`,
          });
        } catch (_) {}
      }
    } else {
      actions.push({ action: 'partial-close', tpName, error: closeResult.error });
    }

    await setPositionState(position.id, state);
    break;
  }

  // ─── TRAILING STOP ──────────────
  const initialSLDistance = Math.abs(state.entry - matchedPending.slPrice);
  const profitDistance = isLong ? currentPrice - state.entry : state.entry - currentPrice;
  const profitR = initialSLDistance > 0 ? profitDistance / initialSLDistance : 0;

  if (profitR >= 2.0 && state.tpsHit.length >= 2) {
    const candles = await fetchCandles(asset, '1h', 30);
    const atrValue = atr(candles.candles || [], 14);
    if (atrValue) {
      const trailDistance = atrValue * 1.0;
      const trailSL = isLong ? currentPrice - trailDistance : currentPrice + trailDistance;
      const currentSL = position.stopLoss;

      const wouldImprove = isLong ? trailSL > currentSL : trailSL < currentSL;
      const lastMove = state.slMoves[state.slMoves.length - 1];
      const lastMoveAge = lastMove ? Date.now() - lastMove.ts : Infinity;

      if (wouldImprove && lastMoveAge > 15 * 60 * 1000) {
        const nextTPPrice = tpLevels.find((tp) => {
          return isLong ? tp.price > currentPrice : tp.price < currentPrice;
        });
        const modifyResult = await modifyPosition(position.id, trailSL, nextTPPrice ? nextTPPrice.price : null, asset);
        if (modifyResult.ok) {
          state.slMoves.push({ trailing: true, newSL: trailSL, atProfitR: profitR, ts: Date.now() });
          actions.push({ action: 'trail-sl', newSL: trailSL });
          await pushCommentary(asset, 'sl-trailing',
            `Trailing SL moved to ${trailSL.toFixed(trailSL > 100 ? 2 : 5)} (${profitR.toFixed(1)}R profit secured)`);
          await setPositionState(position.id, state);
        }
      }
    }
  }

  return { id: position.id, asset, actions, state };
}

// =================================================================
// CLOSE DETECTION + RECOGNITION FEED
// =================================================================

async function detectAndProcessClosed(currentOpenIds) {
  const r = getRedis();
  if (!r) return [];

  const KNOWN_KEY = 'v12:positions:known';
  const knownRaw = await r.get(KNOWN_KEY).catch(() => null);
  const known = safeParse(knownRaw) || [];

  const closed = known.filter((id) => !currentOpenIds.includes(id));

  const stillOpen = known.filter((id) => currentOpenIds.includes(id));
  const allKnown = [...new Set([...stillOpen, ...currentOpenIds])];
  await r.set(KNOWN_KEY, JSON.stringify(allKnown), { ex: 86400 * 7 }).catch(() => {});

  if (closed.length === 0) return [];

  const recentDeals = await fetchClosedTradesRecent();
  const recordings = [];

  for (const positionId of closed) {
    const state = await getPositionState(positionId);
    if (!state) continue;

    const positionDeals = recentDeals.filter((d) => d.positionId === positionId);
    if (positionDeals.length === 0) continue;

    const totalPnL = positionDeals.reduce((sum, d) => sum + (d.profit || 0) + (d.commission || 0) + (d.swap || 0), 0);

    const pendingList = await getPendingSetups(state.asset);
    const matchedPending = pendingList.find((p) => p.id === state.pendingId);
    if (!matchedPending) continue;

    const closedTrade = {
      id: `trade_${state.asset}_${positionId}`,
      asset: state.asset,
      direction: state.direction,
      mode: matchedPending.setup.mode,
      session: matchedPending.setup.session || getCurrentSession(),
      contributingTactics: matchedPending.setup.contributingTactics,
      timeframesInPlay: matchedPending.setup.timeframesInPlay,
      slDistance: matchedPending.setup.slDistance,
      slDistanceATR: matchedPending.setup.slDistanceATR,
      pnl: totalPnL,
      riskDollars: matchedPending.sizing.baseRisk,
      newsState: matchedPending.newsFeature ? matchedPending.newsFeature.newsState : 'none',
      highImpactWithin60min: matchedPending.newsFeature ? matchedPending.newsFeature.highImpactWithin60min : false,
      enabledTools: null,
      openedAt: state.createdAt,
      closedAt: Date.now(),
      synthetic: false,
    };

    const stored = await storeClosedTrade(closedTrade);

    // v1.3: NEW — contribute to today's realized P&L
    // Without this, dashboard's "Today realized" stays at $0 forever.
    try {
      await addDailyPnL(totalPnL);
    } catch (e) {
      console.error('[manage-trades] addDailyPnL failed:', e.message);
    }

    recordings.push({ positionId, asset: state.asset, pnl: totalPnL, stored });

    await updatePendingSetup(state.asset, state.pendingId, {
      status: 'closed',
      finalPnL: totalPnL,
      closedAt: Date.now(),
    });

    const outcome = totalPnL > 0.5 ? '✓ WIN' : totalPnL < -0.5 ? '✗ LOSS' : '— BE';
    await pushCommentary(state.asset, 'trade-closed',
      `${outcome} — ${state.direction} closed: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);

    try {
      const tpsHit = state.tpsHit || [];
      const isCleanSLHit = tpsHit.length === 0 && totalPnL < -0.5;

      if (isCleanSLHit) {
        const lastSL = state.slMoves && state.slMoves.length > 0
          ? state.slMoves[state.slMoves.length - 1].newSL
          : matchedPending.slPrice;
        await notifySLHit({
          asset: state.asset,
          direction: state.direction,
          slPrice: lastSL,
          dollarsLost: totalPnL,
          positionId,
        });
      } else {
        await notifyTradeClosed({
          asset: state.asset,
          direction: state.direction,
          totalPnL,
          tpsHit,
          positionId,
          openedAt: state.createdAt,
          closedAt: Date.now(),
        });
      }
    } catch (_) {}
  }

  return recordings;
}

// =================================================================
// MAIN ENTRY POINT
// =================================================================

async function runManageTick() {
  if (!isTradingEnabled()) {
    return { ts: Date.now(), tradingEnabled: false };
  }

  const positions = await fetchPositions();
  if (positions === null) {
    console.warn('[manage-trades] broker positions fetch failed — skipping tick to preserve state');
    return {
      ts: Date.now(),
      tradingEnabled: true,
      skipped: 'broker-positions-unavailable',
    };
  }

  const managedPositions = positions.filter((p) => p.comment && (p.comment.startsWith('QB-V12-') || p.comment.startsWith('QB-V13-')));

  const manageResults = await Promise.all(managedPositions.map(managePosition));

  const openIds = positions.map((p) => p.id);
  const recordings = await detectAndProcessClosed(openIds);

  const watched = await checkAllWatchedSetups().catch((e) => ({ error: e.message }));

  return {
    ts: Date.now(),
    tradingEnabled: true,
    openCount: managedPositions.length,
    manageResults,
    closedAndRecorded: recordings,
    watched,
  };
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const result = await runManageTick();
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.runManageTick = runManageTick;
module.exports.managePosition = managePosition;