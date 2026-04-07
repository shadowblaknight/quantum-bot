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

const isNearMarketClose = () => {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;
  if (utcDay === 5 && utcTime >= 21.5) return true;
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADED BRAIN / SIGNAL ENGINE
// Copy-paste this over your current signal-engine section
// ─────────────────────────────────────────────────────────────────────────────

// ─── INDICATORS ──────────────────────────────────────────────────────────────
const calcEMA = (arr, period) => {
  if (!arr || arr.length < period) return null;
  const k = 2 / (period + 1);
  let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
};

const calcRSI = (prices, period = 14) => {
  if (!prices || prices.length < period + 1) return 50;

  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }

  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(changes[i], 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-changes[i], 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
};

const calcMACD = (prices) => {
  if (!prices || prices.length < 26) return { macd: 0, signal: 0, hist: 0 };

  const macdSeries = [];
  for (let i = 26; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const ema12 = calcEMA(slice, 12);
    const ema26 = calcEMA(slice, 26);
    if (ema12 != null && ema26 != null) macdSeries.push(ema12 - ema26);
  }

  if (!macdSeries.length) return { macd: 0, signal: 0, hist: 0 };

  const macd = macdSeries[macdSeries.length - 1];
  const signal = macdSeries.length >= 9 ? calcEMA(macdSeries, 9) : macd;
  const hist = macd - signal;

  return { macd, signal, hist };
};

const calcBollinger = (prices, period = 20) => {
  if (!prices || prices.length < period) {
    return { upper: 0, middle: 0, lower: 0, pct: 50, std: 0 };
  }

  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const last = prices[prices.length - 1];
  const pct = upper === lower ? 50 : ((last - lower) / (upper - lower)) * 100;

  return { upper, middle: mean, lower, pct, std };
};

const calcATR = (prices, period = 14) => {
  if (prices?.candles && prices.candles.length >= period + 1) {
    const candles = prices.candles;
    const trs = [];

    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;

      trs.push(
        Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose)
        )
      );
    }

    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  if (!prices || prices.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < prices.length; i++) {
    trs.push(Math.abs(prices[i] - prices[i - 1]));
  }

  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
};

// ─── SESSION ENGINE ──────────────────────────────────────────────────────────
const getSessionInfo = () => {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;
  const utcDay = now.getUTCDay();

  if (utcDay === 6 || (utcDay === 0 && utcTime < 22)) {
    return {
      session: "WEEKEND",
      isLondonOpen: false,
      isNYOpen: false,
      isAsian: false,
      isLondon: false,
      isNY: false,
      isOverlap: false,
      isSundayReopen: false,
      tradingAllowed: false,
      utcTime,
    };
  }

  const isSundayReopen = utcDay === 0 && utcTime >= 22;
  const isAsian = (utcTime >= 0 && utcTime < 8) || isSundayReopen;
  const isLondon = utcTime >= 8 && utcTime < 16;
  const isNY = utcTime >= 13 && utcTime < 21;
  const isOverlap = utcTime >= 13 && utcTime < 16;

  const isLondonOpen = utcTime >= 8 && utcTime < 8.5;
  const isNYOpen = utcTime >= 13 && utcTime < 13.5;

  let session = "OFF_HOURS";
  if (isSundayReopen) session = "SYDNEY_OPEN";
  else if (isOverlap) session = "LONDON_NY_OVERLAP";
  else if (isNY) session = "NEW_YORK";
  else if (isLondon) session = "LONDON";
  else if (isAsian) session = "ASIAN";

  return {
    session,
    isLondonOpen,
    isNYOpen,
    isAsian,
    isLondon,
    isNY,
    isOverlap,
    isSundayReopen,
    tradingAllowed: isLondon || isNY || isSundayReopen,
    utcTime,
  };
};

const getAsianRange = (candles) => {
  if (!candles || candles.length < 10) return null;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  const asianEnd = new Date(todayStart);
  asianEnd.setUTCHours(8, 0, 0, 0);

  const asianCandles = candles.filter((c) => {
    const t = new Date(c.time);
    return t >= todayStart && t < asianEnd;
  });

  if (asianCandles.length < 3) return null;

  const high = Math.max(...asianCandles.map((c) => c.high));
  const low = Math.min(...asianCandles.map((c) => c.low));

  return { high, low, mid: (high + low) / 2, candleCount: asianCandles.length };
};

const getSessionFilter = (candles, direction, currentPrice) => {
  const sessionInfo = getSessionInfo();

  if (!sessionInfo.tradingAllowed) {
    return { allowed: false, reason: "Outside London/NY/Sunday reopen hours" };
  }

  const asianRange = getAsianRange(candles);

  if (sessionInfo.isLondonOpen || sessionInfo.isNYOpen) {
    const sessionName = sessionInfo.isLondonOpen ? "London" : "New York";

    if (asianRange) {
      if (direction === "LONG" && currentPrice > asianRange.high) {
        return {
          allowed: true,
          reason: `${sessionName} open - Asian High breakout`,
          asianRange,
          sessionInfo,
        };
      }

      if (direction === "SHORT" && currentPrice < asianRange.low) {
        return {
          allowed: true,
          reason: `${sessionName} open - Asian Low breakout`,
          asianRange,
          sessionInfo,
        };
      }

      return {
        allowed: false,
        reason: `${sessionName} open - waiting for Asian range breakout`,
        asianRange,
        sessionInfo,
      };
    }
  }

  return {
    allowed: true,
    reason: `${sessionInfo.session} session`,
    asianRange,
    sessionInfo,
  };
};

// ─── M15 BIAS ────────────────────────────────────────────────────────────────
const calcM15Bias = (m15Candles) => {
  if (!m15Candles || m15Candles.length < 20) {
    return { bias: null, reason: "Insufficient M15 data", ema20: null, ema50: null };
  }

  const closes = m15Candles.map((c) => c.close);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const lastClose = closes[closes.length - 1];

  let swingHighs = [];
  let swingLows = [];
  const recent = m15Candles.slice(-30);

  for (let i = 2; i < recent.length - 2; i++) {
    if (
      recent[i].high > recent[i - 1].high &&
      recent[i].high > recent[i - 2].high &&
      recent[i].high > recent[i + 1].high &&
      recent[i].high > recent[i + 2].high
    ) {
      swingHighs.push(recent[i].high);
    }

    if (
      recent[i].low < recent[i - 1].low &&
      recent[i].low < recent[i - 2].low &&
      recent[i].low < recent[i + 1].low &&
      recent[i].low < recent[i + 2].low
    ) {
      swingLows.push(recent[i].low);
    }
  }

  const bullishStructure =
    swingHighs.length >= 2 &&
    swingLows.length >= 2 &&
    swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2] &&
    swingLows[swingLows.length - 1] > swingLows[swingLows.length - 2];

  const bearishStructure =
    swingHighs.length >= 2 &&
    swingLows.length >= 2 &&
    swingHighs[swingHighs.length - 1] < swingHighs[swingHighs.length - 2] &&
    swingLows[swingLows.length - 1] < swingLows[swingLows.length - 2];

  const bullishEMA = ema20 && ema50 && ema20 > ema50 && lastClose > ema20;
  const bearishEMA = ema20 && ema50 && ema20 < ema50 && lastClose < ema20;

  if (bullishStructure && bullishEMA) {
    return { bias: "BULLISH", reason: "M15 HH/HL + EMA20 > EMA50", ema20, ema50 };
  }

  if (bearishStructure && bearishEMA) {
    return { bias: "BEARISH", reason: "M15 LH/LL + EMA20 < EMA50", ema20, ema50 };
  }

  if (bullishEMA) return { bias: "BULLISH", reason: "M15 EMA stack bullish", ema20, ema50 };
  if (bearishEMA) return { bias: "BEARISH", reason: "M15 EMA stack bearish", ema20, ema50 };

  return { bias: null, reason: "M15 no clear bias", ema20, ema50 };
};

// ─── SMC ─────────────────────────────────────────────────────────────────────
const calcBOSCHOCH = (candles) => {
  if (!candles || candles.length < 10) {
    return { bos: null, choch: null, bias: null, swingHighs: [], swingLows: [] };
  }

  const recent = candles.slice(-20);
  let swingHighs = [];
  let swingLows = [];

  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];

    if (
      c.high > recent[i - 1].high &&
      c.high > recent[i - 2].high &&
      c.high > recent[i + 1].high &&
      c.high > recent[i + 2].high
    ) {
      swingHighs.push({ price: c.high, idx: i });
    }

    if (
      c.low < recent[i - 1].low &&
      c.low < recent[i - 2].low &&
      c.low < recent[i + 1].low &&
      c.low < recent[i + 2].low
    ) {
      swingLows.push({ price: c.low, idx: i });
    }
  }

  const lastClose = candles[candles.length - 1].close;
  let bos = null;
  let choch = null;

  if (swingHighs.length > 0) {
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    if (lastClose > lastSwingHigh.price) {
      bos = { type: "BULLISH", level: lastSwingHigh.price, broken: true };
    }
  }

  if (swingLows.length > 0) {
    const lastSwingLow = swingLows[swingLows.length - 1];
    if (lastClose < lastSwingLow.price) {
      if (bos && bos.type === "BULLISH") {
        choch = { type: "BEARISH", level: lastSwingLow.price };
        bos = null;
      } else {
        bos = { type: "BEARISH", level: lastSwingLow.price, broken: true };
      }
    }
  }

  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const prevHigh = swingHighs[swingHighs.length - 2];
    const lastHigh = swingHighs[swingHighs.length - 1];
    const prevLow = swingLows[swingLows.length - 2];
    const lastLow = swingLows[swingLows.length - 1];

    const wasUptrend = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
    const wasDowntrend = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

    if (wasUptrend && lastClose < lastLow.price) {
      choch = { type: "BEARISH", level: lastLow.price };
    } else if (wasDowntrend && lastClose > lastHigh.price) {
      choch = { type: "BULLISH", level: lastHigh.price };
    }
  }

  let bias = null;
  if (choch) bias = choch.type;
  else if (bos) bias = bos.type;

  return { bos, choch, bias, swingHighs, swingLows };
};

