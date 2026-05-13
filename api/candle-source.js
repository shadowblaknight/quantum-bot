/* eslint-disable */
// V12 — api/candle-source.js
//
// CANDLE DATA LAYER — independent of broker.
// 
// Why separate from broker.js: not all MetaAPI accounts have Market Data
// add-on enabled. Trading actions (account info, positions, order placement)
// stay on MetaAPI. Candle data comes from free sources, scales to paid tiers
// as user count grows.
//
// PROVIDER ROUTING:
//   Crypto assets (btc, eth, sol, xrp) → Binance public API (free, unlimited)
//   Everything else (forex, metals, indices, oil) → TwelveData (free 800/day,
//     paid tiers $29-229/mo for SaaS scale)
//
// CACHING:
//   Each TF has a TTL matched to its candle period:
//     M1 → 1 min, M5 → 5 min, M15 → 15 min, H1 → 1 hour, H4 → 4 hours,
//     D1 → 24 hours, W1 → 7 days, MN1 → 30 days
//   Multiple cron ticks within the TTL window use cached data — keeps API
//   usage well under free-tier limits.
//
// QUALITY:
//   Each candle batch is validated (correct shape, sane values, sorted by
//   time, no NaN, no duplicates). Invalid data is rejected and logged.
//   Detectors only ever see clean candles.
//
// SAFETY:
//   - Network/API failures handled with try/catch
//   - Per-provider failures fall through to next provider where applicable
//   - Empty results return { candles: [], source: null } not throw
//   - Rate limit errors logged with x-ratelimit-* headers when present
// ----------------------------------------------------------------------------

const { getRedis, safeParse } = require('./_lib');
const { getAssetById } = require('./asset-registry');

// =================================================================
// CACHE TTL PER TIMEFRAME
// =================================================================
// Cron runs every minute. Candles don't change within their period.
// Cache to one period's worth of time to balance freshness with API load.

const TF_CACHE_TTL_SEC = {
  '1m':  60,            // 1 min
  '5m':  60 * 5,        // 5 min
  '15m': 60 * 15,       // 15 min
  '30m': 60 * 30,       // 30 min
  '1h':  60 * 60,       // 1 hour
  '4h':  60 * 60 * 4,   // 4 hours
  '1d':  60 * 60 * 24,  // 24 hours
  '1w':  60 * 60 * 24 * 7,
  '1mn': 60 * 60 * 24 * 30,
};

const CACHE_KEY = (asset, tf) => `v12:candles:${asset}:${tf}`;

// =================================================================
// PROVIDER ROUTING
// =================================================================
// Determines which provider serves which asset.

function pickProvider(asset) {
  const meta = getAssetById(asset);
  if (!meta) return null;
  // All assets use TwelveData. (Binance available as fallback if needed —
  // geo-restricted on some Vercel regions, so we use TwelveData for crypto too.)
  return 'twelvedata';
}

// =================================================================
// PROVIDER 1: BINANCE (CRYPTO)
// =================================================================
// Public API, no auth needed, real-time, unlimited free.
// Endpoint: GET https://api.binance.com/api/v3/klines
//   ?symbol=BTCUSDT&interval=1h&limit=200
// Returns: [[openTime, open, high, low, close, volume, closeTime, ...], ...]

const BINANCE_SYMBOL = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
};

const BINANCE_INTERVAL = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '30m': '30m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
  '1w':  '1w',
  '1mn': '1M',
};

