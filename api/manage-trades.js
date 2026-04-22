/* eslint-disable */
// api/manage-trades.js -- Quantum Bot V9.2
// Changes vs V9:
//   - Telegram errors LOGGED visibly (not swallowed)
//   - Broker POSITION_MODIFY results CHECKED (logs failures)
//   - Built-in telegram-test action via ?action=telegram-test (respects 12-file Vercel limit)
//   - Supports TELEGRAM_TOKEN and TELEGRAM_BOT_TOKEN env names
//   - Instruments stay fully open
// Redis namespace: v9:tp:*

const { Redis } = require('@upstash/redis');

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + (process.env.METAAPI_ACCOUNT_ID || '');
const HEADERS = { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN || '' };

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

// ---- Telegram: logs failures visibly ----
const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const tg = async (msg) => {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('[TG] disabled: missing env vars');
    return { ok: false, reason: 'missing env vars' };
  }
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      console.error('[TG] FAIL ' + r.status + ' ' + JSON.stringify(d).slice(0, 200));
      return { ok: false, status: r.status, resp: d };
    }
    return { ok: true };
  } catch (e) {
    console.error('[TG] throw ' + e.message);
    return { ok: false, error: e.message };
  }
};

// ---- Broker modify with verification ----
const modifyPosition = async (positionId, stopLoss, takeProfit, comment) => {
  const dp = (p) => (p > 100 ? 2 : 5);
  const modBody = { actionType: 'POSITION_MODIFY', positionId };
  if (stopLoss   != null) modBody.stopLoss   = parseFloat(stopLoss.toFixed(dp(stopLoss)));
  if (takeProfit != null) modBody.takeProfit = parseFloat(takeProfit.toFixed(dp(takeProfit)));
  if (comment) modBody.comment = comment;

  try {
    const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify(modBody) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) {
      console.error('[MODIFY] FAIL positionId=' + positionId + ' status=' + r.status + ' resp=' + JSON.stringify(d).slice(0, 300));
      return { ok: false, status: r.status, resp: d };
    }
    console.log('[MODIFY] OK positionId=' + positionId + ' sl=' + modBody.stopLoss + ' tp=' + modBody.takeProfit);
    return { ok: true, resp: d };
  } catch (e) {
    console.error('[MODIFY] throw ' + e.message);
    return { ok: false, error: e.message };
  }
};