const calcOrderBlocks = (candles) => {
  if (!candles || candles.length < 5) {
    return { bullishOB: null, bearishOB: null };
  }

  let bullishOB = null;
  let bearishOB = null;

  for (let i = Math.max(0, candles.length - 30); i < candles.length - 1; i++) {
    const c = candles[i];
    const next = candles[i + 1];

    const isBullishMove = next.close > c.high * 1.001;
    const isBearishMove = next.close < c.low * 0.999;

    if (!bullishOB && c.close < c.open && isBullishMove) {
      bullishOB = {
        high: c.high,
        low: c.low,
        mid: (c.high + c.low) / 2,
        idx: i,
      };
    }

    if (!bearishOB && c.close > c.open && isBearishMove) {
      bearishOB = {
        high: c.high,
        low: c.low,
        mid: (c.high + c.low) / 2,
        idx: i,
      };
    }

    if (bullishOB && bearishOB) break;
  }

  return { bullishOB, bearishOB };
};

const calcFVG = (candles) => {
  if (!candles || candles.length < 3) {
    return { bullishFVG: null, bearishFVG: null };
  }

  let bullishFVG = null;
  let bearishFVG = null;

  for (let i = Math.max(0, candles.length - 20); i < candles.length - 2; i++) {
    const c1 = candles[i];
    const c3 = candles[i + 2];

    if (!bullishFVG && c3.low > c1.high) {
      bullishFVG = {
        top: c3.low,
        bottom: c1.high,
        mid: (c3.low + c1.high) / 2,
        idx: i,
      };
    }

    if (!bearishFVG && c3.high < c1.low) {
      bearishFVG = {
        top: c1.low,
        bottom: c3.high,
        mid: (c1.low + c3.high) / 2,
        idx: i,
      };
    }

    if (bullishFVG && bearishFVG) break;
  }

  return { bullishFVG, bearishFVG };
};

const getSMCConfirmation = (candles, direction) => {
  if (!candles || candles.length < 30) {
    return { confirmed: false, reason: "Not enough data" };
  }

  const lastPrice = candles[candles.length - 1].close;
  const { bos, choch, bias, swingHighs, swingLows } = calcBOSCHOCH(candles);
  const { bullishOB, bearishOB } = calcOrderBlocks(candles);
  const { bullishFVG, bearishFVG } = calcFVG(candles);

  let score = 0;
  const reasons = [];

  if (direction === "LONG") {
    if (bias === "BULLISH") {
      score += 3;
      reasons.push("BOS/CHoCH bullish");
    }

    if (bullishOB) {
      const inOB = lastPrice >= bullishOB.low * 0.999 && lastPrice <= bullishOB.high * 1.001;
      const nearOB = lastPrice >= bullishOB.low * 0.995 && lastPrice <= bullishOB.high * 1.005;
      if (inOB) {
        score += 3;
        reasons.push("Price inside bullish OB");
      } else if (nearOB) {
        score += 1;
        reasons.push("Price near bullish OB");
      }
    }

    if (bullishFVG && lastPrice <= bullishFVG.top * 1.002) {
      score += 2;
      reasons.push("Bullish FVG present");
    }

    if (choch && choch.type === "BEARISH") {
      score -= 3;
      reasons.push("Bearish CHOCH conflict");
    }
  }

  if (direction === "SHORT") {
    if (bias === "BEARISH") {
      score += 3;
      reasons.push("BOS/CHoCH bearish");
    }

    if (bearishOB) {
      const inOB = lastPrice >= bearishOB.low * 0.999 && lastPrice <= bearishOB.high * 1.001;
      const nearOB = lastPrice >= bearishOB.low * 0.995 && lastPrice <= bearishOB.high * 1.005;
      if (inOB) {
        score += 3;
        reasons.push("Price inside bearish OB");
      } else if (nearOB) {
        score += 1;
        reasons.push("Price near bearish OB");
      }
    }

    if (bearishFVG && lastPrice >= bearishFVG.bottom * 0.998) {
      score += 2;
      reasons.push("Bearish FVG present");
    }

    if (choch && choch.type === "BULLISH") {
      score -= 3;
      reasons.push("Bullish CHOCH conflict");
    }
  }

  return {
    confirmed: score >= 3,
    score,
    reasons,
    bias,
    bos,
    choch,
    bullishOB,
    bearishOB,
    bullishFVG,
    bearishFVG,
    swingHighs,
    swingLows,
  };
};

// ─── CONTEXT ─────────────────────────────────────────────────────────────────
const calcLiquiditySweep = (candles) => {
  if (!candles || candles.length < 10) return { swept: false, direction: null };

  const last = candles[candles.length - 1];
  const lookback = candles.slice(-20);

  let recentHigh = -Infinity;
  let recentLow = Infinity;

  for (let i = 0; i < lookback.length - 2; i++) {
    if (lookback[i].high > recentHigh) recentHigh = lookback[i].high;
    if (lookback[i].low < recentLow) recentLow = lookback[i].low;
  }

  const bullishSweep =
    last.low < recentLow &&
    last.close > recentLow &&
    last.close > last.open;

  const bearishSweep =
    last.high > recentHigh &&
    last.close < recentHigh &&
    last.close < last.open;

  if (bullishSweep) return { swept: true, direction: "BULLISH", level: recentLow };
  if (bearishSweep) return { swept: true, direction: "BEARISH", level: recentHigh };

  return { swept: false, direction: null };
};

const calcVolumeConfirmation = (candles, direction) => {
  if (!candles || candles.length < 20) {
    return { confirmed: false, reason: "No volume data" };
  }

  const recent = candles.slice(-20);
  const avgVolume = recent.reduce((s, c) => s + (c.volume || 0), 0) / recent.length;

  if (avgVolume === 0) return { confirmed: false, reason: "Zero volume" };

  const lastCandle = candles[candles.length - 1];
  const last3 = candles.slice(-3);

  const hasVolumeSpike = (lastCandle.volume || 0) > avgVolume * 1.5;
  const bullishVolume = last3.filter((c) => c.close > c.open).reduce((s, c) => s + (c.volume || 0), 0);
  const bearishVolume = last3.filter((c) => c.close < c.open).reduce((s, c) => s + (c.volume || 0), 0);

  const directionalConfirm =
    direction === "LONG" ? bullishVolume > bearishVolume : bearishVolume > bullishVolume;

  return {
    confirmed: hasVolumeSpike || directionalConfirm,
    reason: hasVolumeSpike ? "Volume spike confirms move" : directionalConfirm ? "Directional volume bias" : "Weak volume",
    avgVolume,
    lastVolume: lastCandle.volume || 0,
  };
};

const calcConfluenceScore = (direction, m15bias, smc, sweep, volume, rsi, atr, closes) => {
  let score = 0;
  const factors = [];

  const directionBias =
    direction === "LONG" ? "BULLISH" :
    direction === "SHORT" ? "BEARISH" :
    null;

  if (m15bias && m15bias === directionBias) {
    score += 2;
    factors.push("M15 aligned");
  }

  if (smc?.bos?.type === directionBias || smc?.choch?.type === directionBias) {
    score += 2;
    factors.push("M1 BOS/CHoCH");
  }

  if (smc?.bullishOB && direction === "LONG") {
    score += 2;
    factors.push("Bullish OB");
  }

  if (smc?.bearishOB && direction === "SHORT") {
    score += 2;
    factors.push("Bearish OB");
  }

  if (smc?.bullishFVG && direction === "LONG") {
    score += 1;
    factors.push("Bullish FVG");
  }

  if (smc?.bearishFVG && direction === "SHORT") {
    score += 1;
    factors.push("Bearish FVG");
  }

  if (sweep?.swept && sweep.direction === directionBias) {
    score += 2;
    factors.push("Liquidity sweep");
  }

  if (
    rsi &&
    ((direction === "LONG" && rsi > 35 && rsi < 65) ||
      (direction === "SHORT" && rsi < 65 && rsi > 35))
  ) {
    score += 1;
    factors.push("RSI healthy");
  }

  // volume downgraded — small influence only
  if (volume?.confirmed) {
    score += 1;
    factors.push("Volume confirms");
  }

  if (atr && closes?.length > 0) {
    const lastPrice = closes[closes.length - 1];
    const atrPct = (atr / lastPrice) * 100;
    if (atrPct > 0.05 && atrPct < 2.0) {
      score += 1;
      factors.push("ATR healthy");
    }
  }

  return { score, factors, maxScore: 12 };
};

const calcVolatilityFilter = (atr, lastPrice, instType) => {
  if (!atr || !lastPrice) return { healthy: true, reason: "No ATR data" };

  const atrPct = (atr / lastPrice) * 100;

  const thresholds = {
    CRYPTO: { min: 0.05, max: 1.8 },
    COMMODITY: { min: 0.03, max: 1.0 },
    FOREX: { min: 0.01, max: 0.6 },
  };

  const t = thresholds[instType] || thresholds.FOREX;

  if (atrPct < t.min) return { healthy: false, reason: `Market too quiet (${atrPct.toFixed(3)}%)`, atrPct };
  if (atrPct > t.max) return { healthy: false, reason: `Market too volatile (${atrPct.toFixed(3)}%)`, atrPct };

  return { healthy: true, reason: `ATR healthy (${atrPct.toFixed(3)}%)`, atrPct };
};