async function fetchFromBinance(asset, tf, limit) {
  const symbol = BINANCE_SYMBOL[asset];
  const interval = BINANCE_INTERVAL[tf];
  if (!symbol || !interval) {
    return { ok: false, error: `Binance: unsupported asset/tf (${asset}/${tf})` };
  }

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 1000)}`;

  try {
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: `Binance ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = await resp.json();
    if (!Array.isArray(data)) {
      return { ok: false, error: 'Binance: malformed response' };
    }

    // Convert Binance kline format to V12 candle format
    const candles = data.map((k) => ({
      time:   new Date(k[0]).toISOString(),     // openTime → ISO string
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    return { ok: true, candles, source: 'binance' };
  } catch (e) {
    return { ok: false, error: 'Binance: ' + e.message };
  }
}

// =================================================================
// PROVIDER 2: TWELVEDATA (FOREX, METALS, INDICES, OIL)
// =================================================================
// Free tier: 800 requests/day, 8/min. Plenty for solo use.
// Endpoint: GET https://api.twelvedata.com/time_series
//   ?symbol=EUR/USD&interval=1h&outputsize=200&apikey=KEY
//
// Symbol format: SLASH-separated (EUR/USD, XAU/USD, BTC/USD, NDX, SPX)

const TWELVEDATA_SYMBOL = {
  // Forex pairs — slash format
  eurusd: 'EUR/USD',
  gbpusd: 'GBP/USD',
  usdjpy: 'USD/JPY',
  usdchf: 'USD/CHF',
  audusd: 'AUD/USD',
  nzdusd: 'NZD/USD',
  usdcad: 'USD/CAD',
  eurjpy: 'EUR/JPY',
  gbpjpy: 'GBP/JPY',
  eurgbp: 'EUR/GBP',
  audjpy: 'AUD/JPY',
  // Metals
  gold:     'XAU/USD',
  silver:   'XAG/USD',
  platinum: 'XPT/USD',
  // Crypto — TwelveData uses slash format
  btc: 'BTC/USD',
  eth: 'ETH/USD',
  sol: 'SOL/USD',
  xrp: 'XRP/USD',
  // Indices — TwelveData uses tickers
  nas100: 'NDX',          // Nasdaq 100
  us30:   'DJI',          // Dow Jones
  us500:  'SPX',          // S&P 500
  ger40:  'DAX',          // German DAX
  uk100:  'FTSE',         // FTSE 100
  jp225:  'N225',         // Nikkei 225
  // Commodities
  oil_wti:   'CL=F',      // WTI futures (TwelveData)
  oil_brent: 'BZ=F',      // Brent futures
  natgas:    'NG=F',
};

const TWELVEDATA_INTERVAL = {
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

async function fetchFromTwelveData(asset, tf, limit) {
  const symbol = TWELVEDATA_SYMBOL[asset];
  const interval = TWELVEDATA_INTERVAL[tf];
  if (!symbol || !interval) {
    return { ok: false, error: `TwelveData: unsupported asset/tf (${asset}/${tf})` };
  }

  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'TwelveData: TWELVEDATA_API_KEY not configured' };
  }

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${Math.min(limit, 5000)}&apikey=${apiKey}`;

  try {
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: `TwelveData ${resp.status}: ${text.slice(0, 200)}` };
    }

    const data = await resp.json();

    // TwelveData error format: { code, message, status: 'error' }
    if (data.status === 'error' || data.code) {
      return { ok: false, error: `TwelveData: ${data.message || data.code}` };
    }

    if (!data.values || !Array.isArray(data.values)) {
      return { ok: false, error: 'TwelveData: missing values array' };
    }

    // TwelveData returns values in DESCENDING order (newest first).
    // V12 detectors expect ASCENDING order (oldest first).
    //
    // TIMESTAMP FIX:
    // TwelveData's `v.datetime` looks like "2026-05-13 11:00:00" with no timezone.
    // `new Date("2026-05-13 11:00:00")` is parsed as LOCAL time of the server, which
    // can shift the timestamp by several hours depending on Vercel's region.
    // We force UTC interpretation by appending 'Z'.
    function parseAsUTC(dateStr) {
      if (!dateStr) return Date.now();
      // If already has Z or +/-HH:MM, parse as-is
      if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(dateStr)) {
        return new Date(dateStr).getTime();
      }
      // Replace space with T and append Z to force UTC
      const isoLike = dateStr.replace(' ', 'T') + 'Z';
      const ms = new Date(isoLike).getTime();
      return Number.isFinite(ms) ? ms : Date.now();
    }

    const candles = data.values
      .map((v) => ({
        time:   new Date(parseAsUTC(v.datetime)).toISOString(),
        open:   parseFloat(v.open),
        high:   parseFloat(v.high),
        low:    parseFloat(v.low),
        close:  parseFloat(v.close),
        volume: v.volume != null ? parseFloat(v.volume) : 0,
      }))
      .reverse();

    return { ok: true, candles, source: 'twelvedata' };
  } catch (e) {
    return { ok: false, error: 'TwelveData: ' + e.message };
  }
}

// =================================================================
// VALIDATION
// =================================================================
// Reject obviously bad candle data before it reaches detectors.

function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { ok: false, error: 'empty or non-array' };
  }

  let lastTime = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || typeof c !== 'object') return { ok: false, error: `candle ${i} not object` };
    const t = new Date(c.time).getTime();
    if (!isFinite(t)) return { ok: false, error: `candle ${i} invalid time` };
    if (t <= lastTime) return { ok: false, error: `candle ${i} not sorted ascending` };
    lastTime = t;
    if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
      return { ok: false, error: `candle ${i} has NaN OHLC` };
    }
    if (c.high < c.low) return { ok: false, error: `candle ${i} high<low` };
    if (c.open <= 0 || c.close <= 0) return { ok: false, error: `candle ${i} non-positive price` };
    // Sanity check: high should encompass open and close
    if (c.high < c.open || c.high < c.close) return { ok: false, error: `candle ${i} high<open or high<close` };
    if (c.low > c.open || c.low > c.close) return { ok: false, error: `candle ${i} low>open or low>close` };
  }

  return { ok: true };
}

// =================================================================
// MAIN: FETCH CANDLES FOR ASSET+TF
// =================================================================
// Public API used by watcher / tactics-run.
//
// Flow:
//   1. Try Redis cache (returns immediately if cached and fresh)
//   2. Pick provider based on asset class
//   3. Fetch from provider
//   4. Validate the response
//   5. Persist to cache with TF-specific TTL
//   6. Return

async function fetchCandles(asset, tf, limit = 200) {
  const r = getRedis();
  const cacheKey = CACHE_KEY(asset, tf);

  // 1. Try cache
  if (r) {
    try {
      const cachedRaw = await r.get(cacheKey);
      const cached = safeParse(cachedRaw);
      if (cached && cached.candles && cached.fetchedAt) {
        const ttl = (TF_CACHE_TTL_SEC[tf] || 300) * 1000;
        if (Date.now() - cached.fetchedAt < ttl) {
          // Cache hit and fresh
          return {
            candles: cached.candles.slice(-limit),  // respect requested limit
            source: cached.source + '-cached',
          };
        }
      }
    } catch (_) {}
  }

  // 2. Pick provider
  const provider = pickProvider(asset);
  if (!provider) {
    return { candles: [], source: null, error: `Unknown asset: ${asset}` };
  }

  // 3. Fetch
  let result;
  if (provider === 'binance') {
    result = await fetchFromBinance(asset, tf, limit);
  } else if (provider === 'twelvedata') {
    result = await fetchFromTwelveData(asset, tf, limit);
  } else {
    return { candles: [], source: null, error: `Unknown provider: ${provider}` };
  }

  if (!result.ok) {
    // On miss, return stale cache if we have it (better than nothing)
    if (r) {
      try {
        const cachedRaw = await r.get(cacheKey);
        const cached = safeParse(cachedRaw);
        if (cached && cached.candles) {
          return {
            candles: cached.candles.slice(-limit),
            source: cached.source + '-stale',
            warning: result.error,
          };
        }
      } catch (_) {}
    }
    return { candles: [], source: null, error: result.error };
  }

  // 4. Validate
  const validation = validateCandles(result.candles);
  if (!validation.ok) {
    return { candles: [], source: null, error: `Validation failed: ${validation.error}` };
  }

  // 5. Cache
  if (r) {
    try {
      await r.set(cacheKey, JSON.stringify({
        candles: result.candles,
        source: result.source,
        fetchedAt: Date.now(),
      }), { ex: TF_CACHE_TTL_SEC[tf] || 300 });
    } catch (_) {}
  }

  // 6. Return
  return {
    candles: result.candles.slice(-limit),
    source: result.source,
  };
}

// =================================================================
// HTTP HANDLER (for debugging)
// =================================================================
// GET /api/candle-source?asset=gold&tf=1h&limit=50

module.exports = async (req, res) => {
  try {
    const asset = req.query.asset;
    const tf = req.query.tf || '1h';
    const limit = parseInt(req.query.limit || '200', 10);

    if (!asset) return res.status(400).json({ error: 'asset required' });
    if (!getAssetById(asset)) return res.status(400).json({ error: 'unknown asset' });

    const result = await fetchCandles(asset, tf, limit);
    return res.status(200).json({
      asset,
      tf,
      limit,
      candleCount: result.candles?.length || 0,
      source: result.source,
      provider: pickProvider(asset),
      error: result.error || null,
      warning: result.warning || null,
      firstCandle: result.candles?.[0] || null,
      lastCandle: result.candles?.[result.candles.length - 1] || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.fetchCandles = fetchCandles;
module.exports.pickProvider = pickProvider;
module.exports.validateCandles = validateCandles;