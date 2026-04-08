/* eslint-disable */
// api/manage-trades.js
// Trade manager: partial closes + SL to breakeven + trailing
// Called every 30 seconds from frontend
// Runs AFTER a position is open to let winners run

const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN      = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
  if (!TOKEN || !ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars' });

  // tp levels are sent from frontend per position
  // body: { positions: [{ id, symbol, openPrice, currentPrice, stopLoss, takeProfit, volume, direction, tp1, tp2, tp3, breakeven }] }
  const { positions } = req.body || {};
  if (!Array.isArray(positions) || positions.length === 0) {
    return res.status(200).json({ managed: [], message: 'No positions to manage' });
  }

  const BASE = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${ACCOUNT_ID}`;
  const headers = { 'auth-token': TOKEN, 'Content-Type': 'application/json' };

  // Redis for tracking which positions already had TP1/TP2 hit
  let redis = null;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  }

  const managed = [];

  for (const pos of positions) {
    const {
      id,         // MetaAPI position ID
      symbol,
      openPrice,
      currentPrice,
      stopLoss,
      volume,
      direction,  // "LONG" or "SHORT"
      tp1, tp2, tp3, breakeven,
    } = pos;

    if (!id || !currentPrice || !openPrice || !tp1) continue;

    const result = { id, symbol, actions: [] };

    try {
      // ── Track state in Redis ──
      const stateKey = `tp_state:${id}`;
      let state = { tp1Hit: false, tp2Hit: false, tp3Hit: false, beSet: false };

      if (redis) {
        try {
          const saved = await redis.get(stateKey);
          if (saved) state = JSON.parse(saved);
        } catch(e) {}
      }

      const profit_distance = direction === 'LONG'
        ? currentPrice - openPrice
        : openPrice - currentPrice;

      const tp1_distance = Math.abs(tp1 - openPrice);
      const tp2_distance = tp2 ? Math.abs(tp2 - openPrice) : null;
      const tp3_distance = tp3 ? Math.abs(tp3 - openPrice) : null;

      // ── TP1 HIT: Close 50% + move SL to breakeven ──
      if (!state.tp1Hit && profit_distance >= tp1_distance * 0.95) {
        const closeVolume = Math.max(0.01, Math.round((volume * 0.5) / 0.01) * 0.01);

        // Partial close
        const closeRes = await fetch(`${BASE}/trade`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            actionType: 'POSITION_PARTIAL',
            positionId: id,
            volume: closeVolume,
            comment: 'QuantumBot:TP1_50pct'
          })
        });

        const closeData = await closeRes.json();

        if (closeRes.ok && (closeData.orderId || closeData.positionId)) {
          result.actions.push({ type: 'PARTIAL_CLOSE_TP1', volume: closeVolume, price: currentPrice });
          state.tp1Hit = true;

          // Move SL to breakeven
          if (breakeven && stopLoss !== breakeven) {
            const modRes = await fetch(`${BASE}/trade`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                actionType: 'POSITION_MODIFY',
                positionId: id,
                stopLoss: parseFloat(breakeven.toFixed(5)),
                comment: 'QuantumBot:SL_to_BE'
              })
            });

            if (modRes.ok) {
              result.actions.push({ type: 'SL_TO_BREAKEVEN', level: breakeven });
              state.beSet = true;
            }
          }
        }
      }

      // ── TP2 HIT: Close 30% more ──
      if (state.tp1Hit && !state.tp2Hit && tp2_distance && profit_distance >= tp2_distance * 0.95) {
        const remainingVolume = volume * 0.5; // 50% left after TP1
        const closeVolume = Math.max(0.01, Math.round((remainingVolume * 0.6) / 0.01) * 0.01); // 30% of original

        const closeRes = await fetch(`${BASE}/trade`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            actionType: 'POSITION_PARTIAL',
            positionId: id,
            volume: closeVolume,
            comment: 'QuantumBot:TP2_30pct'
          })
        });

        const closeData = await closeRes.json();

        if (closeRes.ok && (closeData.orderId || closeData.positionId)) {
          result.actions.push({ type: 'PARTIAL_CLOSE_TP2', volume: closeVolume, price: currentPrice });
          state.tp2Hit = true;

          // Trail SL to just below current price - 1 ATR
          if (pos.atr) {
            const trailSL = direction === 'LONG'
              ? currentPrice - pos.atr * 1.0
              : currentPrice + pos.atr * 1.0;

            const modRes = await fetch(`${BASE}/trade`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                actionType: 'POSITION_MODIFY',
                positionId: id,
                stopLoss: parseFloat(trailSL.toFixed(5)),
                comment: 'QuantumBot:TRAIL_TP2'
              })
            });

            if (modRes.ok) {
              result.actions.push({ type: 'SL_TRAIL_AT_TP2', level: trailSL });
            }
          }
        }
      }

      // ── TP3 HIT: Close remaining 20% ──
      if (state.tp2Hit && !state.tp3Hit && tp3_distance && profit_distance >= tp3_distance * 0.95) {
        const closeRes = await fetch(`${BASE}/trade`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            actionType: 'POSITION_CLOSE_ID',
            positionId: id,
            comment: 'QuantumBot:TP3_FULL'
          })
        });

        const closeData = await closeRes.json();

        if (closeRes.ok && (closeData.orderId || closeData.positionId)) {
          result.actions.push({ type: 'FULL_CLOSE_TP3', price: currentPrice });
          state.tp3Hit = true;

          // Clean up Redis state
          if (redis) {
            try { await redis.del(stateKey); } catch(e) {}
          }
        }
      }

      // Save updated state to Redis
      if (redis && (state.tp1Hit || state.tp2Hit || state.tp3Hit)) {
        try {
          await redis.set(stateKey, JSON.stringify(state), { ex: 86400 }); // 24h TTL
        } catch(e) {}
      }

      if (result.actions.length > 0) managed.push(result);

    } catch(e) {
      result.error = e.message;
      managed.push(result);
    }
  }

  return res.status(200).json({ managed, count: managed.length, ts: new Date().toISOString() });
};