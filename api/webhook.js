/* eslint-disable */
// api/webhook.js  (Pilot Dashboard v1.1 — manual mode routing)
//
// Adds: when decision.tradingMode === 'manual', writes setup to watched-setups
// for the cron to monitor + notifies user via Telegram. Does NOT place an order.
// Auto mode flow is unchanged.
// ----------------------------------------------------------------------------

const { getRedis, applyCors, roundToPipSize } = require('./_lib');
const { resolveSymbol } = require('./symbol-resolver');
const { fetchAccount, fetchPositions, fetchCandles } = require('./broker');
const { placeLimitOrder, placeMarketOrder } = require('./execute');
const { notifyTradePlaced, sendOnce } = require('./telegram');
const { getAssetById } = require('./asset-registry');
const { applyRulesToSignal, logActivity, getTodaysPnL } = require('./rules-store');
const { addWatchedSetup } = require('./watched-setups');
const { templateLabelMap, REACTION_TEMPLATES } = require('./_templates');
const { evaluateReactionMTF, tfSetForMode } = require('./reaction-filter');
const TEMPLATE_LABELS = templateLabelMap();

// v14: tick-rounding must NOT depend on _lib exporting roundToPipSize. If that
// import is ever undefined, calling it would throw mid-placement and silently
// drop EVERY auto-mode trade (skips bypass this path), which looks exactly like
// "signals deliver but never trade". Use the import when it's a real function,
// otherwise fall back to an identical local implementation.
const _roundTick = (typeof roundToPipSize === 'function')
  ? roundToPipSize
  : (value, step, mode) => {
      const s = (step && isFinite(step) && step > 0) ? step : 0.0001;
      const q = value / s;
      const r = mode === 'down' ? Math.floor(q) : mode === 'up' ? Math.ceil(q) : Math.round(q);
      const dec = Math.max(0, Math.min(10, ((String(s).split('.')[1]) || '').length));
      return parseFloat((r * s).toFixed(dec));
    };

const PINE_TO_ASSET = {
  XAUUSD: 'gold', EURUSD: 'eurusd', GBPUSD: 'gbpusd', USDJPY: 'usdjpy',
  // NAS100 aliases — data feeds label this instrument differently. Your feed
  // sends "NDQ" (visible in the alert), which had no mapping → 400 unknown symbol.
  NAS100: 'nas100', NDQ: 'nas100', US100: 'nas100', USTEC: 'nas100', NDX: 'nas100', USTECH: 'nas100',
  // SP500 aliases
  SP500: 'us500', US500: 'us500', SPX500: 'us500', SPX: 'us500',
  BTCUSD: 'btc', BTCUSDT: 'btc', BTCUSDC: 'btc',
};

const DEDUPE_PREFIX = 'v13:webhook:dedupe:';
const DEDUPE_TTL = 60 * 60;
const ACCEPTED_TEMPLATES = ['reaction','reaction-fvg','reaction-ifvg','orb','silver-bullet','unicorn','turtle-soup','judas-swing','ote-continuation','am-ifvg'];
function _escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const BALANCE_CACHE_KEY = 'v13:account:balance';
async function getCapitalFast() {
  const r = getRedis();
  const account = await withTimeout(fetchAccount(), 2000, null);
  if (account && (account.balance || account.equity)) {
    const bal = account.balance || account.equity;
    if (r) { try { await r.set(BALANCE_CACHE_KEY, String(bal), { ex: 86400 }); } catch (_) {} }
    return bal;
  }
  if (r) {
    try { const raw = await r.get(BALANCE_CACHE_KEY); if (raw) return parseFloat(raw); }
    catch (_) {}
  }
  return 10000;
}

function isTradingEnabled() {
  return process.env.QB_TRADING_ENABLED === 'true';
}

function parseDualFormat(body) {
  if (!body) return { ok: false, error: 'empty body' };
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return { ok: true, payload: body };
  }
  const text = typeof body === 'string' ? body : String(body);
  const delimIdx = text.indexOf('\n---');
  if (delimIdx < 0) {
    try { return { ok: true, payload: JSON.parse(text.trim()) }; }
    catch (_) { return { ok: false, error: 'no --- delimiter and body is not JSON' }; }
  }
  const jsonPart = text.slice(delimIdx + 4).trim();
  try { return { ok: true, payload: JSON.parse(jsonPart) }; }
  catch (e) { return { ok: false, error: `JSON parse failed: ${e.message}` }; }
}

