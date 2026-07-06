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

// v14: all-or-nothing exits. The full position rides to the FINAL TP (parked as
// the broker TP at placement). At TP1/TP2 touches we ONLY ratchet the SL up to
// that TP — no partial closes. Set to true to restore the legacy 33/33/34 scale-out.
const USE_PARTIALS = false;
const USE_SL_RATCHET = true;     // ratchet SL to each confirmed TP level
const USE_TRAILING_STOP = true;  // trail at 1×ATR once 2R+ profit and 2 TPs hit

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
      return tps.every((tp) => (isLong ? tp.price > entry : tp.price < entry));
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

  // ─── TP TOUCH DETECTION (wick-aware, CONFIRMED) ──────────────────
  // A TP counts as hit only when price trades a confirmation buffer BEYOND it —
  // not a bare wick that instantly reverses. (A 1-tick stab that bounces used to
  // record a "hit" and yank the stop to breakeven, strangling a winner.) The
  // notification is DEFERRED until after the ratchet so it reports the REAL stop.
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
      const rMult = Math.abs(tpPrice - state.entry) / initialSLForR;
      await pushCommentary(asset, 'tp-hit',
        `${tpName} confirmed @ ${tpPrice.toFixed(tpPrice > 100 ? 2 : 5)} (${rMult.toFixed(1)}R)`);
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
  const pipSz = (assetMeta && assetMeta.pipSize) || (currentPrice > 100 ? 0.01 : 0.0001);
  const stopBuffer = Math.max(pipSz * 8, initialSLForR * 0.05);
  const curSL = (typeof position.stopLoss === 'number' && position.stopLoss > 0) ? position.stopLoss : null;

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
    const modifyResult = await modifyPosition(position.id, chosen.price, finalTPPrice, asset);
    if (modifyResult.ok) {
      state.slMoves.push({ atTP: chosen.name, newSL: chosen.price, ts: Date.now() });
      actions.push({ action: 'sl-move', newSL: chosen.price, at: chosen.name, ok: true });
      await pushCommentary(asset, 'sl-moved',
        `SL locked at ${chosen.name} @ ${chosen.price.toFixed(chosen.price > 100 ? 2 : 5)}`);
      // Telegram ONLY when the lock deepens to a NEW TP — reporting the REAL
      // guaranteed dollars from that stop level (never an ideal/unrealized figure).
      if (state.lockedTP !== chosen.name) {
        state.lockedTP = chosen.name;
        const rMult = Math.abs(chosen.price - state.entry) / initialSLForR;
        const lockedDollars = signedDollarsForLeg(asset, state.entry, chosen.price, direction, position.volume);
        const ridingTo = tpLevels[finalIdx] ? tpLevels[finalIdx].price : null;
        try {
          await sendOnce(`tplock:${position.id}:${chosen.name}`,
            `\u{1F3AF} <b>${chosen.name} LOCKED \u2014 ${asset.toUpperCase()}</b>\n\n` +
            `${isLong ? '\u{1F7E2}' : '\u{1F534}'} ${direction} \u00b7 stop now at ${chosen.name} <code>${chosen.price.toFixed(chosen.price > 100 ? 2 : 5)}</code> (${rMult.toFixed(1)}R)\n` +
            (lockedDollars != null ? `Locked in: <b>${lockedDollars >= 0 ? '+' : ''}$${lockedDollars.toFixed(2)}</b> guaranteed if stopped\n` : '') +
            (ridingTo != null ? `Riding to TP${finalIdx + 1}: <code>${ridingTo.toFixed(ridingTo > 100 ? 2 : 5)}</code>` : ''));
        } catch (_) {}
      }
    } else {
      actions.push({ action: 'sl-move', error: modifyResult.error, attemptedSL: chosen.price });
      await pushCommentary(asset, 'sl-move-rejected',
        `SL lock to ${chosen.name} rejected (retries next tick): ${modifyResult.error.slice(0, 70)}`);
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
      synthetic: false,
    };

    const stored = await storeClosedTrade(closedTrade);

    // v14: write full cost breakdown to ledger (gross, commission, swap, slippage)
    try {
      await writeLedgerRecord({ state, matchedPending, positionDeals, positionId });
    } catch (e) {
      console.error('[manage-trades] ledger write failed:', e.message);
    }

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
    const action = (req.query && req.query.action) || '';
    if (action === 'today-pnl') {
      return res.status(200).json(await getTodayRealized());
    }
    const result = await runManageTick();
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.runManageTick = runManageTick;
module.exports.getTodayRealized = getTodayRealized;
module.exports.managePosition = managePosition;