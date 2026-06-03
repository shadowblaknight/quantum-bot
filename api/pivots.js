/* eslint-disable */
// api/pivots.js  (Pilot Dashboard v1)
const { fetchCandles } = require('./broker');

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
    console.error('[pivots] getPrevDayHLC failed:', e.message);
    return null;
  }
}

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

module.exports = async (req, res) => {
  const assetId = (req.query && req.query.asset) || (req.body && req.body.asset);
  if (!assetId) return res.status(400).json({ ok: false, error: 'missing asset param' });
  try {
    const pivots = await computeDailyPivots(assetId);
    if (!pivots) return res.status(404).json({ ok: false, error: 'no candle data available' });
    return res.status(200).json({ ok: true, pivots });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.classicPivots = classicPivots;
module.exports.fibPivots = fibPivots;
module.exports.camarillaPivots = camarillaPivots;
module.exports.getPrevDayHLC = getPrevDayHLC;
module.exports.computeDailyPivots = computeDailyPivots;
module.exports.nearestPivotInDirection = nearestPivotInDirection;