/* eslint-disable */
// V12 — api/_lib.js
//
// Shared utilities used across V12 modules. No business logic — just helpers.
//
// Notable absences vs V11 _lib:
//   - No TACTIC_FAMILY_MAP (V12 uses tactics/, families re-derived from active tactics)
//   - No R_DISTANCE_TABLE (V12 uses asset-registry's typicalH1ATR + sizing-engine)
//   - No buildLadder / getTradingMode (V12 ladder logic moves to tactics/coherence)
//   - No betaMean/betaCI scoring helpers (V12 has no scoring layer)
// ----------------------------------------------------------------------------

const { Redis } = require('@upstash/redis');

// =================================================================
// REDIS
// =================================================================

function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try { return new Redis({ url, token }); } catch (_) { return null; }
}

// =================================================================
// PARSING / SAFETY
// =================================================================

function safeParse(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// =================================================================
// CORS (for browser-facing endpoints)
// =================================================================

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

// =================================================================
// SELF URL (for inter-API fetches)
// =================================================================

function selfBase() {
  const explicit = process.env.QB_PUBLIC_URL || process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}

// =================================================================
// SESSION DETECTION
// =================================================================

// Trading session for a given UTC hour
function sessionForHour(utcH) {
  // Asian: 00:00-07:00 UTC
  // London: 07:00-13:00 UTC
  // Overlap: 13:00-16:00 UTC (London/NY overlap)
  // NY: 13:00-21:00 UTC (with overlap 13-16)
  // Off: 21:00-00:00 UTC
  if (utcH >= 13 && utcH < 16) return 'OVERLAP';
  if (utcH >= 13 && utcH < 21) return 'NEW_YORK';
  if (utcH >= 7  && utcH < 13) return 'LONDON';
  if (utcH >= 0  && utcH < 7)  return 'ASIAN';
  return 'OFF';
}

function getCurrentSession() {
  return sessionForHour(new Date().getUTCHours());
}

// =================================================================
// INDICATORS (used by tactics)
// =================================================================

// ATR — Average True Range
function atr(candles, period) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  // Wilder smoothing
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let result = sum / period;
  for (let i = period; i < trs.length; i++) {
    result = (result * (period - 1) + trs[i]) / period;
  }
  return result;
}

// ADX — Average Directional Index (trend strength)
function adx(candles, period) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return null;
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    pdm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    ndm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const trVal = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    tr.push(trVal);
  }
  // Smoothed sums (Wilder)
  let sumTR = 0, sumPDM = 0, sumNDM = 0;
  for (let i = 0; i < period; i++) { sumTR += tr[i]; sumPDM += pdm[i]; sumNDM += ndm[i]; }
  const dxs = [];
  for (let i = period; i < tr.length; i++) {
    sumTR  = sumTR  - sumTR / period  + tr[i];
    sumPDM = sumPDM - sumPDM / period + pdm[i];
    sumNDM = sumNDM - sumNDM / period + ndm[i];
    const pdi = sumTR > 0 ? (sumPDM / sumTR) * 100 : 0;
    const ndi = sumTR > 0 ? (sumNDM / sumTR) * 100 : 0;
    const denom = pdi + ndi;
    dxs.push(denom > 0 ? Math.abs(pdi - ndi) / denom * 100 : 0);
  }
  if (dxs.length < period) return null;
  let adxVal = 0;
  for (let i = 0; i < period; i++) adxVal += dxs[i];
  adxVal /= period;
  for (let i = period; i < dxs.length; i++) {
    adxVal = (adxVal * (period - 1) + dxs[i]) / period;
  }
  return adxVal;
}

// Bollinger Band width — relative volatility expansion measure
function bollingerWidth(candles, period, mult) {
  if (!Array.isArray(candles) || candles.length < period) return null;
  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((s, x) => s + (x - mean) ** 2, 0) / period;
  const stdev = Math.sqrt(variance);
  const upper = mean + mult * stdev;
  const lower = mean - mult * stdev;
  return mean > 0 ? (upper - lower) / mean : 0;
}

// EMA — Exponential Moving Average
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

// =================================================================
// PRICE FORMATTING
// =================================================================

// Decimal places appropriate for a price level
function priceDp(p) {
  const abs = Math.abs(p);
  if (abs >= 10000) return 2;
  if (abs >= 100) return 2;
  if (abs >= 10) return 3;
  if (abs >= 1) return 4;
  return 5;
}

// Format a price with appropriate dp
function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '--';
  return p.toFixed(priceDp(p));
}

// V12.4.1: Round a price to the broker's pip increment.
// MT5 rejects orders with prices beyond the symbol's tick size as
// INVALID_PRICE (numericCode 10015). For gold (pipSize=0.01), every price
// must end in 2 decimals; for NAS100 (pipSize=1.0), integers only; etc.
//
// mode:
//   'nearest' (default) — bankers rounding to the nearest tick
//   'down' — floor (further from infinity, closer to zero)
//   'up'   — ceil  (further from zero, away from infinity)
//
// Typical usage by the order layer:
//   entry → 'nearest'
//   LONG  SL → 'down' (wider, further from entry), TP → 'down' (closer to entry, conservative)
//   SHORT SL → 'up'   (wider, further from entry), TP → 'up'   (closer to entry, conservative)
function roundToPipSize(price, pipSize, mode = 'nearest') {
  if (price == null || !isFinite(price)) return price;
  if (!pipSize || pipSize <= 0) return price;
  const factor = 1 / pipSize;
  if (mode === 'down') return Math.floor(price * factor) / factor;
  if (mode === 'up')   return Math.ceil(price  * factor) / factor;
  return Math.round(price * factor) / factor;
}

// =================================================================
// EXPORTS
// =================================================================

module.exports = {
  // redis
  getRedis,
  // parsing
  safeParse,
  // http
  applyCors,
  selfBase,
  // session
  sessionForHour,
  getCurrentSession,
  // indicators
  atr,
  adx,
  bollingerWidth,
  ema,
  // formatting
  priceDp,
  fmtPrice,
  roundToPipSize,
};