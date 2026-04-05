import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const INSTRUMENTS = [
  { id: "GBPUSD",  label: "GBP/USD",  type: "FOREX",     color: "#00D4AA", icon: "₤" },
  { id: "BTCUSDT", label: "BTC/USDT", type: "CRYPTO",    color: "#F7931A", icon: "₿" },
  { id: "XAUUSD",  label: "XAU/USD",  type: "COMMODITY", color: "#FFD700", icon: "⬡" },
];

// ─── MARKET HOURS ─────────────────────────────────────────────────────────────
const getMarketStatus = () => {
  const now = new Date();
  const utcDay  = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;
  const crypto  = { open: true, session: "24/7" };
  let forex = { open: false, session: "WEEKEND" };
  if (utcDay >= 1 && utcDay <= 4) {
    const s = utcTime < 8 ? "SYDNEY/TOKYO" : utcTime < 16 ? "LONDON" : "NEW YORK";
    forex = { open: true, session: s };
  } else if (utcDay === 5 && utcTime < 22) {
    forex = { open: true, session: utcTime < 16 ? "LONDON" : "NEW YORK" };
  } else if (utcDay === 0 && utcTime >= 22) {
    forex = { open: true, session: "SYDNEY" };
  }
  const gold = forex.open ? { open: true, session: "COMMODITIES" } : { open: false, session: "WEEKEND" };
  return { GBPUSD: forex, BTCUSDT: crypto, XAUUSD: gold };
};

// Check if current time is near market close (avoid overnight trades)
const isNearMarketClose = () => {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;
  if (utcDay === 5 && utcTime >= 21.5) return true;
  return false;
};

// ─── REAL INDICATOR CALCULATIONS ──────────────────────────────────────────────
const calcEMA = (arr, period) => {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
  return ema;
};