const getPipMult = (sym) => {
  const s = (sym || '').toUpperCase();
  if (s.includes('BTC') || s.includes('ETH')) return 1;
  if (s.includes('XAU') || s.includes('GOLD')) return 100;
  return 100000;
};
const priceDp = (price) => (price > 100 ? 2 : 5);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}

  // ========================================================================
  // Telegram test (consolidated here instead of a new file)
  // POST {"action":"telegram-test"} or ?action=telegram-test
  // ========================================================================
  const action = body.action || (req.query && req.query.action) || null;
  if (action === 'telegram-test') {
    console.log('[TG-TEST] invoked');
    console.log('[TG-TEST] TELEGRAM_TOKEN set:', !!process.env.TELEGRAM_TOKEN);
    console.log('[TG-TEST] TELEGRAM_BOT_TOKEN set:', !!process.env.TELEGRAM_BOT_TOKEN);
    console.log('[TG-TEST] TELEGRAM_CHAT_ID set:', !!process.env.TELEGRAM_CHAT_ID);
    const r = await tg('<b>Quantum Bot V9.2 -- Telegram test</b>\nIf you see this, Telegram is working.');
    return res.status(200).json({
      ok: r.ok,
      result: r,
      envCheck: {
        TELEGRAM_TOKEN:     !!process.env.TELEGRAM_TOKEN,
        TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID:   !!process.env.TELEGRAM_CHAT_ID,
      },
    });
  }

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(500).json({ error: 'Missing Redis env vars' });
  }
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  // ========================================================================
  // Post-fill TP correction -- with broker verification
  // ========================================================================
  if (body.correctTPs) {
    const { positionId, instrument, direction, fillPrice, tp1, tp2, tp3, tp4, sl } = body.correctTPs;
    if (!positionId || !fillPrice) return res.status(400).json({ error: 'correctTPs requires positionId and fillPrice' });

    // ---- Verify direction consistency ----
    if (direction === 'LONG') {
      if (sl && sl >= fillPrice) return res.status(200).json({ corrected: false, error: 'LONG SL must be below fillPrice' });
      if (tp1 && tp1 <= fillPrice) return res.status(200).json({ corrected: false, error: 'LONG TPs must be above fillPrice' });
    } else if (direction === 'SHORT') {
      if (sl && sl <= fillPrice) return res.status(200).json({ corrected: false, error: 'SHORT SL must be above fillPrice' });
      if (tp1 && tp1 >= fillPrice) return res.status(200).json({ corrected: false, error: 'SHORT TPs must be below fillPrice' });
    }

    // ---- Apply modify on broker with result checking ----
    const finalTP = tp4 || tp3 || tp2 || tp1;
    const modResult = await modifyPosition(positionId, sl, finalTP, 'QB:FILL_CORRECT');

    // ---- Store corrected state in Redis ----
    const stateKey = 'v9:tp:' + positionId;
    const existing = safe(await redis.get(stateKey).catch(() => null)) || {};
    await redis.set(stateKey, JSON.stringify({
      ...existing, tp1, tp2, tp3, tp4, sl,
      fillCorrected: modResult.ok, instrument, direction, fillPrice,
      openTs: Date.now(),
      modifyError: modResult.ok ? null : (modResult.resp || modResult.error || 'unknown'),
    }), { ex: 86400 * 7 });

    // ---- Telegram: TP correction confirmation ----
    const tgMsg = modResult.ok
      ? '<b>TPs corrected -- ' + (instrument || positionId) + '</b>\n' +
        'Direction: ' + direction + '\n' +
        'Fill: ' + fillPrice.toFixed(priceDp(fillPrice)) + '\n' +
        'SL: ' + (sl || 0).toFixed(priceDp(sl || 0)) + '\n' +
        'TP1: ' + (tp1 || 0).toFixed(priceDp(tp1 || 0)) + ' | TP2: ' + (tp2 || 0).toFixed(priceDp(tp2 || 0)) + '\n' +
        'TP3: ' + (tp3 || 0).toFixed(priceDp(tp3 || 0)) + ' | TP4: ' + (tp4 || 0).toFixed(priceDp(tp4 || 0))
      : '<b>TP correction FAILED -- ' + (instrument || positionId) + '</b>\n' +
        'Error: ' + (modResult.resp && modResult.resp.message ? modResult.resp.message : (modResult.error || 'unknown')) + '\n' +
        'Broker still has original SL/TP.';
    await tg(tgMsg);

    return res.status(200).json({ corrected: modResult.ok, positionId, modifyResult: modResult });
  }

  // ========================================================================
  // Manage open positions (TP ladder + retrace)
  // ========================================================================
  const { positions } = body;
  if (!Array.isArray(positions) || positions.length === 0) {
    return res.status(200).json({ managed: [], message: 'No positions to manage' });
  }

  const managed = [];

  for (const pos of positions) {
    const { id, symbol, openPrice, currentPrice, stopLoss, volume, direction, tp1, tp2, tp3, tp4 } = pos;
    if (!id || !currentPrice || !openPrice || !tp1) continue;
    const result = { id, symbol, actions: [] };

    try {
      const stateKey = 'v9:tp:' + id;
      const stateRaw = safe(await redis.get(stateKey).catch(() => null));
      let state = (stateRaw && typeof stateRaw === 'object') ? stateRaw : { tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false, openTs: Date.now() };

      // Use fill-corrected levels if available
      const fTP1 = state.tp1 || tp1;
      const fTP2 = state.tp2 || tp2;
      const fTP3 = state.tp3 || tp3;
      const fTP4 = state.tp4 || tp4;
      const fSL  = state.sl  || stopLoss;

      const profit = direction === 'LONG' ? currentPrice - openPrice : openPrice - currentPrice;
      const d1 = Math.abs(fTP1 - openPrice);
      const d2 = fTP2 ? Math.abs(fTP2 - openPrice) : null;
      const d3 = fTP3 ? Math.abs(fTP3 - openPrice) : null;
      const d4 = fTP4 ? Math.abs(fTP4 - openPrice) : null;
      const mult = getPipMult(symbol);
      const dp   = priceDp(currentPrice);

      const saveState = async (s) => { await redis.set(stateKey, JSON.stringify(s), { ex: 86400 * 7 }).catch(() => {}); };

      const closeFull = async (comment) => {
        try {
          const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: id, comment }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) { console.error('[CLOSE_FULL] FAIL ' + r.status + ' ' + JSON.stringify(d).slice(0, 200)); return false; }
          return !!(d.orderId || d.positionId);
        } catch (e) { console.error('[CLOSE_FULL] throw ' + e.message); return false; }
      };

      const closePartial = async (pct, comment) => {
        const vol = Math.max(0.01, Math.round((volume * pct) / 0.01) * 0.01);
        const pnl = parseFloat((profit * vol * mult).toFixed(2));
        try {
          const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify({ actionType: 'POSITION_PARTIAL', positionId: id, volume: vol, comment }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) { console.error('[CLOSE_PARTIAL] FAIL ' + r.status + ' ' + JSON.stringify(d).slice(0, 200)); return { ok: false, vol, pnl }; }
          return { ok: !!(d.orderId || d.positionId), vol, pnl };
        } catch (e) { console.error('[CLOSE_PARTIAL] throw ' + e.message); return { ok: false, vol, pnl }; }
      };

      const modifySL = async (newSL) => {
        if (newSL == null) return false;
        const r = await modifyPosition(id, newSL, null, 'QB:SL_TRAIL');
        return r.ok;
      };

      // ---- POST-TP1 PRE-TP2 RETRACE GUARD ----
      if (state.tp1Hit && !state.tp2Hit && !state.tp1RetraceClose) {
        const triggerDist = d1 * 0.25;
        const retracing = profit <= triggerDist && profit > 0;
        if (retracing) {
          const { ok, vol, pnl } = await closePartial(0.3, 'QB:T1_RETRACE');
          if (ok) {
            state.tp1RetraceClose = true;
            const tightSL = direction === 'LONG' ? openPrice + d1 * 0.15 : openPrice - d1 * 0.15;
            await modifySL(tightSL);
            result.actions.push({ type: 'TP1_RETRACE_PROTECT', volume: vol, price: currentPrice, pnl });
            await saveState(state);
            const r = await tg(
              '<b>TP1 retrace protect -- ' + symbol + '</b>\n' +
              'TP1 was hit, price retracing toward entry\n' +
              'Closed next 30% @ ' + currentPrice.toFixed(dp) + '\n' +
              'P&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + '\n' +
              'SL tightened above entry'
            );
            if (!r.ok) console.error('[TG] TP1_RETRACE notification failed');
          }
        }
      }

      // ---- TP2/TP3 retrace guard ----
      const retraceLevel = state.tp3Hit && !state.tp4Hit ? fTP3
                         : state.tp2Hit && !state.tp3Hit ? fTP2
                         : state.tp1Hit && !state.tp2Hit ? fTP1
                         : null;
      if (retraceLevel && state.tp1Hit) {
        const retraced = direction === 'LONG' ? currentPrice <= retraceLevel : currentPrice >= retraceLevel;
        if (retraced && state.tp2Hit) {
          const pnl = parseFloat((profit * volume * mult).toFixed(2));
          const closed = await closeFull('QB:RETRACE');
          if (closed) {
            const lbl = state.tp3Hit ? 'TP3' : 'TP2';
            result.actions.push({ type: 'RETRACE_CLOSE', price: currentPrice, pnl });
            state.tp4Hit = true;
            await redis.del(stateKey).catch(() => {});
            const r = await tg(
              '<b>Retrace protected -- ' + symbol + '</b>\n' +
              lbl + ' was hit, price retraced to protection zone\n' +
              'Closed remainder @ ' + currentPrice.toFixed(dp) + '\n' +
              'P&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)
            );
            if (!r.ok) console.error('[TG] RETRACE notification failed');
          }
          if (result.actions.length) managed.push(result);
          continue;
        }
      }

      // ---- TP1 ----
      if (!state.tp1Hit && profit >= d1 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.4, 'QB:TP1');
        if (ok) {
          state.tp1Hit = true;
          const beLevel = direction === 'LONG' ? openPrice + d1 * 0.3 : openPrice - d1 * 0.3;
          await modifySL(beLevel);
          result.actions.push({ type: 'TP1', volume: vol, price: currentPrice, pnl });
          await saveState(state);
          const r = await tg('<b>TP1 hit -- ' + symbol + '</b>\n' + direction + ' | 40% closed @ ' + currentPrice.toFixed(dp) + '\nP&L: +$' + pnl.toFixed(2) + '\nSL moved to BE+ ' + beLevel.toFixed(priceDp(beLevel)) + '\n60% running');
          if (!r.ok) console.error('[TG] TP1 notification failed');
        }
      }
      // ---- TP2 ----
      else if (state.tp1Hit && !state.tp2Hit && d2 && profit >= d2 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.3, 'QB:TP2');
        if (ok) {
          state.tp2Hit = true;
          if (fTP1) await modifySL(fTP1);
          result.actions.push({ type: 'TP2', volume: vol, price: currentPrice, pnl });
          await saveState(state);
          const r = await tg('<b>TP2 hit -- ' + symbol + '</b>\n' + direction + ' | 30% closed @ ' + currentPrice.toFixed(dp) + '\nP&L: +$' + pnl.toFixed(2) + '\nSL moved to TP1 ' + (fTP1||0).toFixed(priceDp(fTP1||0)) + '\n30% running');
          if (!r.ok) console.error('[TG] TP2 notification failed');
        }
      }
      // ---- TP3 ----
      else if (state.tp2Hit && !state.tp3Hit && d3 && profit >= d3 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.2, 'QB:TP3');
        if (ok) {
          state.tp3Hit = true;
          if (fTP2) await modifySL(fTP2);
          result.actions.push({ type: 'TP3', volume: vol, price: currentPrice, pnl });
          await saveState(state);
          const r = await tg('<b>TP3 hit -- ' + symbol + '</b>\n' + direction + ' | 20% closed @ ' + currentPrice.toFixed(dp) + '\nP&L: +$' + pnl.toFixed(2) + '\nSL moved to TP2 ' + (fTP2||0).toFixed(priceDp(fTP2||0)) + '\n10% runner');
          if (!r.ok) console.error('[TG] TP3 notification failed');
        }
      }
      // ---- TP4 ----
      else if (state.tp3Hit && !state.tp4Hit && d4 && profit >= d4 * 0.95) {
        const pnl = parseFloat((profit * volume * 0.1 * mult).toFixed(2));
        const closed = await closeFull('QB:TP4');
        if (closed) {
          state.tp4Hit = true;
          result.actions.push({ type: 'TP4_FINAL', price: currentPrice, pnl });
          await redis.del(stateKey).catch(() => {});
          const r = await tg('<b>TP4 COMPLETE -- ' + symbol + '</b>\nAll targets hit. Full close.\nFinal 10% @ ' + currentPrice.toFixed(dp) + '\nP&L: +$' + pnl.toFixed(2));
          if (!r.ok) console.error('[TG] TP4 notification failed');
        }
      }

      if (result.actions.length) managed.push(result);
    } catch (e) { console.error('[MANAGE] error for ' + id + ': ' + e.message); }
  }

  return res.status(200).json({ managed });
};