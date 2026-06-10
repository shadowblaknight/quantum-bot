/* eslint-disable */
// V12.1.2 — api/broker.js
//
// Thin wrapper over MetaAPI (PU Prime / any MT5 broker via MetaAPI).
//
// CRITICAL V12 CHANGE: All public functions accept ASSET IDs (e.g., 'gold', 'btc')
// and internally resolve to broker-specific symbol strings via symbol-resolver.
// This decouples our internal logic from broker symbol conventions forever.
//
// BACKWARD COMPAT: If caller passes something that looks like a broker symbol
// (uppercase, contains digits/dots/hashes), we treat it as already-resolved and
// pass it through. This eases the migration from V11.
//
// ── V12.1 HARDENING PASS (additive — no contract changes) ───────────────────
//   ROOT CAUSE of the /api/broker 5xx emails: the MetaAPI fetch calls had NO
//   timeout. When MetaAPI is slow/unreachable, fetch() hangs, the Vercel
//   function runs past its max duration, and the PLATFORM kills it with a 504
//   (which never appears in your own logs because your code never returns).
//
//   FIX: every MetaAPI call now goes through metaapiFetch(), which:
//     • aborts after BROKER_TIMEOUT_MS (default 3500ms) so the function always
//       returns inside Vercel's budget instead of timing out,
//     • retries once (BROKER_MAX_ATTEMPTS, default 2) on transient failures
//       (network error, abort/timeout, and 408/425/429/500/502/503/504),
//       with a short linear backoff — does NOT retry 4xx (won't self-heal).
//
//   CONTRACTS UNCHANGED: fetchAccount → data | {error}; fetchPositions →
//   array | null (null still SIGNALS a broker miss so manage-trades skips the
//   tick and preserves state); fetchPrice → {price,...} | {error,price:null}.
//   fetchPositions symbol annotation is now time-bounded so resolveAsset can
//   never hang the whole call (falls back to un-annotated positions).
//
//   Tunable via env (optional, sane defaults): BROKER_TIMEOUT_MS,
//   BROKER_MAX_ATTEMPTS, BROKER_BACKOFF_MS.
// ----------------------------------------------------------------------------

const { Redis } = require('@upstash/redis');
const { getAssetById } = require('./asset-registry');
const { resolveSymbol: resolveAssetToBroker, resolveAsset } = require('./symbol-resolver');

const ALL_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mn'];

// Per-TF Redis cache TTLs (seconds). Same as V11.
const TF_CACHE_TTL = {
  '1m':   30,        // 30 seconds
  '5m':   2 * 60,
  '15m':  5 * 60,
  '30m':  10 * 60,
  '1h':   30 * 60,
  '4h':   2 * 60 * 60,
  '1d':   12 * 60 * 60,
  '1w':   24 * 60 * 60,
  '1mn':  3 * 24 * 60 * 60,
};

// =================================================================
// RESILIENCE CONFIG (V12.1)
// =================================================================

// V12.1.2 CORRECTION: single attempt + GENEROUS timeout.
//   History: the original had NO timeout (could hang -> platform 504). V12.1
//   added a 3.5s/2-attempt retry, which (a) aborted slow-but-ALIVE MetaAPI
//   responses early and blanked the dashboard, and (b) doubled request volume.
//   This version keeps a single attempt (no load doubling) but raises the
//   timeout to 8s so a slow-but-healthy MetaAPI gets time to answer instead of
//   being killed at 3.5s. Still caps under Vercel's 10s limit, so it cannot
//   reintroduce the original hang-to-504. If MetaAPI returns a fast error
//   (e.g. 503 nginx page, region mismatch), that comes back immediately and is
//   reported as-is — the timeout only matters for genuinely slow responses.
const BROKER_TIMEOUT_MS   = parseInt(process.env.BROKER_TIMEOUT_MS, 10)   || 8000;
const BROKER_MAX_ATTEMPTS = parseInt(process.env.BROKER_MAX_ATTEMPTS, 10) || 1;
const BROKER_BACKOFF_MS   = parseInt(process.env.BROKER_BACKOFF_MS, 10)   || 500;
const RETRYABLE_STATUS    = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Single choke point for every MetaAPI REST call.
// Returns { resp } on a completed HTTP exchange (ok OR non-retryable non-ok),
// or { error } when all attempts failed (timeout / network / exhausted retries).
async function metaapiFetch(url, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= BROKER_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers: metaapiHeaders(), signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) return { resp };
      // Non-OK response.
      if (RETRYABLE_STATUS.has(resp.status) && attempt < BROKER_MAX_ATTEMPTS) {
        const txt = await resp.text().catch(() => '');
        console.warn(`[broker] ${label} ${resp.status} (attempt ${attempt}/${BROKER_MAX_ATTEMPTS}) retrying: ${txt.slice(0, 120)}`);
        await sleep(BROKER_BACKOFF_MS * attempt);
        continue;
      }
      return { resp }; // non-retryable non-OK (e.g. 401/404) — let caller read it
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const reason = e && e.name === 'AbortError' ? `timeout>${BROKER_TIMEOUT_MS}ms` : (e && e.message) || 'network error';
      if (attempt < BROKER_MAX_ATTEMPTS) {
        console.warn(`[broker] ${label} ${reason} (attempt ${attempt}/${BROKER_MAX_ATTEMPTS}) retrying`);
        await sleep(BROKER_BACKOFF_MS * attempt);
        continue;
      }
      return { error: reason };
    }
  }
  return { error: lastErr ? (lastErr.message || 'unknown') : 'exhausted' };
}

