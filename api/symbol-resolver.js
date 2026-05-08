/* eslint-disable */
// V12 — api/symbol-resolver.js
//
// Bridge between asset IDs (used everywhere internally) and broker-specific symbol
// strings (used only when calling MetaAPI / placing orders).
//
// CORE FUNCTIONS:
//   syncBrokerSymbols(userId?) — fetches user's broker symbol list, auto-builds map
//   resolveSymbol(assetId, userId?) — assetId → broker symbol string
//   resolveAsset(brokerSymbol, userId?) — broker symbol → asset id (reverse lookup)
//   getMappedAssets(userId?) — list of asset IDs successfully mapped for this user
//   getUnmappedSymbols(userId?) — broker symbols we couldn't auto-match (shown in UI for manual)
//
// STORAGE:
//   v12:symmap:{userId} — JSON map { assetId: brokerSymbol, ... }
//   v12:symmap:meta:{userId} — sync timestamp, broker name, unmapped symbols, sync source
//
// USAGE EXAMPLE:
//   const broker = await resolveSymbol('gold');           // → "XAUUSD.s"
//   const broker = await resolveSymbol('btc', userId);    // → "BTCUSDm" (per-user)
//   const candles = await fetchCandles(broker, '1h', 100);
//
// NOTE on userId: V12 is currently single-user (Omar). Functions accept an optional userId
// for forward compatibility with V13 multi-tenant. If omitted, falls back to a default user.
// ----------------------------------------------------------------------------

const { Redis } = require('@upstash/redis');
const { matchBrokerSymbol, getAssetById, getAllAssetIds } = require('./asset-registry');

// Single-user fallback (Omar). When V13 multi-tenant arrives, every call passes userId.
const DEFAULT_USER = 'default';

const SYNC_TTL_HOURS = 24; // re-sync once a day automatically; user can force via UI

// =================================================================
// REDIS HELPERS
// =================================================================

function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try { return new Redis({ url, token }); } catch (_) { return null; }
}

function symMapKey(userId) {
  return `v12:symmap:${userId || DEFAULT_USER}`;
}

function symMapMetaKey(userId) {
  return `v12:symmap:meta:${userId || DEFAULT_USER}`;
}

