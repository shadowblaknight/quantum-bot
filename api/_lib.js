/* eslint-disable */
// V10 — shared utilities used by all API files.
// Centralizes Redis, MetaAPI base URL, symbol normalization, family classification,
// math helpers, and Telegram. No logic, just plumbing.

const { Redis } = require('@upstash/redis');

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  _redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  return _redis;
}

// MetaAPI region — defaults to london, can be overridden per call
const META_REGIONS = ['london', 'new-york', 'singapore'];
function metaBase(region) {
  const r = region || process.env.META_REGION || 'london';
  return `https://mt-client-api-v1.${r}.agiliumtrade.ai`;
}
function metaHeaders() {
  return { 'auth-token': process.env.METAAPI_TOKEN, 'Content-Type': 'application/json' };
}
function metaAccountId() { return process.env.METAAPI_ACCOUNT_ID; }

// Symbol normalization — strips broker suffixes (.s, .pro, .raw, ...)
function normSym(sym) {
  if (!sym) return '';
  return String(sym).toUpperCase().replace(/\.(S|PRO|RAW|ECN|M|R|I|C|X|MICRO)$/i, '').trim();
}

// Symbol category — used everywhere
function instCategory(sym) {
  const s = normSym(sym);
  if (/XAU|GOLD/.test(s)) return 'GOLD';
  if (/XAG|SILVER/.test(s)) return 'METAL';
  if (/BTC|ETH|XRP|LTC|SOL|ADA|DOGE|CRYPTO|COIN/.test(s)) return 'CRYPTO';
  if (/NAS|SPX|US30|GER|UK100|JP225|INDEX/.test(s)) return 'INDEX';
  if (/USOIL|UKOIL|BRENT|WTI|OIL/.test(s)) return 'COMMODITY';
  return 'FOREX';
}

// V10 — Tactic Family classification.
// Maps any V9 raw tactic abbreviation into one of 6 canonical families.
// This is the heart of the family consolidation. Old tactics are not deleted —
// their stats roll up into the family they belong to.
const TACTIC_FAMILY_MAP = {
  // TREND family — momentum aligned with higher-TF direction
  'TREND_H4':              'TREND',
  'TREND':                 'TREND',
  'TREND_BREAKOUT':        'TREND',     // also fits BREAKOUT but TREND aspect dominates
  'TREND_FOLLOW':          'TREND',
  'TREND_PULLBACK':        'TREND',
  'EMA_TREND':             'TREND',
  'MA_TREND':              'TREND',
  'MOM_SESSION':           'TREND',     // session-momentum is essentially trend continuation
  'MOM_S':                 'TREND',
  'MOMENTUM':              'TREND',
  'MOMEN':                 'TREND',
  'MOM':                   'TREND',
  'MOM_TREND':             'TREND',

  // REVERSION family — fades extension back to mean
  'MR_ROUND':              'REVERSION',
  'MR_RANGE':              'REVERSION',
  'MR_RA':                 'REVERSION',
  'MR_RO':                 'REVERSION',
  'MEAN_REV':              'REVERSION',
  'MEAN_REVERSION':        'REVERSION',
  'MR':                    'REVERSION',
  'PA_REJECTION':          'REVERSION', // rejection at S/R is a reversion bet
  'PA_REJ':                'REVERSION',
  'PA_RE':                 'REVERSION',
  'PA':                    'REVERSION',
  'OVERSOLD_BOUNCE':       'REVERSION',
  'OVERBOUGHT_FADE':       'REVERSION',

  // STRUCTURE family — institutional / smart-money concepts
  'ICT_KILLZONE':          'STRUCTURE',
  'ICT_SWEEP':             'STRUCTURE',
  'ICT_OB':                'STRUCTURE',
  'ICT_FVG':               'STRUCTURE',
  'ICT_BOS':               'STRUCTURE',
  'ICT_CHOCH':             'STRUCTURE',
  'ICT':                   'STRUCTURE',
  'SMC':                   'STRUCTURE',
  'LIQUIDITY':             'STRUCTURE',
  'ORDER_BLOCK':           'STRUCTURE',
  'KILLZONE':              'STRUCTURE',
  'SWEEP':                 'STRUCTURE',

  // BREAKOUT family — pure breakouts of consolidation
  'BREAKOUT':              'BREAKOUT',
  'BO':                    'BREAKOUT',
  'RANGE_BREAK':           'BREAKOUT',
  'OPENING_BREAK':         'BREAKOUT',
  'SESSION_BREAK':         'BREAKOUT',

  // RANGE family — works inside established ranges
  'RANGE':                 'RANGE',
  'RANGE_FADE':            'RANGE',
  'CONSOLIDATION':         'RANGE',
  'BB_BOUNCE':             'RANGE',

  // NEWS family — post-event reactions
  'NEWS':                  'NEWS',
  'NEWS_FADE':             'NEWS',
  'NEWS_MOMENTUM':         'NEWS',
};

