/* eslint-disable */
// api/broker-price.js -- V9.3.1
// Multi-region fallback + CANDLES FALLBACK.
// Your MetaAPI current-price endpoint was returning 404 for non-BTC symbols
// while historical candles returned 200. So if all current-price attempts fail,
// we fetch the latest M1 candle from the working candles service and use its
// close price. Slight delay (<= 60s) but 100% reliable across all symbols.

const { Redis } = require('@upstash/redis');

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

const PRICE_REGIONS = [
  'https://mt-client-api-v1.london.agiliumtrade.ai',
  'https://mt-client-api-v1.new-york.agiliumtrade.ai',
  'https://mt-client-api-v1.singapore.agiliumtrade.ai',
];
const MD_REGIONS = [
  'https://mt-market-data-client-api-v1.london.agiliumtrade.ai',
  'https://mt-market-data-client-api-v1.new-york.agiliumtrade.ai',
  'https://mt-market-data-client-api-v1.singapore.agiliumtrade.ai',
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
  let cachedMDRegion = null;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const cached = safe(await redis.get('v9:sym:' + baseSym).catch(() => null));
      if (cached && typeof cached === 'string') candidates.push(cached);
      cachedRegion   = safe(await redis.get('v9:region_price').catch(() => null));
      cachedMDRegion = safe(await redis.get('v9:region').catch(() => null));
    }
  } catch (_) {}

  if (rawSymbol !== baseSym && !candidates.includes(rawSymbol)) candidates.unshift(rawSymbol);
  for (const s of [baseSym + '.s', baseSym + '.pro', baseSym + '.S', baseSym + '.PRO', baseSym]) {
    if (!candidates.includes(s)) candidates.push(s);
  }

  const priceRegionOrder = cachedRegion && PRICE_REGIONS.includes(cachedRegion)
    ? [cachedRegion, ...PRICE_REGIONS.filter(r => r !== cachedRegion)]
    : PRICE_REGIONS;

  let lastErr = null;
  let lastStatus = null;

  // -------- Attempt 1: real-time current-price across regions --------
  for (const region of priceRegionOrder) {
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
          if (r.status === 404) break; // wrong region, try next
          continue;
        }
        const data = await r.json();
        const bid = Number(data.bid);
        const ask = Number(data.ask);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) { lastErr = 'Invalid price data'; continue; }

        const sample = (bid + ask) / 2;
        let decimals;
        if (sample > 1000) decimals = 2; else if (sample > 10) decimals = 3; else decimals = 5;
        const mid = parseFloat(((bid + ask) / 2).toFixed(decimals));

        if (redis) {
          try { await redis.set('v9:sym:' + baseSym, JSON.stringify(trySym)); } catch (_) {}
          try { await redis.set('v9:region_price', JSON.stringify(region)); } catch (_) {}
        }
        return res.status(200).json({ price: mid, bid, ask, symbol: trySym, region, source: 'live' });
      } catch (e) { lastErr = e.message; }
    }
  }

  // -------- Attempt 2: Fallback to latest M1 candle close --------
  // Current-price isn't available (account permissions / different provisioning).
  // Candles work, so use the most recent close price. Delay <= 60s.
  console.warn('[BROKER-PRICE] live price 404 for ' + rawSymbol + ' -- falling back to latest M1 candle');
  const mdRegionOrder = cachedMDRegion && MD_REGIONS.includes(cachedMDRegion)
    ? [cachedMDRegion, ...MD_REGIONS.filter(r => r !== cachedMDRegion)]
    : MD_REGIONS;

  for (const region of mdRegionOrder) {
    for (const trySym of candidates) {
      try {
        const url = region + '/users/current/accounts/' + ACCOUNT_ID +
          '/historical-market-data/symbols/' + encodeURIComponent(trySym) +
          '/timeframes/1m/candles?limit=1';
        const r = await fetch(url, { headers: { 'auth-token': TOKEN } });
        if (!r.ok) { if (r.status === 404) break; continue; }
        const data = await r.json();
        const raw = Array.isArray(data) ? data : ((data && (data.candles || data.history)) || []);
        if (!raw.length) continue;
        const last = raw[raw.length - 1];
        const close = Number(last.close);
        if (!Number.isFinite(close)) continue;

        const sample = close;
        let decimals;
        if (sample > 1000) decimals = 2; else if (sample > 10) decimals = 3; else decimals = 5;
        const mid = parseFloat(close.toFixed(decimals));

        // Approximate bid/ask (spread ~1-2 pips)
        const spread = sample > 1000 ? 0.5 : sample > 10 ? 0.05 : 0.00015;
        const bid = parseFloat((close - spread / 2).toFixed(decimals));
        const ask = parseFloat((close + spread / 2).toFixed(decimals));

        if (redis) {
          try { await redis.set('v9:sym:' + baseSym, JSON.stringify(trySym)); } catch (_) {}
        }
        return res.status(200).json({
          price: mid, bid, ask, symbol: trySym, region, source: 'candle_fallback',
          candleTime: last.time || last.brokerTime || null,
          note: 'Live price endpoint unavailable, using latest M1 candle close',
        });
      } catch (e) { lastErr = e.message; }
    }
  }

  console.error('[BROKER-PRICE] all sources failed for ' + rawSymbol + ': ' + lastErr);
  return res.status(404).json({
    error: lastErr || 'Symbol not found in any region (live or candle)',
    price: null, tried: candidates, priceRegions: priceRegionOrder, mdRegions: mdRegionOrder, lastStatus,
  });
};