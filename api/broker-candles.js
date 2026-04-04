/* eslint-disable */
// api/broker-candles.js - OHLCV candles from PU Prime via MetaAPI
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;

  if (!TOKEN || !ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const allowed = ['BTCUSD', 'XAUUSD', 'GBPUSD'];
  const allowedTF = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

  const symbol = req.query && req.query.symbol;
  const timeframe = (req.query && req.query.timeframe) || 'M1';

  // Safe limit parsing
  var rawLimit = parseInt((req.query && req.query.limit) || '200', 10);
  var limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 200;

  if (!symbol || !allowed.includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol. Use BTCUSD, XAUUSD, or GBPUSD' });
  }

  if (!allowedTF.includes(timeframe)) {
    return res.status(400).json({ error: 'Invalid timeframe. Use M1, M5, M15, M30, H1, H4, D1' });
  }

  try {
    var url = 'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' +
      ACCOUNT_ID + '/historical-market-data/symbols/' + symbol +
      '/timeframes/' + timeframe + '/candles?limit=' + limit;

    var r = await fetch(url, { headers: { 'auth-token': TOKEN } });

    if (!r.ok) {
      var text = await r.text();
      return res.status(r.status).json({
        error: text || 'Failed to fetch candles',
        candles: []
      });
    }

    var data = await r.json();
    var raw = Array.isArray(data) ? data : (data.candles || data.history || []);

    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(502).json({ error: 'No candle data returned', candles: [] });
    }

    var normalized = raw
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

    if (normalized.length === 0) {
      return res.status(502).json({
        error: 'No valid candle data after normalization',
        candles: []
      });
    }

    return res.status(200).json({
      candles: normalized,
      count: normalized.length,
      symbol: symbol,
      timeframe: timeframe,
      source: 'puprime'
    });

  } catch (e) {
    return res.status(503).json({
      error: e.message || 'Broker candles unavailable',
      candles: []
    });
  }
};