// ─── ENTRY / LOCATION ────────────────────────────────────────────────────────
const hasPullback = (candles, direction) => {
  if (!candles || candles.length < 10) return false;

  const recent = candles.slice(-15);

  if (direction === "LONG") {
    let swingHigh = -Infinity;
    let swingIdx = 0;

    for (let i = 0; i < recent.length - 2; i++) {
      if (recent[i].high > swingHigh) {
        swingHigh = recent[i].high;
        swingIdx = i;
      }
    }

    const swingLow = Math.min(...recent.slice(swingIdx).map((c) => c.low));
    const currentClose = recent[recent.length - 1].close;
    const swingRange = swingHigh - swingLow;
    if (swingRange <= 0) return false;

    const retracePct = (swingHigh - currentClose) / swingRange;
    return retracePct >= 0.30;
  }

  if (direction === "SHORT") {
    let swingLow = Infinity;
    let swingIdx = 0;

    for (let i = 0; i < recent.length - 2; i++) {
      if (recent[i].low < swingLow) {
        swingLow = recent[i].low;
        swingIdx = i;
      }
    }

    const swingHigh = Math.max(...recent.slice(swingIdx).map((c) => c.high));
    const currentClose = recent[recent.length - 1].close;
    const swingRange = swingHigh - swingLow;
    if (swingRange <= 0) return false;

    const retracePct = (currentClose - swingLow) / swingRange;
    return retracePct >= 0.30;
  }

  return false;
};

const isValidLongLocation = ({ last, ema21, atr, smc }) => {
  const nearEMA =
    ema21 != null &&
    atr != null &&
    Math.abs(last - ema21) <= atr * 0.6 &&
    last <= ema21 * 1.002;

  const inBullishOB =
    smc?.bullishOB &&
    last >= smc.bullishOB.low &&
    last <= smc.bullishOB.high;

  const inBullishFVG =
    smc?.bullishFVG &&
    last >= smc.bullishFVG.bottom &&
    last <= smc.bullishFVG.top;

  return {
    valid: !!(nearEMA || inBullishOB || inBullishFVG),
    nearEMA: !!nearEMA,
    inBullishOB: !!inBullishOB,
    inBullishFVG: !!inBullishFVG,
  };
};

const isValidShortLocation = ({ last, ema21, atr, smc }) => {
  const nearEMA =
    ema21 != null &&
    atr != null &&
    Math.abs(last - ema21) <= atr * 0.6 &&
    last >= ema21 * 0.998;

  const inBearishOB =
    smc?.bearishOB &&
    last >= smc.bearishOB.low &&
    last <= smc.bearishOB.high;

  const inBearishFVG =
    smc?.bearishFVG &&
    last >= smc.bearishFVG.bottom &&
    last <= smc.bearishFVG.top;

  return {
    valid: !!(nearEMA || inBearishOB || inBearishFVG),
    nearEMA: !!nearEMA,
    inBearishOB: !!inBearishOB,
    inBearishFVG: !!inBearishFVG,
  };
};

// ─── STRUCTURAL STOPS ────────────────────────────────────────────────────────
const getRecentSwingLow = (candles, lookback = 12) => {
  if (!candles || candles.length < 3) return null;
  const recent = candles.slice(-lookback);
  return Math.min(...recent.map((c) => c.low));
};

const getRecentSwingHigh = (candles, lookback = 12) => {
  if (!candles || candles.length < 3) return null;
  const recent = candles.slice(-lookback);
  return Math.max(...recent.map((c) => c.high));
};

const calcAdvancedLevels = (direction, entry, atr, candles, smc) => {
  if (!atr || !entry || !candles) return null;
  if (direction !== "LONG" && direction !== "SHORT") return null;

  const buffer = atr * 0.25;

  if (direction === "LONG") {
    const swingLow = getRecentSwingLow(candles, 12);
    const obLow = smc?.bullishOB?.low ?? null;
    const structuralBase = Math.min(
      swingLow ?? Number.POSITIVE_INFINITY,
      obLow ?? Number.POSITIVE_INFINITY
    );

    const stopLoss =
      Number.isFinite(structuralBase)
        ? structuralBase - buffer
        : entry - atr * 1.5;

    const risk = Math.abs(entry - stopLoss);
    const partialTP = entry + risk * 1.5;
    const fullTP = entry + risk * 2.2;

    return {
      stopLoss,
      partialTP,
      fullTP,
      breakeven: entry,
      trailBy: atr,
    };
  }

  const swingHigh = getRecentSwingHigh(candles, 12);
  const obHigh = smc?.bearishOB?.high ?? null;
  const structuralBase = Math.max(
    swingHigh ?? Number.NEGATIVE_INFINITY,
    obHigh ?? Number.NEGATIVE_INFINITY
  );

  const stopLoss =
    Number.isFinite(structuralBase)
      ? structuralBase + buffer
      : entry + atr * 1.5;

  const risk = Math.abs(stopLoss - entry);
  const partialTP = entry - risk * 1.5;
  const fullTP = entry - risk * 2.2;

  return {
    stopLoss,
    partialTP,
    fullTP,
    breakeven: entry,
    trailBy: atr,
  };
};

// ─── MASTER BRAIN ────────────────────────────────────────────────────────────
const analyzeStrategies = (prices) => {
  if (!prices || prices.length < 50) return null;

  const rsi = calcRSI(prices);
  const macd = calcMACD(prices);
  const bb = calcBollinger(prices);
  const atr = calcATR(prices);

  const ema9 = calcEMA(prices, 9);
  const ema21 = calcEMA(prices, 21);
  const ema50 = calcEMA(prices, 50);
  const ema200 = prices.length >= 200 ? calcEMA(prices, 200) : null;

  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];

  if (!ema9 || !ema21 || !ema50 || !atr) return null;

  const trendEMA = ema200 || ema50;
  const bullTrend = last > trendEMA;
  const bearTrend = last < trendEMA;

  const scores = {
    RSI: rsi < 30 ? 90 : rsi < 40 ? 70 : rsi > 70 ? 10 : rsi > 60 ? 30 : 50,
    MACD:
      macd.hist > 0 && macd.macd > macd.signal ? 80 :
      macd.hist < 0 && macd.macd < macd.signal ? 20 :
      macd.hist > 0 ? 65 :
      macd.hist < 0 ? 35 :
      50,
    Bollinger:
      bb.pct < 15 ? 85 :
      bb.pct < 30 ? 65 :
      bb.pct > 85 ? 15 :
      bb.pct > 70 ? 35 :
      50,
    "EMA Cloud":
      ema9 > ema21 && ema21 > ema50 ? 85 :
      ema9 < ema21 && ema21 < ema50 ? 15 :
      ema9 > ema21 ? 65 :
      ema9 < ema21 ? 35 :
      50,
    Trend: bullTrend ? 75 : bearTrend ? 25 : 50,
    Momentum:
      (last - prev) > atr * 0.5 ? 75 :
      (last - prev) < -atr * 0.5 ? 25 :
      50,
  };

  Object.keys(scores).forEach((k) => {
    scores[k] = Math.min(95, Math.max(5, Math.round(scores[k])));
  });

  const bullCount = Object.values(scores).filter((s) => s >= 60).length;
  const bearCount = Object.values(scores).filter((s) => s <= 40).length;

  let direction = "NEUTRAL";
  if (bullCount >= 4) direction = "LONG";
  else if (bearCount >= 4) direction = "SHORT";

  if (direction === "LONG" && rsi > 72) direction = "NEUTRAL";
  if (direction === "SHORT" && rsi < 28) direction = "NEUTRAL";

  // anti-chase filter
  if (direction !== "NEUTRAL" && prices.length >= 5) {
    const recent = prices.slice(-5);
    const moves = [];
    for (let i = 1; i < recent.length; i++) moves.push(recent[i] - recent[i - 1]);

    const allBull = moves.every((m) => m > 0);
    const allBear = moves.every((m) => m < 0);

    if (direction === "LONG" && allBull) direction = "NEUTRAL";
    if (direction === "SHORT" && allBear) direction = "NEUTRAL";
  }

  // M15 bias must be clear and aligned
  const m15 = calcM15Bias(prices.m15Candles);
  const directionBias =
    direction === "LONG" ? "BULLISH" :
    direction === "SHORT" ? "BEARISH" :
    null;

  if (direction !== "NEUTRAL") {
    if (!m15.bias) direction = "NEUTRAL";
    else if (m15.bias !== directionBias) direction = "NEUTRAL";
  }

  // volatility must be healthy
  const instType = prices.instType || "FOREX";
  const volatility = calcVolatilityFilter(atr, last, instType);
  if (direction !== "NEUTRAL" && !volatility.healthy) {
    direction = "NEUTRAL";
  }

  // SMC structure must align
  let smc = null;
  if (direction !== "NEUTRAL") {
    if (!prices.candles || prices.candles.length < 30) {
      direction = "NEUTRAL";
    } else {
      smc = getSMCConfirmation(prices.candles, direction);

      const hasBias = smc.bias === directionBias;
      const hasBOS = smc.bos && smc.bos.type === directionBias;
      const hasCHOCH = smc.choch && smc.choch.type === directionBias;

      // stricter than before: require real structure alignment
      if (!hasBias && !hasBOS && !hasCHOCH) {
        direction = "NEUTRAL";
      }
    }
  }

  const sweep = prices.candles ? calcLiquiditySweep(prices.candles) : { swept: false, direction: null };
  const volume = prices.candles ? calcVolumeConfirmation(prices.candles, direction) : { confirmed: false, reason: "No volume" };

  // mandatory pullback gate
  let pullbackOk = false;
  if (direction !== "NEUTRAL" && prices.candles) {
    pullbackOk = hasPullback(prices.candles, direction);
    if (!pullbackOk) direction = "NEUTRAL";
  }

  // entry location gate
  let entryLocation = {
    valid: false,
    nearEMA: false,
    inBullishOB: false,
    inBullishFVG: false,
    inBearishOB: false,
    inBearishFVG: false,
  };

  if (direction === "LONG") {
    entryLocation = isValidLongLocation({ last, ema21, atr, smc });
    if (!entryLocation.valid) direction = "NEUTRAL";
  }

  if (direction === "SHORT") {
    entryLocation = isValidShortLocation({ last, ema21, atr, smc });
    if (!entryLocation.valid) direction = "NEUTRAL";
  }

  // late-entry distance filter
  if (direction === "LONG" && Math.abs(last - ema21) > atr * 1.2) {
    direction = "NEUTRAL";
  }

  if (direction === "SHORT" && Math.abs(last - ema21) > atr * 1.2) {
    direction = "NEUTRAL";
  }

  // confluence hard gate again
  const confluence = calcConfluenceScore(direction, m15.bias, smc, sweep, volume, rsi, atr, prices);
  if (direction !== "NEUTRAL" && confluence.score < 8) {
    direction = "NEUTRAL";
  }

  // recalc confluence after possible neutralization
  const finalConfluence = calcConfluenceScore(direction, m15.bias, smc, sweep, volume, rsi, atr, prices);

  // levels with structural SL
  const levels = direction !== "NEUTRAL"
    ? calcAdvancedLevels(direction, last, atr, prices.candles, smc)
    : null;

  const stopLoss = levels ? levels.stopLoss : null;
  const takeProfit = levels ? levels.fullTP : null;
  const slDistance = stopLoss != null ? Math.abs(last - stopLoss) : null;
  const tpDistance = takeProfit != null ? Math.abs(last - takeProfit) : null;

  // RR hard gate
  let rr = 0;
  if (direction !== "NEUTRAL" && slDistance && tpDistance) {
    rr = tpDistance / slDistance;
    if (rr < 1.8) {
      direction = "NEUTRAL";
    }
  }

  // confidence should reflect strictness
  const finalBias =
    direction === "LONG" ? "BULLISH" :
    direction === "SHORT" ? "BEARISH" :
    null;

  const agreementScore =
    direction === "LONG" ? bullCount :
    direction === "SHORT" ? bearCount :
    0;

  const m15Boost = finalBias && m15.bias === finalBias ? 6 : 0;
  const structureBoost = smc && (smc.bos || smc.choch) ? 6 : 0;
  const locationBoost = entryLocation.valid ? 8 : 0;
  const pullbackBoost = pullbackOk ? 6 : 0;
  const sweepBoost = finalBias && sweep.swept && sweep.direction === finalBias ? 4 : 0;

  const confidence =
    direction === "NEUTRAL"
      ? 50
      : Math.min(
          95,
          Math.max(
            50,
            Math.round(
              45 +
              agreementScore * 5 +
              m15Boost +
              structureBoost +
              locationBoost +
              pullbackBoost +
              sweepBoost
            )
          )
        );

  return {
    scores,
    direction,
    confidence,
    rsi,
    macd,
    bb,
    atr,
    ema9,
    ema21,
    ema50,
    ema200,
    stopLoss,
    takeProfit,
    slDistance,
    tpDistance,
    rr,
    bullTrend,
    bearTrend,
    smc,
    m15,
    sweep,
    volume,
    confluence: finalConfluence,
    volatility,
    levels,
    pullbackOk,
    entryLocation,
    reason:
      direction === "NEUTRAL"
        ? "No trade setup meets all filters"
        : "Valid setup",
  };
};
// ─── RISK ENGINE HELPERS ─────────────────────────────────────────────────────

