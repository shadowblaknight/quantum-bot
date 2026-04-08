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
    return retracePct >= 0.15;
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
  const h4Strength = smc?.h4Strength || null;
  const emaMultiplier =
  h4Strength === "STRONG" ? 2.0 :
  h4Strength === "MEDIUM" ? 1.2 : 0.6;

 const nearEMA =
  ema21 != null &&
  atr != null &&
  Math.abs(last - ema21) <= atr * emaMultiplier &&
  last >= ema21 * 0.998;

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
  const h4Strength = smc?.h4Strength || null;
  const emaMultiplier =
  h4Strength === "STRONG" ? 2.0 :
  h4Strength === "MEDIUM" ? 1.2 : 0.6;

  const nearEMA =
  ema21 != null &&
  atr != null &&
  Math.abs(last - ema21) <= atr * emaMultiplier &&
  last <= ema21 * 1.002;

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

// ─── SUPERIOR BRAIN v3 ────────────────────────────────────────────────────────
// Outperforms SignalXpert by adding:
// 1. H4 trend bias (catches +500 pip Gold moves)
// 2. Daily trend filter (no counter-trend trades)
// 3. Trailing stop levels (lets winners run)
// 4. Dynamic multi-TP (TP1=1:1, TP2=1:2, TP3=1:3)
// 5. Volatility regime detection (trending vs ranging)
// 6. Key level confluence (D1 S/R + OB + FVG together)
// ─────────────────────────────────────────────────────────────────────────────

// ─── H4 BIAS ENGINE ──────────────────────────────────────────────────────────
const calcH4Bias = (h4Candles) => {
  if (!h4Candles || h4Candles.length < 20) {
    return { bias: null, reason: "Insufficient H4 data", ema20: null, ema50: null, ema200: null };
  }

  const closes = h4Candles.map(c => c.close);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, Math.min(50, closes.length - 1));
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, Math.min(100, closes.length - 1));
  const last   = closes[closes.length - 1];

  // Swing structure
  const recent = h4Candles.slice(-30);
  let highs = [], lows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high) highs.push(recent[i].high);
    if (recent[i].low  < recent[i-1].low  && recent[i].low  < recent[i+1].low)  lows.push(recent[i].low);
  }

  const hhhl = highs.length >= 2 && lows.length >= 2 &&
    highs[highs.length-1] > highs[highs.length-2] &&
    lows[lows.length-1]   > lows[lows.length-2];

  const lhll = highs.length >= 2 && lows.length >= 2 &&
    highs[highs.length-1] < highs[highs.length-2] &&
    lows[lows.length-1]   < lows[lows.length-2];

  const bullEMA = ema20 && ema50 && ema20 > ema50 && last > ema20;
  const bearEMA = ema20 && ema50 && ema20 < ema50 && last < ema20;
  const aboveLT = ema200 && last > ema200;
  const belowLT = ema200 && last < ema200;

  // Strong bias: structure + EMA + long-term trend
  if (hhhl && bullEMA && aboveLT) return { bias: "BULLISH", strength: "STRONG", reason: "H4 HH/HL + EMA stack + above EMA200", ema20, ema50, ema200 };
  if (lhll && bearEMA && belowLT) return { bias: "BEARISH", strength: "STRONG", reason: "H4 LH/LL + EMA stack + below EMA200", ema20, ema50, ema200 };

  // Medium bias: structure OR EMA
  if (hhhl && bullEMA) return { bias: "BULLISH", strength: "MEDIUM", reason: "H4 HH/HL + EMA bullish", ema20, ema50, ema200 };
  if (lhll && bearEMA) return { bias: "BEARISH", strength: "MEDIUM", reason: "H4 LH/LL + EMA bearish", ema20, ema50, ema200 };
  if (bullEMA && aboveLT) return { bias: "BULLISH", strength: "MEDIUM", reason: "H4 EMA stack bullish + above LT", ema20, ema50, ema200 };
  if (bearEMA && belowLT) return { bias: "BEARISH", strength: "MEDIUM", reason: "H4 EMA stack bearish + below LT", ema20, ema50, ema200 };

  // Weak bias: just EMA
  if (bullEMA) return { bias: "BULLISH", strength: "WEAK", reason: "H4 EMA stack only", ema20, ema50, ema200 };
  if (bearEMA) return { bias: "BEARISH", strength: "WEAK", reason: "H4 EMA stack only", ema20, ema50, ema200 };

  return { bias: null, strength: null, reason: "H4 no clear bias", ema20, ema50, ema200 };
};

// ─── DAILY TREND FILTER ──────────────────────────────────────────────────────
const calcDailyTrend = (d1Candles) => {
  if (!d1Candles || d1Candles.length < 10) {
    return { trend: null, reason: "No D1 data" };
  }

  const closes = d1Candles.map(c => c.close);
  const ema10  = calcEMA(closes, Math.min(10, closes.length - 1));
  const ema20  = calcEMA(closes, Math.min(20, closes.length - 1));
  const last   = closes[closes.length - 1];

  // Last 5 candles direction
  const last5 = closes.slice(-5);
  const rising  = last5[4] > last5[0] && last5[3] > last5[1];
  const falling = last5[4] < last5[0] && last5[3] < last5[1];

  if (ema10 && ema20) {
    if (ema10 > ema20 && last > ema10 && rising)  return { trend: "UP",   reason: "D1 uptrend confirmed",   ema10, ema20 };
    if (ema10 < ema20 && last < ema10 && falling) return { trend: "DOWN", reason: "D1 downtrend confirmed", ema10, ema20 };
    if (ema10 > ema20) return { trend: "UP",   reason: "D1 EMA bullish", ema10, ema20 };
    if (ema10 < ema20) return { trend: "DOWN", reason: "D1 EMA bearish", ema10, ema20 };
  }

  return { trend: null, reason: "D1 ranging/unclear", ema10, ema20 };
};

