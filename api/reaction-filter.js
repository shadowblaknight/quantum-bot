// =================================================================
// reaction-filter.js  ·  v14.3  (multi-timeframe, mode-aware)
//
// Real SMC reaction model across FOUR timeframes, split by trade mode:
//
//   SWING mode :  bias = [Daily, H4]      trigger = [H1, M15]
//   DAY   mode :  bias = [H4, H1]         trigger = [M15, M5]
//
// Within each PAIR the timeframes are OR-combined by default — no single
// timeframe can block the other:
//   - bias is "aligned" if EITHER higher timeframe agrees with the direction
//   - a trigger is "present" if EITHER lower timeframe shows sweep -> CHoCH
//
// Across the two groups: the trigger is the entry signal (required), and bias
// is a VOTE, not a veto — a counter-trend trigger can still pass when location
// (premium/discount) and session back it. (Combiner is switchable to 'and'.)
//
// Pure functions: the caller fetches the candle sets and passes them in.
// =================================================================

const REACTION_TEMPLATES = ['reaction', 'reaction-fvg', 'reaction-ifvg'];

const TF_SETS = {
  swing: { bias: ['1d', '4h'], trigger: ['1h', '15m'] },
  day:   { bias: ['4h', '1h'], trigger: ['15m', '5m'] },
};
function tfSetForMode(mode) { return TF_SETS[mode] || TF_SETS.day; }

function _pivots(candles, L) {
  const highs = [], lows = [];
  for (let i = L; i < candles.length - L; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= L; j++) {
      if (!(candles[i].high > candles[i - j].high && candles[i].high > candles[i + j].high)) isH = false;
      if (!(candles[i].low  < candles[i - j].low  && candles[i].low  < candles[i + j].low )) isL = false;
    }
    if (isH) highs.push({ i, price: candles[i].high });
    if (isL) lows.push({ i, price: candles[i].low });
  }
  return { highs, lows };
}

// HH+HL = bullish, LH+LL = bearish; fallback to last close vs range midpoint.
function detectBias(candles) {
  if (!Array.isArray(candles) || candles.length < 12) return null;
  const { highs, lows } = _pivots(candles, 2);
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price  > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price  < lows[lows.length - 2].price;
    if (hh && hl) return 'LONG';
    if (lh && ll) return 'SHORT';
  }
  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  const last = candles[candles.length - 1].close;
  const band = (hi - lo) * 0.1;
  if (last > (hi + lo) / 2 + band) return 'LONG';
  if (last < (hi + lo) / 2 - band) return 'SHORT';
  return null;
}

function detectSweep(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 12) return { swept: false };
  const n = candles.length, half = Math.floor(n / 2);
  const first = candles.slice(0, half), second = candles.slice(half), last = candles[n - 1];
  if (direction === 'LONG') {
    const priorLow = Math.min(...first.map((c) => c.low));
    const sweptLow = Math.min(...second.map((c) => c.low));
    if (sweptLow < priorLow && last.close > priorLow) return { swept: true, level: priorLow, extreme: sweptLow };
  } else {
    const priorHigh = Math.max(...first.map((c) => c.high));
    const sweptHigh = Math.max(...second.map((c) => c.high));
    if (sweptHigh > priorHigh && last.close < priorHigh) return { swept: true, level: priorHigh, extreme: sweptHigh };
  }
  return { swept: false };
}

function detectChoch(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 12) return { choch: false };
  const { highs, lows } = _pivots(candles, 2);
  const last = candles[candles.length - 1];
  if (direction === 'LONG') {
    if (!highs.length) return { choch: false };
    if (last.close > highs[highs.length - 1].price) return { choch: true, brokeLevel: highs[highs.length - 1].price };
  } else {
    if (!lows.length) return { choch: false };
    if (last.close < lows[lows.length - 1].price) return { choch: true, brokeLevel: lows[lows.length - 1].price };
  }
  return { choch: false };
}

function locationOK(candles, direction, entry) {
  if (!Array.isArray(candles) || candles.length < 6 || !isFinite(entry)) return null;
  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  const mid = (hi + lo) / 2;
  return direction === 'LONG' ? entry <= mid : entry >= mid;
}

function triggerOnTF(candles, direction) {
  const s = detectSweep(candles, direction);
  const c = detectChoch(candles, direction);
  return { ok: !!(s.swept && c.choch), swept: s.swept, choch: c.choch };
}

// biasCandles=[higherTF,lowerTF], triggerCandles=[higherTF,lowerTF], combine='or'|'and'
function evaluateReactionMTF({ template, direction, entry, session, mode, htfBiasAlign }, opts) {
  if (!REACTION_TEMPLATES.includes(template)) return { applies: false, pass: true };
  const biasCandles    = (opts && opts.biasCandles) || [];
  const triggerCandles = (opts && opts.triggerCandles) || [];
  const combine = (opts && opts.combine) || 'or';

  const biasVotes = biasCandles.map((c) => detectBias(c));
  const usable    = biasVotes.filter((b) => b);
  const agree     = biasVotes.filter((b) => b === direction).length;
  let biasAligned;
  if (usable.length === 0) {
    biasAligned = (htfBiasAlign == null) ? null : !!htfBiasAlign;
  } else {
    biasAligned = combine === 'and' ? (agree === usable.length) : (agree > 0);
  }

  const trigVotes = triggerCandles.map((c) => triggerOnTF(c, direction));
  const trigOk    = trigVotes.filter((t) => t.ok).length;
  const triggerPresent = combine === 'and'
    ? (triggerCandles.length > 0 && trigOk === triggerCandles.length)
    : (trigOk > 0);

  let location = null;
  for (const c of biasCandles) { const l = locationOK(c, direction, entry); if (l !== null) { location = l; break; } }
  const sessionOK = !/asia/i.test(String(session || ''));

  const checks = {
    mode, combine, biasVotes, biasAligned,
    trigVotes: trigVotes.map((t) => t.ok), triggerPresent, location, sessionOK,
  };

  if (!triggerPresent) return { applies: true, pass: false, reason: 'no-trigger-on-either-ltf', checks };
  if (biasAligned === true || biasAligned === null) return { applies: true, pass: true, reason: 'confirmed', checks };
  if (location !== false && sessionOK) return { applies: true, pass: true, reason: 'confirmed-counter-trend', checks };
  return { applies: true, pass: false, reason: 'counter-trend-no-location-or-session', checks };
}

// Back-compat single-timeframe verdict.
function evaluateReaction({ template, direction, entry, session, htfBiasAlign }, candles) {
  return evaluateReactionMTF(
    { template, direction, entry, session, mode: 'day', htfBiasAlign },
    { biasCandles: [candles], triggerCandles: [candles], combine: 'or' }
  );
}

module.exports = {
  evaluateReactionMTF, evaluateReaction,
  detectBias, detectSweep, detectChoch, locationOK, triggerOnTF,
  tfSetForMode, REACTION_TEMPLATES, TF_SETS,
};