/* eslint-disable */
const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(500).json({ error: 'Missing Redis env vars' });
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  try {
    if (req.method === 'GET') {
      const trades = (await redis.get('quantum:trades')) || [];
      const stats  = (await redis.get('quantum:stats'))  || { total: 0, wins: 0, pnl: 0, winRate: '0.0' };
      return res.status(200).json({ trades, stats });
    }

    if (req.method === 'POST') {
      const trade = req.body || {};
      const pnl = Number(trade.pnl);
      const allowedInstruments = ['GBPUSD', 'BTCUSDT', 'XAUUSD'];

      if (!allowedInstruments.includes(trade.instrument)) return res.status(400).json({ error: 'Invalid instrument' });
      if (!['LONG', 'SHORT'].includes(trade.direction))   return res.status(400).json({ error: 'Invalid direction' });
      if (!Number.isFinite(pnl))                          return res.status(400).json({ error: 'Invalid pnl value' });

      const normalizedTrade = {
        ...trade,
        pnl,
        win: trade.win === true || trade.win === 'true',
        id: `P${Date.now()}`,
        savedAt: new Date().toISOString(),
      };

      const existing = (await redis.get('quantum:trades')) || [];
      const updated  = [normalizedTrade, ...existing].slice(0, 500);
      await redis.set('quantum:trades', updated);

      const stats = (await redis.get('quantum:stats')) || { total: 0, wins: 0, pnl: 0 };
      stats.total += 1;
      if (normalizedTrade.win) stats.wins += 1;
      stats.pnl     = Number((Number(stats.pnl || 0) + pnl).toFixed(2));
      stats.winRate = ((stats.wins / stats.total) * 100).toFixed(1);
      stats.lastUpdate = new Date().toISOString();
      await redis.set('quantum:stats', stats);

      return res.status(200).json({ success: true, trade: normalizedTrade, stats });
    }

    if (req.method === 'DELETE') {
      if (!process.env.ADMIN_DELETE_TOKEN) return res.status(500).json({ error: 'Missing admin delete token' });
      if (req.headers['x-admin-token'] !== process.env.ADMIN_DELETE_TOKEN) return res.status(403).json({ error: 'Forbidden' });

      await redis.set('quantum:trades', []);
      await redis.set('quantum:stats', { total: 0, wins: 0, pnl: 0, winRate: '0.0' });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error('Redis error:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};