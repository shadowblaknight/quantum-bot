/* eslint-disable */
// V12 — api/manage-trades.js
//
// Manages open positions through their full lifecycle:
//   - Detects when limit order fills → marks pending as 'filled', records actual entry
//   - At TP1 hit: close 25% of position, move SL to entry (BE)
//   - At TP2 hit: close 25%, move SL to TP1 (lock profit)
//   - At TP3 hit: close 25%, move SL to TP2
//   - At TP4 hit: close remaining 25%, position closed
//   - When SL hit: position closes naturally
//   - Trailing: once 2R in profit, also enable trailing stop at 1 ATR
//
// On position CLOSE:
//   - Reads pending setup record (still in Redis) for entry-time feature vector
//   - Computes outcome: WIN / LOSS / BREAKEVEN
//   - Calls recognition-memory.storeClosedTrade with full feature vector
//   - Pushes commentary
//
// CRITICAL SAFETY:
//   - Only acts if QB_TRADING_ENABLED === 'true'
//   - Won't touch positions not opened by V12 (recognized via comment prefix)
//   - All MetaAPI calls have error handling — failures don't crash watcher
// ----------------------------------------------------------------------------

const { getRedis, safeParse, applyCors, atr, getCurrentSession, roundToPipSize } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { resolveSymbol, resolveAsset } = require('./symbol-resolver');
const { fetchPositions, fetchCandles } = require('./broker');
const { getPendingSetups, updatePendingSetup, pushCommentary } = require('./watcher');
const { storeClosedTrade } = require('./recognition-memory');
const { notifyTPHit, notifySLHit, notifyTradeClosed } = require('./telegram');

// ===== Position management state =====
const POSITION_STATE_KEY = (positionId) => `v12:position:${positionId}:state`;
// Stores: { tpsHit: ['TP1', 'TP2'], slMoves: [...], partialCloses: [...], originalLot, ... }

// ===== Trading enabled gate =====
function isTradingEnabled() {
  return process.env.QB_TRADING_ENABLED === 'true';
}

// =================================================================
// $ ESTIMATION FROM PRICE DISTANCE
// =================================================================
// Used for telegram TP-hit notifications where we don't yet have
// a closed deal in MetaAPI history. Uses asset-registry pipSize +
// dollarPerPipPerLot for accurate-enough estimate.
//
// For final close summary (notifyTradeClosed), we use the EXACT P&L
// from MetaAPI history-deals — this estimate is only used for
// in-flight partial-close notifications.

function estimateDollarsFromDistance(assetId, distance, lot) {
  const meta = getAssetById(assetId);
  if (!meta || !meta.pipSize || !meta.dollarPerPipPerLot) return null;
  const pips = Math.abs(distance) / meta.pipSize;
  return pips * meta.dollarPerPipPerLot * lot;
}

