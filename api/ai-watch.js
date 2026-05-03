/* eslint-disable */
// V11 — api/ai-watch.js
// Aggregates everything the visualization page needs in ONE call:
//   - Recent candles for the chart
//   - Current price
//   - Last AI decision (from memory)
//   - Active setups from setup-detector
//   - AI's observations from observation-memory
//   - Open positions with TP/SL ladder
//   - Regime + chaos
//
// Frontend polls this every 60s per active instrument. Cheap (most data is cached).

const { applyCors, normSym, getRedis, safeParse } = require('./_lib');
const { fetchCandles, fetchPrice, fetchPositions } = require('./broker');
const { getRegimeFor } = require('./regime');
const { readSetupsFor } = require('./setup-detector');
const { readObservations } = require('./observation-memory');
const { findLevelsFor } = require('./level-finder');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const sym = String(req.query.symbol || '').toUpperCase();
  if (!sym) return res.status(400).json({ error: 'symbol required' });
  const tf = String(req.query.tf || '1h');
  const n  = Math.min(Math.max(parseInt(req.query.n || '100', 10), 20), 200);

  try {
    const [candlesResp, priceResp, positionsResp, regime, setups, observations, levels] = await Promise.all([
      fetchCandles(sym, tf, n),
      fetchPrice(sym),
      fetchPositions(),
      getRegimeFor(sym),
      readSetupsFor(sym),
      readObservations(sym),
      findLevelsFor(sym).catch(() => null),
    ]);

    // Filter positions to this symbol and merge with TP ladder state
    const r = getRedis();
    const myPositions = (positionsResp.positions || []).filter(p => normSym(p.symbol) === sym);
    const positionsWithLadder = [];
    for (const pos of myPositions) {
      let ladder = null;
      if (r && pos.id) {
        try {
          const raw = await r.get('v9:tp:' + pos.id).catch(() => null);
          ladder = safeParse(raw);
          // Normalize tpHits: manage-trades writes V9 individual flags (tp1Hit, tp2Hit, ...).
          // Frontend reads V11 nested shape (tpHits.tp1, ...). Bridge them here so the
          // chart shows "✓" markers as soon as a TP hits.
          if (ladder) {
            ladder.tpHits = {
              tp1: !!(ladder.tpHits && ladder.tpHits.tp1) || !!ladder.tp1Hit,
              tp2: !!(ladder.tpHits && ladder.tpHits.tp2) || !!ladder.tp2Hit,
              tp3: !!(ladder.tpHits && ladder.tpHits.tp3) || !!ladder.tp3Hit,
              tp4: !!(ladder.tpHits && ladder.tpHits.tp4) || !!ladder.tp4Hit,
            };
          }
        } catch (_) {}
      }
      positionsWithLadder.push({
        id:           pos.id,
        symbol:       pos.symbol,
        direction:    pos.direction,
        type:         pos.type,
        volume:       pos.volume,
        openPrice:    pos.openPrice,
        currentPrice: pos.currentPrice,
        stopLoss:     pos.stopLoss,
        takeProfit:   pos.takeProfit,
        profit:       pos.profit,
        time:         pos.time,
        ladder:       ladder,            // {mode, tp1..4, slCurrent, tpHits, closes, ...}
      });
    }

    // Last AI decision from memory short-term layer (best-effort)
    let lastDecision = null;
    if (r) {
      try {
        const raw = await r.get('v10:mem:short').catch(() => null);
        const mem = safeParse(raw);
        // Memory short layer stores { decisions: [...], positions: {...} }
        const decisions = mem && Array.isArray(mem.decisions) ? mem.decisions : [];
        const symMem = decisions.filter(m => m.sym === sym).sort((a, b) => (b.ts || 0) - (a.ts || 0));
        if (symMem.length > 0) {
          const m = symMem[0];
          // Normalize: memory uses 'conf' but the frontend chart expects 'confidence'
          lastDecision = {
            ts:         m.ts,
            sym:        m.sym,
            decision:   m.decision,
            family:     m.family,
            confidence: m.conf,            // ← rename for frontend
            regime:     m.regime,
            reason:     m.reason,
            outcome:    m.outcome,
          };
        }
      } catch (_) {}
    }

    return res.status(200).json({
      symbol:        sym,
      timeframe:     tf,
      candles:       candlesResp.candles || [],
      currentPrice:  priceResp.price || null,
      bid:           priceResp.bid || null,
      ask:           priceResp.ask || null,
      regime: {
        regime:     regime.regime,
        score:      regime.score,
        adx:        regime.indicators ? regime.indicators.h1Adx14 : null,
        atr:        regime.indicators ? regime.indicators.h1Atr14 : null,
        chaos:      !!(regime.chaos && regime.chaos.chaos),
        chaosRatio: regime.chaos ? regime.chaos.ratio : null,
      },
      setups,
      observations,
      levels:       levels || { above: [], below: [], currentPrice: null },
      positions:    positionsWithLadder,
      lastDecision,
      ts:           Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'unknown' });
  }
};