// ─── VOLATILITY REGIME ───────────────────────────────────────────────────────
const calcVolatilityRegime = (candles, atr, lastPrice) => {
  if (!candles || candles.length < 20 || !atr || !lastPrice) {
    return { regime: "UNKNOWN", trending: false, ranging: false, adx: null };
  }

  // Simplified ADX using directional movement
  const period = 14;
  const recent = candles.slice(-period - 1);
  let plusDM = 0, minusDM = 0, trSum = 0;

  for (let i = 1; i < recent.length; i++) {
    const high = recent[i].high, low = recent[i].low;
    const prevHigh = recent[i-1].high, prevLow = recent[i-1].low, prevClose = recent[i-1].close;

    const upMove   = high - prevHigh;
    const downMove = prevLow - low;

    if (upMove > downMove && upMove > 0)   plusDM  += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;

    trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  const avgTR    = trSum / period;
  const plusDI   = avgTR > 0 ? (plusDM / avgTR) * 100 : 0;
  const minusDI  = avgTR > 0 ? (minusDM / avgTR) * 100 : 0;
  const diSum    = plusDI + minusDI;
  const adx      = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;

  const atrPct = (atr / lastPrice) * 100;

  if (adx >= 25 && atrPct > 0.05) return { regime: "TRENDING",  trending: true,  ranging: false, adx: Math.round(adx), plusDI: Math.round(plusDI), minusDI: Math.round(minusDI) };
  if (adx < 20)                   return { regime: "RANGING",   trending: false, ranging: true,  adx: Math.round(adx), plusDI: Math.round(plusDI), minusDI: Math.round(minusDI) };
  return                                 { regime: "TRANSITION", trending: false, ranging: false, adx: Math.round(adx), plusDI: Math.round(plusDI), minusDI: Math.round(minusDI) };
};

// ─── KEY LEVEL DETECTION ─────────────────────────────────────────────────────
const calcKeyLevels = (candles, currentPrice) => {
  if (!candles || candles.length < 20) return { supports: [], resistances: [], nearKey: false };

  const supports    = [];
  const resistances = [];
  const lookback    = candles.slice(-100);

  for (let i = 3; i < lookback.length - 3; i++) {
    const c = lookback[i];
    let isSupport    = true;
    let isResistance = true;

    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      if (lookback[j].low  < c.low)  isSupport    = false;
      if (lookback[j].high > c.high) isResistance = false;
    }

    if (isSupport) {
      const existing = supports.find(s => Math.abs(s.level - c.low) / c.low < 0.002);
      if (existing) existing.strength++;
      else supports.push({ level: c.low, strength: 1 });
    }

    if (isResistance) {
      const existing = resistances.find(r => Math.abs(r.level - c.high) / c.high < 0.002);
      if (existing) existing.strength++;
      else resistances.push({ level: c.high, strength: 1 });
    }
  }

  supports.sort((a, b)    => b.strength - a.strength);
  resistances.sort((a, b) => b.strength - a.strength);

  const atr = candles.length > 14
    ? candles.slice(-14).reduce((s, c) => s + (c.high - c.low), 0) / 14
    : (currentPrice * 0.001);

  const nearSupport    = supports.find(s    => Math.abs(currentPrice - s.level)    < atr * 1.5 && currentPrice > s.level);
  const nearResistance = resistances.find(r => Math.abs(currentPrice - r.level)    < atr * 1.5 && currentPrice < r.level);
  const atSupport      = supports.find(s    => Math.abs(currentPrice - s.level)    < atr * 0.5);
  const atResistance   = resistances.find(r => Math.abs(currentPrice - r.level)    < atr * 0.5);

  return {
    supports:          supports.slice(0, 5),
    resistances:       resistances.slice(0, 5),
    nearSupport,
    nearResistance,
    atSupport,
    atResistance,
    nearKey:           !!(nearSupport || nearResistance || atSupport || atResistance),
    closestSupport:    supports[0]    || null,
    closestResistance: resistances[0] || null,
  };
};

// ─── MULTI-TP LEVELS ─────────────────────────────────────────────────────────
const calcMultiTP = (direction, entry, stopLoss, atr, regime) => {
  if (!entry || !stopLoss || !atr) return null;

  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;

  // In trending market, use wider TPs to catch the big moves
  const tp1Mult = 1.0;
  const tp2Mult = regime?.trending ? 2.5 : 2.0;
  const tp3Mult = regime?.trending ? 4.0 : 3.0;  // The +550 pip catcher
  const trailBy = atr * 0.8;

  if (direction === "LONG") {
    return {
      tp1:      entry + risk * tp1Mult,   // 1:1 — partial close 50%
      tp2:      entry + risk * tp2Mult,   // 1:2.5 — partial close 30%
      tp3:      entry + risk * tp3Mult,   // 1:4 — let 20% run
      stopLoss,
      breakeven: entry + risk * 0.5,     // Move SL to BE after TP1
      trailBy,
      risk,
      rr1: tp1Mult, rr2: tp2Mult, rr3: tp3Mult,
    };
  }

  return {
    tp1:      entry - risk * tp1Mult,
    tp2:      entry - risk * tp2Mult,
    tp3:      entry - risk * tp3Mult,
    stopLoss,
    breakeven: entry - risk * 0.5,
    trailBy,
    risk,
    rr1: tp1Mult, rr2: tp2Mult, rr3: tp3Mult,
  };
};

// ─── DIVERGENCE DETECTOR ─────────────────────────────────────────────────────
const calcDivergence = (candles, rsi) => {
  if (!candles || candles.length < 20 || !rsi) return { bullish: false, bearish: false };

  const closes   = candles.map(c => c.close);
  const recent   = closes.slice(-20);
  const recentC  = candles.slice(-20);

  // Price making lower lows but RSI making higher lows = bullish divergence
  const priceLL  = recent[recent.length-1] < Math.min(...recent.slice(0, -5));
  // Price making higher highs but RSI making lower highs = bearish divergence
  const priceHH  = recent[recent.length-1] > Math.max(...recent.slice(0, -5));

  // Simplified: check last 5 vs previous 5
  const recentAvg  = recent.slice(-5).reduce((a,b) => a+b,0) / 5;
  const prevAvg    = recent.slice(-10,-5).reduce((a,b) => a+b,0) / 5;
  const priceDown  = recentAvg < prevAvg;
  const priceUp    = recentAvg > prevAvg;

  return {
    bullish:     priceDown && rsi > 40,  // Price down, RSI recovering
    bearish:     priceUp   && rsi > 65,  // Price up but RSI overbought
    hiddenBull:  priceUp   && rsi < 50,  // Trend continuation long
    hiddenBear:  priceDown && rsi > 50,  // Trend continuation short
  };
};

// ─── SMART BRAIN v4 ──────────────────────────────────────────────────────────
// Changes from v3:
// 1. Reduced from 12 hard gates to 7 smart gates
// 2. Pattern recognition (Head & Shoulders, Double Top/Bottom, Triangle)
// 3. Dynamic S/R with zone strength scoring
// 4. Adaptive entry zone based on H4 strength
// 5. Scoring system instead of binary pass/fail
// 6. Targets 3-5 trades per day
// ─────────────────────────────────────────────────────────────────────────────

