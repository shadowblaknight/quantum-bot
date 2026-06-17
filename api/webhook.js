/* eslint-disable */
// api/webhook.js  (Pilot Dashboard v1.1 — manual mode routing)
//
// Adds: when decision.tradingMode === 'manual', writes setup to watched-setups
// for the cron to monitor + notifies user via Telegram. Does NOT place an order.
// Auto mode flow is unchanged.
// ----------------------------------------------------------------------------

const { getRedis, applyCors } = require('./_lib');
const { resolveSymbol } = require('./symbol-resolver');
const { fetchAccount, fetchPositions } = require('./broker');
const { placeLimitOrder } = require('./execute');
const { notifyTradePlaced, sendOnce } = require('./telegram');
const { getAssetById } = require('./asset-registry');
const { applyRulesToSignal, logActivity, getTodaysPnL } = require('./rules-store');
const { addWatchedSetup } = require('./watched-setups');
const { templateLabelMap } = require('./_templates');
const TEMPLATE_LABELS = templateLabelMap();

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
  catch (_) { return false; }
}

async function markExecuted(dedupeKey, info) {
  const r = getRedis();
  if (!r || !dedupeKey) return;
  try { await r.set(DEDUPE_PREFIX + dedupeKey, JSON.stringify(info), { ex: DEDUPE_TTL }); }
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

  // 7. Position-already-open check
  const existing = (Array.isArray(positions) ? positions : []).find((pos) => {
    return (pos.assetId === assetId) ||
           (pos.symbol && pineTicker && pos.symbol.toUpperCase().includes(pineTicker));
  });
  if (existing) {
    return bgSkip({
      dedupeKey, pineTicker, template: p.template,
      reason: 'position-already-open',
      extras: { assetId, positionTicket: existing.id }, notify: false,
    });
  }

  // 8. Resolve broker symbol
  const brokerSymbol = await resolveSymbol(assetId);
  if (!brokerSymbol) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: `cannot resolve broker symbol for ${assetId}` });
    return;
  }

  // 10. Asset meta
  const assetMeta = getAssetById(assetId);
  if (!assetMeta) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: `no asset registry for ${assetId}` });
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
  const finalLot = decision.finalLot;
  const finalSL = decision.finalSL;
  const finalTP1 = decision.finalTP1 != null ? decision.finalTP1 : tp1;
  // v14 all-or-nothing: broker TP parks at the LAST configured target so the full
  // position rides there. SL ratchets to TP1/TP2 in manage-trades (no partials).
  const _bTP2 = decision.finalTP2 != null ? decision.finalTP2 : tp2;
  const _bTP3 = decision.finalTP3 != null ? decision.finalTP3 : tp3;
  const brokerTP = _bTP3 != null ? _bTP3 : (_bTP2 != null ? _bTP2 : finalTP1);
  const comment = `QB-V13-${p.template}-${(p.window || p.swept || '').slice(0, 12)}`.slice(0, 64);

  const placement = await placeLimitOrder(brokerSymbol, p.direction, finalLot, entry, finalSL, brokerTP, comment);

  if (!placement.ok) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: placement.error });
    try {
      await sendOnce(`webhook-fail:${dedupeKey}`,
        `\u26a0\ufe0f <b>Order REJECTED by broker \u2014 ${pineTicker}</b>\n\n` +
        `Template: ${p.template}\nDirection: ${p.direction}\nLot: ${finalLot}\n` +
        `Error: <code>${(placement.error || 'unknown').slice(0, 200)}</code>`);
    } catch (_) {}
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
      v13: true, pilotRulesApplied: decision.rulesApplied,
    };
    await addPendingSetup(assetId, pendingRecord);
  } catch (e) { console.error('[webhook] pending setup write failed:', e.message); }

  await logActivity({
    type: 'trade-placed', asset: assetId, template: p.template, direction: p.direction,
    lot: finalLot, entry, sl: finalSL, tp1: decision.finalTP1,
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
    const extra  = (p.htfTier ? `\nTier: ${p.htfTier}` : '') + (p.widthATR != null ? `\nWidth: ${p.widthATR}× ATR` : '') + (p.session ? `\nSession: ${p.session}` : '');
    try {
      await sendOnce(`pineskip:${assetId}:${p.template}:${reason}:${p.timestamp || ''}`,
        `⚪ ${assetId.toUpperCase()} · ${p.template} · SKIPPED\n${note}${extra}`);
    } catch (_) {}
    try { await logActivity({ type: 'skip', asset: assetId, template: p.template, direction: p.direction || null, reason: `pine-skip: ${reason}` }); } catch (_) {}
    return res.status(200).json({ ok: true, skipped: true, reason });
  }

  // 9. Parse numerics (fast) — fail fast on a malformed payload
  const entry = parseFloat(p.entry);
  const sl    = parseFloat(p.sl);
  const tp1   = parseFloat(p.tp1);
  const tp2   = parseFloat(p.tp2);
  const tp3   = parseFloat(p.tp3);
  if (!isFinite(entry) || !isFinite(sl) || !isFinite(tp1)) {
    return res.status(400).json({ ok: false, error: 'invalid entry/sl/tp1 in payload' });
  }

  // 5. Dedupe (fast Redis read)
  const dedupeKey = `${assetId}:${p.template}:${p.direction}:${p.timestamp}`;
  if (await alreadyExecuted(dedupeKey)) {
    return res.status(200).json({ ok: true, executed: false, reason: 'duplicate-signal', dedupeKey });
  }

  // ---- Run the heavy pipeline. Placement MUST survive the response. ----
  // Vercel FREEZES a serverless function the moment its response is flushed,
  // UNLESS post-response work is registered via waitUntil. So branch on it:
  //   • waitUntil present  → fast-ACK now, place in background (clean TV log).
  //   • waitUntil ABSENT   → place INLINE first, THEN respond. Guaranteed
  //     placement. The TV log may occasionally read "took too long", which is
  //     cosmetic: Vercel still completes the function and the order IS placed.
  if (typeof _waitUntil === 'function') {
    res.status(202).json({ ok: true, accepted: true, dedupeKey, ackMs: Date.now() - t0 });
    _waitUntil(
      processSignalBackground({ p, assetId, pineTicker, dedupeKey, entry, sl, tp1, tp2, tp3 })
        .catch((e) => { try { console.error('[webhook bg] error:', e && e.message); } catch (_) {} })
    );
  } else {
    try {
      await processSignalBackground({ p, assetId, pineTicker, dedupeKey, entry, sl, tp1, tp2, tp3 });
      if (!res.headersSent) res.status(200).json({ ok: true, dedupeKey, ms: Date.now() - t0 });
    } catch (e) {
      try { console.error('[webhook] inline pipeline error:', e && e.message); } catch (_) {}
      if (!res.headersSent) res.status(200).json({ ok: false, error: (e && e.message) || 'pipeline-error', dedupeKey });
    }
  }
};

module.exports.parseDualFormat = parseDualFormat;