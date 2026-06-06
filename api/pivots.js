/* eslint-disable */
// api/pivots.js  (Pilot Dashboard v1.1 — adds batch/dashboard mode)
//
// v1.1 CHANGE:
//   v1.0 required ?asset=X and returned a SINGLE asset's pivots with full
//   classic/fib/camarilla detail. The frontend PivotsPanel polls /api/pivots
//   with NO params expecting a { byAsset: {...} } shape covering the whole
//   watchlist. v1.0 responded 400 → dashboard panel always showed "endpoint
//   not deployed" + console errors.
//
//   v1.1 supports BOTH modes:
//     - GET /api/pivots                  → batch (dashboard): classic-style
//                                          pivots for default-7 watchlist
//     - GET /api/pivots?assets=a,b,c     → batch: pivots for given asset list
//     - GET /api/pivots?asset=X          → single asset, full detail
//                                          (classic + fib + camarilla, UNCHANGED)
//
//   Batch shape (App.jsx-compatible):
//     {
//       ok: true,
//       byAsset: {
//         gold:   { pivot, r1, r2, r3, s1, s2, s3, prevHigh, prevLow, prevClose },
//         eurusd: { ... },
//         ...
//       },
//       updatedAt: 1234567890
//     }
// ----------------------------------------------------------------------------

const { fetchCandles } = require('./broker');

const DEFAULT_WATCHLIST = ['gold', 'eurusd', 'gbpusd', 'usdjpy', 'nas100', 'us500', 'btc'];

// ─── Pivot math (unchanged from v1.0) ───────────────────────────────

function classicPivots(H, L, C) {
  if (!isFinite(H) || !isFinite(L) || !isFinite(C)) return null;
  const P  = (H + L + C) / 3;
  const range = H - L;
  return {
    P, R1: 2 * P - L, S1: 2 * P - H,
    R2: P + range, S2: P - range,
    R3: H + 2 * (P - L), S3: L - 2 * (H - P),
  };
}

function fibPivots(H, L, C) {
  if (!isFinite(H) || !isFinite(L) || !isFinite(C)) return null;
  const P = (H + L + C) / 3;
  const range = H - L;
  return {
    P,
    R1: P + 0.382 * range, R2: P + 0.618 * range, R3: P + 1.000 * range,
    S1: P - 0.382 * range, S2: P - 0.618 * range, S3: P - 1.000 * range,
  };
}

function camarillaPivots(H, L, C) {
  if (!isFinite(H) || !isFinite(L) || !isFinite(C)) return null;
  const range = H - L;
  return {
    P: C,
    R1: C + range * 1.1 / 12, R2: C + range * 1.1 / 6,
    R3: C + range * 1.1 / 4,  R4: C + range * 1.1 / 2,
    S1: C - range * 1.1 / 12, S2: C - range * 1.1 / 6,
    S3: C - range * 1.1 / 4,  S4: C - range * 1.1 / 2,
  };
}

async function getPrevDayHLC(assetId) {
  try {
    const result = await fetchCandles(assetId, '1d', 5);
    if (!result || !result.candles || result.candles.length < 2) return null;
    const prev = result.candles[result.candles.length - 2];
    if (!prev || !isFinite(prev.high) || !isFinite(prev.low) || !isFinite(prev.close)) return null;
    return { high: prev.high, low: prev.low, close: prev.close, time: prev.time };
  } catch (e) {
    console.error(`[pivots] getPrevDayHLC failed for ${assetId}:`, e.message);
    return null;
  }
}

// Single-asset full-detail (v1.0 behavior, preserved)
async function computeDailyPivots(assetId) {
  const hlc = await getPrevDayHLC(assetId);
  if (!hlc) return null;
  return {
    assetId,
    prevHigh: hlc.high, prevLow: hlc.low, prevClose: hlc.close, prevTime: hlc.time,
    classic: classicPivots(hlc.high, hlc.low, hlc.close),
    fib: fibPivots(hlc.high, hlc.low, hlc.close),
    camarilla: camarillaPivots(hlc.high, hlc.low, hlc.close),
  };
}

// v1.1: compact App.jsx-friendly shape (classic only, lowercase field names)
async function computeCompactPivots(assetId) {
  const hlc = await getPrevDayHLC(assetId);
  if (!hlc) return null;
  const c = classicPivots(hlc.high, hlc.low, hlc.close);
  if (!c) return null;
  return {
    pivot: c.P,
    r1: c.R1, r2: c.R2, r3: c.R3,
    s1: c.S1, s2: c.S2, s3: c.S3,
    prevHigh: hlc.high,
    prevLow: hlc.low,
    prevClose: hlc.close,
  };
}

function nearestPivotInDirection(currentPrice, pivots, direction) {
  if (!pivots) return null;
  const levels = Object.entries(pivots)
    .filter(([_, v]) => isFinite(v))
    .map(([name, price]) => ({ name, price }));
  const isLong = direction === 'LONG';
  const candidates = levels.filter((l) => isLong ? l.price > currentPrice : l.price < currentPrice);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => isLong ? a.price - b.price : b.price - a.price);
  return candidates[0];
}

// ─── HTTP handler (v1.1 dual-mode) ──────────────────────────────────

module.exports = async (req, res) => {
  // Single-asset mode (v1.0 behavior — UNCHANGED)
  const singleAsset = req.query && req.query.asset;
  if (singleAsset) {
    try {
      const pivots = await computeDailyPivots(singleAsset);
      if (!pivots) return res.status(404).json({ ok: false, error: 'no candle data available' });
      return res.status(200).json({ ok: true, pivots });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Batch mode (v1.1 — for the dashboard PivotsPanel)
  const assetsParam = req.query && req.query.assets;
  const assetList = assetsParam
    ? assetsParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_WATCHLIST;

  try {
    // Parallel fetch: ~1-2s total for 7 assets instead of 5-10s sequential
    const results = await Promise.all(
      assetList.map(async (id) => {
        const p = await computeCompactPivots(id);
        return [id, p];
      })
    );

    const byAsset = {};
    for (const [id, p] of results) {
      if (p) byAsset[id] = p;   // skip assets that failed to fetch (defensive)
    }

    return res.status(200).json({
      ok: true,
      byAsset,
      assets: assetList,
      gotCount: Object.keys(byAsset).length,
      requestedCount: assetList.length,
      updatedAt: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.classicPivots = classicPivots;
module.exports.fibPivots = fibPivots;
module.exports.camarillaPivots = camarillaPivots;
module.exports.getPrevDayHLC = getPrevDayHLC;
module.exports.computeDailyPivots = computeDailyPivots;
module.exports.computeCompactPivots = computeCompactPivots;
module.exports.nearestPivotInDirection = nearestPivotInDirection;