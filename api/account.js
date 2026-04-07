/* eslint-disable */
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

  try {
    const response = await fetch(
      `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${ACCOUNT_ID}/account-information`,
      {
        method: 'GET',
        headers: {
          'auth-token': TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return res.status(response.status).json({
        error: 'Failed to fetch account information',
        detail: text || response.statusText
      });
    }

    const data = await response.json();

    const balance = Number(data.balance);
    const equity = Number(data.equity);
    const freeMargin = Number(data.freeMargin ?? data.margin_free);
    const margin = Number(data.margin);

    return res.status(200).json({
      success: true,
      balance: Number.isFinite(balance) ? balance : null,
      equity: Number.isFinite(equity) ? equity : null,
      freeMargin: Number.isFinite(freeMargin) ? freeMargin : null,
      margin: Number.isFinite(margin) ? margin : null,
      currency: data.currency || null,
      platform: data.platform || null,
      raw: data
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Account fetch failed',
      detail: error.message || 'Unknown error'
    });
  }
};