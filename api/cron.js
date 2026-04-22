/* eslint-disable */
// api/cron.js -- Quantum Bot V9.3 server-side trading loop
//
// PURPOSE: Trade 24/7 without the browser app being open.
// Reads config from Redis (v9:config), runs AI brain + manage-trades for every
// configured instrument, just like the frontend does -- but on a Vercel cron schedule.
//
// Schedule: see vercel.json. Recommended: every minute on Vercel Pro, every 5 minutes
// on free schedules. If your plan only allows daily cron, hit this URL externally
// from cron-job.org (free) or uptime robot every minute.

const { Redis } = require('@upstash/redis');

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + (process.env.METAAPI_ACCOUNT_ID || '');
const HEADERS = { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN || '' };

// Build absolute base URL for self-calls
const SELF_BASE = (() => {
  if (process.env.QB_PUBLIC_URL) return process.env.QB_PUBLIC_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL)    return 'https://' + process.env.VERCEL_URL;
  return ''; // will fail, but we log it
})();

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

const normSym = (raw) => { if (!raw) return null; return raw.toUpperCase().replace('.S', '').replace('.PRO', '').trim(); };
const instCategory = (sym) => {
  if (!sym) return 'OTHER';
  const u = sym.toUpperCase();
  if (u.includes('XAU') || u.includes('GOLD')) return 'GOLD';
  if (u.includes('BTC') || u.includes('ETH') || u.includes('CRYPTO') || u.includes('COIN')) return 'CRYPTO';
  return 'FOREX';
};

const isTradeable = (sym, utcH, isWeekend) => {
  if (!sym) return false;
  if (isWeekend) return false;
  const cat = instCategory(sym);
  if (cat === 'CRYPTO') return utcH >= 7 && utcH < 23;
  return utcH >= 8 && utcH < 21;
};

const sumC = (arr, n = 5) => {
  if (!arr || !arr.length) return 'no data';
  const sl = arr.slice(-n);
  const c = sl[sl.length - 1];
  const o = sl[0];
  if (!c || !o) return 'no data';
  const dir = c.close > o.close ? 'up' : 'down';
  const chg = (((c.close - o.close) / o.close) * 100).toFixed(3);
  const hi  = Math.max(...sl.map(x => x.high));
  const lo  = Math.min(...sl.map(x => x.low));
  const dp  = hi > 1000 ? 0 : 5;
  return dir + chg + '% H:' + hi.toFixed(dp) + ' L:' + lo.toFixed(dp);
};

// Cooldown key per instrument so we don't spam the AI
const cooldownKey = (sym) => 'v9:ai_cd:' + sym;
const tradeCooldownKey = (sym) => 'v9:trade_cd:' + sym;