// ─── PATTERN RECOGNITION ─────────────────────────────────────────────────────
const detectPatterns = (candles) => {
  if (!candles || candles.length < 30) return { patterns: [], bias: null };

  const patterns = [];
  const recent = candles.slice(-50);
  const closes = recent.map(c => c.close);
  const highs  = recent.map(c => c.high);
  const lows   = recent.map(c => c.low);

  // ── Head & Shoulders (bearish reversal) ──
  const findHeadAndShoulders = () => {
    const peaks = [];
    for (let i = 2; i < recent.length - 2; i++) {
      if (highs[i] > highs[i-1] && highs[i] > highs[i-2] &&
          highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
        peaks.push({ idx: i, price: highs[i] });
      }
    }
    if (peaks.length < 3) return null;
    for (let i = 0; i < peaks.length - 2; i++) {
      const left  = peaks[i];
      const head  = peaks[i+1];
      const right = peaks[i+2];
      const isHead = head.price > left.price * 1.001 && head.price > right.price * 1.001;
      const shouldersSymmetric = Math.abs(left.price - right.price) / left.price < 0.015;
      if (isHead && shouldersSymmetric) {
        // Find neckline
        const neckline = Math.min(
          Math.min(...lows.slice(left.idx, head.idx)),
          Math.min(...lows.slice(head.idx, right.idx))
        );
        const currentClose = closes[closes.length - 1];
        const broken = currentClose < neckline;
        return { type: 'HEAD_AND_SHOULDERS', bias: 'BEARISH', neckline, broken, head: head.price, leftShoulder: left.price, rightShoulder: right.price };
      }
    }
    return null;
  };

  // ── Inverse Head & Shoulders (bullish reversal) ──
  const findInverseHnS = () => {
    const troughs = [];
    for (let i = 2; i < recent.length - 2; i++) {
      if (lows[i] < lows[i-1] && lows[i] < lows[i-2] &&
          lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
        troughs.push({ idx: i, price: lows[i] });
      }
    }
    if (troughs.length < 3) return null;
    for (let i = 0; i < troughs.length - 2; i++) {
      const left  = troughs[i];
      const head  = troughs[i+1];
      const right = troughs[i+2];
      const isHead = head.price < left.price * 0.999 && head.price < right.price * 0.999;
      const shouldersSymmetric = Math.abs(left.price - right.price) / left.price < 0.015;
      if (isHead && shouldersSymmetric) {
        const neckline = Math.max(
          Math.max(...highs.slice(left.idx, head.idx)),
          Math.max(...highs.slice(head.idx, right.idx))
        );
        const currentClose = closes[closes.length - 1];
        const broken = currentClose > neckline;
        return { type: 'INVERSE_HEAD_AND_SHOULDERS', bias: 'BULLISH', neckline, broken, head: head.price };
      }
    }
    return null;
  };

  // ── Double Top (bearish) ──
  const findDoubleTop = () => {
    const peaks = [];
    for (let i = 2; i < recent.length - 2; i++) {
      if (highs[i] > highs[i-1] && highs[i] > highs[i+1]) {
        peaks.push({ idx: i, price: highs[i] });
      }
    }
    for (let i = 0; i < peaks.length - 1; i++) {
      const p1 = peaks[i], p2 = peaks[i+1];
      const separation = p2.idx - p1.idx;
      const similar = Math.abs(p1.price - p2.price) / p1.price < 0.008;
      if (similar && separation >= 5 && separation <= 30) {
        const valley = Math.min(...lows.slice(p1.idx, p2.idx));
        const currentClose = closes[closes.length - 1];
        return { type: 'DOUBLE_TOP', bias: 'BEARISH', resistance: (p1.price + p2.price) / 2, support: valley, broken: currentClose < valley };
      }
    }
    return null;
  };

  // ── Double Bottom (bullish) ──
  const findDoubleBottom = () => {
    const troughs = [];
    for (let i = 2; i < recent.length - 2; i++) {
      if (lows[i] < lows[i-1] && lows[i] < lows[i+1]) {
        troughs.push({ idx: i, price: lows[i] });
      }
    }
    for (let i = 0; i < troughs.length - 1; i++) {
      const t1 = troughs[i], t2 = troughs[i+1];
      const separation = t2.idx - t1.idx;
      const similar = Math.abs(t1.price - t2.price) / t1.price < 0.008;
      if (similar && separation >= 5 && separation <= 30) {
        const peak = Math.max(...highs.slice(t1.idx, t2.idx));
        const currentClose = closes[closes.length - 1];
        return { type: 'DOUBLE_BOTTOM', bias: 'BULLISH', support: (t1.price + t2.price) / 2, resistance: peak, broken: currentClose > peak };
      }
    }
    return null;
  };

  // ── Ascending Triangle (bullish) ──
  const findAscendingTriangle = () => {
    const last20 = recent.slice(-20);
    const topResistance = Math.max(...last20.map(c => c.high));
    const recentHighs = last20.filter(c => c.high > topResistance * 0.998);
    const risingLows = last20.slice(-10).map(c => c.low);
    const isRising = risingLows[risingLows.length-1] > risingLows[0] * 1.002;
    if (recentHighs.length >= 2 && isRising) {
      return { type: 'ASCENDING_TRIANGLE', bias: 'BULLISH', resistance: topResistance };
    }
    return null;
  };

  // ── Descending Triangle (bearish) ──
  const findDescendingTriangle = () => {
    const last20 = recent.slice(-20);
    const bottomSupport = Math.min(...last20.map(c => c.low));
    const recentLows = last20.filter(c => c.low < bottomSupport * 1.002);
    const risingHighs = last20.slice(-10).map(c => c.high);
    const isFalling = risingHighs[risingHighs.length-1] < risingHighs[0] * 0.998;
    if (recentLows.length >= 2 && isFalling) {
      return { type: 'DESCENDING_TRIANGLE', bias: 'BEARISH', support: bottomSupport };
    }
    return null;
  };

  const hns    = findHeadAndShoulders();
  const ihns   = findInverseHnS();
  const dtop   = findDoubleTop();
  const dbot   = findDoubleBottom();
  const atri   = findAscendingTriangle();
  const dtri   = findDescendingTriangle();

  if (hns)  patterns.push(hns);
  if (ihns) patterns.push(ihns);
  if (dtop) patterns.push(dtop);
  if (dbot) patterns.push(dbot);
  if (atri) patterns.push(atri);
  if (dtri) patterns.push(dtri);

  // Overall pattern bias
  const bullPatterns = patterns.filter(p => p.bias === 'BULLISH').length;
  const bearPatterns = patterns.filter(p => p.bias === 'BEARISH').length;
  const bias = bullPatterns > bearPatterns ? 'BULLISH' : bearPatterns > bullPatterns ? 'BEARISH' : null;

  return { patterns, bias, bullPatterns, bearPatterns };
};

// ─── SMART S/R ZONES ─────────────────────────────────────────────────────────
const calcSRZones = (candles, currentPrice) => {
  if (!candles || candles.length < 20) return { zones: [], nearZone: null, atZone: null };

  const zones = [];
  const lookback = candles.slice(-100);
  const atr = lookback.slice(-14).reduce((s, c) => s + (c.high - c.low), 0) / 14;

  // Find pivot highs and lows
  for (let i = 3; i < lookback.length - 3; i++) {
    const c = lookback[i];
    let isPivotHigh = true;
    let isPivotLow  = true;

    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      if (lookback[j].high >= c.high) isPivotHigh = false;
      if (lookback[j].low  <= c.low)  isPivotLow  = false;
    }

    if (isPivotHigh) {
      const existing = zones.find(z => Math.abs(z.price - c.high) < atr * 0.5);
      if (existing) { existing.strength++; existing.type = 'BOTH'; }
      else zones.push({ price: c.high, type: 'RESISTANCE', strength: 1 });
    }

    if (isPivotLow) {
      const existing = zones.find(z => Math.abs(z.price - c.low) < atr * 0.5);
      if (existing) { existing.strength++; existing.type = 'BOTH'; }
      else zones.push({ price: c.low, type: 'SUPPORT', strength: 1 });
    }
  }

  // Add round number levels (psychological S/R)
  const roundLevel = (price) => {
    if (price > 1000) return Math.round(price / 100) * 100;
    if (price > 100)  return Math.round(price / 10)  * 10;
    if (price > 1)    return Math.round(price * 10)  / 10;
    return Math.round(price * 100) / 100;
  };

  const nearest = roundLevel(currentPrice);
  if (Math.abs(currentPrice - nearest) < atr * 2) {
    const exists = zones.find(z => Math.abs(z.price - nearest) < atr * 0.3);
    if (!exists) zones.push({ price: nearest, type: 'ROUND_NUMBER', strength: 2 });
    else exists.strength += 2;
  }

  zones.sort((a, b) => b.strength - a.strength);

  const nearZone = zones.find(z => Math.abs(currentPrice - z.price) < atr * 1.5);
  const atZone   = zones.find(z => Math.abs(currentPrice - z.price) < atr * 0.4);

  return { zones: zones.slice(0, 8), nearZone, atZone, atr };
};

