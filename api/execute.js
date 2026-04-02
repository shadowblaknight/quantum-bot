/* eslint-disable */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { instrument, direction, entry, stopLossPips } = req.body;
  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;

  try {
    // Get account info (balance for lot sizing)
    const accRes = await fetch(
      `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${ACCOUNT_ID}/account-information`,
      { headers: { 'auth-token': TOKEN } }
    );
    const accData = await accRes.json();
    const balance = accData.balance || 10000;

    // Risk-based lot sizing (1% of balance)
    const riskAmount = balance * 0.01;
    const sl = stopLossPips || 50;
    const pipValue = instrument === 'XAUUSD' ? 1 : instrument === 'BTCUSDT' ? 1 : 10;
    let lotSize = parseFloat((riskAmount / (sl * pipValue)).toFixed(2));
    lotSize = Math.max(0.01, Math.min(lotSize, 1.0)); // min 0.01, max 1.0

    // Map instrument to broker symbol
    const symbolMap = {
      'BTCUSDT': 'BTCUSD',
      'XAUUSD': 'XAUUSD',
      'GBPUSD': 'GBPUSD'
    };
    const symbol = symbolMap[instrument] || instrument;

    // Place the order
    const orderRes = await fetch(
      `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${ACCOUNT_ID}/trade`,
      {
        method: 'POST',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'ORDER_TYPE_BUY' ,
          symbol,
          volume: lotSize,
          comment: `QuantumBot ${direction} ${instrument}`
        })
      }
    );
    const orderData = await orderRes.json();
    return res.status(200).json({ success: true, order: orderData, lotSize, balance });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};