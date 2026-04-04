/* eslint-disable */
// api/gold.js - Real XAU/USD price server-side
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const r1 = await fetch('https://api.metals.live/v1/spot/gold');
    if (r1.ok) {
      const d1 = await r1.json();
      const price = d1?.[0]?.price ?? d1?.gold ?? d1?.price;
      if (Number.isFinite(Number(price))) {
        return res.status(200).json({ price: Number(price), source: 'metals.live' });
      }
    }
  } catch(e) {}

  try {
    const r2 = await fetch('https://api.frankfurter.app/latest?from=XAU&to=USD');
    if (r2.ok) {
      const d2 = await r2.json();
      const price = d2?.rates?.USD;
      if (Number.isFinite(Number(price))) {
        return res.status(200).json({ price: Number(price), source: 'frankfurter' });
      }
    }
  } catch(e) {}

  // Fail closed - no fake price, let frontend pause gold trading
  return res.status(503).json({ price: null, source: 'unavailable', error: 'Gold price unavailable' });
};