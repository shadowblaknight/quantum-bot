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

// Short-lived positions cache: multiple Lambda functions (manage-trades every 1min,
// alexg-run every 15min, alexg-watchdog every 5min, dashboard polls) independently
// call fetchPositions(). When they overlap they burst MetaAPI with concurrent
// identical requests. A 30s cache ensures only ONE call reaches MetaAPI per window.
// manage-trades fires every 60s so the cache always expires before the next tick.
const POSITIONS_CACHE_KEY = 'v14:broker:positions:cache';
const POSITIONS_CACHE_TTL = 30; // seconds
const ORDERS_CACHE_KEY    = 'v21:broker:orders:cache';
const ORDERS_CACHE_TTL    = 15; // seconds — shorter than positions: a resting
// limit can fill or be cancelled at any tick, and this feeds an entry decision.

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
//   timeout to 14s so a slow-but-healthy MetaAPI gets time to answer. The
//   original 8s was too tight — MetaAPI has been observed taking >8s during
//   low-activity hours (01:00–05:00 UTC). manage-trades has a 30s maxDuration
//   so 14s is well within budget and still safely below the platform kill limit.
const BROKER_TIMEOUT_MS   = parseInt(process.env.BROKER_TIMEOUT_MS, 10)   || 14000;
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
      // Record 404s before handing the response back. See recordNotFound.
      if (resp.status === 404) await recordNotFound(url, label, resp);
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
// NotFoundError RECORDER  (added 2026-09-28 — logging only)
// =================================================================
// WHY THIS EXISTS. MetaAPI throttles a TOKEN, not an account, once it sees too
// many 404s against unexisting or undeployed accounts. Its 429 body says
// literally: "check your application logs for occurrences of NotFoundError".
//
// On 2026-09-28 a live gold SHORT was rejected by exactly that throttle, and
// there was nothing to check. Two reasons, both structural:
//   1. A rejected order never reaches stdout. execute.js has ONE console line
//      in the whole file and it is about a positions fetch, so the broker
//      error only ever went to Redis + Telegram.
//   2. Vercel runtime log retention on this plan is ~50 MINUTES (measured:
//      asked for 7 days, got 15:13-16:03). A console line would have expired
//      hours before anyone looked.
// So a console.error here would have been useless. This writes to the Redis
// activity log instead — 200 entries, 7-day TTL — which is the same place the
// 429 itself was still readable from days later.
//
// DEDUPED to one entry per endpoint-shape per 10 minutes. The activity log is
// capped at 200 entries and is the source of truth for trades; a 404 on the
// every-minute manage-trades cron would otherwise flush the entire trade
// history out of it in about three hours.
//
// THIS CANNOT TOUCH A TRADE. It reads a cloned response, writes one log entry,
// and swallows every error it can raise.
const NF_DEDUPE_SEC = 600;

async function recordNotFound(url, label, resp) {
  try {
    const acct = accountId() || '(unset)';
    // Endpoint shape with the account id substituted out, so the dedupe key
    // groups calls to the same endpoint no matter which account they named.
    let path;
    try { path = new URL(url).pathname.split(acct).join('{account}'); }
    catch (_) { path = label || 'unknown'; }

    const r = getRedis();
    if (r) {
      // set-if-absent is atomic, so two lambdas hitting the same 404 in the
      // same window cannot both write.
      const fresh = await r.set(`v13:nf:${path}`, 1, { nx: true, ex: NF_DEDUPE_SEC });
      if (!fresh) return;
    }

    // CLONE. The caller still has to read this body — consuming the stream
    // here would hand them an empty one and break every 404 error message.
    const body = await resp.clone().text().catch(() => '');

    // Lazy require: rules-store does not import broker today, but this keeps
    // the choke point free of a load-order dependency either way.
    const { logActivity } = require('./rules-store');
    await logActivity({
      type: 'metaapi-404',
      label: label || null,
      accountId: acct,
      path,
      body: body.slice(0, 300),
      note: `deduped 1 per ${NF_DEDUPE_SEC / 60}min`,
    });
  } catch (_) { /* logging must never break a broker call */ }
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
  // Serve from cache if a recent fetch already ran (prevents burst when multiple
  // Lambda invocations overlap). manage-trades' 60s interval always outlasts the
  // 30s TTL, so each cron tick still gets a fresh read.
  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get(POSITIONS_CACHE_KEY).catch(() => null);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) { /* cache miss — fall through to live fetch */ }
  }

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
  let result = positions;
  try {
    const annotate = Promise.all((positions || []).map(async (p) => {
      const assetId = await resolveAsset(p.symbol).catch(() => null);
      return { ...p, assetId };
    }));
    const cap = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
    const annotated = await Promise.race([annotate, cap]);
    result = annotated || positions;
  } catch (_) {
    result = positions;
  }

  // Write to cache after a successful live fetch
  if (r && Array.isArray(result)) {
    try { await r.set(POSITIONS_CACHE_KEY, JSON.stringify(result), { ex: POSITIONS_CACHE_TTL }); } catch (_) {}
  }

  return result;
}

// =================================================================
// PUBLIC API: PENDING ORDERS
// =================================================================
// ADDED 2026-09-21. Until now nothing in this codebase ever read /orders, so
// every "is something already running on this asset?" check was blind to a
// resting limit that had not filled yet. With C2 retest entries the order can
// sit unfilled for HOURS, so that blind spot is the normal case, not an edge
// one: Frankfurt arms a limit at 08:00, London fires at 09:00, the guard sees
// no POSITION, and both orders end up live.
//
// Returns null on any broker error — same contract as fetchPositions, so the
// caller can tell "broker is unreachable" apart from "no pending orders",
// which must never be conflated when the answer gates placing a trade.
async function fetchOrders() {
  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get(ORDERS_CACHE_KEY).catch(() => null);
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) { /* cache miss — fall through to live fetch */ }
  }

  const url = `${metaapiBase()}/users/current/accounts/${accountId()}/orders`;
  const { resp, error } = await metaapiFetch(url, 'fetchOrders');
  if (error) {
    console.warn(`[broker] fetchOrders failed: ${error}`);
    return null; // SIGNAL: broker error, NOT a confirmed empty order book
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.warn(`[broker] fetchOrders ${resp.status}: ${txt.slice(0, 200)}`);
    return null;
  }

  let orders = [];
  try {
    orders = await resp.json();
  } catch (e) {
    console.warn(`[broker] fetchOrders parse: ${e.message}`);
    return null;
  }

  // Same assetId annotation as positions, same 1.5s cap so a slow resolver can
  // never hang an entry decision.
  let result = orders;
  try {
    const annotate = Promise.all((orders || []).map(async (o) => {
      const assetId = await resolveAsset(o.symbol).catch(() => null);
      return { ...o, assetId };
    }));
    const cap = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
    const annotated = await Promise.race([annotate, cap]);
    result = annotated || orders;
  } catch (_) {
    result = orders;
  }

  if (r && Array.isArray(result)) {
    try { await r.set(ORDERS_CACHE_KEY, JSON.stringify(result), { ex: ORDERS_CACHE_TTL }); } catch (_) {}
  }

  return result;
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
module.exports.fetchOrders    = fetchOrders;
module.exports.fetchPrice     = fetchPrice;
module.exports.fetchCandles   = fetchCandles;
module.exports.fetchMultiTF   = fetchMultiTF;
module.exports.toBrokerSymbol = toBrokerSymbol;
module.exports.ALL_TFS        = ALL_TFS;