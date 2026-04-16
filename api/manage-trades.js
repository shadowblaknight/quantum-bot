/* eslint-disable */
const { Redis } = require('@upstash/redis');

// ── Session detection ──
const getSession = () => {
  const h = new Date().getUTCHours();
  const inLondon = h >= 7  && h < 16;
  const inNY     = h >= 13 && h < 22;
  if (inLondon && inNY) return 'LONDON_NY_OVERLAP';
  if (inLondon) return 'LONDON';
  if (inNY)     return 'NEW_YORK';
  return 'ASIA';
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN      = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;

  let redis = null;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  }

  // ── Telegram helper ──
  const sendTelegram = async (msg) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat  = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML', disable_notification: false }),
      });
    } catch(e) { console.error('Telegram error:', e.message); }
  };

  // ── Rich Telegram message builders ──
  const tgEntry = (sym, dir, price, sl, tp1, tp2, tp3, vol, conf, reason) => {
    const emoji = dir === 'LONG' ? '📈🟢' : '📉🔴';
    const slPips = Math.abs(price - sl).toFixed(2);
    const rr = tp3 ? (Math.abs(tp3 - price) / Math.abs(price - sl)).toFixed(1) : '—';
    return `${emoji} <b>NEW TRADE — ${sym}</b>
━━━━━━━━━━━━━━━━━━━━
Direction: <b>${dir}</b>  |  Size: <b>${vol} lots</b>
Entry:  <b>$${parseFloat(price).toFixed(2)}</b>
SL:     <b>$${parseFloat(sl).toFixed(2)}</b> (${slPips} pips)
TP1:    <b>$${parseFloat(tp1).toFixed(2)}</b> → 50% close
TP2:    <b>$${parseFloat(tp2||0).toFixed(2)}</b> → 30% close
TP3:    <b>$${parseFloat(tp3||0).toFixed(2)}</b> → 20% runner
R/R:    <b>1:${rr}</b>
━━━━━━━━━━━━━━━━━━━━
Confidence: <b>${conf||'—'}%</b>
💬 ${reason||''}
⏰ ${new Date().toUTCString()}`;
  };

  const tgTP1 = (sym, dir, price, pnl, entry, tp2, tp3) => {
    const progress = tp2 ? Math.abs(price - entry) / Math.abs(tp3 - entry) * 100 : 0;
    const tp1Dist = Math.abs(price - parseFloat(entry));
    const lockLevel = dir === 'LONG'
      ? parseFloat(entry) + tp1Dist * 0.30
      : parseFloat(entry) - tp1Dist * 0.30;
    return `🎯 <b>TP1 HIT — ${sym}</b>
━━━━━━━━━━━━━━━━━━━━
${dir} @ entry $${parseFloat(entry).toFixed(2)}
Closed 40% @ <b>$${parseFloat(price).toFixed(2)}</b>
Secured: <b>+$${parseFloat(pnl).toFixed(2)}</b>
🔒 SL locked at <b>$${lockLevel.toFixed(2)}</b> (+30% of TP1 — guaranteed profit)
━━━━━━━━━━━━━━━━━━━━
Next target TP2: <b>$${parseFloat(tp2||0).toFixed(2)}</b>
Progress to TP3: ${progress.toFixed(0)}%`;
  };

  const tgTP2 = (sym, dir, price, pnl, entry, tp1pnl, tp3) => {
    return `🎯🎯 <b>TP2 HIT — ${sym}</b>
━━━━━━━━━━━━━━━━━━━━
${dir} @ entry $${parseFloat(entry).toFixed(2)}
Closed 30% @ <b>$${parseFloat(price).toFixed(2)}</b>
This close: <b>+$${parseFloat(pnl).toFixed(2)}</b>
Total secured: <b>+$${(parseFloat(pnl)+(tp1pnl||0)).toFixed(2)}</b>
🔒 Stop trailed to protect profits
━━━━━━━━━━━━━━━━━━━━
🏃 20% runner still open → TP3: <b>$${parseFloat(tp3||0).toFixed(2)}</b>`;
  };

  const tgTP3 = (sym, dir, price, pnl, entry, totalPnl) => {
    return `🏆 <b>TRADE COMPLETE — ${sym}</b>
━━━━━━━━━━━━━━━━━━━━
${dir} @ entry $${parseFloat(entry).toFixed(2)}
Closed 100% @ <b>$${parseFloat(price).toFixed(2)}</b>
━━━━━━━━━━━━━━━━━━━━
TP1: ✅  TP2: ✅  TP3: ✅  (TP4 runner active)
<b>TOTAL P&L: +$${parseFloat(totalPnl||pnl).toFixed(2)}</b>
━━━━━━━━━━━━━━━━━━━━
🤖 Quantum Bot V5.2 | ${new Date().toUTCString()}`;
  };

  const tgSLHit = (sym, dir, price, pnl, entry, tp1Hit) => {
    return `🛑 <b>STOP LOSS HIT — ${sym}</b>
━━━━━━━━━━━━━━━━━━━━
${dir} @ entry $${parseFloat(entry).toFixed(2)}
Stopped @ <b>$${parseFloat(price).toFixed(2)}</b>
${tp1Hit ? '✅ TP1 was secured before SL' : '❌ No TPs hit'}
P&L: <b>$${parseFloat(pnl).toFixed(2)}</b>
━━━━━━━━━━━━━━━━━━━━
🤖 Bot continues monitoring market`;
  };

  const tgWait = (reason, conf) =>
    `⏸ <b>WAIT</b> — Confidence: ${conf||'—'}%
💬 ${reason||'Setup not clear enough'}`;

  // ══════════════════════════════════════════════════════════════════════════
  // GET — fetch reports + analytics
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method === 'GET') {
    try {
      if (!redis) return res.status(500).json({ error: 'Redis not configured' });

      const listKey = 'qbot:reports:list';
      const list    = await redis.get(listKey).catch(() => null);
      const keys    = list ? (typeof list === 'string' ? JSON.parse(list) : list) : [];

      const reports = [];
      for (const key of keys.slice(0, 100)) {
        try {
          const r = await redis.get(key);
          if (r) reports.push(typeof r === 'string' ? JSON.parse(r) : r);
        } catch(e) {}
      }

      // ── Base analytics ──
      const totalTrades = reports.length;
      const tp1Count    = reports.filter(r => r.tp1Hit || r.events?.some(e => e.type === 'PARTIAL_CLOSE_TP1')).length;
      const tp2Count    = reports.filter(r => r.tp2Hit || r.events?.some(e => e.type === 'PARTIAL_CLOSE_TP2')).length;
      const tp3Count    = reports.filter(r => r.tp3Hit || r.events?.some(e => e.type === 'FULL_CLOSE_TP3')).length;
      const slHitCount  = reports.filter(r => r.finalExit === 'SL_HIT').length;
      const beCount     = reports.filter(r => r.beMoved).length;

      const tp1Pct = totalTrades > 0 ? Math.round((tp1Count / totalTrades) * 100) : 0;
      const tp2Pct = tp1Count > 0    ? Math.round((tp2Count / tp1Count)    * 100) : 0;
      const tp3Pct = tp2Count > 0    ? Math.round((tp3Count / tp2Count)    * 100) : 0;
      const bePct  = tp1Count > 0    ? Math.round((beCount  / tp1Count)    * 100) : 0;

      const totalPnl = reports.reduce((s, r) => s + (r.totalPnl || 0), 0);
      const avgPnl   = totalTrades > 0 ? totalPnl / totalTrades : 0;

      // ── Session analytics ──
      const sessionMap = {};
      for (const r of reports) {
        const s = r.session || 'UNKNOWN';
        if (!sessionMap[s]) sessionMap[s] = { trades: 0, wins: 0, pnl: 0, tp1: 0, tp2: 0, tp3: 0 };
        sessionMap[s].trades++;
        if ((r.totalPnl || 0) > 0) sessionMap[s].wins++;
        sessionMap[s].pnl  += (r.totalPnl || 0);
        if (r.tp1Hit) sessionMap[s].tp1++;
        if (r.tp2Hit) sessionMap[s].tp2++;
        if (r.tp3Hit) sessionMap[s].tp3++;
      }
      const sessions = {};
      for (const [s, d] of Object.entries(sessionMap)) {
        sessions[s] = {
          ...d,
          pnl:     parseFloat(d.pnl.toFixed(2)),
          winRate: d.trades > 0 ? Math.round((d.wins / d.trades) * 100) : 0,
          tp1Pct:  d.trades > 0 ? Math.round((d.tp1  / d.trades) * 100) : 0,
          tp2Pct:  d.tp1    > 0 ? Math.round((d.tp2  / d.tp1)    * 100) : 0,
          tp3Pct:  d.tp2    > 0 ? Math.round((d.tp3  / d.tp2)    * 100) : 0,
        };
      }

      // ── Time-based analytics ──
      const now = new Date();
      const isToday = (d) => { const dt = new Date(d); return dt.toDateString() === now.toDateString(); };
      const isWeek  = (d) => (now - new Date(d)) / 864e5 <= 7;
      const isMth   = (d) => { const dt = new Date(d); return dt.getMonth()===now.getMonth() && dt.getFullYear()===now.getFullYear(); };

      const summarize = (arr) => {
        const wins = arr.filter(r => (r.totalPnl||0) > 0).length;
        const pnl  = arr.reduce((s,r) => s+(r.totalPnl||0), 0);
        return { trades: arr.length, wins, losses: arr.length-wins,
          winRate: arr.length > 0 ? Math.round((wins/arr.length)*100) : 0,
          pnl: parseFloat(pnl.toFixed(2)) };
      };

      const daily   = summarize(reports.filter(r => isToday(r.openedAt || r.closedAt)));
      const weekly  = summarize(reports.filter(r => isWeek(r.openedAt  || r.closedAt)));
      const monthly = summarize(reports.filter(r => isMth(r.openedAt   || r.closedAt)));

      // ── By instrument ──
      const byInstrument = {};
      for (const r of reports) {
        const sym = (r.symbol||'UNKNOWN').replace('.s','').replace('.S','');
        if (!byInstrument[sym]) byInstrument[sym] = { trades:0, tp1:0, tp2:0, tp3:0, pnl:0 };
        byInstrument[sym].trades++;
        if (r.tp1Hit) byInstrument[sym].tp1++;
        if (r.tp2Hit) byInstrument[sym].tp2++;
        if (r.tp3Hit) byInstrument[sym].tp3++;
        byInstrument[sym].pnl = parseFloat((byInstrument[sym].pnl+(r.totalPnl||0)).toFixed(2));
      }

      return res.status(200).json({
        reports: reports.slice(0,50),
        analytics: {
          totalTrades,
          tp1Count, tp1Pct,
          tp2Count, tp2Pct,
          tp3Count, tp3Pct,
          slHitCount,
          beCount,   bePct,
          totalPnl: parseFloat(totalPnl.toFixed(2)),
          avgPnl:   parseFloat(avgPnl.toFixed(2)),
          byInstrument,
          sessions,
          daily, weekly, monthly,
        },
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // POST — manage open positions
  // ══════════════════════════════════════════════════════════════════════════
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!TOKEN || !ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars' });

  const body = req.body || {};

  // ── Handle entry notification ──
  if (body.telegramEntry) {
    const { symbol, direction, price, sl, tp1, tp2, tp3, volume, confidence, reason } = body.telegramEntry;
    await sendTelegram(tgEntry(symbol, direction, price, sl, tp1, tp2, tp3, volume, confidence, reason));
    return res.status(200).json({ ok: true });
  }

  const { positions } = body;
  if (!Array.isArray(positions) || positions.length === 0) {
    return res.status(200).json({ managed: [], message: 'No positions to manage' });
  }

  const BASE    = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${ACCOUNT_ID}`;
  const headers = { 'auth-token': TOKEN, 'Content-Type': 'application/json' };

  // Contract multiplier per instrument — verified against real PU Prime MT5 data
  // BTC:  1 lot = 1 BTC,        price_move × lots × 1       = USD PnL
  // XAU:  1 lot = 100 oz Gold,  price_move × lots × 100     = USD PnL
  // GBP:  1 lot = 100k units,   price_move × lots × 100000  = USD PnL
  const getMultiplier = (sym) => {
    const s = (sym||'').toUpperCase();
    if (s.includes('BTC'))  return 1;
    if (s.includes('XAU'))  return 100;
    if (s.includes('GBP'))  return 100000;
    if (s.includes('EUR'))  return 100000;
    if (s.includes('JPY'))  return 1000;
    return 100; // default Gold-like
  };

  // ── Save / update report in Redis ──
  const saveReport = async (report) => {
    if (!redis) return;
    try {
      const key      = `qbot:report:${report.positionId}`;
      const existing = await redis.get(key).catch(() => null);
      const current  = existing
        ? (typeof existing === 'string' ? JSON.parse(existing) : existing)
        : {
            positionId: report.positionId,
            symbol:     report.symbol,
            direction:  report.direction,
            session:    getSession(),
            openPrice:  report.openPrice,
            volume:     report.volume,
            tp1: report.tp1, tp2: report.tp2, tp3: report.tp3,
            tp1Hit: false, tp2Hit: false, tp3Hit: false,
            beMoved: false,
            openedAt:  new Date().toISOString(),
            closedAt:  null,
            events:    [],
            finalExit: null,
            totalPnl:  0,
          };

      // Track TP hits
      if (report.eventType === 'PARTIAL_CLOSE_TP1') current.tp1Hit = true;
      if (report.eventType === 'PARTIAL_CLOSE_TP2') current.tp2Hit = true;
      if (report.eventType === 'FULL_CLOSE_TP3')    current.tp3Hit = true;
      if (report.eventType === 'SL_TO_BREAKEVEN')   current.beMoved = true;

      current.events.push({
        type: report.eventType, price: report.price,
        volume: report.volume, pnl: report.pnl || 0,
        timestamp: new Date().toISOString(),
      });

      if (['FULL_CLOSE_TP3','SL_HIT','MANUAL_CLOSE'].includes(report.eventType)) {
        current.finalExit = report.eventType;
        current.closedAt  = new Date().toISOString();
      }

      current.totalPnl = parseFloat(((current.totalPnl||0)+(report.pnl||0)).toFixed(2));
      await redis.set(key, JSON.stringify(current), { ex: 60*60*24*30 });

      const listKey = 'qbot:reports:list';
      const list    = await redis.get(listKey).catch(() => null);
      const arr     = list ? (typeof list === 'string' ? JSON.parse(list) : list) : [];
      if (!arr.includes(key)) arr.unshift(key);
      await redis.set(listKey, JSON.stringify(arr.slice(0,200)));
    } catch(e) {
      console.error('Report save error:', e.message);
    }
  };

  const managed = [];

  for (const pos of positions) {
    const { id, symbol, openPrice, currentPrice, stopLoss, volume, direction, tp1, tp2, tp3, tp4, breakeven } = pos;
    if (!id || !currentPrice || !openPrice || !tp1) continue;

    const result = { id, symbol, actions: [] };

    try {
      const stateKey = `tp_state:${id}`;
      let state = { tp1Hit: false, tp2Hit: false, tp3Hit: false, beSet: false };

      if (redis) {
        try {
          const saved = await redis.get(stateKey);
          if (saved) state = typeof saved === 'string' ? JSON.parse(saved) : saved;
        } catch(e) {}
      }

      const profit_distance = direction === 'LONG' ? currentPrice - openPrice : openPrice - currentPrice;
      const tp1_distance    = Math.abs(tp1 - openPrice);
      const tp2_distance    = tp2 ? Math.abs(tp2 - openPrice) : null;
      const tp3_distance    = tp3 ? Math.abs(tp3 - openPrice) : null;
      const tp4_distance    = tp4 ? Math.abs(tp4 - openPrice) : null;

      // ── TP1: Close 50% + SL to breakeven ──
      if (!state.tp1Hit && profit_distance >= tp1_distance * 0.95) {
        const closeVolume = Math.max(0.01, Math.round((volume * 0.4) / 0.01) * 0.01); // 40% at TP1
        const pnl = parseFloat((profit_distance * closeVolume * getMultiplier(symbol)).toFixed(2));

        const closeRes  = await fetch(`${BASE}/trade`, {
          method: 'POST', headers,
          body: JSON.stringify({ actionType: 'POSITION_PARTIAL', positionId: id, volume: closeVolume, comment: 'QuantumBot:TP1_50pct' })
        });
        const closeData = await closeRes.json();

        if (closeRes.ok && (closeData.orderId || closeData.positionId)) {
          result.actions.push({ type: 'PARTIAL_CLOSE_TP1', volume: closeVolume, price: currentPrice, pnl });
          state.tp1Hit = true;
          await saveReport({ positionId: id, symbol, direction, openPrice, volume: closeVolume,
            tp1, tp2, tp3, eventType: 'PARTIAL_CLOSE_TP1', price: currentPrice, pnl });

          // Send Telegram
          await sendTelegram(tgTP1(symbol, direction, currentPrice, pnl, openPrice, tp2, tp3));

          // Move SL to entry + 30% of TP1 distance — locks profit on remaining 60%
          // Formula: if LONG entry=4800 TP1=4820 → lock SL at 4800 + (4820-4800)*0.30 = 4806
          // If price reverses after TP1, we still keep at least 30% of TP1 profit on remaining position
          const tp1Dist = Math.abs(tp1 - openPrice);
          const lockPct  = 0.30; // lock 30% of TP1 distance as guaranteed minimum profit
          const lockedSL = direction === 'LONG'
            ? openPrice + tp1Dist * lockPct
            : openPrice - tp1Dist * lockPct;
          const dp = symbol.includes('JPY') ? 3 : symbol.includes('XAU') || symbol.includes('BTC') ? 2 : 5;

          const modRes = await fetch(`${BASE}/trade`, {
            method: 'POST', headers,
            body: JSON.stringify({ actionType: 'POSITION_MODIFY', positionId: id, stopLoss: parseFloat(lockedSL.toFixed(dp)), comment: 'QuantumBot:SL_PROFIT_LOCK_TP1' })
          });
          if (modRes.ok) {
            result.actions.push({ type: 'SL_PROFIT_LOCK_TP1', level: lockedSL });
            state.beSet = true;
            state.lockedSL = lockedSL;
            await saveReport({ positionId: id, symbol, direction, openPrice, volume: 0,
              tp1, tp2, tp3, eventType: 'SL_TO_BREAKEVEN', price: lockedSL, pnl: 0 });
            const lockPips = (tp1Dist * lockPct).toFixed(2);
            await sendTelegram('🔒 <b>PROFIT LOCKED</b>\n' + symbol + ' ' + direction + '\nSL locked at ' + lockedSL.toFixed(2) + '\n(+' + lockPips + ' pips guaranteed on remaining 50%)');
          }
        }
      }

      // ── TP2: Close 30% + smart trail ──
      if (state.tp1Hit && !state.tp2Hit && tp2_distance && profit_distance >= tp2_distance * 0.95) {
        const closeVolume = Math.max(0.01, Math.round((volume * 0.3) / 0.01) * 0.01); // 30% at TP2
        const pnl = parseFloat((profit_distance * closeVolume * getMultiplier(symbol)).toFixed(2));

        const closeRes  = await fetch(`${BASE}/trade`, {
          method: 'POST', headers,
          body: JSON.stringify({ actionType: 'POSITION_PARTIAL', positionId: id, volume: closeVolume, comment: 'QuantumBot:TP2_30pct' })
        });
        const closeData = await closeRes.json();

        if (closeRes.ok && (closeData.orderId || closeData.positionId)) {
          result.actions.push({ type: 'PARTIAL_CLOSE_TP2', volume: closeVolume, price: currentPrice, pnl });
          state.tp2Hit = true;
          await saveReport({ positionId: id, symbol, direction, openPrice, volume: closeVolume,
            tp1, tp2, tp3, eventType: 'PARTIAL_CLOSE_TP2', price: currentPrice, pnl });

          const tp1pnl = result.actions.find(a=>a.type==='PARTIAL_CLOSE_TP1')?.pnl || 0;
          await sendTelegram(tgTP2(symbol, direction, currentPrice, pnl, openPrice, tp1pnl, tp3));

          // Move SL to TP1 + 20% of TP1→TP2 distance (remaining 30%+20%+10% always profitable)
          // This guarantees: even if price reverses from TP2, SL is ABOVE TP1 level
          // Meaning the remaining 20% position is always in positive territory
          // Formula: if LONG TP1=4820 TP2=4840 → SL at 4820 + (4840-4820)*0.20 = 4824
          const tp1tp2Dist = tp2 ? Math.abs(tp2 - tp1) : 0;
          const tp2LockBuffer = tp1tp2Dist * 0.20;
          const dp2 = symbol.includes('JPY') ? 3 : symbol.includes('XAU') || symbol.includes('BTC') ? 2 : 5;

          // Never go below the TP1 lock — always take the max (most profitable SL)
          const rawTP2SL = direction === 'LONG'
            ? (tp1 || openPrice) + tp2LockBuffer
            : (tp1 || openPrice) - tp2LockBuffer;

          // Safety: compare with existing SL and only move if more profitable
          const currentSLValue = state.lockedSL || stopLoss || openPrice;
          const tp2SL = direction === 'LONG'
            ? Math.max(rawTP2SL, currentSLValue)
            : Math.min(rawTP2SL, currentSLValue);

          const modRes = await fetch(`${BASE}/trade`, {
            method: 'POST', headers,
            body: JSON.stringify({ actionType: 'POSITION_MODIFY', positionId: id, stopLoss: parseFloat(tp2SL.toFixed(dp2)), comment: 'QuantumBot:SL_ABOVE_TP1' })
          });
          if (modRes.ok) {
            state.lockedSL = tp2SL;
            result.actions.push({ type: 'SL_ABOVE_TP1', level: tp2SL });
            const bufferPips = Math.abs(tp2SL - (tp1||openPrice)).toFixed(2);
            await sendTelegram('🔒🔒 <b>SL ABOVE TP1</b>\n' + symbol + ' ' + direction + '\nSL at ' + tp2SL.toFixed(2) + '\n(' + bufferPips + ' pips above TP1 — 20% runner guaranteed profit)');
          }
        }
      }

      // ── TP3: Close 20% (or all if no TP4) ──
      if (state.tp2Hit && !state.tp3Hit && tp3_distance && profit_distance >= tp3_distance * 0.95) {
        // If TP4 exists, close 20% and leave 10% runner. If no TP4, close everything.
        const tp3ClosePct = tp4 ? 0.2 : 1.0; // 20% partial if TP4 exists, else full close
        const closeVolume = tp4
          ? Math.max(0.01, Math.round((volume * 0.2) / 0.01) * 0.01)
          : Math.max(0.01, Math.round((volume * 0.2) / 0.01) * 0.01); // same for now
        const pnl = parseFloat((profit_distance * closeVolume * getMultiplier(symbol)).toFixed(2));

        const closeRes  = await fetch(`${BASE}/trade`, {
          method: 'POST', headers,
          body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: id, comment: 'QuantumBot:TP3_FULL' })
        });
        const closeData = await closeRes.json();

        if (closeRes.ok && (closeData.orderId || closeData.positionId)) {
          result.actions.push({ type: 'FULL_CLOSE_TP3', price: currentPrice, pnl });
          state.tp3Hit = true;
          await saveReport({ positionId: id, symbol, direction, openPrice, volume: closeVolume,
            tp1, tp2, tp3, eventType: 'FULL_CLOSE_TP3', price: currentPrice, pnl });
          if (redis) { try { await redis.del(stateKey); } catch(e) {} }

          const totalPnlFinal = (result.actions.reduce((s,a)=>s+(a.pnl||0),0));
          await sendTelegram(tgTP3(symbol, direction, currentPrice, pnl, openPrice, totalPnlFinal));
        }
      }

      // ── TP4: Close final 10% ──
      if (state.tp3Hit && !state.tp4Hit && tp4_distance && profit_distance >= tp4_distance * 0.95) {
        const closeVolume = Math.max(0.01, Math.round((volume * 0.1) / 0.01) * 0.01);
        const pnl = parseFloat((profit_distance * closeVolume * getMultiplier(symbol)).toFixed(2));

        const closeRes = await fetch(`${BASE}/trade`, {
          method: 'POST', headers,
          body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: id, comment: 'QuantumBot:TP4_FINAL' })
        });
        const closeData = await closeRes.json();

        if (closeRes.ok && (closeData.orderId || closeData.positionId)) {
          result.actions.push({ type: 'FULL_CLOSE_TP4', price: currentPrice, pnl });
          state.tp4Hit = true;
          await saveReport({ positionId: id, symbol, direction, openPrice, volume: closeVolume,
            tp1, tp2, tp3, tp4, eventType: 'FULL_CLOSE_TP4', price: currentPrice, pnl });
          if (redis) { try { await redis.del(stateKey); } catch(e) {} }
          const totalPnlFinal = result.actions.reduce((s,a)=>s+(a.pnl||0),0);
          await sendTelegram(
            '🏆 <b>TP4 COMPLETE — ' + symbol + '</b>\n' +
            direction + ' fully closed\n' +
            'Final 10% @ $' + currentPrice.toFixed(2) + '\n' +
            'Total trade P&L: <b>+$' + totalPnlFinal.toFixed(2) + '</b>'
          );
        }
      }

      // ── TP3 → move SL above TP2 ──
      // Already handled, but if tp4 exists, after TP3 we trail SL above TP2 level

      // ── SL HIT detection: price went through SL ──
      if (!state.tp3Hit && stopLoss && profit_distance < 0) {
        const slDist = Math.abs(stopLoss - openPrice);
        if (Math.abs(profit_distance) >= slDist * 0.95) {
          const pnl = parseFloat((profit_distance * volume * getMultiplier(symbol)).toFixed(2));
          await saveReport({ positionId: id, symbol, direction, openPrice, volume,
            tp1, tp2, tp3, eventType: 'SL_HIT', price: currentPrice, pnl });
          await sendTelegram(tgSLHit(symbol, direction, currentPrice, pnl, openPrice, state.tp1Hit));
          if (redis) { try { await redis.del(stateKey); } catch(e) {} }
        }
      }

      // lockedSL is already in state object, will be persisted below
      if (redis && (state.tp1Hit || state.tp2Hit || state.tp3Hit)) {
        try { await redis.set(stateKey, JSON.stringify(state), { ex: 86400 }); } catch(e) {}
      }

      if (result.actions.length > 0) managed.push(result);

    } catch(e) {
      result.error = e.message;
      managed.push(result);
    }
  }

  return res.status(200).json({ managed, count: managed.length, ts: new Date().toISOString() });
};