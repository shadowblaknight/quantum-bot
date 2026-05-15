/* eslint-disable */
// V12.4 — api/quotes.js
//
// LIGHTWEIGHT PRICE QUOTE ENDPOINT for the cockpit live tape.
//
// Returns the latest price plus a short history of recent closes for sparkline
// rendering. Reads from the M1 candle cache populated by the cron — so calls
// are cheap (Redis hit) and only the cron actually talks to MetaAPI.
//
// Granularity: M1 (1-minute closes). For true tick streaming we'd need a
// long-running WebSocket subscriber, which Vercel's stateless functions don't
// support. M1 closes give a real sense of price movement at minimal cost.
//
// Response shape:
//   {
//     asset:        'gold',
//     price:        4691.55,         // most recent close
//     history:      [4690.1, ...],   // last 30 closes (oldest → newest)
//     change:       -0.12,           // % change first → last
//     high:         4699.20,         // max in window
//     low:          4688.10,         // min in window
//     candleCount:  30,
//     tf:           '1m',
//     source:       'metaapi(XAUUSD.s)-cached',
//     updatedAt:    1715740812345,
//   }
//
// Errors return 200 with { asset, price: null, history: [], error: '...' }
// so the UI can display a tasteful empty state rather than crashing.

const { fetchCandles } = require('./candle-source');
const { getAssetById } = require('./asset-registry');

module.exports = async (req, res) => {
  try {
    const asset = req.query.asset;
    if (!asset) return res.status(400).json({ error: 'asset required' });
    if (!getAssetById(asset)) return res.status(400).json({ error: 'unknown asset' });

    const tf = '1m';
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 60);

    const result = await fetchCandles(asset, tf, limit);
    if (!result.candles || result.candles.length === 0) {
      return res.status(200).json({
        asset,
        price: null,
        history: [],
        error: result.error || 'no candles available',
        updatedAt: Date.now(),
      });
    }

    const closes = result.candles.map((c) => c.close);
    const price = closes[closes.length - 1];
    const first = closes[0];
    const change = first > 0 ? ((price - first) / first) * 100 : 0;
    const high = Math.max(...closes);
    const low = Math.min(...closes);

    return res.status(200).json({
      asset,
      price,
      history: closes,
      change,
      high,
      low,
      candleCount: closes.length,
      tf,
      source: result.source,
      updatedAt: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};