// ─── SMART CONFLUENCE SCORER ──────────────────────────────────────────────────
// Instead of binary pass/fail, everything scores points
const calcSmartConfluence = (direction, { m15, h4, d1, smc, sweep, volume, rsi, atr, closes, patterns, srZones, regime, divergence, bb, macd }) => {
  let score  = 0;
  const why  = [];
  const dirBias = direction === 'LONG' ? 'BULLISH' : 'BEARISH';

  // ── Timeframe alignment (max 9 pts) ──
  if (h4.bias === dirBias) {
    const pts = h4.strength === 'STRONG' ? 4 : h4.strength === 'MEDIUM' ? 3 : 2;
    score += pts; why.push(`H4 ${h4.strength} ${h4.bias} +${pts}`);
  }
  if (d1.trend === 'UP' && direction === 'LONG')  { score += 3; why.push('D1 uptrend +3'); }
  if (d1.trend === 'DOWN' && direction === 'SHORT') { score += 3; why.push('D1 downtrend +3'); }
  if (m15.bias === dirBias) { score += 2; why.push('M15 aligned +2'); }

  // ── Pattern recognition (max 4 pts) ──
  if (patterns) {
    const alignedPatterns = patterns.patterns.filter(p => p.bias === dirBias);
    if (alignedPatterns.length > 0) {
      const pts = Math.min(4, alignedPatterns.length * 2);
      score += pts;
      why.push(`Pattern: ${alignedPatterns[0].type} +${pts}`);
    }
    // Pattern conflict penalty
    const conflictPatterns = patterns.patterns.filter(p => p.bias !== dirBias && p.bias !== null);
    if (conflictPatterns.length > 0) { score -= 2; why.push('Pattern conflict -2'); }
  }

  // ── S/R zones (max 3 pts) ──
  if (srZones?.atZone) {
    const zoneAligned =
      (direction === 'LONG'  && (srZones.atZone.type === 'SUPPORT' || srZones.atZone.type === 'BOTH' || srZones.atZone.type === 'ROUND_NUMBER')) ||
      (direction === 'SHORT' && (srZones.atZone.type === 'RESISTANCE' || srZones.atZone.type === 'BOTH' || srZones.atZone.type === 'ROUND_NUMBER'));
    if (zoneAligned) { score += 3; why.push(`At S/R zone (strength ${srZones.atZone.strength}) +3`); }
  } else if (srZones?.nearZone) {
    score += 1; why.push('Near S/R zone +1');
  }

  // ── SMC structure (max 4 pts) ──
  if (smc) {
    if (smc.bias === dirBias)  { score += 2; why.push('SMC structure +2'); }
    if (smc.bos?.type   === dirBias) { score += 1; why.push('BOS confirmed +1'); }
    if (smc.choch?.type === dirBias) { score += 2; why.push('CHoCH +2'); }
    if (direction === 'LONG'  && smc.bullishOB) { score += 1; why.push('Bullish OB +1'); }
    if (direction === 'SHORT' && smc.bearishOB) { score += 1; why.push('Bearish OB +1'); }
  }

  // ── Momentum (max 3 pts) ──
  if (direction === 'LONG') {
    if (rsi > 30 && rsi < 60)    { score += 1; why.push('RSI healthy for long +1'); }
    if (macd?.hist > 0)          { score += 1; why.push('MACD positive +1'); }
    if (bb?.pct < 40)            { score += 1; why.push('BB low pullback +1'); }
  } else {
    if (rsi > 40 && rsi < 70)    { score += 1; why.push('RSI healthy for short +1'); }
    if (macd?.hist < 0)          { score += 1; why.push('MACD negative +1'); }
    if (bb?.pct > 60)            { score += 1; why.push('BB high pullback +1'); }
  }

  // ── Liquidity sweep (max 2 pts) ──
  if (sweep?.swept && sweep.direction === dirBias) { score += 2; why.push('Liquidity sweep +2'); }

  // ── Regime bonus ──
  if (regime?.trending) { score += 1; why.push('Trending regime +1'); }

  // ── Divergence penalty ──
  if (direction === 'LONG'  && divergence?.bearish) { score -= 3; why.push('Bearish divergence -3'); }
  if (direction === 'SHORT' && divergence?.bullish) { score -= 3; why.push('Bullish divergence -3'); }

  return { score, why, maxScore: 28 };
};

// ─── ADAPTIVE ENTRY LOCATION ──────────────────────────────────────────────────
const isGoodEntryLocation = (direction, { last, ema21, atr, smc, h4, srZones }) => {
  if (!ema21 || !atr) return { valid: true, reason: 'No EMA data — allowing entry' };

  // Adaptive multiplier based on H4 strength
  const multiplier =
    h4?.strength === 'STRONG' ? 2.5 :
    h4?.strength === 'MEDIUM' ? 1.5 : 0.8;

  const distance   = Math.abs(last - ema21);
  const maxDist    = atr * multiplier;
  const nearEMA    = distance <= maxDist;

  // Also valid if at OB/FVG or S/R zone
  const atOB =
    (direction === 'LONG'  && smc?.bullishOB && last >= smc.bullishOB.low && last <= smc.bullishOB.high * 1.002) ||
    (direction === 'SHORT' && smc?.bearishOB && last >= smc.bearishOB.low * 0.998 && last <= smc.bearishOB.high);

  const atFVG =
    (direction === 'LONG'  && smc?.bullishFVG && last >= smc.bullishFVG.bottom && last <= smc.bullishFVG.top) ||
    (direction === 'SHORT' && smc?.bearishFVG && last >= smc.bearishFVG.bottom && last <= smc.bearishFVG.top);

  const atSR = !!srZones?.atZone || !!srZones?.nearZone;

  const valid = nearEMA || atOB || atFVG || atSR;
  const reason = nearEMA ? `Near EMA21 (${(distance/atr).toFixed(1)}x ATR)` : atOB ? 'Inside Order Block' : atFVG ? 'Inside FVG' : atSR ? 'At S/R zone' : `Too far from EMA21 (${(distance/atr).toFixed(1)}x ATR)`;

  return { valid, reason, nearEMA, atOB, atFVG, atSR, multiplier };
};

