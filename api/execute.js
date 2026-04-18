/* eslint-disable */
// api/execute.js -- Quantum Bot V9
// Executes market orders with broker-symbol awareness (auto-tries .s and .pro suffixes).
// Remembers which suffix worked per symbol via Redis cache.

const { Redis } = require('@upstash/redis');

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + (process.env.METAAPI_ACCOUNT_ID || '');
const HEADERS = { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN || '' };

const getMaxLot = (sym) => {
  const s = (sym || '').toUpperCase();
  if (s.includes('BTC') || s.includes('ETH')) return 0.30;
  if (s.includes('XAU') || s.includes('GOLD')) return 0.50;
  return 2.00;
};

const getMinSLDist = (sym, price) => {
  const s = (sym || '').toUpperCase();
  if (s.includes('BTC') || s.includes('ETH')) return 50;
  if (s.includes('XAU') || s.includes('GOLD')) return 3;
  if (price && price > 100) return 0.5;
  return 0.0002;
};

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.METAAPI_TOKEN || !process.env.METAAPI_ACCOUNT_ID) return res.status(500).json({ error: 'Missing MetaAPI env vars' });

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const { instrument, direction, entry, stopLoss, takeProfit, volume, comment, todayPnl, lossStreak, riskPaused } = body;
  if (!instrument) return res.status(400).json({ error: 'Missing instrument' });
  if (!['LONG', 'SHORT'].includes(direction)) return res.status(400).json({ error: 'direction must be LONG or SHORT' });
  if (!stopLoss) return res.status(400).json({ error: 'Missing stopLoss' });
  if (!volume || volume <= 0) return res.status(400).json({ error: 'Missing or invalid volume' });

  if (riskPaused) return res.status(200).json({ success: false, blocked: true, reason: 'riskPaused active' });
  if (typeof lossStreak === 'number' && lossStreak >= 5) return res.status(200).json({ success: false, blocked: true, reason: 'lossStreak >= 5' });

  const maxLot = getMaxLot(instrument);
  const safeVol = Math.max(0.01, Math.min(maxLot, Math.round(volume / 0.01) * 0.01));
  const entryPrice = entry || 0;
  const minSL = getMinSLDist(instrument, entryPrice);
  const slDist = Math.abs(entryPrice - stopLoss);
  if (entryPrice > 0 && slDist < minSL) return res.status(200).json({ success: false, blocked: true, reason: 'SL distance ' + slDist.toFixed(5) + ' < min ' + minSL });

  // ---- Broker symbol resolution ----
  // Try cached suffix first; if it fails, try .s, .pro, then bare symbol.
  const baseSym = instrument.toUpperCase().replace('.S', '').replace('.PRO', '').trim();
  const candidates = [];

  let redis = null;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const cached = safe(await redis.get('v9:sym:' + baseSym).catch(() => null));
      if (cached && typeof cached === 'string') candidates.push(cached);
    }
  } catch (_) {}

  // If user typed an exact suffix, prefer that first
  if (instrument !== baseSym && !candidates.includes(instrument)) candidates.unshift(instrument);
  // Then add fallbacks
  for (const s of [baseSym + '.s', baseSym + '.pro', baseSym + '.S', baseSym + '.PRO', baseSym]) {
    if (!candidates.includes(s)) candidates.push(s);
  }

  const orderType = direction === 'LONG' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
  let lastErr = null;
  let success = null;

  for (const trySym of candidates) {
    const orderBody = {
      actionType: orderType,
      symbol:     trySym,
      volume:     safeVol,
      stopLoss:   parseFloat(stopLoss.toFixed(stopLoss > 100 ? 2 : 5)),
      comment:    (comment || 'QB:V9').slice(0, 32),
    };
    if (takeProfit) orderBody.takeProfit = parseFloat(takeProfit.toFixed(takeProfit > 100 ? 2 : 5));

    try {
      const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify(orderBody) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && !d.error && (d.orderId || d.positionId)) {
        success = { d, trySym };
        // Cache the working symbol for next time
        if (redis) { try { await redis.set('v9:sym:' + baseSym, JSON.stringify(trySym)); } catch (_) {} }
        break;
      }
      lastErr = d.message || d.error || ('HTTP ' + r.status);
      // Only retry on symbol-not-found-style errors; bail on other errors
      const looksLikeSymbolErr = (lastErr || '').toLowerCase().match(/symbol|not.?found|invalid.?symbol|unknown/);
      if (!looksLikeSymbolErr) break;
    } catch (e) { lastErr = e.message; break; }
  }

  if (!success) {
    console.error('execute failed all candidates:', lastErr, 'tried:', candidates);
    return res.status(200).json({ success: false, error: lastErr || 'All symbol candidates failed', tried: candidates });
  }

  const { d, trySym } = success;
  console.log('execute OK:', trySym, direction, safeVol + 'L', 'orderId=' + d.orderId);
  return res.status(200).json({
    success:    true,
    orderId:    d.orderId || null,
    positionId: d.positionId || null,
    instrument: trySym,
    direction,
    volume:     safeVol,
    stopLoss,
    takeProfit: takeProfit || null,
    comment:    (comment || 'QB:V9').slice(0, 32),
  });
};