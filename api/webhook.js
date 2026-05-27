/* eslint-disable */
// V13 — api/webhook.js
//
// Receives TradingView alerts from the Pine "Quantum Bot ICT Narrative Engine" v2.0+.
// Replaces V12's entire detection pipeline. Pine does detection on TradingView,
// this endpoint just executes the signal on MetaAPI.
//
// EXPECTED REQUEST BODY (text/plain or application/json):
//   Dual-format alert string:
//     🟢 XAUUSD · BUY SIGNAL · 5
//     Entry zone: 2384.30 - 2384.70
//     Why: Kill zone setup · LONDON
//     ---
//     {"version":"2.0","template":"silver-bullet","direction":"LONG", ... }
//
// We parse everything AFTER the `---` delimiter as JSON.
//
// SAFETY:
//   1. QB_TRADING_ENABLED must be 'true' (matches V12 contract)
//   2. apiKey in payload must match WEBHOOK_API_KEY env (rejects unsigned hits)
//   3. Idempotency via Redis (apiKey+symbol+timestamp dedupe)
//   4. Won't open a new position if one already exists on that asset
// ----------------------------------------------------------------------------

const { getRedis, applyCors } = require('./_lib');
const { resolveSymbol } = require('./symbol-resolver');
const { suggestLot } = require('./sizing-engine');
const { fetchAccount, fetchPositions } = require('./broker');
const { placeLimitOrder } = require('./execute');
const { notifyTradePlaced, sendOnce } = require('./telegram');

// ===== Pine ticker → V12 asset id =====
const PINE_TO_ASSET = {
  XAUUSD: 'gold',
  EURUSD: 'eurusd',
  GBPUSD: 'gbpusd',
  USDJPY: 'usdjpy',
  NAS100: 'nas100',
  SP500:  'us500',
  US500:  'us500',
  BTCUSD: 'btc',
  BTCUSDT: 'btc',
};

const DEDUPE_PREFIX = 'v13:webhook:dedupe:';
const DEDUPE_TTL = 60 * 60; // 1 hour — covers the signal expiry window

function isTradingEnabled() {
  return process.env.QB_TRADING_ENABLED === 'true';
}