// ─── MASTER BRAIN v4 ─────────────────────────────────────────────────────────
const analyzeStrategies = (prices) => {
  if (!prices || prices.length < 50) return null;

  const rsi  = calcRSI(prices);
  const macd = calcMACD(prices);
  const bb   = calcBollinger(prices);
  const atr  = calcATR(prices);

  const ema9   = calcEMA(prices, 9);
  const ema21  = calcEMA(prices, 21);
  const ema50  = calcEMA(prices, 50);
  const ema200 = prices.length >= 200 ? calcEMA(prices, 200) : null;

  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];

  if (!ema9 || !ema21 || !ema50 || !atr) return null;

  const trendEMA  = ema200 || ema50;
  const bullTrend = last > trendEMA;
  const bearTrend = last < trendEMA;

  // ── Step 1: Base indicator scores ──
  const scores = {
    RSI:         rsi < 30 ? 90 : rsi < 40 ? 70 : rsi > 70 ? 10 : rsi > 60 ? 30 : 50,
    MACD:        macd.hist > 0 && macd.macd > macd.signal ? 80 : macd.hist < 0 && macd.macd < macd.signal ? 20 : macd.hist > 0 ? 65 : macd.hist < 0 ? 35 : 50,
    Bollinger:   bb.pct < 15 ? 85 : bb.pct < 30 ? 65 : bb.pct > 85 ? 15 : bb.pct > 70 ? 35 : 50,
    "EMA Cloud": ema9 > ema21 && ema21 > ema50 ? 85 : ema9 < ema21 && ema21 < ema50 ? 15 : ema9 > ema21 ? 65 : ema9 < ema21 ? 35 : 50,
    Trend:       bullTrend ? 75 : bearTrend ? 25 : 50,
    Momentum:    (last - prev) > atr * 0.5 ? 75 : (last - prev) < -atr * 0.5 ? 25 : 50,
  };

  Object.keys(scores).forEach(k => { scores[k] = Math.min(95, Math.max(5, Math.round(scores[k]))); });

  const bullCount = Object.values(scores).filter(s => s >= 60).length;
  const bearCount = Object.values(scores).filter(s => s <= 40).length;

  let direction = "NEUTRAL";
  if (bullCount >= 3) direction = "LONG";
  else if (bearCount >= 3) direction = "SHORT";

  // RSI extreme filter
  if (direction === "LONG"  && rsi > 75) direction = "NEUTRAL";
  if (direction === "SHORT" && rsi < 25) direction = "NEUTRAL";

  // Anti-chase (only block if ALL 5 candles same direction — less strict)
  if (direction !== "NEUTRAL" && prices.length >= 5) {
    const moves = [];
    for (let i = prices.length - 4; i < prices.length; i++) moves.push(prices[i] - prices[i-1]);
    if (direction === "LONG"  && moves.every(m => m > atr * 0.3)) direction = "NEUTRAL";
    if (direction === "SHORT" && moves.every(m => m < -atr * 0.3)) direction = "NEUTRAL";
  }

  // ── Step 2: Collect all context ──
  const h4      = calcH4Bias(prices.h4Candles);
  const d1      = calcDailyTrend(prices.d1Candles);
  const m15     = calcM15Bias(prices.m15Candles);
  const regime  = calcVolatilityRegime(prices.candles, atr, last);
  const instType = prices.instType || "FOREX";
  const volatility = calcVolatilityFilter(atr, last, instType);

  // Volatility still hard gate — don't trade in dead or explosive markets
  if (!volatility.healthy) direction = "NEUTRAL";

  const dirBias = direction === "LONG" ? "BULLISH" : direction === "SHORT" ? "BEARISH" : null;

  // ── Step 3: H4 must not contradict ──
  // Only hard block if H4 is STRONG in opposite direction
  if (direction !== "NEUTRAL" && h4.bias && h4.bias !== dirBias && h4.strength === "STRONG") {
    direction = "NEUTRAL";
  }

  // D1 soft filter — only block if D1 confirmed opposite trend
  if (direction === "LONG"  && d1.trend === "DOWN" && d1.reason?.includes("confirmed")) direction = "NEUTRAL";
  if (direction === "SHORT" && d1.trend === "UP"   && d1.reason?.includes("confirmed")) direction = "NEUTRAL";

  const dirBias2 = direction === "LONG" ? "BULLISH" : direction === "SHORT" ? "BEARISH" : null;

  // ── Step 4: SMC (soft — scores points, not hard gate) ──
  let smc = null;
  if (direction !== "NEUTRAL" && prices.candles && prices.candles.length >= 30) {
    smc = getSMCConfirmation(prices.candles, direction);
  }

  // ── Step 5: Pattern detection ──
  const patterns = prices.candles ? detectPatterns(prices.candles) : null;

  // Hard pattern conflict: if strong reversal pattern against direction
  if (direction === "LONG"  && patterns?.bias === "BEARISH" && patterns.bearPatterns >= 2) direction = "NEUTRAL";
  if (direction === "SHORT" && patterns?.bias === "BULLISH" && patterns.bullPatterns >= 2) direction = "NEUTRAL";

  // ── Step 6: S/R zones ──
  const srZones   = prices.candles ? calcSRZones(prices.candles, last) : null;
  const sweep     = prices.candles ? calcLiquiditySweep(prices.candles) : { swept: false };
  const volume    = prices.candles ? calcVolumeConfirmation(prices.candles, direction) : { confirmed: false };
  const divergence = prices.candles ? calcDivergence(prices.candles, rsi) : null;
  const keyLevels = prices.candles ? calcKeyLevels(prices.candles, last) : null;

  // ── Step 7: Smart confluence scoring ──
  const confluence = direction !== "NEUTRAL" ? calcSmartConfluence(direction, {
    m15, h4, d1, smc, sweep, volume, rsi, atr, closes: prices,
    patterns, srZones, regime, divergence, bb, macd
  }) : { score: 0, why: [], maxScore: 28 };

  // Need score ≥ 8 out of 28 (much more achievable than before)
  if (direction !== "NEUTRAL" && confluence.score < 8) direction = "NEUTRAL";

  // ── Step 8: Adaptive entry location ──
  let entryLocation = { valid: true };
  if (direction !== "NEUTRAL") {
    entryLocation = isGoodEntryLocation(direction, { last, ema21, atr, smc, h4, srZones });
    if (!entryLocation.valid) direction = "NEUTRAL";
  }

  // ── Step 9: Pullback — relaxed ──
  let pullbackOk = false;
  if (direction !== "NEUTRAL" && prices.candles) {
    // Try 15% first, then 30%
    const recent = prices.candles.slice(-15);
    if (direction === "LONG") {
      const swingHigh = Math.max(...recent.map(c => c.high));
      const swingLow  = Math.min(...recent.map(c => c.low));
      const range     = swingHigh - swingLow;
      if (range > 0) {
        const retrace = (swingHigh - last) / range;
        pullbackOk = retrace >= 0.15; // relaxed from 0.30
      }
    } else {
      const swingHigh = Math.max(...recent.map(c => c.high));
      const swingLow  = Math.min(...recent.map(c => c.low));
      const range     = swingHigh - swingLow;
      if (range > 0) {
        const retrace = (last - swingLow) / range;
        pullbackOk = retrace >= 0.15;
      }
    }
    // Only block pullback if H4 is weak AND no pattern
    if (!pullbackOk && h4.strength !== "STRONG" && !patterns?.patterns?.length) {
      direction = "NEUTRAL";
    }
  }

  // ── Step 10: SL/TP ──
  const levels = direction !== "NEUTRAL"
    ? calcAdvancedLevels(direction, last, atr, prices.candles, smc)
    : null;

  const stopLoss   = levels?.stopLoss   ?? null;
  const takeProfit = levels?.fullTP     ?? null;
  const slDistance = stopLoss   != null ? Math.abs(last - stopLoss)   : null;
  const tpDistance = takeProfit != null ? Math.abs(last - takeProfit) : null;

  const multiTP = direction !== "NEUTRAL" && stopLoss
    ? calcMultiTP(direction, last, stopLoss, atr, regime)
    : null;

  // RR gate — relaxed to 1.5
  let rr = 0;
  if (direction !== "NEUTRAL" && slDistance && tpDistance) {
    rr = tpDistance / slDistance;
    if (rr < 1.5) direction = "NEUTRAL";
  }

  // Divergence hard block
  if (direction === "LONG"  && divergence?.bearish) direction = "NEUTRAL";
  if (direction === "SHORT" && divergence?.bullish) direction = "NEUTRAL";

  // ── Confidence ──
  const finalBias  = direction === "LONG" ? "BULLISH" : direction === "SHORT" ? "BEARISH" : null;
  const agreeScore = direction === "LONG" ? bullCount : direction === "SHORT" ? bearCount : 0;

  const h4Boost       = finalBias && h4.bias === finalBias ? (h4.strength === "STRONG" ? 10 : 6) : 0;
  const d1Boost       = (direction === "LONG" && d1.trend === "UP") || (direction === "SHORT" && d1.trend === "DOWN") ? 6 : 0;
  const m15Boost      = finalBias && m15.bias === finalBias ? 5 : 0;
  const patternBoost  = patterns?.bias === finalBias ? 5 : 0;
  const srBoost       = entryLocation.atSR ? 5 : entryLocation.nearEMA ? 3 : 0;
  const structBoost   = smc && (smc.bos || smc.choch) ? 4 : 0;
  const sweepBoost    = finalBias && sweep.swept && sweep.direction === finalBias ? 4 : 0;
  const regimeBoost   = regime.trending ? 3 : 0;

  const confidence = direction === "NEUTRAL" ? 50 : Math.min(95, Math.max(
    55,
    Math.round(
      40 + agreeScore * 4 +
      h4Boost + d1Boost + m15Boost +
      patternBoost + srBoost + structBoost +
      sweepBoost + regimeBoost
    )
  ));

  const activePattern = patterns?.patterns?.[0] || null;

  return {
    scores, direction, confidence,
    rsi, macd, bb, atr,
    ema9, ema21, ema50, ema200,
    stopLoss, takeProfit, slDistance, tpDistance, rr,
    bullTrend, bearTrend,
    smc, m15, h4, d1,
    sweep, volume, divergence,
    confluence,
    volatility, regime,
    keyLevels, srZones, patterns,
    levels, multiTP,
    pullbackOk, entryLocation,
    activePattern,
    reason: direction === "NEUTRAL"
      ? "No trade setup meets all filters"
      : `${h4.strength || ""} H4 ${h4.bias || ""} + ${activePattern ? activePattern.type : d1.trend + " D1"} confirmed`,
    debug: {
      longScore:       bullCount,
      shortScore:      bearCount,
      h4Bias:          h4.bias,
      h4Strength:      h4.strength,
      d1Trend:         d1.trend,
      regime:          regime.regime,
      adx:             regime.adx,
      confluenceScore: confluence.score,
      confluenceWhy:   confluence.why,
      patterns:        patterns?.patterns?.map(p => p.type) || [],
      atSRZone:        !!entryLocation.atSR,
      inKillZone:      (() => { const s = getSessionInfo(); return s.isLondon || s.isNY; })(),
      rawDirection:    bullCount >= 3 ? "LONG" : bearCount >= 3 ? "SHORT" : "NEUTRAL",
      atrPct:          atr && last ? (atr / last) * 100 : 0,
      bbWidth:         bb ? bb.std : 0,
      longReasons:     Object.entries(scores).filter(([,v]) => v >= 60).map(([k,v]) => `${k}: ${v}`),
      shortReasons:    Object.entries(scores).filter(([,v]) => v <= 40).map(([k,v]) => `${k}: ${v}`),
    },
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
  const [h4Candles, setH4Candles]            = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
  const [d1Candles, setD1Candles]            = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
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
    // REPLACE your existing fetchBrokerCandles function with this version
// It adds H4 and D1 candle fetching alongside M1 and M15

const fetchBrokerCandles = async (instId) => {
  const symbol = symbolMap[instId];
  try {
    // M1 candles (signal engine)
    const r = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=M1&limit=200`);
    const d = await r.json();
    if (d.candles && d.candles.length >= 50) {
      setBrokerCandles(prev => ({ ...prev, [instId]: d.candles }));
      const lastClose = d.candles[d.candles.length - 1].close;
      if (Number.isFinite(lastClose)) {
        setPrices(prev => {
          setPrevPrices(pp => ({ ...pp, [instId]: prev[instId] }));
          return { ...prev, [instId]: lastClose };
        });
      }
    } else {
      addLog(`${symbol} M1 candles unavailable`, "warn");
      setPrices(prev => ({ ...prev, [instId]: null }));
      setBrokerCandles(prev => ({ ...prev, [instId]: [] }));
      setM15Candles(prev => ({ ...prev, [instId]: [] }));
      setH4Candles(prev => ({ ...prev, [instId]: [] }));
      setD1Candles(prev => ({ ...prev, [instId]: [] }));
      setSignals(prev => { const n = {...prev}; delete n[instId]; return n; });
    }

    // M15 candles (HTF bias)
    try {
      const r15 = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=M15&limit=100`);
      const d15 = await r15.json();
      if (d15.candles && d15.candles.length >= 20) {
        setM15Candles(prev => ({ ...prev, [instId]: d15.candles }));
      }
    } catch(e) {}

    // H4 candles (NEW — catches big moves like SignalXpert +550 pip Gold)
    try {
      const r4 = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=H4&limit=100`);
      const d4 = await r4.json();
      if (d4.candles && d4.candles.length >= 20) {
        setH4Candles(prev => ({ ...prev, [instId]: d4.candles }));
      }
    } catch(e) {}

    // D1 candles (NEW — daily trend filter, no counter-trend trades)
    try {
      const rd = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=D1&limit=30`);
      const dd = await rd.json();
      if (dd.candles && dd.candles.length >= 10) {
        setD1Candles(prev => ({ ...prev, [instId]: dd.candles }));
      }
    } catch(e) {}

  } catch(e) {
    addLog(`${symbol} candles error`, "warn");
    setPrices(prev => ({ ...prev, [instId]: null }));
    setBrokerCandles(prev => ({ ...prev, [instId]: [] }));
    setM15Candles(prev => ({ ...prev, [instId]: [] }));
    setH4Candles(prev => ({ ...prev, [instId]: [] }));
    setD1Candles(prev => ({ ...prev, [instId]: [] }));
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
  // REPLACE your existing signal calculation useEffect with this version
// Passes H4 and D1 candles to the brain

useEffect(() => {
  const newSignals = {};
  INSTRUMENTS.forEach(inst => {
    const candles = brokerCandles[inst.id];
    if (!candles || candles.length < 50) return;
    const closes        = candles.map(c => c.close);
    closes.candles      = candles;
    closes.m15Candles   = m15Candles[inst.id]  || [];
    closes.h4Candles    = h4Candles[inst.id]   || [];  // NEW
    closes.d1Candles    = d1Candles[inst.id]   || [];  // NEW
    closes.instType     = inst.type;
    const sig = analyzeStrategies(closes);
    if (sig) newSignals[inst.id] = sig;
  });
  setSignals(newSignals);
}, [brokerCandles, m15Candles, h4Candles, d1Candles]);

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

  // ─── ADD THIS FUNCTION before the useEffect section ───────────────────────────
// Place it right after fetchClosedTrades

const manageTrades = useCallback(async () => {
  if (openPositions.length === 0) return;

  // Build position list with TP levels from signals
  const managed = openPositions.map(pos => {
    const raw = (pos.symbol || '').toUpperCase();
    const instId =
      raw.startsWith('BTCUSD') ? 'BTCUSDT' :
      raw.startsWith('XAUUSD') ? 'XAUUSD'  :
      raw.startsWith('GBPUSD') ? 'GBPUSD'  : null;

    const sig = instId ? signals[instId] : null;
    const multiTP = sig?.multiTP;

    return {
      id:           pos.id || pos.positionId,
      symbol:       pos.symbol,
      openPrice:    pos.openPrice,
      currentPrice: pos.currentPrice,
      stopLoss:     pos.stopLoss,
      volume:       pos.volume,
      direction:    pos.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT',
      tp1:          multiTP?.tp1      ?? null,
      tp2:          multiTP?.tp2      ?? null,
      tp3:          multiTP?.tp3      ?? null,
      breakeven:    multiTP?.breakeven ?? pos.openPrice,
      atr:          sig?.atr          ?? null,
    };
  }).filter(p => p.id && p.tp1);

  if (managed.length === 0) return;

  try {
    const r = await fetch('/api/manage-trades', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ positions: managed }),
    });
    const d = await r.json();

    if (d.managed && d.managed.length > 0) {
      d.managed.forEach(m => {
        m.actions.forEach(a => {
          if (a.type === 'PARTIAL_CLOSE_TP1')  addLog(`TP1 hit: ${m.symbol} — closed 50% @ ${a.price?.toFixed(2)} | SL → breakeven`, 'success');
          if (a.type === 'PARTIAL_CLOSE_TP2')  addLog(`TP2 hit: ${m.symbol} — closed 30% @ ${a.price?.toFixed(2)} | trailing SL`, 'success');
          if (a.type === 'FULL_CLOSE_TP3')     addLog(`TP3 hit: ${m.symbol} — closed remaining 20% @ ${a.price?.toFixed(2)} 🎯`, 'success');
          if (a.type === 'SL_TO_BREAKEVEN')    addLog(`${m.symbol} SL moved to breakeven @ ${a.level?.toFixed(2)}`, 'info');
          if (a.type === 'SL_TRAIL_AT_TP2')    addLog(`${m.symbol} SL trailing @ ${a.level?.toFixed(2)}`, 'info');
        });
      });
      // Refresh positions after management
      setTimeout(fetchLiveTrades, 1500);
      setTimeout(fetchClosedTrades, 3000);
    }
  } catch(e) {
    // Silent fail — trade management is best-effort
  }
}, [openPositions, signals, addLog, fetchLiveTrades, fetchClosedTrades]);


