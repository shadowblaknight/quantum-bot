/* eslint-disable */
// api/manage-trades.js -- Quantum Bot V9
// Multi-TP ladder, retrace guards (incl. post-TP1 pre-TP2 retrace), Telegram, fill correction.
// Redis namespace: v9:tp:*

const { Redis } = require('@upstash/redis');

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + (process.env.METAAPI_ACCOUNT_ID || '');
const HEADERS = { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN || '' };

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

const tg = async (msg) => {
  if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }),
    });
  } catch (_) {}
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

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return res.status(500).json({ error: 'Missing Redis env vars' });

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}

  // ---- Post-fill TP correction ----
  if (body.correctTPs) {
    const { positionId, instrument, direction, fillPrice, tp1, tp2, tp3, tp4, sl } = body.correctTPs;
    if (!positionId || !fillPrice) return res.status(400).json({ error: 'correctTPs requires positionId and fillPrice' });
    try {
      await fetch(BASE + '/trade', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ actionType: 'POSITION_MODIFY', positionId, stopLoss: sl, takeProfit: tp4 || tp3 || tp2 || tp1, comment: 'QB:FILL_CORRECT' }),
      }).catch(() => {});

      const stateKey = 'v9:tp:' + positionId;
      const existing = safe(await redis.get(stateKey).catch(() => null)) || {};
      await redis.set(stateKey, JSON.stringify({ ...existing, tp1, tp2, tp3, tp4, sl, fillCorrected: true, instrument, direction, fillPrice, openTs: Date.now() }), { ex: 86400 * 7 });

      await tg(
        '<b>Trade opened -- ' + (instrument || positionId) + '</b>\n' +
        'Direction: ' + direction + '\n' +
        'Fill: ' + fillPrice.toFixed(priceDp(fillPrice)) + '\n' +
        'SL: ' + (sl || 0).toFixed(priceDp(sl || 0)) + '\n' +
        'TP1: ' + (tp1 || 0).toFixed(priceDp(tp1 || 0)) + ' | TP2: ' + (tp2 || 0).toFixed(priceDp(tp2 || 0)) +
        '\nTP3: ' + (tp3 || 0).toFixed(priceDp(tp3 || 0)) + ' | TP4: ' + (tp4 || 0).toFixed(priceDp(tp4 || 0))
      );
      return res.status(200).json({ corrected: true, positionId });
    } catch (e) { return res.status(200).json({ corrected: false, error: e.message }); }
  }

  // ---- Manage open positions ----
  const { positions } = body;
  if (!Array.isArray(positions) || positions.length === 0) return res.status(200).json({ managed: [], message: 'No positions to manage' });

  const managed = [];

  for (const pos of positions) {
    const { id, symbol, openPrice, currentPrice, stopLoss, volume, direction, tp1, tp2, tp3, tp4 } = pos;
    if (!id || !currentPrice || !openPrice || !tp1) continue;
    const result = { id, symbol, actions: [] };

    try {
      const stateKey = 'v9:tp:' + id;
      const stateRaw = safe(await redis.get(stateKey).catch(() => null));
      let state = (stateRaw && typeof stateRaw === 'object') ? stateRaw : { tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false, openTs: Date.now() };

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

      const saveState  = async (s) => { await redis.set(stateKey, JSON.stringify(s), { ex: 86400 * 7 }).catch(() => {}); };
      const closeFull  = async (comment) => {
        const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: id, comment }) }).catch(() => null);
        const d = r ? await r.json().catch(() => ({})) : {};
        return !!(r && r.ok && (d.orderId || d.positionId));
      };
      const closePartial = async (pct, comment) => {
        const vol = Math.max(0.01, Math.round((volume * pct) / 0.01) * 0.01);
        const pnl = parseFloat((profit * vol * mult).toFixed(2));
        const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify({ actionType: 'POSITION_PARTIAL', positionId: id, volume: vol, comment }) }).catch(() => null);
        const d = r ? await r.json().catch(() => ({})) : {};
        return { ok: !!(r && r.ok && (d.orderId || d.positionId)), vol, pnl };
      };
      const modifySL = async (newSL) => {
        if (newSL == null) return;
        await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify({ actionType: 'POSITION_MODIFY', positionId: id, stopLoss: parseFloat(newSL.toFixed(priceDp(newSL))) }) }).catch(() => {});
      };

      // ---- POST-TP1 PRE-TP2 RETRACE GUARD ----
      // If TP1 was hit but TP2 not yet reached, and price retraces back toward entry
      // before going red, close the next 30% tranche to lock in protection.
      if (state.tp1Hit && !state.tp2Hit && !state.tp1RetraceClose) {
        // Trigger when profit drops below 25% of d1 distance (not yet at BE but losing momentum)
        const triggerDist = d1 * 0.25;
        const retracing = profit <= triggerDist && profit > 0;
        if (retracing) {
          const { ok, vol, pnl } = await closePartial(0.3, 'QB:T1_RETRACE');
          if (ok) {
            state.tp1RetraceClose = true;
            // Tighten SL to 50% of TP1 distance from entry
            const tightSL = direction === 'LONG' ? openPrice + d1 * 0.15 : openPrice - d1 * 0.15;
            await modifySL(tightSL);
            result.actions.push({ type: 'TP1_RETRACE_PROTECT', volume: vol, price: currentPrice, pnl });
            await saveState(state);
            await tg(
              '<b>TP1 retrace protect -- ' + symbol + '</b>\n' +
              'TP1 was hit, price retracing toward entry\n' +
              'Closed next 30% @ ' + currentPrice.toFixed(dp) + '\n' +
              'P&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + '\n' +
              'SL tightened above entry'
            );
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
            await tg(
              '<b>Retrace protected -- ' + symbol + '</b>\n' +
              lbl + ' was hit, price retraced to protection zone\n' +
              'Closed remainder @ ' + currentPrice.toFixed(dp) + '\n' +
              'P&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)
            );
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
          await tg('<b>TP1 -- ' + symbol + '</b>\n' + direction + ' | 40% closed @ ' + currentPrice.toFixed(dp) + '\nP&L: +$' + pnl.toFixed(2) + '\nSL moved to BE+ ' + beLevel.toFixed(priceDp(beLevel)) + '\n60% running');
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
          await tg('<b>TP2 -- ' + symbol + '</b>\n' + direction + ' | 30% closed @ ' + currentPrice.toFixed(dp) + '\nP&L: +$' + pnl.toFixed(2) + '\nSL moved to TP1 ' + (fTP1||0).toFixed(priceDp(fTP1||0)) + '\n30% running');
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
          await tg('<b>TP3 -- ' + symbol + '</b>\n' + direction + ' | 20% closed @ ' + currentPrice.toFixed(dp) + '\nP&L: +$' + pnl.toFixed(2) + '\nSL moved to TP2 ' + (fTP2||0).toFixed(priceDp(fTP2||0)) + '\n10% runner');
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
          await tg('<b>TP4 COMPLETE -- ' + symbol + '</b>\nAll targets hit. Full close.\nFinal 10% @ ' + currentPrice.toFixed(dp) + '\nP&L: +$' + pnl.toFixed(2));
        }
      }

      if (result.actions.length) managed.push(result);
    } catch (e) { console.error('manage error', id, e.message); }
  }

  return res.status(200).json({ managed });
};