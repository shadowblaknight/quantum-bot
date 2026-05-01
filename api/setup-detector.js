/* eslint-disable */
// V11 — api/setup-detector.js
// Pure pattern-matching scanner. Runs each cron tick. Stores active setups to Redis
// for the AI to read on its next decision call.
//
// Five patterns:
//   1. LIQUIDITY_SWEEP  — wick takes out swing high/low, body rejects back
//   2. RANGE_BREAK      — close exits multi-bar consolidation with volume confirmation
//   3. SESSION_DRIVE    — strong directional candle in first 1-2 hours of London/NY open
//   4. NEWS_MOMENTUM    — directional run shortly after a high-impact news event
//   5. CONFLUENCE       — price at 3+ overlapping key levels with rejection
//
// Each detector returns {pattern, direction, quality, level, invalidatesAt, expiresAt, evidence}
// or null if no setup found.

const { getRedis, normSym, atr, safeParse } = require('./_lib');
const { fetchCandles } = require('./broker');

// =================================================================
// Helpers
// =================================================================

function sma(arr, n) {
  if (!arr || arr.length < n) return null;
  const s = arr.slice(-n).reduce((a, b) => a + b, 0);
  return s / n;
}

function stdev(arr, n) {
  if (!arr || arr.length < n) return null;
  const slice = arr.slice(-n);
  const m = sma(slice, n);
  const v = slice.reduce((a, b) => a + Math.pow(b - m, 2), 0) / n;
  return Math.sqrt(v);
}

function pctChange(a, b) {
  return b === 0 ? 0 : (a - b) / b;
}

// =================================================================
// 1. LIQUIDITY SWEEP detector
// =================================================================
function detectLiquiditySweep(h1Candles, sessionLabel) {
  if (!h1Candles || h1Candles.length < 21) return null;
  const recent = h1Candles.slice(-20, -1);  // last 20 bars excluding current
  const current = h1Candles[h1Candles.length - 1];
  if (!current || !current.high || !current.low) return null;

  const recentHigh = Math.max(...recent.map(c => c.high));
  const recentLow  = Math.min(...recent.map(c => c.low));

  // Volume context
  const volumes = h1Candles.slice(-20, -1).map(c => c.tickVolume || c.volume || 0);
  const avgVol = sma(volumes, 19) || 0;
  const currentVol = current.tickVolume || current.volume || 0;
  const volStrong = avgVol > 0 && currentVol >= avgVol * 1.2;

  // Sweep HIGH (bearish): wick took out high, body rejected back below
  if (current.high > recentHigh && current.close < recentHigh) {
    const wickPenetration = (current.high - recentHigh) / (recentHigh - recentLow || 1);
    const bodyClosedBelow = (recentHigh - current.close) / (recentHigh - recentLow || 1);
    let quality = 0.4 + Math.min(wickPenetration * 4, 0.3) + Math.min(bodyClosedBelow * 2, 0.2);
    if (sessionLabel === 'LONDON' || sessionLabel === 'NEW_YORK' || sessionLabel === 'OVERLAP') quality += 0.10;
    if (volStrong) quality += 0.10;
    quality = Math.max(0, Math.min(1, quality));
    return {
      pattern: 'LIQUIDITY_SWEEP',
      direction: 'SHORT',
      quality,
      level: recentHigh,
      invalidatesAt: current.high,
      expiresAt: Date.now() + 4 * 60 * 60 * 1000,  // 4h
      evidence: [
        'H1 wick took out 20-bar high ' + recentHigh.toFixed(5),
        'Close back below at ' + current.close.toFixed(5),
        sessionLabel + ' session',
        volStrong ? 'Volume +' + ((currentVol / avgVol - 1) * 100).toFixed(0) + '%' : 'Volume normal',
      ],
    };
  }

  // Sweep LOW (bullish): wick took out low, body rejected back above
  if (current.low < recentLow && current.close > recentLow) {
    const wickPenetration = (recentLow - current.low) / (recentHigh - recentLow || 1);
    const bodyClosedAbove = (current.close - recentLow) / (recentHigh - recentLow || 1);
    let quality = 0.4 + Math.min(wickPenetration * 4, 0.3) + Math.min(bodyClosedAbove * 2, 0.2);
    if (sessionLabel === 'LONDON' || sessionLabel === 'NEW_YORK' || sessionLabel === 'OVERLAP') quality += 0.10;
    if (volStrong) quality += 0.10;
    quality = Math.max(0, Math.min(1, quality));
    return {
      pattern: 'LIQUIDITY_SWEEP',
      direction: 'LONG',
      quality,
      level: recentLow,
      invalidatesAt: current.low,
      expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      evidence: [
        'H1 wick took out 20-bar low ' + recentLow.toFixed(5),
        'Close back above at ' + current.close.toFixed(5),
        sessionLabel + ' session',
        volStrong ? 'Volume +' + ((currentVol / avgVol - 1) * 100).toFixed(0) + '%' : 'Volume normal',
      ],
    };
  }

  return null;
}