async function alreadyExecuted(dedupeKey) {
  if (!dedupeKey) return false;
  const r = getRedis();
  if (!r) return false;
  try { return (await r.get(DEDUPE_PREFIX + dedupeKey)) != null; }
  catch (e) { console.warn('[webhook] Redis dedupe check failed — dedupe disabled for this request:', e && e.message); return false; }
}

async function markExecuted(dedupeKey, info, ttlSeconds = DEDUPE_TTL) {
  const r = getRedis();
  if (!r || !dedupeKey) return;
  try { await r.set(DEDUPE_PREFIX + dedupeKey, JSON.stringify(info), { ex: ttlSeconds }); }
  catch (_) {}
}

async function skipWithReason({ res, dedupeKey, pineTicker, template, reason, extras = {}, notify = true }) {
  await logActivity({
    type: 'skip', asset: extras.assetId || null, template,
    direction: extras.direction || null, reason, ...extras,
  });
  if (notify) {
    try {
      await sendOnce(`skip:${dedupeKey || reason}`,
        `⚠️ <b>Signal SKIPPED — ${pineTicker || extras.assetId || ''}</b>\n\n` +
        (template ? `Template: ${template}\n` : '') +
        `Reason: <code>${reason}</code>`);
    } catch (_) {}
  }
  return res.status(200).json({ ok: true, executed: false, reason, ...extras });
}

// =====================================================================
// FAST-ACK REFACTOR (v1.2)
//   TradingView's webhook waits only a few seconds and does NOT retry. The
//   old flow placed the MetaAPI order INLINE before responding, so a slow
//   broker round-trip blew that budget -> "request took too long and timed
//   out", even though the order usually still placed late. Fix: validate just
//   enough to ACK TradingView instantly (sub-second), then run the heavy
//   pipeline (fetch, rules, place, notify) AFTER the response via waitUntil.
//   The broker latency no longer has TradingView waiting on it.
//   Behaviour (auto place, manual watch, skips, dedupe, Telegram) is identical
//   to v1.1 — only the response timing changed.
// =====================================================================

// Vercel's waitUntil keeps the function alive for post-response work. Optional:
// if '@vercel/functions' isn't installed we fall back to awaiting the pipeline
// (the async handler stays pending, so Node serverless keeps it alive anyway).
let _waitUntil = null;
try { ({ waitUntil: _waitUntil } = require('@vercel/functions')); } catch (_) {}

// Background skip = skipWithReason without res (used after the ACK).
async function bgSkip({ dedupeKey, pineTicker, template, reason, extras = {}, notify = true }) {
  await logActivity({
    type: 'skip', asset: extras.assetId || null, template,
    direction: extras.direction || null, reason, ...extras,
  });
  if (notify) {
    try {
      await sendOnce(`skip:${dedupeKey || reason}`,
        `\u26a0\ufe0f <b>Signal SKIPPED \u2014 ${pineTicker || extras.assetId || ''}</b>\n\n` +
        (template ? `Template: ${template}\n` : '') +
        `Reason: <code>${reason}</code>`);
    } catch (_) {}
  }
}

