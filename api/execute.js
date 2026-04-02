/* eslint-disable */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
  const { instrument, direction } = req.body || {};

  if (!TOKEN || !ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars' });

  const symbolMap = { 'BTCUSDT': 'BTCUSD', 'XAUUSD': 'XAUUSD', 'GBPUSD': 'GBPUSD' };
  const symbol = symbolMap[instrument] || instrument;
  const actionType = direction === 'LONG' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';

  try {
    const r = await fetch(
      `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${ACCOUNT_ID}/trade`,
      {
        method: 'POST',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType, symbol, volume: 0.01, comment: 'QuantumBot' })
      }
    );
    const data = await r.json();
    return res.status(200).json({ success: true, data });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};