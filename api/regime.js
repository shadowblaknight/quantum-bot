/* eslint-disable */
// V10 — api/regime.js
// 4-state market regime classifier + chaos detector.
//
// Regimes:
//   TRENDING   -- ADX > 22, MA difference > 0.3 * ATR, HTF trend confirms
//   RANGING    -- ADX < 22, BB width < 0.025, price oscillating
//   VOLATILE   -- ATR > 1.5x recent average, BB expanding
//   QUIET      -- ATR < 0.7x recent average, BB compressed (pre-breakout calm)
//
// Chaos detector:
//   1m ATR vs 1h ATR avg ratio. Ratio > 3 = chaos (news, manipulation, flash event).
//   When chaos active, no new trades for 15min, but existing positions still managed.

const { atr, adx, bollingerWidth, getRedis, applyCors, normSym, instCategory, selfBase } = require('./_lib');

const REGIME_TTL = 5 * 60; // cache regime per symbol for 5 minutes

// V10 BUGFIX: regime was calling /api/broker-candles which DOES NOT EXIST anymore
// (consolidated into /api/broker?action=candles). Every call 404'd silently, returning [],
// so every regime came back UNKNOWN with ADX=0 ATR=0. This is why the bot saw no market data.
//
// We now import broker.fetchCandles directly -- no HTTP round-trip, faster and avoids
// concurrent-request pressure on MetaAPI.
const brokerModule = require('./broker');
async function fetchCandles(sym, timeframe, count) {
  try {
    const r = await brokerModule.fetchCandles(sym, timeframe, count || 100);
    return Array.isArray(r.candles) ? r.candles : [];
  } catch (_) { return []; }
}

// Compute regime from candles. Returns { regime, score, indicators }.
function classifyRegime(h1Candles, h4Candles) {
  if (!h1Candles || h1Candles.length < 25) return { regime: 'UNKNOWN', score: 0, indicators: {} };

  const h1Atr14   = atr(h1Candles, 14);
  const h1Atr50   = atr(h1Candles.slice(-65, -15), 14); // baseline ATR 50 candles ago
  const h1Adx14   = adx(h1Candles, 14);
  const h1BBwidth = bollingerWidth(h1Candles, 20, 2);

  // EMA-9 vs EMA-21 difference
  const closes = h1Candles.map(c => c.close);
  const ema = (arr, n) => {
    if (arr.length < n) return null;
    let s = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const k = 2 / (n + 1);
    for (let i = n; i < arr.length; i++) s = arr[i] * k + s * (1 - k);
    return s;
  };
  const ema9  = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const maDiff = (ema9 != null && ema21 != null && h1Atr14)
    ? Math.abs(ema9 - ema21) / h1Atr14
    : 0;

  // Higher-TF trend confirmation: H4 EMA9 vs EMA21 direction
  let h4TrendDir = 0;
  if (h4Candles && h4Candles.length >= 25) {
    const h4Closes = h4Candles.map(c => c.close);
    const h4Ema9 = ema(h4Closes, 9);
    const h4Ema21 = ema(h4Closes, 21);
    if (h4Ema9 != null && h4Ema21 != null) {
      h4TrendDir = h4Ema9 > h4Ema21 ? 1 : (h4Ema9 < h4Ema21 ? -1 : 0);
    }
  }

  // Volatility ratio (current vs baseline)
  const volRatio = (h1Atr14 && h1Atr50) ? h1Atr14 / h1Atr50 : 1;

  // V10: Tick-volume regime signal -- recent volume vs 50-period average.
  // Expansion = participation (confirms moves). Contraction = pre-breakout calm or fakeouts.
  let tickVolRatio = 1;
  let volExpanding = false;
  let volContracting = false;
  if (h1Candles && h1Candles.length >= 50) {
    const recent10 = h1Candles.slice(-10).map(c => c.tickVolume || c.volume || 0).filter(v => v > 0);
    const baseline40 = h1Candles.slice(-50, -10).map(c => c.tickVolume || c.volume || 0).filter(v => v > 0);
    if (recent10.length >= 5 && baseline40.length >= 20) {
      const recentAvg = recent10.reduce((s, v) => s + v, 0) / recent10.length;
      const baseAvg   = baseline40.reduce((s, v) => s + v, 0) / baseline40.length;
      if (baseAvg > 0) {
        tickVolRatio = recentAvg / baseAvg;
        volExpanding   = tickVolRatio >= 1.4;
        volContracting = tickVolRatio <= 0.65;
      }
    }
  }

  const indicators = {
    h1Atr14, h1Atr50, h1Adx14, h1BBwidth, ema9, ema21, ema50, maDiff,
    h4TrendDir, volRatio,
    tickVolRatio, volExpanding, volContracting,
  };

  // Decision tree
  let regime = 'UNKNOWN';
  let score = 50;

  if (volRatio > 1.5 && h1BBwidth > 0.018) {
    regime = 'VOLATILE';
    score = 60 + Math.round((volRatio - 1.5) * 20);
    if (volExpanding) score += 5; // confirmed by volume
  } else if (h1Adx14 != null && h1Adx14 > 22 && maDiff > 0.3 && h4TrendDir !== 0) {
    regime = 'TRENDING';
    score = 60 + Math.round(Math.min(40, (h1Adx14 - 22) + maDiff * 30));
    // V10: Trend WITHOUT volume expansion is suspect -- could be drifting/exhausted
    if (volExpanding) score += 8;
    else if (volContracting) score -= 12;
  } else if (h1Adx14 != null && h1Adx14 < 22 && (h1BBwidth || 1) < 0.025 && maDiff < 0.4) {
    regime = 'RANGING';
    score = 50 + Math.round((22 - h1Adx14));
  } else if (volRatio < 0.7 && (h1BBwidth || 1) < 0.012) {
    regime = 'QUIET';
    score = 50;
    // V10: Quiet + volume contraction = pre-breakout coil. Worth flagging.
    if (volContracting) score += 5;
  } else {
    regime = 'MIXED';
    score = 40;
  }

  return { regime, score: Math.max(0, Math.min(100, score)), indicators };
}