// =================================================================
// REDIS / ENV
// =================================================================

function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try { return new Redis({ url, token }); } catch (_) { return null; }
}

function metaapiBase() {
  const region = process.env.METAAPI_REGION || 'london';
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai`;
}

function metaapiHeaders() {
  return { 'auth-token': process.env.METAAPI_TOKEN, 'Accept': 'application/json' };
}

function accountId() {
  return process.env.METAAPI_ACCOUNT_ID;
}

// =================================================================
// ASSET ↔ BROKER SYMBOL RESOLVER (the V12 magic)
// =================================================================

// Smart resolver: accepts either an asset ID or a broker symbol, returns a broker symbol.
// - "gold" → "XAUUSD.s"   (asset ID, looked up in user's map)
// - "XAUUSD.s" → "XAUUSD.s"   (already a broker symbol, pass through)
//
// Detection heuristic: asset IDs are lowercase, no digits, no dots/hashes.
// Broker symbols have uppercase + maybe digits/dots/hashes.
function looksLikeAssetId(s) {
  if (typeof s !== 'string' || !s) return false;
  // asset IDs: all lowercase letters and underscores only
  return /^[a-z][a-z0-9_]*$/.test(s);
}

async function toBrokerSymbol(assetIdOrSym, userId) {
  if (!assetIdOrSym) return null;
  if (looksLikeAssetId(assetIdOrSym)) {
    // It's an asset ID — resolve via symbol-resolver
    const broker = await resolveAssetToBroker(assetIdOrSym, userId);
    if (!broker) {
      console.warn(`[broker] Asset "${assetIdOrSym}" has no broker mapping. Run symbol-resolver sync.`);
    }
    return broker;
  }
  // Looks like a broker symbol already — pass through
  return assetIdOrSym;
}

// =================================================================
// PUBLIC API: ACCOUNT
// =================================================================

async function fetchAccount() {
  const url = `${metaapiBase()}/users/current/accounts/${accountId()}/account-information`;
  const { resp, error } = await metaapiFetch(url, 'fetchAccount');
  if (error) return { error };
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { error: `account ${resp.status}: ${txt.slice(0, 200)}` };
  }
  try {
    return await resp.json();
  } catch (e) {
    return { error: `account parse: ${e.message}` };
  }
}

// =================================================================
// PUBLIC API: POSITIONS
// =================================================================

async function fetchPositions() {
  const url = `${metaapiBase()}/users/current/accounts/${accountId()}/positions`;
  const { resp, error } = await metaapiFetch(url, 'fetchPositions');
  if (error) {
    console.warn(`[broker] fetchPositions failed: ${error}`);
    return null; // SIGNAL: broker error, NOT a confirmed empty positions list
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.warn(`[broker] fetchPositions ${resp.status}: ${txt.slice(0, 200)}`);
    return null; // SIGNAL: broker error
  }

  let positions = [];
  try {
    positions = await resp.json();
  } catch (e) {
    console.warn(`[broker] fetchPositions parse: ${e.message}`);
    return null;
  }

  // Annotate each with assetId if we can resolve it — but time-bound it so a
  // slow symbol-resolver can never hang the whole request. Fall back to the
  // un-annotated positions (correct, just missing the convenience field).
  try {
    const annotate = Promise.all((positions || []).map(async (p) => {
      const assetId = await resolveAsset(p.symbol).catch(() => null);
      return { ...p, assetId };
    }));
    const cap = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
    const annotated = await Promise.race([annotate, cap]);
    return annotated || positions;
  } catch (_) {
    return positions;
  }
}

// =================================================================
// PUBLIC API: PRICE
// =================================================================

// Accepts asset ID or broker symbol.
async function fetchPrice(assetIdOrSym, userId) {
  const sym = await toBrokerSymbol(assetIdOrSym, userId);
  if (!sym) return { error: 'symbol unresolved', price: null };
  const url = `${metaapiBase()}/users/current/accounts/${accountId()}/symbols/${sym}/current-price`;
  const { resp, error } = await metaapiFetch(url, `fetchPrice ${sym}`);
  if (error) return { error, symbol: sym, price: null };
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { error: `price ${resp.status}: ${txt.slice(0, 200)}`, symbol: sym, price: null };
  }
  try {
    const data = await resp.json();
    // Use mid price; bid/ask available as well
    const bid = data.bid;
    const ask = data.ask;
    const price = (bid != null && ask != null) ? (bid + ask) / 2 : (bid ?? ask ?? null);
    return { symbol: sym, price, bid, ask, time: data.time };
  } catch (e) {
    return { error: e.message, symbol: sym, price: null };
  }
}

// =================================================================
// PUBLIC API: CANDLES
// =================================================================
//
// Candles come from candle-source.js (Binance for crypto, TwelveData for
// everything else). Decoupled from MetaAPI because not all MetaAPI accounts
// have the Market Data add-on.
//
// IMPORTANT: this function takes assetIdOrSym for backward compatibility with
// V11 callers. New V12 callers should pass assetId directly. If a broker
// symbol is passed, we resolve it back to assetId via reverseLookup.

async function fetchCandles(assetIdOrSym, tf, n, userId) {
  if (!ALL_TFS.includes(tf)) return { error: `invalid tf ${tf}`, candles: [] };
  const count = Math.max(1, Math.min(500, parseInt(n, 10) || 100));

  // Normalize to assetId
  let assetId = assetIdOrSym;
  // If it's a broker symbol (contains broker-suffix patterns), resolve back
  if (typeof assetIdOrSym === 'string' && (
    assetIdOrSym.includes('.') || assetIdOrSym.match(/[A-Z]{6,}/)
  )) {
    const { resolveAsset } = require('./symbol-resolver');
    const reversed = await resolveAsset(assetIdOrSym, userId).catch(() => null);
    if (reversed) assetId = reversed;
  }

  // Delegate to candle-source
  const { fetchCandles: fetchFromSource } = require('./candle-source');
  const result = await fetchFromSource(assetId, tf, count);

  if (result.error) {
    return { candles: [], error: result.error, source: result.source };
  }

  return {
    symbol: assetId,
    timeframe: tf,
    count: result.candles.length,
    candles: result.candles,
    source: result.source,
    warning: result.warning,
  };
}

// =================================================================
// PUBLIC API: MULTI-TF (used by tactic validators + recognition)
// =================================================================

async function fetchMultiTF(assetIdOrSym, userId) {
  const sym = await toBrokerSymbol(assetIdOrSym, userId);
  if (!sym) return { error: 'symbol unresolved', timeframes: {} };

  // V12: counts per TF, more recent for fast TFs, fewer for slow
  const tfCounts = {
    '1m': 60, '5m': 60, '15m': 60, '30m': 50, '1h': 100, '4h': 60, '1d': 30,
  };

  const tfs = Object.keys(tfCounts);
  const results = await Promise.all(
    tfs.map(async (tf) => {
      const r = await fetchCandles(sym, tf, tfCounts[tf]);
      return [tf, r.candles || [], r.error];
    })
  );

  const timeframes = {};
  const errors = [];
  for (const [tf, candles, err] of results) {
    timeframes[tf] = candles;
    if (err) errors.push({ tf, error: err });
  }

  return {
    symbol: sym,
    timeframes,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// =================================================================
// HTTP HANDLER (debug / forced fetch)
// =================================================================
//
// V12.1: broker failures are now handled INSIDE the fetch functions (they
// return {error} / null), so a flaky MetaAPI no longer produces a platform
// 5xx here. The 500 in the catch is reserved for genuine unexpected bugs.
// For positions, a broker miss (null) is returned as [] so the dashboard
// shows "no data" rather than crashing — matches App.jsx's Array.isArray guard.

module.exports = async (req, res) => {
  try {
    const action = String(req.query.action || 'account');

    if (action === 'account') {
      return res.status(200).json(await fetchAccount());
    }
    if (action === 'positions') {
      const positions = await fetchPositions();
      // null = broker miss; return [] so the UI degrades gracefully, no 5xx.
      return res.status(200).json(Array.isArray(positions) ? positions : []);
    }
    if (action === 'price') {
      const asset = String(req.query.asset || req.query.symbol || '');
      if (!asset) return res.status(400).json({ error: 'asset or symbol required' });
      return res.status(200).json(await fetchPrice(asset));
    }
    if (action === 'candles') {
      const asset = String(req.query.asset || req.query.symbol || '');
      const tf = String(req.query.tf || '1h');
      const n = parseInt(req.query.n || '100', 10);
      if (!asset) return res.status(400).json({ error: 'asset or symbol required' });
      return res.status(200).json(await fetchCandles(asset, tf, n));
    }
    if (action === 'multi') {
      const asset = String(req.query.asset || req.query.symbol || '');
      if (!asset) return res.status(400).json({ error: 'asset or symbol required' });
      return res.status(200).json(await fetchMultiTF(asset));
    }
    return res.status(400).json({
      error: 'unknown action',
      validActions: ['account', 'positions', 'price', 'candles', 'multi'],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
};

module.exports.fetchAccount   = fetchAccount;
module.exports.fetchPositions = fetchPositions;
module.exports.fetchPrice     = fetchPrice;
module.exports.fetchCandles   = fetchCandles;
module.exports.fetchMultiTF   = fetchMultiTF;
module.exports.toBrokerSymbol = toBrokerSymbol;
module.exports.ALL_TFS        = ALL_TFS;