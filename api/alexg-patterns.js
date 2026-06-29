/* eslint-disable */
// api/alexg-patterns.js
//
// ALEX G — "Full Set & Forget" strategy — PATTERN DETECTORS
// ============================================================================
// Detects the two confluence families the grade was missing, so Layer 4 can
// score the FULL PDF checklist instead of a subset:
//   1. Candlestick rejection formations (at an AOI)   — PDF l.~660-790
//   2. Chart patterns: Head & Shoulders (+inverse),
//      Double Top / Double Bottom                      — PDF l.~700-790
//
// Pure functions over candle arrays / pivot arrays. No I/O. Direction-aware:
// 'long' wants BULLISH rejections / bottoming patterns; 'short' wants bearish.
// Tolerances are ATR- or range-relative so the same code works on every asset.
// ----------------------------------------------------------------------------

const CFG = {
  dojiBodyFrac:   0.10,  // body <= 10% of range => doji-class
  pinWickMult:    2.0,   // dominant wick >= 2x body => pin/hammer
  pinOppWickFrac: 0.35,  // opposite wick <= 35% of range
  bodyZoneFrac:   0.55,  // hammer body must sit in the top (bull) / bottom (bear) portion
  tweezerTolFrac: 0.12,  // equal highs/lows within 12% of range
  haramiBodyMult: 2.0,   // prior body >= 2x current body for harami
  starBigFrac:    0.45,  // star: outer candles' body >= 45% of their range
  starSmallFrac:  0.30,  // star: middle body <= 30% of its range
  patternTolAtr:  0.55,  // "equal" highs/lows within this many ATRs (chart patterns)
  scan:           3,     // how many recent candles to scan for a rejection
};

// ─── candle geometry ────────────────────────────────────────────────
function geo(c) {
  const o = c.open, cl = c.close, h = c.high, l = c.low;
  const range = (h - l) || 1e-9;
  return {
    o, cl, h, l, range,
    body: Math.abs(cl - o),
    upper: h - Math.max(o, cl),
    lower: Math.min(o, cl) - l,
    maxOC: Math.max(o, cl), minOC: Math.min(o, cl),
    bull: cl > o, bear: cl < o,
  };
}

// ─── single-candle rejections ───────────────────────────────────────
function bullishSingle(c) {
  const g = geo(c);
  if (g.body <= CFG.dojiBodyFrac * g.range && g.lower >= 0.6 * g.range && g.upper <= 0.15 * g.range) return 'dragonfly-doji';
  if (g.lower >= CFG.pinWickMult * Math.max(g.body, 1e-9) && g.upper <= CFG.pinOppWickFrac * g.range && g.maxOC >= g.l + CFG.bodyZoneFrac * g.range) return 'hammer';
  if (g.body <= CFG.dojiBodyFrac * g.range) return 'doji';
  return null;
}
function bearishSingle(c) {
  const g = geo(c);
  if (g.body <= CFG.dojiBodyFrac * g.range && g.upper >= 0.6 * g.range && g.lower <= 0.15 * g.range) return 'gravestone-doji';
  if (g.upper >= CFG.pinWickMult * Math.max(g.body, 1e-9) && g.lower <= CFG.pinOppWickFrac * g.range && g.minOC <= g.h - CFG.bodyZoneFrac * g.range) return 'shooting-star';
  if (g.body <= CFG.dojiBodyFrac * g.range) return 'doji';
  return null;
}

// ─── two-candle rejections ──────────────────────────────────────────
function bullishPair(c, p) {
  const gc = geo(c), gp = geo(p);
  if (gc.bull && gp.bear && gc.cl >= gp.o && gc.o <= gp.cl) return 'bullish-engulfing';
  if (gp.bear && gc.bull && Math.abs(gp.l - gc.l) <= CFG.tweezerTolFrac * Math.max(gp.range, gc.range)) return 'tweezer-bottom';
  if (gp.bear && gp.body >= CFG.haramiBodyMult * Math.max(gc.body, 1e-9) && gc.maxOC <= gp.maxOC && gc.minOC >= gp.minOC) return 'bullish-harami';
  return null;
}
function bearishPair(c, p) {
  const gc = geo(c), gp = geo(p);
  if (gc.bear && gp.bull && gc.cl <= gp.o && gc.o >= gp.cl) return 'bearish-engulfing';
  if (gp.bull && gc.bear && Math.abs(gp.h - gc.h) <= CFG.tweezerTolFrac * Math.max(gp.range, gc.range)) return 'tweezer-top';
  if (gp.bull && gp.body >= CFG.haramiBodyMult * Math.max(gc.body, 1e-9) && gc.maxOC <= gp.maxOC && gc.minOC >= gp.minOC) return 'bearish-harami';
  return null;
}

