/* eslint-disable */
// api/broker-price.js - Real-time price from PU Prime via MetaAPI
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

  const rawSymbol = String((req.query && req.query.symbol) || '').trim();
  const symbolMap = {
    BTCUSD: 'BTCUSD',
    GBPUSD: 'GBPUSD.s',
    XAUUSD: 'XAUUSD.s',
    'XAUUSD.S': 'XAUUSD.s',
    'GBPUSD.S': 'GBPUSD.s'
  };
  const symbol = symbolMap[rawSymbol] || symbolMap[rawSymbol.toUpperCase()];
  const allowed = ['BTCUSD', 'XAUUSD.s', 'GBPUSD.s'];

  if (!symbol || !allowed.includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol. Use BTCUSD, XAUUSD.s, or GBPUSD.s', price: null });
  }

  try {
    const r = await fetch(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/symbols/' + symbol + '/current-price',
      { headers: { 'auth-token': TOKEN } }
    );

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text || 'Failed to fetch price', price: null });
    }

    const data = await r.json();
    const bid = Number(data.bid);
    const ask = Number(data.ask);

    if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
      return res.status(502).json({ error: 'Invalid price data from broker', price: null });
    }

    const decimals =
      symbol === 'GBPUSD.s' ? 5 :
      symbol === 'XAUUSD.s' ? 2 :
      symbol === 'BTCUSD' ? 2 :
      5;
    const mid = parseFloat(((bid + ask) / 2).toFixed(decimals));

    return res.status(200).json({ price: mid, bid: bid, ask: ask, symbol: symbol, source: 'puprime' });

  } catch (e) {
    return res.status(503).json({ error: e.message || 'Broker price unavailable', price: null });
  }
};