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

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const url     = req.url || '';
  const isLearn = url.includes('learn=true');

  // ══════════════════════════════════════════════════════════════════════════
  // SELF-LEARNING ROUTES  /api/trades?learn=true
  // ══════════════════════════════════════════════════════════════════════════
  if (isLearn) {

    if (req.method === 'GET') {
      try {
        const specificKeys = await redis.keys('qbot:learn:*');
        const stats = {};

        for (const key of specificKeys) {
          if (key.includes('broad:')) continue; // skip broad keys
          const data = await redis.get(key);
          if (!data) continue;
          const d     = typeof data === 'string' ? JSON.parse(data) : data;
          const label = key.replace('qbot:learn:', '');
          const total = (d.wins || 0) + (d.losses || 0);
          stats[label] = {
            wins:     d.wins    || 0,
            losses:   d.losses  || 0,
            total,
            winRate:  total > 0 ? Math.round(((d.wins||0)/total)*100) : null,
            avgPips:  total > 0 && d.totalPips != null ? parseFloat((d.totalPips/total).toFixed(1)) : null,
            bestRR:   d.bestRR   || null,
            lastSeen: d.lastSeen || null,
            trades:   d.trades   || [],
          };
        }

        // ── ANALYTICS ENGINE ──
        const now = new Date();
        const isTdy = (d) => new Date(d).toDateString() === now.toDateString();
        const isWk  = (d) => (now - new Date(d)) / 864e5 <= 7;
        const isMth = (d) => { const dt = new Date(d); return dt.getMonth()===now.getMonth() && dt.getFullYear()===now.getFullYear(); };

        // Flatten all individual trades
        const allTrades = [];
        Object.values(stats).forEach(s => {
          (s.trades || []).forEach(t => allTrades.push(t));
        });

        const computeStats = (arr) => {
          const wins = arr.filter(t => t.won).length;
          const pnl  = arr.reduce((s,t) => s+(t.pips||0), 0);
          const avgWin  = wins > 0 ? arr.filter(t=>t.won).reduce((s,t)=>s+(t.pips||0),0)/wins : 0;
          const losses  = arr.filter(t => !t.won);
          const avgLoss = losses.length > 0 ? losses.reduce((s,t)=>s+(t.pips||0),0)/losses.length : 0;
          return {
            total:    arr.length,
            wins,
            losses:   arr.length - wins,
            winRate:  arr.length > 0 ? Math.round((wins/arr.length)*100) : 0,
            pnl:      parseFloat(pnl.toFixed(2)),
            avgWin:   parseFloat(avgWin.toFixed(2)),
            avgLoss:  parseFloat(avgLoss.toFixed(2)),
          };
        };

        // ── Session breakdown ──
        const sessionStats = {};
        ['LONDON','NEW_YORK','LONDON_NY_OVERLAP','ASIA'].forEach(s => {
          const filtered = allTrades.filter(t => t.session === s);
          if (filtered.length > 0) sessionStats[s] = computeStats(filtered);
        });

        // ── TP flow ──
        const tp1 = allTrades.filter(t => t.tp1Hit).length;
        const tp2 = allTrades.filter(t => t.tp2Hit).length;
        const tp3 = allTrades.filter(t => t.tp3Hit).length;
        const be  = allTrades.filter(t => t.beMoved).length;

        const tpFlow = {
          tp1Rate:      allTrades.length > 0 ? Math.round((tp1/allTrades.length)*100) : 0,
          tp2FromTp1:   tp1 > 0 ? Math.round((tp2/tp1)*100) : 0,
          tp3FromTp2:   tp2 > 0 ? Math.round((tp3/tp2)*100) : 0,
          beRate:       tp1 > 0 ? Math.round((be/tp1)*100) : 0,
        };

        return res.status(200).json({
          stats,
          totalPatterns: Object.keys(stats).length,
          analytics: {
            all:      computeStats(allTrades),
            daily:    computeStats(allTrades.filter(t => isTdy(t.date))),
            weekly:   computeStats(allTrades.filter(t => isWk(t.date))),
            monthly:  computeStats(allTrades.filter(t => isMth(t.date))),
            sessions: sessionStats,
            tpFlow,
          },
        });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (req.method === 'POST') {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const {
          instrument, direction, won, pips, rr,
          h4Strength, d1Trend, entryCandle,
          regime, session, confluenceScore, grade, rsi,
          tp1Hit, tp2Hit, tp3Hit, beMoved,
        } = body;

        if (!instrument || !direction || won === undefined) {
          return res.status(400).json({ error: 'Missing required fields' });
        }

        const fingerprint = [
          instrument,
          direction,
          h4Strength  || 'UNKNOWN',
          d1Trend     || 'UNKNOWN',
          entryCandle || 'NONE',
          regime      || 'UNKNOWN',
          session     || 'UNKNOWN',
        ].join(':');

        const broadFingerprint = [instrument, direction, h4Strength||'UNKNOWN', d1Trend||'UNKNOWN'].join(':');
        const now = new Date().toISOString();

        const key      = `qbot:learn:${fingerprint}`;
        const existing = await redis.get(key);
        const current  = existing
          ? (typeof existing === 'string' ? JSON.parse(existing) : existing)
          : { wins: 0, losses: 0, totalPips: 0, bestRR: 0, trades: [] };

        const updated = {
          wins:      won ? (current.wins||0)+1 : (current.wins||0),
          losses:    won ? (current.losses||0) : (current.losses||0)+1,
          totalPips: (current.totalPips||0)+(pips||0),
          bestRR:    Math.max(current.bestRR||0, rr||0),
          lastSeen:  now,
          trades: [...(current.trades||[]).slice(-9), {
            won, pips, rr, grade, confluenceScore, rsi,
            session:  session  || 'UNKNOWN',
            tp1Hit:   tp1Hit   || false,
            tp2Hit:   tp2Hit   || false,
            tp3Hit:   tp3Hit   || false,
            beMoved:  beMoved  || false,
            date: now,
          }],
        };

        await redis.set(key, JSON.stringify(updated), { ex: 60*60*24*90 });

        // Broad fingerprint
        const broadKey     = `qbot:learn:broad:${broadFingerprint}`;
        const broadExist   = await redis.get(broadKey);
        const broadCurrent = broadExist
          ? (typeof broadExist === 'string' ? JSON.parse(broadExist) : broadExist)
          : { wins: 0, losses: 0, totalPips: 0 };

        await redis.set(broadKey, JSON.stringify({
          wins:      won ? (broadCurrent.wins||0)+1 : (broadCurrent.wins||0),
          losses:    won ? (broadCurrent.losses||0) : (broadCurrent.losses||0)+1,
          totalPips: (broadCurrent.totalPips||0)+(pips||0),
          lastSeen:  now,
        }), { ex: 60*60*24*90 });

        const total = updated.wins + updated.losses;
        return res.status(200).json({
          success: true, fingerprint,
          result: won ? 'WIN' : 'LOSS',
          newStats: { wins: updated.wins, losses: updated.losses, total,
            winRate: total > 0 ? Math.round((updated.wins/total)*100) : null },
        });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRADE STORAGE ROUTES  /api/trades
  // ══════════════════════════════════════════════════════════════════════════
  try {
    if (req.method === 'GET') {
      const trades = (await redis.get('quantum:trades')) || [];
      const stats  = (await redis.get('quantum:stats'))  || { total:0, wins:0, pnl:0, winRate:'0.0' };
      return res.status(200).json({ trades, stats });
    }

    if (req.method === 'POST') {
      const trade = req.body || {};
      const pnl   = Number(trade.pnl);
      const allowed = ['GBPUSD','BTCUSDT','XAUUSD'];
      if (!allowed.includes(trade.instrument))          return res.status(400).json({ error: 'Invalid instrument' });
      if (!['LONG','SHORT'].includes(trade.direction))  return res.status(400).json({ error: 'Invalid direction' });
      if (!Number.isFinite(pnl))                        return res.status(400).json({ error: 'Invalid pnl value' });

      const normalizedTrade = { ...trade, pnl, win: trade.win===true||trade.win==='true', id:`P${Date.now()}`, savedAt: new Date().toISOString() };
      const existing = (await redis.get('quantum:trades')) || [];
      const updated  = [normalizedTrade, ...existing].slice(0,500);
      await redis.set('quantum:trades', updated);

      const stats      = (await redis.get('quantum:stats')) || { total:0, wins:0, pnl:0 };
      stats.total     += 1;
      if (normalizedTrade.win) stats.wins += 1;
      stats.pnl        = Number((Number(stats.pnl||0)+pnl).toFixed(2));
      stats.winRate    = ((stats.wins/stats.total)*100).toFixed(1);
      stats.lastUpdate = new Date().toISOString();
      await redis.set('quantum:stats', stats);

      return res.status(200).json({ success: true, trade: normalizedTrade, stats });
    }

    if (req.method === 'DELETE') {
      if (!process.env.ADMIN_DELETE_TOKEN) return res.status(500).json({ error: 'Missing admin delete token' });
      if (req.headers['x-admin-token'] !== process.env.ADMIN_DELETE_TOKEN) return res.status(403).json({ error: 'Forbidden' });
      await redis.set('quantum:trades', []);
      await redis.set('quantum:stats', { total:0, wins:0, pnl:0, winRate:'0.0' });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error('Redis error:', e);
    return res.status(500).json({ error: e.message||'Server error' });
  }
};