// ===== Parse the dual-format body — readable header + "---" + JSON =====
function parseDualFormat(body) {
  if (!body) return { ok: false, error: 'empty body' };

  // If Vercel auto-parsed it as JSON object (unlikely but possible), pass through
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return { ok: true, payload: body };
  }

  // Coerce to string
  const text = typeof body === 'string' ? body : String(body);

  // Find the delimiter. Pine emits "\n---\n". Be tolerant of whitespace variants.
  const delimIdx = text.indexOf('\n---');
  if (delimIdx < 0) {
    // No delimiter — try parsing the whole body as JSON (Tier 2 direct-JSON mode)
    try {
      return { ok: true, payload: JSON.parse(text.trim()) };
    } catch (_) {
      return { ok: false, error: 'no --- delimiter and body is not JSON' };
    }
  }

  // Take everything after the delimiter, trim, JSON.parse
  const jsonPart = text.slice(delimIdx + 4).trim();
  try {
    return { ok: true, payload: JSON.parse(jsonPart) };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e.message}` };
  }
}

// ===== Idempotency: same apiKey+symbol+template+timestamp = same signal =====
async function alreadyExecuted(dedupeKey) {
  if (!dedupeKey) return false;
  const r = getRedis();
  if (!r) return false;
  try {
    const seen = await r.get(DEDUPE_PREFIX + dedupeKey);
    return seen != null;
  } catch (_) {
    return false;
  }
}

async function markExecuted(dedupeKey, info) {
  const r = getRedis();
  if (!r || !dedupeKey) return;
  try {
    await r.set(DEDUPE_PREFIX + dedupeKey, JSON.stringify(info), { ex: DEDUPE_TTL });
  } catch (_) {}
}

// ===== Main handler =====
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  // Only POST is valid for webhooks
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  }

  const t0 = Date.now();

  // ── 1. Parse body ──────────────────────────────────────────────────
  const parsed = parseDualFormat(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: parsed.error });
  }
  const p = parsed.payload;

  // ── 2. Validate auth ───────────────────────────────────────────────
  const expectedKey = process.env.WEBHOOK_API_KEY || '';
  if (!expectedKey) {
    return res.status(500).json({ ok: false, error: 'server-misconfigured (WEBHOOK_API_KEY not set)' });
  }
  if (p.apiKey !== expectedKey) {
    return res.status(401).json({ ok: false, error: 'invalid-api-key' });
  }

  // ── 3. Trading enabled? ────────────────────────────────────────────
  if (!isTradingEnabled()) {
    return res.status(200).json({
      ok: true,
      executed: false,
      reason: 'trading-disabled (QB_TRADING_ENABLED != true)',
      payload: { template: p.template, direction: p.direction, symbol: p.symbol },
    });
  }

  // ── 4. Resolve Pine ticker → V12 asset id ──────────────────────────
  // Pine sends syminfo.tickerid which can include exchange prefix (e.g. "OANDA:XAUUSD"
  // or "VANTAGE:NAS100"). Strip the prefix before mapping.
  const rawSymbol = (p.symbol || '').toUpperCase();
  const colonIdx = rawSymbol.lastIndexOf(':');
  const pineTicker = (colonIdx >= 0 ? rawSymbol.slice(colonIdx + 1) : rawSymbol).replace(/[^A-Z0-9]/g, '');
  const assetId = PINE_TO_ASSET[pineTicker];
  if (!assetId) {
    return res.status(400).json({ ok: false, error: `unknown symbol: ${p.symbol} (extracted: ${pineTicker})` });
  }

  // ── 5. Dedupe ──────────────────────────────────────────────────────
  const dedupeKey = `${assetId}:${p.template}:${p.direction}:${p.timestamp}`;
  if (await alreadyExecuted(dedupeKey)) {
    return res.status(200).json({
      ok: true,
      executed: false,
      reason: 'duplicate-signal (already executed)',
      dedupeKey,
    });
  }

  // ── 6. Position already open? ──────────────────────────────────────
  const positions = await fetchPositions().catch(() => []);
  const existing = (Array.isArray(positions) ? positions : []).find((pos) => {
    return (pos.assetId === assetId) ||
           (pos.symbol && pineTicker && pos.symbol.toUpperCase().includes(pineTicker));
  });
  if (existing) {
    return res.status(200).json({
      ok: true,
      executed: false,
      reason: 'position-already-open',
      positionTicket: existing.id,
    });
  }

  // ── 7. Resolve broker symbol (e.g. 'gold' → 'XAUUSD.s') ────────────
  const brokerSymbol = await resolveSymbol(assetId);
  if (!brokerSymbol) {
    return res.status(500).json({ ok: false, error: `cannot resolve broker symbol for ${assetId}` });
  }

  // ── 8. Parse numerics from Pine payload ────────────────────────────
  const entry = parseFloat(p.entry);
  const sl    = parseFloat(p.sl);
  const tp1   = parseFloat(p.tp1);
  const tp2   = parseFloat(p.tp2);
  const tp3   = parseFloat(p.tp3);

  if (!isFinite(entry) || !isFinite(sl) || !isFinite(tp1)) {
    return res.status(400).json({ ok: false, error: 'invalid entry/sl/tp1 in payload' });
  }

  // ── 9. Compute lot size for THIS user (single-tenant in V13) ──────
  const account = await fetchAccount().catch(() => null);
  const capital = (account && (account.balance || account.equity)) || 10000;
  const riskPercent = parseFloat(process.env.QB_RISK_PERCENT || '0.01'); // 1% default

  const slDistance = Math.abs(entry - sl);
  const sizing = suggestLot({ assetId, slDistance, capital, riskPercent });
  if (sizing.error) {
    return res.status(500).json({ ok: false, error: `sizing failed: ${sizing.error}` });
  }
  const lot = sizing.suggestedLot;
  const riskDollars = sizing.riskDollars;

  // ── 10. Place the limit order ──────────────────────────────────────
  const comment = `QB-V13-${p.template}-${(p.window || p.swept || '').slice(0, 12)}`.slice(0, 64);
  const placement = await placeLimitOrder(
    brokerSymbol,
    p.direction,
    lot,
    entry,
    sl,
    tp1,                 // first TP — manage-trades.js will handle TP2/TP3 partials
    comment
  );

  if (!placement.ok) {
    // Notify failure via Telegram (best-effort, non-blocking)
    sendOnce(`webhook-fail:${dedupeKey}`,
      `⚠️ <b>Webhook order rejected — ${pineTicker}</b>\n\n` +
      `Template: ${p.template}\n` +
      `Direction: ${p.direction}\n` +
      `Error: <code>${placement.error?.slice(0, 200) || 'unknown'}</code>`
    ).catch(() => {});
    return res.status(500).json({ ok: false, error: placement.error, dedupeKey });
  }

 // ── 11. Mark executed (dedupe) ─────────────────────────────────────
  await markExecuted(dedupeKey, {
    brokerOrderId: placement.orderId,
    template: p.template,
    placedAt: Date.now(),
  });

  // ── 11b. Write pending-setup record so manage-trades can manage it ─
  // manage-trades.js looks up pending records in `v12:watcher:{asset}:pending`
  // to know TPs, sizing, and to feed recognition memory on close.
  // The schema mirrors V12's coherence-checker output so the existing
  // management logic (partial closes, BE moves, trailing, KNN feed) works
  // unchanged on V13-placed positions.
  try {
    const { addPendingSetup } = require('./watcher');
    const pendingRecord = {
      id: `setup_${assetId}_v13_${p.timestamp}_${Date.now()}`,
      asset: assetId,
      setup: {
        direction: p.direction,
        mode: 'DAY',
        session: p.window || (p.swept ? `swept ${p.swept}` : 'unknown'),
        contributingTactics: [p.template],
        timeframesInPlay: [p.timeframe],
        slDistance: Math.abs(entry - sl),
        slDistanceATR: parseFloat(p.impulseATR) || null,
        entry,
        sl,
        targets: [
          { price: tp1, rMultiple: 1.0 },
          { price: tp2, rMultiple: 2.0 },
          { price: tp3, rMultiple: 3.0 },
        ],
        template: p.template,
      },
      recognition: { advice: 'neutral', matchCount: 0, wins: 0, losses: 0, confidence: 'none' },
      sizing: { baseLot: lot, recommendedLot: lot, baseRisk: riskDollars },
      plannedEntry: entry,
      slPrice: sl,
      tpLevels: [
        { price: tp1, rMultiple: 1.0, source: 'Pine TP1' },
        { price: tp2, rMultiple: 2.0, source: 'Pine TP2' },
        { price: tp3, rMultiple: 3.0, source: 'Pine TP3' },
      ],
      newsFeature: { newsState: 'none', highImpactWithin60min: false },
      createdAt: Date.now(),
      expiresAt: Date.now() + 4 * 60 * 60 * 1000, // 4 hours
      status: 'placed',
      brokerOrderId: placement.orderId,
      comment,
      positionId: null,
      v13: true,
    };
    await addPendingSetup(assetId, pendingRecord);
    console.log('[webhook] pending setup written for manage-trades:', pendingRecord.id);
  } catch (e) {
    // Non-fatal — order is at broker, but manage-trades won't manage it for partials.
    console.error('[webhook] pending setup write failed:', e.message);
  }

  // ── 12. Telegram confirmation (uses V12 formatter) ─────────────────
  // CRITICAL: await this. Vercel serverless functions terminate when the
  // response is sent — fire-and-forget Telegram calls get killed mid-fetch.
  let telegramResult;
  try {
    telegramResult = await notifyTradePlaced({
      asset: assetId,
      direction: p.direction,
      lot,
      entry,
      sl,
      tpLevels: [
        { price: tp1, rMultiple: 1.0, source: 'Pine TP1' },
        { price: tp2, rMultiple: 2.0, source: 'Pine TP2' },
        { price: tp3, rMultiple: 3.0, source: 'Pine TP3' },
      ],
      riskDollars,
      brokerOrderId: placement.orderId,
    });
    console.log('[webhook] telegram result:', JSON.stringify(telegramResult));
  } catch (e) {
    console.error('[webhook] telegram notify failed:', e.message);
    telegramResult = { sent: false, error: e.message };
  }

  // ── 13. Done ───────────────────────────────────────────────────────
  return res.status(200).json({
    ok: true,
    executed: true,
    brokerOrderId: placement.orderId,
    assetId,
    brokerSymbol,
    direction: p.direction,
    lot,
    entry,
    sl,
    tp1, tp2, tp3,
    riskDollars,
    template: p.template,
    telegram: telegramResult,
    durationMs: Date.now() - t0,
  });
};

module.exports.parseDualFormat = parseDualFormat;