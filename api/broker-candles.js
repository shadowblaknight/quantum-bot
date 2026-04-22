/* eslint-disable */
// api/broker-candles.js -- V9.3 dynamic symbol resolution + multi-region fallback

const { Redis } = require('@upstash/redis');

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

const REGIONS = [
  'https://mt-market-data-client-api-v1.london.agiliumtrade.ai',
  'https://mt-market-data-client-api-v1.new-york.agiliumtrade.ai',
  'https://mt-market-data-client-api-v1.singapore.agiliumtrade.ai',
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', candles: [] });

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
  if (!TOKEN || !ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars', candles: [] });

  const rawSymbol = String(req.query.symbol || '').trim();
  if (!rawSymbol) return res.status(400).json({ error: 'Missing symbol', candles: [] });

  const rawTf = String(req.query.timeframe || 'M1').toUpperCase();
  const rawLimit = parseInt(req.query.limit || '200', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 200;

  const timeframeMap = {
    M1:'1m',M2:'2m',M3:'3m',M4:'4m',M5:'5m',M6:'6m',M10:'10m',M12:'12m',M15:'15m',M20:'20m',
    M30:'30m',H1:'1h',H2:'2h',H3:'3h',H4:'4h',H6:'6h',H8:'8h',H12:'12h',D1:'1d',W1:'1w',MN1:'1mn',
  };
  const timeframe = timeframeMap[rawTf] || '1m';

  const baseSym = rawSymbol.toUpperCase().replace('.S', '').replace('.PRO', '').trim();
  const candidates = [];

  let redis = null;
  let cachedRegion = null;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const cached = safe(await redis.get('v9:sym:' + baseSym).catch(() => null));
      if (cached && typeof cached === 'string') candidates.push(cached);
      cachedRegion = safe(await redis.get('v9:region').catch(() => null));
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
        const url = region + '/users/current/accounts/' + ACCOUNT_ID +
          '/historical-market-data/symbols/' + encodeURIComponent(trySym) +
          '/timeframes/' + encodeURIComponent(timeframe) + '/candles?limit=' + limit;

        const r = await fetch(url, { method: 'GET', headers: { 'auth-token': TOKEN } });
        lastStatus = r.status;
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          lastErr = (text || 'HTTP ' + r.status).slice(0, 200);
          if (r.status === 404) break; // wrong region/account, try next region
          continue;
        }
        const data = await r.json();
        const raw = Array.isArray(data) ? data : ((data && (data.candles || data.history)) || []);
        const candles = raw
          .map((c) => ({
            time: c.time || c.brokerTime || c.openTime || null,
            open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
            volume: Number(c.tickVolume || c.volume || 0),
          }))
          .filter((c) => c.time && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
          .sort((a, b) => new Date(a.time) - new Date(b.time));

        if (redis && candles.length > 0) {
          try { await redis.set('v9:sym:' + baseSym, JSON.stringify(trySym)); } catch (_) {}
          try { await redis.set('v9:region', JSON.stringify(region)); } catch (_) {}
        }
        return res.status(200).json({ candles, count: candles.length, symbol: trySym, timeframe, region, source: 'puprime' });
      } catch (e) { lastErr = e.message; }
    }
  }

  console.warn('[BROKER-CANDLES] all regions + symbols failed for ' + rawSymbol + ': ' + lastErr);
  return res.status(404).json({ error: lastErr || 'Symbol not found in any region', candles: [], tried: candidates, regions: regionOrder, lastStatus });
};