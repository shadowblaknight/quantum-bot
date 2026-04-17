/* eslint-disable */
// api/manage-trades.js -- V8.2.0
// Handles: TP1/TP2/TP3/TP4 partial closes, BE, retrace guard, post-fill correction.
// Env vars: METAAPI_TOKEN, METAAPI_ACCOUNT_ID, KV_REST_API_URL, KV_REST_API_TOKEN,
//           TELEGRAM_TOKEN, TELEGRAM_CHAT_ID

const { Redis } = require('@upstash/redis');

// Correct MetaAPI base: account-level endpoint, trade actions go to /trade
const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/'
  + (process.env.METAAPI_ACCOUNT_ID || '');

const HEADERS = {
  'Content-Type': 'application/json',
  'auth-token': process.env.METAAPI_TOKEN || '',
};

const safe = (v) => {
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return v; }
};

const tg = async (msg) => {
  if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      'https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/sendMessage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: msg,
          parse_mode: 'HTML',
        }),
      }
    );
  } catch (e) {}
};

const getMultiplier = (sym) => {
  const s = (sym || '').toUpperCase();
  if (s.includes('BTC') || s.includes('ETH')) return 1;
  if (s.includes('XAU') || s.includes('GOLD')) return 100;
  return 100000;
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(500).json({ error: 'Missing Redis environment variables' });
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {}

  // Post-fill TP correction
  // Called 3 seconds after execution to recalculate TP levels from the actual fill price.
  if (body.correctTPs) {
    const { positionId, instrument, direction, fillPrice, tp1, tp2, tp3, tp4, sl } = body.correctTPs;
    try {
      // Update SL/TP on MT5 to match actual fill
      await fetch(BASE + '/trade', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          actionType: 'POSITION_MODIFY',
          positionId,
          stopLoss:   sl,
          takeProfit: tp4 || tp3,
          comment:    'QB:FILL_CORRECT',
        }),
      }).catch(() => {});

      // Store corrected levels in Redis for use by TP management
      const stateKey = 'v820:tp:' + positionId;
      const existing = safe(await redis.get(stateKey).catch(() => null)) || {};
      await redis.set(stateKey, JSON.stringify({
        ...existing,
        tp1, tp2, tp3, tp4, sl,
        fillCorrected: true,
      }), { ex: 86400 });

      return res.status(200).json({ corrected: true });
    } catch (e) {
      return res.status(200).json({ corrected: false, error: e.message });
    }
  }

  // Manage open positions
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
      const stateKey = 'v820:tp:' + id;
      const stateRaw = safe(await redis.get(stateKey).catch(() => null));
      let state = (stateRaw && typeof stateRaw === 'object') ? stateRaw
        : { tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false };

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
      const mult = getMultiplier(symbol);

      const saveState = async (s) => {
        await redis.set(stateKey, JSON.stringify(s), { ex: 86400 }).catch(() => {});
      };

      const closePosition = async (comment) => {
        const r = await fetch(BASE + '/trade', {
          method: 'POST', headers: HEADERS,
          body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: id, comment }),
        }).catch(() => null);
        const d = r ? await r.json().catch(() => ({})) : {};
        return !!(r && r.ok && (d.orderId || d.positionId));
      };

      const closePartial = async (pct, comment) => {
        const vol = Math.max(0.01, Math.round((volume * pct) / 0.01) * 0.01);
        const pnl = parseFloat((profit * vol * mult).toFixed(2));
        const r = await fetch(BASE + '/trade', {
          method: 'POST', headers: HEADERS,
          body: JSON.stringify({ actionType: 'POSITION_PARTIAL', positionId: id, volume: vol, comment }),
        }).catch(() => null);
        const d = r ? await r.json().catch(() => ({})) : {};
        return { ok: !!(r && r.ok && (d.orderId || d.positionId)), vol, pnl };
      };

      const modifySL = async (newSL) => {
        await fetch(BASE + '/trade', {
          method: 'POST', headers: HEADERS,
          body: JSON.stringify({
            actionType: 'POSITION_MODIFY',
            positionId: id,
            stopLoss: parseFloat(newSL.toFixed(newSL > 100 ? 2 : 5)),
          }),
        }).catch(() => {});
      };

      // Retrace guard:
      // If TP1 hit and price retraces back to the last hit TP level, close the remainder.
      const retraceLevel = state.tp3Hit && !state.tp4Hit ? fTP3
                         : state.tp2Hit && !state.tp3Hit ? fTP2
                         : state.tp1Hit && !state.tp2Hit ? fTP1
                         : null;

      if (retraceLevel && state.tp1Hit) {
        const retraced = direction === 'LONG' ? currentPrice <= retraceLevel : currentPrice >= retraceLevel;
        if (retraced) {
          const pnl = parseFloat((profit * volume * mult).toFixed(2));
          const ok  = await closePosition('QB:RETRACE');
          if (ok) {
            const tpHit = state.tp3Hit ? 'TP3' : state.tp2Hit ? 'TP2' : 'TP1';
            result.actions.push({ type: 'RETRACE_CLOSE', price: currentPrice, pnl });
            state.tp4Hit = true;
            await redis.del(stateKey).catch(() => {});
            await tg(
              '<b>Retrace close -- ' + symbol + '</b>\n' +
              tpHit + ' was hit but price retraced back\n' +
              'Closed remainder @ ' + currentPrice.toFixed(currentPrice > 100 ? 2 : 5) + '\n' +
              'P&L this close: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)
            );
          }
          if (result.actions.length) managed.push(result);
          continue;
        }
      }

      // TP1: close 40%
      if (!state.tp1Hit && profit >= d1 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.4, 'QB:TP1');
        if (ok) {
          state.tp1Hit = true;
          // SL to BE + 30% buffer
          const beLevel = direction === 'LONG'
            ? openPrice + (d1 * 0.3)
            : openPrice - (d1 * 0.3);
          await modifySL(beLevel);
          result.actions.push({ type: 'TP1', volume: vol, price: currentPrice, pnl });
          await saveState(state);
          await tg(
            '<b>TP1 -- ' + symbol + '</b>\n' +
            direction + ' +40% closed @ ' + currentPrice.toFixed(currentPrice > 100 ? 2 : 5) + '\n' +
            'P&L: +$' + pnl.toFixed(2) + '\n' +
            'SL moved to BE ' + beLevel.toFixed(beLevel > 100 ? 2 : 5)
          );
        }
      }

      // TP2: close 30%
      else if (state.tp1Hit && !state.tp2Hit && d2 && profit >= d2 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.3, 'QB:TP2');
        if (ok) {
          state.tp2Hit = true;
          if (fTP1) await modifySL(fTP1);
          result.actions.push({ type: 'TP2', volume: vol, price: currentPrice, pnl });
          await saveState(state);
          await tg(
            '<b>TP2 -- ' + symbol + '</b>\n' +
            direction + ' +30% closed @ ' + currentPrice.toFixed(currentPrice > 100 ? 2 : 5) + '\n' +
            'P&L: +$' + pnl.toFixed(2) + '\n' +
            'SL moved to TP1'
          );
        }
      }

      // TP3: close 20%
      else if (state.tp2Hit && !state.tp3Hit && d3 && profit >= d3 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.2, 'QB:TP3');
        if (ok) {
          state.tp3Hit = true;
          if (fTP2) await modifySL(fTP2);
          result.actions.push({ type: 'TP3', volume: vol, price: currentPrice, pnl });
          await saveState(state);
          await tg(
            '<b>TP3 -- ' + symbol + '</b>\n' +
            direction + ' +20% closed @ ' + currentPrice.toFixed(currentPrice > 100 ? 2 : 5) + '\n' +
            'P&L: +$' + pnl.toFixed(2) + '\n' +
            'SL moved to TP2 -- 10% runner active'
          );
        }
      }

      // TP4: close final 10% (full close of remaining)
      else if (state.tp3Hit && !state.tp4Hit && d4 && profit >= d4 * 0.95) {
        const pnl = parseFloat((profit * volume * mult).toFixed(2));
        const ok  = await closePosition('QB:TP4');
        if (ok) {
          state.tp4Hit = true;
          result.actions.push({ type: 'TP4_FINAL', price: currentPrice, pnl });
          await redis.del(stateKey).catch(() => {});
          await tg(
            '<b>TP4 COMPLETE -- ' + symbol + '</b>\n' +
            'Full trade closed\n' +
            'Final 10% @ ' + currentPrice.toFixed(currentPrice > 100 ? 2 : 5) + '\n' +
            'P&L: +$' + pnl.toFixed(2)
          );
        }
      }

      if (result.actions.length) managed.push(result);

    } catch (e) {
      console.error('manage error for', id, ':', e.message);
    }
  }

  return res.status(200).json({ managed });
};