// =================================================================
// 2. RANGE BREAK detector
// =================================================================
function detectRangeBreak(h1Candles) {
  if (!h1Candles || h1Candles.length < 25) return null;
  const current = h1Candles[h1Candles.length - 1];
  if (!current) return null;

  // Range = last 6 H1 bars before current (6 hours of consolidation)
  const range = h1Candles.slice(-7, -1);
  const rangeHigh = Math.max(...range.map(c => c.high));
  const rangeLow  = Math.min(...range.map(c => c.low));
  const rangeWidth = rangeHigh - rangeLow;
  if (rangeWidth <= 0) return null;

  // Range must be relatively tight: width < 1.5x ATR(14)
  const atr14 = atr(h1Candles.slice(-15), 14);
  if (!atr14 || rangeWidth > atr14 * 1.5) return null;

  // Volume context
  const volumes = h1Candles.slice(-21, -1).map(c => c.tickVolume || c.volume || 0);
  const avgVol = sma(volumes, 20) || 0;
  const volSD = stdev(volumes, 20) || 1;
  const currentVol = current.tickVolume || current.volume || 0;
  const volZ = avgVol > 0 ? (currentVol - avgVol) / volSD : 0;

  // Need volume confirmation: 1.5σ above mean
  if (volZ < 1.5) return null;

  // Direction
  if (current.close > rangeHigh) {
    const breakStrength = (current.close - rangeHigh) / atr14;
    const quality = Math.min(0.95, 0.5 + breakStrength * 0.2 + Math.min(volZ * 0.05, 0.2));
    return {
      pattern: 'RANGE_BREAK',
      direction: 'LONG',
      quality,
      level: rangeHigh,
      invalidatesAt: rangeLow,
      expiresAt: Date.now() + 3 * 60 * 60 * 1000,
      evidence: [
        '6h range ' + rangeLow.toFixed(5) + '-' + rangeHigh.toFixed(5),
        'H1 close ' + current.close.toFixed(5) + ' breaks above',
        'Volume +' + volZ.toFixed(1) + 'σ',
        'Range width ' + (rangeWidth / atr14).toFixed(2) + 'x ATR',
      ],
    };
  }
  if (current.close < rangeLow) {
    const breakStrength = (rangeLow - current.close) / atr14;
    const quality = Math.min(0.95, 0.5 + breakStrength * 0.2 + Math.min(volZ * 0.05, 0.2));
    return {
      pattern: 'RANGE_BREAK',
      direction: 'SHORT',
      quality,
      level: rangeLow,
      invalidatesAt: rangeHigh,
      expiresAt: Date.now() + 3 * 60 * 60 * 1000,
      evidence: [
        '6h range ' + rangeLow.toFixed(5) + '-' + rangeHigh.toFixed(5),
        'H1 close ' + current.close.toFixed(5) + ' breaks below',
        'Volume +' + volZ.toFixed(1) + 'σ',
        'Range width ' + (rangeWidth / atr14).toFixed(2) + 'x ATR',
      ],
    };
  }

  return null;
}

