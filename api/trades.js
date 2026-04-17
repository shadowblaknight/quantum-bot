/* eslint-disable */
// api/trades.js — V8 Strategy Lab
const { Redis } = require('@upstash/redis');

const INSTRUMENTS = ['XAUUSD', 'BTCUSDT', 'GBPUSD'];
const CROWN_THRESHOLD = 5;
const DETHRONE_LOSSES = 3;
const BAN_LOSSES = 3;

const safeJsonParse = (value) => {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch(e) { return value; }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)
    return res.status(500).json({ error: 'Missing Redis env vars' });

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const url   = req.url || '';

  // ── CLEANUP ──────────────────────────────────────────────────────────────
  if (url.includes('cleanup=true') && req.method === 'GET') {
    if (!url.includes('confirm=yes')) {
      return res.status(200).json({ warning: 'DRY RUN — add &confirm=yes to execute' });
    }
    try {
      const [stratKeys, learnKeys, tpKeys] = await Promise.all([
        redis.keys('qbot:strat:*').catch(()=>[]),
        redis.keys('qbot:learn:*').catch(()=>[]),
        redis.keys('tp_state:*').catch(()=>[]),
      ]);
      const toDelete = [...learnKeys, ...tpKeys];
      // Only delete strat keys that are garbage
      for (const key of stratKeys) {
        const clean = key.replace('qbot:strat:','');
        const parts = clean.split(':');
        const strat = parts.slice(1).join(':');
        const isGarbage = !strat || strat === 'EXPLORING' || strat === 'UNKNOWN' ||
          strat.includes('LONG:') || strat.includes('SHORT:') || strat.includes('AI_DECISION');
        if (isGarbage) toDelete.push(key);
      }
      // Delete EXPLORING crowns
      for (const inst of INSTRUMENTS) {
        const ck = `qbot:strat:crown:${inst}`;
        const val = safeJsonParse(await redis.get(ck).catch(()=>null));
        if (val === 'EXPLORING' || val === 'UNKNOWN') toDelete.push(ck);
      }
      for (let i = 0; i < toDelete.length; i += 50) {
        const batch = toDelete.slice(i, i+50);
        await Promise.all(batch.map(k => redis.del(k).catch(()=>null)));
      }
      const kept = stratKeys.length - toDelete.filter(k=>k.startsWith('qbot:strat:')).length;
      return res.status(200).json({ deleted: toDelete.length, kept, message: 'Smart cleanup done' });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── DEBUG ──────────────────────────────────────────────────────────────
  if (url.includes('debug=true') && req.method === 'GET') {
    try {
      const all = await redis.keys('*').catch(()=>[]);
      const strat = all.filter(k=>k.startsWith('qbot:strat:'));
      const learn = all.filter(k=>k.startsWith('qbot:learn:'));
      let sample = null;
      const sk = strat.find(k=>!k.includes('crown:')&&!k.includes('blacklist:'));
      if (sk) { const r = await redis.get(sk).catch(()=>null); sample = {key:sk, value:r}; }
      return res.status(200).json({ total:all.length, strat:strat.length, learn:learn.length, sample });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── STRATEGY LAB ──────────────────────────────────────────────────────
  if (url.includes('learn=true')) {

    // GET — full lab data
    if (req.method === 'GET') {
      try {
        const stratKeys = await redis.keys('qbot:strat:*').catch(()=>[]);
        const dataKeys = stratKeys.filter(k => !k.includes('blacklist:') && !k.includes('crown:'));

        // Fetch all in batches
        let values = [];
        for (let b = 0; b < dataKeys.length; b += 50) {
          const batch = dataKeys.slice(b, b+50);
          if (!batch.length) continue;
          const bv = await redis.mget(...batch).catch(()=>new Array(batch.length).fill(null));
          values = values.concat(bv);
        }

        const lab = {};
        for (let i = 0; i < dataKeys.length; i++) {
          const key = dataKeys[i];
          const raw = values[i];
          if (!raw) continue;
          let d;
          try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; if (!d || typeof d !== 'object') continue; }
          catch(e) { continue; }

          const clean = key.replace('qbot:strat:','');
          const parts = clean.split(':');
          const rawInst = parts[0];
          const strat = parts.slice(1).join(':') || '';
          if (!strat || strat === 'EXPLORING' || strat === 'UNKNOWN') continue;

          const NORM = { BTCUSD:'BTCUSDT', BTCUSDT:'BTCUSDT', XAUUSD:'XAUUSD', 'XAUUSD.S':'XAUUSD', 'XAUUSD.s':'XAUUSD', GBPUSD:'GBPUSD', 'GBPUSD.S':'GBPUSD', 'GBPUSD.s':'GBPUSD' };
          const inst = NORM[rawInst] || NORM[rawInst.toUpperCase()] || null;
          if (!inst) continue;
          if (!lab[strat]) lab[strat] = {};

          const total = (d.wins||0) + (d.losses||0);
          const wr = total > 0 ? Math.round(((d.wins||0)/total)*100) : null;
          const recentResults = (d.trades||[]).slice(-3).map(t=>t.won);
          const banned = recentResults.length >= BAN_LOSSES && recentResults.every(r=>r===false);
          const hasCrown = (d.wins||0) >= CROWN_THRESHOLD && !banned;
          const dethroned = hasCrown && (d.postCrownLosses||0) >= DETHRONE_LOSSES;

          lab[strat][inst] = {
            wins: d.wins||0, losses: d.losses||0, total, winRate: wr,
            avgPnl: d.totalPnl && total>0 ? parseFloat((d.totalPnl/total).toFixed(2)) : null,
            crown: hasCrown && !dethroned, dethroned, banned,
            consecutiveLosses: d.consecutiveLosses||0, postCrownLosses: d.postCrownLosses||0,
            lastSeen: d.lastSeen, trades: (d.trades||[]).slice(-5),
          };
        }

        // Crown locks
        const crownLocks = {};
        const crownVals = await redis.mget(...INSTRUMENTS.map(i=>`qbot:strat:crown:${i}`)).catch(()=>[]);
        INSTRUMENTS.forEach((inst,i) => { if (crownVals[i]) crownLocks[inst] = safeJsonParse(crownVals[i]); });

        // Blacklist
        const blRaw = await redis.get('qbot:strat:blacklist:global').catch(()=>null);
        const blacklist = safeJsonParse(blRaw) || [];

        // Summary
        const summary = {};
        for (const [strat, instData] of Object.entries(lab)) {
          const instKeys = Object.keys(instData);
          const totalWins = instKeys.reduce((s,k)=>s+(instData[k].wins||0),0);
          const totalLosses = instKeys.reduce((s,k)=>s+(instData[k].losses||0),0);
          const total = totalWins + totalLosses;
          const crownCount = instKeys.filter(k=>instData[k].crown).length;
          const bannedOn = instKeys.filter(k=>instData[k].banned);
          const isLocked = Object.values(crownLocks).includes(strat);
          summary[strat] = {
            instruments: instData, totalWins, totalLosses, total,
            overallWinRate: total>0?Math.round((totalWins/total)*100):null,
            crowns: crownCount, bannedOn, isBlacklisted: blacklist.includes(strat), isLocked,
          };
        }

        const now = new Date();
        const allT = Object.values(lab).flatMap(s=>Object.values(s).flatMap(d=>d.trades||[]));
        const isTdy = d => new Date(d).toDateString()===now.toDateString();
        const cmp = arr => { const w=arr.filter(t=>t.won).length; return {trades:arr.length,wins:w,losses:arr.length-w,winRate:arr.length?Math.round((w/arr.length)*100):0,pnl:parseFloat((arr.reduce((s,t)=>s+(t.pnl||0),0)).toFixed(2))}; };
        const sessStat = {}; allT.forEach(t=>{const s=t.session||'UNKNOWN';if(!sessStat[s])sessStat[s]={trades:0,wins:0,pnl:0};sessStat[s].trades++;if(t.won)sessStat[s].wins++;sessStat[s].pnl+=(t.pnl||0);});
        const sessOut = {}; Object.entries(sessStat).forEach(([s,d])=>{sessOut[s]={...d,winRate:d.trades>0?Math.round((d.wins/d.trades)*100):0,pnl:parseFloat(d.pnl.toFixed(2))};});

        return res.status(200).json({
          lab: summary, crownLocks, blacklist,
          totalStrategiesTried: Object.keys(summary).length,
          analytics: { all:cmp(allT), daily:cmp(allT.filter(t=>isTdy(t.date))), sessions:sessOut },
        });
      } catch(e) {
        console.error('Lab GET error:', e.message);
        return res.status(500).json({ error: e.message });
      }
    }

    // POST — record result
    if (req.method === 'POST') {
      try {
        let body = {};
        try { body = typeof req.body==='string' ? JSON.parse(req.body) : (req.body||{}); }
        catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

        const { instrument, direction, won, pnl, pips, rr, strategy, session,
                tp1Hit, tp2Hit, tp3Hit, beMoved, confidence, closeTime, openPrice, closePrice, volume } = body;

        if (!instrument || !direction || !strategy || won===undefined)
          return res.status(400).json({ error: 'Missing required fields' });
        if (!strategy || strategy === 'EXPLORING' || strategy === 'UNKNOWN')
          return res.status(200).json({ skipped: true, reason: 'Garbage strategy name' });

        const NORM = { BTCUSD:'BTCUSDT', BTCUSDT:'BTCUSDT', XAUUSD:'XAUUSD', 'XAUUSD.S':'XAUUSD', 'XAUUSD.s':'XAUUSD', GBPUSD:'GBPUSD', 'GBPUSD.S':'GBPUSD', 'GBPUSD.s':'GBPUSD' };
        const normInst = NORM[instrument] || NORM[(instrument||'').toUpperCase()] || instrument;
        const now = new Date().toISOString();
        const key = `qbot:strat:${normInst}:${strategy}`;
        const existing = safeJsonParse(await redis.get(key).catch(()=>null));
        const cur = (existing && typeof existing === 'object') ? existing
          : { wins:0, losses:0, totalPnl:0, consecutiveLosses:0, postCrownLosses:0, trades:[] };

        const newConsec = won ? 0 : (cur.consecutiveLosses||0)+1;
        const wasCrowned = (cur.wins||0) >= CROWN_THRESHOLD;
        const newPostCrown = wasCrowned ? (won ? 0 : (cur.postCrownLosses||0)+1) : 0;
        const updated = {
          wins: won ? (cur.wins||0)+1 : (cur.wins||0),
          losses: won ? (cur.losses||0) : (cur.losses||0)+1,
          totalPnl: parseFloat(((cur.totalPnl||0)+(pnl||0)).toFixed(2)),
          consecutiveLosses: newConsec, postCrownLosses: newPostCrown, lastSeen: now,
          trades: [...(cur.trades||[]).slice(-19), {
            won, pnl:pnl||0, pips:pips||0, rr:rr||0, direction:direction||'UNKNOWN',
            session:session||'UNKNOWN', tp1Hit:!!tp1Hit, tp2Hit:!!tp2Hit, tp3Hit:!!tp3Hit,
            beMoved:!!beMoved, confidence:confidence||0,
            date:closeTime||now, openPrice:openPrice||null, closePrice:closePrice||null, volume:volume||0.1,
          }],
        };
        await redis.set(key, JSON.stringify(updated), { ex: 60*60*24*120 });

        // Crown check
        let justCrowned = false;
        if (!wasCrowned && updated.wins >= CROWN_THRESHOLD) {
          const ck = `qbot:strat:crown:${normInst}`;
          const curCr = safeJsonParse(await redis.get(ck).catch(()=>null));
          if (!curCr || curCr === 'EXPLORING' || curCr === 'UNKNOWN') {
            await redis.set(ck, JSON.stringify(strategy), { ex: 60*60*24*365 });
            justCrowned = true;
          }
        }

        // Dethrone check
        let dethroned = false;
        if (wasCrowned && newPostCrown >= DETHRONE_LOSSES) {
          const ck = `qbot:strat:crown:${normInst}`;
          const locked = safeJsonParse(await redis.get(ck).catch(()=>null));
          if (locked === strategy) { await redis.del(ck); dethroned = true; }
        }

        // Blacklist check
        let blacklisted = false;
        if (!won && newConsec >= BAN_LOSSES) {
          const others = INSTRUMENTS.filter(i=>i!==normInst);
          const otherRaw = await redis.mget(...others.map(i=>`qbot:strat:${i}:${strategy}`)).catch(()=>[]);
          const allBanned = otherRaw.every(r=>{ const d=safeJsonParse(r); return d&&typeof d==='object'&&(d.consecutiveLosses||0)>=BAN_LOSSES; });
          if (allBanned) {
            const bl = safeJsonParse(await redis.get('qbot:strat:blacklist:global').catch(()=>null)) || [];
            if (!bl.includes(strategy)) { bl.push(strategy); await redis.set('qbot:strat:blacklist:global', JSON.stringify(bl), { ex: 60*60*24*180 }); blacklisted = true; }
          }
        }

        const total = updated.wins + updated.losses;
        return res.status(200).json({
          success:true, strategy, instrument:normInst, result:won?'WIN':'LOSS',
          stats:{ wins:updated.wins, losses:updated.losses, total, winRate:total?Math.round((updated.wins/total)*100):null },
          justCrowned, dethroned, blacklisted,
        });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Standard trade storage ─────────────────────────────────────────────
  try {
    if (req.method === 'GET') {
      const trades = (await redis.get('quantum:trades')) || [];
      const stats  = (await redis.get('quantum:stats'))  || { total:0,wins:0,pnl:0,winRate:'0.0' };
      return res.status(200).json({ trades, stats });
    }
    if (req.method === 'POST') {
      const trade = req.body || {};
      const p = Number(trade.pnl);
      const NORM = { BTCUSD:'BTCUSDT', BTCUSDT:'BTCUSDT', XAUUSD:'XAUUSD', GBPUSD:'GBPUSD' };
      const normI = NORM[trade.instrument] || trade.instrument;
      if (!INSTRUMENTS.includes(normI)) return res.status(400).json({ error:'Invalid instrument' });
      if (!['LONG','SHORT'].includes(trade.direction)) return res.status(400).json({ error:'Invalid direction' });
      if (!Number.isFinite(p)) return res.status(400).json({ error:'Invalid pnl' });
      const t = { ...trade, pnl:p, win:trade.win===true||trade.win==='true', id:`P${Date.now()}`, savedAt:new Date().toISOString() };
      const ex = (await redis.get('quantum:trades')) || [];
      await redis.set('quantum:trades', [t,...ex].slice(0,500));
      const st = (await redis.get('quantum:stats')) || { total:0,wins:0,pnl:0 };
      st.total++; if(t.win)st.wins++; st.pnl=Number((Number(st.pnl||0)+p).toFixed(2)); st.winRate=((st.wins/st.total)*100).toFixed(1); st.lastUpdate=new Date().toISOString();
      await redis.set('quantum:stats', st);
      return res.status(200).json({ success:true, trade:t, stats:st });
    }
    if (req.method === 'DELETE') {
      if (!process.env.ADMIN_DELETE_TOKEN) return res.status(500).json({ error:'Missing admin token' });
      if (req.headers['x-admin-token']!==process.env.ADMIN_DELETE_TOKEN) return res.status(403).json({ error:'Forbidden' });
      await redis.set('quantum:trades',[]); await redis.set('quantum:stats',{total:0,wins:0,pnl:0,winRate:'0.0'});
      return res.status(200).json({ success:true });
    }
    return res.status(405).json({ error:'Method not allowed' });
  } catch(e) { return res.status(500).json({ error: e.message }); }
};