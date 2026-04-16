/* eslint-disable */
// api/trades.js — V8 Strategy Lab + Crown Lock System
const { Redis } = require('@upstash/redis');

const INSTRUMENTS     = ['XAUUSD', 'BTCUSDT', 'GBPUSD'];
// All symbol variants stored in Redis (broker appends .s, crypto uses BTCUSD not BTCUSDT)
const INST_NORMALIZE  = {
  'BTCUSD':'BTCUSDT','BTCUSDT':'BTCUSDT',
  'XAUUSD':'XAUUSD','XAUUSD.S':'XAUUSD','XAUUSD.s':'XAUUSD',
  'GBPUSD':'GBPUSD','GBPUSD.S':'GBPUSD','GBPUSD.s':'GBPUSD',
};
const CROWN_THRESHOLD   = 5;   // wins needed for crown
const DETHRONE_LOSSES   = 3;   // consec losses after crown = dethrone
const BAN_LOSSES        = 3;   // consec losses = banned on instrument
const BLACKLIST_TRIGGER = 3;   // banned on all 3 = global blacklist

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
  const isDebug = url.includes('debug=true');

  // ── DEBUG: inspect Redis keys ──────────────────────────────────────────
  if (isDebug && req.method === 'GET') {
    try {
      const allKeys   = await redis.keys('*').catch(()=>[]);
      const stratKeys = allKeys.filter(k=>k.startsWith('qbot:strat:'));
      const learnKeys = allKeys.filter(k=>k.startsWith('qbot:learn:'));
      const otherKeys = allKeys.filter(k=>!k.startsWith('qbot:')&&!k.startsWith('tp_state:'));
      let sample = null;
      if (stratKeys.length > 0) {
        const r = await redis.get(stratKeys[0]).catch(()=>null);
        sample = { key: stratKeys[0], value: r };
      } else if (learnKeys.length > 0) {
        const r = await redis.get(learnKeys[0]).catch(()=>null);
        sample = { key: learnKeys[0], value: r };
      }
      return res.status(200).json({
        totalKeys: allKeys.length,
        stratKeys: { count: stratKeys.length, keys: stratKeys.slice(0,20) },
        learnKeys: { count: learnKeys.length, keys: learnKeys.slice(0,20) },
        otherKeys: { count: otherKeys.length, keys: otherKeys.slice(0,10) },
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
        // Read both new format (qbot:strat:*) and old format (qbot:learn:*)
        const [newKeys, oldKeys] = await Promise.all([
          redis.keys('qbot:strat:*').catch(()=>[]),
          redis.keys('qbot:learn:*').catch(()=>[]),
        ]);
        const keys = [...new Set([...newKeys, ...oldKeys])];
        const lab  = {};
        const skipped = [], processed = [];

        for (const key of keys) {
          if (key.includes('blacklist:') || key.includes('crown:')) continue;
          const raw = await redis.get(key);
          if (!raw) continue;
          const d     = typeof raw === 'string' ? JSON.parse(raw) : raw;
          // Handle both key formats
          const cleanKey = key.replace('qbot:strat:', '').replace('qbot:learn:', '');
          const parts = cleanKey.split(':');
          const inst  = parts[0];
          const strat = parts.slice(1).join(':') || 'LEGACY';
          const normInst = INST_NORMALIZE[inst] || INST_NORMALIZE[(inst||'').toUpperCase()] || null;
          if (!normInst) { skipped.push({key, reason:'unknown_inst', inst}); continue; }
          if (!strat || strat === 'broad') { skipped.push({key, reason:'no_strat'}); continue; }
          if (!lab[strat]) lab[strat] = {};
          const instKey = normInst; // canonical instrument key

          const total = (d.wins||0) + (d.losses||0);
          const wr    = total > 0 ? Math.round(((d.wins||0)/total)*100) : null;

          // Ban: 3 consecutive losses
          const recentResults = (d.trades||[]).slice(-3).map(t=>t.won);
          const banned = recentResults.length >= BAN_LOSSES && recentResults.every(r=>r===false);

          // Crown: 5+ wins AND not currently banned
          const hasCrown = (d.wins||0) >= CROWN_THRESHOLD && !banned;

          // Post-crown dethrone: if crowned, track losses since crown was earned
          const dethroned = hasCrown && (d.postCrownLosses||0) >= DETHRONE_LOSSES;

          processed.push(key); lab[strat][instKey] = {
            wins: d.wins||0, losses: d.losses||0, total, winRate: wr,
            avgPnl: d.totalPnl && total>0 ? parseFloat((d.totalPnl/total).toFixed(2)) : null,
            crown: hasCrown && !dethroned,
            dethroned, banned,
            consecutiveLosses: d.consecutiveLosses||0,
            postCrownLosses: d.postCrownLosses||0,
            lastSeen: d.lastSeen,
            trades: (d.trades||[]).slice(-5),
          };
        }

        // ── Load crown locks per instrument ────────────────────────────
        // crown lock = which strategy is THE primary for each instrument
        const crownLocks = {};
        for (const inst of INSTRUMENTS) {
          const ck = `qbot:strat:crown:${inst}`;
          const cr = await redis.get(ck).catch(()=>null);
          if (cr) crownLocks[inst] = typeof cr==='string' ? JSON.parse(cr) : cr;
        }

        // ── Global blacklist ────────────────────────────────────────────
        const blRaw     = await redis.get('qbot:strat:blacklist:global').catch(()=>null);
        const blacklist = blRaw ? (typeof blRaw==='string'?JSON.parse(blRaw):blRaw) : [];

        // ── Build summary ───────────────────────────────────────────────
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
            crowns: crownCount,
            bannedOn,
            isBlacklisted: blacklist.includes(strat),
            isLocked,
          };
        }

        // ── Flatten trades for analytics ────────────────────────────────
        const now      = new Date();
        const allT     = Object.values(lab).flatMap(s=>Object.values(s).flatMap(d=>d.trades||[]));
        const isTdy    = d => new Date(d).toDateString()===now.toDateString();
        const isWk     = d => (now-new Date(d))/864e5<=7;
        const isMth    = d => { const dt=new Date(d); return dt.getMonth()===now.getMonth()&&dt.getFullYear()===now.getFullYear(); };
        const cmp      = arr => { const w=arr.filter(t=>t.won).length; return { trades:arr.length,wins:w,losses:arr.length-w,winRate:arr.length>0?Math.round((w/arr.length)*100):0,pnl:parseFloat((arr.reduce((s,t)=>s+(t.pnl||0),0)).toFixed(2)) }; };
        const sessStat = {};
        allT.forEach(t=>{ const s=t.session||'UNKNOWN'; if(!sessStat[s])sessStat[s]={trades:0,wins:0,pnl:0}; sessStat[s].trades++;if(t.won)sessStat[s].wins++;sessStat[s].pnl+=(t.pnl||0); });
        const sessOut  = {};
        Object.entries(sessStat).forEach(([s,d])=>{ sessOut[s]={...d,winRate:d.trades>0?Math.round((d.wins/d.trades)*100):0,pnl:parseFloat(d.pnl.toFixed(2))}; });
        const tpFlow   = { tp1Pct:allT.length?Math.round(allT.filter(t=>t.tp1Hit).length/allT.length*100):0, tp2Pct:allT.filter(t=>t.tp1Hit).length?Math.round(allT.filter(t=>t.tp2Hit).length/allT.filter(t=>t.tp1Hit).length*100):0, tp3Pct:allT.filter(t=>t.tp2Hit).length?Math.round(allT.filter(t=>t.tp3Hit).length/allT.filter(t=>t.tp2Hit).length*100):0 };

        // ── debug ──
        console.log('Lab build:', processed.length, 'processed,', skipped.length, 'skipped');
        console.log('Skipped sample:', JSON.stringify(skipped.slice(0,5)));
        console.log('Summary keys:', Object.keys(summary).slice(0,5));

        return res.status(200).json({
          lab: summary,
          _debug: { processed: processed.length, skipped: skipped.slice(0,10), summaryCount: Object.keys(summary).length },
          crownLocks,   // { XAUUSD: "ICT_FVG+TREND_H4", BTCUSDT: null, GBPUSD: null }
          blacklist,
          totalStrategiesTried: Object.keys(summary).length,
          analytics: { all:cmp(allT), daily:cmp(allT.filter(t=>isTdy(t.date))), weekly:cmp(allT.filter(t=>isWk(t.date))), monthly:cmp(allT.filter(t=>isMth(t.date))), sessions:sessOut, tpFlow },
        });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── POST: record a strategy result ──────────────────────────────────
    if (req.method === 'POST') {
      try {
        const body = typeof req.body==='string' ? JSON.parse(req.body) : (req.body||{});
        const { instrument, direction, won, pnl, pips, rr, strategy, session,
                tp1Hit, tp2Hit, tp3Hit, beMoved, confidence,
                closeTime, openPrice, closePrice, volume } = body;

        if (!instrument || !direction || !strategy || won===undefined)
          return res.status(400).json({ error: 'Missing required fields' });

        const now = new Date().toISOString();
        // Normalize instrument name before writing
        const normInstrument = INST_NORMALIZE[instrument] || INST_NORMALIZE[(instrument||'').toUpperCase()] || instrument;
        const key = `qbot:strat:${normInstrument}:${strategy}`;
        const existing = await redis.get(key).catch(()=>null);
        const cur = existing ? (typeof existing==='string'?JSON.parse(existing):existing)
                             : { wins:0, losses:0, totalPnl:0, consecutiveLosses:0, postCrownLosses:0, trades:[] };

        const newConsec = won ? 0 : (cur.consecutiveLosses||0)+1;
        const wasCrowned = (cur.wins||0) >= CROWN_THRESHOLD;

        // Post-crown losses: only count losses that happen AFTER crown was earned
        const newPostCrownLosses = wasCrowned
          ? (won ? 0 : (cur.postCrownLosses||0)+1)
          : 0;

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
            date:closeTime||now,
            openPrice:openPrice||null, closePrice:closePrice||null,
            volume:volume||0.1,
          }],
        };

        await redis.set(key, JSON.stringify(updated), { ex: 60*60*24*120 });

        const newTotalWins = updated.wins;
        const justCrowned  = !wasCrowned && newTotalWins >= CROWN_THRESHOLD;
        const dethroned    = wasCrowned  && newPostCrownLosses >= DETHRONE_LOSSES;
        const banned       = newConsec   >= BAN_LOSSES;

        // ── Crown lock: earn it ──────────────────────────────────────────
        let crownLockSet = false;
        if (justCrowned) {
          const ck    = `qbot:strat:crown:${instrument}`;
          const curCr = await redis.get(ck).catch(()=>null);
          // Only lock if no strategy is already crowned on this instrument
          if (!curCr) {
            await redis.set(ck, JSON.stringify(strategy), { ex: 60*60*24*365 });
            crownLockSet = true;
            console.log(`👑 CROWN LOCKED: ${strategy} on ${instrument}`);
          }
        }

        // ── Crown dethrone ───────────────────────────────────────────────
        let dethroneOccurred = false;
        if (dethroned) {
          const ck    = `qbot:strat:crown:${instrument}`;
          const curCr = await redis.get(ck).catch(()=>null);
          const lockedStrat = curCr ? (typeof curCr==='string'?JSON.parse(curCr):curCr) : null;
          if (lockedStrat === strategy) {
            await redis.del(ck);
            dethroneOccurred = true;
            console.log(`💔 CROWN DETHRONED: ${strategy} on ${instrument} (${DETHRONE_LOSSES} consecutive losses post-crown)`);
          }
        }

        // ── Global blacklist: banned on all 3 ───────────────────────────
        let globallyBlacklisted = false;
        if (!won && banned) {
          const others = INSTRUMENTS.filter(i=>i!==instrument);
          const checks = await Promise.all(others.map(async inst=>{
            const r = await redis.get(`qbot:strat:${INST_NORMALIZE[inst]||inst}:${strategy}`).catch(()=>null);
            if (!r) return false;
            const d = typeof r==='string'?JSON.parse(r):r;
            return (d.consecutiveLosses||0) >= BAN_LOSSES;
          }));
          if (checks.every(b=>b)) {
            const blRaw = await redis.get('qbot:strat:blacklist:global').catch(()=>null);
            const bl    = blRaw ? (typeof blRaw==='string'?JSON.parse(blRaw):blRaw) : [];
            if (!bl.includes(strategy)) {
              bl.push(strategy);
              await redis.set('qbot:strat:blacklist:global', JSON.stringify(bl), { ex: 60*60*24*180 });
              globallyBlacklisted = true;
              console.log(`⛔ BLACKLISTED: ${strategy}`);
            }
          }
        }

        const total = updated.wins + updated.losses;
        return res.status(200).json({
          success: true, strategy, instrument,
          result: won ? 'WIN' : 'LOSS',
          stats: { wins:updated.wins, losses:updated.losses, total, winRate:total>0?Math.round((updated.wins/total)*100):null },
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
      if (!INSTRUMENTS.includes(trade.instrument)) return res.status(400).json({ error:'Invalid instrument' });
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
      await redis.set('quantum:trades', []); await redis.set('quantum:stats', { total:0,wins:0,pnl:0,winRate:'0.0' });
      return res.status(200).json({ success:true });
    }
    return res.status(405).json({ error:'Method not allowed' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};