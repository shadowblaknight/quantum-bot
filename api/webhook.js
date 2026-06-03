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

const PINE_TO_ASSET = {
  XAUUSD: 'gold', EURUSD: 'eurusd', GBPUSD: 'gbpusd', USDJPY: 'usdjpy',
  NAS100: 'nas100', SP500: 'us500', US500: 'us500', BTCUSD: 'btc', BTCUSDT: 'btc',
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

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  const t0 = Date.now();

  // 1-2. Parse + auth
  const parsed = parseDualFormat(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  const p = parsed.payload;

  const expectedKey = process.env.WEBHOOK_API_KEY || '';
  if (!expectedKey) return res.status(500).json({ ok: false, error: 'WEBHOOK_API_KEY not set' });
  if (p.apiKey !== expectedKey) return res.status(401).json({ ok: false, error: 'invalid-api-key' });

  // 3. Master kill switch
  if (!isTradingEnabled()) {
    return skipWithReason({
      res, dedupeKey: null, pineTicker: p.symbol, template: p.template,
      reason: 'trading-disabled (QB_TRADING_ENABLED != true)', notify: false,
    });
  }

  // 4. Resolve ticker
  const rawSymbol = (p.symbol || '').toUpperCase();
  const colonIdx = rawSymbol.lastIndexOf(':');
  const pineTicker = (colonIdx >= 0 ? rawSymbol.slice(colonIdx + 1) : rawSymbol).replace(/[^A-Z0-9]/g, '');
  const assetId = PINE_TO_ASSET[pineTicker];
  if (!assetId) return res.status(400).json({ ok: false, error: `unknown symbol: ${p.symbol}` });

  // 5. Dedupe
  const dedupeKey = `${assetId}:${p.template}:${p.direction}:${p.timestamp}`;
  if (await alreadyExecuted(dedupeKey)) {
    return res.status(200).json({ ok: true, executed: false, reason: 'duplicate-signal', dedupeKey });
  }

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
    return skipWithReason({
      res, dedupeKey, pineTicker, template: p.template,
      reason: 'position-already-open',
      extras: { assetId, positionTicket: existing.id }, notify: false,
    });
  }

  // 8. Resolve broker symbol (only needed for auto mode but cheap to do anyway)
  const brokerSymbol = await resolveSymbol(assetId);
  if (!brokerSymbol) {
    return res.status(500).json({ ok: false, error: `cannot resolve broker symbol for ${assetId}` });
  }

  // 9. Parse numerics
  const entry = parseFloat(p.entry);
  const sl    = parseFloat(p.sl);
  const tp1   = parseFloat(p.tp1);
  const tp2   = parseFloat(p.tp2);
  const tp3   = parseFloat(p.tp3);
  if (!isFinite(entry) || !isFinite(sl) || !isFinite(tp1)) {
    return res.status(400).json({ ok: false, error: 'invalid entry/sl/tp1 in payload' });
  }

  // 10. Asset meta
  const assetMeta = getAssetById(assetId);
  if (!assetMeta) return res.status(500).json({ ok: false, error: `no asset registry for ${assetId}` });

  // 11. RULES ENGINE
  const todaysPnL = await getTodaysPnL();
  const managedOpen = (positions || []).filter((pos) =>
    pos.comment && (pos.comment.startsWith('QB-V12-') || pos.comment.startsWith('QB-V13-'))
  );
  const decision = await applyRulesToSignal({
    assetId, template: p.template, direction: p.direction,
    entry, sl, tp1, tp2, tp3,
    capital, openPositions: managedOpen, todaysPnL, assetMeta,
  });

  if (!decision.allow) {
    return skipWithReason({
      res, dedupeKey, pineTicker, template: p.template,
      reason: decision.reason,
      extras: { assetId, direction: p.direction, pineSL: sl, pineTP1: tp1 },
      notify: true,
    });
  }

  // ═══════ NEW IN v1.1: MANUAL MODE BRANCH ═══════
  if (decision.tradingMode === 'manual') {
    // Don't place order. Store as watching, let cron alert when price enters zone.
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
      expiresAt: Date.now() + 90 * 60 * 1000, // 90 minutes
      rulesApplied: decision.rulesApplied,
    });

    // Mark dedupe so we don't double-watch
    await markExecuted(dedupeKey, { watchId, mode: 'manual', placedAt: Date.now() });

    // Activity log
    await logActivity({
      type: 'manual-watching',
      asset: assetId, template: p.template, direction: p.direction,
      entry, sl: decision.finalSL, tp1: decision.finalTP1,
      watchId,
    });

    // Telegram: setup-watching notification
    try {
      const templateLabels = {
        'silver-bullet':'🥈 Silver Bullet','unicorn':'🦄 Unicorn','turtle-soup':'🐢 Turtle Soup',
        'judas-swing':'🎭 Judas Swing','ote-continuation':'🎯 OTE Continuation',
      };
      const tmplLabel = templateLabels[p.template] || p.template;
      const dirEmoji = p.direction === 'LONG' ? '🟢' : '🔴';
      await sendOnce(`watching:${watchId}`,
        `🔔 <b>SETUP FORMING — ${pineTicker}</b>\n\n` +
        `Setup: ${tmplLabel}\n` +
        `${dirEmoji} ${p.direction}  •  Lot to place: ${decision.finalLot}\n` +
        `Entry: <code>${entry}</code>\n` +
        `SL: <code>${decision.finalSL}</code>\n` +
        `TP1: <code>${decision.finalTP1}</code>\n\n` +
        `⏳ Watching for price to enter the zone. You'll get a "TIME TO ENTER" alert when it does.\n` +
        `<i>Manual mode: bot will not auto-place this trade.</i>`
      );
    } catch (_) {}

    return res.status(200).json({
      ok: true,
      executed: false,
      mode: 'manual',
      reason: 'manual-mode-watching',
      watchId,
      assetId, direction: p.direction,
      entry, sl: decision.finalSL,
      tp1: decision.finalTP1, tp2: decision.finalTP2, tp3: decision.finalTP3,
      lotToPlace: decision.finalLot,
      rulesApplied: decision.rulesApplied,
      durationMs: Date.now() - t0,
    });
  }

  // ═══════ AUTO MODE (unchanged from v1) ═══════
  const finalLot = decision.finalLot;
  const finalSL = decision.finalSL;
  const finalTP1 = decision.finalTP1 != null ? decision.finalTP1 : tp1;
  const comment = `QB-V13-${p.template}-${(p.window || p.swept || '').slice(0, 12)}`.slice(0, 64);

  const placement = await placeLimitOrder(brokerSymbol, p.direction, finalLot, entry, finalSL, finalTP1, comment);

  if (!placement.ok) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: placement.error });
    try {
      await sendOnce(`webhook-fail:${dedupeKey}`,
        `⚠️ <b>Order REJECTED by broker — ${pineTicker}</b>\n\n` +
        `Template: ${p.template}\nDirection: ${p.direction}\nLot: ${finalLot}\n` +
        `Error: <code>${(placement.error || 'unknown').slice(0, 200)}</code>`);
    } catch (_) {}
    return res.status(500).json({ ok: false, error: placement.error, dedupeKey });
  }

  await markExecuted(dedupeKey, { brokerOrderId: placement.orderId, template: p.template, placedAt: Date.now() });

  // Write pending-setup for manage-trades
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
        targets: [
          { price: finalTP1, rMultiple: 1.0 },
          { price: finalTP2, rMultiple: 2.0 },
          { price: finalTP3, rMultiple: 3.0 },
        ].filter((t) => t.price != null),
        template: p.template,
      },
      recognition: { advice: 'neutral', matchCount: 0, wins: 0, losses: 0, confidence: 'none' },
      sizing: { baseLot: finalLot, recommendedLot: finalLot, baseRisk: slDistance * (assetMeta.dollarPerPipPerLot / assetMeta.pipSize) * finalLot },
      plannedEntry: entry, slPrice: finalSL,
      tpLevels: [
        { price: finalTP1, rMultiple: 1.0, source: decision.rulesApplied.tpMode },
        { price: finalTP2, rMultiple: 2.0, source: decision.rulesApplied.tpMode },
        { price: finalTP3, rMultiple: 3.0, source: decision.rulesApplied.tpMode },
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

  let telegramResult;
  try {
    telegramResult = await notifyTradePlaced({
      asset: assetId, direction: p.direction,
      lot: finalLot, entry, sl: finalSL,
      tpLevels: [
        { price: decision.finalTP1, rMultiple: 1.0, source: decision.rulesApplied.tpMode },
        { price: decision.finalTP2, rMultiple: 2.0, source: decision.rulesApplied.tpMode },
        { price: decision.finalTP3, rMultiple: 3.0, source: decision.rulesApplied.tpMode },
      ].filter((t) => t.price != null),
      riskDollars: Math.abs(entry - finalSL) * (assetMeta.dollarPerPipPerLot / assetMeta.pipSize) * finalLot,
      brokerOrderId: placement.orderId, template: p.template,
    });
  } catch (e) { telegramResult = { sent: false, error: e.message }; }

  return res.status(200).json({
    ok: true, executed: true, mode: 'auto',
    brokerOrderId: placement.orderId,
    assetId, brokerSymbol, direction: p.direction,
    lot: finalLot, entry, sl: finalSL,
    tp1: decision.finalTP1, tp2: decision.finalTP2, tp3: decision.finalTP3,
    pineSuggested: { sl, tp1, tp2, tp3 },
    activeMode: decision.activeMode,
    rulesApplied: decision.rulesApplied,
    template: p.template,
    telegram: telegramResult,
    durationMs: Date.now() - t0,
  });
};

module.exports.parseDualFormat = parseDualFormat;