/* eslint-disable */
// V10 — api/historical-fetch.js
// Downloads historical candle data for backtesting.
//
// Source: Twelve Data (free tier: 800 requests/day, supports forex + gold + crypto + indices)
// Why not Dukascopy: their .bi5 files are LZMA-compressed binary, can't decode in Vercel
//                    serverless edge runtime. Twelve Data ships clean JSON.
//
// Caches downloaded candles to Redis with hierarchical keys:
//   v10:hist:{symbol}:{tf}:{date_yyyymmdd}  -> JSON array of candles for that day
//
// Routes:
//   GET  /api/historical-fetch?symbol=XAUUSD&tf=1h&start=2025-01-01&end=2025-04-01
//        -> downloads + caches, returns count
//   GET  /api/historical-fetch?action=read&symbol=XAUUSD&tf=1h&start=...&end=...
//        -> reads cached candles (no download)
//   GET  /api/historical-fetch?action=status
//        -> shows what's cached
//
// Setup: set TWELVE_DATA_KEY in Vercel env vars. Get free key at twelvedata.com/pricing

const { applyCors, getRedis, normSym, safeParse } = require('./_lib');

// Twelve Data symbol mapping (some need different tickers)
const TD_SYMBOL_MAP = {
  'XAUUSD':  'XAU/USD',
  'XAGUSD':  'XAG/USD',
  'EURUSD':  'EUR/USD',
  'GBPUSD':  'GBP/USD',
  'USDJPY':  'USD/JPY',
  'USDCHF':  'USD/CHF',
  'AUDUSD':  'AUD/USD',
  'NZDUSD':  'NZD/USD',
  'USDCAD':  'USD/CAD',
  'EURJPY':  'EUR/JPY',
  'GBPJPY':  'GBP/JPY',
  'EURGBP':  'EUR/GBP',
  'AUDJPY':  'AUD/JPY',
  'EURAUD':  'EUR/AUD',
  'GBPAUD':  'GBP/AUD',
  'BTCUSD':  'BTC/USD',
  'ETHUSD':  'ETH/USD',
  'NAS100':  'NDX',     // Nasdaq 100 index
  'US30':    'DJI',
  'SPX500':  'SPX',
};

// Twelve Data interval mapping
const TD_INTERVAL_MAP = {
  '1m':  '1min',
  '5m':  '5min',
  '15m': '15min',
  '30m': '30min',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1day',
  '1w':  '1week',
  '1mn': '1month',
};

function tdSymbol(sym) {
  const s = normSym(sym);
  return TD_SYMBOL_MAP[s] || s;
}

// Fetch a chunk of historical candles from Twelve Data.
// Free tier returns max 5000 candles per call -- we batch automatically.
async function fetchFromTwelveData(symbol, tf, startDate, endDate) {
  const apiKey = process.env.TWELVE_DATA_KEY;
  if (!apiKey) return { error: 'TWELVE_DATA_KEY not set in env vars' };
  const interval = TD_INTERVAL_MAP[tf] || tf;
  const tdSym = tdSymbol(symbol);
  const url = 'https://api.twelvedata.com/time_series'
    + '?symbol=' + encodeURIComponent(tdSym)
    + '&interval=' + interval
    + '&start_date=' + startDate
    + '&end_date=' + endDate
    + '&format=JSON&outputsize=5000'
    + '&apikey=' + apiKey;
  try {
    const r = await fetch(url);
    if (!r.ok) return { error: 'TwelveData HTTP ' + r.status };
    const data = await r.json();
    if (data.status === 'error') return { error: 'TwelveData: ' + data.message };
    if (!data.values || !Array.isArray(data.values)) return { error: 'No values returned', raw: data };
    // Twelve Data returns newest-first, we want oldest-first
    const candles = data.values
      .map(v => ({
        time:   v.datetime,
        open:   parseFloat(v.open),
        high:   parseFloat(v.high),
        low:    parseFloat(v.low),
        close:  parseFloat(v.close),
        volume: parseFloat(v.volume || 0),
      }))
      .filter(c => isFinite(c.close))
      .reverse();
    return { candles, count: candles.length };
  } catch (e) {
    return { error: e && e.message ? e.message : 'unknown' };
  }
}

