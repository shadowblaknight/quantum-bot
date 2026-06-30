/* eslint-disable */
// V12.5 — api/candle-source.js
//
// CANDLE DATA LAYER — MetaAPI broker-direct.
//
// V12.5 FIX (the stale high-timeframe bug):
//   MetaAPI's historical-market-data endpoint loads candles BACKWARD from
//   `startTime` — the returned batch ENDS at startTime. The previous code set
//   startTime to (now − count×period×factor), i.e. a point in the PAST, so the
//   newest candle returned was exactly that far back: 26-day-old 4h, 4.6-year-
//   old 1w, etc. The freshness guard then (correctly) rejected them, so every
//   high-TF read failed. Low TFs survived only because their offset was tiny.
//   Fix: anchor startTime to NOW (the right edge); MetaAPI then returns the
//   most-recent `limit` candles. (See fetchFromMetaAPI step 3.)
//
// V12.4 PIVOT (from V12.3 TwelveData-based):
// We previously used TwelveData (free 800/day, with NAS100/S&P500 gaps) and
// Binance (crypto only, geo-restricted). Both required separate symbol-mapping
// tables that drifted from the broker's actual symbols.
//
// Now: MetaAPI is the sole provider. Reasons:
//   1. Single source of truth — same data the bot trades on
//   2. No quota — we already pay the broker via spread
//   3. No symbol-mapping drift — symbol-resolver auto-syncs broker symbols
//   4. NAS100, indices, exotic pairs all work if the broker offers them
//   5. Real-time freshness — no 5-min TwelveData staleness
//
// Endpoint:
//   GET https://mt-market-data-client-api-v1.{region}.agiliumtrade.ai
//       /users/current/accounts/{accountId}
//       /historical-market-data/symbols/{brokerSymbol}/timeframes/{tf}/candles
//       ?startTime={ISO}&limit={N}
//   Headers: auth-token: {METAAPI_TOKEN}
//
// CACHING:
//   Each TF has a TTL matched to its candle period. Multiple cron ticks
//   within the TTL use cached data — drastically reduces MetaAPI load.
//
// QUALITY:
//   Each candle batch validated (correct shape, sane values, sorted by time,
//   no NaN, no duplicates). Invalid data rejected and logged.
//
// SAFETY:
//   - Auto-bootstrap symbol map if empty (one sync, then cached)
//   - Network/API failures handled with try/catch
//   - Empty results return { candles: [], source: null }, never throw
//   - On miss, falls back to stale cache if available
// ----------------------------------------------------------------------------

const { getRedis, safeParse } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { resolveSymbol, syncBrokerSymbols } = require('./symbol-resolver');

// =================================================================
// CACHE TTL PER TIMEFRAME
// =================================================================
// Cron runs every minute. Candles don't change within their period.
// Cache to one period's worth of time to balance freshness with API load.

const TF_CACHE_TTL_SEC = {
  '1m':  60,
  '5m':  60 * 5,
  '15m': 60 * 15,
  '30m': 60 * 30,
  '1h':  60 * 60,
  '4h':  60 * 60 * 4,
  '1d':  60 * 60 * 24,
  '1w':  60 * 60 * 24 * 7,
  '1mn': 60 * 60 * 24 * 30,
};

// Milliseconds per timeframe — used to compute startTime for `limit` candles
const TF_MS = {
  '1m':  60 * 1000,
  '5m':  5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h':  60 * 60 * 1000,
  '4h':  4 * 60 * 60 * 1000,
  '1d':  24 * 60 * 60 * 1000,
  '1w':  7 * 24 * 60 * 60 * 1000,
  '1mn': 30 * 24 * 60 * 60 * 1000,
};

// V12.5: bumped namespace from `v12:candles2:` so the deploy that fixes the
// stale-startTime bug doesn't inherit any of the old broken entries (some held
// for up to 7 days under their TTL). Old keys expire naturally per their TTLs.
function CACHE_KEY(asset, tf) { return `v12:candles3:${asset}:${tf}`; }

// =================================================================
// PROVIDER ROUTING
// =================================================================
// V12.4: MetaAPI for everything. Single source.

function pickProvider(asset) {
  const meta = getAssetById(asset);
  if (!meta) return null;
  return 'metaapi';
}

