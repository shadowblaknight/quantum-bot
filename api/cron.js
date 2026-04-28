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
  // V9.6: Cut late NY (18-21 UTC). After London close, liquidity drops and
  // fakeouts dominate -- proven loser zone in our backfilled data.
  // Tradeable hours: London open + London/NY overlap + early NY only.
  return utcH >= 8 && utcH < 18;
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

      // V9.3: Hard gate -- if ALL timeframes came back empty, the broker-candles
      // endpoint is broken or the symbol resolution is wrong. Calling the AI with
      // "no data" strings just wastes tokens and makes it say WAIT. Skip and log.
      const totalCandles = m1d.length + m5d.length + m15d.length + h1d.length + h4d.length + d1d.length + wkd.length;
      if (totalCandles === 0) {
        console.error('[CRON] ' + sym + ' ALL candle timeframes empty -- broker-candles endpoint broken or symbol unknown to broker');
        summary.errors.push({ sym, where: 'candles', error: 'all timeframes empty -- check /api/broker-candles for this symbol' });
        continue;
      }
      if (m1d.length < 15) {
        console.warn('[CRON] ' + sym + ' M1 has only ' + m1d.length + ' candles, ATR will be inaccurate');
      }

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

        // V9.3: Fetch current market price to verify the new SL won't be already
        // breached (broker rejects modify with "validation failed" if SL is on
        // wrong side of current price, which is what caused your TP correction failures).
        let livePrice = null;
        try {
          const pr = await fetch(SELF_BASE + '/api/broker-price?symbol=' + encodeURIComponent(sym));
          if (pr.ok) { const pd = await pr.json(); livePrice = pd.price; }
        } catch (_) {}

        const proposedSL = parseFloat((fill - sign * slDist).toFixed(fdp));

        // If price already moved past where the new SL would be, skip the correction
        // to avoid broker rejection. Broker SL/TP from execute.js stays in place.
        let slSafe = true;
        if (livePrice) {
          if (dec.decision === 'LONG' && livePrice <= proposedSL) slSafe = false;
          if (dec.decision === 'SHORT' && livePrice >= proposedSL) slSafe = false;
        }

        if (!slSafe) {
          console.warn('[CRON] ' + sym + ' skipping TP correction -- live price ' + livePrice + ' already past proposed SL ' + proposedSL);
          // Still store the ladder in Redis so manage-trades can track TPs,
          // but don't try to modify broker SL.
          const corr = {
            positionId: ex.positionId, instrument: sym, direction: dec.decision, fillPrice: fill,
            tp1: parseFloat((fill + sign * pips[0]).toFixed(fdp)),
            tp2: parseFloat((fill + sign * pips[1]).toFixed(fdp)),
            tp3: parseFloat((fill + sign * pips[2]).toFixed(fdp)),
            tp4: parseFloat((fill + sign * pips[3]).toFixed(fdp)),
            sl: null,  // skip SL modify
          };
          await fetch(SELF_BASE + '/api/manage-trades', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correctTPs: corr }),
          }).catch(() => {});
        } else {
          const corr = {
            positionId: ex.positionId, instrument: sym, direction: dec.decision, fillPrice: fill,
            tp1: parseFloat((fill + sign * pips[0]).toFixed(fdp)),
            tp2: parseFloat((fill + sign * pips[1]).toFixed(fdp)),
            tp3: parseFloat((fill + sign * pips[2]).toFixed(fdp)),
            tp4: parseFloat((fill + sign * pips[3]).toFixed(fdp)),
            sl:  proposedSL,
          };
          await fetch(SELF_BASE + '/api/manage-trades', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correctTPs: corr }),
          }).catch(() => {});
        }
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
        // V9.6: Backfill TP ladder. Prefer broker TP as TP4 reference.
        // If broker has no TP (only SL), derive from SL distance (assume 1:2 R:R).
        if (pos.openPrice && (pos.takeProfit || pos.stopLoss)) {
          const sign = pos.type === 'POSITION_TYPE_BUY' ? 1 : -1;
          let tp4Ref;
          if (pos.takeProfit) {
            tp4Ref = pos.takeProfit;
          } else {
            // No broker TP -- estimate TP4 as 2x SL distance from entry
            const slDist = Math.abs(pos.openPrice - pos.stopLoss);
            tp4Ref = pos.openPrice + sign * slDist * 2;
            console.log('[CRON] ' + posId + ' no broker TP, estimating TP4 at 2:1 R:R from SL');
          }
          const tp1Dist = Math.abs(tp4Ref - pos.openPrice);
          managePos.push({
            id: posId, symbol: pos.symbol, openPrice: pos.openPrice, currentPrice: pos.currentPrice,
            stopLoss: pos.stopLoss, volume: pos.volume,
            direction: pos.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT',
            tp1: pos.openPrice + sign * tp1Dist * 0.25,
            tp2: pos.openPrice + sign * tp1Dist * 0.50,
            tp3: pos.openPrice + sign * tp1Dist * 0.75,
            tp4: tp4Ref,
          });
        } else {
          console.warn('[CRON] ' + posId + ' cannot manage: no openPrice or no SL/TP');
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

  // ====================================================================
  // V9.5: Detect closed positions and record them in the strategy lab.
  // Without this, cron-placed trades never update the lab when they close.
  // Strategy: store {id -> minimal info} in v9:cron_last_pos. Each cycle,
  // diff against current open positions. Closed = was-open last, gone now.
  // Fetch closed-trade profit from /api/history.
  // ====================================================================
  try {
    const lastSnapRaw = await redis.get('v9:cron_last_pos').catch(() => null);
    const lastSnap = safe(lastSnapRaw);
    const lastMap = (lastSnap && typeof lastSnap === 'object' && !Array.isArray(lastSnap)) ? lastSnap : {};

    // Build current map { positionId -> { symbol, type, openPrice } }
    const currentMap = {};
    for (const p of openPositions) {
      const pid = p.id || p.positionId;
      if (!pid) continue;
      currentMap[String(pid)] = {
        symbol:    p.symbol,
        type:      p.type,
        openPrice: p.openPrice,
        comment:   p.comment || p.tradeComment || '',
      };
    }

    // Find positions that disappeared (closed)
    const closedIds = Object.keys(lastMap).filter(id => !currentMap[id]);

    if (closedIds.length > 0) {
      console.log('[CRON][CLOSED] detected ' + closedIds.length + ' closed position(s): ' + closedIds.join(','));

      // Fetch recent history once to find profits for closed positions
      let history = [];
      try {
        const hR = await fetch(SELF_BASE + '/api/history?limit=100');
        if (hR.ok) { const hD = await hR.json(); history = Array.isArray(hD.trades) ? hD.trades : []; }
      } catch (e) { console.warn('[CRON][CLOSED] history fetch failed: ' + e.message); }

      // Determine current session (for recording)
      const nowForSess = new Date();
      const hr = nowForSess.getUTCHours() + nowForSess.getUTCMinutes() / 60;
      const session = (hr >= 13 && hr < 16) ? 'OVERLAP'
                    : (hr >= 13 && hr < 21) ? 'NEW YORK'
                    : (hr >=  8 && hr < 16) ? 'LONDON'
                    : 'ASIAN';

      for (const closedId of closedIds) {
        const wasOpen = lastMap[closedId];
        if (!wasOpen) continue;

        // Extract strategy from MT5 comment (set by execute.js as "QB:STRATNAME")
        const comment = wasOpen.comment || '';
        const strategy = comment.startsWith('QB:') ? comment.slice(3).trim() : null;
        if (!strategy || strategy === 'EXPLORING' || strategy === 'UNKNOWN' || strategy.length < 3) {
          console.warn('[CRON][CLOSED] skipping ' + closedId + ' -- no strategy label (comment=' + comment + ')');
          continue;
        }

        // Find profit from history
        const histEntry = history.find(h => String(h.positionId || h.id) === String(closedId));
        const pnl = histEntry ? (histEntry.profit != null ? histEntry.profit : (histEntry.pnl || 0)) : 0;

        const inst = (wasOpen.symbol || '').toUpperCase().replace('.S', '').replace('.PRO', '').trim();
        const direction = wasOpen.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT';

        try {
          const recR = await fetch(SELF_BASE + '/api/trades', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instrument: inst,
              direction,
              won: pnl > 0,
              pnl,
              strategy,
              session,
              confidence: 0,
              closeTime: new Date().toISOString(),
              openPrice: wasOpen.openPrice || null,
              closePrice: histEntry ? (histEntry.closePrice || null) : null,
              volume: histEntry ? (histEntry.volume || 0.01) : 0.01,
              positionId: closedId,
            }),
          });
          if (recR.ok) {
            const recD = await recR.json().catch(() => ({}));
            console.log('[CRON][CLOSED] recorded [' + strategy + '] ' + inst + ' ' + (pnl > 0 ? 'WIN' : 'LOSS') + ' $' + pnl.toFixed(2) +
                        (recD.justCrowned ? ' [CROWNED!]' : '') +
                        (recD.dethroned ? ' [DETHRONED]' : '') +
                        (recD.blacklisted ? ' [BLACKLISTED]' : ''));
          } else {
            console.error('[CRON][CLOSED] record FAIL ' + recR.status);
          }
        } catch (e) { console.error('[CRON][CLOSED] record error: ' + e.message); }
      }
    }

    // Update the snapshot if positions changed (avoid Redis write when nothing happened)
    const lastIds = Object.keys(lastMap).sort().join(',');
    const currIds = Object.keys(currentMap).sort().join(',');
    if (lastIds !== currIds) {
      await redis.set('v9:cron_last_pos', JSON.stringify(currentMap)).catch(() => {});
    }
  } catch (e) { console.error('[CRON][CLOSED] block error: ' + e.message); }

  // ====================================================================
  // V9.4: Daily summary at 21:00 UTC (end of NY session), weekdays only.
  // Fires ONCE per day via the v9:dailySummary:{YYYY-MM-DD} guard.
  // ====================================================================
  try {
    const nowUTC = new Date();
    const utcHour = nowUTC.getUTCHours();
    const utcDay  = nowUTC.getUTCDay(); // 0=Sun 6=Sat
    const isWeekday = utcDay >= 1 && utcDay <= 5;
    if (utcHour === 21 && isWeekday) {
      const today = nowUTC.toISOString().slice(0, 10);
      const guardKey = 'v9:daily_summary_sent:' + today;
      const alreadySent = await redis.get(guardKey).catch(() => null);
      if (!alreadySent) {
        await redis.set(guardKey, '1', { ex: 86400 * 3 }).catch(() => {});
        await sendDailySummary(SELF_BASE, redis, today);
      }
    }
  } catch (e) { console.error('[CRON][DAILY-SUMMARY] error: ' + e.message); }

  const elapsed = Date.now() - startedAt;
  console.log('[CRON] done in ' + elapsed + 'ms processed=' + summary.processed.length + ' traded=' + summary.traded.length + ' skipped=' + summary.skipped.length + ' errors=' + summary.errors.length);

  return res.status(200).json({ ok: true, elapsedMs: elapsed, summary });
};

