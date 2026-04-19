/* eslint-disable */
// api/broker-price.js -- V9 dynamic symbol resolution
// Tries the symbol as-typed first, then .s, .pro, then bare. Caches working suffix in Redis.

const { Redis } = require('@upstash/redis');

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', price: null });

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
  if (!TOKEN || !ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars', price: null });

  const rawSymbol = String((req.query && req.query.symbol) || '').trim();
  if (!rawSymbol) return res.status(400).json({ error: 'Missing symbol', price: null });

  const baseSym = rawSymbol.toUpperCase().replace('.S', '').replace('.PRO', '').trim();
  const candidates = [];

  // Redis cache: which suffix worked last time for this symbol
  let redis = null;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const cached = safe(await redis.get('v9:sym:' + baseSym).catch(() => null));
      if (cached && typeof cached === 'string') candidates.push(cached);
    }
  } catch (_) {}

  // Prefer exact user input first
  if (rawSymbol !== baseSym && !candidates.includes(rawSymbol)) candidates.unshift(rawSymbol);
  // Fallbacks
  for (const s of [baseSym + '.s', baseSym + '.pro', baseSym + '.S', baseSym + '.PRO', baseSym]) {
    if (!candidates.includes(s)) candidates.push(s);
  }

  let lastErr = null;
  for (const trySym of candidates) {
    try {
      const r = await fetch(
        'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/symbols/' + encodeURIComponent(trySym) + '/current-price',
        { headers: { 'auth-token': TOKEN } }
      );
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        lastErr = (text || 'HTTP ' + r.status).slice(0, 200);
        // Only retry on symbol-not-found errors
        if (!/symbol|not.?found|invalid|unknown/i.test(lastErr)) break;
        continue;
      }
      const data = await r.json();
      const bid = Number(data.bid);
      const ask = Number(data.ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
        lastErr = 'Invalid price data';
        continue;
      }

      // Decimals: detect from price magnitude
      const sample = (bid + ask) / 2;
      let decimals;
      if (sample > 1000) decimals = 2;
      else if (sample > 10) decimals = 3;
      else decimals = 5;

      const mid = parseFloat(((bid + ask) / 2).toFixed(decimals));

      // Cache the working symbol
      if (redis) { try { await redis.set('v9:sym:' + baseSym, JSON.stringify(trySym)); } catch (_) {} }

      return res.status(200).json({ price: mid, bid, ask, symbol: trySym, source: 'puprime', tried: candidates.indexOf(trySym) + 1 });
    } catch (e) { lastErr = e.message; }
  }

  return res.status(404).json({ error: lastErr || 'Symbol not found on broker', price: null, tried: candidates });
};