// ─── three-candle stars ─────────────────────────────────────────────
function bullishTriple(a, b, c) {
  const ga = geo(a), gb = geo(b), gc = geo(c);
  if (ga.bear && ga.body >= CFG.starBigFrac * ga.range
    && gb.body <= CFG.starSmallFrac * gb.range
    && gc.bull && gc.cl > (ga.o + ga.cl) / 2) return 'morning-star';
  return null;
}
function bearishTriple(a, b, c) {
  const ga = geo(a), gb = geo(b), gc = geo(c);
  if (ga.bull && ga.body >= CFG.starBigFrac * ga.range
    && gb.body <= CFG.starSmallFrac * gb.range
    && gc.bear && gc.cl < (ga.o + ga.cl) / 2) return 'evening-star';
  return null;
}

// Detect any direction-appropriate rejection in the last `scan` candles.
// If `zone` given, the rejection candle's wick must touch the zone (so it's
// genuinely "at the AOI").
function detectCandleRejection(candles, direction, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 2) return { found: false, type: null, idx: -1 };
  const scan = opts.scan != null ? opts.scan : CFG.scan;
  const zone = opts.zone || null;
  const single = direction === 'long' ? bullishSingle : bearishSingle;
  const pair = direction === 'long' ? bullishPair : bearishPair;
  const triple = direction === 'long' ? bullishTriple : bearishTriple;
  const n = candles.length;
  const inZone = (c) => !zone || (c.high >= zone.lo && c.low <= zone.hi);

  for (let i = n - 1; i >= Math.max(0, n - scan); i--) {
    const c = candles[i];
    if (!inZone(c)) continue;
    let t = single(c);
    if (!t && i >= 1) t = pair(c, candles[i - 1]);
    if (!t && i >= 2) t = triple(candles[i - 2], candles[i - 1], c);
    if (t) return { found: true, type: t, idx: i };
  }
  return { found: false, type: null, idx: -1 };
}

// ─── chart patterns from swing pivots ───────────────────────────────
// pivots: alternating {type:'H'|'L', close, ...} (from alexg-bias.buildStructure)
function detectChartPattern(pivots, direction, lastClose, atrVal, opts = {}) {
  if (!Array.isArray(pivots) || pivots.length < 3 || !(atrVal > 0)) return { found: false, type: null };
  const tol = (opts.patternTolAtr != null ? opts.patternTolAtr : CFG.patternTolAtr) * atrVal;
  const P = pivots;
  const last = (t, before) => { for (let i = P.length - 1; i >= 0; i--) if (P[i].type === t && (before == null || P[i].idx < before)) return P[i]; return null; };

  if (direction === 'long') {
    // Double Bottom: ...L1, H1, L2 with L1~L2 and price reclaiming above H1.
    const L2 = last('L', null);
    const H1 = L2 ? last('H', L2.idx) : null;
    const L1 = H1 ? last('L', H1.idx) : null;
    if (L1 && H1 && L2 && Math.abs(L2.close - L1.close) <= tol && lastClose > H1.close) {
      return { found: true, type: 'double-bottom', neckline: H1.close };
    }
    // Inverse H&S: lows LS, head(lower), RS(~LS); break above the neckline highs.
    if (P.length >= 5) {
      const lows = P.filter((p) => p.type === 'L').slice(-3);
      const highs = P.filter((p) => p.type === 'H').slice(-2);
      if (lows.length === 3 && highs.length === 2) {
        const [LS, head, RS] = lows;
        const neckline = Math.min(highs[0].close, highs[1].close);
        if (head.close < LS.close - tol && head.close < RS.close - tol && Math.abs(LS.close - RS.close) <= 1.5 * tol && lastClose > neckline) {
          return { found: true, type: 'inverse-head-shoulders', neckline };
        }
      }
    }
  } else {
    // Double Top: ...H1, L1, H2 with H1~H2 and price breaking below L1.
    const H2 = last('H', null);
    const L1 = H2 ? last('L', H2.idx) : null;
    const H1 = L1 ? last('H', L1.idx) : null;
    if (H1 && L1 && H2 && Math.abs(H2.close - H1.close) <= tol && lastClose < L1.close) {
      return { found: true, type: 'double-top', neckline: L1.close };
    }
    // H&S: highs LS, head(higher), RS(~LS); break below the neckline lows.
    if (P.length >= 5) {
      const highs = P.filter((p) => p.type === 'H').slice(-3);
      const lows = P.filter((p) => p.type === 'L').slice(-2);
      if (highs.length === 3 && lows.length === 2) {
        const [LS, head, RS] = highs;
        const neckline = Math.max(lows[0].close, lows[1].close);
        if (head.close > LS.close + tol && head.close > RS.close + tol && Math.abs(LS.close - RS.close) <= 1.5 * tol && lastClose < neckline) {
          return { found: true, type: 'head-shoulders', neckline };
        }
      }
    }
  }
  return { found: false, type: null };
}

module.exports = {
  CFG, geo,
  bullishSingle, bearishSingle, bullishPair, bearishPair, bullishTriple, bearishTriple,
  detectCandleRejection, detectChartPattern,
};