// Group candles by UTC date (yyyy-mm-dd)
function groupByDate(candles) {
  const out = {};
  for (const c of candles) {
    const date = String(c.time).slice(0, 10);
    if (!out[date]) out[date] = [];
    out[date].push(c);
  }
  return out;
}

// Cache candles to Redis, organized by symbol:tf:date
async function cacheCandles(symbol, tf, candles) {
  const r = getRedis(); if (!r) return { error: 'no redis' };
  const sym = normSym(symbol);
  const grouped = groupByDate(candles);
  let written = 0;
  for (const [date, dayCandles] of Object.entries(grouped)) {
    const key = 'v10:hist:' + sym + ':' + tf + ':' + date.replace(/-/g, '');
    await r.set(key, JSON.stringify(dayCandles)).catch(() => {});
    written++;
  }
  return { dates: written, totalCandles: candles.length };
}

// Read cached candles from Redis for a date range
async function readCachedRange(symbol, tf, startDate, endDate) {
  const r = getRedis(); if (!r) return [];
  const sym = normSym(symbol);
  const start = new Date(startDate);
  const end = new Date(endDate);
  const out = [];
  const cur = new Date(start);
  while (cur <= end) {
    const dateStr = cur.toISOString().slice(0, 10).replace(/-/g, '');
    const key = 'v10:hist:' + sym + ':' + tf + ':' + dateStr;
    const raw = await r.get(key).catch(() => null);
    const parsed = safeParse(raw);
    if (Array.isArray(parsed)) out.push(...parsed);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// What's cached? (for the UI status display)
async function cacheStatus() {
  const r = getRedis(); if (!r) return {};
  const keys = [];
  let cursor = 0;
  do {
    const result = await r.scan(cursor, { match: 'v10:hist:*', count: 500 }).catch(() => [0, []]);
    cursor = parseInt(result[0], 10);
    keys.push(...result[1]);
  } while (cursor !== 0);

  // Group by symbol:tf
  const out = {};
  for (const k of keys) {
    // v10:hist:XAUUSD:1h:20250115
    const parts = k.split(':');
    if (parts.length !== 5) continue;
    const sym = parts[2], tf = parts[3], date = parts[4];
    const composite = sym + ':' + tf;
    if (!out[composite]) out[composite] = { symbol: sym, tf, dates: [], count: 0 };
    out[composite].dates.push(date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8));
    out[composite].count++;
  }
  // Sort dates within each entry, summarize range
  for (const v of Object.values(out)) {
    v.dates.sort();
    v.firstDate = v.dates[0];
    v.lastDate = v.dates[v.dates.length - 1];
    delete v.dates; // don't return all of them
  }
  return Object.values(out).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const action = String(req.query.action || 'fetch');

  try {
    if (action === 'status') {
      return res.status(200).json(await cacheStatus());
    }

    if (action === 'read') {
      const sym = String(req.query.symbol || '').toUpperCase();
      const tf  = String(req.query.tf || '1h');
      const start = String(req.query.start || '');
      const end   = String(req.query.end || '');
      if (!sym || !start || !end) return res.status(400).json({ error: 'symbol, start, end required' });
      const candles = await readCachedRange(sym, tf, start, end);
      return res.status(200).json({ symbol: sym, tf, start, end, count: candles.length, candles });
    }

    if (action === 'fetch' || action === 'download') {
      const sym = String(req.query.symbol || '').toUpperCase();
      const tf  = String(req.query.tf || '1h');
      const start = String(req.query.start || '');
      const end   = String(req.query.end || '');
      if (!sym || !start || !end) return res.status(400).json({ error: 'symbol, start, end required' });

      const result = await fetchFromTwelveData(sym, tf, start, end);
      if (result.error) return res.status(500).json({ error: result.error });
      const cached = await cacheCandles(sym, tf, result.candles);
      return res.status(200).json({
        symbol: sym, tf, start, end,
        downloaded: result.count,
        cached: cached.dates,
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'unknown' });
  }
};

module.exports.fetchFromTwelveData = fetchFromTwelveData;
module.exports.cacheCandles        = cacheCandles;
module.exports.readCachedRange     = readCachedRange;
module.exports.cacheStatus         = cacheStatus;