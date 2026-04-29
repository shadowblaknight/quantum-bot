/* eslint-disable */
// V10 — api/backtest.js
// Runs tactic families against historical candle data.
// Reports honest WR / expectancy / max drawdown per family per symbol.
//
// This is the OUT-OF-SAMPLE VALIDATION layer. V9 had none — every "crowned" strategy
// was crowned on production trades. With backtest, we can finally answer:
//   "Does TREND family ACTUALLY work on XAUUSD, or is the live data lucky?"
//
// Trade simulation is intentionally simple — same logic the live AI uses:
//   1. ATR(14) on H1 -> SL distance = 1.5 * ATR
//   2. TP = entry + 2.5 * SL distance (R:R 2.5)
//   3. Family triggers based on simple rules (not AI calls — too slow + expensive)
//   4. One position at a time per symbol
//
// Run modes:
//   POST /api/backtest    body: { symbol, family, start, end, tf? }
//   GET  /api/backtest?action=summary&symbol=XAUUSD
//        -> previously-run results from cache
//
// Backtest results stored at v10:backtest:{symbol}:{family}:{start_end}

const { applyCors, getRedis, normSym, instCategory, safeParse, atr, adx, bollingerWidth } = require('./_lib');
const { readCachedRange } = require('./historical-fetch');

const FAMILIES = ['TREND', 'REVERSION', 'STRUCTURE', 'BREAKOUT', 'RANGE', 'NEWS'];

// Helper: simple EMA
function ema(arr, n) {
  if (arr.length < n) return null;
  let s = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const k = 2 / (n + 1);
  const out = new Array(n - 1).fill(null).concat([s]);
  for (let i = n; i < arr.length; i++) {
    s = arr[i] * k + s * (1 - k);
    out.push(s);
  }
  return out;
}

// === Family signal generators ===
// Each returns { signal: 'BUY'|'SELL'|null, confidence: 0-1 } at index i (0-based)

function signalTrend(candles, i) {
  if (i < 50) return null;
  const closes = candles.slice(0, i + 1).map(c => c.close);
  const ema9   = ema(closes, 9);
  const ema21  = ema(closes, 21);
  const ema50  = ema(closes, 50);
  if (!ema9 || !ema21 || !ema50) return null;
  const last  = candles[i];
  const prev  = candles[i - 1];

  const adxVal = adx(candles.slice(Math.max(0, i - 30), i + 1), 14);
  if (!adxVal || adxVal < 20) return null; // not trending enough

  // Bullish: ema9 > ema21 > ema50, pullback to ema21, bullish bar close
  if (ema9[i] > ema21[i] && ema21[i] > ema50[i]) {
    if (prev.low <= ema21[i] && last.close > ema21[i] && last.close > last.open) {
      return { signal: 'BUY', confidence: Math.min(1, 0.5 + adxVal / 100) };
    }
  }
  // Bearish mirror
  if (ema9[i] < ema21[i] && ema21[i] < ema50[i]) {
    if (prev.high >= ema21[i] && last.close < ema21[i] && last.close < last.open) {
      return { signal: 'SELL', confidence: Math.min(1, 0.5 + adxVal / 100) };
    }
  }
  return null;
}

function signalReversion(candles, i) {
  if (i < 25) return null;
  const closes = candles.slice(0, i + 1).map(c => c.close);
  // Bollinger %B
  const period = 20;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const last = candles[i];
  const prev = candles[i - 1];

  // Need RANGING regime (low ADX)
  const adxVal = adx(candles.slice(Math.max(0, i - 30), i + 1), 14);
  if (!adxVal || adxVal > 25) return null;

  // Bounce off lower band
  if (prev.low <= lower && last.close > lower && last.close > last.open) {
    return { signal: 'BUY', confidence: 0.6 };
  }
  // Reject upper band
  if (prev.high >= upper && last.close < upper && last.close < last.open) {
    return { signal: 'SELL', confidence: 0.6 };
  }
  return null;
}

function signalStructure(candles, i) {
  if (i < 30) return null;
  // Liquidity sweep: previous candle takes out a recent high/low, current candle reverses
  const last = candles[i];
  const prev = candles[i - 1];
  const lookback = candles.slice(Math.max(0, i - 20), i - 1);
  const recentHigh = Math.max(...lookback.map(c => c.high));
  const recentLow  = Math.min(...lookback.map(c => c.low));

  // Sweep low + bullish reversal
  if (prev.low < recentLow && last.close > prev.high && last.close > last.open) {
    return { signal: 'BUY', confidence: 0.65 };
  }
  // Sweep high + bearish reversal
  if (prev.high > recentHigh && last.close < prev.low && last.close < last.open) {
    return { signal: 'SELL', confidence: 0.65 };
  }
  return null;
}