// Daily loss limit: blocks trading if today P&L drops below -3% of balance
const checkDailyLossLimit = (todayPnl, balance) => {
  if (!Number.isFinite(todayPnl) || !Number.isFinite(balance) || balance <= 0) return false;
  return todayPnl <= -(balance * 0.03);
};

// Dynamic position sizing: scales with confidence, halves after losses, stops at 3
const calculatePositionSize = ({ balance, entry, stopLoss, confidence, confluenceScore, lossStreak }) => {
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || entry === stopLoss) return 0;
  if (!Number.isFinite(balance) || balance <= 0) return 0;

  const slDistance = Math.abs(entry - stopLoss);

  let riskPct = 0.01;
  if (confidence >= 88 && confluenceScore >= 9) riskPct = 0.015;

  if (lossStreak >= 2) riskPct *= 0.5;
  if (lossStreak >= 3) return 0;

  const riskAmount = balance * riskPct;
  const rawVolume = riskAmount / slDistance;
  const step = 0.01;

  return Math.max(0.01, Math.round(rawVolume / step) * step);
};

// Consecutive loss counter from real closed trades
const getConsecutiveLosses = (closedTrades = []) => {
  if (!closedTrades.length) return 0;

  let streak = 0;
  for (let i = closedTrades.length - 1; i >= 0; i--) {
    if (Number(closedTrades[i]?.profit || 0) < 0) streak++;
    else break;
  }

  return streak;
};

// Today's P&L from real closed trades
const getTodayPnl = (closedTrades = []) => {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  return closedTrades.reduce((sum, t) => {
    const timeRaw = t.time || t.closeTime || t.createdAt || t.date;
    if (!timeRaw) return sum;

    const dt = new Date(timeRaw);
    if (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) {
      return sum + Number(t.profit || 0);
    }

    return sum;
  }, 0);
};
// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function TradingBotLive() {
  const [prices,         setPrices]         = useState({ GBPUSD: null, BTCUSDT: null, XAUUSD: null });
  const [prevPrices,     setPrevPrices]      = useState({ GBPUSD: null, BTCUSDT: null, XAUUSD: null });
  const [signals,        setSignals]         = useState({});
  const [news,           setNews]            = useState([]);
  const [closedTrades,   setClosedTrades]    = useState([]);
  const [openPositions,  setOpenPositions]   = useState([]);
  const [brokerCandles,  setBrokerCandles]   = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
  const [m15Candles,     setM15Candles]      = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
  const [sessionInfo,    setSessionInfo]     = useState(getSessionInfo());
  const [selected,       setSelected]        = useState("BTCUSDT");
  const [activeTab,      setActiveTab]       = useState("signals");
  const [eventAlert,     setEventAlert]      = useState(null);
  const [marketStatus,   setMarketStatus]    = useState(getMarketStatus());
  const [log,            setLog]             = useState([]);
  const [isAiLoading,    setIsAiLoading]     = useState(false);
  const [aiAnalysis,     setAiAnalysis]      = useState("");
  const [calendarEvents, setCalendarEvents]  = useState([]);
  const [accountBalance, setAccountBalance]  = useState(null);
  const lastTradeRef = useRef({});
  const logRef       = useRef(null);

  const addLog = useCallback((msg, type = "info") => {
    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;
    setLog(prev => [...prev.slice(-50), { time, msg, type }]);
  }, []);

  const fetchLiveTrades = useCallback(async () => {
    try {
      const r = await fetch("/api/positions");
      if (r.ok) { const d = await r.json(); setOpenPositions(d.positions || []); }
    } catch(e) {}
  }, []);

  const fetchClosedTrades = useCallback(async () => {
    try {
      const r = await fetch("/api/history");
      if (r.ok) { const d = await r.json(); setClosedTrades(d.deals || []); }
    } catch(e) {}
  }, []);

  // Fetch account balance for accurate position sizing
  // Fetch account balance for accurate position sizing
