/* eslint-disable */
// V10 — api/broker.js
// Consolidated MetaAPI broker layer. Replaces V9's account.js + positions.js +
// broker-price.js + broker-candles.js. Single endpoint, action-based routing.
//
// Routes:
//   GET  /api/broker?action=account                          -> account info
//   GET  /api/broker?action=positions                        -> open positions
//   GET  /api/broker?action=price&symbol=XAUUSD              -> bid/ask/spread
//   GET  /api/broker?action=candles&symbol=XAUUSD&tf=1h&n=200 -> OHLCV candles
//   GET  /api/broker?action=multi-tf&symbol=XAUUSD            -> all 9 timeframes at once

const { metaBase, metaHeaders, metaAccountId, applyCors, normSym, getRedis, safeParse } = require('./_lib');

// MetaAPI timeframe mapping (theirs uses different strings)
const TF_MAP = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '30m': '30m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
  '1w':  '1w',
  '1mn': '1mn',
};

const ALL_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mn'];

// Symbol resolution cache — broker-specific suffixes (.s, .pro, etc.)
async function resolveSymbol(baseSym) {
  const r = getRedis();
  if (r) {
    const cached = await r.get('v9:sym:' + baseSym).catch(() => null);
    if (cached) return typeof cached === 'string' ? cached : String(cached);
  }
  // Try common suffixes — PU Prime uses .s
  const candidates = [baseSym + '.s', baseSym, baseSym + '.pro', baseSym + '.raw'];
  for (const cand of candidates) {
    try {
      const url = metaBase() + '/users/current/accounts/' + metaAccountId() + '/symbols/' + encodeURIComponent(cand) + '/current-price';
      const resp = await fetch(url, { headers: metaHeaders() });
      if (resp.ok) {
        if (r) await r.set('v9:sym:' + baseSym, cand, { ex: 86400 * 7 }).catch(() => {});
        return cand;
      }
    } catch (_) {}
  }
  return baseSym; // fallback
}

async function fetchAccount() {
  const url = metaBase() + '/users/current/accounts/' + metaAccountId() + '/account-information';
  const r = await fetch(url, { headers: metaHeaders() });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { error: 'account fetch ' + r.status + ': ' + txt.slice(0, 200) };
  }
  return await r.json();
}

async function fetchPositions() {
  const url = metaBase() + '/users/current/accounts/' + metaAccountId() + '/positions';
  const r = await fetch(url, { headers: metaHeaders() });
  if (!r.ok) return { positions: [], error: 'positions fetch ' + r.status };
  const data = await r.json().catch(() => []);
  const positions = (Array.isArray(data) ? data : []).map((p) => ({
    id:           p.id || p.positionId,
    symbol:       p.symbol,
    type:         p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
    direction:    p.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT',
    volume:       p.volume,
    openPrice:    p.openPrice,
    currentPrice: p.currentPrice,
    stopLoss:     p.stopLoss || null,
    takeProfit:   p.takeProfit || null,
    profit:       p.profit || 0,
    swap:         p.swap || 0,
    commission:   p.commission || 0,
    time:         p.time || p.openTime || null,
    comment:      p.comment || '',
  }));
  return { positions };
}

async function fetchPrice(baseSym) {
  const sym = await resolveSymbol(baseSym);
  const url = metaBase() + '/users/current/accounts/' + metaAccountId() + '/symbols/' + encodeURIComponent(sym) + '/current-price';
  const r = await fetch(url, { headers: metaHeaders() });
  if (!r.ok) return { error: 'price fetch ' + r.status, symbol: sym };
  const data = await r.json();
  const bid = data.bid, ask = data.ask;
  const mid = (bid + ask) / 2;
  return {
    symbol:     sym,
    baseSymbol: baseSym,
    bid, ask,
    price:      mid,
    spread:     ask - bid,
    time:       data.time,
  };
}

async function fetchCandles(baseSym, timeframe, count) {
  const sym = await resolveSymbol(baseSym);
  const tf = TF_MAP[timeframe] || timeframe;
  const n = Math.min(Math.max(count || 100, 10), 1000); // MetaAPI max 1000
  const url = metaBase() + '/users/current/accounts/' + metaAccountId() + '/historical-market-data/symbols/' + encodeURIComponent(sym) + '/timeframes/' + tf + '/candles?limit=' + n;
  const r = await fetch(url, { headers: metaHeaders() });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { candles: [], error: 'candles ' + r.status + ': ' + txt.slice(0, 200) };
  }
  const data = await r.json().catch(() => []);
  const candles = (Array.isArray(data) ? data : []).map((c) => ({
    time:       c.time,
    open:       c.open,
    high:       c.high,
    low:        c.low,
    close:      c.close,
    volume:     c.volume || c.tickVolume || 0,
    tickVolume: c.tickVolume || 0,
  }));
  return { symbol: sym, timeframe: tf, count: candles.length, candles };
}

// Multi-timeframe fetch — used by V10 AI to get full picture in one call
async function fetchMultiTF(baseSym) {
  // Counts per timeframe — more recent for fast TFs, fewer for slow
  const tfCounts = {
    '1m':  60,
    '5m':  60,
    '15m': 60,
    '30m': 50,
    '1h':  100,
    '4h':  60,
    '1d':  60,
    '1w':  30,
    '1mn': 24,
  };
  const sym = await resolveSymbol(baseSym);
  // V10 BUGFIX: Parallel fetch (was sequential -- 3x slower than needed).
  // MetaAPI handles 9 concurrent symbol-candle requests fine.
  const results = await Promise.all(ALL_TFS.map(async (tf) => {
    try {
      const r = await fetchCandles(baseSym, tf, tfCounts[tf]);
      return [tf, r.candles || []];
    } catch (_) { return [tf, []]; }
  }));
  const timeframes = {};
  for (const [tf, candles] of results) timeframes[tf] = candles;
  return { symbol: sym, baseSymbol: baseSym, timeframes };
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const action = String(req.query.action || '').toLowerCase();

  try {
    if (action === 'account') {
      return res.status(200).json(await fetchAccount());
    }
    if (action === 'positions') {
      return res.status(200).json(await fetchPositions());
    }
    if (action === 'price') {
      const sym = String(req.query.symbol || '').toUpperCase();
      if (!sym) return res.status(400).json({ error: 'symbol required' });
      return res.status(200).json(await fetchPrice(sym));
    }
    if (action === 'candles') {
      const sym = String(req.query.symbol || '').toUpperCase();
      const tf  = String(req.query.tf || req.query.timeframe || '1h');
      const n   = parseInt(String(req.query.n || req.query.count || '100'), 10);
      if (!sym) return res.status(400).json({ error: 'symbol required' });
      return res.status(200).json(await fetchCandles(sym, tf, n));
    }
    if (action === 'multi-tf') {
      const sym = String(req.query.symbol || '').toUpperCase();
      if (!sym) return res.status(400).json({ error: 'symbol required' });
      return res.status(200).json(await fetchMultiTF(sym));
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'Unknown error' });
  }
};

module.exports.fetchAccount   = fetchAccount;
module.exports.fetchPositions = fetchPositions;
module.exports.fetchPrice     = fetchPrice;
module.exports.fetchCandles   = fetchCandles;
module.exports.fetchMultiTF   = fetchMultiTF;
module.exports.resolveSymbol  = resolveSymbol;
module.exports.ALL_TFS        = ALL_TFS;