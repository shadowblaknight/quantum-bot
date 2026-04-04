/* eslint-disable */
// api/positions.js - Open positions from PU Prime via MetaAPI
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', positions: [] });
  }

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;

  if (!TOKEN || !ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing env vars', positions: [] });
  }

  try {
    const url =
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' +
      ACCOUNT_ID + '/positions';

    const r = await fetch(url, {
      method: 'GET',
      headers: { 'auth-token': TOKEN }
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({
        positions: [],
        error: (text || 'Failed to fetch positions').slice(0, 500)
      });
    }

    const positions = await r.json();

    return res.status(200).json({
      positions: Array.isArray(positions) ? positions : []
    });
  } catch(e) {
    return res.status(500).json({
      positions: [],
      error: e && e.message ? e.message : 'Unknown server error'
    });
  }
};