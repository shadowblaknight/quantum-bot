/* eslint-disable */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
  if (!TOKEN || !ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars' });

  var body = req.body || {};
  var instrument = body.instrument;
  var direction = body.direction;
  var stopLoss = body.stopLoss;
  var takeProfit = body.takeProfit;
  var entry = body.entry;

  var allowedInstruments = { BTCUSDT: 'BTCUSD', XAUUSD: 'XAUUSD', GBPUSD: 'GBPUSD' };
  if (!instrument || !allowedInstruments[instrument]) {
    return res.status(400).json({ error: 'Invalid instrument' });
  }
  if (!direction || !['LONG', 'SHORT'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }

  var sl = Number(stopLoss);
  var tp = Number(takeProfit);
  var en = Number(entry);

  if (!Number.isFinite(sl) || !Number.isFinite(tp)) {
    return res.status(400).json({ error: 'SL/TP must be valid numbers' });
  }
  if (!Number.isFinite(en)) {
    return res.status(400).json({ error: 'Entry price must be a valid number' });
  }
  if (direction === 'LONG' && !(sl < en && tp > en)) {
    return res.status(400).json({ error: 'Invalid LONG levels: SL below entry, TP above entry' });
  }
  if (direction === 'SHORT' && !(sl > en && tp < en)) {
    return res.status(400).json({ error: 'Invalid SHORT levels: SL above entry, TP below entry' });
  }

  var slDistance = Math.abs(en - sl);
  if (slDistance <= 0) {
    return res.status(400).json({ error: 'Invalid stop loss distance' });
  }

  // ── Fetch real account balance ──
  var accountBalance = 10000; // safe fallback
  try {
    var accRes = await fetch(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/account-information',
      { headers: { 'auth-token': TOKEN } }
    );
    if (accRes.ok) {
      var accData = await accRes.json();
      if (Number.isFinite(Number(accData.balance))) {
        accountBalance = Number(accData.balance);
      }
    }
  } catch (e) {}

  // ── Risk-based lot sizing ──
  var riskPercent = 0.005; // 0.5% per trade
  var riskAmount = accountBalance * riskPercent;
  var volume = 0.01; // safe default

  if (instrument === 'GBPUSD') {
    // Standard forex: ~$10 per pip per lot, pip = 0.0001
    var pipSize = 0.0001;
    var pipValuePerLot = 10;
    var stopLossPips = slDistance / pipSize;
    var calculated = riskAmount / (stopLossPips * pipValuePerLot);
    volume = Math.floor(Math.min(Math.max(calculated, 0.01), 0.10) * 100) / 100;
  } else if (instrument === 'XAUUSD') {
    // Fixed until PU Prime contract spec confirmed
    volume = 0.01;
  } else if (instrument === 'BTCUSDT') {
    // Fixed until PU Prime contract spec confirmed
    volume = 0.01;
  }

  var symbol = allowedInstruments[instrument];
  var actionType = direction === 'LONG' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';

  var formatPrice = function(sym, val) {
    var d = sym === 'GBPUSD' ? 5 : sym === 'XAUUSD' ? 2 : sym === 'BTCUSD' ? 2 : 5;
    return parseFloat(Number(val).toFixed(d));
  };

  try {
    var r = await fetch(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/trade',
      {
        method: 'POST',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: actionType,
          symbol: symbol,
          volume: volume,
          stopLoss: formatPrice(symbol, sl),
          takeProfit: formatPrice(symbol, tp),
          comment: 'QuantumBot'
        })
      }
    );

    var data;
    try { data = await r.json(); } catch (e) { data = { error: 'Invalid JSON from broker' }; }

    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        error: (data && (data.message || data.error)) || 'Trade failed',
        data: data
      });
    }

    return res.status(200).json({
      success: true,
      data: data,
      volume: volume,
      riskAmount: riskAmount,
      accountBalance: accountBalance
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Unknown error' });
  }
};