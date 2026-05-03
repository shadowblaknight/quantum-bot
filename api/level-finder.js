/* eslint-disable */
// V11 — api/level-finder.js
// Detects real liquidity levels around current price for use as TP targets.
//
// Returns ranked levels ABOVE and BELOW current price. Each level has:
//   - type: source category (ASIAN_HIGH, LONDON_HIGH, PDH, SWING_H, ROUND, WEEKLY_OPEN, ...)
//   - price: the level
//   - age: how old (hours since formed)
//   - strength: 0-1 composite score (recency + untapped + session weight)
//   - distancePips: distance from current price
//
// Used by AI as TP target candidates. AI picks 4 from the ABOVE/BELOW list (depending on
// trade direction) and the ladder is built from those structural levels.
//
// Storage: not persisted — recomputed each cron tick (broker candles are cached so cheap).

const { getRedis, normSym, instCategory, atr, safeParse } = require('./_lib');
const { fetchCandles, fetchPrice } = require('./broker');

// =================================================================
// Helper: pip mult per category (price-units per pip)
// =================================================================
function pipMultFor(sym) {
  const cat = instCategory(sym);
  if (cat === 'GOLD' || cat === 'METAL') return 0.01;
  if (cat === 'CRYPTO') return 1.0;
  if (cat === 'INDEX')  return 1.0;
  if (sym.includes('JPY')) return 0.01;
  return 0.0001;
}

// =================================================================
// Helper: round-number step per price magnitude
// =================================================================
function roundStep(price) {
  if (price > 50000) return 1000;     // BTC at 78k → step 1000
  if (price > 10000) return 500;      // BTC at 30k or low BTC → 500
  if (price > 1000)  return 50;       // gold ($4500-5000), indices
  if (price > 100)   return 5;        // mid-tier indices
  if (price > 10)    return 0.5;      // crosses like USDJPY at 150
  if (price > 1)     return 0.01;     // forex EURUSD-like: big figures (1.08, 1.09, 1.10)
  return 0.001;                       // micro forex
}

// =================================================================
// Helper: get the current trading session label from UTC hour
// =================================================================
function sessionForHour(utcH) {
  if (utcH >= 13 && utcH < 16) return 'OVERLAP';
  if (utcH >= 13 && utcH < 21) return 'NEW_YORK';
  if (utcH >= 7  && utcH < 13) return 'LONDON';
  return 'ASIAN';
}

// =================================================================
// Helper: session UTC ranges for a given date (used to slice candles)
// Returns {asian: [start, end], london: [start, end], ny: [start, end]} in ms
// =================================================================
function sessionRangesForDate(date) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate();
  return {
    asian:  [Date.UTC(y, m, d, 0, 0),  Date.UTC(y, m, d, 7, 0)],
    london: [Date.UTC(y, m, d, 7, 0),  Date.UTC(y, m, d, 13, 0)],
    ny:     [Date.UTC(y, m, d, 13, 0), Date.UTC(y, m, d, 21, 0)],
  };
}

// Filter candles into a time range
function candlesInRange(candles, startMs, endMs) {
  return candles.filter(c => {
    const t = new Date(c.time).getTime();
    return t >= startMs && t < endMs;
  });
}

// =================================================================
// 1. SESSION HIGHS/LOWS (today's earlier sessions)
// =================================================================
// If currently NY session, returns Asian high+low + London high+low.
// If currently London, returns just Asian high+low.
// If currently Asian, none (no earlier session today).
function findSessionLevels(h1Candles, currentSession) {
  const now = new Date();
  const ranges = sessionRangesForDate(now);
  const out = [];

  if (currentSession === 'LONDON' || currentSession === 'NEW_YORK' || currentSession === 'OVERLAP') {
    // Add Asian session high/low if Asian has actually finished candles
    const asianBars = candlesInRange(h1Candles, ranges.asian[0], ranges.asian[1]);
    if (asianBars.length >= 3) {
      const asHigh = Math.max(...asianBars.map(c => c.high));
      const asLow  = Math.min(...asianBars.map(c => c.low));
      const ageHours = (Date.now() - ranges.asian[1]) / 3600000;
      out.push({ type: 'ASIAN_HIGH', price: asHigh, age: ageHours, source: 'asian session', side: 'above' });
      out.push({ type: 'ASIAN_LOW',  price: asLow,  age: ageHours, source: 'asian session', side: 'below' });
    }
  }
  if (currentSession === 'NEW_YORK' || currentSession === 'OVERLAP') {
    const londonBars = candlesInRange(h1Candles, ranges.london[0], ranges.london[1]);
    if (londonBars.length >= 3) {
      const lHigh = Math.max(...londonBars.map(c => c.high));
      const lLow  = Math.min(...londonBars.map(c => c.low));
      const ageHours = (Date.now() - ranges.london[1]) / 3600000;
      out.push({ type: 'LONDON_HIGH', price: lHigh, age: ageHours, source: 'london session', side: 'above' });
      out.push({ type: 'LONDON_LOW',  price: lLow,  age: ageHours, source: 'london session', side: 'below' });
    }
  }
  return out;
}

