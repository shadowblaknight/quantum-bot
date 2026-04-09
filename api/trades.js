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
    url:   process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const url      = req.url || '';
  const isLearn  = url.includes('learn=true');

  // ══════════════════════════════════════════════════════════════════════════
  // SELF-LEARNING ROUTES  —  /api/trades?learn=true
  // ══════════════════════════════════════════════════════════════════════════
  if (isLearn) {

    // ── GET: return all learned stats ──────────────────────────────────────
    if (req.method === 'GET') {
      try {
        const specificKeys = await redis.keys('qbot:learn:*');
        const stats = {};

        for (const key of specificKeys) {
          const data = await redis.get(key);
          if (!data) continue;
          const d     = typeof data === 'string' ? JSON.parse(data) : data;
          const label = key.replace('qbot:learn:', '');
          const total = (d.wins || 0) + (d.losses || 0);
          stats[label] = {
            wins:     d.wins    || 0,
            losses:   d.losses  || 0,
            total,
            winRate:  total > 0 ? Math.round(((d.wins || 0) / total) * 100) : null,
            avgPips:  total > 0 && d.totalPips != null
              ? parseFloat((d.totalPips / total).toFixed(1)) : null,
            bestRR:   d.bestRR   || null,
            lastSeen: d.lastSeen || null,
            trades:   d.trades   || [],
          };
        }

        return res.status(200).json({
          stats,
          totalPatterns: Object.keys(stats).length,
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── POST: record a trade result ────────────────────────────────────────
    if (req.method === 'POST') {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const {
          instrument, direction, won, pips, rr,
          h4Strength, d1Trend, entryCandle,
          regime, session, confluenceScore, grade, rsi,
        } = body;

        if (!instrument || !direction || won === undefined) {
          return res.status(400).json({ error: 'Missing required fields' });
        }

        // Unique fingerprint — 7 factors identify the setup
        const fingerprint = [
          instrument,
          direction,
          h4Strength  || 'UNKNOWN',
          d1Trend     || 'UNKNOWN',
          entryCandle || 'NONE',
          regime      || 'UNKNOWN',
          session     || 'UNKNOWN',
        ].join(':');

        // Broader fingerprint — instrument + direction + H4 + D1 only
        const broadFingerprint = [
          instrument,
          direction,
          h4Strength || 'UNKNOWN',
          d1Trend    || 'UNKNOWN',
        ].join(':');

        const now = new Date().toISOString();

        // Update specific fingerprint
        const key      = `qbot:learn:${fingerprint}`;
        const existing = await redis.get(key);
        const current  = existing
          ? (typeof existing === 'string' ? JSON.parse(existing) : existing)
          : { wins: 0, losses: 0, totalPips: 0, bestRR: 0, trades: [] };

        const updated = {
          wins:      won ? (current.wins || 0) + 1 : (current.wins || 0),
          losses:    won ? (current.losses || 0)   : (current.losses || 0) + 1,
          totalPips: (current.totalPips || 0) + (pips || 0),
          bestRR:    Math.max(current.bestRR || 0, rr || 0),
          lastSeen:  now,
          // Keep last 10 results for trend analysis
          trades: [...(current.trades || []).slice(-9), {
            won, pips, rr, grade, confluenceScore, rsi, date: now,
          }],
        };

        // 90-day TTL — old patterns expire naturally
        await redis.set(key, JSON.stringify(updated), { ex: 60 * 60 * 24 * 90 });

        // Update broad fingerprint
        const broadKey     = `qbot:learn:broad:${broadFingerprint}`;
        const broadExist   = await redis.get(broadKey);
        const broadCurrent = broadExist
          ? (typeof broadExist === 'string' ? JSON.parse(broadExist) : broadExist)
          : { wins: 0, losses: 0, totalPips: 0 };

        await redis.set(broadKey, JSON.stringify({
          wins:      won ? (broadCurrent.wins || 0) + 1 : (broadCurrent.wins || 0),
          losses:    won ? (broadCurrent.losses || 0)   : (broadCurrent.losses || 0) + 1,
          totalPips: (broadCurrent.totalPips || 0) + (pips || 0),
          lastSeen:  now,
        }), { ex: 60 * 60 * 24 * 90 });

        console.log(JSON.stringify({
          event:       won ? 'TRADE_WIN_LEARNED' : 'TRADE_LOSS_LEARNED',
          fingerprint, pips, rr, grade,
        }));

        const total = updated.wins + updated.losses;
        return res.status(200).json({
          success: true,
          fingerprint,
          result:  won ? 'WIN' : 'LOSS',
          newStats: {
            wins:    updated.wins,
            losses:  updated.losses,
            total,
            winRate: total > 0 ? Math.round((updated.wins / total) * 100) : null,
          },
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRADE STORAGE ROUTES  —  /api/trades  (original logic — unchanged)
  // ══════════════════════════════════════════════════════════════════════════
  try {
    if (req.method === 'GET') {
      const trades = (await redis.get('quantum:trades')) || [];
      const stats  = (await redis.get('quantum:stats'))  || { total: 0, wins: 0, pnl: 0, winRate: '0.0' };
      return res.status(200).json({ trades, stats });
    }

    if (req.method === 'POST') {
      const trade = req.body || {};
      const pnl   = Number(trade.pnl);
      const allowedInstruments = ['GBPUSD', 'BTCUSDT', 'XAUUSD'];

      if (!allowedInstruments.includes(trade.instrument)) return res.status(400).json({ error: 'Invalid instrument' });
      if (!['LONG', 'SHORT'].includes(trade.direction))   return res.status(400).json({ error: 'Invalid direction' });
      if (!Number.isFinite(pnl))                          return res.status(400).json({ error: 'Invalid pnl value' });

      const normalizedTrade = {
        ...trade,
        pnl,
        win:     trade.win === true || trade.win === 'true',
        id:      `P${Date.now()}`,
        savedAt: new Date().toISOString(),
      };

      const existing = (await redis.get('quantum:trades')) || [];
      const updated  = [normalizedTrade, ...existing].slice(0, 500);
      await redis.set('quantum:trades', updated);

      const stats      = (await redis.get('quantum:stats')) || { total: 0, wins: 0, pnl: 0 };
      stats.total     += 1;
      if (normalizedTrade.win) stats.wins += 1;
      stats.pnl        = Number((Number(stats.pnl || 0) + pnl).toFixed(2));
      stats.winRate    = ((stats.wins / stats.total) * 100).toFixed(1);
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
  } catch (e) {
    console.error('Redis error:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};