module.exports = async (req, res) => {
  // Allow GET (Vercel cron uses GET) and POST (manual trigger)
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const startedAt = Date.now();
  console.log('[CRON] start ' + new Date().toISOString());

  if (!SELF_BASE) {
    console.error('[CRON] no SELF_BASE -- set QB_PUBLIC_URL env var to your deployment URL (e.g. https://quantum-bot-mocha.vercel.app)');
    return res.status(500).json({ error: 'Missing QB_PUBLIC_URL or VERCEL_URL' });
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(500).json({ error: 'Missing Redis env vars' });
  }
  if (!process.env.METAAPI_TOKEN || !process.env.METAAPI_ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing MetaAPI env vars' });
  }

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  // ---- Load config (instruments user wants traded) ----
  const cfgRaw = await redis.get('v9:config').catch(() => null);
  const cfg = safe(cfgRaw) || { instruments: [], riskMode: 'TEST', sessions: ['LONDON', 'NEW YORK'] };
  const instruments = (cfg.instruments || []).map(normSym).filter(Boolean);

  if (instruments.length === 0) {
    console.warn('[CRON] no instruments configured. Open the app, set instruments in Settings -> they will be saved to v9:config.');
    return res.status(200).json({ ok: true, message: 'No instruments configured', instruments: [] });
  }

  // ---- Time gating ----
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;

  console.log('[CRON] instruments=' + instruments.join(',') + ' utcH=' + utcH.toFixed(2) + ' weekend=' + isWeekend);

  // ---- Fetch shared state ----
  let accountBalance = 10000;
  try {
    const r = await fetch(SELF_BASE + '/api/account');
    if (r.ok) { const d = await r.json(); if (d.balance != null) accountBalance = d.balance; }
  } catch (e) { console.warn('[CRON] account fetch failed: ' + e.message); }

  let openPositions = [];
  try {
    const r = await fetch(SELF_BASE + '/api/positions');
    if (r.ok) { const d = await r.json(); openPositions = Array.isArray(d.positions) ? d.positions : []; }
  } catch (e) { console.warn('[CRON] positions fetch failed: ' + e.message); }

  let learnedStats = {}, crownLocks = {}, blacklist = [];
  try {
    const r = await fetch(SELF_BASE + '/api/trades');
    if (r.ok) { const d = await r.json(); learnedStats = d.lab || {}; crownLocks = d.crownLocks || {}; blacklist = d.blacklist || []; }
  } catch (e) { console.warn('[CRON] lab fetch failed: ' + e.message); }

  const summary = { processed: [], traded: [], skipped: [], errors: [] };

  // ====================================================================
  // 1) Run AI brain for each instrument
  // ====================================================================
  for (const sym of instruments) {
    try {
      if (!isTradeable(sym, utcH, isWeekend)) {
        summary.skipped.push({ sym, reason: 'outside hours' });
        continue;
      }

      // Cooldown check (5-min between AI cycles per instrument)
      const lastAiTs = parseInt(await redis.get(cooldownKey(sym)).catch(() => '0'), 10) || 0;
      if (Date.now() - lastAiTs < 290000) {
        summary.skipped.push({ sym, reason: 'AI cooldown' });
        continue;
      }

      // Skip if position already open on this instrument
      if (openPositions.some(p => normSym(p.symbol) === sym)) {
        summary.skipped.push({ sym, reason: 'position already open' });
        continue;
      }

      // ---- Fetch current price ----
      let price = null;
      try {
        const r = await fetch(SELF_BASE + '/api/broker-price?symbol=' + encodeURIComponent(sym));
        if (r.ok) { const d = await r.json(); price = d.price; }
      } catch (_) {}
      if (price == null) { summary.skipped.push({ sym, reason: 'no price' }); continue; }

      // ---- Fetch candles (in parallel) ----
      const tfs = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1', 'W1'];
      const lims = [60, 24, 24, 24, 20, 14, 8];
      const candles = await Promise.all(tfs.map((tf, i) =>
        fetch(SELF_BASE + '/api/broker-candles?symbol=' + encodeURIComponent(sym) + '&timeframe=' + tf + '&limit=' + lims[i])
          .then(r => r.json()).catch(() => ({ candles: [] }))
      ));
      const [m1d, m5d, m15d, h1d, h4d, d1d, wkd] = candles.map(r => r.candles || []);

      // ATR14 from M1
      let atr = 0;
      if (m1d.length >= 15) {
        const trs = m1d.slice(-14).map((c, i, a) => {
          const prev = a[Math.max(0, i - 1)];
          return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
        });
        atr = trs.reduce((s, x) => s + x, 0) / trs.length;
      }

      // ---- Session ----
      const isLondon = utcH >= 8 && utcH < 16;
      const isNY     = utcH >= 13 && utcH < 21;
      const isOverlap = utcH >= 13 && utcH < 16;
      const session = isOverlap ? 'OVERLAP' : isNY ? 'NEW YORK' : isLondon ? 'LONDON' : 'ASIAN';
      const inKillZone = (utcH >= 7 && utcH < 10) || (utcH >= 13 && utcH < 16);

      const snap = {
        price, session, balance: accountBalance, todayPnl: '0.00',
        lossStreak: 0, winStreak: 0,
        atr14: parseFloat(atr.toFixed(4)),
        weekly: sumC(wkd, 4), d1: sumC(d1d, 5), h4: sumC(h4d, 5), h1: sumC(h1d, 5),
        m15: sumC(m15d, 6), m5: sumC(m5d, 6), m1: sumC(m1d, 8),
        openCount: openPositions.filter(p => normSym(p.symbol) === sym).length,
        inKillZone,
        killZone: utcH >= 7 && utcH < 10 ? 'London 07-10' : utcH >= 13 && utcH < 16 ? 'NY 13-16' : '',
        atrGuide: atr > 0 ? 'min SL ' + (atr * 0.8).toFixed(4) : 'unknown',
      };

      // ---- Call AI ----
      const aiR = await fetch(SELF_BASE + '/api/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snap, instrument: sym, riskMode: cfg.riskMode, prevDecisions: [], lab: learnedStats, crownLocks, blacklist }),
      });
      if (!aiR.ok) { summary.errors.push({ sym, where: 'ai', status: aiR.status }); continue; }
      const dec = await aiR.json();

      // Update cooldown regardless of decision
      await redis.set(cooldownKey(sym), String(Date.now()), { ex: 600 }).catch(() => {});

      summary.processed.push({ sym, decision: dec.decision, confidence: dec.confidence, strategy: dec.strategy });
      console.log('[CRON][AI] ' + sym + ' ' + dec.decision + ' ' + (dec.confidence || 0) + '% ' + (dec.strategy || '-'));

      if (dec.decision === 'WAIT' || !dec.volume || !dec.stopLoss || !dec.takeProfit1) continue;

      // Trade cooldown (10-min between actual trades on same instrument)
      const lastTrTs = parseInt(await redis.get(tradeCooldownKey(sym)).catch(() => '0'), 10) || 0;
      if (Date.now() - lastTrTs < 600000) { summary.skipped.push({ sym, reason: 'trade cooldown' }); continue; }

      // ---- Execute ----
      const exR = await fetch(SELF_BASE + '/api/execute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrument: sym, direction: dec.decision, entry: price,
          stopLoss: dec.stopLoss,
          takeProfit: dec.takeProfit4 || dec.takeProfit3 || dec.takeProfit2 || dec.takeProfit1,
          volume: dec.volume,
          comment: 'QB:' + (dec.strategy || 'CRON').slice(0, 18),
        }),
      });
      const ex = await exR.json().catch(() => ({}));
      if (!ex.success) { summary.errors.push({ sym, where: 'execute', error: ex.error }); continue; }

      summary.traded.push({ sym, direction: dec.decision, volume: dec.volume, positionId: ex.positionId });
      await redis.set(tradeCooldownKey(sym), String(Date.now()), { ex: 1800 }).catch(() => {});

      // ---- Post-fill TP correction (re-fetch position, recalc TPs from fill) ----
      if (ex.positionId && ex.verified && ex.verified.fillPrice) {
        const fill = ex.verified.fillPrice;
        const sign = dec.decision === 'LONG' ? 1 : -1;
        const cat = instCategory(sym);
        let pips;
        if (cat === 'GOLD') pips = [5, 10, 15, 20];
        else if (cat === 'CRYPTO') { const aP = Math.max(atr * 0.5, 50); pips = [aP, aP*2, aP*3, aP*4]; }
        else { const aP = Math.max(atr * 0.5, 0.0005); pips = [aP, aP*2, aP*3, aP*4]; }
        const fdp = fill > 100 ? 2 : 5;
        const slDist = cat === 'GOLD' ? 10 : Math.max(atr * 0.8, pips[0]);
        const corr = {
          positionId: ex.positionId, instrument: sym, direction: dec.decision, fillPrice: fill,
          tp1: parseFloat((fill + sign * pips[0]).toFixed(fdp)),
          tp2: parseFloat((fill + sign * pips[1]).toFixed(fdp)),
          tp3: parseFloat((fill + sign * pips[2]).toFixed(fdp)),
          tp4: parseFloat((fill + sign * pips[3]).toFixed(fdp)),
          sl:  parseFloat((fill - sign * slDist).toFixed(fdp)),
        };
        await fetch(SELF_BASE + '/api/manage-trades', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ correctTPs: corr }),
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[CRON] ' + sym + ' error: ' + e.message);
      summary.errors.push({ sym, error: e.message });
    }
  }

  // ====================================================================
  // 2) Manage open positions (TP ladder, retrace) for ALL open positions
  // ====================================================================
  if (openPositions.length > 0) {
    // Re-fetch positions because we may have just opened new ones
    try {
      const r = await fetch(SELF_BASE + '/api/positions');
      if (r.ok) { const d = await r.json(); openPositions = Array.isArray(d.positions) ? d.positions : openPositions; }
    } catch (_) {}

    // Build manage payload from broker truth + Redis-stored TP ladders
    const managePos = [];
    for (const pos of openPositions) {
      const posId = pos.id || pos.positionId;
      if (!posId) continue;
      const stateRaw = await redis.get('v9:tp:' + posId).catch(() => null);
      const state = safe(stateRaw);
      if (!state || !state.tp1) {
        // Backfill from broker SL/TP if available
        if (pos.stopLoss && pos.takeProfit && pos.openPrice) {
          const sign = pos.type === 'POSITION_TYPE_BUY' ? 1 : -1;
          const tp1Dist = Math.abs(pos.takeProfit - pos.openPrice);
          managePos.push({
            id: posId, symbol: pos.symbol, openPrice: pos.openPrice, currentPrice: pos.currentPrice,
            stopLoss: pos.stopLoss, volume: pos.volume,
            direction: pos.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT',
            tp1: pos.openPrice + sign * tp1Dist * 0.25,
            tp2: pos.openPrice + sign * tp1Dist * 0.50,
            tp3: pos.openPrice + sign * tp1Dist * 0.75,
            tp4: pos.takeProfit,
          });
        }
        continue;
      }
      managePos.push({
        id: posId, symbol: pos.symbol, openPrice: pos.openPrice, currentPrice: pos.currentPrice,
        stopLoss: pos.stopLoss, volume: pos.volume,
        direction: pos.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT',
        tp1: state.tp1, tp2: state.tp2, tp3: state.tp3, tp4: state.tp4,
      });
    }

    if (managePos.length > 0) {
      try {
        const mR = await fetch(SELF_BASE + '/api/manage-trades', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positions: managePos }),
        });
        const mD = await mR.json().catch(() => ({}));
        if (mD.managed && mD.managed.length) {
          summary.managed = mD.managed;
          console.log('[CRON][MANAGE] ' + mD.managed.length + ' position(s) had actions');
        }
      } catch (e) { summary.errors.push({ where: 'manage-trades', error: e.message }); }
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log('[CRON] done in ' + elapsed + 'ms processed=' + summary.processed.length + ' traded=' + summary.traded.length + ' skipped=' + summary.skipped.length + ' errors=' + summary.errors.length);

  return res.status(200).json({ ok: true, elapsedMs: elapsed, summary });
};