// =================================================================
// 2. PRIOR DAY HIGH/LOW (yesterday's daily candle)
// =================================================================
function findPriorDayLevels(d1Candles) {
  if (!d1Candles || d1Candles.length < 2) return [];
  // Last fully-closed daily candle = yesterday's
  const yesterday = d1Candles[d1Candles.length - 2];
  if (!yesterday) return [];
  const ageHours = (Date.now() - new Date(yesterday.time).getTime()) / 3600000;
  return [
    { type: 'PDH', price: yesterday.high, age: ageHours, source: 'prior day', side: 'above' },
    { type: 'PDL', price: yesterday.low,  age: ageHours, source: 'prior day', side: 'below' },
  ];
}

// =================================================================
// 3. RECENT SWING HIGHS/LOWS (H1 fractal — local extremes in last 30 bars)
// =================================================================
// A fractal high = bar whose high > 2 bars before AND > 2 bars after.
// Same for fractal low. We scan last 30 H1 bars (last ~30 hours).
function findSwingLevels(h1Candles) {
  if (!h1Candles || h1Candles.length < 7) return [];
  const out = [];
  const window = h1Candles.slice(-30);  // last 30 bars
  // Need 2 bars on either side, so scan indices 2..length-3
  for (let i = 2; i < window.length - 2; i++) {
    const bar = window[i];
    const isHigh = bar.high > window[i-1].high && bar.high > window[i-2].high
                && bar.high > window[i+1].high && bar.high > window[i+2].high;
    const isLow  = bar.low < window[i-1].low && bar.low < window[i-2].low
                && bar.low < window[i+1].low && bar.low < window[i+2].low;
    const ageHours = (Date.now() - new Date(bar.time).getTime()) / 3600000;
    if (isHigh) out.push({ type: 'SWING_H', price: bar.high, age: ageHours, source: 'h1 swing', side: 'above' });
    if (isLow)  out.push({ type: 'SWING_L', price: bar.low,  age: ageHours, source: 'h1 swing', side: 'below' });
  }
  return out;
}

// =================================================================
// 4. ROUND NUMBERS near current price
// =================================================================
// Returns the next 3 round numbers above and below.
function findRoundNumbers(currentPrice) {
  const step = roundStep(currentPrice);
  const out = [];
  let above = Math.ceil(currentPrice / step) * step;
  let below = Math.floor(currentPrice / step) * step;
  for (let i = 0; i < 3; i++) {
    if (above > currentPrice) out.push({ type: 'ROUND', price: above, age: 0, source: 'round number', side: 'above' });
    if (below < currentPrice) out.push({ type: 'ROUND', price: below, age: 0, source: 'round number', side: 'below' });
    above += step;
    below -= step;
  }
  return out;
}

// =================================================================
// 5. WEEKLY OPEN (this week's Sunday/Monday open price — magnet level)
// =================================================================
function findWeeklyOpen(h1Candles) {
  if (!h1Candles || h1Candles.length < 24) return [];
  // Find first H1 bar of this UTC week (Monday 00:00 UTC)
  const now = new Date();
  const dayOfWeek = now.getUTCDay();  // 0 Sun, 1 Mon, ..., 6 Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7;  // Mon=0, Sun=6
  const mondayMidnight = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday, 0, 0
  );
  // Find the H1 candle at or just after mondayMidnight
  const weekOpenBar = h1Candles.find(c => new Date(c.time).getTime() >= mondayMidnight);
  if (!weekOpenBar) return [];
  const ageHours = (Date.now() - mondayMidnight) / 3600000;
  // Weekly open is one level — both above and below depending on current price
  // We tag side: 'either' and let the caller filter
  return [{ type: 'WEEKLY_OPEN', price: weekOpenBar.open, age: ageHours, source: 'weekly open', side: 'either' }];
}