function safeParse(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// =================================================================
// METAAPI: FETCH AVAILABLE SYMBOLS
// =================================================================

// Fetch the full list of symbol strings available on the user's broker account.
// Calls MetaAPI's /accounts/{id}/symbols endpoint.
async function fetchBrokerSymbols() {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region = process.env.METAAPI_REGION || 'london';
  if (!token || !accountId) {
    return { ok: false, error: 'MetaAPI credentials missing', symbols: [] };
  }
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/symbols`;
  try {
    const resp = await fetch(url, {
      headers: { 'auth-token': token, 'Accept': 'application/json' },
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `MetaAPI ${resp.status}: ${txt.slice(0, 200)}`, symbols: [] };
    }
    const data = await resp.json();
    const symbols = Array.isArray(data) ? data : (data.symbols || []);
    return { ok: true, symbols };
  } catch (e) {
    return { ok: false, error: e.message, symbols: [] };
  }
}

// =================================================================
// SYNC: BUILD THE PER-USER MAP
// =================================================================

// Score a broker symbol for "tradeability priority" when multiple match the same asset.
// Higher score = preferred. PU Prime convention: `.s` suffix = standard tradeable spot;
// futures (`ft`), cash (`.cash`), or non-suffixed equity tickers should be deprioritized.
function symbolPriority(sym, matchType) {
  let score = 0;
  // Exact match strongly preferred over fuzzy
  if (matchType === 'exact') score += 100;

  const upper = String(sym).toUpperCase();

  // Strong positive signals
  if (upper.endsWith('.S')) score += 30;     // .s = PU Prime standard tradeable
  if (upper.endsWith('M')) score += 20;      // m = micro/MT4 standard
  if (upper.endsWith('.STD')) score += 15;
  if (upper.endsWith('.PRO')) score += 10;
  if (upper.endsWith('.RAW')) score += 10;

  // Strong negatives — these aren't the canonical tradeable spot/CFD
  if (upper.endsWith('FT.S')) score -= 25;   // futures: NAS100FT.S, DJ30FT.S, JPN225FT.S
  if (upper.endsWith('.CASH')) score -= 10;
  if (upper.endsWith('.CRP')) score -= 25;
  if (upper.endsWith('.24H')) score -= 15;
  if (upper.includes('FT')) score -= 5;

  // Minor tie-breaker
  score -= upper.length * 0.1;

  return score;
}

// Fetch broker symbols, auto-match each one against asset registry, persist the map.
// Returns: { ok, mapped, unmapped, brokerSymbols, syncedAt, error? }
async function syncBrokerSymbols(userId) {
  const r = getRedis();
  if (!r) return { ok: false, error: 'Redis unavailable' };

  const fetchResult = await fetchBrokerSymbols();
  if (!fetchResult.ok) return { ok: false, error: fetchResult.error };

  const brokerSymbols = fetchResult.symbols;
  const mapped = {};       // assetId → brokerSymbol
  const reverseMap = {};   // brokerSymbol → assetId  (for collision detection)
  const unmapped = [];     // broker symbols we couldn't match
  const conflicts = [];    // multiple broker symbols matching same asset (rare but real)

  for (const brokerSym of brokerSymbols) {
    if (typeof brokerSym !== 'string' || !brokerSym) continue;
    const match = matchBrokerSymbol(brokerSym);
    if (!match.asset) {
      unmapped.push(brokerSym);
      continue;
    }
    const assetId = match.asset.id;
    if (mapped[assetId]) {
      // Two broker symbols match the same asset (e.g., "XAUUSD" AND "XAUUSDm" both present)
      // Resolution rules (in order of priority):
      //   1. Exact match wins over fuzzy match
      //   2. PU Prime suffix `.s` (standard) wins over no-suffix
      //      (PU Prime standard symbols like XAUUSD.s are the canonical tradeable contract)
      //   3. Avoid `.cash`, `.crp`, `ft`, futures suffixes
      //   4. Otherwise prefer shorter
      const existing = mapped[assetId];
      const existingMatch = matchBrokerSymbol(existing);

      const newPriority = symbolPriority(brokerSym, match.matchType);
      const existingPriority = symbolPriority(existing, existingMatch.matchType);
      const preferNew = newPriority > existingPriority;

      if (preferNew) {
        conflicts.push({ assetId, kept: brokerSym, dropped: existing });
        mapped[assetId] = brokerSym;
        delete reverseMap[existing];
        reverseMap[brokerSym] = assetId;
      } else {
        conflicts.push({ assetId, kept: existing, dropped: brokerSym });
      }
    } else {
      mapped[assetId] = brokerSym;
      reverseMap[brokerSym] = assetId;
    }
  }

  // Persist
  // Trim unmapped to a reasonable preview size to avoid huge Redis payloads.
  // Full unmapped list returned in API response, only preview persisted.
  const unmappedPreview = unmapped.slice(0, 200);
  const meta = {
    syncedAt: Date.now(),
    brokerSymbolCount: brokerSymbols.length,
    mappedCount: Object.keys(mapped).length,
    unmappedCount: unmapped.length,
    unmapped: unmappedPreview,
    unmappedTrimmed: unmapped.length > 200,
    conflicts,
  };
  try {
    await r.set(symMapKey(userId), JSON.stringify(mapped));
    await r.set(symMapMetaKey(userId), JSON.stringify(meta));
  } catch (e) {
    return { ok: false, error: 'Persist failed: ' + e.message };
  }

  // Invalidate in-memory cache so next loadMap fetches fresh data
  clearCache(userId);

  return {
    ok: true,
    mapped,
    unmapped,
    conflicts,
    brokerSymbols,
    syncedAt: meta.syncedAt,
    mappedCount: meta.mappedCount,
    unmappedCount: meta.unmappedCount,
  };
}

// =================================================================
// LOOKUP: assetId → broker symbol
// =================================================================

// In-memory cache to avoid hitting Redis on every call within the same cron tick.
// Keyed by userId. Invalidated when sync runs.
const _memCache = {};

async function loadMap(userId) {
  const key = userId || DEFAULT_USER;
  // Return cached only if it has actual content (don't cache empty as "loaded")
  if (_memCache[key] && Object.keys(_memCache[key]).length > 0) {
    return _memCache[key];
  }
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(symMapKey(userId));
    const map = safeParse(raw) || {};
    // Only cache non-empty maps (otherwise we'd cache emptiness forever)
    if (Object.keys(map).length > 0) {
      _memCache[key] = map;
    }
    return map;
  } catch (_) {
    return null;
  }
}

function clearCache(userId) {
  if (userId) delete _memCache[userId];
  else for (const k of Object.keys(_memCache)) delete _memCache[k];
}

// THE main function used everywhere in V12 code.
// assetId ('gold', 'btc', 'eurusd') → broker symbol string ('XAUUSD.s', 'BTCUSDm', 'EURUSD')
// Returns null if not mapped (caller should handle).
async function resolveSymbol(assetId, userId) {
  if (!assetId) return null;
  const id = String(assetId).toLowerCase();
  // Fast path: validate asset exists
  if (!getAssetById(id)) {
    console.warn(`[symbol-resolver] Unknown asset id: ${id}`);
    return null;
  }
  const map = await loadMap(userId);
  if (!map) return null;
  return map[id] || null;
}

// Reverse: broker symbol → assetId.
// Used when we get a position back from broker and need to know which asset it is.
async function resolveAsset(brokerSymbol, userId) {
  if (!brokerSymbol) return null;
  const map = await loadMap(userId);
  if (!map) return null;
  for (const [assetId, sym] of Object.entries(map)) {
    if (sym === brokerSymbol) return assetId;
  }
  // Fallback: try registry direct match (in case map is stale)
  const fallback = matchBrokerSymbol(brokerSymbol);
  return fallback.asset ? fallback.asset.id : null;
}

// List of asset IDs we successfully mapped for this user.
async function getMappedAssets(userId) {
  const map = await loadMap(userId);
  return map ? Object.keys(map) : [];
}

// Sync metadata: when did we last sync, what's unmapped, etc.
async function getSyncMeta(userId) {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(symMapMetaKey(userId));
    return safeParse(raw);
  } catch (_) {
    return null;
  }
}

// Manually override one entry in the map (used by "Custom" flow in UI).
async function setManualMapping(assetId, brokerSymbol, userId) {
  const id = String(assetId).toLowerCase();
  if (!getAssetById(id)) return { ok: false, error: 'Unknown asset id' };
  const r = getRedis();
  if (!r) return { ok: false, error: 'Redis unavailable' };
  const map = (await loadMap(userId)) || {};
  map[id] = brokerSymbol;
  try {
    await r.set(symMapKey(userId), JSON.stringify(map));
    clearCache(userId);
    return { ok: true, assetId: id, brokerSymbol };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// =================================================================
// HTTP HANDLER (for inspection / forced sync from UI)
// =================================================================

module.exports = async (req, res) => {
  const action = String(req.query.action || 'status');
  const userId = String(req.query.user || DEFAULT_USER);

  if (action === 'sync') {
    const result = await syncBrokerSymbols(userId);
    return res.status(result.ok ? 200 : 500).json(result);
  }

  if (action === 'status') {
    const map = (await loadMap(userId)) || {};
    const meta = await getSyncMeta(userId);
    const allAssets = getAllAssetIds();
    const mapped = Object.keys(map);
    const notMapped = allAssets.filter(a => !mapped.includes(a));
    return res.status(200).json({
      userId,
      mapped,
      mappedCount: mapped.length,
      notMappedAssets: notMapped,
      meta,
      currentMap: map,
    });
  }

  if (action === 'resolve') {
    const assetId = String(req.query.asset || '');
    const sym = await resolveSymbol(assetId, userId);
    return res.status(200).json({ assetId, brokerSymbol: sym });
  }

  if (action === 'set' && req.method === 'POST') {
    const body = await readBody(req);
    const { assetId, brokerSymbol } = body;
    if (!assetId || !brokerSymbol) {
      return res.status(400).json({ error: 'assetId and brokerSymbol required' });
    }
    const result = await setManualMapping(assetId, brokerSymbol, userId);
    return res.status(result.ok ? 200 : 400).json(result);
  }

  return res.status(400).json({ error: 'unknown action', validActions: ['status', 'sync', 'resolve', 'set'] });
};

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? safeParse(req.body) : req.body;
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(safeParse(data) || {}));
    req.on('error', () => resolve({}));
  });
}

module.exports.syncBrokerSymbols  = syncBrokerSymbols;
module.exports.resolveSymbol      = resolveSymbol;
module.exports.resolveAsset       = resolveAsset;
module.exports.getMappedAssets    = getMappedAssets;
module.exports.getSyncMeta        = getSyncMeta;
module.exports.setManualMapping   = setManualMapping;
module.exports.clearCache         = clearCache;
module.exports.fetchBrokerSymbols = fetchBrokerSymbols;
module.exports.DEFAULT_USER       = DEFAULT_USER;