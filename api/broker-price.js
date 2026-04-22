/* eslint-disable */
// api/broker-price.js -- V9.3 dynamic symbol resolution + multi-region fallback
// Tries London -> New York -> Singapore MetaAPI regions.
// Caches both the working symbol AND the working region in Redis, so subsequent
// calls skip the probing step and go straight to the right endpoint.

const { Redis } = require('@upstash/redis');

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

// MetaAPI trading region endpoints (same base as execute.js, different service path)
const REGIONS = [
  'https://mt-client-api-v1.london.agiliumtrade.ai',
  'https://mt-client-api-v1.new-york.agiliumtrade.ai',
  'https://mt-client-api-v1.singapore.agiliumtrade.ai',
];

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

  let redis = null;
  let cachedRegion = null;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const cached = safe(await redis.get('v9:sym:' + baseSym).catch(() => null));
      if (cached && typeof cached === 'string') candidates.push(cached);
      // NOTE: broker-candles and broker-price use different services, so they may
      // have different working regions. We use v9:region_price for this endpoint.
      cachedRegion = safe(await redis.get('v9:region_price').catch(() => null));
    }
  } catch (_) {}

  if (rawSymbol !== baseSym && !candidates.includes(rawSymbol)) candidates.unshift(rawSymbol);
  for (const s of [baseSym + '.s', baseSym + '.pro', baseSym + '.S', baseSym + '.PRO', baseSym]) {
    if (!candidates.includes(s)) candidates.push(s);
  }

  const regionOrder = cachedRegion && REGIONS.includes(cachedRegion)
    ? [cachedRegion, ...REGIONS.filter(r => r !== cachedRegion)]
    : REGIONS;

  let lastErr = null;
  let lastStatus = null;
  for (const region of regionOrder) {
    for (const trySym of candidates) {
      try {
        const r = await fetch(
          region + '/users/current/accounts/' + ACCOUNT_ID + '/symbols/' + encodeURIComponent(trySym) + '/current-price',
          { headers: { 'auth-token': TOKEN } }
        );
        lastStatus = r.status;
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          lastErr = (text || 'HTTP ' + r.status).slice(0, 200);
          // 404 = wrong region or unknown symbol. Try next symbol; if all fail, outer loop tries next region.
          if (r.status === 404) { break; } // break symbol loop -> next region
          continue;
        }
        const data = await r.json();
        const bid = Number(data.bid);
        const ask = Number(data.ask);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) { lastErr = 'Invalid price data'; continue; }

        const sample = (bid + ask) / 2;
        let decimals;
        if (sample > 1000) decimals = 2;
        else if (sample > 10) decimals = 3;
        else decimals = 5;
        const mid = parseFloat(((bid + ask) / 2).toFixed(decimals));

        if (redis) {
          try { await redis.set('v9:sym:' + baseSym, JSON.stringify(trySym)); } catch (_) {}
          try { await redis.set('v9:region_price', JSON.stringify(region)); } catch (_) {}
        }
        return res.status(200).json({ price: mid, bid, ask, symbol: trySym, region, source: 'puprime' });
      } catch (e) { lastErr = e.message; }
    }
  }

  console.warn('[BROKER-PRICE] all regions + symbols failed for ' + rawSymbol + ': ' + lastErr);
  return res.status(404).json({ error: lastErr || 'Symbol not found in any region', price: null, tried: candidates, regions: regionOrder, lastStatus });
};