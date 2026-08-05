/* eslint-disable */
// V14 — api/manage-trades.js  (v1.4 — tags closed trades with day/swing style)
//
// v1.4 CHANGE (v14 backend coherence):
//   The closed-trade record now carries `style` (day|swing) and an explicit
//   `template`, pulled from the matched pending setup (which the webhook stamps
//   from rules-store's decision). This is what feeds the dashboard's
//   Day-vs-Swing comparison chart. No behavior change to position management.
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
const { writeLedgerRecord } = require('./ledger');  // v14: P&L cost ledger
const { notifyTPHit, notifySLHit, notifyTradeClosed, sendOnce } = require('./telegram');
const { checkAllWatchedSetups } = require('./watched-setups-checker');
const { runEntryStyleEvaluator } = require('./entrystyle-evaluator');

// v14: all-or-nothing exits. The full position rides to the FINAL TP (parked as
// the broker TP at placement). At TP1/TP2 touches we ONLY ratchet the SL up to
// that TP — no partial closes. Set to true to restore the legacy 33/33/34 scale-out.
const USE_PARTIALS = false;
const USE_SL_RATCHET = true;     // ratchet SL to each confirmed TP level
const USE_TRAILING_STOP = true;  // trail at 1×ATR once 2R+ profit and 2 TPs hit

// ===== Position management state =====
const POSITION_STATE_KEY = (positionId) => `v12:position:${positionId}:state`;

// ===== Manage-trades error log =====
const MT_ERRORS_KEY = 'v14:managetrades:errors';
const MT_ERRORS_CAP = 50;

// ===== Trading enabled gate =====
function isTradingEnabled() {
  return process.env.QB_TRADING_ENABLED === 'true';
}

async function logMTError(obj) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.lpush(MT_ERRORS_KEY, JSON.stringify({ ts: Date.now(), ...obj }));
    await r.ltrim(MT_ERRORS_KEY, 0, MT_ERRORS_CAP - 1);
  } catch (_) {}
}