// Chaos detector — call separately, uses M1 vs H1 ATR
async function detectChaos(sym) {
  const m1 = await fetchCandles(sym, '1m', 60);
  const h1 = await fetchCandles(sym, '1h', 30);
  if (m1.length < 30 || h1.length < 14) return { chaos: false, ratio: 0 };

  const m1Atr10 = atr(m1, 10);
  const h1Atr14 = atr(h1, 14);
  if (!m1Atr10 || !h1Atr14) return { chaos: false, ratio: 0 };

  // Convert h1Atr to per-minute equivalent (divide by ~60) before comparing
  const h1AtrPerMin = h1Atr14 / 60;
  const ratio = m1Atr10 / Math.max(1e-9, h1AtrPerMin);

  return {
    chaos: ratio > 3.0,
    ratio: Math.round(ratio * 10) / 10,
    m1Atr10, h1Atr14, h1AtrPerMin,
  };
}

// Full regime read for a symbol, with caching
async function getRegimeFor(sym) {
  const r = getRedis();
  const cacheKey = 'v10:regime:' + normSym(sym);
  if (r) {
    const cached = await r.get(cacheKey).catch(() => null);
    if (cached) {
      try { return typeof cached === 'string' ? JSON.parse(cached) : cached; } catch (_) {}
    }
  }
  const [h1, h4] = await Promise.all([
    fetchCandles(sym, '1h', 100),
    fetchCandles(sym, '4h', 50),
  ]);
  const result = classifyRegime(h1, h4);
  result.sym = normSym(sym);
  result.ts = Date.now();
  if (r) await r.set(cacheKey, JSON.stringify(result), { ex: REGIME_TTL }).catch(() => {});
  return result;
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sym = String(req.query.symbol || '').toUpperCase();
  if (!sym) return res.status(400).json({ error: 'symbol required' });

  const action = String(req.query.action || 'regime');

  if (action === 'chaos') {
    const c = await detectChaos(sym);
    return res.status(200).json(c);
  }

  // Default: full regime + chaos
  const [reg, chaos] = await Promise.all([
    getRegimeFor(sym),
    detectChaos(sym),
  ]);
  return res.status(200).json({ ...reg, chaos });
};

module.exports.classifyRegime = classifyRegime;
module.exports.detectChaos    = detectChaos;
module.exports.getRegimeFor   = getRegimeFor;