// =================================================================
// METAAPI HISTORICAL CANDLES
// =================================================================
// MetaAPI is the bot's broker connection. We reuse the auth token, account
// ID, and region that already work for order placement. Symbol mapping is
// delegated to symbol-resolver (auto-syncs broker symbols, handles `.s` /
// `ft.s` priority for PU Prime, persists in Redis).
//
// IMPORTANT: market-data API is on a DIFFERENT subdomain from the trading
// API. trading = `mt-client-api-v1`, market-data = `mt-market-data-client-api-v1`.

const METAAPI_REGION = process.env.METAAPI_REGION || 'london';

// V12.4.1 — MetaAPI rate limits historical-data requests to 5 concurrent per
// account. Our cron fires 6 assets × 3 TFs = 18 requests in parallel which
// trips this limit, causing 429 errors, retries, slow ticks, and ultimately
// Vercel function timeouts that kill the entire watcher mid-write.
//
// Solution: a lightweight global semaphore that throttles concurrent calls
// into `fetchFromMetaAPI` to 4 (1 slot of headroom under the 5-cap). Pending
// requests queue and resolve in FIFO order.
const METAAPI_MAX_CONCURRENT = 4;
let _metaapiActiveCount = 0;
const _metaapiQueue = [];

function _metaapiAcquire() {
  return new Promise((resolve) => {
    if (_metaapiActiveCount < METAAPI_MAX_CONCURRENT) {
      _metaapiActiveCount++;
      resolve();
    } else {
      _metaapiQueue.push(resolve);
    }
  });
}

function _metaapiRelease() {
  _metaapiActiveCount--;
  if (_metaapiQueue.length > 0) {
    const next = _metaapiQueue.shift();
    _metaapiActiveCount++;
    next();
  }
}

function metaapiCandlesUrl(accountId, brokerSymbol, tf, startTimeIso, limit) {
  return `https://mt-market-data-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai`
    + `/users/current/accounts/${accountId}`
    + `/historical-market-data/symbols/${encodeURIComponent(brokerSymbol)}`
    + `/timeframes/${tf}/candles`
    + `?startTime=${encodeURIComponent(startTimeIso)}`
    + `&limit=${limit}`;
}