// =================================================================
// 3. SESSION OPENING DRIVE detector
// =================================================================
function detectSessionDrive(h1Candles) {
  if (!h1Candles || h1Candles.length < 15) return null;
  const utcH = new Date().getUTCHours();
  const utcM = new Date().getUTCMinutes();

  // Only fire in first 90 minutes of London (08:00-09:30 UTC) or NY (13:00-14:30 UTC)
  let session = null;
  if (utcH === 8 || (utcH === 9 && utcM <= 30)) session = 'LONDON';
  else if (utcH === 13 || (utcH === 14 && utcM <= 30)) session = 'NEW_YORK';
  else return null;

  const current = h1Candles[h1Candles.length - 1];
  if (!current) return null;

  // Need a strong directional candle: range > 0.8 ATR, close in top/bottom 25% of range
  const atr14 = atr(h1Candles.slice(-15), 14);
  if (!atr14) return null;
  const candleRange = current.high - current.low;
  if (candleRange < atr14 * 0.8) return null;

  const closeInRange = (current.close - current.low) / candleRange;
  let direction = null;
  if (closeInRange >= 0.75) direction = 'LONG';
  else if (closeInRange <= 0.25) direction = 'SHORT';
  else return null;

  // Quality boosted by candle strength + Asian quietness
  const asianBars = h1Candles.slice(-10, -1);  // approx prior session
  const asianRange = Math.max(...asianBars.map(c => c.high)) - Math.min(...asianBars.map(c => c.low));
  const asianQuiet = asianRange < atr14 * 1.5;

  let quality = 0.5 + (candleRange / atr14 - 0.8) * 0.2;
  if (asianQuiet) quality += 0.15;
  quality = Math.max(0, Math.min(0.85, quality));

  return {
    pattern: 'SESSION_DRIVE',
    direction,
    quality,
    level: direction === 'LONG' ? current.low : current.high,
    invalidatesAt: direction === 'LONG' ? current.low : current.high,
    expiresAt: Date.now() + 2 * 60 * 60 * 1000,
    evidence: [
      session + ' open drive',
      'H1 range ' + (candleRange / atr14).toFixed(2) + 'x ATR',
      'Close in ' + (direction === 'LONG' ? 'top' : 'bottom') + ' 25%',
      asianQuiet ? 'Prior session was quiet' : 'Prior session was active',
    ],
  };
}

// =================================================================
// 4. NEWS MOMENTUM detector
// =================================================================
// Reads recent news events from Redis (populated by the news cron in V10)
async function detectNewsMomentum(sym, h1Candles, m5Candles) {
  if (!h1Candles || h1Candles.length < 5 || !m5Candles || m5Candles.length < 6) return null;

  const r = getRedis();
  if (!r) return null;
  const newsRaw = await r.get('v10:news:upcoming').catch(() => null);
  const news = safeParse(newsRaw);
  if (!Array.isArray(news)) return null;

  // Find HIGH-impact event in last 60 minutes affecting this symbol's currencies
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const symU = normSym(sym);
  const recent = news.filter(e => {
    if (e.impact !== 'High') return false;
    const t = new Date(e.date || e.time).getTime();
    if (t < cutoff || t > now) return false;
    const c = (e.country || '').toUpperCase();
    if (!c) return false;
    if (symU.includes('USD') && (c === 'US' || c === 'USA')) return true;
    if (symU.includes('EUR') && (c === 'EU' || c === 'EUR' || c === 'EURO')) return true;
    if (symU.includes('GBP') && (c === 'GB' || c === 'UK' || c === 'GBP')) return true;
    if (symU.includes('JPY') && (c === 'JP' || c === 'JPY')) return true;
    if (symU.includes('AUD') && (c === 'AU' || c === 'AUD')) return true;
    if (symU.includes('CAD') && (c === 'CA' || c === 'CAD')) return true;
    return false;
  });
  if (recent.length === 0) return null;
  // Sort by time descending so we use the most recent event
  recent.sort((a, b) => new Date(b.date || b.time).getTime() - new Date(a.date || a.time).getTime());
  const event = recent[0];
  const eventTime = new Date(event.date || event.time).getTime();
  const minsSince = (now - eventTime) / 60000;

  // Tradeable window: 15-45 min after release
  if (minsSince < 15 || minsSince > 45) return null;

  // Need 3+ consecutive same-direction M5 candles after the event
  const last5m = m5Candles.slice(-5);
  let direction = null;
  const closes = last5m.map(c => c.close);
  if (closes[0] < closes[1] && closes[1] < closes[2] && closes[2] < closes[3]) direction = 'LONG';
  else if (closes[0] > closes[1] && closes[1] > closes[2] && closes[2] > closes[3]) direction = 'SHORT';
  if (!direction) return null;

  const moveSize = Math.abs(closes[3] - closes[0]);
  const atr14 = atr(h1Candles.slice(-15), 14);
  if (!atr14 || moveSize < atr14 * 0.3) return null;

  const quality = Math.min(0.85, 0.55 + (moveSize / atr14) * 0.3);
  return {
    pattern: 'NEWS_MOMENTUM',
    direction,
    quality,
    level: closes[3],
    invalidatesAt: direction === 'LONG' ? closes[0] : closes[0],
    expiresAt: eventTime + 90 * 60 * 1000,  // expires 90min after the event
    evidence: [
      'High-impact ' + (event.country || '') + ' event ' + minsSince.toFixed(0) + 'min ago',
      event.title || event.event || 'News release',
      '3 consecutive M5 candles ' + direction,
      'Move size ' + (moveSize / atr14).toFixed(2) + 'x H1 ATR',
    ],
  };
}

