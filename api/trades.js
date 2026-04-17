/* eslint-disable */
// api/trades.js — V8 Strategy Lab + Self-Learning Engine
const { Redis } = require('@upstash/redis');

const INSTRUMENTS    = ['XAUUSD','BTCUSDT','GBPUSD'];
const CROWN_THRESHOLD = 5;
const DETHRONE_LOSSES = 3;
const BAN_LOSSES      = 3;

const safeJsonParse = (value) => {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch(e) { return value; }
};

// Normalize any broker symbol variant to canonical instrument ID
const NORM = {
  'BTCUSD':'BTCUSDT','BTCUSDT':'BTCUSDT',
  'XAUUSD':'XAUUSD','XAUUSD.S':'XAUUSD','XAUUSD.s':'XAUUSD',
  'GBPUSD':'GBPUSD','GBPUSD.S':'GBPUSD','GBPUSD.s':'GBPUSD',
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)
    return res.status(500).json({ error: 'Missing Redis env vars' });

  const redis   = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const url     = req.url || '';
  const isLearn = url.includes('learn=true');
  const isDebug   = url.includes('debug=true');
  const isCleanup = url.includes('cleanup=true');

  // ── CLEANUP: delete all old qbot:learn:* keys ─────────────────────────
  if (isCleanup && req.method === 'GET') {
    try {
      const oldKeys = await redis.keys('qbot:learn:*').catch(()=>[]);
      if (oldKeys.length > 0) {
        // Delete in batches
        for (let i = 0; i < oldKeys.length; i += 50) {
          const batch = oldKeys.slice(i, i+50);
          await Promise.all(batch.map(k => redis.del(k).catch(()=>null)));
        }
      }
      return res.status(200).json({ deleted: oldKeys.length, message: `Cleaned up ${oldKeys.length} old V1-V7 keys` });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DEBUG ──────────────────────────────────────────────────────────────
  if (isDebug && req.method === 'GET') {
    try {
      const allKeys   = await redis.keys('*').catch(()=>[]);
      const stratKeys = allKeys.filter(k=>k.startsWith('qbot:strat:'));
      const learnKeys = allKeys.filter(k=>k.startsWith('qbot:learn:'));
      let sample = null;
      const sampleKey = stratKeys[0] || learnKeys[0];
      if (sampleKey) {
        const r = await redis.get(sampleKey).catch(()=>null);
        sample = { key: sampleKey, value: r };
      }
      return res.status(200).json({
        totalKeys: allKeys.length,
        stratKeys: { count: stratKeys.length, keys: stratKeys.slice(0,10) },
        learnKeys: { count: learnKeys.length, keys: learnKeys.slice(0,10) },
        sample,
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (isLearn) {

    // ── GET: full strategy lab ──────────────────────────────────────────
    if (req.method === 'GET') {
      try {
        // Only read V8 strategy keys (qbot:strat:*) — ignore old V1-V7 qbot:learn:* keys
        const newKeys = await redis.keys('qbot:strat:*').catch(()=>[]);

        // Filter out crown/blacklist keys
        const dataKeys = newKeys.filter(k => !k.includes('blacklist:') && !k.includes('crown:'));

        // Fetch values in batches of 50 (safer than spreading 128 args)
        let values = [];
        const BATCH = 50;
        for (let b = 0; b < dataKeys.length; b += BATCH) {
          const batch = dataKeys.slice(b, b + BATCH);
          const batchVals = batch.length > 0
            ? await redis.mget(...batch).catch(()=>new Array(batch.length).fill(null))
            : [];
          values = values.concat(batchVals);
        }

        const lab = {};

        // Log summary of what we got
        console.log(`mget: ${dataKeys.length} keys requested, ${values.filter(v=>v!=null).length} non-null values returned`);
        if (dataKeys.length > 0) console.log('Sample key:', dataKeys[0], 'Sample value type:', typeof values[0]);

        for (let i = 0; i < dataKeys.length; i++) {
          const key = dataKeys[i];
          const raw = values[i];
          if (!raw) continue;

          let d;
          try {
            d = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!d || typeof d !== 'object') continue; // skip non-object values
          } catch(e) { 
            console.log('Parse error for key:', key, 'raw:', String(raw).slice(0,50));
            continue; 
          }

          // Parse key — handle both qbot:strat: and qbot:learn: formats
          const cleanKey = key.replace('qbot:strat:','').replace('qbot:learn:','');
          const parts    = cleanKey.split(':');
          const rawInst  = parts[0];
          const strat    = parts.slice(1).join(':') || 'LEGACY';

          // Normalize instrument
          const inst = NORM[rawInst] || NORM[rawInst.toUpperCase()] || null;
          if (!inst) { if(i<3) console.log(`SKIP unknown inst: ${rawInst} from key: ${key}`); continue; }
          if (!strat || strat === 'broad') { if(i<3) console.log(`SKIP no strat from key: ${key}`); continue; }

          if (!lab[strat]) lab[strat] = {};

          const total = (d.wins||0) + (d.losses||0);
          const wr    = total > 0 ? Math.round(((d.wins||0)/total)*100) : null;

          const recentResults = (d.trades||[]).slice(-3).map(t=>t.won);
          const banned  = recentResults.length >= BAN_LOSSES && recentResults.every(r=>r===false);
          const hasCrown = (d.wins||0) >= CROWN_THRESHOLD && !banned;
          const dethroned = hasCrown && (d.postCrownLosses||0) >= DETHRONE_LOSSES;

          lab[strat][inst] = {
            wins: d.wins||0, losses: d.losses||0, total, winRate: wr,
            avgPnl: d.totalPnl && total>0 ? parseFloat((d.totalPnl/total).toFixed(2)) : null,
            crown: hasCrown && !dethroned, dethroned, banned,
            consecutiveLosses: d.consecutiveLosses||0,
            postCrownLosses: d.postCrownLosses||0,
            lastSeen: d.lastSeen,
            trades: (d.trades||[]).slice(-5),
          };
        }

        // Load crown locks
        const crownLocks = {};
        const crownVals = await redis.mget(
          ...INSTRUMENTS.map(inst=>`qbot:strat:crown:${inst}`)
        ).catch(()=>[]);
        INSTRUMENTS.forEach((inst, i) => {
          if (crownVals[i]) crownLocks[inst] = safeJsonParse(crownVals[i]);
        });

        // Load blacklist
        const blRaw     = await redis.get('qbot:strat:blacklist:global').catch(()=>null);
        const blacklist = safeJsonParse(blRaw) || [];

        // Build summary
        const summary = {};
        for (const [strat, instData] of Object.entries(lab)) {
          const instKeys    = Object.keys(instData);
          const totalWins   = instKeys.reduce((s,k)=>s+(instData[k].wins||0),0);
          const totalLosses = instKeys.reduce((s,k)=>s+(instData[k].losses||0),0);
          const total       = totalWins + totalLosses;
          const crownCount  = instKeys.filter(k=>instData[k].crown).length;
          const bannedOn    = instKeys.filter(k=>instData[k].banned);
          const isLocked    = Object.values(crownLocks).includes(strat);
          summary[strat] = {
            instruments: instData,
            totalWins, totalLosses, total,
            overallWinRate: total>0?Math.round((totalWins/total)*100):null,
            crowns: crownCount, bannedOn,
            isBlacklisted: blacklist.includes(strat),
            isLocked,
          };
        }

        // Analytics
        const now   = new Date();
        const allT  = Object.values(lab).flatMap(s=>Object.values(s).flatMap(d=>d.trades||[]));
        const isTdy = d => new Date(d).toDateString()===now.toDateString();
        const isWk  = d => (now-new Date(d))/864e5<=7;
        const isMth = d => { const dt=new Date(d); return dt.getMonth()===now.getMonth()&&dt.getFullYear()===now.getFullYear(); };
        const cmp   = arr => { const w=arr.filter(t=>t.won).length; return { trades:arr.length,wins:w,losses:arr.length-w,winRate:arr.length>0?Math.round((w/arr.length)*100):0,pnl:parseFloat((arr.reduce((s,t)=>s+(t.pnl||0),0)).toFixed(2)) }; };
        const sessStat = {};
        allT.forEach(t=>{ const s=t.session||'UNKNOWN'; if(!sessStat[s])sessStat[s]={trades:0,wins:0,pnl:0}; sessStat[s].trades++;if(t.won)sessStat[s].wins++;sessStat[s].pnl+=(t.pnl||0); });
        const sessOut = {};
        Object.entries(sessStat).forEach(([s,d])=>{ sessOut[s]={...d,winRate:d.trades>0?Math.round((d.wins/d.trades)*100):0,pnl:parseFloat(d.pnl.toFixed(2))}; });
        const tpFlow = { tp1Pct:allT.length?Math.round(allT.filter(t=>t.tp1Hit).length/allT.length*100):0, tp2Pct:allT.filter(t=>t.tp1Hit).length?Math.round(allT.filter(t=>t.tp2Hit).length/allT.filter(t=>t.tp1Hit).length*100):0, tp3Pct:allT.filter(t=>t.tp2Hit).length?Math.round(allT.filter(t=>t.tp3Hit).length/allT.filter(t=>t.tp2Hit).length*100):0 };

        console.log(`Lab built: ${Object.keys(lab).length} strategies, summary: ${Object.keys(summary).length}`);
        return res.status(200).json({
          lab: summary,
          crownLocks,
          blacklist,
          totalStrategiesTried: Object.keys(summary).length,
          analytics: { all:cmp(allT), daily:cmp(allT.filter(t=>isTdy(t.date))), weekly:cmp(allT.filter(t=>isWk(t.date))), monthly:cmp(allT.filter(t=>isMth(t.date))), sessions:sessOut, tpFlow },
        });
      } catch(e) {
        console.error('Lab GET error:', e.message, e.stack?.slice(0,200));
        return res.status(500).json({ error: e.message });
      }
    }

    // ── POST: record a strategy result ──────────────────────────────────
    if (req.method === 'POST') {
      try {
        let body = {};
        try {
          body = typeof req.body==='string' ? JSON.parse(req.body) : (req.body||{});
        } catch(e) { return res.status(400).json({ error: 'Invalid JSON body' }); }
        const { instrument, direction, won, pnl, pips, rr, strategy, session,
                tp1Hit, tp2Hit, tp3Hit, beMoved, confidence, closeTime, openPrice, closePrice, volume } = body;

        if (!instrument || !direction || !strategy || won===undefined)
          return res.status(400).json({ error: 'Missing required fields' });

        const now         = new Date().toISOString();
        const normInst    = NORM[instrument] || NORM[(instrument||'').toUpperCase()] || instrument;
        const key         = `qbot:strat:${normInst}:${strategy}`;
        const existing    = await redis.get(key).catch(()=>null);
        const cur         = existing ? safeJsonParse(existing)
                                     : { wins:0, losses:0, totalPnl:0, consecutiveLosses:0, postCrownLosses:0, trades:[] };

        const newConsec         = won ? 0 : (cur.consecutiveLosses||0)+1;
        const wasCrowned        = (cur.wins||0) >= CROWN_THRESHOLD;
        const newPostCrownLosses = wasCrowned ? (won ? 0 : (cur.postCrownLosses||0)+1) : 0;

        const updated = {
          wins:              won ? (cur.wins||0)+1 : (cur.wins||0),
          losses:            won ? (cur.losses||0) : (cur.losses||0)+1,
          totalPnl:          parseFloat(((cur.totalPnl||0)+(pnl||0)).toFixed(2)),
          consecutiveLosses: newConsec,
          postCrownLosses:   newPostCrownLosses,
          lastSeen:          now,
          trades: [...(cur.trades||[]).slice(-19), {
            won, pnl:pnl||0, pips:pips||0, rr:rr||0, direction:direction||'UNKNOWN',
            session:session||'UNKNOWN', tp1Hit:!!tp1Hit, tp2Hit:!!tp2Hit,
            tp3Hit:!!tp3Hit, beMoved:!!beMoved, confidence:confidence||0,
            date:closeTime||now, openPrice:openPrice||null, closePrice:closePrice||null, volume:volume||0.1,
          }],
        };

        await redis.set(key, JSON.stringify(updated), { ex: 60*60*24*120 });

        // Crown lock
        let justCrowned = false, crownLockSet = false;
        const newTotalWins = updated.wins;
        if (!wasCrowned && newTotalWins >= CROWN_THRESHOLD) {
          justCrowned = true;
          const ck    = `qbot:strat:crown:${normInst}`;
          const curCr = await redis.get(ck).catch(()=>null);
          if (!curCr) {
            await redis.set(ck, JSON.stringify(strategy), { ex: 60*60*24*365 });
            crownLockSet = true;
          }
        }

        // Dethrone
        let dethroneOccurred = false;
        if (wasCrowned && newPostCrownLosses >= DETHRONE_LOSSES) {
          const ck    = `qbot:strat:crown:${normInst}`;
          const curCr = await redis.get(ck).catch(()=>null);
          const locked = safeJsonParse(curCr);
          if (locked === strategy) { await redis.del(ck); dethroneOccurred = true; }
        }

        // Global blacklist
        let globallyBlacklisted = false;
        const banned = newConsec >= BAN_LOSSES;
        if (!won && banned) {
          const others  = INSTRUMENTS.filter(i=>i!==normInst);
          const otherRaw = await redis.mget(...others.map(i=>`qbot:strat:${i}:${strategy}`)).catch(()=>[]);
          const checks   = otherRaw.map(r=>{ if(!r)return false; const d=typeof r==='string'?JSON.parse(r):r; return (d.consecutiveLosses||0)>=BAN_LOSSES; });
          if (checks.every(b=>b)) {
            const blRaw = await redis.get('qbot:strat:blacklist:global').catch(()=>null);
            const bl = safeJsonParse(blRaw) || [];
            if (!bl.includes(strategy)) {
              bl.push(strategy);
              await redis.set('qbot:strat:blacklist:global', JSON.stringify(bl), { ex: 60*60*24*180 });
              globallyBlacklisted = true;
            }
          }
        }

        const total = updated.wins + updated.losses;
        return res.status(200).json({
          success:true, strategy, instrument:normInst, result:won?'WIN':'LOSS',
          stats:{ wins:updated.wins, losses:updated.losses, total, winRate:total>0?Math.round((updated.wins/total)*100):null },
          justCrowned, crownLockSet, dethroneOccurred, banned, globallyBlacklisted,
        });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
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
      const p     = Number(trade.pnl);
      const normI = NORM[trade.instrument] || trade.instrument;
      if (!INSTRUMENTS.includes(normI)) return res.status(400).json({ error:'Invalid instrument' });
      if (!['LONG','SHORT'].includes(trade.direction)) return res.status(400).json({ error:'Invalid direction' });
      if (!Number.isFinite(p)) return res.status(400).json({ error:'Invalid pnl' });
      const t  = { ...trade, pnl:p, win:trade.win===true||trade.win==='true', id:`P${Date.now()}`, savedAt:new Date().toISOString() };
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
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};