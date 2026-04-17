/* eslint-disable */
// api/trades.js -- V8.2.0 Strategy Lab
// Redis namespace: v820:strat:*, v820:crown:*, v820:blacklist

const { Redis } = require('@upstash/redis');

const CROWN_WIN  = 5;
const BAN_LOSSES = 3;
const DETHRONE   = 3;

// Normalize broker symbol to a canonical key (strips suffixes, uppercases)
const normSym = (s) => {
  if (!s) return '';
  return s.toUpperCase().replace('.S', '').replace('.PRO', '').replace('.s', '').trim();
};

// Safe JSON parse -- returns null instead of throwing
const safe = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(500).json({ error: 'Missing Redis environment variables' });
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  // GET -- return full strategy lab
  if (req.method === 'GET') {
    try {
      // 1. Fetch all strategy data keys (not crown or blacklist keys)
      const allKeys = await redis.keys('v820:strat:*').catch(() => []);
      const dataKeys = allKeys.filter(k => !k.includes(':crown:') && !k.includes(':bl:'));

      // 2. Fetch all values in batches of 50
      let values = [];
      for (let b = 0; b < dataKeys.length; b += 50) {
        const batch = dataKeys.slice(b, b + 50);
        if (!batch.length) continue;
        const bv = await redis.mget(...batch).catch(() => new Array(batch.length).fill(null));
        values = values.concat(Array.isArray(bv) ? bv : new Array(batch.length).fill(null));
      }

      // 3. Build lab map -- { [strategy]: { [instrument]: { wins, losses, ... } } }
      // Instruments are discovered dynamically from Redis keys, never hardcoded.
      const lab = {};

      for (let i = 0; i < dataKeys.length; i++) {
        const raw = values[i];
        if (!raw) continue;

        let d;
        try {
          d = safe(raw);
          if (!d || typeof d !== 'object') continue;
        } catch (e) { continue; }

        // Key format: v820:strat:{INSTRUMENT}:{STRATEGY}
        const parts = dataKeys[i].replace('v820:strat:', '').split(':');
        const rawInst = parts[0];
        const strat   = parts.slice(1).join(':');

        if (!rawInst || !strat || strat === 'EXPLORING' || strat === 'UNKNOWN') continue;

        const inst = normSym(rawInst);
        if (!inst) continue;

        if (!lab[strat]) lab[strat] = {};

        const total  = (d.wins || 0) + (d.losses || 0);
        const wr     = total > 0 ? Math.round(((d.wins || 0) / total) * 100) : null;
        const recent = (d.trades || []).slice(-BAN_LOSSES).map(t => t.won);
        const banned = recent.length >= BAN_LOSSES && recent.every(r => r === false);
        const crowned  = (d.wins || 0) >= CROWN_WIN && !banned;
        const dethroned = crowned && (d.postCrownLosses || 0) >= DETHRONE;

        lab[strat][inst] = {
          wins:               d.wins    || 0,
          losses:             d.losses  || 0,
          total,
          winRate:            wr,
          avgPnl:             (d.totalPnl != null && total > 0) ? parseFloat((d.totalPnl / total).toFixed(2)) : null,
          crown:              crowned && !dethroned,
          banned,
          consecutiveLosses:  d.consecutiveLosses  || 0,
          postCrownLosses:    d.postCrownLosses     || 0,
          lastSeen:           d.lastSeen || null,
          trades:             (d.trades || []).slice(-10),
        };
      }

      // 4. Crown locks -- discovered from Redis, not from a hardcoded instrument list
      const crownKeys = allKeys.filter(k => k.startsWith('v820:crown:'));
      const crownVals = crownKeys.length
        ? await redis.mget(...crownKeys).catch(() => new Array(crownKeys.length).fill(null))
        : [];

      const crownLocks = {};
      crownKeys.forEach((key, i) => {
        const inst = key.replace('v820:crown:', '');
        const val  = safe(crownVals[i]);
        if (val && val !== 'EXPLORING' && val !== 'UNKNOWN') {
          crownLocks[inst] = val;
        }
      });

      // 5. Blacklist
      const blacklist = safe(await redis.get('v820:blacklist').catch(() => null)) || [];

      // 6. Build summary per strategy
      const summary = {};
      for (const [strat, instData] of Object.entries(lab)) {
        const instKeys = Object.keys(instData);
        const tw = instKeys.reduce((s, k) => s + (instData[k].wins   || 0), 0);
        const tl = instKeys.reduce((s, k) => s + (instData[k].losses || 0), 0);
        const tt = tw + tl;

        summary[strat] = {
          instruments:    instData,
          totalWins:      tw,
          totalLosses:    tl,
          total:          tt,
          overallWinRate: tt > 0 ? Math.round((tw / tt) * 100) : null,
          crowns:         instKeys.filter(k => instData[k].crown).length,
          bannedOn:       instKeys.filter(k => instData[k].banned),
          isBlacklisted:  (blacklist || []).includes(strat),
          isLocked:       Object.values(crownLocks).includes(strat),
        };
      }

      // 7. Analytics
      const allT = Object.values(lab).flatMap(s => Object.values(s).flatMap(d => d.trades || []));
      const now  = new Date();

      const isTdy = (t) => new Date(t).toDateString() === now.toDateString();

      const cmp = (arr) => {
        const w = arr.filter(t => t.won).length;
        return {
          trades:  arr.length,
          wins:    w,
          losses:  arr.length - w,
          winRate: arr.length ? Math.round((w / arr.length) * 100) : 0,
          pnl:     parseFloat(arr.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2)),
        };
      };

      const sessMap = {};
      allT.forEach(t => {
        const s = t.session || 'UNKNOWN';
        if (!sessMap[s]) sessMap[s] = { trades: 0, wins: 0, pnl: 0 };
        sessMap[s].trades++;
        if (t.won) sessMap[s].wins++;
        sessMap[s].pnl += (t.pnl || 0);
      });

      const sessions = {};
      Object.entries(sessMap).forEach(([s, d]) => {
        sessions[s] = {
          ...d,
          winRate: d.trades ? Math.round((d.wins / d.trades) * 100) : 0,
          pnl:     parseFloat(d.pnl.toFixed(2)),
        };
      });

      return res.status(200).json({
        lab:                summary,
        crownLocks,
        blacklist,
        totalStrategies:    Object.keys(summary).length,
        analytics: {
          all:      cmp(allT),
          today:    cmp(allT.filter(t => isTdy(t.date))),
          sessions,
        },
      });

    } catch (e) {
      console.error('trades GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // POST -- record a trade result
  if (req.method === 'POST') {
    try {
      let body = {};
      try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }

      const {
        instrument, direction, won, pnl,
        strategy, session, tp1Hit, tp2Hit, tp3Hit, tp4Hit,
        confidence, closeTime, openPrice, closePrice, volume,
      } = body;

      if (!instrument || !direction || won === undefined) {
        return res.status(400).json({ error: 'Missing required fields: instrument, direction, won' });
      }

      // Skip garbage strategy names
      const strat = (strategy || '').trim();
      if (!strat || strat === 'EXPLORING' || strat === 'UNKNOWN' || strat.length < 3) {
        return res.status(200).json({ skipped: true, reason: 'No valid strategy name' });
      }

      const inst = normSym(instrument);
      const now  = new Date().toISOString();
      const key  = 'v820:strat:' + inst + ':' + strat;

      const existing = safe(await redis.get(key).catch(() => null));
      const cur = (existing && typeof existing === 'object')
        ? existing
        : { wins: 0, losses: 0, totalPnl: 0, consecutiveLosses: 0, postCrownLosses: 0, trades: [] };

      const newConsec    = won ? 0 : (cur.consecutiveLosses || 0) + 1;
      const wasCrowned   = (cur.wins || 0) >= CROWN_WIN;
      const newPostCrown = wasCrowned ? (won ? 0 : (cur.postCrownLosses || 0) + 1) : 0;

      const updated = {
        wins:               won ? (cur.wins   || 0) + 1 : (cur.wins   || 0),
        losses:             won ? (cur.losses  || 0)     : (cur.losses || 0) + 1,
        totalPnl:           parseFloat(((cur.totalPnl || 0) + (pnl || 0)).toFixed(2)),
        consecutiveLosses:  newConsec,
        postCrownLosses:    newPostCrown,
        lastSeen:           now,
        trades: [
          ...(cur.trades || []).slice(-24),
          {
            won,
            pnl:        pnl        || 0,
            direction:  direction  || 'UNKNOWN',
            session:    session    || 'UNKNOWN',
            tp1Hit:     !!tp1Hit,
            tp2Hit:     !!tp2Hit,
            tp3Hit:     !!tp3Hit,
            tp4Hit:     !!tp4Hit,
            confidence: confidence || 0,
            date:       closeTime  || now,
            openPrice:  openPrice  || null,
            closePrice: closePrice || null,
            volume:     volume     || 0.01,
          },
        ],
      };

      await redis.set(key, JSON.stringify(updated), { ex: 60 * 60 * 24 * 90 });

      // Crown check
      let justCrowned = false;
      if (!wasCrowned && updated.wins >= CROWN_WIN) {
        const ck  = 'v820:crown:' + inst;
        const cur = safe(await redis.get(ck).catch(() => null));
        if (!cur || cur === 'EXPLORING' || cur === 'UNKNOWN') {
          await redis.set(ck, JSON.stringify(strat), { ex: 60 * 60 * 24 * 365 });
          justCrowned = true;
        }
      }

      // Dethrone check
      let dethroned = false;
      if (wasCrowned && newPostCrown >= DETHRONE) {
        const ck     = 'v820:crown:' + inst;
        const locked = safe(await redis.get(ck).catch(() => null));
        if (locked === strat) {
          await redis.del(ck);
          dethroned = true;
        }
      }

      // Blacklist check -- instrument peers discovered from Redis, not a hardcoded list
      let blacklisted = false;
      if (!won && newConsec >= BAN_LOSSES) {
        // Find all other instruments that have data for this strategy
        const peerPattern = 'v820:strat:*:' + strat;
        const peerKeys = await redis.keys(peerPattern).catch(() => []);
        const otherKeys = peerKeys.filter(k => {
          const kInst = normSym(k.replace('v820:strat:', '').split(':')[0]);
          return kInst !== inst;
        });

        if (otherKeys.length > 0) {
          const peerVals = await redis.mget(...otherKeys).catch(() => []);
          const allPeersBanned = peerVals.every(r => {
            const d = safe(r);
            return d && typeof d === 'object' && (d.consecutiveLosses || 0) >= BAN_LOSSES;
          });

          if (allPeersBanned && otherKeys.length >= 2) {
            const bl = safe(await redis.get('v820:blacklist').catch(() => null)) || [];
            if (!bl.includes(strat)) {
              bl.push(strat);
              await redis.set('v820:blacklist', JSON.stringify(bl), { ex: 60 * 60 * 24 * 180 });
              blacklisted = true;
            }
          }
        }
      }

      const total = updated.wins + updated.losses;
      return res.status(200).json({
        success:    true,
        strategy:   strat,
        instrument: inst,
        result:     won ? 'WIN' : 'LOSS',
        stats: {
          wins:    updated.wins,
          losses:  updated.losses,
          total,
          winRate: total ? Math.round((updated.wins / total) * 100) : null,
        },
        justCrowned,
        dethroned,
        blacklisted,
      });

    } catch (e) {
      console.error('trades POST error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};