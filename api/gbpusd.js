/* eslint-disable */
// api/gbpusd.js - GBP/USD live price server-side (no CORS issues)
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY || '7a56659902cd4756a8a65068af305db4';

  try {
    // Try Twelve Data first
    const r1 = await fetch(`https://api.twelvedata.com/price?symbol=GBP/USD&apikey=${TWELVE_DATA_KEY}`);
    const d1 = await r1.json();
    if (d1.price && parseFloat(d1.price) > 1.0) {
      return res.status(200).json({ price: parseFloat(d1.price), source: 'twelvedata' });
    }

    // Fallback: Frankfurter
    const r2 = await fetch('https://api.frankfurter.app/latest?from=GBP&to=USD');
    const d2 = await r2.json();
    if (d2.rates?.USD) {
      return res.status(200).json({ price: d2.rates.USD, source: 'frankfurter' });
    }

    return res.status(200).json({ price: 1.3242, source: 'fallback' });
  } catch(e) {
    return res.status(200).json({ price: 1.3242, source: 'fallback' });
  }
};