function signalBreakout(candles, i) {
  if (i < 25) return null;
  const last = candles[i];
  // Range break: last close > 20-period high, with body > 60% of range
  const lookback20 = candles.slice(Math.max(0, i - 20), i);
  const rangeHigh = Math.max(...lookback20.map(c => c.high));
  const rangeLow  = Math.min(...lookback20.map(c => c.low));
  const bodyPct = Math.abs(last.close - last.open) / Math.max(1e-9, last.high - last.low);

  if (last.close > rangeHigh && last.close > last.open && bodyPct > 0.6) {
    return { signal: 'BUY', confidence: 0.6 };
  }
  if (last.close < rangeLow && last.close < last.open && bodyPct > 0.6) {
    return { signal: 'SELL', confidence: 0.6 };
  }
  return null;
}

function signalRange(candles, i) {
  // Same as REVERSION but with stricter ADX requirement
  if (i < 25) return null;
  const adxVal = adx(candles.slice(Math.max(0, i - 30), i + 1), 14);
  if (!adxVal || adxVal > 18) return null;
  return signalReversion(candles, i);
}

function signalNews(candles, i) {
  // Simulated: a news-like spike is when ATR(5) > 2x ATR(20) — abnormal volatility burst
  if (i < 25) return null;
  const recentATR = atr(candles.slice(Math.max(0, i - 5), i + 1), 5);
  const baselineATR = atr(candles.slice(Math.max(0, i - 25), i - 5), 14);
  if (!recentATR || !baselineATR) return null;
  const ratio = recentATR / baselineATR;
  if (ratio < 2.0) return null;
  // Trade with the spike direction
  const last = candles[i];
  if (last.close > last.open) return { signal: 'BUY', confidence: 0.5 };
  if (last.close < last.open) return { signal: 'SELL', confidence: 0.5 };
  return null;
}

const FAMILY_SIGNALS = {
  TREND:     signalTrend,
  REVERSION: signalReversion,
  STRUCTURE: signalStructure,
  BREAKOUT:  signalBreakout,
  RANGE:     signalRange,
  NEWS:      signalNews,
};

// === Backtest engine ===
function runBacktest({ candles, family, rrRatio = 2.5, slMultATR = 1.5 }) {
  const signalFn = FAMILY_SIGNALS[family];
  if (!signalFn) return { error: 'Unknown family: ' + family };

  const trades = [];
  let openTrade = null;
  let equity = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;
  const equityCurve = [];

  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];

    // Check if open trade hits SL or TP
    if (openTrade) {
      let exitPrice = null;
      let exitReason = null;
      if (openTrade.dir === 'BUY') {
        if (candle.low <= openTrade.sl)       { exitPrice = openTrade.sl; exitReason = 'SL'; }
        else if (candle.high >= openTrade.tp) { exitPrice = openTrade.tp; exitReason = 'TP'; }
      } else {
        if (candle.high >= openTrade.sl)      { exitPrice = openTrade.sl; exitReason = 'SL'; }
        else if (candle.low <= openTrade.tp)  { exitPrice = openTrade.tp; exitReason = 'TP'; }
      }
      if (exitPrice != null) {
        const pnlR = exitReason === 'TP' ? rrRatio : -1;
        const won = exitReason === 'TP';
        trades.push({
          entryTime: openTrade.entryTime,
          exitTime: candle.time,
          entry: openTrade.entry,
          exit: exitPrice,
          dir: openTrade.dir,
          pnlR,
          won,
          confidence: openTrade.confidence,
        });
        equity += pnlR;
        if (equity > peakEquity) peakEquity = equity;
        const drawdown = peakEquity - equity;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        equityCurve.push({ time: candle.time, equity });
        openTrade = null;
      }
    }

    // No open trade -> check for new signal
    if (!openTrade) {
      const sig = signalFn(candles, i);
      if (sig && sig.signal && sig.confidence > 0.4) {
        const slDist = (atr(candles.slice(Math.max(0, i - 20), i + 1), 14) || 0) * slMultATR;
        if (slDist > 0) {
          const entry = candle.close;
          const sl = sig.signal === 'BUY' ? entry - slDist : entry + slDist;
          const tp = sig.signal === 'BUY' ? entry + slDist * rrRatio : entry - slDist * rrRatio;
          openTrade = {
            entryTime: candle.time, entry, sl, tp,
            dir: sig.signal, confidence: sig.confidence,
          };
        }
      }
    }
  }

  // Calculate stats
  const wins = trades.filter(t => t.won).length;
  const losses = trades.filter(t => !t.won).length;
  const total = trades.length;
  const winRate = total > 0 ? wins / total : 0;
  const totalR = trades.reduce((s, t) => s + t.pnlR, 0);
  const expectancyR = total > 0 ? totalR / total : 0;
  // Profit factor
  const wonR = trades.filter(t => t.won).reduce((s, t) => s + t.pnlR, 0);
  const lostR = Math.abs(trades.filter(t => !t.won).reduce((s, t) => s + t.pnlR, 0));
  const profitFactor = lostR > 0 ? wonR / lostR : (wonR > 0 ? Infinity : 0);

  return {
    trades,
    stats: {
      total, wins, losses,
      winRate: Math.round(winRate * 1000) / 10,
      totalR: Math.round(totalR * 100) / 100,
      expectancyR: Math.round(expectancyR * 100) / 100,
      profitFactor: profitFactor === Infinity ? 999 : Math.round(profitFactor * 100) / 100,
      maxDrawdownR: Math.round(maxDrawdown * 100) / 100,
      finalEquity: Math.round(equity * 100) / 100,
    },
    equityCurve,
  };
}

