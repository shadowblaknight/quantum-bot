/* eslint-disable */
// api/trades.js - Vercel serverless function for persistent trade storage
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL || 'https://talented-doe-70974.upstash.io',
  token: process.env.KV_REST_API_TOKEN || 'gQAAAAAAARU-AAIncDIxMzJkZWM3YTJjNzY0MjViOTRjNTQyYjFlZDg1MTk40XAyNzA5NzQ',
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const trades = await redis.get('quantum:trades') || [];
      const stats  = await redis.get('quantum:stats')  || { total:0, wins:0, pnl:0 };
      return res.status(200).json({ trades, stats });
    }

    if (req.method === 'POST') {
      const trade = req.body;
      trade.id = `P${Date.now()}`;
      trade.savedAt = new Date().toISOString();

      const existing = await redis.get('quantum:trades') || [];
      const updated  = [trade, ...existing].slice(0, 500); // keep last 500
      await redis.set('quantum:trades', updated);

      // Update stats
      const stats = await redis.get('quantum:stats') || { total:0, wins:0, pnl:0 };
      stats.total += 1;
      if (trade.win) stats.wins += 1;
      stats.pnl = Number((stats.pnl + trade.pnl).toFixed(2));
      stats.winRate = ((stats.wins / stats.total) * 100).toFixed(1);
      stats.lastUpdate = new Date().toISOString();
      await redis.set('quantum:stats', stats);

      return res.status(200).json({ success: true, trade, stats });
    }

    if (req.method === 'DELETE') {
      await redis.set('quantum:trades', []);
      await redis.set('quantum:stats', { total:0, wins:0, pnl:0, winRate:'0.0' });
      return res.status(200).json({ success: true });
    }

  } catch (e) {
    console.error('Redis error:', e);
    return res.status(500).json({ error: e.message });
  }
};