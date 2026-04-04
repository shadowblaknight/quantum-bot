/* eslint-disable */
// api/broker-candles.js
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', candles: [] });
  }

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;

  if (!TOKEN || !ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing env vars', candles: [] });
  }

  const symbol = String(req.query.symbol || 'BTCUSD').toUpperCase();
  const rawTf = String(req.query.timeframe || 'M1').toUpperCase();
  var rawLimit = parseInt(req.query.limit || '200', 10);
  var limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 200;

  const timeframeMap = {
    M1: '1m', M2: '2m', M3: '3m', M4: '4m', M5: '5m',
    M6: '6m', M10: '10m', M12: '12m', M15: '15m', M20: '20m',
    M30: '30m', H1: '1h', H2: '2h', H3: '3h', H4: '4h',
    H6: '6h', H8: '8h', H12: '12h', D1: '1d', W1: '1w', MN1: '1mn'
  };

  const allowed = ['BTCUSD', 'XAUUSD', 'GBPUSD'];
  if (!allowed.includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol', candles: [] });
  }

  const timeframe = timeframeMap[rawTf] || '1m';

  try {
    const url =
      'https://mt-market-data-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' +
      ACCOUNT_ID +
      '/historical-market-data/symbols/' +
      encodeURIComponent(symbol) +
      '/timeframes/' +
      encodeURIComponent(timeframe) +
      '/candles?limit=' + limit;

    const r = await fetch(url, {
      method: 'GET',
      headers: { 'auth-token': TOKEN }
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({
        error: (text || 'Failed to fetch candles').slice(0, 500),
        candles: []
      });
    }

    const data = await r.json();
    const raw = Array.isArray(data) ? data : ((data && (data.candles || data.history)) || []);

    // Normalize and validate candles
    const candles = raw
      .map(function(c) {
        return {
          time:   c.time || c.brokerTime || c.openTime || null,
          open:   Number(c.open),
          high:   Number(c.high),
          low:    Number(c.low),
          close:  Number(c.close),
          volume: Number(c.tickVolume || c.volume || 0)
        };
      })
      .filter(function(c) {
        return c.time &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close);
      })
      .sort(function(a, b) {
        return new Date(a.time) - new Date(b.time);
      });

    return res.status(200).json({
      candles: candles,
      count: candles.length,
      symbol: symbol,
      timeframe: timeframe,
      source: 'puprime'
    });

  } catch(e) {
    return res.status(500).json({
      error: e && e.message ? e.message : 'Unknown server error',
      candles: []
    });
  }
};