// Re-reads a single open position's stopLoss from MetaAPI after a modify,
// to verify the broker actually applied the change. Returns the SL as a
// number, or null if the position is gone (closed) or the fetch failed.
// Hard-capped at 5 s so a slow broker never stalls the manage tick.
async function fetchPositionSL(positionId) {
  const token     = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region    = process.env.METAAPI_REGION || 'london';
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/positions`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      headers: { 'auth-token': token, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const list = await resp.json();
    const pos  = Array.isArray(list) ? list.find(p => p.id === positionId) : null;
    return pos ? (typeof pos.stopLoss === 'number' ? pos.stopLoss : null) : null;
  } catch (_) {
    return null;
  }
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

// v14.1: REAL today realized P&L straight from the broker's closed deals — so
// the dashboard can never diverge from MT5 again. Sums profit+commission+swap of
// today's deals, excluding balance/credit entries (deposits).
async function getTodayRealized() {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region = process.env.METAAPI_REGION || 'london';
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const since = start.toISOString();
  const until = now.toISOString();
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time/${since}/${until}`;
  try {
    const resp = await fetch(url, { headers: { 'auth-token': token, 'Accept': 'application/json' } });
    if (!resp.ok) return { ok: false, error: `deals ${resp.status}` };
    const deals = await resp.json();
    const list = Array.isArray(deals) ? deals : [];
    let realized = 0, trades = 0, wins = 0, losses = 0;
    for (const d of list) {
      if (d.type === 'DEAL_TYPE_BALANCE' || d.type === 'DEAL_TYPE_CREDIT') continue; // skip deposits
      realized += (d.profit || 0) + (d.commission || 0) + (d.swap || 0);
      if (d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT') {
        trades += 1;
        if ((d.profit || 0) > 0) wins += 1; else if ((d.profit || 0) < 0) losses += 1;
      }
    }
    return { ok: true, pnl: Math.round(realized * 100) / 100, trades, wins, losses, since, source: 'broker-deals' };
  } catch (e) {
    return { ok: false, error: e.message };
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
    // Candidate setups for THIS asset: placed/filled, same direction, TPs on the
    // correct side of the ACTUAL fill, and not already linked to a different
    // position. Entry-price proximity is NOT required — market-order slippage
    // routinely moves the fill a few points off the plan (e.g. gold planned 4183,
    // filled 4180.70 = 2.30 off, which used to exceed the 2.0 tolerance and orphan
    // the trade so it was never managed). Only one position per asset is allowed,
    // so an asset+direction match is unambiguous.
    const entry = position.openPrice;
    const candidates = pendingList.filter((p) => {
      if (p.status !== 'placed' && p.status !== 'filled') return false;
      if (p.positionId && p.positionId !== position.id) return false; // belongs to another position
      if (!p.setup || p.setup.direction !== direction) return false;
      const tps = p.tpLevels || [];
      if (tps.length === 0) return false;
      // Use some() not every() — large slippage (common on BTC/crypto) can push the
      // actual fill past a tight TP1, making it appear on the wrong side and falsely
      // rejecting the candidate. Requiring at least one reachable TP is sufficient;
      // the direction check above already rules out opposite-direction confusion.
      return tps.some((tp) => (isLong ? tp.price > entry : tp.price < entry));
    });

    if (candidates.length === 1) {
      matchedPending = candidates[0];
    } else if (candidates.length > 1) {
      // tie-break by the setup whose planned entry is closest to the actual fill
      matchedPending = candidates.reduce((best, p) =>
        Math.abs(p.plannedEntry - entry) < Math.abs(best.plannedEntry - entry) ? p : best
      );
    }
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
      dedupeKey: matchedPending.dedupeKey || null,
      tpsHit: [],
      slMoves: [],
      partialCloses: [],
      createdAt: Date.now(),
    };
    await setPositionState(position.id, state);
  }

  const tpLevels = matchedPending.tpLevels || [];
  // v14: the broker TP sits here; SL ratchets toward earlier TPs but the broker
  // TP must stay parked at the final target on every modify (null would clear it).
  const finalTPPrice = tpLevels.length ? tpLevels[tpLevels.length - 1].price : null;
  if (tpLevels.length === 0) {
    return { id: position.id, error: 'no TP levels in pending setup' };
  }

  // v14.1: derive a RELIABLE current price + the favorable EXTREME since open.
  // TP-touch detection uses the favorable extreme reached SINCE the position
  // opened. CRITICAL: we build that extreme FORWARD from the entry using only
  // current price data — never a historical candle window. Reading history (even
  // a time-sliced one) let pre-fill price action — e.g. where price sat while a
  // limit waited to fill — masquerade as TPs already hit, force-closing brand-new
  // trades on their first tick. Seeding at the entry and only ever ratcheting
  // forward makes this immune to fill timing, late limit fills, and anchor drift.
  const assetMeta = getAssetById(asset);
  let livePrice = (isFinite(position.currentPrice) && position.currentPrice > 0) ? position.currentPrice : null;
  let lastWick = null;
  try {
    const cr = await fetchCandles(asset, '1m', 2); // only the current poll window
    const cs = (cr && cr.candles) || [];
    const last = cs[cs.length - 1];
    if (last) {
      if (livePrice == null && isFinite(last.close)) livePrice = last.close;
      lastWick = isLong ? last.high : last.low; // the in-progress candle's wick only
    }
  } catch (_) {}
  if (livePrice == null) livePrice = position.openPrice;

  // priorExtreme seeds at the entry on the first tick and only moves forward in
  // the favorable direction thereafter — it can never reach back to pre-fill lows.
  const priorExtreme = (typeof state.extreme === 'number' && isFinite(state.extreme)) ? state.extreme : state.entry;
  const extreme = isLong
    ? Math.max(priorExtreme, livePrice, lastWick != null ? lastWick : -Infinity)
    : Math.min(priorExtreme, livePrice, lastWick != null ? lastWick :  Infinity);
  state.extreme = extreme;

  const currentPrice = livePrice;   // used by the trailing block below
  const actions = [];

  const initialSLForR = Math.abs(state.entry - matchedPending.slPrice) || 1;
  const finalIdx = tpLevels.length - 1;

  // Hoisted here so the TP-detection Telegram can reference stopBuffer.
  const pipSz      = (assetMeta && assetMeta.pipSize) || (currentPrice > 100 ? 0.01 : 0.0001);
  // Proportional buffer: 25% of SL, floored at 2 pips, capped at 8 pips.
  // Replaces the old flat 8-pip floor that blocked ratcheting on tight-stop trades
  // (orb-pro 10-pip SL: old buffer = 8 pip, new = 2.4 pip; 20-pip SL: 4.9 pip; 32-pip+ = 8 pip).
  const stopBuffer = Math.min(Math.max(initialSLForR * 0.25, pipSz * 2), pipSz * 8);

  // ─── TP TOUCH DETECTION (wick-aware, CONFIRMED) ──────────────────
  // A TP counts as hit only when price trades a confirmation buffer BEYOND it —
  // not a bare wick that instantly reverses. (A 1-tick stab that bounces used to
  // record a "hit" and yank the stop to breakeven, strangling a winner.) The
  // TP-hit Telegram fires immediately at detection (see sendOnce below each push).
  // The SL-lock Telegram (tplock:...) fires separately, only after broker verification.
  const confirmBuffer = initialSLForR * (matchedPending.tpConfirmR || 0.10); // 0.1R beyond the TP
  let finalTouched = false;
  for (let i = 0; i < tpLevels.length && i < 3; i++) {
    const tpName = `TP${i + 1}`;
    const tpPrice = tpLevels[i].price;
    const tpOnProfitSide = isLong ? tpPrice > state.entry : tpPrice < state.entry;
    if (!tpOnProfitSide) continue;

    const confirmed = isLong ? extreme >= tpPrice + confirmBuffer : extreme <= tpPrice - confirmBuffer;
    if (!confirmed) continue;

    if (i === finalIdx) { finalTouched = true; continue; }

    if (!state.tpsHit.includes(tpName)) {
      state.tpsHit.push(tpName);
      actions.push({ action: 'tp-hit', tpName, tpPrice });
      // Use the pre-stored rMultiple (computed from planned entry at signal time).
      // This matches the order-placed notification and stays correct even when
      // the actual fill has slippage vs the planned entry.
      const rMult = tpLevels[i].rMultiple ?? (Math.abs(tpPrice - state.entry) / initialSLForR);
      await pushCommentary(asset, 'tp-hit',
        `${tpName} confirmed @ ${tpPrice.toFixed(tpPrice > 100 ? 2 : 5)} (${rMult.toFixed(1)}R)`);
      // TP-hit Telegram: fires at detection, BEFORE and SEPARATE FROM the lock attempt.
      // Ensures the user is always notified even when the ratchet can't lock immediately
      // (e.g. price bounced back within the stop-buffer window).
      try {
        const tpEmoji = tpName === 'TP1' ? '🥉' : tpName === 'TP2' ? '🥈' : '🥇';
        await sendOnce(`tp-confirmed:${position.id}:${tpName}`,
          `${tpEmoji} <b>${tpName} CONFIRMED — ${asset.toUpperCase()}</b>\n\n` +
          `${isLong ? '🟢' : '🔴'} ${direction} · <code>${tpPrice.toFixed(tpPrice > 100 ? 2 : 5)}</code> (${rMult.toFixed(1)}R)\n` +
          `SL lock will fire once price clears TP by >${(stopBuffer / pipSz).toFixed(1)} pips`);
      } catch (_) {}
    }
  }

  // ─── FINAL TP backstop close ─────────────────────────────────────
  const finalName = `TP${finalIdx + 1}`;
  if (finalTouched && !state.tpsHit.includes(finalName)) {
    const tpPrice = tpLevels[finalIdx].price;
    const closeResult = await partialClose(position.id, position.volume);
    if (closeResult.ok) {
      state.tpsHit.push(finalName);
      state.partialCloses.push({ tpName: finalName, lotClosed: position.volume, atPrice: tpPrice, ts: Date.now() });
      actions.push({ action: 'final-tp-close', tpName: finalName, ok: true });
      await pushCommentary(asset, 'tp-hit',
        `${finalName} (final) hit @ ${tpPrice.toFixed(tpPrice > 100 ? 2 : 5)} — closed full ${position.volume} lot`);
    } else {
      actions.push({ action: 'final-tp-close', tpName: finalName, error: closeResult.error });
    }
    await setPositionState(position.id, state);
  }

  // ─── SL RATCHET — lock the deepest TP price has actually reached ──
  // "TP hit -> SL at that TP." NO entry-breakeven, ever: the stop only moves to a
  // TP level price has genuinely traded through, and only when that level is a
  // broker-valid stop (beyond market by the min-stop buffer). If price has retraced
  // above every hit TP, the stop simply WAITS where it is — it never hands the win
  // back to entry. A reversal into a locked TP is a real win at that TP.
  // (pipSz and stopBuffer hoisted above TP detection — see declarations above the loop.)
  // Use the better of broker-reported SL and the last SL we successfully verified.
  // MetaAPI often serves a stale position.stopLoss on the tick immediately after a
  // modify — using stateVerifiedSL as a floor prevents the ratchet from thinking
  // the lock hasn't happened yet and firing a spurious SKIPPED on the next tick.
  const brokerSL        = (typeof position.stopLoss === 'number' && position.stopLoss > 0) ? position.stopLoss : null;
  const stateVerifiedSL = (typeof state.lastVerifiedSL === 'number' && isFinite(state.lastVerifiedSL)) ? state.lastVerifiedSL : null;
  const curSL = (() => {
    if (brokerSL == null && stateVerifiedSL == null) return null;
    if (brokerSL == null)      return stateVerifiedSL;
    if (stateVerifiedSL == null) return brokerSL;
    return isLong ? Math.max(brokerSL, stateVerifiedSL) : Math.min(brokerSL, stateVerifiedSL);
  })();

  // hit TP rungs (exclude the final/close rung), deepest-profit first
  const hitRungs = [];
  for (const n of state.tpsHit) {
    if (n === finalName) continue;
    const idx = parseInt(n.slice(2), 10) - 1;
    if (tpLevels[idx]) hitRungs.push({ name: n, price: tpLevels[idx].price });
  }
  hitRungs.sort((a, b) => (isLong ? b.price - a.price : a.price - b.price));

  // deepest hit rung that is a valid stop right now AND improves the current SL
  let chosen = null;
  for (const c of hitRungs) {
    const valid    = isLong ? c.price <= currentPrice - stopBuffer : c.price >= currentPrice + stopBuffer;
    const improves = curSL == null ? true : (isLong ? c.price > curSL : c.price < curSL);
    if (valid && improves) { chosen = c; break; }
  }

  if (USE_SL_RATCHET && chosen) {
    // Pre-submit: broker minimum stop distance.
    // assetMeta.brokerMinStopDist is the minimum PRICE distance from market
    // the broker requires for stops (e.g. 50 pts for BTC). The app's internal
    // stopBuffer (~14 pts for BTC) is far below the broker minimum -- submitting
    // inside it returns MetaAPI HTTP 200 but the broker silently rejects it.
    // Detect this before submitting and clamp to the nearest valid level if viable.
    const minStopDist = (assetMeta && assetMeta.brokerMinStopDist) || 0;
    let slCandidate  = chosen.price;
    let slClamped    = false;
    let skipRatchet  = false;

    if (minStopDist > 0) {
      const distFromMarket = isLong ? currentPrice - slCandidate : slCandidate - currentPrice;
      if (distFromMarket < minStopDist) {
        const raw     = isLong
          ? currentPrice - minStopDist - pipSz
          : currentPrice + minStopDist + pipSz;
        const clamped = roundToPipSize(raw, pipSz, 'nearest');
        const clampedImproves    = curSL == null
          ? (isLong ? clamped > state.entry : clamped < state.entry)
          : (isLong ? clamped > curSL : clamped < curSL);
        const clampedOnProfitSide = isLong ? clamped > state.entry : clamped < state.entry;
        if (clampedImproves && clampedOnProfitSide) {
          slCandidate = clamped;
          slClamped   = true;
          actions.push({ action: 'sl-clamp', tpName: chosen.name, proposed: chosen.price, clamped, minStopDist });
          await pushCommentary(asset, 'sl-clamped',
            `SL clamped from ${chosen.price.toFixed(2)} to ${clamped.toFixed(2)} (broker min-stop ${minStopDist} pts)`);
        } else {
          skipRatchet = true;
          actions.push({ action: 'sl-skip', reason: 'inside-broker-min-stop-unclamped', tpName: chosen.name, proposed: chosen.price, distFromMarket, minStopDist });
          await pushCommentary(asset, 'sl-skip',
            `SL-lock SKIPPED: ${chosen.price.toFixed(2)} is ${distFromMarket.toFixed(2)} pts from market (min ${minStopDist}) -- clamp not viable`);
          await logMTError({ type: 'sl-skip-unclamped', asset, positionId: position.id, tpName: chosen.name, proposed: chosen.price, distFromMarket, minStopDist });
          try {
            await sendOnce(`sllock-skip:${position.id}:${chosen.name}`,
              `⚠️ <b>${chosen.name} hit but SL-lock SKIPPED — ${asset.toUpperCase()}</b>\n\n` +
              `Proposed SL <code>${chosen.price.toFixed(chosen.price > 100 ? 2 : 5)}</code> is ${distFromMarket.toFixed(2)} pts from market\n` +
              `Broker minimum: ${minStopDist} pts — clamp would not improve on current SL\n` +
              `<b>Position unprotected at this TP level. Intervene manually.</b>`);
          } catch (_) {}
        }
      }
    }

    if (!skipRatchet) {
      const modifyResult = await modifyPosition(position.id, slCandidate, finalTPPrice, asset);
      if (modifyResult.ok) {
        // Post-submit verification.
        // MetaAPI HTTP 200 = order QUEUED, not broker-confirmed. MT5 can still
        // reject after accepting (INVALID_STOPS, etc.). Wait 1 s for the
        // broker round-trip then re-read the actual SL to confirm it landed.
        await new Promise(resolve => setTimeout(resolve, 1000));
        const slAfter    = await fetchPositionSL(position.id);
        // null = position closed during the wait, or verify fetch failed.
        // Treated as "unverified" -- no Telegram until confirmed on next tick.
        const slTol      = Math.max(pipSz * 3, 1.0);
        const slVerified = slAfter !== null && Math.abs(slAfter - slCandidate) <= slTol;

        if (slVerified) {
          state.slMoves.push({ atTP: chosen.name, newSL: slCandidate, clamped: slClamped, ts: Date.now() });
          actions.push({ action: 'sl-move', newSL: slCandidate, at: chosen.name, ok: true, verified: true, clamped: slClamped });
          await pushCommentary(asset, 'sl-moved',
            `SL locked at ${chosen.name} @ ${slCandidate.toFixed(slCandidate > 100 ? 2 : 5)}${slClamped ? ' (clamped)' : ''}`);
          state.lastVerifiedSL = slCandidate;
          if (state.lockedTP !== chosen.name) {
            state.lockedTP = chosen.name;
            // R from planned entry/SL so it matches the order-placed notification.
            const plannedSLDist = Math.abs(matchedPending.plannedEntry - matchedPending.slPrice);
            const rMult = plannedSLDist > 0
              ? Math.abs(slCandidate - matchedPending.plannedEntry) / plannedSLDist
              : (Math.abs(slCandidate - state.entry) / initialSLForR);
            const lockedDollars = signedDollarsForLeg(asset, state.entry, slCandidate, direction, position.volume);
            const ridingTo      = tpLevels[finalIdx] ? tpLevels[finalIdx].price : null;
            // When the SL was clamped, label it clearly — the stop is NOT at TP price.
            const pFmt = (v) => v.toFixed(v > 100 ? 2 : 5);
            const stopDesc = slClamped
              ? `<code>${pFmt(slCandidate)}</code> ⚠️ clamped (${chosen.name} ${pFmt(chosen.price)} too close to market)`
              : `${chosen.name} <code>${pFmt(slCandidate)}</code>`;
            try {
              await sendOnce(`tplock:${position.id}:${chosen.name}`,
                `\u{1F3AF} <b>${chosen.name} LOCKED — ${asset.toUpperCase()}</b>\n\n` +
                `${isLong ? '\u{1F7E2}' : '\u{1F534}'} ${direction} · stop now at ${stopDesc} (${rMult.toFixed(1)}R)\n` +
                (lockedDollars != null ? `Locked in: <b>${lockedDollars >= 0 ? '+' : ''}$${lockedDollars.toFixed(2)}</b> guaranteed if stopped\n` : '') +
                (ridingTo != null ? `Riding to TP${finalIdx + 1}: <code>${ridingTo.toFixed(ridingTo > 100 ? 2 : 5)}</code>` : ''));
            } catch (_) {}
          }
        } else if (slAfter === null) {
          // Position closed while waiting, or verify fetch timed out.
          // No state write, no Telegram -- next tick will resolve.
          actions.push({ action: 'sl-unverified', submittedSL: slCandidate, tpName: chosen.name });
          await pushCommentary(asset, 'sl-unverified',
            `SL-lock unverified after submit (position closed or broker unreachable) -- check MT5`);
        } else {
          // Got a response but SL value did not change at the broker.
          const errDetail = `submitted ${slCandidate.toFixed(2)}, broker shows ${slAfter.toFixed(2)}`;
          actions.push({ action: 'sl-rejected', error: `broker-verify-failed: ${errDetail}`, submittedSL: slCandidate, brokerSL: slAfter });
          await pushCommentary(asset, 'sl-rejected', `SL-lock rejected by broker: ${errDetail}`);
          await logMTError({ type: 'sl-verify-failed', asset, positionId: position.id, tpName: chosen.name, submittedSL: slCandidate, brokerSL: slAfter });
          try {
            await sendOnce(`sllock-rejected:${position.id}:${chosen.name}`,
              `⚠️ <b>${chosen.name} hit but SL-lock REJECTED — ${asset.toUpperCase()}</b>\n\n` +
              `Submitted: <code>${slCandidate.toFixed(slCandidate > 100 ? 2 : 5)}</code>\n` +
              `Broker shows: <code>${slAfter.toFixed(slAfter > 100 ? 2 : 5)}</code>\n` +
              `<b>Position is UNPROTECTED. Manual intervention required.</b>`);
          } catch (_) {}
        }
      } else {
        actions.push({ action: 'sl-move', error: modifyResult.error, attemptedSL: slCandidate });
        await pushCommentary(asset, 'sl-move-rejected',
          `SL lock to ${chosen.name} rejected (retries next tick): ${modifyResult.error.slice(0, 70)}`);
      }
    }
  }


  await setPositionState(position.id, state);

  // ─── TRAILING STOP ──────────────
  const initialSLDistance = Math.abs(state.entry - matchedPending.slPrice);
  const profitDistance = isLong ? currentPrice - state.entry : state.entry - currentPrice;
  const profitR = initialSLDistance > 0 ? profitDistance / initialSLDistance : 0;

  if (USE_TRAILING_STOP && profitR >= 2.0 && state.tpsHit.length >= 2) {
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
        const modifyResult = await modifyPosition(position.id, trailSL, finalTPPrice, asset);
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

    if (!state) {
      // No position state — pending setup was never matched (invalidated by watcher,
      // MetaAPI timing, signal gate blocked placement, etc.). Reconstruct from broker
      // deals so the trade is never silently lost regardless of how state creation failed.
      const noStateDeals = recentDeals.filter(d => d.positionId === positionId);
      if (noStateDeals.length === 0) continue;
      const nsEntry = noStateDeals.find(d => d.entryType === 'DEAL_ENTRY_IN');
      const nsExit  = noStateDeals.find(d => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT');
      if (!nsExit) continue;
      const nsSymbol = ((nsEntry || noStateDeals[0]).symbol || '').trim();
      const nsAsset  = nsSymbol ? await resolveAsset(nsSymbol).catch(() => null) : null;
      if (!nsAsset) continue;
      const nsTradeId    = `trade_${nsAsset}_${positionId}`;
      const nsAlreadyDone = await r.get(`v14:ledger:trade:${nsTradeId}`).catch(() => null);
      if (nsAlreadyDone) continue;
      const nsPnL       = noStateDeals.reduce((s, d) => s + (d.profit || 0) + (d.commission || 0) + (d.swap || 0), 0);
      const nsDirection = (!nsEntry || nsEntry.type === 'DEAL_TYPE_BUY') ? 'LONG' : 'SHORT';
      const nsOpenedAt  = nsEntry?.time ? new Date(nsEntry.time).getTime() : null;
      const nsClosedAt  = nsExit.time   ? new Date(nsExit.time).getTime()  : Date.now();
      const noStateTrade = {
        id: nsTradeId, asset: nsAsset, direction: nsDirection,
        template: null, style: null, mode: null, session: null,
        tpsHit: [], maxTP: 0,
        pnl: nsPnL, riskDollars: null,
        openedAt: nsOpenedAt || nsClosedAt, closedAt: nsClosedAt,
        dedupeKey: null,
        reconstructedClose: true, noPositionState: true, synthetic: false,
      };
      try {
        const { lookupQualityForTrade } = require('./signal-quality');
        const sq = await lookupQualityForTrade(nsAsset, null, noStateTrade.openedAt, null);
        if (sq) {
          if (sq._template)  noStateTrade.template  = sq._template;
          if (sq._dedupeKey) noStateTrade.dedupeKey = sq._dedupeKey;
        }
      } catch (_) {}
      try { await storeClosedTrade(noStateTrade); } catch (_) {}
      try { await addDailyPnL(nsPnL); } catch (_) {}
      const nsOutcome = nsPnL > 0.5 ? '✓ WIN' : nsPnL < -0.5 ? '✗ LOSS' : '— BE';
      recordings.push({ positionId, asset: nsAsset, pnl: nsPnL, stored: true, noPositionState: true });
      await pushCommentary(nsAsset, 'trade-closed',
        `${nsOutcome} — ${nsDirection} closed (no-state recovery): ${nsPnL >= 0 ? '+' : ''}$${nsPnL.toFixed(2)}`);
      try {
        await notifyTradeClosed({ asset: nsAsset, direction: nsDirection, totalPnL: nsPnL,
          tpsHit: [], positionId, openedAt: noStateTrade.openedAt, closedAt: nsClosedAt });
      } catch (_) {}
      continue;
    }

    const positionDeals = recentDeals.filter((d) => d.positionId === positionId);
    if (positionDeals.length === 0) continue;

    const totalPnL = positionDeals.reduce((sum, d) => sum + (d.profit || 0) + (d.commission || 0) + (d.swap || 0), 0);

    const pendingList = await getPendingSetups(state.asset);
    const matchedPending = pendingList.find((p) => p.id === state.pendingId);
    if (!matchedPending) {
      // FALLBACK: pending setup was cleared before close detection ran.
      // Reconstruct from position state + broker deals so the trade is not
      // silently lost from ledger, recognition memory, and daily P&L.
      const tradeId      = `trade_${state.asset}_${positionId}`;
      const alreadyDone  = await r.get(`v14:ledger:trade:${tradeId}`).catch(() => null);
      const hasExitDeal  = positionDeals.some(d => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT');
      if (!alreadyDone && hasExitDeal) {
        const reconstructed = {
          id: tradeId, asset: state.asset, direction: state.direction,
          template: null, style: null, mode: null, session: null,
          tpsHit: state.tpsHit || [],
          maxTP: (state.tpsHit || []).reduce((m, n) => Math.max(m, parseInt(String(n).slice(2), 10) || 0), 0),
          pnl: totalPnL, riskDollars: null,
          openedAt: state.createdAt, closedAt: Date.now(),
          dedupeKey: state.dedupeKey || null,
          reconstructedClose: true, synthetic: false,
        };
        try { await storeClosedTrade(reconstructed); } catch (_) {}
        try { await writeLedgerRecord({ state, matchedPending: null, positionDeals, positionId, extraFlags: { reconstructedClose: true } }); } catch (_) {}
        try { await addDailyPnL(totalPnL); } catch (_) {}
        recordings.push({ positionId, asset: state.asset, pnl: totalPnL, stored: true, reconstructedClose: true });
        await updatePendingSetup(state.asset, state.pendingId, { status: 'closed', finalPnL: totalPnL, closedAt: Date.now() }).catch(() => {});
        const outcome = totalPnL > 0.5 ? '✓ WIN' : totalPnL < -0.5 ? '✗ LOSS' : '— BE';
        await pushCommentary(state.asset, 'trade-closed',
          `${outcome} — ${state.direction} closed (reconstructed): ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);
        try {
          await notifyTradeClosed({
            asset: state.asset, direction: state.direction, totalPnL,
            tpsHit: state.tpsHit || [], positionId,
            openedAt: state.createdAt, closedAt: Date.now(),
          });
        } catch (_) {}
      }
      continue;
    }

    const closedTrade = {
      id: `trade_${state.asset}_${positionId}`,
      asset: state.asset,
      direction: state.direction,
      mode: matchedPending.setup.mode,
      // v14: day/swing style + explicit template, for the Day-vs-Swing chart.
      // style comes from the webhook decision (rules-store), carried on the
      // pending setup. Falls back to pilotRulesApplied for in-flight setups.
      style: matchedPending.setup.style
             || (matchedPending.pilotRulesApplied && matchedPending.pilotRulesApplied.style)
             || null,
      template: matchedPending.setup.template
             || (matchedPending.setup.contributingTactics || [])[0]
             || null,
      // v14: carry the entry-style label through to closed trades so the
      // Immediate-vs-Retest comparison can aggregate win-rate / count / P&L.
      // Only trades placed after this ships will have it (older ones = null).
      entryType: matchedPending.entryType || null,
      execKind: matchedPending.execKind || null,
      htfTier: matchedPending.htfTier || null,
      // v14.1: which TP rungs the trade reached (for per-template TP-hit stats)
      tpsHit: state.tpsHit || [],
      maxTP: (state.tpsHit || []).reduce((m, n) => Math.max(m, parseInt(String(n).slice(2), 10) || 0), 0),
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
      dedupeKey: state.dedupeKey || null,
      synthetic: false,
    };

    const stored = await storeClosedTrade(closedTrade);

    // v14: write full cost breakdown to ledger (gross, commission, swap, slippage)
    try {
      await writeLedgerRecord({ state, matchedPending, positionDeals, positionId });
    } catch (e) {
      console.error('[manage-trades] ledger write failed:', e.message);
    }

    // Shadow close: stamp the signal-time advice record with actual outcome.
    // Lets the shadow log compare advice→outcome without any post-hoc adjustment.
    try {
      const _shadowKey = `v14:shadow:advice:${matchedPending.id}`;
      const _shadowRaw = await r.get(_shadowKey).catch(() => null);
      const _shadow = _shadowRaw
        ? (typeof _shadowRaw === 'string' ? safeParse(_shadowRaw) : _shadowRaw)
        : null;
      if (_shadow && !_shadow.closedAt) {
        const _outcome     = totalPnL > 0.5 ? 'WIN' : totalPnL < -0.5 ? 'LOSS' : 'BREAKEVEN';
        const _riskDollars = matchedPending.sizing?.baseRisk;
        await r.set(_shadowKey, JSON.stringify({
          ..._shadow,
          outcome:   _outcome,
          netPnl:    Math.round(totalPnL * 100) / 100,
          pnlR:      (_riskDollars > 0) ? Math.round(totalPnL / _riskDollars * 100) / 100 : null,
          closedAt:  Date.now(),
        }), { ex: 86400 * 90 }).catch(() => {});
      }
    } catch (_) {}

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
          asset:       state.asset,
          direction:   state.direction,
          slPrice:     lastSL,
          dollarsLost: totalPnL,
          positionId,
          riskDollars: matchedPending.sizing?.baseRisk || null,
          openedAt:    state.createdAt,
        });
      } else {
        await notifyTradeClosed({
          asset:       state.asset,
          direction:   state.direction,
          totalPnL,
          tpsHit,
          positionId,
          openedAt:    state.createdAt,
          closedAt:    Date.now(),
          template:    matchedPending.setup?.template   || null,
          session:     matchedPending.setup?.session    || null,
          riskDollars: matchedPending.sizing?.baseRisk  || null,
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

  // All trade-management work is done. Build result before the evaluator runs so
  // a slow candle fetch or error can never corrupt the manage-tick return value.
  const result = {
    ts: Date.now(),
    tradingEnabled: true,
    openCount: managedPositions.length,
    manageResults,
    closedAndRecorded: recordings,
    watched,
  };

  // ── Entrystyle shadow evaluator ─────────────────────────────────────────────
  // Resolves immediate-vs-retest shadow records older than 4 h via MetaAPI 5m
  // candles. MAX_PER_TICK = 20 (cap is in entrystyle-evaluator.js).
  // 8 s hard timeout so a slow network call can't delay the next minute's tick.
  // Errors are swallowed — never affects live position state.
  try {
    result.entryStyle = await Promise.race([
      runEntryStyleEvaluator(),
      new Promise((resolve) => setTimeout(() => resolve({ skipped: 'timeout' }), 8000)),
    ]);
  } catch (_) {
    result.entryStyle = { error: 'evaluator-threw' };
  }

  return result;
}


// ── Backfill helpers for orphaned closed positions ────────────────────────────
// An orphaned position is one where detectAndProcessClosed ran AFTER the pending
// setup was already cleared, causing ledger/recognition writes to be skipped.
// Call action=backfill-orphaned to recover those trades from MetaAPI history.

async function fetchOrphanedDeals(positionIds) {
  const token     = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region    = process.env.METAAPI_REGION || 'london';
  const since     = new Date(Date.now() - 30 * 86400000).toISOString();
  const until     = new Date().toISOString();
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time/${since}/${until}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, {
      headers: { 'auth-token': token, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`MetaAPI ${resp.status}: ${t.slice(0, 120)}`); }
    const deals  = await resp.json();
    if (!Array.isArray(deals)) throw new Error('non-array from MetaAPI history');
    const wanted = new Set(positionIds.map(String));
    const byPos  = {};
    for (const d of deals) {
      if (!d.positionId || !wanted.has(String(d.positionId))) continue;
      if (d.type === 'DEAL_TYPE_BALANCE' || d.type === 'DEAL_TYPE_CREDIT') continue;
      (byPos[String(d.positionId)] = byPos[String(d.positionId)] || []).push(d);
    }
    return byPos;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function backfillOrphanedPositions(positionIds) {
  const r = getRedis();
  if (!r) throw new Error('no-redis');
  const dealsByPos = await fetchOrphanedDeals(positionIds);
  const results    = [];

  for (const positionId of positionIds) {
    const deals = dealsByPos[String(positionId)];
    if (!deals || deals.length === 0) {
      results.push({ positionId, status: 'no-deals-in-30d' });
      continue;
    }
    // Guard: require at least one exit deal. Without one the position is still
    // open and pnl would be 0 — writing a close record would be premature.
    const hasExit = deals.some(d => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT');
    if (!hasExit) {
      results.push({ positionId, status: 'position-still-open' });
      continue;
    }
    const stateRaw = await r.get(POSITION_STATE_KEY(positionId)).catch(() => null);
    const state    = safeParse(stateRaw);
    if (!state) {
      results.push({ positionId, status: 'no-position-state' });
      continue;
    }
    const tradeId    = `trade_${state.asset}_${positionId}`;
    const existLedger = await r.get(`v14:ledger:trade:${tradeId}`).catch(() => null);
    if (existLedger) {
      results.push({ positionId, status: 'already-in-ledger', tradeId });
      continue;
    }
    const totalPnL = deals.reduce((s, d) => s + (d.profit || 0) + (d.commission || 0) + (d.swap || 0), 0);
    const closed   = {
      id: tradeId, asset: state.asset, direction: state.direction,
      template: null, style: null, mode: null, session: null,
      tpsHit: state.tpsHit || [],
      maxTP: (state.tpsHit || []).reduce((m, n) => Math.max(m, parseInt(String(n).slice(2), 10) || 0), 0),
      pnl: totalPnL, riskDollars: null,
      openedAt: state.createdAt, closedAt: Date.now(),
      dedupeKey: state.dedupeKey || null,
      reconstructedClose: true, synthetic: false,
    };
    let recogOk = false;
    try { await storeClosedTrade(closed); recogOk = true; } catch (_) {}
    let ledgerResult;
    try {
      ledgerResult = await writeLedgerRecord({
        state, matchedPending: null, positionDeals: deals, positionId,
        extraFlags: { reconstructedClose: true },
      });
    } catch (e) {
      ledgerResult = { error: e.message };
    }
    try { await addDailyPnL(totalPnL); } catch (_) {}
    results.push({
      positionId, status: 'backfilled', tradeId,
      asset: state.asset, pnl: Math.round(totalPnL * 100) / 100,
      tpsHit: state.tpsHit || [], recogOk, ledger: ledgerResult,
    });
  }
  return results;
}

// ── Force-record from MetaAPI deal history ────────────────────────────────────
// Recovery path for trades that were never stored in recognition memory because
// position state was never created (e.g. BTC slippage pushed fill past TP1 →
// managePosition rejected the pending setup → no state → detectAndProcessClosed
// silently dropped it). Works without position state — reconstructs from deals only.

async function forceRecordFromHistory(positionIds, overrides = {}) {
  const r = getRedis();
  if (!r) throw new Error('no-redis');
  const dealsByPos = await fetchOrphanedDeals(positionIds);
  const results    = [];

  for (const positionId of positionIds) {
    const deals = dealsByPos[String(positionId)];
    if (!deals || deals.length === 0) {
      results.push({ positionId, status: 'no-deals-in-30d' });
      continue;
    }

    const entryDeal = deals.find(d => d.entryType === 'DEAL_ENTRY_IN');
    const exitDeal  = deals.find(d => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT');
    if (!exitDeal) {
      results.push({ positionId, status: 'no-exit-deal' });
      continue;
    }

    const totalPnL = deals.reduce((s, d) => s + (d.profit || 0) + (d.commission || 0) + (d.swap || 0), 0);

    const symb  = ((entryDeal || deals[0]) || {}).symbol || '';
    const asset = symb ? await resolveAsset(symb).catch(() => null) : null;
    if (!asset) {
      results.push({ positionId, status: 'cannot-resolve-asset', symbol: symb });
      continue;
    }

    // BUY deal at entry = LONG position
    const direction = (!entryDeal || entryDeal.type === 'DEAL_TYPE_BUY') ? 'LONG' : 'SHORT';

    const openedAt = entryDeal?.time ? new Date(entryDeal.time).getTime() : null;
    const closedAt = exitDeal.time   ? new Date(exitDeal.time).getTime()  : Date.now();

    const tradeId = `trade_${asset}_${positionId}`;
    const closed  = {
      id: tradeId, asset, direction,
      template: null, style: null, mode: null, session: null,
      tpsHit: [], maxTP: 0,
      pnl: totalPnL, riskDollars: null,
      openedAt: openedAt || closedAt, closedAt,
      dedupeKey: null,
      reconstructedClose: true, synthetic: false,
    };

    // Apply caller-supplied overrides first (e.g. template passed via ?template= query param).
    if (overrides.template)  closed.template  = overrides.template;
    if (overrides.dedupeKey) closed.dedupeKey = overrides.dedupeKey;

    // Enrich with SQ record to get dedupeKey (and template if not overridden).
    // Uses provided template for a tighter join; falls back to asset+time only.
    try {
      const { lookupQualityForTrade } = require('./signal-quality');
      const sq = await lookupQualityForTrade(asset, closed.template || null, closed.openedAt, closed.dedupeKey || null);
      if (sq) {
        if (sq._template  && !closed.template)  closed.template  = sq._template;
        if (sq._dedupeKey && !closed.dedupeKey) closed.dedupeKey = sq._dedupeKey;
      }
    } catch (_) {}

    let recogOk = false;
    try { await storeClosedTrade(closed); recogOk = true; } catch (e) {
      results.push({ positionId, status: 'store-failed', error: e.message });
      continue;
    }

    results.push({
      positionId, status: 'recorded', tradeId,
      asset, direction,
      pnl:      Math.round(totalPnL * 100) / 100,
      openedAt, closedAt, recogOk,
    });
  }
  return results;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const action = (req.query && req.query.action) || '';
    if (action === 'today-pnl') {
      return res.status(200).json(await getTodayRealized());
    }
    if (action === 'backfill-orphaned') {
      const key = String((req.query && req.query.key) || '');
      if (!process.env.WEBHOOK_API_KEY || key !== process.env.WEBHOOK_API_KEY) {
        return res.status(401).json({ ok: false, error: 'unauthorized -- pass ?key=WEBHOOK_API_KEY' });
      }
      const rawIds = req.query.ids
        ? String(req.query.ids).split(',').map(s => s.trim()).filter(Boolean)
        : ['307572483', '300390977'];
      return res.status(200).json({ ok: true, results: await backfillOrphanedPositions(rawIds) });
    }
    if (action === 'force-record') {
      const key = String((req.query && req.query.key) || '');
      if (!process.env.WEBHOOK_API_KEY || key !== process.env.WEBHOOK_API_KEY) {
        return res.status(401).json({ ok: false, error: 'unauthorized -- pass ?key=WEBHOOK_API_KEY' });
      }
      const rawIds = req.query.ids
        ? String(req.query.ids).split(',').map(s => s.trim()).filter(Boolean)
        : [];
      if (!rawIds.length) return res.status(400).json({ ok: false, error: 'ids required' });
      const overrides = {};
      if (req.query.template) overrides.template  = String(req.query.template).trim();
      if (req.query.dedupeKey) overrides.dedupeKey = String(req.query.dedupeKey).trim();
      return res.status(200).json({ ok: true, results: await forceRecordFromHistory(rawIds, overrides) });
    }
    const result = await runManageTick();
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.runManageTick             = runManageTick;
module.exports.getTodayRealized          = getTodayRealized;
module.exports.managePosition            = managePosition;
module.exports.backfillOrphanedPositions = backfillOrphanedPositions;