async function runBacktestForSymbol({ symbol, family, start, end, tf = '1h' }) {
  const candles = await readCachedRange(symbol, tf, start, end);
  if (!candles || candles.length < 100) {
    return {
      error: 'Not enough cached candles for ' + symbol + ' on ' + tf + ' between ' + start + ' and ' + end + '. Run /api/historical-fetch first.',
      candleCount: candles ? candles.length : 0,
    };
  }
  const result = runBacktest({ candles, family });

  // Cache result
  const r = getRedis();
  if (r) {
    const key = 'v10:backtest:' + normSym(symbol) + ':' + family + ':' + start + '_' + end;
    await r.set(key, JSON.stringify({
      symbol: normSym(symbol), family, start, end, tf,
      candleCount: candles.length,
      stats: result.stats,
      ts: Date.now(),
    }), { ex: 30 * 24 * 60 * 60 }).catch(() => {});
  }

  return {
    symbol: normSym(symbol), family, start, end, tf,
    candleCount: candles.length,
    stats: result.stats,
    // Don't return all trades + equity curve in API by default (too big). Return summary only.
    sampleTrades: result.trades.slice(0, 10),
    equityCurveLength: result.equityCurve.length,
  };
}

// Run all 6 families on a symbol
async function runFullBacktest({ symbol, start, end, tf = '1h' }) {
  const results = {};
  for (const fam of FAMILIES) {
    results[fam] = await runBacktestForSymbol({ symbol, family: fam, start, end, tf });
  }
  return { symbol: normSym(symbol), start, end, tf, families: results };
}

// Read previously-cached backtest results
async function readBacktestSummary(symbol) {
  const r = getRedis(); if (!r) return [];
  const sym = normSym(symbol);
  const keys = [];
  let cursor = 0;
  do {
    const result = await r.scan(cursor, { match: 'v10:backtest:' + sym + ':*', count: 200 }).catch(() => [0, []]);
    cursor = parseInt(result[0], 10);
    keys.push(...result[1]);
  } while (cursor !== 0);
  const out = [];
  for (const k of keys) {
    const raw = await r.get(k).catch(() => null);
    const parsed = safeParse(raw);
    if (parsed) out.push(parsed);
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    const action = String(req.query.action || 'summary');
    if (action === 'summary') {
      const sym = String(req.query.symbol || '').toUpperCase();
      if (!sym) return res.status(400).json({ error: 'symbol required' });
      return res.status(200).json(await readBacktestSummary(sym));
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    if (!body || !body.symbol) return res.status(400).json({ error: 'symbol required' });

    if (body.family === 'ALL' || !body.family) {
      // Run all 6 families
      return res.status(200).json(await runFullBacktest({
        symbol: body.symbol,
        start: body.start || new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10),
        end:   body.end   || new Date().toISOString().slice(0, 10),
        tf:    body.tf    || '1h',
      }));
    }
    return res.status(200).json(await runBacktestForSymbol({
      symbol: body.symbol,
      family: body.family,
      start: body.start || new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10),
      end:   body.end   || new Date().toISOString().slice(0, 10),
      tf:    body.tf    || '1h',
    }));
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports.runBacktest          = runBacktest;
module.exports.runBacktestForSymbol = runBacktestForSymbol;
module.exports.runFullBacktest      = runFullBacktest;
module.exports.FAMILY_SIGNALS       = FAMILY_SIGNALS;