// Sign-aware variant: returns POSITIVE when tpPrice is in the profit direction
// from entry, NEGATIVE when it's against. Critical for notification accuracy —
// without this, a position closed at a loss would report a fake positive
// "secured" amount because |distance| × multiplier is always positive.
function signedDollarsForLeg(assetId, entryPrice, exitPrice, direction, lot) {
  const meta = getAssetById(assetId);
  if (!meta || !meta.pipSize || !meta.dollarPerPipPerLot) return null;
  const isLong = direction === 'LONG';
  // For LONG: profit when exit > entry; for SHORT: profit when exit < entry.
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

  // V12.4.1: round to broker pip increment to avoid INVALID_PRICE rejections.
  // If assetId is passed, we know the pipSize. Without it, prices pass through.
  let sl = slPrice, tp = tpPrice;
  if (assetId) {
    const meta = getAssetById(assetId);
    if (meta?.pipSize) {
      // We don't know direction here, so use 'nearest' for both. The caller
      // already chose the levels with direction in mind; this just snaps to
      // a valid quote precision.
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

  // V12 positions are recognized by comment prefix
  if (!position.comment || !position.comment.startsWith('QB-V12-')) {
    return { id: position.id, skipped: 'not-v12-position' };
  }

  // Resolve asset
  const asset = position.assetId || await resolveAsset(position.symbol);
  if (!asset) return { id: position.id, error: 'cannot resolve asset' };

  const isLong = position.type === 'POSITION_TYPE_BUY' || position.direction === 'LONG';
  const direction = isLong ? 'LONG' : 'SHORT';

  // Find pending setup that matches this position.
  //
  // CRITICAL: matching must be precise. A previous bug used a 1% tolerance
  // (46 pts for gold!) which would match COMPLETELY DIFFERENT setups whose
  // TP levels pointed the wrong direction — causing the bot to report SL
  // hits as "TP hits" with sign-inverted dollar amounts.
  //
  // Strategy:
  //   1. Prefer matching by positionId (set when first managed) — exact match
  //   2. Fallback to strict price + direction + TP-direction-sanity check
  const pendingList = await getPendingSetups(asset);

  // Pass 1: exact positionId match (managed before)
  let matchedPending = pendingList.find((p) =>
    p.positionId && p.positionId === position.id &&
    (p.status === 'placed' || p.status === 'filled')
  );

  // Pass 2: strict first-fill match
  if (!matchedPending) {
    // Tighter tolerance: for gold, 2 points; for fx-like, 0.05% of price
    const isGold = position.openPrice > 100;
    const priceTolerance = isGold ? 2.0 : position.openPrice * 0.0005;

    matchedPending = pendingList.find((p) => {
      if (p.status !== 'placed' && p.status !== 'filled') return false;
      if (p.setup.direction !== direction) return false;
      if (Math.abs(p.plannedEntry - position.openPrice) > priceTolerance) return false;

      // Sanity check: TPs must point the correct direction relative to entry.
      // For SHORT: all TP prices should be BELOW entry.
      // For LONG: all TP prices should be ABOVE entry.
      // If they don't, this pending is from a different context — reject the match.
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

  // Mark as filled if just discovered (first time manage sees this position)
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

  // Get position state (TP hits, SL moves so far)
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

  // Get TP levels and current price
  const tpLevels = matchedPending.tpLevels || [];
  if (tpLevels.length === 0) {
    return { id: position.id, error: 'no TP levels in pending setup' };
  }

  // Read fresh price (use position.currentPrice from broker if available)
  const currentPrice = position.currentPrice || position.openPrice;
  const actions = [];

  // TP HIT DETECTION
  // For LONG: TP hit when current price >= TP level
  // For SHORT: TP hit when current price <= TP level
  for (let i = 0; i < tpLevels.length && i < 4; i++) {
    const tpName = `TP${i + 1}`;
    if (state.tpsHit.includes(tpName)) continue;

    const tpPrice = tpLevels[i].price;

    // SAFETY: TP must be on the profit side of entry. If it isn't, the
    // matched pending setup is bogus (probably a stale one with TPs from a
    // different context). Skip detection to avoid reporting SL hits as wins.
    const tpOnProfitSide = isLong ? tpPrice > state.entry : tpPrice < state.entry;
    if (!tpOnProfitSide) {
      actions.push({ action: 'tp-skipped', tpName, reason: 'tp-on-loss-side', tpPrice, entry: state.entry });
      continue;
    }

    const hit = isLong ? currentPrice >= tpPrice : currentPrice <= tpPrice;

    if (hit) {
      // Partial close: 25% of original lot
      const closeAmount = Math.max(0.01, Math.round(state.originalLot * 0.25 * 100) / 100);
      const remaining = position.volume - closeAmount;

      // Special case: if this is TP4 (final), close everything remaining
      const closingFinalTP = (i === 3) || (i === tpLevels.length - 1);
      const lotToClose = closingFinalTP ? position.volume : closeAmount;

      const closeResult = await partialClose(position.id, lotToClose);
      if (closeResult.ok) {
        state.tpsHit.push(tpName);
        state.partialCloses.push({ tpName, lotClosed: lotToClose, atPrice: tpPrice, ts: Date.now() });
        actions.push({ action: 'partial-close', tpName, lotClosed: lotToClose, ok: true });

        await pushCommentary(asset, 'tp-hit',
          `${tpName} hit @ ${tpPrice.toFixed(tpPrice > 100 ? 2 : 5)} — closed ${lotToClose} lot`);

        // Estimate $ for this leg + cumulative using SIGN-AWARE calculation.
        // If tpPrice happens to be on the wrong side of entry (e.g. due to a
        // stale-pending matching bug), the result will be NEGATIVE and the
        // notification will show the truth, not a fake gain.
        const dollarsThisLeg = signedDollarsForLeg(asset, state.entry, tpPrice, direction, lotToClose);
        const cumulativeDollars = (state.partialCloses || []).reduce((sum, pc) => {
          const d = signedDollarsForLeg(asset, state.entry, pc.atPrice, direction, pc.lotClosed) || 0;
          return sum + d;
        }, 0);

        // Move SL based on TP that hit:
        //   TP1 hit → SL to entry (BE)
        //   TP2 hit → SL to TP1
        //   TP3 hit → SL to TP2
        //   TP4 hit → all closed, no SL move needed
        let newSL = null;
        if (!closingFinalTP) {
          if (i === 0) newSL = state.entry;                  // BE
          else if (i === 1) newSL = tpLevels[0].price;       // SL to TP1
          else if (i === 2) newSL = tpLevels[1].price;       // SL to TP2

          if (newSL != null) {
            // Keep the next TP as the broker's TP target
            const nextTPPrice = tpLevels[i + 1] ? tpLevels[i + 1].price : tpPrice;
            const modifyResult = await modifyPosition(position.id, newSL, nextTPPrice, asset);
            if (modifyResult.ok) {
              state.slMoves.push({ atTP: tpName, newSL, ts: Date.now() });
              actions.push({ action: 'sl-move', newSL, ok: true });
              await pushCommentary(asset, 'sl-moved',
                `SL moved to ${i === 0 ? 'breakeven' : `TP${i}`} @ ${newSL.toFixed(newSL > 100 ? 2 : 5)}`);
            } else {
              actions.push({ action: 'sl-move', error: modifyResult.error });
            }
          }
        }

        // Telegram: TP hit (only for TP1-TP3 — TP4 emits as part of "trade closed")
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
      // Only one TP per tick (avoid race conditions)
      break;
    }
  }

  // TRAILING STOP (when 2R+ in profit)
  // SL initial distance = entry to original SL
  const initialSLDistance = Math.abs(state.entry - matchedPending.slPrice);
  const profitDistance = isLong ? currentPrice - state.entry : state.entry - currentPrice;
  const profitR = initialSLDistance > 0 ? profitDistance / initialSLDistance : 0;

  if (profitR >= 2.0 && state.tpsHit.length >= 2) {
    // Compute trailing SL: 1 ATR behind current price
    const candles = await fetchCandles(asset, '1h', 30);
    const atrValue = atr(candles.candles || [], 14);
    if (atrValue) {
      const trailDistance = atrValue * 1.0;
      const trailSL = isLong ? currentPrice - trailDistance : currentPrice + trailDistance;
      const currentSL = position.stopLoss;

      // Only move SL more favorable, never against
      const wouldImprove = isLong ? trailSL > currentSL : trailSL < currentSL;
      const lastMove = state.slMoves[state.slMoves.length - 1];
      const lastMoveAge = lastMove ? Date.now() - lastMove.ts : Infinity;

      // Throttle: don't trail more than once per 15 min
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
// On each tick, check positions that USED to be open but are now gone.
// For each, fetch the closing deal from MetaAPI's history, build a feature
// vector, and store in recognition memory.

async function detectAndProcessClosed(currentOpenIds) {
  const r = getRedis();
  if (!r) return [];

  // Track which V12 positions we've seen recently
  const KNOWN_KEY = 'v12:positions:known';
  const knownRaw = await r.get(KNOWN_KEY).catch(() => null);
  const known = safeParse(knownRaw) || [];

  // Find positions we knew about that are NO LONGER open
  const closed = known.filter((id) => !currentOpenIds.includes(id));

  // Update known list
  const stillOpen = known.filter((id) => currentOpenIds.includes(id));
  const allKnown = [...new Set([...stillOpen, ...currentOpenIds])];
  await r.set(KNOWN_KEY, JSON.stringify(allKnown), { ex: 86400 * 7 }).catch(() => {});

  if (closed.length === 0) return [];

  // For each closed position, get its state (which has the linked pending setup)
  const recentDeals = await fetchClosedTradesRecent();
  const recordings = [];

  for (const positionId of closed) {
    const state = await getPositionState(positionId);
    if (!state) continue;

    // Find deals for this position
    const positionDeals = recentDeals.filter((d) => d.positionId === positionId);
    if (positionDeals.length === 0) continue;

    // Compute total realized P&L
    const totalPnL = positionDeals.reduce((sum, d) => sum + (d.profit || 0) + (d.commission || 0) + (d.swap || 0), 0);

    // Find the matching pending setup (it has the feature vector)
    const pendingList = await getPendingSetups(state.asset);
    const matchedPending = pendingList.find((p) => p.id === state.pendingId);
    if (!matchedPending) continue;

    // Build the closed trade record for recognition memory
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
      newsState: matchedPending.newsFeature?.newsState || 'none',
      highImpactWithin60min: matchedPending.newsFeature?.highImpactWithin60min || false,
      enabledTools: null, // V12.1 — when we have per-user tool config
      openedAt: state.createdAt,
      closedAt: Date.now(),
      synthetic: false,
    };

    const stored = await storeClosedTrade(closedTrade);
    recordings.push({ positionId, asset: state.asset, pnl: totalPnL, stored });

    // Update pending status
    await updatePendingSetup(state.asset, state.pendingId, {
      status: 'closed',
      finalPnL: totalPnL,
      closedAt: Date.now(),
    });

    // Commentary
    const outcome = totalPnL > 0.5 ? '✓ WIN' : totalPnL < -0.5 ? '✗ LOSS' : '— BE';
    await pushCommentary(state.asset, 'trade-closed',
      `${outcome} — ${state.direction} closed: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);

    // Telegram: trade closed
    // Determine if this was a clean SL hit (no TPs hit) vs partial-then-SL vs full TP sweep.
    // tpsHit array tells us tier. SL hit when 0 TPs hit AND outcome is loss.
    try {
      const tpsHit = state.tpsHit || [];
      const isCleanSLHit = tpsHit.length === 0 && totalPnL < -0.5;

      if (isCleanSLHit) {
        // Just an SL hit — no partials secured
        // Find the SL price: it's the matchedPending.slPrice (original SL)
        // unless trail moved it; check state.slMoves for last move
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
        // Trade closed with at least one TP, or BE, or trail
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

  // CRITICAL: If broker fetch fails, we MUST NOT proceed. Otherwise
  // detectAndProcessClosed will see "no open positions" and mark every
  // previously-tracked position as just-closed, corrupting the track
  // record and firing fake Telegram notifications.
  const positions = await fetchPositions();
  if (positions === null) {
    console.warn('[manage-trades] broker positions fetch failed — skipping tick to preserve state');
    return {
      ts: Date.now(),
      tradingEnabled: true,
      skipped: 'broker-positions-unavailable',
    };
  }
  const v12Positions = positions.filter((p) => p.comment && p.comment.startsWith('QB-V12-'));

  // 1. Manage each open V12 position
  const manageResults = await Promise.all(v12Positions.map(managePosition));

  // 2. Detect any positions that closed since last tick → feed recognition memory
  const openIds = positions.map((p) => p.id);
  const recordings = await detectAndProcessClosed(openIds);

  return {
    ts: Date.now(),
    tradingEnabled: true,
    openCount: v12Positions.length,
    manageResults,
    closedAndRecorded: recordings,
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