useEffect(() => {
  const fetchAccount = async () => {
    try {
      const r = await fetch("/api/account");
      if (!r.ok) {
        console.log("Account fetch failed:", r.status);
        return;
      }

      const d = await r.json();
      console.log("Account API response:", d);

      const balance = Number(d.balance ?? d.equity ?? d.accountBalance);

      if (Number.isFinite(balance) && balance > 0) {
        setAccountBalance(balance);
      }
    } catch (e) {
      console.log("Account fetch error:", e.message);
    }
  };

  fetchAccount();
  const interval = setInterval(fetchAccount, 30000);
  return () => clearInterval(interval);
}, []);

  // Price feeds
  useEffect(() => {
    const symbolMap = { BTCUSDT: "BTCUSD", XAUUSD: "XAUUSD.s", GBPUSD: "GBPUSD" };
    const fetchBrokerCandles = async (instId) => {
      const symbol = symbolMap[instId];
      try {
        const r = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=M1&limit=200`);
        const d = await r.json();
        if (d.candles && d.candles.length >= 50) {
          setBrokerCandles(prev => ({ ...prev, [instId]: d.candles }));
          const lastClose = d.candles[d.candles.length - 1].close;
          if (Number.isFinite(lastClose)) {
            setPrices(prev => { setPrevPrices(pp => ({ ...pp, [instId]: prev[instId] })); return { ...prev, [instId]: lastClose }; });
          }
        } else {
          addLog(`${symbol} M1 candles unavailable`, "warn");
          setPrices(prev => ({ ...prev, [instId]: null }));
          setBrokerCandles(prev => ({ ...prev, [instId]: [] }));
          setM15Candles(prev => ({ ...prev, [instId]: [] }));
          setSignals(prev => { const n = {...prev}; delete n[instId]; return n; });
        }
        try {
          const r15 = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=M15&limit=100`);
          const d15 = await r15.json();
          if (d15.candles && d15.candles.length >= 20) setM15Candles(prev => ({ ...prev, [instId]: d15.candles }));
        } catch(e) {}
      } catch(e) {
        addLog(`${symbol} candles error`, "warn");
        setPrices(prev => ({ ...prev, [instId]: null }));
        setBrokerCandles(prev => ({ ...prev, [instId]: [] }));
        setM15Candles(prev => ({ ...prev, [instId]: [] }));
        setSignals(prev => { const n = {...prev}; delete n[instId]; return n; });
      }
    };
    const fetchBrokerPrice = async (instId) => {
      const symbol = symbolMap[instId];
      try {
        const r = await fetch(`/api/broker-price?symbol=${symbol}`);
        const d = await r.json();
        if (Number.isFinite(d.price)) {
          setPrices(prev => { setPrevPrices(pp => ({ ...pp, [instId]: prev[instId] })); return { ...prev, [instId]: d.price }; });
        }
      } catch(e) {}
    };
    INSTRUMENTS.forEach(inst => fetchBrokerCandles(inst.id));
    const intervals       = INSTRUMENTS.map(inst => setInterval(() => fetchBrokerPrice(inst.id),    5000));
    const candleIntervals = INSTRUMENTS.map(inst => setInterval(() => fetchBrokerCandles(inst.id), 60000));
    addLog("Price feeds: PU Prime broker (MetaAPI)", "success");
    addLog("BTC/USDT, GBP/USD, XAU/USD via broker", "info");
    return () => { intervals.forEach(clearInterval); candleIntervals.forEach(clearInterval); };
  }, [addLog]);

  // Signal calculation
  useEffect(() => {
    const newSignals = {};
    INSTRUMENTS.forEach(inst => {
      const candles = brokerCandles[inst.id];
      if (!candles || candles.length < 50) return;
      const closes = candles.map(c => c.close);
      closes.candles    = candles;
      closes.m15Candles = m15Candles[inst.id] || [];
      closes.instType   = inst.type;
      const sig = analyzeStrategies(closes);
      if (sig) newSignals[inst.id] = sig;
    });
    setSignals(newSignals);
  }, [brokerCandles, m15Candles]);

  // Market status
  useEffect(() => {
    const interval = setInterval(() => { setMarketStatus(getMarketStatus()); setSessionInfo(getSessionInfo()); }, 60000);
    return () => clearInterval(interval);
  }, []);

  // News
  useEffect(() => {
    const fetchNews = async () => { try { const r = await fetch("/api/news"); const d = await r.json(); if (d.articles) setNews(d.articles); } catch(e) {} };
    fetchNews();
    const interval = setInterval(fetchNews, 300000);
    return () => clearInterval(interval);
  }, []);

  // Calendar
  useEffect(() => {
    const fetchCalendar = async () => {
      try {
        const r = await fetch("/api/calendar");
        const d = await r.json();
        if (d.source === "unavailable" || !Array.isArray(d.events)) {
          addLog("Calendar unavailable - trading paused for safety", "warn");
          setEventAlert({ name: "Calendar unavailable", date: null });
          return;
        }
        setCalendarEvents(d.events);
        const now = Date.now();
        const upcoming = d.events.find(ev => { const evTime = new Date(ev.date).getTime(); return evTime > now && evTime < now + 30 * 60 * 1000; });
        setEventAlert(upcoming || null);
      } catch(e) {
        addLog("Calendar fetch error - trading paused for safety", "warn");
        setEventAlert({ name: "Calendar error", date: null });
      }
    };
    fetchCalendar();
    const interval = setInterval(fetchCalendar, 300000);
    return () => clearInterval(interval);
  }, [addLog]);

  // Fetch live trades
  useEffect(() => {
    fetchLiveTrades(); fetchClosedTrades();
    const interval = setInterval(() => { fetchLiveTrades(); fetchClosedTrades(); }, 30000);
    return () => clearInterval(interval);
  }, [fetchLiveTrades, fetchClosedTrades]);

  // Log scroll
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const pendingTradeRef   = useRef({});
  const lastEventTimeRef  = useRef(0);
  const lastBlockLogRef   = useRef({});

  const shouldLogBlock = useCallback((key, cooldownMs = 60000) => {
    const now = Date.now();
    if (!lastBlockLogRef.current[key] || now - lastBlockLogRef.current[key] > cooldownMs) { lastBlockLogRef.current[key] = now; return true; }
    return false;
  }, []);

  useEffect(() => { if (eventAlert?.date) lastEventTimeRef.current = new Date(eventAlert.date).getTime(); }, [eventAlert]);

  // Live execution
  useEffect(() => {
    INSTRUMENTS.forEach(inst => {
      const sig = signals[inst.id];
      if (!sig || sig.direction === "NEUTRAL" || sig.confidence < 85) return;

      const nowTs   = Date.now();
      const eventTs = eventAlert?.date ? new Date(eventAlert.date).getTime() : 0;
      if (eventTs > nowTs && eventTs < nowTs + 30 * 60 * 1000) { if (shouldLogBlock(`${inst.id}-event`)) addLog(`Trade blocked: ${eventAlert.name} imminent`, "warn"); return; }

      const lastEvTs = lastEventTimeRef.current;
      if (lastEvTs > 0 && nowTs >= lastEvTs && nowTs < lastEvTs + 30 * 60 * 1000) { if (shouldLogBlock(`${inst.id}-postevent`)) addLog("Trade blocked: post-event cooldown", "warn"); return; }

      if (isNearMarketClose() && inst.type !== "CRYPTO") { if (shouldLogBlock(`${inst.id}-close`)) addLog("Trade blocked: near market close", "warn"); return; }

      let sessionFilter = null;
      if (inst.type !== "CRYPTO") {
        sessionFilter = getSessionFilter(brokerCandles[inst.id], sig.direction, prices[inst.id]);
        if (!sessionFilter.allowed) { if (shouldLogBlock(`${inst.id}-session`)) addLog(`Session filter: ${sessionFilter.reason}`, "warn"); return; }
      }

      const mStatus = marketStatus[inst.id];
      if (!mStatus?.open && inst.type !== "CRYPTO") return;

      const now = Date.now();
      if (lastTradeRef.current[inst.id] && (now - lastTradeRef.current[inst.id]) < 300000) return;
      if (pendingTradeRef.current[inst.id]) return;

      const alreadyOpen = openPositions.some(p => {
        const raw = (p.symbol || "").toUpperCase();
        const normalized = raw === "XAUUSD.S" ? "XAUUSD" : raw.startsWith("BTCUSD") ? "BTCUSD" : raw.startsWith("GBPUSD") ? "GBPUSD" : raw.startsWith("XAUUSD") ? "XAUUSD" : raw;
        const targetSym = inst.id === "BTCUSDT" ? "BTCUSD" : inst.id === "XAUUSD" ? "XAUUSD" : inst.id;
        return normalized === targetSym;
      });
      if (alreadyOpen) return;
      if (openPositions.length >= 2) return;
      if (!Number.isFinite(sig.stopLoss) || !Number.isFinite(sig.takeProfit)) { addLog("Trade blocked: missing SL/TP", "warn"); return; }

      const candles = brokerCandles[inst.id];
      if (candles && candles.length >= 10) {
        const pullback = hasPullback(candles, sig.direction);
        if (!pullback) { if (shouldLogBlock(`${inst.id}-pullback`)) addLog(`${inst.label}: waiting for pullback before entry`, "warn"); return; }
      }
      if (!Number.isFinite(accountBalance) || accountBalance <= 0) {
        if (shouldLogBlock(`${inst.id}-balance-missing`)) {
          addLog("Trade blocked: account balance not loaded", "warn");
        }
        return;
      }
      // ── Risk Engine ──
      const lossStreak = getConsecutiveLosses(closedTrades);
      const todayPnl   = getTodayPnl(closedTrades);

      if (checkDailyLossLimit(todayPnl, accountBalance)) {
        if (shouldLogBlock(`${inst.id}-daily-loss`)) addLog("Trade blocked: daily loss limit hit (-3%)", "error");
        return;
      }

      const suggestedVolume = calculatePositionSize({
        balance:         accountBalance,
        entry:           prices[inst.id],
        stopLoss:        sig.stopLoss,
        confidence:      sig.confidence || 0,
        confluenceScore: sig.confluence?.score || 0,
        lossStreak
      });

      if (!Number.isFinite(suggestedVolume) || suggestedVolume <= 0) {
        if (shouldLogBlock(`${inst.id}-risk-engine`)) addLog(`Trade blocked: risk engine paused (${lossStreak} consecutive losses)`, "warn");
        return;
      }

      pendingTradeRef.current[inst.id] = true;
      addLog(`Signal: ${inst.label} ${sig.direction} ${sig.confidence}% | SL:${sig.stopLoss?.toFixed(inst.id==="BTCUSDT"?0:4)} TP:${sig.takeProfit?.toFixed(inst.id==="BTCUSDT"?0:4)} | Risk:${(suggestedVolume*Math.abs(prices[inst.id]-sig.stopLoss)).toFixed(2)}`, "signal");

      fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: inst.id,
          direction:  sig.direction,
          entry:      prices[inst.id],
          stopLoss:   sig.stopLoss,
          takeProfit: sig.takeProfit,
          volume:     suggestedVolume,
        })
      })
      .then(r => r.json())
      .then(d => {
        pendingTradeRef.current[inst.id] = false;
        if (d.success) {
          lastTradeRef.current[inst.id] = now;
          addLog(`Trade executed: ${inst.label} ${sig.direction} ${d.volume || suggestedVolume} lots @ ${prices[inst.id]}`, "success");
          setTimeout(fetchLiveTrades, 2000);
          setTimeout(fetchClosedTrades, 3000);
        } else {
          addLog(`Execution failed: ${d.error || "unknown"}`, "error");
        }
      })
      .catch(e => { pendingTradeRef.current[inst.id] = false; addLog(`Execute error: ${e.message}`, "error"); });
    });
  }, [signals, prices, brokerCandles, eventAlert, marketStatus, openPositions, closedTrades, accountBalance, addLog, fetchLiveTrades, fetchClosedTrades, shouldLogBlock]);

  // AI Analysis
  const runAI = async () => {
    setIsAiLoading(true); setAiAnalysis("");
    const sig = signals[selected] || {}, inst = INSTRUMENTS.find(i => i.id === selected);
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
Kill Zone: ${sig.debug?.inKillZone}
Long Score: ${sig.debug?.longScore} | Short Score: ${sig.debug?.shortScore}
Suggested SL: ${sig.stopLoss?.toFixed(4)} | TP: ${sig.takeProfit?.toFixed(4)}
Open positions: ${openPositions.length}
Account Balance: ${accountBalance != null ? `$${accountBalance.toFixed(2)}` : "Not loaded"}
News: ${news.slice(0,3).map(n=>n.title).join(" | ")}

Provide: 1) Market regime 2) Signal quality (A/B/C/D) 3) Risk assessment 4) Final recommendation. Be direct and specific.`;
    try {
      const r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
      const d = await r.json();
      setAiAnalysis(d.analysis || "No response");
    } catch(e) { setAiAnalysis("AI analysis error"); }
    setIsAiLoading(false);
  };

  const fmt = (id, p) => p != null ? (id === "BTCUSDT" ? p.toLocaleString("en", { maximumFractionDigits: 0 }) : p.toFixed(id === "GBPUSD" ? 4 : 2)) : "—";
  const priceDelta = (id) => { if (!prices[id] || !prevPrices[id]) return null; return prices[id] - prevPrices[id]; };
  const sig  = signals[selected] || {};
  const inst = INSTRUMENTS.find(i => i.id === selected);
  const nowTs    = Date.now();
  const eventTs  = eventAlert?.date ? new Date(eventAlert.date).getTime() : 0;
  const showEventBanner = !!eventAlert && (!eventTs || (eventTs > nowTs && eventTs < nowTs + 30 * 60 * 1000) || (eventTs > 0 && nowTs >= eventTs && nowTs < eventTs + 30 * 60 * 1000));
  const wins     = closedTrades.filter(t => t.profit > 0).length;
  const totalPnl = closedTrades.reduce((a, t) => a + (t.profit || 0), 0);
  const winRate  = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : "0.0";
  const lossStreakDisplay = getConsecutiveLosses(closedTrades);
  const todayPnlDisplay   = getTodayPnl(closedTrades);

  const styles = {
    app:       { background: "#0a0a0f", color: "#e0e0e0", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", minHeight: "100vh", fontSize: "12px" },
    header:    { background: "linear-gradient(135deg, #0d1117 0%, #161b22 100%)", borderBottom: "1px solid #21262d", padding: "12px 20px", display: "flex", alignItems: "center", gap: "20px", flexWrap: "wrap" },
    statBox:   { display: "flex", flexDirection: "column", gap: "2px" },
    statLabel: { color: "#8b949e", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px" },
    statValue: { fontWeight: "700", fontSize: "14px" },
    body:      { display: "flex", height: "calc(100vh - 60px)" },
    sidebar:   { width: "200px", background: "#0d1117", borderRight: "1px solid #21262d", padding: "12px", display: "flex", flexDirection: "column", gap: "8px", overflowY: "auto" },
    instCard:  (id) => ({ padding: "10px", borderRadius: "6px", cursor: "pointer", border: selected === id ? `1px solid ${INSTRUMENTS.find(i=>i.id===id)?.color}` : "1px solid #21262d", background: selected === id ? "rgba(255,255,255,0.05)" : "transparent", transition: "all 0.2s" }),
    main:      { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
    tabs:      { display: "flex", borderBottom: "1px solid #21262d", background: "#0d1117" },
    tab:       (active) => ({ padding: "10px 16px", cursor: "pointer", borderBottom: active ? "2px solid #58a6ff" : "2px solid transparent", color: active ? "#58a6ff" : "#8b949e", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px", transition: "all 0.2s" }),
    content:   { flex: 1, padding: "16px", overflowY: "auto" },
    card:      { background: "#0d1117", border: "1px solid #21262d", borderRadius: "8px", padding: "16px", marginBottom: "12px" },
    logPanel:  { width: "280px", background: "#0d1117", borderLeft: "1px solid #21262d", display: "flex", flexDirection: "column" },
    logHeader: { padding: "10px 12px", borderBottom: "1px solid #21262d", color: "#8b949e", fontSize: "10px", textTransform: "uppercase" },
    logBody:   { flex: 1, overflowY: "auto", padding: "8px" },
    logEntry:  (type) => ({ padding: "3px 6px", marginBottom: "2px", borderRadius: "3px", fontSize: "10px", color: type === "signal" ? "#3fb950" : type === "error" ? "#f85149" : type === "warn" ? "#e3b341" : type === "success" ? "#3fb950" : "#8b949e" }),
    badge:     (dir) => ({ padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", background: dir === "LONG" ? "rgba(63,185,80,0.15)" : dir === "SHORT" ? "rgba(248,81,73,0.15)" : "rgba(139,148,158,0.15)", color: dir === "LONG" ? "#3fb950" : dir === "SHORT" ? "#f85149" : "#8b949e", border: `1px solid ${dir === "LONG" ? "#3fb950" : dir === "SHORT" ? "#f85149" : "#8b949e"}40` }),
    scoreBar:  (score) => ({ height: "6px", borderRadius: "3px", background: score >= 60 ? "#3fb950" : score <= 40 ? "#f85149" : "#e3b341", width: `${score}%`, transition: "width 0.5s" }),
    tradeRow:  { display: "grid", gridTemplateColumns: "80px 70px 60px 90px 80px 80px", gap: "8px", padding: "8px", borderBottom: "1px solid #21262d", fontSize: "11px", alignItems: "center" },
    posCard:   { background: "#161b22", border: "1px solid #30363d", borderRadius: "6px", padding: "12px", marginBottom: "8px" },
    alertBanner: { background: "rgba(227,179,65,0.15)", border: "1px solid #e3b341", borderRadius: "6px", padding: "10px 16px", marginBottom: "12px", color: "#e3b341", display: "flex", alignItems: "center", gap: "8px" },
  };

  return (
    <div style={styles.app}>
      {/* HEADER */}
      <div style={styles.header}>
        <div style={{ color: "#58a6ff", fontWeight: "900", fontSize: "16px", letterSpacing: "2px" }}>QUANTUM BOT</div>
        <div style={styles.statBox}><span style={styles.statLabel}>Win Rate</span><span style={{ ...styles.statValue, color: "#3fb950" }}>{winRate}%</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Closed</span><span style={{ ...styles.statValue, color: "#58a6ff" }}>{closedTrades.length}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Net P&L</span><span style={{ ...styles.statValue, color: totalPnl >= 0 ? "#3fb950" : "#f85149" }}>${totalPnl.toFixed(2)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Balance</span><span style={{ ...styles.statValue, color: "#58a6ff" }}>${accountBalance.toFixed(0)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Today P&L</span><span style={{ ...styles.statValue, color: todayPnlDisplay >= 0 ? "#3fb950" : "#f85149" }}>${todayPnlDisplay.toFixed(2)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Loss Streak</span><span style={{ ...styles.statValue, color: lossStreakDisplay >= 2 ? "#f85149" : "#3fb950" }}>{lossStreakDisplay}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Open</span><span style={{ ...styles.statValue, color: "#e3b341" }}>{openPositions.length}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>BTC</span><span style={{ ...styles.statValue, color: "#F7931A" }}>${fmt("BTCUSDT", prices.BTCUSDT)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Gold</span><span style={{ ...styles.statValue, color: "#FFD700" }}>${fmt("XAUUSD", prices.XAUUSD)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>GBP/USD</span><span style={{ ...styles.statValue, color: "#00D4AA" }}>{fmt("GBPUSD", prices.GBPUSD)}</span></div>
        <div style={{ marginLeft: "auto", color: "#e3b341", fontSize: "11px" }}>{sessionInfo.session} {showEventBanner && `| ${eventAlert.name}`}</div>
      </div>

      <div style={styles.body}>
        {/* SIDEBAR */}
        <div style={styles.sidebar}>
          {INSTRUMENTS.map(i => {
            const s = signals[i.id], delta = priceDelta(i.id);
            return (
              <div key={i.id} style={styles.instCard(i.id)} onClick={() => setSelected(i.id)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <span style={{ color: i.color, fontWeight: "700", fontSize: "11px" }}>{i.icon} {i.label}</span>
                  <span style={{ fontSize: "9px", color: "#8b949e" }}>{i.type}</span>
                </div>
                <div style={{ fontSize: "13px", fontWeight: "700", marginBottom: "4px" }}>
                  {fmt(i.id, prices[i.id])}
                  {delta !== null && <span style={{ fontSize: "10px", color: delta >= 0 ? "#3fb950" : "#f85149", marginLeft: "4px" }}>{delta >= 0 ? "+" : ""}</span>}
                </div>
                {s && <div style={{ display: "flex", justifyContent: "space-between" }}><span style={styles.badge(s.direction)}>{s.direction}</span><span style={{ color: "#8b949e", fontSize: "10px" }}>{s.confidence}%</span></div>}
                {!s && <div style={{ color: "#8b949e", fontSize: "10px" }}>Loading {brokerCandles[i.id]?.length || 0}/60</div>}
                <div style={{ marginTop: "4px", fontSize: "9px", color: marketStatus[i.id]?.open ? "#3fb950" : "#f85149" }}>{marketStatus[i.id]?.open ? "OPEN" : "CLOSED"}</div>
              </div>
            );
          })}
          <div style={{ marginTop: "8px", padding: "8px", background: "#161b22", borderRadius: "6px", fontSize: "10px" }}>
            <div style={{ color: "#8b949e", marginBottom: "4px" }}>OPEN POSITIONS</div>
            {openPositions.length === 0 ? <div style={{ color: "#8b949e" }}>No open trades</div> : openPositions.map((p, i) => (
              <div key={i} style={{ marginBottom: "4px", color: p.profit >= 0 ? "#3fb950" : "#f85149" }}>{p.symbol} {p.type} {p.volume} | {p.profit?.toFixed(2)}</div>
            ))}
          </div>
        </div>

        {/* MAIN */}
        <div style={styles.main}>
          <div style={styles.tabs}>
            {["signals", "live trades", "debug", "ai analysis", "news", "calendar"].map(tab => (
              <div key={tab} style={styles.tab(activeTab === tab)} onClick={() => setActiveTab(tab)}>{tab.toUpperCase()}</div>
            ))}
          </div>
          <div style={styles.content}>
            {showEventBanner && <div style={styles.alertBanner}>{eventAlert.name} - Trading paused 30 min before/after event.</div>}

            {/* SIGNALS TAB */}
            {activeTab === "signals" && (
              <div>
                <div style={styles.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <div>
                      <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "4px" }}>COMPOSITE SIGNAL - {inst?.label}</div>
                      <div style={{ fontSize: "28px", fontWeight: "900", color: sig.direction === "LONG" ? "#3fb950" : sig.direction === "SHORT" ? "#f85149" : "#8b949e" }}>{sig.direction || "LOADING..."}</div>
                      {sig.reason && <div style={{ color: "#8b949e", fontSize: "10px", marginTop: "4px" }}>{sig.reason}</div>}
                    </div>
                    <div style={{ textAlign: "right" }}><div style={{ color: "#8b949e", fontSize: "10px" }}>CONFIDENCE</div><div style={{ fontSize: "24px", fontWeight: "700", color: (sig.confidence || 0) >= 78 ? "#3fb950" : "#e3b341" }}>{sig.confidence || 0}%</div></div>
                    <div style={{ textAlign: "right" }}><div style={{ color: "#8b949e", fontSize: "10px" }}>RSI</div><div style={{ fontSize: "20px", fontWeight: "700", color: (sig.rsi || 50) < 30 ? "#3fb950" : (sig.rsi || 50) > 70 ? "#f85149" : "#e0e0e0" }}>{sig.rsi?.toFixed(1) || "—"}</div></div>
                    <div style={{ textAlign: "right" }}><div style={{ color: "#8b949e", fontSize: "10px" }}>KILL ZONE</div><div style={{ fontSize: "14px", fontWeight: "700", color: sig.debug?.inKillZone ? "#3fb950" : "#f85149" }}>{sig.debug?.inKillZone ? "ACTIVE" : "INACTIVE"}</div></div>
                  </div>
                  {sig.direction && sig.direction !== "NEUTRAL" && (
                    <div style={{ display: "flex", gap: "16px", padding: "10px", background: "#161b22", borderRadius: "6px", marginBottom: "12px" }}>
                      <div><span style={{ color: "#8b949e", fontSize: "10px" }}>ENTRY </span><span style={{ color: "#58a6ff", fontWeight: "700" }}>{fmt(selected, prices[selected])}</span></div>
                      <div><span style={{ color: "#8b949e", fontSize: "10px" }}>SL </span><span style={{ color: "#f85149", fontWeight: "700" }}>{fmt(selected, sig.stopLoss)}</span></div>
                      <div><span style={{ color: "#8b949e", fontSize: "10px" }}>TP </span><span style={{ color: "#3fb950", fontWeight: "700" }}>{fmt(selected, sig.takeProfit)}</span></div>
                      <div><span style={{ color: "#8b949e", fontSize: "10px" }}>ATR </span><span style={{ color: "#e3b341", fontWeight: "700" }}>{sig.atr?.toFixed(selected === "BTCUSDT" ? 0 : 4)}</span></div>
                    </div>
                  )}
                </div>

                {/* Strategy Scores */}
                <div style={styles.card}>
                  <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "12px" }}>STRATEGY SCORES</div>
                  {sig.scores && Object.entries(sig.scores).map(([name, score]) => (
                    <div key={name} style={{ marginBottom: "8px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
                        <span style={{ color: "#c9d1d9", fontSize: "11px" }}>{name}</span>
                        <span style={{ color: score >= 60 ? "#3fb950" : score <= 40 ? "#f85149" : "#e3b341", fontSize: "11px", fontWeight: "700" }}>{score}</span>
                      </div>
                      <div style={{ background: "#21262d", borderRadius: "3px", height: "6px" }}><div style={styles.scoreBar(score)} /></div>
                    </div>
                  ))}
                  {!sig.scores && <div style={{ color: "#8b949e" }}>Collecting data... {brokerCandles[selected]?.length || 0}/60</div>}
                  {sig.direction === "NEUTRAL" && <div style={{ color: "#8b949e", fontSize: "11px", marginTop: "8px" }}>No trade setup meets all filters. Reason: {sig.reason}</div>}
                </div>

                {/* M15 Bias */}
                {sig.m15 && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "8px" }}>M15 HIGHER TIMEFRAME BIAS</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>M15 BIAS</div><div style={{ fontWeight: "700", color: sig.m15.bias === "BULLISH" ? "#3fb950" : sig.m15.bias === "BEARISH" ? "#f85149" : "#8b949e" }}>{sig.m15.bias || "UNCLEAR"}</div></div>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>EMA20</div><div style={{ fontWeight: "700" }}>{sig.m15.ema20?.toFixed(2) || "—"}</div></div>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>EMA50</div><div style={{ fontWeight: "700" }}>{sig.m15.ema50?.toFixed(2) || "—"}</div></div>
                    </div>
                    <div style={{ marginTop: "8px", color: "#8b949e", fontSize: "10px", fontStyle: "italic" }}>{sig.m15.reason}</div>
                  </div>
                )}

                {/* Confluence */}
                {sig.confluence && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "12px" }}>CONFLUENCE SCORE</div>
                    <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "10px" }}>
                      <div style={{ fontSize: "32px", fontWeight: "800", color: sig.confluence.score >= 8 ? "#3fb950" : sig.confluence.score >= 6 ? "#e3b341" : "#f85149" }}>
                        {sig.confluence.score}<span style={{ fontSize: "16px", color: "#8b949e" }}>/{sig.confluence.maxScore}</span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ height: "6px", background: "#21262d", borderRadius: "3px" }}>
                          <div style={{ height: "100%", borderRadius: "3px", width: `${(sig.confluence.score / sig.confluence.maxScore) * 100}%`, background: sig.confluence.score >= 8 ? "#3fb950" : sig.confluence.score >= 6 ? "#e3b341" : "#f85149" }} />
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {sig.confluence.factors.map((f, i) => (
                        <span key={i} style={{ background: "rgba(63,185,80,0.15)", color: "#3fb950", border: "1px solid #3fb95040", padding: "2px 8px", borderRadius: "10px", fontSize: "10px" }}>{f}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* SMC */}
                {sig.smc && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "10px" }}>SMART MONEY CONCEPTS</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "10px" }}>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>STRUCTURE</div><div style={{ fontWeight: "700", color: sig.smc.bias === "BULLISH" ? "#3fb950" : sig.smc.bias === "BEARISH" ? "#f85149" : "#8b949e" }}>{sig.smc.bias || "NEUTRAL"}</div></div>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>CONFIRMED</div><div style={{ fontWeight: "700", color: sig.smc.confirmed ? "#3fb950" : "#f85149" }}>{sig.smc.confirmed ? "YES" : "NO"}</div></div>
                    </div>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      {sig.smc.bullishOB && <div style={{ background: "rgba(63,185,80,0.1)", border: "1px solid #3fb95040", padding: "6px 10px", borderRadius: "4px", fontSize: "10px" }}><span style={{ color: "#3fb950" }}>Bull OB </span>{fmt(selected, sig.smc.bullishOB.low)} - {fmt(selected, sig.smc.bullishOB.high)}</div>}
                      {sig.smc.bearishOB && <div style={{ background: "rgba(248,81,73,0.1)", border: "1px solid #f8514940", padding: "6px 10px", borderRadius: "4px", fontSize: "10px" }}><span style={{ color: "#f85149" }}>Bear OB </span>{fmt(selected, sig.smc.bearishOB.low)} - {fmt(selected, sig.smc.bearishOB.high)}</div>}
                      {sig.smc.bos && <div style={{ background: "#161b22", padding: "6px 10px", borderRadius: "4px", fontSize: "10px" }}><span style={{ color: sig.smc.bos.type === "BULLISH" ? "#3fb950" : "#f85149" }}>BOS {sig.smc.bos.type}</span> @ {fmt(selected, sig.smc.bos.level)}</div>}
                    </div>
                  </div>
                )}

                {/* Market Conditions */}
                {(sig.volatility || sig.sweep || sig.volume) && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "10px" }}>MARKET CONDITIONS</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                      {sig.volatility && <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>VOLATILITY</div><div style={{ fontWeight: "700", fontSize: "11px", color: sig.volatility.healthy ? "#3fb950" : "#f85149" }}>{sig.volatility.healthy ? "Healthy" : "Blocked"}</div><div style={{ color: "#8b949e", fontSize: "9px" }}>{sig.volatility.reason}</div></div>}
                      {sig.sweep && <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>LIQ. SWEEP</div><div style={{ fontWeight: "700", fontSize: "11px", color: sig.sweep.swept ? "#3fb950" : "#8b949e" }}>{sig.sweep.swept ? sig.sweep.direction : "None"}</div></div>}
                      {sig.volume && <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>VOLUME</div><div style={{ fontWeight: "700", fontSize: "11px", color: sig.volume.confirmed ? "#3fb950" : "#8b949e" }}>{sig.volume.confirmed ? "Confirms" : "Weak"}</div></div>}
                    </div>
                  </div>
                )}

                {/* Levels */}
                {sig.levels && sig.direction !== "NEUTRAL" && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "10px" }}>TRADE LEVELS</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                      {[["Stop Loss", sig.levels.stopLoss, "#f85149"], ["Partial TP", sig.levels.partialTP, "#e3b341"], ["Full TP", sig.levels.fullTP, "#3fb950"], ["Breakeven", sig.levels.breakeven, "#58a6ff"]].map(([label, val, color]) => (
                        <div key={label} style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>{label}</div><div style={{ fontWeight: "700", fontSize: "12px", color }}>{val ? fmt(selected, val) : "—"}</div></div>
                      ))}
                    </div>
                  </div>
                )}

                {/* EMA */}
                {sig.ema9 && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "8px" }}>EMA LEVELS</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px" }}>
                      {[["EMA 9", sig.ema9], ["EMA 21", sig.ema21], ["EMA 50", sig.ema50], ["EMA 200", sig.ema200]].map(([label, val]) => (
                        <div key={label} style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>{label}</div><div style={{ fontWeight: "700", fontSize: "12px" }}>{val ? fmt(selected, val) : "—"}</div></div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* DEBUG TAB */}
            {activeTab === "debug" && (
              <div style={styles.card}>
                <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "12px" }}>SIGNAL DEBUG - {inst?.label}</div>
                {sig.debug ? (
                  <div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "12px" }}>
                      {[["Long Score", sig.debug.longScore, "#3fb950"], ["Short Score", sig.debug.shortScore, "#f85149"], ["Kill Zone", sig.debug.inKillZone ? "ACTIVE" : "INACTIVE", sig.debug.inKillZone ? "#3fb950" : "#f85149"], ["Raw Direction", sig.debug.rawDirection, "#58a6ff"], ["ATR%", sig.debug.atrPct?.toFixed(3) + "%", "#e3b341"], ["BB Width", sig.debug.bbWidth?.toFixed(3) + "%", "#e3b341"]].map(([label, val, color]) => (
                        <div key={label} style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}><div style={{ color: "#8b949e", fontSize: "9px" }}>{label}</div><div style={{ fontWeight: "700", color }}>{val}</div></div>
                      ))}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                        <div style={{ color: "#3fb950", fontSize: "9px", marginBottom: "4px" }}>LONG REASONS</div>
                        {sig.debug.longReasons.map((r, i) => <div key={i} style={{ fontSize: "10px", color: "#c9d1d9", marginBottom: "2px" }}>+ {r}</div>)}
                      </div>
                      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
                        <div style={{ color: "#f85149", fontSize: "9px", marginBottom: "4px" }}>SHORT REASONS</div>
                        {sig.debug.shortReasons.map((r, i) => <div key={i} style={{ fontSize: "10px", color: "#c9d1d9", marginBottom: "2px" }}>- {r}</div>)}
                      </div>
                    </div>
                  </div>
                ) : <div style={{ color: "#8b949e" }}>No debug data yet</div>}
              </div>
            )}

            {/* LIVE TRADES TAB */}
            {activeTab === "live trades" && (
              <div>
                <div style={styles.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <div style={{ color: "#8b949e", fontSize: "10px" }}>OPEN POSITIONS ({openPositions.length})</div>
                    <button onClick={fetchLiveTrades} style={{ background: "#21262d", border: "1px solid #30363d", color: "#c9d1d9", padding: "4px 10px", borderRadius: "4px", cursor: "pointer", fontSize: "10px" }}>Refresh</button>
                  </div>
                  {openPositions.length === 0 ? <div style={{ color: "#8b949e", textAlign: "center", padding: "20px" }}>No open positions</div> : openPositions.map((pos, i) => (
                    <div key={i} style={styles.posCard}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <div><span style={{ fontWeight: "700", color: "#58a6ff" }}>{pos.symbol}</span><span style={{ margin: "0 8px", color: pos.type === "POSITION_TYPE_BUY" ? "#3fb950" : "#f85149", fontWeight: "700" }}>{pos.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL"}</span><span style={{ color: "#8b949e" }}>{pos.volume} lots</span></div>
                        <span style={{ fontWeight: "700", color: (pos.profit || 0) >= 0 ? "#3fb950" : "#f85149" }}>{(pos.profit || 0) >= 0 ? "+" : ""}{(pos.profit || 0).toFixed(2)}</span>
                      </div>
                      <div style={{ display: "flex", gap: "16px", marginTop: "6px", fontSize: "10px", color: "#8b949e" }}>
                        <span>Entry: {pos.openPrice}</span><span>Current: {pos.currentPrice}</span>
                        {pos.stopLoss   && <span style={{ color: "#f85149" }}>SL: {pos.stopLoss}</span>}
                        {pos.takeProfit && <span style={{ color: "#3fb950" }}>TP: {pos.takeProfit}</span>}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                  {[["Win Rate", `${winRate}%`, "#3fb950"], ["Total Trades", closedTrades.length, "#58a6ff"], ["Net P&L", `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`, totalPnl >= 0 ? "#3fb950" : "#f85149"], ["Today P&L", `${todayPnlDisplay >= 0 ? "+" : ""}${todayPnlDisplay.toFixed(2)}`, todayPnlDisplay >= 0 ? "#3fb950" : "#f85149"]].map(([label, value, color]) => (
                    <div key={label} style={{ ...styles.card, marginBottom: 0, textAlign: "center" }}><div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "4px" }}>{label}</div><div style={{ fontWeight: "700", fontSize: "18px", color }}>{value}</div></div>
                  ))}
                </div>
                <div style={styles.card}>
                  <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "12px" }}>TRADE HISTORY ({closedTrades.length})</div>
                  <div style={{ ...styles.tradeRow, color: "#8b949e", fontSize: "10px", borderBottom: "1px solid #30363d" }}><span>SYMBOL</span><span>TYPE</span><span>LOTS</span><span>OPEN</span><span>CLOSE</span><span>P&L</span></div>
                  {closedTrades.length === 0 ? <div style={{ color: "#8b949e", textAlign: "center", padding: "20px" }}>No closed trades yet</div> : closedTrades.slice(0, 50).map((t, i) => (
                    <div key={i} style={styles.tradeRow}>
                      <span style={{ color: "#58a6ff", fontWeight: "700" }}>{t.symbol}</span>
                      <span style={{ color: t.type === "BUY" ? "#3fb950" : "#f85149" }}>{t.type}</span>
                      <span>{t.volume}</span>
                      <span style={{ color: "#8b949e" }}>{t.openPrice ?? "—"}</span>
                      <span>{t.closePrice ?? "—"}</span>
                      <span style={{ fontWeight: "700", color: (t.profit || 0) >= 0 ? "#3fb950" : "#f85149" }}>{(t.profit || 0) >= 0 ? "+" : ""}{(t.profit || 0).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* AI TAB */}
            {activeTab === "ai analysis" && (
              <div style={styles.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                  <div style={{ color: "#8b949e", fontSize: "10px" }}>AI DEEP ANALYSIS - {inst?.label}</div>
                  <button onClick={runAI} disabled={isAiLoading} style={{ background: isAiLoading ? "#21262d" : "#1f6feb", border: "none", color: "#fff", padding: "6px 14px", borderRadius: "6px", cursor: isAiLoading ? "not-allowed" : "pointer", fontSize: "11px", fontWeight: "700" }}>
                    {isAiLoading ? "ANALYZING..." : "RUN AI ANALYSIS"}
                  </button>
                </div>
                {aiAnalysis ? <div style={{ lineHeight: "1.6", color: "#c9d1d9", fontSize: "13px", whiteSpace: "pre-wrap" }}>{aiAnalysis}</div> : <div style={{ color: "#8b949e", textAlign: "center", padding: "40px" }}>Click "Run AI Analysis" for a deep market read</div>}
              </div>
            )}

            {/* NEWS TAB */}
            {activeTab === "news" && (
              <div>
                {news.length === 0 ? <div style={{ ...styles.card, color: "#8b949e", textAlign: "center" }}>Loading news...</div> : news.map((article, i) => (
                  <div key={i} style={{ ...styles.card, marginBottom: "8px" }}>
                    <div style={{ color: "#c9d1d9", fontWeight: "600", marginBottom: "4px", fontSize: "12px" }}>{article.title}</div>
                    <div style={{ color: "#8b949e", fontSize: "10px" }}>{article.source} - {article.inst}</div>
                  </div>
                ))}
              </div>
            )}

            {/* CALENDAR TAB */}
            {activeTab === "calendar" && (
              <div>
                {calendarEvents.length === 0 ? <div style={{ ...styles.card, color: "#8b949e", textAlign: "center" }}>Loading calendar...</div> : calendarEvents.map((ev, i) => {
                  const evDate = new Date(ev.date), isToday = evDate.toDateString() === new Date().toDateString();
                  return (
                    <div key={i} style={{ ...styles.card, marginBottom: "8px", borderLeft: `3px solid ${isToday ? "#f85149" : "#21262d"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <div>
                          <div style={{ fontWeight: "700", color: isToday ? "#f85149" : "#c9d1d9", marginBottom: "4px" }}>{ev.name}</div>
                          <div style={{ color: "#8b949e", fontSize: "10px" }}>{evDate.toLocaleString()} - {ev.country}</div>
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
                <span style={{ color: "#484f58", marginRight: "6px" }}>{entry.time}</span>{entry.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}