// =================================================================
// 5. CONFLUENCE detector
// =================================================================
function detectConfluence(h1Candles, h4Candles, d1Candles) {
  if (!h1Candles || h1Candles.length < 25) return null;
  const current = h1Candles[h1Candles.length - 1];
  if (!current) return null;
  const price = current.close;
  const atr14 = atr(h1Candles.slice(-15), 14);
  if (!atr14) return null;
  const proximityZone = atr14 * 0.3;

  const levels = [];

  // Prior day H/L
  if (d1Candles && d1Candles.length >= 2) {
    const yesterday = d1Candles[d1Candles.length - 2];
    if (yesterday) {
      levels.push({ name: 'PDH', value: yesterday.high });
      levels.push({ name: 'PDL', value: yesterday.low });
    }
  }
  // Weekly open (approximate: oldest H4 candle of the week)
  if (h4Candles && h4Candles.length >= 30) {
    levels.push({ name: 'W-Open', value: h4Candles[h4Candles.length - 30].open });
  }
  // Round numbers near current price
  let step;
  if (price > 10000) step = 100;       // BTC: 70000, 70100, ...
  else if (price > 1000) step = 10;    // gold/indices
  else if (price > 100) step = 1;
  else if (price > 10) step = 0.1;
  else step = 0.01;                    // forex: 1.17, 1.18, ...
  const round = Math.round(price / step) * step;
  levels.push({ name: 'Round-' + step, value: round });
  // Session H/L (last 8 bars)
  const sessionBars = h1Candles.slice(-9, -1);
  if (sessionBars.length >= 4) {
    levels.push({ name: 'SessH', value: Math.max(...sessionBars.map(c => c.high)) });
    levels.push({ name: 'SessL', value: Math.min(...sessionBars.map(c => c.low)) });
  }

  // Filter to nearby levels
  const near = levels.filter(l => Math.abs(l.value - price) <= proximityZone);
  if (near.length < 3) return null;

  // Need a rejection candle (long wick on side of confluence)
  const candleRange = current.high - current.low;
  if (candleRange <= 0) return null;
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  let direction = null;
  if (upperWick / candleRange > 0.5) direction = 'SHORT';   // long upper wick = rejection from above
  else if (lowerWick / candleRange > 0.5) direction = 'LONG';  // long lower wick = rejection from below
  else return null;

  const quality = Math.min(0.90, 0.5 + (near.length - 3) * 0.10 + (Math.max(upperWick, lowerWick) / candleRange - 0.5) * 0.4);
  return {
    pattern: 'CONFLUENCE',
    direction,
    quality,
    level: price,
    invalidatesAt: direction === 'LONG' ? current.low : current.high,
    expiresAt: Date.now() + 3 * 60 * 60 * 1000,
    evidence: [
      near.length + ' levels within ' + proximityZone.toFixed(5) + ' of price',
      near.map(l => l.name + '@' + l.value.toFixed(5)).join(', '),
      direction === 'LONG' ? 'Lower wick rejection' : 'Upper wick rejection',
    ],
  };
}