useEffect(() => {
  if (openPositions.length === 0) return;
  // Run trade manager every 30 seconds when positions are open
  const interval = setInterval(manageTrades, 30000);
  // Also run immediately when positions change
  manageTrades();
  return () => clearInterval(interval);
}, [openPositions, manageTrades]);

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
        <div style={styles.statBox}><span style={styles.statLabel}>Net P&L</span><span style={{ ...styles.statValue, color: (totalPnl||0) >= 0 ? "#3fb950" : "#f85149" }}>${(totalPnl||0).toFixed(2)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Balance</span><span style={{ ...styles.statValue, color: "#58a6ff" }}>{accountBalance != null ? `$${accountBalance.toFixed(0)}` : "Loading..."}</span></div>
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
                {/* PATTERNS — v4 NEW */}
                {sig.patterns && sig.patterns.patterns && sig.patterns.patterns.length > 0 && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "10px" }}>PATTERN RECOGNITION</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      {sig.patterns.patterns.map((p, i) => (
                        <div key={i} style={{ background: p.bias === "BULLISH" ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)", border: `1px solid ${p.bias === "BULLISH" ? "#3fb95040" : "#f8514940"}`, padding: "8px 12px", borderRadius: "6px" }}>
                          <div style={{ fontWeight: "700", fontSize: "11px", color: p.bias === "BULLISH" ? "#3fb950" : "#f85149" }}>{p.type.replace(/_/g, " ")}</div>
                          <div style={{ color: "#8b949e", fontSize: "9px", marginTop: "2px" }}>{p.bias} {p.broken ? "— BROKEN ✅" : "— forming"}</div>
                          {p.neckline && <div style={{ color: "#e3b341", fontSize: "9px" }}>Neckline: {p.neckline?.toFixed ? p.neckline.toFixed(4) : p.neckline}</div>}
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: "8px", fontSize: "10px", color: sig.patterns.bias === "BULLISH" ? "#3fb950" : sig.patterns.bias === "BEARISH" ? "#f85149" : "#8b949e" }}>
                      Overall pattern bias: {sig.patterns.bias || "NEUTRAL"} ({sig.patterns.bullPatterns} bull / {sig.patterns.bearPatterns} bear)
                    </div>
                  </div>
                )}

                {/* S/R ZONES — v4 NEW */}
                {sig.srZones && sig.srZones.zones && sig.srZones.zones.length > 0 && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "10px" }}>SMART S/R ZONES</div>
                    {sig.srZones.atZone && (
                      <div style={{ background: "rgba(88,166,255,0.1)", border: "1px solid #58a6ff40", padding: "8px", borderRadius: "6px", marginBottom: "8px" }}>
                        <span style={{ color: "#58a6ff", fontWeight: "700", fontSize: "11px" }}>⚡ AT ZONE: </span>
                        <span style={{ color: "#c9d1d9", fontSize: "11px" }}>{sig.srZones.atZone.type} @ {sig.srZones.atZone.price?.toFixed ? sig.srZones.atZone.price.toFixed(4) : sig.srZones.atZone.price} (strength: {sig.srZones.atZone.strength})</span>
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                      {sig.srZones.zones.slice(0, 6).map((z, i) => (
                        <div key={i} style={{ background: "#161b22", padding: "6px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: "9px", color: z.type === "RESISTANCE" ? "#f85149" : z.type === "SUPPORT" ? "#3fb950" : "#58a6ff" }}>{z.type}</span>
                          <span style={{ fontSize: "10px", fontWeight: "700" }}>{z.price?.toFixed ? z.price.toFixed(4) : z.price}</span>
                          <span style={{ fontSize: "9px", color: "#8b949e" }}>×{z.strength}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* CONFLUENCE WHY — v4 upgrade */}
                {sig.confluence && sig.confluence.why && sig.confluence.why.length > 0 && (
                  <div style={styles.card}>
                    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "10px" }}>CONFLUENCE BREAKDOWN</div>
                    <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "10px" }}>
                      <div style={{ fontSize: "32px", fontWeight: "800", color: sig.confluence.score >= 12 ? "#3fb950" : sig.confluence.score >= 8 ? "#e3b341" : "#f85149" }}>
                        {sig.confluence.score}<span style={{ fontSize: "16px", color: "#8b949e" }}>/{sig.confluence.maxScore}</span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ height: "6px", background: "#21262d", borderRadius: "3px" }}>
                          <div style={{ height: "100%", borderRadius: "3px", width: `${Math.min(100, (sig.confluence.score / sig.confluence.maxScore) * 100)}%`, background: sig.confluence.score >= 12 ? "#3fb950" : sig.confluence.score >= 8 ? "#e3b341" : "#f85149" }} />
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {sig.confluence.why.map((w, i) => (
                        <span key={i} style={{ background: w.includes("-") ? "rgba(248,81,73,0.1)" : "rgba(63,185,80,0.1)", color: w.includes("-") ? "#f85149" : "#3fb950", border: `1px solid ${w.includes("-") ? "#f8514940" : "#3fb95040"}`, padding: "2px 8px", borderRadius: "10px", fontSize: "10px" }}>{w}</span>
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

                

{/* H4 BIAS — NEW */}
{sig.h4 && (
  <div style={styles.card}>
    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "8px" }}>H4 HIGHER TIMEFRAME BIAS</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px" }}>
      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
        <div style={{ color: "#8b949e", fontSize: "9px" }}>H4 BIAS</div>
        <div style={{ fontWeight: "700", color: sig.h4.bias === "BULLISH" ? "#3fb950" : sig.h4.bias === "BEARISH" ? "#f85149" : "#8b949e" }}>
          {sig.h4.bias || "UNCLEAR"}
        </div>
      </div>
      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
        <div style={{ color: "#8b949e", fontSize: "9px" }}>STRENGTH</div>
        <div style={{ fontWeight: "700", color: sig.h4.strength === "STRONG" ? "#3fb950" : sig.h4.strength === "MEDIUM" ? "#e3b341" : "#8b949e" }}>
          {sig.h4.strength || "—"}
        </div>
      </div>
      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
        <div style={{ color: "#8b949e", fontSize: "9px" }}>H4 EMA20</div>
        <div style={{ fontWeight: "700" }}>{sig.h4.ema20?.toFixed(2) || "—"}</div>
      </div>
      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
        <div style={{ color: "#8b949e", fontSize: "9px" }}>H4 EMA200</div>
        <div style={{ fontWeight: "700" }}>{sig.h4.ema200?.toFixed(2) || "—"}</div>
      </div>
    </div>
    <div style={{ marginTop: "8px", color: "#8b949e", fontSize: "10px", fontStyle: "italic" }}>{sig.h4.reason}</div>
  </div>
)}

{/* D1 TREND — NEW */}
{sig.d1 && (
  <div style={styles.card}>
    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "8px" }}>DAILY TREND FILTER</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
        <div style={{ color: "#8b949e", fontSize: "9px" }}>D1 TREND</div>
        <div style={{ fontWeight: "700", color: sig.d1.trend === "UP" ? "#3fb950" : sig.d1.trend === "DOWN" ? "#f85149" : "#e3b341" }}>
          {sig.d1.trend || "RANGING"}
        </div>
      </div>
      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
        <div style={{ color: "#8b949e", fontSize: "9px" }}>D1 EMA10</div>
        <div style={{ fontWeight: "700" }}>{sig.d1.ema10?.toFixed(2) || "—"}</div>
      </div>
      <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
        <div style={{ color: "#8b949e", fontSize: "9px" }}>D1 EMA20</div>
        <div style={{ fontWeight: "700" }}>{sig.d1.ema20?.toFixed(2) || "—"}</div>
      </div>
    </div>
    <div style={{ marginTop: "8px", color: "#8b949e", fontSize: "10px", fontStyle: "italic" }}>{sig.d1.reason}</div>
  </div>
)}

{/* REGIME + DIVERGENCE — NEW */}
{(sig.regime || sig.divergence) && (
  <div style={styles.card}>
    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "8px" }}>MARKET REGIME & DIVERGENCE</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
      {sig.regime && (
        <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
          <div style={{ color: "#8b949e", fontSize: "9px" }}>REGIME (ADX)</div>
          <div style={{ fontWeight: "700", color: sig.regime.trending ? "#3fb950" : sig.regime.ranging ? "#e3b341" : "#58a6ff" }}>
            {sig.regime.regime}
          </div>
          <div style={{ color: "#8b949e", fontSize: "9px", marginTop: "2px" }}>ADX: {sig.regime.adx ?? "—"}</div>
        </div>
      )}
      {sig.divergence && (
        <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
          <div style={{ color: "#8b949e", fontSize: "9px" }}>DIVERGENCE</div>
          <div style={{ fontWeight: "700", fontSize: "11px", color: sig.divergence.bearish ? "#f85149" : sig.divergence.bullish ? "#3fb950" : "#8b949e" }}>
            {sig.divergence.bearish ? "⚠️ Bearish" : sig.divergence.bullish ? "✅ Bullish" : sig.divergence.hiddenBull ? "Hidden Bull" : sig.divergence.hiddenBear ? "Hidden Bear" : "None"}
          </div>
        </div>
      )}
      {sig.keyLevels && (
        <div style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
          <div style={{ color: "#8b949e", fontSize: "9px" }}>KEY LEVEL</div>
          <div style={{ fontWeight: "700", color: sig.keyLevels.nearKey ? "#3fb950" : "#8b949e" }}>
            {sig.keyLevels.nearKey ? "✅ Near level" : "Away from level"}
          </div>
          {sig.keyLevels.closestResistance && <div style={{ fontSize: "9px", color: "#f85149" }}>R: {fmt(selected, sig.keyLevels.closestResistance.level)}</div>}
          {sig.keyLevels.closestSupport    && <div style={{ fontSize: "9px", color: "#3fb950" }}>S: {fmt(selected, sig.keyLevels.closestSupport.level)}</div>}
        </div>
      )}
    </div>
  </div>
)}