const calcRSI = (prices, period = 14) => {
  if (prices.length < period + 1) return 50;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period; avgLoss /= period;
  // Smoothed RSI
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(changes[i], 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-changes[i], 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
};

// Real MACD calculation
const calcMACD = (prices) => {
  if (prices.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, hist: 0 };
  const macdLine = ema12 - ema26;
  // Calculate signal line (9 EMA of MACD values)
  const macdValues = [];
  for (let i = 26; i <= prices.length; i++) {
    const e12 = calcEMA(prices.slice(0, i), 12);
    const e26 = calcEMA(prices.slice(0, i), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  const signalLine = macdValues.length >= 9 ? calcEMA(macdValues, 9) : macdLine;
  const histogram = macdLine - (signalLine || macdLine);
  return { macd: macdLine, signal: signalLine || macdLine, hist: histogram };
};

const calcBollinger = (prices, period = 20) => {
  if (prices.length < period) return { upper: 0, middle: 0, lower: 0, pct: 50 };
  const slice = prices.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + 2 * std, lower = mean - 2 * std;
  const last  = prices[prices.length - 1];
  const pct   = upper === lower ? 50 : ((last - lower) / (upper - lower)) * 100;
  return { upper, middle: mean, lower, pct, std };
};

// ATR for stop loss calculation
const calcATR = (prices, period = 14) => {
  if (prices.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < prices.length; i++) {
    trs.push(Math.abs(prices[i] - prices[i - 1]));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
};



// ─── SESSION TACTICS ENGINE ──────────────────────────────────────────────────

// Session time constants (UTC hours)
const SESSION_TIMES = {
  ASIAN_START:  0,
  ASIAN_END:    8,
  LONDON_OPEN:  8,
  LONDON_END:   16,
  NY_OPEN:      13,
  NY_END:       21,
};

// Get current session info
const getSessionInfo = () => {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;
  const utcDay  = now.getUTCDay(); // 0=Sun, 6=Sat

  // Weekend check
  if (utcDay === 0 || utcDay === 6) {
    return { session: 'WEEKEND', isLondonOpen: false, isNYOpen: false, isAsian: false, tradingAllowed: false };
  }

  const isAsian    = utcTime >= SESSION_TIMES.ASIAN_START  && utcTime < SESSION_TIMES.ASIAN_END;
  const isLondon   = utcTime >= SESSION_TIMES.LONDON_OPEN  && utcTime < SESSION_TIMES.LONDON_END;
  const isNY       = utcTime >= SESSION_TIMES.NY_OPEN      && utcTime < SESSION_TIMES.NY_END;
  const isOverlap  = utcTime >= SESSION_TIMES.NY_OPEN      && utcTime < SESSION_TIMES.LONDON_END;

  // Session open windows: first 30 minutes
  const isLondonOpen = utcTime >= SESSION_TIMES.LONDON_OPEN && utcTime < SESSION_TIMES.LONDON_OPEN + 0.5;
  const isNYOpen     = utcTime >= SESSION_TIMES.NY_OPEN     && utcTime < SESSION_TIMES.NY_OPEN + 0.5;

  let session = 'OFF_HOURS';
  if (isOverlap)    session = 'LONDON_NY_OVERLAP';
  else if (isNY)    session = 'NEW_YORK';
  else if (isLondon) session = 'LONDON';
  else if (isAsian)  session = 'ASIAN';

  return {
    session,
    isLondonOpen,
    isNYOpen,
    isAsian,
    isLondon,
    isNY,
    isOverlap,
    tradingAllowed: isLondon || isNY, // only trade London and NY
    utcTime
  };
};

// Calculate Asian session High/Low from candles
const getAsianRange = (candles) => {
  if (!candles || candles.length < 10) return null;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const asianEnd = new Date(todayStart);
  asianEnd.setUTCHours(8, 0, 0, 0);

  // Filter candles within today's Asian session
  const asianCandles = candles.filter(c => {
    const t = new Date(c.time);
    return t >= todayStart && t < asianEnd;
  });

  if (asianCandles.length < 3) return null;

  const high = Math.max(...asianCandles.map(c => c.high));
  const low  = Math.min(...asianCandles.map(c => c.low));

  return { high, low, mid: (high + low) / 2, candleCount: asianCandles.length };
};

// Session-based entry filter
const getSessionFilter = (candles, direction, currentPrice) => {
  const sessionInfo = getSessionInfo();

  if (!sessionInfo.tradingAllowed) {
    return { allowed: false, reason: 'Outside trading hours (London/NY only)' };
  }

  const asianRange = getAsianRange(candles);

  // At London or NY open - look for Asian range breakout
  if (sessionInfo.isLondonOpen || sessionInfo.isNYOpen) {
    const sessionName = sessionInfo.isLondonOpen ? 'London' : 'New York';

    if (asianRange) {
      // LONG: price breaking above Asian High
      if (direction === 'LONG' && currentPrice > asianRange.high) {
        return {
          allowed: true,
          reason: `${sessionName} open - Asian High breakout`,
          asianRange,
          sessionInfo
        };
      }
      // SHORT: price breaking below Asian Low
      if (direction === 'SHORT' && currentPrice < asianRange.low) {
        return {
          allowed: true,
          reason: `${sessionName} open - Asian Low breakout`,
          asianRange,
          sessionInfo
        };
      }
      // No breakout at session open = wait
      return {
        allowed: false,
        reason: `${sessionName} open - waiting for Asian range breakout (H:${asianRange.high.toFixed(4)} L:${asianRange.low.toFixed(4)})`,
        asianRange,
        sessionInfo
      };
    }
  }

  // During regular session hours (not open window) - allow if signal is strong
  return {
    allowed: true,
    reason: `${sessionInfo.session} session`,
    asianRange,
    sessionInfo
  };
};


// ─── SMART MONEY CONCEPTS ENGINE ─────────────────────────────────────────────

// Break of Structure & Change of Character
const calcBOSCHOCH = (candles) => {
  if (!candles || candles.length < 10) return { bos: null, choch: null, bias: null };

  const n = candles.length;
  // Find recent swing highs and lows (last 20 candles)
  const lookback = Math.min(20, n);
  const recent = candles.slice(n - lookback);

  let swingHighs = [];
  let swingLows = [];

  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    // Swing high: higher than 2 candles each side
    if (c.high > recent[i-1].high && c.high > recent[i-2].high &&
        c.high > recent[i+1].high && c.high > recent[i+2].high) {
      swingHighs.push({ price: c.high, idx: i });
    }
    // Swing low: lower than 2 candles each side
    if (c.low < recent[i-1].low && c.low < recent[i-2].low &&
        c.low < recent[i+1].low && c.low < recent[i+2].low) {
      swingLows.push({ price: c.low, idx: i });
    }
  }

  const lastCandle = candles[n - 1];
  const lastClose = lastCandle.close;
  const lastHigh = lastCandle.high;
  const lastLow = lastCandle.low;

  let bos = null;
  let choch = null;

  // BOS Bullish: price breaks above most recent swing high
  if (swingHighs.length > 0) {
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    if (lastClose > lastSwingHigh.price) {
      bos = { type: 'BULLISH', level: lastSwingHigh.price, broken: true };
    }
  }

  // BOS Bearish: price breaks below most recent swing low
  if (swingLows.length > 0) {
    const lastSwingLow = swingLows[swingLows.length - 1];
    if (lastClose < lastSwingLow.price) {
      if (bos && bos.type === 'BULLISH') {
        // Conflicting - most recent takes priority
        choch = { type: 'BEARISH', level: lastSwingLow.price };
        bos = null;
      } else {
        bos = { type: 'BEARISH', level: lastSwingLow.price, broken: true };
      }
    }
  }

  // CHoCH: previous trend broken in opposite direction
  // If we had higher highs/higher lows (uptrend) and now break a swing low = CHoCH BEARISH
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const prevHigh = swingHighs[swingHighs.length - 2];
    const lastHighSH = swingHighs[swingHighs.length - 1];
    const prevLow = swingLows[swingLows.length - 2];
    const lastLowSL = swingLows[swingLows.length - 1];

    const wasUptrend = lastHighSH.price > prevHigh.price && lastLowSL.price > prevLow.price;
    const wasDowntrend = lastHighSH.price < prevHigh.price && lastLowSL.price < prevLow.price;

    if (wasUptrend && lastClose < lastLowSL.price) {
      choch = { type: 'BEARISH', level: lastLowSL.price };
    } else if (wasDowntrend && lastClose > lastHighSH.price) {
      choch = { type: 'BULLISH', level: lastHighSH.price };
    }
  }

  // Overall bias from structure
  let bias = null;
  if (choch) bias = choch.type;
  else if (bos) bias = bos.type;

  return { bos, choch, bias, swingHighs, swingLows };
};

// Order Blocks
const calcOrderBlocks = (candles) => {
  if (!candles || candles.length < 5) return { bullishOB: null, bearishOB: null };

  const n = candles.length;
  let bullishOB = null;
  let bearishOB = null;

  // Look back through last 30 candles
  const lookback = Math.min(30, n - 1);

  for (let i = n - lookback; i < n - 1; i++) {
    const c = candles[i];
    const next = candles[i + 1];
    const isBullishMove = next.close > c.high * 1.001; // strong move up after candle
    const isBearishMove = next.close < c.low * 0.999;  // strong move down after candle

    // Bullish OB: last bearish candle before a strong bullish move
    if (!bullishOB && c.close < c.open && isBullishMove) {
      bullishOB = {
        high: c.high,
        low: c.low,
        mid: (c.high + c.low) / 2,
        idx: i
      };
    }

    // Bearish OB: last bullish candle before a strong bearish move
    if (!bearishOB && c.close > c.open && isBearishMove) {
      bearishOB = {
        high: c.high,
        low: c.low,
        mid: (c.high + c.low) / 2,
        idx: i
      };
    }

    if (bullishOB && bearishOB) break;
  }

  return { bullishOB, bearishOB };
};

// Fair Value Gaps
const calcFVG = (candles) => {
  if (!candles || candles.length < 3) return { bullishFVG: null, bearishFVG: null };

  const n = candles.length;
  let bullishFVG = null;
  let bearishFVG = null;

  // Scan last 20 candles for FVGs
  for (let i = n - 20; i < n - 2; i++) {
    if (i < 0) continue;
    const c1 = candles[i];
    const c3 = candles[i + 2];

    // Bullish FVG: gap between c1 high and c3 low (price moved up fast)
    if (!bullishFVG && c3.low > c1.high) {
      bullishFVG = {
        top: c3.low,
        bottom: c1.high,
        mid: (c3.low + c1.high) / 2,
        idx: i
      };
    }

    // Bearish FVG: gap between c1 low and c3 high (price moved down fast)
    if (!bearishFVG && c3.high < c1.low) {
      bearishFVG = {
        top: c1.low,
        bottom: c3.high,
        mid: (c1.low + c3.high) / 2,
        idx: i
      };
    }

    if (bullishFVG && bearishFVG) break;
  }

  return { bullishFVG, bearishFVG };
};

// SMC Confirmation: checks if current price is in a valid SMC setup
const getSMCConfirmation = (candles, direction) => {
  if (!candles || candles.length < 30) return { confirmed: false, reason: 'Not enough data' };

  const lastPrice = candles[candles.length - 1].close;
  const { bos, choch, bias } = calcBOSCHOCH(candles);
  const { bullishOB, bearishOB } = calcOrderBlocks(candles);
  const { bullishFVG, bearishFVG } = calcFVG(candles);

  let score = 0;
  const reasons = [];

  if (direction === 'LONG') {
    // 1. Structure confirms bullish
    if (bias === 'BULLISH') { score += 3; reasons.push('BOS/CHoCH bullish'); }

    // 2. Price near or inside bullish Order Block
    if (bullishOB) {
      const inOB = lastPrice >= bullishOB.low * 0.999 && lastPrice <= bullishOB.high * 1.001;
      const nearOB = lastPrice >= bullishOB.low * 0.995 && lastPrice <= bullishOB.high * 1.005;
      if (inOB) { score += 3; reasons.push('Price inside bullish OB'); }
      else if (nearOB) { score += 1; reasons.push('Price near bullish OB'); }
    }

    // 3. Bullish FVG present (price may fill it going up)
    if (bullishFVG && lastPrice <= bullishFVG.top * 1.002) {
      score += 2; reasons.push('Bullish FVG present');
    }

    // 4. No bearish CHoCH contradicting
    if (choch && choch.type === 'BEARISH') { score -= 3; reasons.push('CHoCH bearish conflict'); }

  } else if (direction === 'SHORT') {
    // 1. Structure confirms bearish
    if (bias === 'BEARISH') { score += 3; reasons.push('BOS/CHoCH bearish'); }

    // 2. Price near or inside bearish Order Block
    if (bearishOB) {
      const inOB = lastPrice >= bearishOB.low * 0.999 && lastPrice <= bearishOB.high * 1.001;
      const nearOB = lastPrice >= bearishOB.low * 0.995 && lastPrice <= bearishOB.high * 1.005;
      if (inOB) { score += 3; reasons.push('Price inside bearish OB'); }
      else if (nearOB) { score += 1; reasons.push('Price near bearish OB'); }
    }

    // 3. Bearish FVG present
    if (bearishFVG && lastPrice >= bearishFVG.bottom * 0.998) {
      score += 2; reasons.push('Bearish FVG present');
    }

    // 4. No bullish CHoCH contradicting
    if (choch && choch.type === 'BULLISH') { score -= 3; reasons.push('CHoCH bullish conflict'); }
  }

  // SMC confirmed if score >= 3 (at least structure + one other factor)
  const confirmed = score >= 3;

  return {
    confirmed,
    score,
    reasons,
    bias,
    bos,
    choch,
    bullishOB,
    bearishOB,
    bullishFVG,
    bearishFVG
  };
};


// ─── PULLBACK FILTER ─────────────────────────────────────────────────────────
// Prevents entering at the top/bottom of a move - waits for retracement
const hasPullback = (candles, direction) => {
  if (!candles || candles.length < 10) return false;

  const n = candles.length;
  const recent = candles.slice(n - 15); // last 15 candles

  // Find the swing point (highest high for LONG entry, lowest low for SHORT)
  let swingIdx = 0;
  if (direction === 'LONG') {
    // Find recent swing high
    let maxHigh = -Infinity;
    for (let i = 0; i < recent.length - 2; i++) {
      if (recent[i].high > maxHigh) { maxHigh = recent[i].high; swingIdx = i; }
    }
    const swingHigh = maxHigh;
    const swingLow = Math.min(...recent.slice(swingIdx).map(c => c.low));
    const currentClose = recent[recent.length - 1].close;
    const swingRange = swingHigh - swingLow;

    if (swingRange <= 0) return false;

    // Price must have retraced at least 30% from the swing high
    const retracePct = (swingHigh - currentClose) / swingRange;
    return retracePct >= 0.30;
  }

  if (direction === 'SHORT') {
    // Find recent swing low
    let minLow = Infinity;
    for (let i = 0; i < recent.length - 2; i++) {
      if (recent[i].low < minLow) { minLow = recent[i].low; swingIdx = i; }
    }
    const swingLow = minLow;
    const swingHigh = Math.max(...recent.slice(swingIdx).map(c => c.high));
    const currentClose = recent[recent.length - 1].close;
    const swingRange = swingHigh - swingLow;

    if (swingRange <= 0) return false;

    // Price must have retraced at least 30% from the swing low
    const retracePct = (currentClose - swingLow) / swingRange;
    return retracePct >= 0.30;
  }

  return false;
};

// ─── REAL SIGNAL ENGINE (NO MATH.RANDOM) ──────────────────────────────────────
const analyzeStrategies = (prices) => {
  if (!prices || prices.length < 50) return null;

  const rsi  = calcRSI(prices);
  const macd = calcMACD(prices);
  const bb   = calcBollinger(prices);
  const atr  = calcATR(prices);

  // EMAs for trend detection
  const ema9   = calcEMA(prices, 9);
  const ema21  = calcEMA(prices, 21);
  const ema50  = calcEMA(prices, 50);
  const ema200 = prices.length >= 200 ? calcEMA(prices, 200) : null;

  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];

  if (!ema9 || !ema21 || !ema50) return null;

  // ── Primary Trend (EMA200 or EMA50 as fallback) ──
  const trendEMA = ema200 || ema50;
  const bullTrend = last > trendEMA;
  const bearTrend = last < trendEMA;

  // ── Score each indicator (pure math, no random) ──
  const scores = {
    // RSI: oversold = bullish, overbought = bearish
    RSI: rsi < 30 ? 90 : rsi < 40 ? 70 : rsi > 70 ? 10 : rsi > 60 ? 30 : 50,

    // MACD: histogram direction is key signal
    MACD: macd.hist > 0 && macd.macd > macd.signal ? 80
         : macd.hist < 0 && macd.macd < macd.signal ? 20
         : macd.hist > 0 ? 65 : macd.hist < 0 ? 35 : 50,

    // Bollinger: price position relative to bands
    Bollinger: bb.pct < 15 ? 85 : bb.pct < 30 ? 65
             : bb.pct > 85 ? 15 : bb.pct > 70 ? 35 : 50,

    // EMA Cloud: short vs long term trend
    "EMA Cloud": ema9 > ema21 && ema21 > ema50 ? 85
               : ema9 < ema21 && ema21 < ema50 ? 15
               : ema9 > ema21 ? 65 : ema9 < ema21 ? 35 : 50,

    // Trend: primary trend direction (weighted heavily)
    Trend: bullTrend ? 75 : bearTrend ? 25 : 50,

    // Momentum: price vs previous candle + ATR filter
    Momentum: atr ? (
      (last - prev) > atr * 0.5 ? 75 :
      (last - prev) < -atr * 0.5 ? 25 : 50
    ) : (last > prev ? 60 : last < prev ? 40 : 50),
  };

  // Clamp all scores
  Object.keys(scores).forEach(k => {
    scores[k] = Math.min(95, Math.max(5, Math.round(scores[k])));
  });

  const bullCount = Object.values(scores).filter(s => s >= 60).length;
  const bearCount = Object.values(scores).filter(s => s <= 40).length;

  // Step 1: Technical direction (need 4/6)
  let direction = "NEUTRAL";
  if (bullCount >= 4) direction = "LONG";
  else if (bearCount >= 4) direction = "SHORT";

  // Extra confirmation: RSI must not be extreme
  if (direction === "LONG"  && rsi > 75) direction = "NEUTRAL";
  if (direction === "SHORT" && rsi < 25) direction = "NEUTRAL";

  // Anti-chasing filter: reject if move is already extended
  // Check last 3 candles - if all moving same direction, likely late entry
  if (direction !== "NEUTRAL" && prices.length >= 5) {
    const recent = prices.slice(-5);
    const moves = [];
    for (let i = 1; i < recent.length; i++) {
      moves.push(recent[i] - recent[i-1]);
    }
    const allBull = moves.every(m => m > 0);
    const allBear = moves.every(m => m < 0);
    // If 4+ consecutive candles already moved strongly in signal direction = too late
    if (direction === "LONG"  && allBull) direction = "NEUTRAL";
    if (direction === "SHORT" && allBear) direction = "NEUTRAL";
  }

  // Step 2: SMC Confirmation (strictly required)
  let smc = null;
  if (direction !== "NEUTRAL") {
    if (!prices.candles || prices.candles.length < 30) {
      // No candles = no SMC = no trade
      direction = "NEUTRAL";
    } else {
      smc = getSMCConfirmation(prices.candles, direction);
      if (!smc.confirmed) direction = "NEUTRAL";
    }
  }

  // Confidence based on agreement strength + SMC score boost
  const agreementScore = direction === "LONG" ? bullCount : direction === "SHORT" ? bearCount : 0;
  const smcBoost = smc && smc.confirmed ? Math.min(smc.score * 2, 10) : 0;
  const confidence = Math.min(95, Math.max(50, Math.round(50 + agreementScore * 7.5 + smcBoost)));

  // SL/TP based on ATR
  const slMultiplier = 3.0; // 3x ATR for wider, safer SL
  const tpMultiplier = 6.0; // 6x ATR = 1:2 risk/reward with 3x SL
  const slDistance = atr ? atr * slMultiplier : last * 0.005;
  const tpDistance = atr ? atr * tpMultiplier : last * 0.010;

  const stopLoss   = direction === "LONG"  ? last - slDistance : last + slDistance;
  const takeProfit = direction === "LONG"  ? last + tpDistance : last - tpDistance;

  return {
    scores, direction, confidence,
    rsi, macd, bb, atr,
    ema9, ema21, ema50, ema200,
    stopLoss, takeProfit, slDistance, tpDistance,
    bullTrend, bearTrend,
    smc // SMC analysis results
  };
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function TradingBotLive() {
  const [prices,       setPrices]       = useState({ GBPUSD: null, BTCUSDT: null, XAUUSD: null });
  const [prevPrices,   setPrevPrices]   = useState({ GBPUSD: null, BTCUSDT: null, XAUUSD: null });
  // priceHistory removed - brokerCandles is single source of truth
  const [signals,      setSignals]      = useState({});
  const [news,         setNews]         = useState([]);
  // liveTrades removed - using closedTrades and openPositions directly
  const [closedTrades, setClosedTrades] = useState([]); // Closed MT5 trades
  const [openPositions,setOpenPositions]= useState([]); // Current open positions
  const [brokerCandles, setBrokerCandles] = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
  const [sessionInfo, setSessionInfo] = useState(getSessionInfo());
  const [selected,     setSelected]     = useState("BTCUSDT");
  const [activeTab,    setActiveTab]    = useState("signals");
  const [eventAlert,   setEventAlert]   = useState(null);
  const [marketStatus, setMarketStatus] = useState(getMarketStatus());
  const [log,          setLog]          = useState([]);
  const [isAiLoading,  setIsAiLoading]  = useState(false);
  const [aiAnalysis,   setAiAnalysis]   = useState("");
  const [calendarEvents, setCalendarEvents] = useState([]);
  const lastTradeRef = useRef({});
  const logRef       = useRef(null);

  const addLog = useCallback((msg, type = "info") => {
    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;
    setLog(prev => [...prev.slice(-50), { time, msg, type }]);
  }, []);

  // ── Fetch live trades from MetaAPI ──
  const fetchLiveTrades = useCallback(async () => {
    try {
      const r = await fetch("/api/positions");
      if (r.ok) {
        const d = await r.json();
        setOpenPositions(d.positions || []);
      }
    } catch(e) {}
  }, []);

  const fetchClosedTrades = useCallback(async () => {
    try {
      const r = await fetch("/api/history");
      if (r.ok) {
        const d = await r.json();
        setClosedTrades(d.deals || []);
      }
    } catch(e) {}
  }, []);

  // ── Price feeds (all from PU Prime broker via MetaAPI) ──
  useEffect(() => {
    // Instrument to broker symbol mapping
    const symbolMap = { BTCUSDT: 'BTCUSD', XAUUSD: 'XAUUSD.s', GBPUSD: 'GBPUSD' };

    // Fetch broker candles for signal engine
    const fetchBrokerCandles = async (instId) => {
      const symbol = symbolMap[instId];
      try {
        const r = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=M1&limit=200`);
        const d = await r.json();
        if (d.candles && d.candles.length >= 50) {
          setBrokerCandles(prev => ({ ...prev, [instId]: d.candles }));
          // Update price from latest candle close
          const lastClose = d.candles[d.candles.length - 1].close;
          if (Number.isFinite(lastClose)) {
            setPrices(prev => {
              setPrevPrices(pp => ({ ...pp, [instId]: prev[instId] }));
              return { ...prev, [instId]: lastClose };
            });
          }
        } else {
          // Candles unavailable - clear ALL stale data for this instrument
          addLog(`${symbol} candles unavailable - signals cleared`, "warn");
          setPrices(prev => ({ ...prev, [instId]: null }));
          setBrokerCandles(prev => ({ ...prev, [instId]: [] }));
          setSignals(prev => { const n = {...prev}; delete n[instId]; return n; });
        }
      } catch(e) {
        addLog(`${symbol} candles error - signals cleared`, "warn");
        setPrices(prev => ({ ...prev, [instId]: null }));
        setBrokerCandles(prev => ({ ...prev, [instId]: [] }));
        setSignals(prev => { const n = {...prev}; delete n[instId]; return n; });
      }
    };

    // Fetch current broker price for live display
    const fetchBrokerPrice = async (instId) => {
      const symbol = symbolMap[instId];
      try {
        const r = await fetch(`/api/broker-price?symbol=${symbol}`);
        const d = await r.json();
        if (Number.isFinite(d.price)) {
          // Display price only - indicators use candles only
          setPrices(prev => {
            setPrevPrices(pp => ({ ...pp, [instId]: prev[instId] }));
            return { ...prev, [instId]: d.price };
          });
        }
        // else: keep last valid displayed price, don't erase
      } catch(e) {
        // keep previous price on error
      }
    };

    // Initial candle fetch for all instruments
    INSTRUMENTS.forEach(inst => fetchBrokerCandles(inst.id));

    // Live price updates every 5 seconds from broker
    const intervals = INSTRUMENTS.map(inst =>
      setInterval(() => fetchBrokerPrice(inst.id), 5000)
    );

    // Refresh candles every 60 seconds for fresh signal data
    const candleIntervals = INSTRUMENTS.map(inst =>
      setInterval(() => fetchBrokerCandles(inst.id), 60000)
    );

    addLog("Price feeds: PU Prime broker (MetaAPI)", "success");
    addLog("BTC/USDT, GBP/USD, XAU/USD via broker", "info");

    return () => {
      intervals.forEach(clearInterval);
      candleIntervals.forEach(clearInterval);
    };
  }, [addLog]);

  // ── Signal calculation (candles are single source of truth) ──

  useEffect(() => {
    const newSignals = {};
    INSTRUMENTS.forEach(inst => {
      const candles = brokerCandles[inst.id];
      // Need at least 50 candles for indicators
      if (!candles || candles.length < 50) return;
      const closes = candles.map(c => c.close);
      // Attach full candles for SMC
      closes.candles = candles;
      const sig = analyzeStrategies(closes);
      if (sig) newSignals[inst.id] = sig;
    });
    setSignals(newSignals); // always update - clears stale signals when instruments fail
  }, [brokerCandles]);

  // ── Market status ──
  useEffect(() => {
    const interval = setInterval(() => {
      setMarketStatus(getMarketStatus());
      setSessionInfo(getSessionInfo());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // ── News feed ──
  useEffect(() => {
    const fetchNews = async () => {
      try {
        const r = await fetch("/api/news");
        const d = await r.json();
        if (d.articles) setNews(d.articles);
      } catch(e) {}
    };
    fetchNews();
    const interval = setInterval(fetchNews, 300000);
    return () => clearInterval(interval);
  }, []);

  // ── Economic calendar ──
  useEffect(() => {
    const fetchCalendar = async () => {
      try {
        const r = await fetch("/api/calendar");
        const d = await r.json();

        // If calendar is unavailable, pause trading by default (safer)
        if (d.source === 'unavailable' || !Array.isArray(d.events)) {
          addLog("Calendar unavailable - trading paused for safety", "warn");
          setEventAlert({ name: "Calendar unavailable", date: null });
          return;
        }

        setCalendarEvents(d.events);

        // Check for events within next 30 min
        const now = Date.now();
        const upcoming = d.events.find(ev => {
          const evTime = new Date(ev.date).getTime();
          return evTime > now && evTime < now + 30 * 60 * 1000;
        });
        setEventAlert(upcoming || null);
      } catch(e) {
        addLog("Calendar fetch error - trading paused for safety", "warn");
        setEventAlert({ name: "Calendar error", date: null });
      }
    };
    fetchCalendar();
    const interval = setInterval(fetchCalendar, 300000);
    return () => clearInterval(interval);
  }, []);

  // ── Fetch live trades periodically ──
  useEffect(() => {
    fetchLiveTrades();
    fetchClosedTrades();
    const interval = setInterval(() => {
      fetchLiveTrades();
      fetchClosedTrades();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchLiveTrades, fetchClosedTrades]);

  // ── Log scroll ──
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const pendingTradeRef = useRef({});
  const lastEventTimeRef = useRef(0);
  const lastBlockLogRef = useRef({});

  // Throttle block warning logs - max once per minute per key
  const shouldLogBlock = useCallback((key, cooldownMs = 60000) => {
    const now = Date.now();
    if (!lastBlockLogRef.current[key] || now - lastBlockLogRef.current[key] > cooldownMs) {
      lastBlockLogRef.current[key] = now;
      return true;
    }
    return false;
  }, []);

  // Track actual event timestamp for post-event blackout
  useEffect(() => {
    if (eventAlert?.date) {
      lastEventTimeRef.current = new Date(eventAlert.date).getTime();
    }
  }, [eventAlert]);

  // ── LIVE TRADE EXECUTION (real signals only) ──
  useEffect(() => {
    INSTRUMENTS.forEach(inst => {
      const sig = signals[inst.id];
      if (!sig || sig.direction === "NEUTRAL" || sig.confidence < 78) return;

      // Block if event is genuinely within next 30 min
      const nowTs = Date.now();
      const eventTs = eventAlert?.date ? new Date(eventAlert.date).getTime() : 0;
      if (eventTs > nowTs && eventTs < nowTs + 30 * 60 * 1000) {
        if (shouldLogBlock(`${inst.id}-event`)) addLog(`Trade blocked: ${eventAlert.name} imminent`, "warn");
        return;
      }

      // Block 30 min AFTER event ends
      const lastEvTs = lastEventTimeRef.current;
      if (lastEvTs > 0 && nowTs >= lastEvTs && nowTs < lastEvTs + 30 * 60 * 1000) {
        if (shouldLogBlock(`${inst.id}-postevent`)) addLog("Trade blocked: post-event cooldown", "warn");
        return;
      }

      // Block near market close
      if (isNearMarketClose() && inst.type !== "CRYPTO") {
        if (shouldLogBlock(`${inst.id}-close`)) addLog("Trade blocked: near market close", "warn");
        return;
      }

      // Session filter - London and NY opens preferred
      let sessionFilter = null;
      if (inst.type !== "CRYPTO") {
        sessionFilter = getSessionFilter(
          brokerCandles[inst.id],
          sig.direction,
          prices[inst.id]
        );
        if (!sessionFilter.allowed) {
          if (shouldLogBlock(`${inst.id}-session`)) {
            addLog(`Session filter: ${sessionFilter.reason}`, "warn");
          }
          return;
        }
      }

      // Check market hours
      const mStatus = marketStatus[inst.id];
      if (!mStatus?.open && inst.type !== "CRYPTO") return;

      // Cooldown: max 1 trade per instrument per 5 minutes
      const now = Date.now();
      if (lastTradeRef.current[inst.id] && (now - lastTradeRef.current[inst.id]) < 300000) return;

      // Pending lock - prevent duplicate execution
      if (pendingTradeRef.current[inst.id]) return;

      // Symbol normalization - handle broker suffixes like BTCUSDm, XAUUSD.
      const alreadyOpen = openPositions.some(p => {
        const raw = (p.symbol || "").toUpperCase();
        const normalized =
          raw === "XAUUSD.S" ? "XAUUSD" :
          raw.startsWith("BTCUSD") ? "BTCUSD" :
          raw.startsWith("GBPUSD") ? "GBPUSD" :
          raw.startsWith("XAUUSD") ? "XAUUSD" :
          raw;
        const targetSym =
          inst.id === "BTCUSDT" ? "BTCUSD" :
          inst.id === "XAUUSD"  ? "XAUUSD" :
          inst.id;
        return normalized === targetSym;
      });
      if (alreadyOpen) return;

      // Max 2 total open positions
      if (openPositions.length >= 2) return;

      // Require valid SL/TP
      if (!Number.isFinite(sig.stopLoss) || !Number.isFinite(sig.takeProfit)) { addLog("Trade blocked: missing SL/TP", "warn"); return; }

      // Pullback filter - don't chase the trend
      const candles = brokerCandles[inst.id];
      if (candles && candles.length >= 10) {
        const pullback = hasPullback(candles, sig.direction);
        if (!pullback) {
          if (shouldLogBlock(`${inst.id}-pullback`)) {
            addLog(`${inst.label}: waiting for pullback before entry`, "warn");
          }
          return;
        }
      }

      // Lock this instrument
      pendingTradeRef.current[inst.id] = true;

      addLog(`Session: ${sessionFilter ? sessionFilter.reason : "crypto"} | Signal: ${inst.label} ${sig.direction} ${sig.confidence}% | RSI:${sig.rsi?.toFixed(1)} | SL:${sig.stopLoss?.toFixed(inst.id==="BTCUSDT"?0:4)} TP:${sig.takeProfit?.toFixed(inst.id==="BTCUSDT"?0:4)}`, "signal");

      fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: inst.id,
          direction: sig.direction,
          entry: prices[inst.id],
          stopLoss: sig.stopLoss,
          takeProfit: sig.takeProfit,
        })
      })
      .then(r => r.json())
      .then(d => {
        pendingTradeRef.current[inst.id] = false;
        if (d.success) {
          lastTradeRef.current[inst.id] = now; // set cooldown ONLY on success
          addLog(`✅ Trade executed: ${inst.label} ${sig.direction} ${d.volume || "?"} lots @ ${prices[inst.id]}`, "success");

          // Refresh positions and history from broker (source of truth)
          setTimeout(fetchLiveTrades, 2000);
          setTimeout(fetchClosedTrades, 3000);
        } else {
          addLog(`❌ Execution failed: ${d.error || "unknown"}`, "error");
        }
      })
      .catch(e => {
        pendingTradeRef.current[inst.id] = false;
        addLog(`❌ Execute error: ${e.message}`, "error");
      });
    });
  }, [signals, prices, brokerCandles, eventAlert, marketStatus, openPositions, addLog, fetchLiveTrades, fetchClosedTrades, shouldLogBlock]);

  // ── AI Analysis ──
  const runAI = async () => {
    setIsAiLoading(true);
    setAiAnalysis("");
    const sig  = signals[selected] || {};
    const inst = INSTRUMENTS.find(i => i.id === selected);
    const prompt = `You are a professional quant trader. Analyze this market data and give a concise trade recommendation.

Instrument: ${inst?.label}
Current Price: ${prices[selected]}
Signal: ${sig.direction} (${sig.confidence}% confidence)
RSI: ${sig.rsi?.toFixed(1)}
MACD Histogram: ${sig.macd?.hist?.toFixed(6)}
Bollinger %B: ${sig.bb?.pct?.toFixed(1)}%
EMA9: ${sig.ema9?.toFixed(4)} | EMA21: ${sig.ema21?.toFixed(4)} | EMA50: ${sig.ema50?.toFixed(4)}
Bull trend: ${sig.bullTrend} | Bear trend: ${sig.bearTrend}
ATR: ${sig.atr?.toFixed(4)}
Suggested SL: ${sig.stopLoss?.toFixed(4)} | TP: ${sig.takeProfit?.toFixed(4)}
Open positions: ${openPositions.length}
News sentiment: ${news.slice(0,3).map(n=>n.title).join(" | ")}

Provide: 1) Market regime 2) Signal quality (A/B/C/D) 3) Risk assessment 4) Final recommendation. Be direct and specific.`;

    try {
      const r = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });
      const d = await r.json();
      setAiAnalysis(d.analysis || "No response");
    } catch(e) {
      setAiAnalysis("AI analysis error");
    }
    setIsAiLoading(false);
  };

  // ── Helpers ──
  const fmt = (id, p) => p ? (id === "BTCUSDT" ? p.toLocaleString("en", { maximumFractionDigits: 0 }) : p.toFixed(id === "GBPUSD" ? 4 : 2)) : "—";
  const priceDelta = (id) => {
    if (!prices[id] || !prevPrices[id]) return null;
    return prices[id] - prevPrices[id];
  };
  const sig = signals[selected] || {};
  const inst = INSTRUMENTS.find(i => i.id === selected);
  const mStatus = marketStatus[selected];

  // Compute event visibility once - used by both banner and header
  const nowTs = Date.now();
  const eventTs = eventAlert?.date ? new Date(eventAlert.date).getTime() : 0;
  const showEventBanner = !!eventAlert && (
    !eventTs ||
    (eventTs > nowTs && eventTs < nowTs + 30 * 60 * 1000) ||
    (eventTs > 0 && nowTs >= eventTs && nowTs < eventTs + 30 * 60 * 1000)
  );

  // ── Stats from closed trades ──
  const wins = closedTrades.filter(t => t.profit > 0).length;
  const totalPnl = closedTrades.reduce((a, t) => a + (t.profit || 0), 0);
  const winRate = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : "0.0";

  const styles = {
    app: { background: "#0a0a0f", color: "#e0e0e0", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", minHeight: "100vh", fontSize: "12px" },
    header: { background: "linear-gradient(135deg, #0d1117 0%, #161b22 100%)", borderBottom: "1px solid #21262d", padding: "12px 20px", display: "flex", alignItems: "center", gap: "20px", flexWrap: "wrap" },
    statBox: { display: "flex", flexDirection: "column", gap: "2px" },
    statLabel: { color: "#8b949e", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px" },
    statValue: { fontWeight: "700", fontSize: "14px" },
    body: { display: "flex", height: "calc(100vh - 60px)" },
    sidebar: { width: "200px", background: "#0d1117", borderRight: "1px solid #21262d", padding: "12px", display: "flex", flexDirection: "column", gap: "8px", overflowY: "auto" },
    instCard: (id) => ({ padding: "10px", borderRadius: "6px", cursor: "pointer", border: selected === id ? `1px solid ${INSTRUMENTS.find(i=>i.id===id)?.color}` : "1px solid #21262d", background: selected === id ? "rgba(255,255,255,0.05)" : "transparent", transition: "all 0.2s" }),
    main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
    tabs: { display: "flex", borderBottom: "1px solid #21262d", background: "#0d1117" },
    tab: (active) => ({ padding: "10px 16px", cursor: "pointer", borderBottom: active ? "2px solid #58a6ff" : "2px solid transparent", color: active ? "#58a6ff" : "#8b949e", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px", transition: "all 0.2s" }),
    content: { flex: 1, padding: "16px", overflowY: "auto" },
    card: { background: "#0d1117", border: "1px solid #21262d", borderRadius: "8px", padding: "16px", marginBottom: "12px" },
    logPanel: { width: "280px", background: "#0d1117", borderLeft: "1px solid #21262d", display: "flex", flexDirection: "column" },
    logHeader: { padding: "10px 12px", borderBottom: "1px solid #21262d", color: "#8b949e", fontSize: "10px", textTransform: "uppercase" },
    logBody: { flex: 1, overflowY: "auto", padding: "8px" },
    logEntry: (type) => ({ padding: "3px 6px", marginBottom: "2px", borderRadius: "3px", fontSize: "10px", color: type === "signal" ? "#3fb950" : type === "error" ? "#f85149" : type === "warn" ? "#e3b341" : type === "success" ? "#3fb950" : "#8b949e" }),
    badge: (dir) => ({ padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", background: dir === "LONG" ? "rgba(63,185,80,0.15)" : dir === "SHORT" ? "rgba(248,81,73,0.15)" : "rgba(139,148,158,0.15)", color: dir === "LONG" ? "#3fb950" : dir === "SHORT" ? "#f85149" : "#8b949e", border: `1px solid ${dir === "LONG" ? "#3fb950" : dir === "SHORT" ? "#f85149" : "#8b949e"}40` }),
    scoreBar: (score) => ({ height: "6px", borderRadius: "3px", background: score >= 60 ? "#3fb950" : score <= 40 ? "#f85149" : "#e3b341", width: `${score}%`, transition: "width 0.5s" }),
    tradeRow: { display: "grid", gridTemplateColumns: "80px 70px 60px 90px 80px 80px", gap: "8px", padding: "8px", borderBottom: "1px solid #21262d", fontSize: "11px", alignItems: "center" },
    positionCard: { background: "#161b22", border: "1px solid #30363d", borderRadius: "6px", padding: "12px", marginBottom: "8px" },
    alertBanner: { background: "rgba(227,179,65,0.15)", border: "1px solid #e3b341", borderRadius: "6px", padding: "10px 16px", marginBottom: "12px", color: "#e3b341", display: "flex", alignItems: "center", gap: "8px" },
  };

  return (
    <div style={styles.app}>
      {/* HEADER */}
      <div style={styles.header}>
        <div style={{ color: "#58a6ff", fontWeight: "900", fontSize: "16px", letterSpacing: "2px" }}>
          ● QUANTUM BOT
        </div>
        <div style={styles.statBox}>
          <span style={styles.statLabel}>Win Rate</span>
          <span style={{ ...styles.statValue, color: "#3fb950" }}>{winRate}%</span>
        </div>
        <div style={styles.statBox}>
          <span style={styles.statLabel}>Closed Trades</span>
          <span style={{ ...styles.statValue, color: "#58a6ff" }}>{closedTrades.length}</span>
        </div>
        <div style={styles.statBox}>
          <span style={styles.statLabel}>Net P&L</span>
          <span style={{ ...styles.statValue, color: totalPnl >= 0 ? "#3fb950" : "#f85149" }}>${totalPnl.toFixed(2)}</span>
        </div>
        <div style={styles.statBox}>
          <span style={styles.statLabel}>Open Positions</span>
          <span style={{ ...styles.statValue, color: "#e3b341" }}>{openPositions.length}</span>
        </div>
        <div style={styles.statBox}>
          <span style={styles.statLabel}>BTC</span>
          <span style={{ ...styles.statValue, color: "#F7931A" }}>${fmt("BTCUSDT", prices.BTCUSDT)}</span>
        </div>
        <div style={styles.statBox}>
          <span style={styles.statLabel}>Gold</span>
          <span style={{ ...styles.statValue, color: "#FFD700" }}>${fmt("XAUUSD", prices.XAUUSD)}</span>
        </div>
        <div style={styles.statBox}>
          <span style={styles.statLabel}>GBP/USD</span>
          <span style={{ ...styles.statValue, color: "#00D4AA" }}>{fmt("GBPUSD", prices.GBPUSD)}</span>
        </div>
        <div style={{ marginLeft: "auto", color: "#e3b341", fontSize: "11px" }}>
          {sessionInfo.session} {showEventBanner && `⚠️ ${eventAlert.name}`}
        </div>
      </div>

      <div style={styles.body}>
        {/* SIDEBAR */}
        <div style={styles.sidebar}>
          {INSTRUMENTS.map(i => {
            const s = signals[i.id];
            const delta = priceDelta(i.id);
            return (
              <div key={i.id} style={styles.instCard(i.id)} onClick={() => setSelected(i.id)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <span style={{ color: i.color, fontWeight: "700", fontSize: "11px" }}>{i.icon} {i.label}</span>
                  <span style={{ fontSize: "9px", color: "#8b949e" }}>{i.type}</span>
                </div>
                <div style={{ fontSize: "13px", fontWeight: "700", marginBottom: "4px" }}>
                  {fmt(i.id, prices[i.id])}
                  {delta !== null && <span style={{ fontSize: "10px", color: delta >= 0 ? "#3fb950" : "#f85149", marginLeft: "4px" }}>{delta >= 0 ? "▲" : "▼"}</span>}
                </div>
                {s && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={styles.badge(s.direction)}>{s.direction}</span>
                    <span style={{ color: "#8b949e", fontSize: "10px" }}>{s.confidence}%</span>
                  </div>
                )}
                {!s && <div style={{ color: "#8b949e", fontSize: "10px" }}>Loading {brokerCandles[i.id]?.length || 0}/50</div>}
                <div style={{ marginTop: "4px", fontSize: "9px", color: marketStatus[i.id]?.open ? "#3fb950" : "#f85149" }}>
                  {marketStatus[i.id]?.open ? "● OPEN" : "● CLOSED"}
                </div>
              </div>
            );
          })}

          <div style={{ marginTop: "8px", padding: "8px", background: "#161b22", borderRadius: "6px", fontSize: "10px" }}>
            <div style={{ color: "#8b949e", marginBottom: "4px" }}>OPEN POSITIONS</div>
            {openPositions.length === 0 ? (
              <div style={{ color: "#8b949e" }}>No open trades</div>
            ) : openPositions.map((p, i) => (
              <div key={i} style={{ marginBottom: "4px", color: p.profit >= 0 ? "#3fb950" : "#f85149" }}>
                {p.symbol} {p.type} {p.volume} | {p.profit?.toFixed(2)}€
              </div>
            ))}
          </div>
        </div>

        {/* MAIN */}
        <div style={styles.main}>
          <div style={styles.tabs}>
            {["signals", "live trades", "ai analysis", "news", "calendar"].map(tab => (
              <div key={tab} style={styles.tab(activeTab === tab)} onClick={() => setActiveTab(tab)}>
                {tab.toUpperCase()}
              </div>
            ))}
          </div>

          <div style={styles.content}>
            {/* Event Alert */}
            {showEventBanner && (
              <div style={styles.alertBanner}>
                ⚠️ <strong>{eventAlert.name}</strong> — Signals paused. Trading resumes 30 min after event.
              </div>
            )}

            {/* SIGNALS TAB */}
            {activeTab === "signals" && (
              <div>
                <div style={{ ...styles.card, marginBottom: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <div>
                      <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "4px" }}>COMPOSITE SIGNAL — {inst?.label}</div>
                      <div style={{ fontSize: "28px", fontWeight: "900", color: sig.direction === "LONG" ? "#3fb950" : sig.direction === "SHORT" ? "#f85149" : "#8b949e" }}>
                        {sig.direction || "LOADING..."}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: "#8b949e", fontSize: "10px" }}>CONFIDENCE</div>
                      <div style={{ fontSize: "24px", fontWeight: "700", color: (sig.confidence || 0) >= 78 ? "#3fb950" : "#e3b341" }}>{sig.confidence || "—"}%</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: "#8b949e", fontSize: "10px" }}>RSI</div>
                      <div style={{ fontSize: "20px", fontWeight: "700", color: (sig.rsi || 50) < 30 ? "#3fb950" : (sig.rsi || 50) > 70 ? "#f85149" : "#e0e0e0" }}>{sig.rsi?.toFixed(1) || "—"}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: "#8b949e", fontSize: "10px" }}>TREND</div>
                      <div style={{ fontSize: "14px", fontWeight: "700", color: sig.bullTrend ? "#3fb950" : sig.bearTrend ? "#f85149" : "#8b949e" }}>
                        {sig.bullTrend ? "▲ BULL" : sig.bearTrend ? "▼ BEAR" : "NEUTRAL"}
                      </div>
                    </div>
                  </div>

                  {/* SL/TP display */}
                  {sig.direction && sig.direction !== "NEUTRAL" && (
                    <div style={{ display: "flex", gap: "16px", padding: "10px", background: "#161b22", borderRadius: "6px", marginBottom: "12px" }}>
                      <div><span style={{ color: "#8b949e", fontSize: "10px" }}>ENTRY </span><span style={{ color: "#58a6ff", fontWeight: "700" }}>{fmt(selected, prices[selected])}</span></div>
                      <div><span style={{ color: "#8b949e", fontSize: "10px" }}>STOP LOSS </span><span style={{ color: "#f85149", fontWeight: "700" }}>{fmt(selected, sig.stopLoss)}</span></div>
                      <div><span style={{ color: "#8b949e", fontSize: "10px" }}>TAKE PROFIT </span><span style={{ color: "#3fb950", fontWeight: "700" }}>{fmt(selected, sig.takeProfit)}</span></div>
                      <div><span style={{ color: "#8b949e", fontSize: "10px" }}>ATR </span><span style={{ color: "#e3b341", fontWeight: "700" }}>{sig.atr?.toFixed(selected === "BTCUSDT" ? 0 : 4)}</span></div>
                    </div>
                  )}
                </div>

                {/* Strategy scores */}
                <div style={styles.card}>
                  <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "12px", textTransform: "uppercase" }}>Strategy Scores (Real Indicators)</div>
                  {sig.scores && Object.entries(sig.scores).map(([name, score]) => (
                    <div key={name} style={{ marginBottom: "8px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
                        <span style={{ color: "#c9d1d9", fontSize: "11px" }}>{name}</span>
                        <span style={{ color: score >= 60 ? "#3fb950" : score <= 40 ? "#f85149" : "#e3b341", fontSize: "11px", fontWeight: "700" }}>{score}</span>
                      </div>
                      <div style={{ background: "#21262d", borderRadius: "3px", height: "6px" }}>
                        <div style={styles.scoreBar(score)} />
                      </div>
                    </div>
                  ))}
                  {!sig.scores && (
                    <div style={{ color: "#8b949e" }}>
                      Collecting price data... {brokerCandles[selected]?.length || 0}/50 points
                    </div>
                  )}
                {sig.scores && sig.direction === "NEUTRAL" && sig.smc && !sig.smc.confirmed && (
                  <div style={{ color: "#e3b341", marginTop: "8px", fontSize: "11px", padding: "8px", background: "rgba(227,179,65,0.1)", borderRadius: "4px" }}>
                    ⚠️ Signal filtered by Smart Money Concepts — no valid OB, FVG or structure confirmation.
                  </div>
                )}
                {sig.direction === "NEUTRAL" && (
                  <div style={{ color: "#8b949e", fontSize: "11px", marginTop: "8px" }}>
                    No trade setup currently meets all filters.
                  </div>
                )}
                </div>

                {/* EMA levels */}
                {sig.ema9 && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "8px" }}>EMA LEVELS</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px" }}>
                      {[["EMA 9", sig.ema9], ["EMA 21", sig.ema21], ["EMA 50", sig.ema50], ["EMA 200", sig.ema200]].map(([label, val]) => (
                        <div key={label} style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                          <div style={{ color: "#8b949e", fontSize: "9px" }}>{label}</div>
                          <div style={{ fontWeight: "700", fontSize: "12px" }}>{val ? fmt(selected, val) : "—"}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Session Info */}
                <div style={styles.card}>
                  <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "8px" }}>SESSION TACTICS</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                    <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                      <div style={{ color: "#8b949e", fontSize: "9px" }}>CURRENT SESSION</div>
                      <div style={{ fontWeight: "700", color: sessionInfo.isOverlap ? "#f7931a" : sessionInfo.isLondon || sessionInfo.isNY ? "#3fb950" : "#8b949e", fontSize: "11px" }}>
                        {sessionInfo.session}
                      </div>
                    </div>
                    <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                      <div style={{ color: "#8b949e", fontSize: "9px" }}>LONDON OPEN</div>
                      <div style={{ fontWeight: "700", color: sessionInfo.isLondonOpen ? "#3fb950" : "#8b949e" }}>
                        {sessionInfo.isLondonOpen ? "✅ ACTIVE" : "08:00 UTC"}
                      </div>
                    </div>
                    <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                      <div style={{ color: "#8b949e", fontSize: "9px" }}>NY OPEN</div>
                      <div style={{ fontWeight: "700", color: sessionInfo.isNYOpen ? "#3fb950" : "#8b949e" }}>
                        {sessionInfo.isNYOpen ? "✅ ACTIVE" : "13:00 UTC"}
                      </div>
                    </div>
                  </div>
                </div>

                {/* SMC Analysis */}
                {sig.smc && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "12px", textTransform: "uppercase" }}>
                      Smart Money Concepts
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "10px" }}>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                        <div style={{ color: "#8b949e", fontSize: "9px" }}>STRUCTURE BIAS</div>
                        <div style={{ fontWeight: "700", color: sig.smc.bias === "BULLISH" ? "#3fb950" : sig.smc.bias === "BEARISH" ? "#f85149" : "#8b949e" }}>
                          {sig.smc.bias || "NEUTRAL"}
                        </div>
                      </div>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                        <div style={{ color: "#8b949e", fontSize: "9px" }}>SMC CONFIRMED</div>
                        <div style={{ fontWeight: "700", color: sig.smc.confirmed ? "#3fb950" : "#f85149" }}>
                          {sig.smc.confirmed ? "✅ YES" : "❌ NO"}
                        </div>
                      </div>
                      {sig.smc.bos && (
                        <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                          <div style={{ color: "#8b949e", fontSize: "9px" }}>BOS</div>
                          <div style={{ fontWeight: "700", color: sig.smc.bos.type === "BULLISH" ? "#3fb950" : "#f85149" }}>
                            {sig.smc.bos.type} @ {fmt(selected, sig.smc.bos.level)}
                          </div>
                        </div>
                      )}
                      {sig.smc.choch && (
                        <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                          <div style={{ color: "#8b949e", fontSize: "9px" }}>CHoCH</div>
                          <div style={{ fontWeight: "700", color: sig.smc.choch.type === "BULLISH" ? "#3fb950" : "#f85149" }}>
                            {sig.smc.choch.type} @ {fmt(selected, sig.smc.choch.level)}
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Order Blocks */}
                    <div style={{ marginBottom: "8px" }}>
                      <div style={{ color: "#8b949e", fontSize: "9px", marginBottom: "4px" }}>ORDER BLOCKS</div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        {sig.smc.bullishOB && (
                          <div style={{ background: "rgba(63,185,80,0.1)", border: "1px solid #3fb95040", padding: "6px 10px", borderRadius: "4px", fontSize: "10px" }}>
                            <span style={{ color: "#3fb950" }}>Bull OB </span>
                            <span>{fmt(selected, sig.smc.bullishOB.low)} – {fmt(selected, sig.smc.bullishOB.high)}</span>
                          </div>
                        )}
                        {sig.smc.bearishOB && (
                          <div style={{ background: "rgba(248,81,73,0.1)", border: "1px solid #f8514940", padding: "6px 10px", borderRadius: "4px", fontSize: "10px" }}>
                            <span style={{ color: "#f85149" }}>Bear OB </span>
                            <span>{fmt(selected, sig.smc.bearishOB.low)} – {fmt(selected, sig.smc.bearishOB.high)}</span>
                          </div>
                        )}
                        {!sig.smc.bullishOB && !sig.smc.bearishOB && (
                          <span style={{ color: "#8b949e", fontSize: "10px" }}>No order blocks detected</span>
                        )}
                      </div>
                    </div>
                    {/* Fair Value Gaps */}
                    <div>
                      <div style={{ color: "#8b949e", fontSize: "9px", marginBottom: "4px" }}>FAIR VALUE GAPS</div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        {sig.smc.bullishFVG && (
                          <div style={{ background: "rgba(63,185,80,0.1)", border: "1px solid #3fb95040", padding: "6px 10px", borderRadius: "4px", fontSize: "10px" }}>
                            <span style={{ color: "#3fb950" }}>Bull FVG </span>
                            <span>{fmt(selected, sig.smc.bullishFVG.bottom)} – {fmt(selected, sig.smc.bullishFVG.top)}</span>
                          </div>
                        )}
                        {sig.smc.bearishFVG && (
                          <div style={{ background: "rgba(248,81,73,0.1)", border: "1px solid #f8514940", padding: "6px 10px", borderRadius: "4px", fontSize: "10px" }}>
                            <span style={{ color: "#f85149" }}>Bear FVG </span>
                            <span>{fmt(selected, sig.smc.bearishFVG.bottom)} – {fmt(selected, sig.smc.bearishFVG.top)}</span>
                          </div>
                        )}
                        {!sig.smc.bullishFVG && !sig.smc.bearishFVG && (
                          <span style={{ color: "#8b949e", fontSize: "10px" }}>No FVGs detected</span>
                        )}
                      </div>
                    </div>
                    {/* SMC reasons */}
                    {sig.smc.reasons && sig.smc.reasons.length > 0 && (
                      <div style={{ marginTop: "8px", padding: "8px", background: "#161b22", borderRadius: "4px" }}>
                        <div style={{ color: "#8b949e", fontSize: "9px", marginBottom: "4px" }}>CONFIRMATIONS</div>
                        {sig.smc.reasons.map((r, i) => (
                          <div key={i} style={{ color: "#c9d1d9", fontSize: "10px", marginBottom: "2px" }}>• {r}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* LIVE TRADES TAB */}
            {activeTab === "live trades" && (
              <div>
                {/* Open positions */}
                <div style={styles.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <div style={{ color: "#8b949e", fontSize: "10px", textTransform: "uppercase" }}>Open Positions ({openPositions.length})</div>
                    <button onClick={fetchLiveTrades} style={{ background: "#21262d", border: "1px solid #30363d", color: "#c9d1d9", padding: "4px 10px", borderRadius: "4px", cursor: "pointer", fontSize: "10px" }}>Refresh</button>
                  </div>
                  {openPositions.length === 0 ? (
                    <div style={{ color: "#8b949e", textAlign: "center", padding: "20px" }}>No open positions</div>
                  ) : openPositions.map((pos, i) => (
                    <div key={i} style={styles.positionCard}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <span style={{ fontWeight: "700", color: "#58a6ff" }}>{pos.symbol}</span>
                          <span style={{ margin: "0 8px", color: pos.type === "POSITION_TYPE_BUY" ? "#3fb950" : "#f85149", fontWeight: "700" }}>{pos.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL"}</span>
                          <span style={{ color: "#8b949e" }}>{pos.volume} lots</span>
                        </div>
                        <span style={{ fontWeight: "700", color: (pos.profit || 0) >= 0 ? "#3fb950" : "#f85149", fontSize: "14px" }}>
                          {(pos.profit || 0) >= 0 ? "+" : ""}{(pos.profit || 0).toFixed(2)}€
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "16px", marginTop: "6px", fontSize: "10px", color: "#8b949e" }}>
                        <span>Entry: {pos.openPrice}</span>
                        <span>Current: {pos.currentPrice}</span>
                        {pos.stopLoss && <span style={{ color: "#f85149" }}>SL: {pos.stopLoss}</span>}
                        {pos.takeProfit && <span style={{ color: "#3fb950" }}>TP: {pos.takeProfit}</span>}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Trade history stats */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                  {[
                    ["Win Rate", `${winRate}%`, "#3fb950"],
                    ["Total Trades", closedTrades.length, "#58a6ff"],
                    ["Net P&L", `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}€`, totalPnl >= 0 ? "#3fb950" : "#f85149"],
                    ["Wins", wins, "#3fb950"],
                  ].map(([label, value, color]) => (
                    <div key={label} style={{ ...styles.card, marginBottom: 0, textAlign: "center" }}>
                      <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "4px" }}>{label}</div>
                      <div style={{ fontWeight: "700", fontSize: "18px", color }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Closed trades */}
                <div style={styles.card}>
                  <div style={{ color: "#8b949e", fontSize: "10px", textTransform: "uppercase", marginBottom: "12px" }}>
                    Trade History ({closedTrades.length} trades)
                  </div>
                  <div style={{ ...styles.tradeRow, color: "#8b949e", fontSize: "10px", borderBottom: "1px solid #30363d" }}>
                    <span>SYMBOL</span><span>TYPE</span><span>LOTS</span><span>OPEN</span><span>CLOSE</span><span>P&L</span>
                  </div>
                  {closedTrades.length === 0 ? (
                    <div style={{ color: "#8b949e", textAlign: "center", padding: "20px" }}>No closed trades yet</div>
                  ) : closedTrades.slice(0, 50).map((t, i) => (
                    <div key={i} style={styles.tradeRow}>
                      <span style={{ color: "#58a6ff", fontWeight: "700" }}>{t.symbol}</span>
                      <span style={{ color: t.type === "BUY" ? "#3fb950" : "#f85149" }}>{t.type}</span>
                      <span>{t.volume}</span>
                      <span style={{ color: "#8b949e" }}>{t.openPrice ?? "—"}</span>
                      <span>{t.closePrice ?? "—"}</span>
                      <span style={{ fontWeight: "700", color: (t.profit || 0) >= 0 ? "#3fb950" : "#f85149" }}>
                        {(t.profit || 0) >= 0 ? "+" : ""}{(t.profit || 0).toFixed(2)}€
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* AI ANALYSIS TAB */}
            {activeTab === "ai analysis" && (
              <div style={styles.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                  <div style={{ color: "#8b949e", fontSize: "10px" }}>AI DEEP ANALYSIS — {inst?.label}</div>
                  <button onClick={runAI} disabled={isAiLoading} style={{ background: isAiLoading ? "#21262d" : "#1f6feb", border: "none", color: "#fff", padding: "6px 14px", borderRadius: "6px", cursor: isAiLoading ? "not-allowed" : "pointer", fontSize: "11px", fontWeight: "700" }}>
                    {isAiLoading ? "ANALYZING..." : "RUN AI ANALYSIS"}
                  </button>
                </div>
                {aiAnalysis ? (
                  <div style={{ lineHeight: "1.6", color: "#c9d1d9", fontSize: "13px", whiteSpace: "pre-wrap" }}>{aiAnalysis}</div>
                ) : (
                  <div style={{ color: "#8b949e", textAlign: "center", padding: "40px" }}>Click "Run AI Analysis" for a deep market read powered by Claude</div>
                )}
              </div>
            )}

            {/* NEWS TAB */}
            {activeTab === "news" && (
              <div>
                {news.length === 0 ? (
                  <div style={{ ...styles.card, color: "#8b949e", textAlign: "center" }}>Loading news...</div>
                ) : news.map((article, i) => (
                  <div key={i} style={{ ...styles.card, marginBottom: "8px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: "#c9d1d9", fontWeight: "600", marginBottom: "4px", fontSize: "12px" }}>{article.title}</div>
                        <div style={{ color: "#8b949e", fontSize: "10px" }}>{article.source} · {article.inst}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* CALENDAR TAB */}
            {activeTab === "calendar" && (
              <div>
                {calendarEvents.length === 0 ? (
                  <div style={{ ...styles.card, color: "#8b949e", textAlign: "center" }}>Loading calendar...</div>
                ) : calendarEvents.map((ev, i) => {
                  const evDate = new Date(ev.date);
                  const isToday = evDate.toDateString() === new Date().toDateString();
                  return (
                    <div key={i} style={{ ...styles.card, marginBottom: "8px", borderLeft: `3px solid ${isToday ? "#f85149" : "#21262d"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ fontWeight: "700", color: isToday ? "#f85149" : "#c9d1d9", marginBottom: "4px" }}>{ev.name}</div>
                          <div style={{ color: "#8b949e", fontSize: "10px" }}>{evDate.toLocaleString()} · {ev.country}</div>
                        </div>
                        <div style={{ textAlign: "right", fontSize: "10px" }}>
                          {ev.forecast && <div style={{ color: "#e3b341" }}>Forecast: {ev.forecast}</div>}
                          {ev.previous && <div style={{ color: "#8b949e" }}>Previous: {ev.previous}</div>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* LOG PANEL */}
        <div style={styles.logPanel}>
          <div style={styles.logHeader}>SYSTEM LOG</div>
          <div style={styles.logBody} ref={logRef}>
            {log.map((entry, i) => (
              <div key={i} style={styles.logEntry(entry.type)}>
                <span style={{ color: "#484f58", marginRight: "6px" }}>{entry.time}</span>
                {entry.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}