async function fetchFromMetaAPI(asset, tf, limit) {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  if (!token || !accountId) {
    return { ok: false, error: 'MetaAPI: METAAPI_TOKEN or METAAPI_ACCOUNT_ID missing' };
  }
  if (!TF_MS[tf]) {
    return { ok: false, error: `MetaAPI: unsupported TF ${tf}` };
  }

  // 1. Resolve broker symbol from the auto-synced map
  let brokerSymbol = await resolveSymbol(asset);

  // 2. Auto-bootstrap: if map is empty (fresh deploy), sync now
  if (!brokerSymbol) {
    try {
      const syncResult = await syncBrokerSymbols();
      if (!syncResult || !syncResult.ok) {
        return {
          ok: false,
          error: `MetaAPI symbol sync failed: ${syncResult?.error || 'unknown'}`,
        };
      }
      brokerSymbol = await resolveSymbol(asset);
    } catch (e) {
      return { ok: false, error: 'MetaAPI symbol sync threw: ' + e.message };
    }
  }
  if (!brokerSymbol) {
    return { ok: false, error: `Asset ${asset} not available on broker (no symbol after sync)` };
  }

  // 3. startTime = NOW (the RIGHT edge).
  //    MetaAPI's historical-market-data endpoint loads candles BACKWARD from
  //    startTime (the returned batch ENDS at startTime), then we keep the tail.
  //    So to get the most-recent `limit` candles we anchor startTime to now.
  //    A one-period forward nudge guarantees the latest (possibly just-closed)
  //    candle is included regardless of boundary handling; MetaAPI clamps to
  //    the latest real candle, so no future/empty results.
  //    (The old code set startTime to now − count×period×factor, which made
  //    MetaAPI return candles ENDING that far in the past — the stale-data bug.)
  const cap = Math.min(limit, 1000);
  const nowMs = Date.now();
  const startTimeIso = new Date(nowMs + TF_MS[tf]).toISOString();

  const url = metaapiCandlesUrl(accountId, brokerSymbol, tf, startTimeIso, cap);

  // V12.4.1: throttle through semaphore so we never exceed MetaAPI's
  // 5-concurrent cap. Without this, 18 parallel requests trigger 429s.
  await _metaapiAcquire();

  try {
    const resp = await fetch(url, {
      headers: {
        'auth-token': token,
        'Accept': 'application/json',
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // 404 typically means symbol unknown OR account not provisioned
      // 401 means token wrong
      // 429 means rate limited
      return {
        ok: false,
        error: `MetaAPI ${resp.status}: ${text.slice(0, 200)}`,
        status: resp.status,
      };
    }

    const data = await resp.json();
    if (!Array.isArray(data)) {
      return { ok: false, error: 'MetaAPI: malformed response (not an array)' };
    }
    if (data.length === 0) {
      return { ok: false, error: 'MetaAPI: empty candle array (market closed or no data)' };
    }

    // Convert MetaAPI candle → V12 candle format.
    // tickVolume preferred over volume for forex (real volume often 0 on MT5).
    let candles = data.map((c) => ({
      time: c.time,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.tickVolume != null ? c.tickVolume : (c.volume || 0)),
    }));

    // Defensive: ensure ascending order by time
    candles.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    // Keep only the most-recent `cap` candles (we anchored startTime=NOW, so the
    // tail IS the most recent — but slice defensively in case MetaAPI returns
    // more than requested).
    if (candles.length > cap) candles = candles.slice(-cap);

    // FRESHNESS GUARD — V12.4.1: weekend-tolerant.
    //
    // All sub-daily TFs get 72-hour limit so Friday close → Monday open
    // doesn't trigger false rejections. Only multi-day stale data (broker
    // truly dead) gets blocked.
    const FRESHNESS_LIMIT_MS = {
      '1m':  4  * 60 * 60 * 1000,           // 4 hours
      '5m':  72 * 60 * 60 * 1000,           // 72 hours (weekend tolerance)
      '15m': 72 * 60 * 60 * 1000,           // 72 hours
      '1h':  72 * 60 * 60 * 1000,           // 72 hours
      '4h':  7  * 24 * 60 * 60 * 1000,      // 7 days
      '1d':  14 * 24 * 60 * 60 * 1000,      // 14 days
      '1w':  60 * 24 * 60 * 60 * 1000,      // 60 days
      '1mn': 365 * 24 * 60 * 60 * 1000,     // 1 year
    };
    const lastCandleAgeMs = nowMs - new Date(candles[candles.length - 1].time).getTime();
    const maxStaleMs = FRESHNESS_LIMIT_MS[tf] || (TF_MS[tf] * 100);
    if (lastCandleAgeMs > maxStaleMs) {
      return {
        ok: false,
        error: `MetaAPI stale: latest ${tf} candle is ${Math.round(lastCandleAgeMs / 60000)}min old (max ${Math.round(maxStaleMs / 60000)}min) — broker likely disconnected or symbol unsubscribed`,
      };
    }

    return { ok: true, candles, source: `metaapi(${brokerSymbol})` };
  } catch (e) {
    return { ok: false, error: 'MetaAPI: ' + e.message };
  } finally {
    _metaapiRelease();
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
    if (c.high < c.open || c.high < c.close) return { ok: false, error: `candle ${i} high<open or high<close` };
    if (c.low > c.open || c.low > c.close) return { ok: false, error: `candle ${i} low>open or low>close` };
  }

  return { ok: true };
}

// =================================================================
// MAIN: FETCH CANDLES FOR ASSET+TF
// =================================================================
// Public API used by watcher / events-run.
//
// Flow:
//   1. Try Redis cache (immediate return if fresh)
//   2. Fetch from MetaAPI
//   3. Validate the response
//   4. Persist to cache with TF-specific TTL
//   5. Return
//   On failure: fall back to stale cache if exists, else empty array.

async function fetchCandles(asset, tf, limit = 200, opts = {}) {
  const r = getRedis();
  const cacheKey = CACHE_KEY(asset, tf);
  const bypassCache = opts.bypassCache === true;

  // 1. Try cache (unless explicitly bypassed)
  if (r && !bypassCache) {
    try {
      const cachedRaw = await r.get(cacheKey);
      const cached = safeParse(cachedRaw);
      if (cached && cached.candles && cached.fetchedAt) {
        const ttl = (TF_CACHE_TTL_SEC[tf] || 300) * 1000;
        if (Date.now() - cached.fetchedAt < ttl) {
          return {
            candles: cached.candles.slice(-limit),
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
  if (provider === 'metaapi') {
    result = await fetchFromMetaAPI(asset, tf, limit);
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
    const bypassCache = req.query.fresh === '1';

    if (!asset) return res.status(400).json({ error: 'asset required' });
    if (!getAssetById(asset)) return res.status(400).json({ error: 'unknown asset' });

    const result = await fetchCandles(asset, tf, limit, { bypassCache });
    return res.status(200).json({
      asset,
      tf,
      limit,
      bypassCache,
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
module.exports.fetchFromMetaAPI = fetchFromMetaAPI;