// ====================================================================
// Daily summary builder
// ====================================================================
async function sendDailySummary(selfBase, redis, today) {
  try {
    // Read today's closed trades from /api/history
    const histR = await fetch(selfBase + '/api/history?limit=200').catch(() => null);
    if (!histR || !histR.ok) return;
    const histD = await histR.json().catch(() => ({}));
    const trades = Array.isArray(histD.trades) ? histD.trades : [];

    const todayTrades = trades.filter(t => {
      // V9.6: history.js returns `t.time` as the close timestamp. Older code
      // used `t.closeTime || t.date || t.ts` which always returned nothing,
      // so the daily summary always reported "no trades today".
      const d = t.time || t.closeTime || t.date || t.ts;
      if (!d) return false;
      return String(d).startsWith(today);
    });

    if (todayTrades.length === 0) {
      const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
      const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
      if (TG_TOKEN && TG_CHAT) {
        await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: TG_CHAT, parse_mode: 'HTML',
            text: '📊 <b>Daily Summary · ' + today + '</b>\n\n<pre>No trades today.</pre>' })
        }).catch(() => {});
      }
      return;
    }

    // Aggregate per instrument
    const perInst = {};
    const perSess = {};
    const perStrat = {};
    let totalPnl = 0, totalWins = 0, totalLosses = 0;

    for (const t of todayTrades) {
      const sym  = (t.symbol || 'UNKNOWN').toUpperCase().replace('.S', '').replace('.PRO', '');
      const sess = t.session || 'UNKNOWN';
      const strat = t.strategy || 'UNKNOWN';
      const pnl  = t.profit != null ? t.profit : (t.pnl || 0);
      const won  = pnl > 0;
      totalPnl += pnl;
      if (won) totalWins++; else totalLosses++;

      if (!perInst[sym])  perInst[sym]  = { wins: 0, losses: 0, pnl: 0, bestStrat: {}, bestSess: {} };
      perInst[sym].pnl += pnl;
      if (won) perInst[sym].wins++; else perInst[sym].losses++;
      perInst[sym].bestStrat[strat] = (perInst[sym].bestStrat[strat] || 0) + pnl;
      perInst[sym].bestSess[sess]   = (perInst[sym].bestSess[sess]   || 0) + pnl;

      if (!perSess[sess])  perSess[sess]  = { wins: 0, losses: 0, pnl: 0 };
      perSess[sess].pnl += pnl;
      if (won) perSess[sess].wins++; else perSess[sess].losses++;

      if (!perStrat[strat]) perStrat[strat] = { wins: 0, losses: 0, pnl: 0 };
      perStrat[strat].pnl += pnl;
      if (won) perStrat[strat].wins++; else perStrat[strat].losses++;
    }

    // Get today's learnings (crowns, bans, dethrones, blacklists)
    const learnings = (await redis.lrange('v9:learnings:' + today, 0, 99).catch(() => []))
      .map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch (_) { return null; } })
      .filter(Boolean);

    const crownsToday   = learnings.filter(l => l.type === 'CROWN');
    const dethronesToday = learnings.filter(l => l.type === 'DETHRONE');
    const bansToday     = learnings.filter(l => l.type === 'BAN');
    const blacklistsToday = learnings.filter(l => l.type === 'BLACKLIST');

    // Format message
    const pad = (s, w) => String(s).padEnd(w);
    const money = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);

    let msg = '📊 <b>Daily Summary · ' + today + '</b>\n\n';
    msg += '<pre>';
    msg += 'Trades:   ' + todayTrades.length + '\n';
    msg += 'Wins:     ' + totalWins + '\n';
    msg += 'Losses:   ' + totalLosses + '\n';
    msg += 'Win Rate: ' + (todayTrades.length ? Math.round(totalWins / todayTrades.length * 100) : 0) + '%\n';
    msg += 'Net P&L:  ' + money(totalPnl) + '\n';
    msg += '</pre>\n';

    // Per-instrument
    msg += '<b>By Instrument</b>\n<pre>';
    const instRows = Object.entries(perInst).sort((a, b) => b[1].pnl - a[1].pnl);
    for (const [sym, s] of instRows) {
      const bestSess  = Object.entries(s.bestSess).sort((a, b) => b[1] - a[1])[0];
      const bestStratE = Object.entries(s.bestStrat).sort((a, b) => b[1] - a[1])[0];
      msg += pad(sym, 8) + s.wins + 'W/' + s.losses + 'L ' + money(s.pnl) + '\n';
      if (bestSess)  msg += '   best sess: ' + bestSess[0] + ' ' + money(bestSess[1]) + '\n';
      if (bestStratE) msg += '   best strat: ' + bestStratE[0].slice(0, 22) + '\n';
    }
    msg += '</pre>\n';

    // Per-session
    msg += '<b>By Session</b>\n<pre>';
    const sessRows = Object.entries(perSess).sort((a, b) => b[1].pnl - a[1].pnl);
    for (const [sess, s] of sessRows) {
      msg += pad(sess, 10) + s.wins + 'W/' + s.losses + 'L ' + money(s.pnl) + '\n';
    }
    msg += '</pre>\n';

    // Top/bottom strategies
    const stratRows = Object.entries(perStrat).sort((a, b) => b[1].pnl - a[1].pnl);
    const topStrats = stratRows.slice(0, 3);
    const botStrats = stratRows.slice(-2).reverse();
    if (topStrats.length) {
      msg += '<b>Best Strategies</b>\n<pre>';
      for (const [strat, s] of topStrats) msg += pad(strat.slice(0, 22), 24) + money(s.pnl) + '\n';
      msg += '</pre>\n';
    }
    if (botStrats.length && botStrats[0][1].pnl < 0) {
      msg += '<b>Worst Strategies</b>\n<pre>';
      for (const [strat, s] of botStrats) msg += pad(strat.slice(0, 22), 24) + money(s.pnl) + '\n';
      msg += '</pre>\n';
    }

    // What the bot learned today
    if (crownsToday.length || dethronesToday.length || blacklistsToday.length) {
      msg += '<b>Learnings Today</b>\n<pre>';
      for (const c of crownsToday)      msg += '👑 CROWN     ' + c.strategy + ' on ' + c.instrument + ' (' + c.wr + '% WR)\n';
      for (const d of dethronesToday)   msg += '⚠️  DETHRONED ' + d.strategy + ' on ' + d.instrument + '\n';
      for (const b of blacklistsToday)  msg += '🚫 BLACKLIST ' + b.strategy + '\n';
      msg += '</pre>\n';
    } else {
      msg += '<i>No crown/ban changes today -- still exploring.</i>\n';
    }

    // Send
    const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
    if (TG_TOKEN && TG_CHAT) {
      await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, parse_mode: 'HTML', text: msg })
      }).catch(() => {});
      console.log('[DAILY-SUMMARY] sent for ' + today);
    }
  } catch (e) { console.error('[DAILY-SUMMARY] build error: ' + e.message); }
}