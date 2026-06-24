// =================================================================
// reaction-filter.js  ·  v14.2
// Turns the blind coil-break "tap the zone" reaction into a CONFIRMED entry,
// the way high-probability SMC/ICT reaction trades are actually structured:
//
//   1) LIQUIDITY SWEEP   — a recent swing high/low must have been swept &
//                          reclaimed first (else the zone is likely inducement).
//   2) CHoCH / MSS        — entry-timeframe structure must shift in the trade
//                          direction (break of the last opposing swing) — the
//                          "trigger" the old template never waited for.
//   3) HTF BIAS GATE      — counter-bias ("auto-counter") reactions must pass
//                          EVERY confirmation; aligned reactions need sweep+CHoCH.
//   4) PREMIUM / DISCOUNT — counter-bias longs must sit in discount, shorts in
//                          premium of the recent dealing range.
//   5) SESSION QUALITY    — counter-bias reactions in low-liquidity (Asia) are
//                          skipped; clean displacement clusters at London/NY.
//
// This is a GATE: it can only SKIP a reaction, never place one. Pure function —
// the caller supplies the candles + the Pine payload fields. No network here.
// =================================================================

const REACTION_TEMPLATES = ['reaction', 'reaction-fvg', 'reaction-ifvg'];

// fractal swing pivots (a high/low strictly beyond L bars each side)
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

// Liquidity sweep + reclaim: the 2nd half of the window pierced the prior
// extreme, then price closed back inside (a grab, not acceptance).
function detectSweep(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 12) return { swept: false };
  const n = candles.length;
  const half = Math.floor(n / 2);
  const first = candles.slice(0, half);
  const second = candles.slice(half);
  const last = candles[n - 1];
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

// Change of Character: latest close breaks the most recent opposing swing.
function detectChoch(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 12) return { choch: false };
  const { highs, lows } = _pivots(candles, 2);
  const last = candles[candles.length - 1];
  if (direction === 'LONG') {
    if (!highs.length) return { choch: false };
    const lastHigh = highs[highs.length - 1];
    if (last.close > lastHigh.price) return { choch: true, brokeLevel: lastHigh.price };
  } else {
    if (!lows.length) return { choch: false };
    const lastLow = lows[lows.length - 1];
    if (last.close < lastLow.price) return { choch: true, brokeLevel: lastLow.price };
  }
  return { choch: false };
}

// Premium/discount of the recent dealing range (true = correct half).
function locationOK(candles, direction, entry) {
  if (!Array.isArray(candles) || candles.length < 6 || !isFinite(entry)) return null;
  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  const mid = (hi + lo) / 2;
  return direction === 'LONG' ? entry <= mid : entry >= mid;
}

// Main verdict. `candles` = entry-timeframe candles (oldest→newest).
function evaluateReaction({ template, direction, entry, session, htfBiasAlign, swept: payloadSwept }, candles) {
  if (!REACTION_TEMPLATES.includes(template)) return { applies: false, pass: true };

  const aligned     = !!htfBiasAlign;
  const haveCandles = Array.isArray(candles) && candles.length >= 12;

  const sweep = haveCandles ? detectSweep(candles, direction) : { swept: !!payloadSwept };
  const choch = haveCandles ? detectChoch(candles, direction) : { choch: null };
  const loc   = haveCandles ? locationOK(candles, direction, entry) : null;
  const sessionOK = !/asia/i.test(String(session || ''));

  const checks = {
    aligned, swept: sweep.swept, choch: choch.choch,
    location: loc, sessionOK, haveCandles,
  };

  // 1) every reaction needs a liquidity sweep — no sweep = likely inducement
  if (!sweep.swept) return { applies: true, pass: false, reason: 'no-liquidity-sweep', checks };

  // 2) structure shift required whenever we can compute it
  if (haveCandles && !choch.choch) return { applies: true, pass: false, reason: 'no-structure-shift', checks };
  if (!haveCandles && !aligned)    return { applies: true, pass: false, reason: 'cannot-confirm-counter-trend', checks };

  // 3) counter-bias reactions must also be in the right location + session
  if (!aligned) {
    if (loc === false)  return { applies: true, pass: false, reason: 'counter-trend-wrong-location', checks };
    if (!sessionOK)     return { applies: true, pass: false, reason: 'counter-trend-low-liquidity-session', checks };
  }

  return {
    applies: true, pass: true, reason: 'confirmed',
    tier: aligned ? 'A' : 'B',
    checks,
    sweepExtreme: sweep.extreme != null ? sweep.extreme : null,
  };
}

module.exports = { evaluateReaction, detectSweep, detectChoch, locationOK, REACTION_TEMPLATES };