// Classify a raw tactic name into a family.
// Compound tactics like "TREND_H4+MOM_SESSION" → split, classify each, return the
// most-frequent family (or first family if tied).
function tacticFamily(rawTactic) {
  if (!rawTactic) return 'UNKNOWN';
  const parts = String(rawTactic).split(/[+,&]/).map(p => p.trim().toUpperCase()).filter(Boolean);
  if (!parts.length) return 'UNKNOWN';
  const counts = {};
  for (const p of parts) {
    let fam = TACTIC_FAMILY_MAP[p];
    if (!fam) {
      // Prefix match for truncated labels (e.g. "TREND_" matches "TREND_H4")
      for (const k of Object.keys(TACTIC_FAMILY_MAP)) {
        if (k.startsWith(p) || p.startsWith(k)) { fam = TACTIC_FAMILY_MAP[k]; break; }
      }
    }
    if (fam) counts[fam] = (counts[fam] || 0) + 1;
  }
  if (!Object.keys(counts).length) return 'UNKNOWN';
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Family metadata (for UI + AI prompt)
const FAMILY_META = {
  TREND:     { name: 'Trend Following',  icon: '📈', color: '#3b82f6', desc: 'Momentum aligned with higher-TF direction. Best in trending regimes.' },
  REVERSION: { name: 'Mean Reversion',   icon: '🔄', color: '#10b981', desc: 'Fades price extensions back to the mean. Best in ranging regimes.' },
  STRUCTURE: { name: 'Smart Money',      icon: '⚡', color: '#f59e0b', desc: 'Institutional zones: order blocks, liquidity sweeps, kill zones.' },
  BREAKOUT:  { name: 'Breakout',         icon: '💥', color: '#ef4444', desc: 'Catches breaks of consolidation. Best at session opens.' },
  RANGE:     { name: 'Range Trading',    icon: '↔️', color: '#84cc16', desc: 'Fades extremes within established ranges. Avoid in trends.' },
  NEWS:      { name: 'News Reaction',    icon: '📰', color: '#a855f7', desc: 'Post-event momentum or fade. High risk, fast moves.' },
  UNKNOWN:   { name: 'Unclassified',     icon: '❓', color: '#94a3b8', desc: 'Could not classify into a known family.' },
};

// Bayesian Beta-distribution helpers.
// Each strategy slot gets Beta(alpha, beta) where alpha=wins+1, beta=losses+1
// (Laplace prior so untested strategies start at WR = 50% with very wide CI).
function betaMean(wins, losses) {
  const a = (wins || 0) + 1;
  const b = (losses || 0) + 1;
  return a / (a + b);
}
function betaVariance(wins, losses) {
  const a = (wins || 0) + 1;
  const b = (losses || 0) + 1;
  const ab = a + b;
  return (a * b) / (ab * ab * (ab + 1));
}
// 95% credible interval (approximate via normal approximation, valid for n >= 10)
function betaCI(wins, losses) {
  const mean = betaMean(wins, losses);
  const variance = betaVariance(wins, losses);
  const std = Math.sqrt(variance);
  return [Math.max(0, mean - 1.96 * std), Math.min(1, mean + 1.96 * std)];
}
// Thompson sample — draw a random win-rate from the distribution.
// Used for explore/exploit in AI decisions.
function betaSample(wins, losses) {
  const a = (wins || 0) + 1;
  const b = (losses || 0) + 1;
  // Sample from Gamma using Marsaglia-Tsang (small-shape) — for our typical alpha/beta values,
  // a simpler approximation via two random numbers is fine
  const x = sampleGamma(a);
  const y = sampleGamma(b);
  return x / (x + y);
}
function sampleGamma(shape) {
  // Marsaglia-Tsang for shape >= 1; reroll for shape < 1
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = randomNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function randomNormal() {
  // Box-Muller
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// JSON-safe parse
function safeParse(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ATR / ADX / BB calculators (vanilla JS, no dependencies)
function atr(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}
function adx(candles, period) {
  if (!candles || candles.length < 2 * period) return null;
  let plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(candles[i].high - candles[i].low,
                        Math.abs(candles[i].high - candles[i - 1].close),
                        Math.abs(candles[i].low - candles[i - 1].close));
    trs.push(tr);
  }
  const ema = (arr, n) => {
    if (arr.length < n) return null;
    let s = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const k = 2 / (n + 1);
    for (let i = n; i < arr.length; i++) s = arr[i] * k + s * (1 - k);
    return s;
  };
  const tr_ema = ema(trs, period);
  const pdm_ema = ema(plusDM, period);
  const mdm_ema = ema(minusDM, period);
  if (!tr_ema || tr_ema === 0) return null;
  const pdi = 100 * (pdm_ema / tr_ema);
  const mdi = 100 * (mdm_ema / tr_ema);
  const dx = 100 * Math.abs(pdi - mdi) / Math.max(1e-9, pdi + mdi);
  return dx; // simplified (not full ADX-EMA-of-DX, but good enough for regime)
}
function bollingerWidth(candles, period, mult) {
  if (!candles || candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / period;
  const variance = closes.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return (mult * 2 * std) / mean; // normalized width as fraction of price
}

// Simple price decimal places
function priceDp(p) {
  if (!p) return 5;
  if (p > 1000) return 2;       // gold, indices
  if (p > 100)  return 3;       // JPY pairs
  return 5;                      // most forex
}

// Telegram helper — silent if not configured
async function tg(message) {
  const token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (_) { return false; }
}

// CORS / preflight helper for all V10 endpoints
function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}

// Self-base URL — used when one endpoint calls another
function selfBase() {
  return process.env.QB_PUBLIC_URL || 'https://quantum-bot-mocha.vercel.app';
}

// =================================================================
// V11 — Trading mode definitions (SCALP / DAY / SWING)
// =================================================================
// Each mode defines:
//   - 4 TP levels as multiples of R (where 1R = SL distance)
//   - Volume % to close at each TP
//   - SL move behavior: which TP triggers a move, and where to move
//
// AI returns mode in its decision JSON. Default = DAY.

const TRADING_MODES = {
  SCALP: {
    name: 'SCALP',
    description: 'Quick reversal, tight risk, fast TP',
    tps:        [1.0, 1.5, 2.0, 2.5],   // R multiples
    closes:     [0.40, 0.30, 0.20, 0.10], // close fraction at each TP
    slMoves: {
      atTp1: 'BE',          // move SL to breakeven at TP1
      atTp2: 'TP1',         // move SL to TP1 price at TP2
      atTp3: 'TP2',
      atTp4: null,
    },
    trailAfterTp3: false,
    staleTimeoutHours: 1,
  },
  DAY: {
    name: 'DAY',
    description: 'Intraday swing, hours hold, default mode',
    tps:        [1.0, 2.0, 3.0, 4.0],
    closes:     [0.25, 0.25, 0.25, 0.25],
    slMoves: {
      atTp1: null,          // no SL move at TP1, give runner room
      atTp2: 'BE',          // BE at TP2
      atTp3: 'TP1',         // SL to TP1 price at TP3
      atTp4: null,
    },
    trailAfterTp3: true,    // 1R trail after TP3
    staleTimeoutHours: 4,
  },
  SWING: {
    name: 'SWING',
    description: 'Multi-day, 4H/D1 alignment, patient',
    tps:        [1.5, 3.0, 5.0, 8.0],
    closes:     [0.20, 0.25, 0.25, 0.30],
    slMoves: {
      atTp1: null,
      atTp2: 'BE',
      atTp3: 'TP1',
      atTp4: 'TP2',
    },
    trailAfterTp3: true,
    staleTimeoutHours: 12,
  },
};

// Per-instrument 1R baseline distance per mode.
// 1R = the natural SL distance for that instrument at that mode.
// Stored as the pip count (in instrument-native pips).
// AI can override by passing slPips directly; if not, this lookup is the default.
const R_DISTANCE_TABLE = {
  // Forex majors (non-JPY)
  'EURUSD':  { SCALP: 12, DAY: 25, SWING: 50 },
  'GBPUSD':  { SCALP: 14, DAY: 28, SWING: 55 },
  'AUDUSD':  { SCALP: 12, DAY: 25, SWING: 50 },
  'NZDUSD':  { SCALP: 13, DAY: 26, SWING: 52 },
  'USDCAD':  { SCALP: 12, DAY: 25, SWING: 50 },
  'USDCHF':  { SCALP: 12, DAY: 25, SWING: 50 },
  // JPY pairs (slightly wider, JPY pip = 0.01)
  'USDJPY':  { SCALP: 15, DAY: 30, SWING: 60 },
  'EURJPY':  { SCALP: 18, DAY: 35, SWING: 70 },
  'GBPJPY':  { SCALP: 22, DAY: 45, SWING: 90 },
  'AUDJPY':  { SCALP: 16, DAY: 32, SWING: 65 },
  // Cross majors
  'EURGBP':  { SCALP: 10, DAY: 20, SWING: 40 },
  'EURAUD':  { SCALP: 18, DAY: 36, SWING: 72 },
  'GBPAUD':  { SCALP: 22, DAY: 44, SWING: 88 },
  // Metals (gold pip = 0.01, $1 = 100 pips)
  'XAUUSD':  { SCALP: 150, DAY: 400, SWING: 1000 },  // $1.50 / $4 / $10
  'XAGUSD':  { SCALP: 30,  DAY: 80,  SWING: 200 },   // $0.30 / $0.80 / $2
  // Crypto (BTC pip = $1)
  'BTCUSD':  { SCALP: 300, DAY: 800, SWING: 2000 },
  'ETHUSD':  { SCALP: 20,  DAY: 50,  SWING: 150 },
  // Indices (1 point = 1 pip in our system)
  'NAS100':  { SCALP: 25, DAY: 60,  SWING: 150 },
  'SPX500':  { SCALP: 8,  DAY: 20,  SWING: 50 },
  'US30':    { SCALP: 50, DAY: 120, SWING: 300 },
  'GER40':   { SCALP: 25, DAY: 60,  SWING: 150 },
  'UK100':   { SCALP: 15, DAY: 35,  SWING: 90 },
  'JP225':   { SCALP: 80, DAY: 200, SWING: 500 },
};

// Get default 1R pip distance for symbol + mode. Falls back to category default.
function getRDistance(sym, mode) {
  const s = normSym(sym);
  const m = (mode || 'DAY').toUpperCase();
  if (R_DISTANCE_TABLE[s] && R_DISTANCE_TABLE[s][m] != null) {
    return R_DISTANCE_TABLE[s][m];
  }
  // Category fallback
  const cat = instCategory(s);
  const defaults = {
    FOREX:     { SCALP: 12, DAY: 25, SWING: 50 },
    GOLD:      { SCALP: 150, DAY: 400, SWING: 1000 },
    METAL:     { SCALP: 30, DAY: 80, SWING: 200 },
    CRYPTO:    { SCALP: 300, DAY: 800, SWING: 2000 },
    INDEX:     { SCALP: 25, DAY: 60, SWING: 150 },
    COMMODITY: { SCALP: 15, DAY: 35, SWING: 90 },
  };
  return (defaults[cat] && defaults[cat][m]) || 25;
}

// Get the trading mode definition. Returns DAY if invalid.
function getTradingMode(modeName) {
  const m = String(modeName || 'DAY').toUpperCase();
  return TRADING_MODES[m] || TRADING_MODES.DAY;
}

// Get pip multiplier for an instrument (the price-units-per-pip).
// Used to convert pip distances into price distances.
function pipMult(sym) {
  const s = normSym(sym);
  const cat = instCategory(s);
  if (cat === 'GOLD' || cat === 'METAL') return 0.01;
  if (cat === 'CRYPTO') return 1.0;
  if (cat === 'INDEX') return 1.0;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

// Build a TP ladder given fill price, SL price, direction, and mode.
// Returns { tp1, tp2, tp3, tp4, closes, slMoves, trailAfterTp3, staleTimeoutHours, mode }
function buildLadder({ fillPrice, slPrice, direction, sym, mode }) {
  const m = getTradingMode(mode);
  const sign = direction === 'LONG' || direction === 'BUY' ? 1 : -1;
  const slDist = Math.abs(fillPrice - slPrice);
  if (slDist <= 0) return null;
  const dp = priceDp(fillPrice);
  return {
    mode:      m.name,
    fillPrice,
    slPrice,
    slDistance: slDist,
    tp1: parseFloat((fillPrice + sign * slDist * m.tps[0]).toFixed(dp)),
    tp2: parseFloat((fillPrice + sign * slDist * m.tps[1]).toFixed(dp)),
    tp3: parseFloat((fillPrice + sign * slDist * m.tps[2]).toFixed(dp)),
    tp4: parseFloat((fillPrice + sign * slDist * m.tps[3]).toFixed(dp)),
    closes:           m.closes,
    slMoves:          m.slMoves,
    trailAfterTp3:    m.trailAfterTp3,
    staleTimeoutHours: m.staleTimeoutHours,
  };
}

module.exports = {
  getRedis, metaBase, metaHeaders, metaAccountId, META_REGIONS,
  normSym, instCategory,
  TACTIC_FAMILY_MAP, FAMILY_META, tacticFamily,
  betaMean, betaVariance, betaCI, betaSample,
  safeParse,
  atr, adx, bollingerWidth, priceDp,
  tg, applyCors, selfBase,
  // V11 trading-mode helpers
  TRADING_MODES, R_DISTANCE_TABLE,
  getRDistance, getTradingMode, pipMult, buildLadder,
};