// The heavy pipeline. Runs AFTER TradingView has been acked. NEVER touches res.
async function processSignalBackground({ p, assetId, pineTicker, dedupeKey, entry, sl, tp1, tp2, tp3 }) {
  // 6. Bounded fetch
  const [positions, capital] = await Promise.all([
    withTimeout(fetchPositions(), 1500, []),
    getCapitalFast(),
  ]);

  // 7. Position-already-open check — TEMPLATE-AWARE (v14 testing mode).
  // Block only a SECOND position of the SAME template on the same instrument.
  // A DIFFERENT template is allowed to fire even if the instrument already has an
  // open position — so templates the old "any open position" block was starving
  // (Judas, AM IFVG, Reaction IFVG, Unicorn, Turtle Soup) finally get tested.
  // NOTE: requires a HEDGING account (multiple positions per symbol). On a NETTING
  // account a 2nd order on the same symbol nets against the first.
  const _known = Object.keys(TEMPLATE_LABELS).sort((a, b) => b.length - a.length);
  const _tmplFromComment = (c) => {
    if (!c) return null;
    const m = c.match(/^QB-V1[23]-(.+)$/);
    if (!m) return null;
    const rest = m[1];
    for (const t of _known) { if (rest === t || rest.startsWith(t + '-')) return t; }
    return rest.split('-')[0]; // fallback: first segment, so an unknown template still dedups
  };
  const existing = (Array.isArray(positions) ? positions : []).find((pos) => {
    const sameInstrument = (pos.assetId === assetId) ||
      (pos.symbol && pineTicker && pos.symbol.toUpperCase().includes(pineTicker));
    if (!sameInstrument) return false;
    return _tmplFromComment(pos.comment) === p.template; // only the SAME template blocks
  });
  if (existing) {
    return bgSkip({
      dedupeKey, pineTicker, template: p.template,
      reason: 'same-template-already-open',
      extras: { assetId, positionTicket: existing.id }, notify: true,
    });
  }

  // 8. Resolve broker symbol
  const brokerSymbol = await resolveSymbol(assetId);
  if (!brokerSymbol) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: `cannot resolve broker symbol for ${assetId}` });
    try { await sendOnce(`diag-nosym:${dedupeKey}`, `\u26a0\ufe0f DIAG \u2014 ${assetId} \u00b7 ${p.template}: cannot resolve broker symbol`); } catch (_) {}
    return;
  }

  // 10. Asset meta
  const assetMeta = getAssetById(assetId);
  if (!assetMeta) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: `no asset registry for ${assetId}` });
    try { await sendOnce(`diag-noreg:${dedupeKey}`, `\u26a0\ufe0f DIAG \u2014 ${assetId} \u00b7 ${p.template}: no asset registry entry`); } catch (_) {}
    return;
  }

  // 11. RULES ENGINE
  const todaysPnL = await getTodaysPnL();
  const managedOpen = (positions || []).filter((pos) =>
    pos.comment && (pos.comment.startsWith('QB-V12-') || pos.comment.startsWith('QB-V13-'))
  );
  const decision = await applyRulesToSignal({
    assetId, template: p.template, direction: p.direction,
    entry, sl, tp1, tp2, tp3,
    htfTier: p.htfTier || null, htfBiasAlign: p.htfBiasAlign,
    capital, openPositions: managedOpen, todaysPnL, assetMeta,
  });

  if (!decision.allow) {
    return bgSkip({
      dedupeKey, pineTicker, template: p.template,
      reason: decision.reason,
      extras: { assetId, direction: p.direction, pineSL: sl, pineTP1: tp1 },
      notify: true,
    });
  }

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550 MANUAL MODE \u2550\u2550\u2550\u2550\u2550\u2550\u2550
  if (decision.tradingMode === 'manual') {
    const watchId = `watch_${assetId}_${p.timestamp}_${Date.now()}`;
    await addWatchedSetup({
      id: watchId,
      asset: assetId,
      template: p.template,
      direction: p.direction,
      entry,
      sl: decision.finalSL,
      tp1: decision.finalTP1, tp2: decision.finalTP2, tp3: decision.finalTP3,
      finalLot: decision.finalLot,
      zoneUpper: parseFloat(p.zoneUpper) || null,
      zoneLower: parseFloat(p.zoneLower) || null,
      zoneType: p.zoneType || null,
      pineSL: sl, pineTP1: tp1, pineTP2: tp2, pineTP3: tp3,
      brokerSymbol,
      window: p.window || null,
      swept: p.swept || null,
      timeframe: p.timeframe,
      status: 'watching',
      createdAt: Date.now(),
      expiresAt: Date.now() + 90 * 60 * 1000,
      rulesApplied: decision.rulesApplied,
    });

    await markExecuted(dedupeKey, { watchId, mode: 'manual', placedAt: Date.now() });

    await logActivity({
      type: 'manual-watching',
      asset: assetId, template: p.template, direction: p.direction,
      entry, sl: decision.finalSL, tp1: decision.finalTP1,
      watchId,
    });

    try {
      const tmplLabel = TEMPLATE_LABELS[p.template] || p.template;
      const dirEmoji = p.direction === 'LONG' ? '\ud83d\udfe2' : '\ud83d\udd34';
      await sendOnce(`watching:${watchId}`,
        `\ud83d\udd14 <b>SETUP FORMING \u2014 ${pineTicker}</b>\n\n` +
        `Setup: ${tmplLabel}\n` +
        `${dirEmoji} ${p.direction}  \u2022  Lot to place: ${decision.finalLot}\n` +
        `Entry: <code>${entry}</code>\n` +
        `SL: <code>${decision.finalSL}</code>\n` +
        `TP1: <code>${decision.finalTP1}</code>\n\n` +
        `\u23f3 Watching for price to enter the zone. You'll get a "TIME TO ENTER" alert when it does.\n` +
        `<i>Manual mode: bot will not auto-place this trade.</i>`
      );
    } catch (_) {}
    return;
  }

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550 AUTO MODE \u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // 11b. v14.3 — REACTION multi-timeframe confirmation. Mode-aware: SWING uses
  // [D1,H4] bias + [H1,M15] trigger; DAY uses [H4,H1] bias + [M15,M5] trigger.
  // Each pair is OR-combined (no single timeframe blocks the other); bias is a
  // vote, not a veto. Gate only SKIPS — never places. Runs here so the mode
  // (decision.activeMode) is known.
  if (REACTION_TEMPLATES.includes(p.template)) {
    const rxnMode = decision.activeMode === 'sleep' ? 'swing' : 'day';
    const TFS = tfSetForMode(rxnMode);
    const grab = async (tf, n) => {
      try {
        const r = await withTimeout(fetchCandles(assetId, tf, n), 2500, { candles: [] });
        return (r && r.candles) || [];
      } catch (_) { return []; }
    };
    const [b0, b1, t0, t1] = await Promise.all([
      grab(TFS.bias[0], 40), grab(TFS.bias[1], 40),
      grab(TFS.trigger[0], 60), grab(TFS.trigger[1], 60),
    ]);
    const verdict = evaluateReactionMTF(
      { template: p.template, direction: p.direction, entry, session: p.session, mode: rxnMode, htfBiasAlign: p.htfBiasAlign },
      { biasCandles: [b0, b1], triggerCandles: [t0, t1], combine: 'or' }
    );
    if (verdict.applies && !verdict.pass) {
      await logActivity({
        type: 'reaction-filtered', asset: assetId, template: p.template,
        direction: p.direction, reason: verdict.reason, mode: rxnMode, checks: verdict.checks,
      });
      return bgSkip({
        dedupeKey, pineTicker, template: p.template,
        reason: `reaction-filter:${verdict.reason}`,
        extras: { assetId, direction: p.direction, mode: rxnMode, checks: verdict.checks },
        notify: true,
      });
    }
  }

  const finalLot = decision.finalLot;
  const finalSL = decision.finalSL;
  const finalTP1 = decision.finalTP1 != null ? decision.finalTP1 : tp1;
  // v14 all-or-nothing: broker TP parks at the LAST configured target so the full
  // position rides there. SL ratchets to TP1/TP2 in manage-trades (no partials).
  const _bTP2 = decision.finalTP2 != null ? decision.finalTP2 : tp2;
  const _bTP3 = decision.finalTP3 != null ? decision.finalTP3 : tp3;
  const brokerTP = _bTP3 != null ? _bTP3 : (_bTP2 != null ? _bTP2 : finalTP1);
  const comment = `QB-V13-${p.template}-${(p.window || p.swept || '').slice(0, 12)}`.slice(0, 64);

  // v14: round to the broker's tick increment. Raw Pine prices can carry more
  // decimals than the symbol allows, which the broker rejects as INVALID_PRICE.
  const isLong = p.direction === 'LONG';
  const pipSz = assetMeta.pipSize || 0.0001;
  const rEntry = _roundTick(entry, pipSz, 'nearest');
  const rSL = _roundTick(finalSL, pipSz, isLong ? 'down' : 'up');
  const rTP = brokerTP != null ? _roundTick(brokerTP, pipSz, isLong ? 'down' : 'up') : null;

  // v14: decide MARKET vs LIMIT by whether a valid limit can be placed.
  //  - retest entries sit away from price on the correct side  → LIMIT (as before)
  //  - immediate entries sit at/through the market (the only way in) → MARKET fill,
  //    UNLESS the market has drifted past the entry by more than the slippage budget
  //    (stale / runaway signal) → skip, don't chase. Pine's blow-off cap already
  //    keeps parabolic candles out of the immediate path upstream.
  let entryType = 'retest';
  let useMarket = false;
  // v14.1 diagnostic: capture the routing inputs so a mis-routed immediate/retest
  // can be read back from the activity log — the probed market price, whether a
  // valid limit could be placed, and how far the market had drifted past entry.
  let _dbgProbed = null, _dbgProbeOk = false, _dbgCanLimit = null, _dbgDriftPips = null;
  try {
    const { fetchCandles: _fcSrc } = require('./candle-source');
    const _cr = await withTimeout(_fcSrc(assetId, '5m', 3), 1200, null);
    const _last = _cr && _cr.candles && _cr.candles.length ? _cr.candles[_cr.candles.length - 1] : null;
    const _cur = _last && _last.close;
    if (_cur && isFinite(_cur)) {
      _dbgProbeOk = true; _dbgProbed = _cur;
      const _tol = Math.max((_last.high - _last.low) * 0.5, pipSz * 5);
      // A LIMIT is only valid when the entry sits AWAY from price on the correct
      // side: a LONG buy-limit must be BELOW market, a SHORT sell-limit ABOVE it.
      // Anything else — entry at/through the market (immediate), or so close the
      // broker won't accept it — must go in as a MARKET order, otherwise MT5
      // rejects the limit with TRADE_RETCODE_INVALID_PRICE.
      const _canLimit = isLong ? (rEntry < _cur - _tol) : (rEntry > _cur + _tol);
      _dbgCanLimit = _canLimit;
      if (!_canLimit) {
        const _slDist = Math.abs(rEntry - rSL);
        const _budget = Math.max(_slDist * 0.25, pipSz * 10); // 25% of stop, min 10 pips
        // Adverse drift only: skip just when a MARKET fill would be WORSE than the
        // signalled entry by more than budget (don't chase a runaway). A favorable
        // gap (market better than entry) still fills.
        const _drift = isLong ? (_cur - rEntry) : (rEntry - _cur);
        _dbgDriftPips = +(_drift / pipSz).toFixed(1);
        if (_drift > _budget) {
          await logActivity({ type: 'placement-skipped', asset: assetId, template: p.template, direction: p.direction, reason: 'market-beyond-slippage-budget', signalEntry: rEntry, marketPrice: _cur, driftPips: _dbgDriftPips });
          try {
            await sendOnce(`webhook-stale:${dedupeKey}`,
              `\u26a0\ufe0f <b>Signal SKIPPED \u2014 ${pineTicker}</b>\n\n` +
              `Template: ${p.template}\nDirection: ${p.direction}\n` +
              `Reason: market moved past entry beyond slippage budget \u2014 not chasing`);
          } catch (_) {}
          return;
        }
        useMarket = true;
        entryType = 'immediate';
      }
    }
  } catch (_) { /* candle fetch failed — fall through to limit; broker is final guard */ }

  // v14.1: one-line record of HOW this signal was routed and WHY, so a suspected
  // immediate/retest mis-route can be diagnosed straight from the activity log.
  try {
    await logActivity({
      type: 'entry-routing', asset: assetId, template: p.template, direction: p.direction,
      signalEntry: rEntry, marketPrice: _dbgProbed, probeOk: _dbgProbeOk,
      canLimit: _dbgCanLimit, driftPips: _dbgDriftPips,
      decided: useMarket ? 'immediate(market)' : 'retest(limit)',
    });
  } catch (_) {}

  let placement = useMarket
    ? await placeMarketOrder(brokerSymbol, p.direction, finalLot, rSL, rTP, comment)
    : await placeLimitOrder(brokerSymbol, p.direction, finalLot, rEntry, rSL, rTP, comment);

  // Catch-all for the last INVALID_PRICE causes. A limit can still be rejected
  // when the price probe failed (blind, possibly wrong-side limit) or when a
  // correct-side limit lands inside the broker's minimum stop distance. Rather
  // than drop the trade, retry once as MARKET — a market fill is always
  // price-valid and, for these near-market cases, lands at the intended entry.
  // SL/TP/lot are unchanged, so risk is preserved.
  if (!placement.ok && !useMarket && /INVALID_PRICE/i.test(placement.error || '')) {
    await logActivity({
      type: 'limit-invalid-retry-market', asset: assetId, template: p.template,
      direction: p.direction, attemptedEntry: rEntry, error: (placement.error || '').slice(0, 120),
    });
    const _mkt = await placeMarketOrder(brokerSymbol, p.direction, finalLot, rSL, rTP, comment);
    placement = _mkt;
    if (_mkt.ok) { useMarket = true; entryType = 'immediate'; }
  }

  if (!placement.ok) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: placement.error });
    try {
      await sendOnce(`webhook-fail:${dedupeKey}`,
        `\u26a0\ufe0f <b>Order REJECTED by broker \u2014 ${pineTicker}</b>\n\n` +
        `Template: ${p.template}\nDirection: ${p.direction}\nLot: ${finalLot}\n` +
        `Error: <code>${(placement.error || 'unknown').slice(0, 200)}</code>`);
    } catch (_) {}
    // Downgrade pending marker to a short-lived failure record. Blocks an immediate
    // TV retry of the same bad signal for 60 s; allows a genuine later signal after.
    await markExecuted(dedupeKey, { status: 'failed', failedAt: Date.now() }, 60);
    return;
  }

  await markExecuted(dedupeKey, { brokerOrderId: placement.orderId, template: p.template, placedAt: Date.now() });

  // v2.3: real R-multiples from actual prices — the SL/minRR recompute can put
  // TP1 at 2R (etc.), so the old hardcoded 1/2/3 labels misreported the trade
  // AND corrupted recognition-memory R-data. Compute the truth from prices.
  const _slDist = Math.abs(entry - finalSL);
  const rOf = (tp) => (tp == null || _slDist <= 0) ? null : Math.round(Math.abs(tp - entry) / _slDist * 10) / 10;

  try {
    const { addPendingSetup } = require('./watcher');
    const finalTP2 = decision.finalTP2 != null ? decision.finalTP2 : tp2;
    const finalTP3 = decision.finalTP3 != null ? decision.finalTP3 : tp3;
    const slDistance = Math.abs(entry - finalSL);
    const pendingRecord = {
      id: `setup_${assetId}_v13_${p.timestamp}_${Date.now()}`,
      asset: assetId,
      setup: {
        direction: p.direction,
        mode: decision.activeMode === 'sleep' ? 'SWING' : 'DAY',
        session: p.window || (p.swept ? `swept ${p.swept}` : 'unknown'),
        contributingTactics: [p.template], timeframesInPlay: [p.timeframe],
        slDistance, slDistanceATR: parseFloat(p.impulseATR) || null,
        entry, sl: finalSL,
        style: decision.rulesApplied ? decision.rulesApplied.style : null,
        targets: [
          { price: finalTP1, rMultiple: rOf(finalTP1) },
          { price: finalTP2, rMultiple: rOf(finalTP2) },
          { price: finalTP3, rMultiple: rOf(finalTP3) },
        ].filter((t) => t.price != null),
        template: p.template,
      },
      recognition: { advice: 'neutral', matchCount: 0, wins: 0, losses: 0, confidence: 'none' },
      sizing: { baseLot: finalLot, recommendedLot: finalLot, baseRisk: slDistance * (assetMeta.dollarPerPipPerLot / assetMeta.pipSize) * finalLot },
      plannedEntry: entry, slPrice: finalSL,
      tpLevels: [
        { price: finalTP1, rMultiple: rOf(finalTP1), source: decision.rulesApplied.tpMode },
        { price: finalTP2, rMultiple: rOf(finalTP2), source: decision.rulesApplied.tpMode },
        { price: finalTP3, rMultiple: rOf(finalTP3), source: decision.rulesApplied.tpMode },
      ].filter((t) => t.price != null),
      newsFeature: { newsState: 'none', highImpactWithin60min: false },
      createdAt: Date.now(),
      expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      status: 'placed',
      brokerOrderId: placement.orderId, comment, positionId: null,
      entryType, execKind: useMarket ? 'market' : 'limit',
      v13: true, pilotRulesApplied: decision.rulesApplied,
    };
    await addPendingSetup(assetId, pendingRecord);
  } catch (e) { console.error('[webhook] pending setup write failed:', e.message); }

  await logActivity({
    type: 'trade-placed', asset: assetId, template: p.template, direction: p.direction,
    lot: finalLot, entry, sl: finalSL, tp1: decision.finalTP1,
    entryType, execKind: useMarket ? 'market' : 'limit',
    activeMode: decision.activeMode, rulesApplied: decision.rulesApplied,
    brokerOrderId: placement.orderId,
  });

  try {
    await notifyTradePlaced({
      asset: assetId, direction: p.direction,
      lot: finalLot, entry, sl: finalSL,
      tpLevels: [
        { price: decision.finalTP1, rMultiple: rOf(decision.finalTP1), source: decision.rulesApplied.tpMode },
        { price: decision.finalTP2, rMultiple: rOf(decision.finalTP2), source: decision.rulesApplied.tpMode },
        { price: decision.finalTP3, rMultiple: rOf(decision.finalTP3), source: decision.rulesApplied.tpMode },
      ].filter((t) => t.price != null),
      riskDollars: Math.abs(entry - finalSL) * (assetMeta.dollarPerPipPerLot / assetMeta.pipSize) * finalLot,
      brokerOrderId: placement.orderId, template: p.template,
    });
  } catch (_) {}
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  const t0 = Date.now();

  // ---- FAST PATH: only sub-second work, then ACK so TradingView never times out ----

  // 1-2. Parse + auth
  const parsed = parseDualFormat(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  const p = parsed.payload;

  const expectedKey = process.env.WEBHOOK_API_KEY || '';
  if (!expectedKey) return res.status(500).json({ ok: false, error: 'WEBHOOK_API_KEY not set' });
  if (p.apiKey !== expectedKey) return res.status(401).json({ ok: false, error: 'invalid-api-key' });

  // 3. Master kill switch (fast skip, no order)
  if (!isTradingEnabled()) {
    return skipWithReason({
      res, dedupeKey: null, pineTicker: p.symbol, template: p.template,
      reason: 'trading-disabled (QB_TRADING_ENABLED != true)', notify: false,
    });
  }

  // 4. Resolve ticker (in-memory, fast)
  const rawSymbol = (p.symbol || '').toUpperCase();
  const colonIdx = rawSymbol.lastIndexOf(':');
  const pineTicker = (colonIdx >= 0 ? rawSymbol.slice(colonIdx + 1) : rawSymbol).replace(/[^A-Z0-9]/g, '');
  const assetId = PINE_TO_ASSET[pineTicker];
  if (!assetId) return res.status(400).json({ ok: false, error: `unknown symbol: ${p.symbol}` });

  // 4b. v14 — Pine SKIP alert (tier-C open-space, or ORB width filter). This is
  // NOT a trade: it has no entry/sl/tp. Notify Telegram so the user SEES what the
  // filter rejected, log it, and stop. Fast/inline — no broker, no background.
  if ((p.action || 'trade') === 'skip') {
    const reason = p.reason || 'filtered';
    const note   = p.note || 'setup formed but filtered';
    const extra  = (p.htfTier ? `\nTier: ${_escHtml(p.htfTier)}` : '') + (p.widthATR != null ? `\nWidth: ${p.widthATR}× ATR` : '') + (p.session ? `\nSession: ${_escHtml(p.session)}` : '');
    try {
      await sendOnce(`pineskip:${assetId}:${p.template}:${reason}:${p.timestamp || ''}`,
        `⚪ ${assetId.toUpperCase()} · ${p.template} · SKIPPED\n${_escHtml(note)}${extra}`);
    } catch (_) {}
    try { await logActivity({ type: 'skip', asset: assetId, template: p.template, direction: p.direction || null, reason: `pine-skip: ${reason}` }); } catch (_) {}
    return res.status(200).json({ ok: true, skipped: true, reason });
  }

  if (!ACCEPTED_TEMPLATES.includes(p.template)) {
    return res.status(400).json({ ok: false, error: `unknown template: ${p.template}` });
  }

  // 9. Parse numerics (fast) — fail fast on a malformed payload
  const entry = parseFloat(p.entry);
  const sl    = parseFloat(p.sl);
  const tp1   = parseFloat(p.tp1);
  const _tp2r = parseFloat(p.tp2);
  const _tp3r = parseFloat(p.tp3);
  const tp2   = isFinite(_tp2r) ? _tp2r : null;
  const tp3   = isFinite(_tp3r) ? _tp3r : null;
  if (!isFinite(entry) || !isFinite(sl) || !isFinite(tp1)) {
    return res.status(400).json({ ok: false, error: 'invalid entry/sl/tp1 in payload' });
  }
  if (Math.abs(entry - sl) === 0) {
    return res.status(400).json({ ok: false, error: 'zero-risk payload: sl equals entry' });
  }
  if (p.direction !== 'LONG' && p.direction !== 'SHORT') {
    return res.status(400).json({ ok: false, error: 'invalid direction' });
  }
  const _isLong = p.direction === 'LONG';
  if (_isLong ? (sl >= entry || tp1 <= entry) : (sl <= entry || tp1 >= entry)) {
    return res.status(400).json({ ok: false, error: 'TP/SL on wrong side of entry for direction' });
  }
  if (tp2 !== null && (_isLong ? tp2 <= entry : tp2 >= entry)) {
    return res.status(400).json({ ok: false, error: 'TP/SL on wrong side of entry for direction' });
  }
  if (tp3 !== null && (_isLong ? tp3 <= entry : tp3 >= entry)) {
    return res.status(400).json({ ok: false, error: 'TP/SL on wrong side of entry for direction' });
  }

  // 5. Dedupe (fast Redis read)
  const dedupeKey = `${assetId}:${p.template}:${p.direction}:${p.timestamp}`;
  if (await alreadyExecuted(dedupeKey)) {
    return res.status(200).json({ ok: true, executed: false, reason: 'duplicate-signal', dedupeKey });
  }

  // Write a 'pending' dedupe marker BEFORE the ACK. Any TradingView retry that
  // arrives while the order is in-flight will hit alreadyExecuted and be blocked
  // as a duplicate. Overwritten with the real order record on success; downgraded
  // to a short-lived failure record on broker rejection or exception.
  await markExecuted(dedupeKey, { status: 'pending', startedAt: Date.now() });

  // ---- Run the heavy pipeline. Placement MUST survive the response. ----
  // With @vercel/functions installed _waitUntil is a real function (expected
  // production path): ACK TradingView sub-second, then run the full pipeline
  // post-response via waitUntil so Vercel keeps the function alive. Without it
  // (local/dev fallback): inline-await so nothing silently drops — TV may log a
  // timeout but the order still places.
  if (typeof _waitUntil === 'function') {
    res.status(202).json({ ok: true, accepted: true, dedupeKey, ackMs: Date.now() - t0 });
    _waitUntil(
      processSignalBackground({ p, assetId, pineTicker, dedupeKey, entry, sl, tp1, tp2, tp3 })
        .catch(async (e) => {
          try { console.error('[webhook bg] error:', e && e.message); } catch (_) {}
          // QB-DIAG: surface swallowed background throws over Telegram.
          try { sendOnce(`diag-throw:${dedupeKey}`, `\ud83d\udca5 DIAG THROW \u2014 ${assetId} \u00b7 ${p.template}\n${(e && (e.stack || e.message)) ? String(e.stack || e.message).slice(0, 400) : 'unknown error'}`); } catch (_) {}
          // Downgrade pending marker so an unhandled throw doesn't block this signal for a full hour.
          await markExecuted(dedupeKey, { status: 'failed', failedAt: Date.now() }, 60);
        })
    );
  } else {
    try {
      await processSignalBackground({ p, assetId, pineTicker, dedupeKey, entry, sl, tp1, tp2, tp3 });
      if (!res.headersSent) res.status(200).json({ ok: true, dedupeKey, ms: Date.now() - t0 });
    } catch (e) {
      try { console.error('[webhook] inline pipeline error:', e && e.message); } catch (_) {}
      // QB-DIAG: surface swallowed inline throws over Telegram.
      try { await sendOnce(`diag-throw:${dedupeKey}`, `\ud83d\udca5 DIAG THROW (inline) \u2014 ${assetId} \u00b7 ${p.template}\n${(e && (e.stack || e.message)) ? String(e.stack || e.message).slice(0, 400) : 'unknown error'}`); } catch (_) {}
      // Downgrade pending marker on exception.
      try { await markExecuted(dedupeKey, { status: 'failed', failedAt: Date.now() }, 60); } catch (_) {}
      if (!res.headersSent) res.status(200).json({ ok: false, error: (e && e.message) || 'pipeline-error', dedupeKey });
    }
  }
};

module.exports.parseDualFormat = parseDualFormat;