// =================================================================
// MAIN: scan one symbol, return all active setups
// =================================================================
async function scanSymbol(sym) {
  // Pull the candles we need (cached at broker layer, very cheap)
  const [h1Resp, h4Resp, d1Resp, m5Resp] = await Promise.all([
    fetchCandles(sym, '1h', 30),
    fetchCandles(sym, '4h', 30),
    fetchCandles(sym, '1d', 10),
    fetchCandles(sym, '5m', 10),
  ]);
  const h1 = h1Resp.candles || [];
  const h4 = h4Resp.candles || [];
  const d1 = d1Resp.candles || [];
  const m5 = m5Resp.candles || [];

  if (h1.length < 21) return [];  // not enough data

  const utcH = new Date().getUTCHours();
  const sessionLabel = utcH >= 13 && utcH < 16 ? 'OVERLAP'
                     : utcH >= 13 && utcH < 18 ? 'NEW_YORK'
                     : utcH >= 8  && utcH < 16 ? 'LONDON'
                     : 'ASIAN';

  const results = [];
  try {
    const sw = detectLiquiditySweep(h1, sessionLabel);
    if (sw) results.push(sw);
  } catch (e) { console.warn('[setup] sweep detect: ' + e.message); }
  try {
    const rb = detectRangeBreak(h1);
    if (rb) results.push(rb);
  } catch (e) { console.warn('[setup] range detect: ' + e.message); }
  try {
    const sd = detectSessionDrive(h1);
    if (sd) results.push(sd);
  } catch (e) { console.warn('[setup] drive detect: ' + e.message); }
  try {
    const nm = await detectNewsMomentum(sym, h1, m5);
    if (nm) results.push(nm);
  } catch (e) { console.warn('[setup] news detect: ' + e.message); }
  try {
    const cf = detectConfluence(h1, h4, d1);
    if (cf) results.push(cf);
  } catch (e) { console.warn('[setup] confluence detect: ' + e.message); }

  return results;
}

// Cache active setups in Redis under v11:setup:{sym}
async function scanAndStore(sym) {
  const setups = await scanSymbol(sym);
  const r = getRedis();
  if (r) {
    if (setups.length > 0) {
      const ttl = Math.max(60, Math.floor((Math.max(...setups.map(s => s.expiresAt)) - Date.now()) / 1000));
      await r.set('v11:setup:' + normSym(sym), JSON.stringify({
        ts: Date.now(),
        setups,
      }), { ex: ttl }).catch(() => {});
    } else {
      // Clear stale setups
      await r.del('v11:setup:' + normSym(sym)).catch(() => {});
    }
  }
  return setups;
}

// Read cached setups for AI to consume
async function readSetupsFor(sym) {
  const r = getRedis();
  if (!r) return [];
  const raw = await r.get('v11:setup:' + normSym(sym)).catch(() => null);
  const parsed = safeParse(raw);
  if (!parsed || !Array.isArray(parsed.setups)) return [];
  // Filter expired
  const now = Date.now();
  return parsed.setups.filter(s => s.expiresAt > now);
}

// =================================================================
// HTTP handler — useful for debugging
// =================================================================
module.exports = async (req, res) => {
  const sym = String(req.query.symbol || '').toUpperCase();
  if (!sym) return res.status(400).json({ error: 'symbol required' });
  const action = String(req.query.action || 'scan');

  if (action === 'read') {
    const setups = await readSetupsFor(sym);
    return res.status(200).json({ symbol: sym, count: setups.length, setups });
  }
  // default: live scan
  const setups = await scanAndStore(sym);
  return res.status(200).json({ symbol: sym, count: setups.length, setups, scanTs: Date.now() });
};

module.exports.scanSymbol      = scanSymbol;
module.exports.scanAndStore    = scanAndStore;
module.exports.readSetupsFor   = readSetupsFor;