{/* MULTI-TP LEVELS — NEW */}
{sig.multiTP && sig.direction !== "NEUTRAL" && (
  <div style={styles.card}>
    <div style={{ color: "#8b949e", fontSize: "10px", marginBottom: "10px" }}>MULTI-TP LEVELS (Like SignalXpert)</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: "8px" }}>
      {[
        ["Stop Loss",  sig.multiTP.stopLoss,  "#f85149", "Exit 100%"],
        ["TP1 (1:1)",  sig.multiTP.tp1,       "#e3b341", "Close 50%"],
        ["TP2 (1:2.5)",sig.multiTP.tp2,       "#58a6ff", "Close 30%"],
        ["TP3 (1:4)",  sig.multiTP.tp3,       "#3fb950", "Let 20% run"],
        ["Breakeven",  sig.multiTP.breakeven, "#8b949e", "After TP1"],
      ].map(([label, val, color, sub]) => (
        <div key={label} style={{ background: "#161b22", padding: "8px", borderRadius: "6px" }}>
          <div style={{ color: "#8b949e", fontSize: "9px" }}>{label}</div>
          <div style={{ fontWeight: "700", fontSize: "12px", color }}>{val ? fmt(selected, val) : "—"}</div>
          <div style={{ color: "#484f58", fontSize: "9px", marginTop: "2px" }}>{sub}</div>
        </div>
      ))}
    </div>
    <div style={{ marginTop: "8px", color: "#8b949e", fontSize: "10px" }}>
      Risk: {sig.multiTP.risk ? fmt(selected, sig.multiTP.risk) : "—"} pts |
      Trail by: {sig.multiTP.trailBy ? fmt(selected, sig.multiTP.trailBy) : "—"} pts |
      {sig.regime?.trending ? " 🔥 TRENDING — wider TPs active" : " ↔️ Normal TPs"}
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