// =================================================================
// SCORING — compute strength for each level
// =================================================================
// Composite score 0-1 based on:
//   - Recency: newer = stronger (decays over 48h)
//   - Type weight: PDH/PDL > LONDON > ASIAN > SWING > ROUND > WEEKLY (subjective)
//   - Untapped: if price has tested this level recently it's weakened (not modeled yet)
function scoreLevel(level) {
  const typeWeight = {
    'ASIAN_HIGH': 0.7, 'ASIAN_LOW': 0.7,
    'LONDON_HIGH': 0.8, 'LONDON_LOW': 0.8,
    'PDH': 0.85, 'PDL': 0.85,
    'SWING_H': 0.6, 'SWING_L': 0.6,
    'ROUND': 0.55,
    'WEEKLY_OPEN': 0.7,
  };
  const baseWeight = typeWeight[level.type] || 0.5;
  // Recency decay: full strength if <12h old, decays linearly to 0.4 by 48h
  const recency = level.age <= 12 ? 1.0
                : level.age >= 48 ? 0.4
                : 1.0 - ((level.age - 12) / 36) * 0.6;
  return Math.min(1.0, baseWeight * recency);
}

// =================================================================
// MAIN — find all levels for a symbol
// =================================================================
async function findLevelsFor(sym) {
  const [h1Resp, d1Resp, priceResp] = await Promise.all([
    fetchCandles(sym, '1h', 100),
    fetchCandles(sym, '1d', 30),
    fetchPrice(sym),
  ]);
  const h1 = h1Resp.candles || [];
  const d1 = d1Resp.candles || [];
  const currentPrice = priceResp.price;

  if (!currentPrice || h1.length < 10) {
    return { symbol: sym, currentPrice: null, above: [], below: [], allCount: 0 };
  }

  // Determine current session
  const utcH = new Date().getUTCHours();
  const currentSession = sessionForHour(utcH);

  // Gather all levels
  const all = [];
  try { all.push(...findSessionLevels(h1, currentSession)); } catch (e) { console.warn('[level] session: ' + e.message); }
  try { all.push(...findPriorDayLevels(d1)); } catch (e) { console.warn('[level] PDH/PDL: ' + e.message); }
  try { all.push(...findSwingLevels(h1)); } catch (e) { console.warn('[level] swing: ' + e.message); }
  try { all.push(...findRoundNumbers(currentPrice)); } catch (e) { console.warn('[level] round: ' + e.message); }
  try { all.push(...findWeeklyOpen(h1)); } catch (e) { console.warn('[level] weekly: ' + e.message); }

  // Score each level
  for (const lvl of all) lvl.strength = scoreLevel(lvl);

  // Compute distance from current price
  const pipMult = pipMultFor(sym);
  for (const lvl of all) {
    const distPrice = Math.abs(lvl.price - currentPrice);
    lvl.distancePips = Math.round(distPrice / pipMult);
  }

  // Split above/below current price
  // 'either' (weekly open) goes to whichever side it's actually on
  const above = [];
  const below = [];
  for (const lvl of all) {
    if (lvl.price > currentPrice) {
      if (lvl.side === 'above' || lvl.side === 'either') above.push(lvl);
    } else if (lvl.price < currentPrice) {
      if (lvl.side === 'below' || lvl.side === 'either') below.push(lvl);
    }
  }

  // Deduplicate close levels (within 0.05% of price): keep highest-strength
  const dedup = (list) => {
    list.sort((a, b) => a.price - b.price);
    const tolerance = currentPrice * 0.0005;
    const out = [];
    for (const lvl of list) {
      const last = out[out.length - 1];
      if (last && Math.abs(lvl.price - last.price) < tolerance) {
        // Keep stronger
        if (lvl.strength > last.strength) out[out.length - 1] = lvl;
      } else {
        out.push(lvl);
      }
    }
    return out;
  };
  const aboveDedup = dedup(above);
  const belowDedup = dedup(below);

  // Sort by distance for the AI's view
  aboveDedup.sort((a, b) => a.price - b.price);  // ascending: nearest first above
  belowDedup.sort((a, b) => b.price - a.price);  // descending: nearest first below

  return {
    symbol: sym,
    currentPrice,
    session: currentSession,
    above: aboveDedup,
    below: belowDedup,
    allCount: all.length,
    ts: Date.now(),
  };
}

// =================================================================
// HTTP handler — for inspection/debugging
// =================================================================
module.exports = async (req, res) => {
  const sym = String(req.query.symbol || '').toUpperCase();
  if (!sym) return res.status(400).json({ error: 'symbol required' });
  try {
    const result = await findLevelsFor(sym);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'unknown' });
  }
};

module.exports.findLevelsFor   = findLevelsFor;
module.exports.findSessionLevels   = findSessionLevels;
module.exports.findPriorDayLevels  = findPriorDayLevels;
module.exports.findSwingLevels     = findSwingLevels;
module.exports.findRoundNumbers    = findRoundNumbers;
module.exports.findWeeklyOpen      = findWeeklyOpen;
module.exports.scoreLevel          = scoreLevel;