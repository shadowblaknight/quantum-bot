/* eslint-disable */
// api/alexg-bias.js
//
// ALEX G — "Full Set & Forget" strategy — LAYER 1: BIAS ENGINE
// ============================================================================
// The brain the current bot is missing. Reads market STRUCTURE on Weekly,
// Daily and 4hr, decides each timeframe's trend, then decides whether 2
// CONSECUTIVE timeframes agree. The trade TYPE is defined by WHICH timeframes
// are in sync — not a toggle:
//        W + D in sync  => SWING   (trade from W/D zones, TP at W/D structure)
//        D + 4hr in sync => DAY    (trade from D/4hr zones)
// Consumes Layer 0 (eligibility): a structurally-clear bias on a consolidating
// or extreme-blocked pair is reported but marked NOT tradeable.
//
// MAPS DIRECTLY TO THE PDF:
//   - structure by BODY CLOSES not wicks; "snake trick" elbows  (p.~2, l.30-46)
//   - Bullish = HH+HL ; Bearish = LL+LH                          (l.40-44)
//   - trend shifts when price CLOSES below last HL / above last LH (l.48-49,61-63)
//   - mark W/D/4hr; >=2 CONSECUTIVE timeframes in sync           (l.80-88)
//   - retracement switching (W bull, D flips bear => day short)  (l.100-160)
//
// The "snake trick" is implemented as an ATR-thresholded zigzag over closing
// prices: it walks the body-closes and only records a swing point (elbow) when
// price reverses by more than (atrMult x ATR) from the running extreme. That
// filters the noise wiggles a human eye skips, leaving the clean HH/HL/LH/LL
// sequence the strategy is built on.
//
// READ-ONLY. Produces a bias verdict + the structure points that Layer 2 (AOI)
// and Layer 4 (TP targets) will consume. Trades nothing.
// ----------------------------------------------------------------------------

const { getAssetById } = require('./asset-registry');

let _fetchCandlesCached = null;
function defaultFetchCandles() {
  if (!_fetchCandlesCached) {
    try { _fetchCandlesCached = require('./candle-source').fetchCandles; } catch (_) {}
  }
  return _fetchCandlesCached;
}
let _eligCached = null;
function defaultEligibility() {
  if (!_eligCached) {
    try { _eligCached = require('./alexg-eligibility').evaluateEligibility; } catch (_) {}
  }
  return _eligCached;
}

const CFG = {
  wLookback:  90,    // Weekly candles
  dLookback:  240,   // Daily candles
  h4Lookback: 300,   // 4hr candles
  atrPeriod:  14,
  atrMult:    1.0,   // zigzag reversal threshold = atrMult x ATR (TUNABLE — sets
                     // how "significant" a swing must be to count as structure).
                     // Lowered 1.5 -> 1.0 after live validation: at 1.5 the daily
                     // read "unclear" on pairs whose weekly was clearly trending
                     // (incoherent). At 1.0 the daily resolves the real structure
                     // and agrees with the weekly; 1.0 and 0.7 give the SAME read,
                     // so the trend is robust, not threshold-noise. Downstream
                     // gates (AOI >=3 touches, shift+engulf, RR>=2, grade>=70%)
                     // still filter actual trades — this only unblocks the read.
  minPivots:  4,     // need at least this many swing points to judge a trend
};

// ─── ATR (local, simple) ────────────────────────────────────────────
function trueRanges(candles) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (![c.high, c.low, p.close].every(isFinite)) { tr.push(NaN); continue; }
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return tr;
}
function atr(candles, period = CFG.atrPeriod) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = trueRanges(candles).filter(isFinite);
  if (tr.length < period) return null;
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── The snake: ATR-thresholded zigzag over closes ──────────────────
// Returns pivot indices with type 'H' (swing high) / 'L' (swing low).
function zigzagPivots(values, threshold) {
  const piv = [];
  if (!Array.isArray(values) || values.length < 2 || !(threshold > 0)) return piv;
  // Phase 1 — unknown direction: track running max AND min from the start; the
  // first move that reverses by `threshold` from one of them sets the direction
  // and records the first pivot. (Tracking both in one variable was the bug:
  // the extreme just chased price and no reversal ever confirmed.)
  let maxV = values[0], maxI = 0, minV = values[0], minI = 0;
  let dir = 0, extVal = values[0], extIdx = 0, i = 1;
  for (; i < values.length && dir === 0; i++) {
    const v = values[i];
    if (v > maxV) { maxV = v; maxI = i; }
    if (v < minV) { minV = v; minI = i; }
    if (maxV - v >= threshold) { dir = -1; piv.push({ idx: maxI, type: 'H' }); extVal = v; extIdx = i; }
    else if (v - minV >= threshold) { dir = 1; piv.push({ idx: minI, type: 'L' }); extVal = v; extIdx = i; }
  }
  // Phase 2 — known direction: extend the leg, flip on a threshold reversal.
  for (; i < values.length; i++) {
    const v = values[i];
    if (dir > 0) {
      if (v > extVal) { extVal = v; extIdx = i; }
      else if (extVal - v >= threshold) { piv.push({ idx: extIdx, type: 'H' }); dir = -1; extVal = v; extIdx = i; }
    } else {
      if (v < extVal) { extVal = v; extIdx = i; }
      else if (v - extVal >= threshold) { piv.push({ idx: extIdx, type: 'L' }); dir = 1; extVal = v; extIdx = i; }
    }
  }
  return piv;
}

// ─── Structure for one timeframe ────────────────────────────────────
// Pivots are taken on CLOSES (body) per the strategy. Each pivot is enriched
// with the candle's high/low/body so Layer 2 can build AOI zones from them.
function buildStructure(candles, label, opts = {}) {
  const minPivots = opts.minPivots != null ? opts.minPivots : CFG.minPivots;
  if (!Array.isArray(candles) || candles.length < minPivots + 2) {
    return { ok: false, label, reason: `insufficient ${label} data (${candles ? candles.length : 0})`, trend: 'unclear' };
  }
  const closes = candles.map((c) => c.close);
  const atrVal = atr(candles);
  const atrMult = opts.atrMult != null ? opts.atrMult : CFG.atrMult;
  const threshold = (atrVal && isFinite(atrVal)) ? atrMult * atrVal : null;
  if (!threshold) return { ok: false, label, reason: `no ATR for ${label}`, trend: 'unclear' };

  const rawPiv = zigzagPivots(closes, threshold);
  if (rawPiv.length < minPivots) {
    return { ok: false, label, reason: `too few swing points on ${label} (${rawPiv.length})`, trend: 'unclear', atr: atrVal };
  }

  // Label HH/HL/LH/LL relative to the previous same-type pivot; enrich.
  let prevH = null, prevL = null;
  const pivots = rawPiv.map((p) => {
    const c = candles[p.idx];
    const o = c.open, cl = c.close;
    const node = {
      idx: p.idx, type: p.type, time: c.time,
      close: cl, high: c.high, low: c.low,
      bodyHigh: Math.max(o, cl), bodyLow: Math.min(o, cl),
      label: null,
    };
    if (p.type === 'H') { node.label = prevH == null ? 'H' : (cl > prevH.close ? 'HH' : 'LH'); prevH = node; }
    else { node.label = prevL == null ? 'L' : (cl > prevL.close ? 'HL' : 'LL'); prevL = node; }
    return node;
  });

  const last = (t, lbl) => { for (let i = pivots.length - 1; i >= 0; i--) if (pivots[i].type === t && (!lbl || pivots[i].label === lbl)) return pivots[i]; return null; };
  const lastHigh = last('H'), lastLow = last('L');
  const lastHH = last('H', 'HH'), lastLH = last('H', 'LH');
  const lastHL = last('L', 'HL'), lastLL = last('L', 'LL');
  const lastClose = closes[closes.length - 1];

  // Structural trend from the most recent high+low labels.
  let trend = 'unclear';
  if (lastHigh && lastLow) {
    if (lastHigh.label === 'HH' && lastLow.label === 'HL') trend = 'bull';
    else if (lastHigh.label === 'LH' && lastLow.label === 'LL') trend = 'bear';
  }

  // Body-close shift override (l.48-49): a confirmed close beyond the protected
  // swing flips/ças the trend even before the next labelled pivot forms.
  let shift = null;
  if (trend === 'bull' && lastHL && lastClose < lastHL.close) { trend = 'unclear'; shift = 'broke last HL — bull weakening'; }
  if (trend === 'bear' && lastLH && lastClose > lastLH.close) { trend = 'unclear'; shift = 'broke last LH — bear weakening'; }

  return {
    ok: true, label, trend, shift, atr: atrVal,
    lastClose,
    pivots,
    points: {
      lastHH: lastHH ? pick(lastHH) : null,
      lastHL: lastHL ? pick(lastHL) : null,
      lastLH: lastLH ? pick(lastLH) : null,
      lastLL: lastLL ? pick(lastLL) : null,
    },
  };
}
function pick(p) { return { idx: p.idx, time: p.time, close: p.close, high: p.high, low: p.low, bodyHigh: p.bodyHigh, bodyLow: p.bodyLow, label: p.label }; }

// ─── Bias evaluation (the sync engine) ──────────────────────────────
function agree(a, b) { return a === b && (a === 'bull' || a === 'bear'); }

async function evaluateBias(asset, opts = {}) {
  const fc = opts.fetchCandlesFn || defaultFetchCandles();
  if (typeof fc !== 'function') return { asset, tradeable: false, tradeType: null, direction: null, notes: ['candle source unavailable'], evaluatedAt: Date.now() };

  let w, d, h4;
  try {
    const [wr, dr, hr] = await Promise.all([
      fc(asset, '1w', CFG.wLookback),
      fc(asset, '1d', CFG.dLookback),
      fc(asset, '4h', CFG.h4Lookback),
    ]);
    w = (wr && wr.candles) || []; d = (dr && dr.candles) || []; h4 = (hr && hr.candles) || [];
  } catch (e) {
    return { asset, tradeable: false, tradeType: null, direction: null, notes: ['candle fetch threw: ' + e.message], evaluatedAt: Date.now() };
  }

  const sw = buildStructure(w, 'W', opts);
  const sd = buildStructure(d, 'D', opts);
  const sh4 = buildStructure(h4, '4h', opts);
  const tw = sw.trend, td = sd.trend, th4 = sh4.trend;

  // Sync — must be CONSECUTIVE timeframes (l.84-88).
  let inSync = [], tradeType = null, direction = null;
  if (agree(tw, td)) { inSync = ['W', 'D']; tradeType = 'swing'; direction = tw === 'bull' ? 'long' : 'short'; }
  else if (agree(td, th4)) { inSync = ['D', '4h']; tradeType = 'day'; direction = td === 'bull' ? 'long' : 'short'; }

  const fullStack = agree(tw, td) && agree(td, th4);

  // Retracement / counter-higher-TF context (l.100-160).
  let counterHigherTF = false, awaitingPullback = false;
  const notes = [];
  if (tradeType === 'day' && (tw === 'bull' || tw === 'bear') && ((direction === 'long') !== (tw === 'bull'))) {
    counterHigherTF = true;
    notes.push(`day ${direction} against weekly ${tw} — retracement of the weekly; TP toward the weekly AOI, treat as higher-risk`);
  }
  if (tradeType === 'swing' && (th4 === 'bull' || th4 === 'bear') && ((direction === 'long') !== (th4 === 'bull'))) {
    awaitingPullback = true;
    notes.push(`W+D ${direction} but 4hr is ${th4} — the 4hr pullback is the entry path into the ${direction === 'long' ? 'demand' : 'supply'} AOI`);
  }
  if (!tradeType) notes.push(`no 2 consecutive timeframes in sync (W:${tw} D:${td} 4h:${th4})`);
  if (sw.shift) notes.push(`W: ${sw.shift}`);
  if (sd.shift) notes.push(`D: ${sd.shift}`);

  // Layer 0 gate.
  let elig = opts.eligibility;
  if (!elig) {
    const eligFn = defaultEligibility();
    if (typeof eligFn === 'function') { try { elig = await eligFn(asset, opts); } catch (_) {} }
  }
  let tradeable = !!tradeType;
  if (elig) {
    if (!elig.eligible) { tradeable = false; notes.push('Layer0 ineligible: ' + (elig.reasons || []).join('; ')); }
    if (direction === 'long' && elig.flags && elig.flags.longBlocked) { tradeable = false; notes.push('Layer0: longs blocked at extreme'); }
    if (direction === 'short' && elig.flags && elig.flags.shortBlocked) { tradeable = false; notes.push('Layer0: shorts blocked at extreme'); }
  }

  return {
    asset,
    tradeable,
    tradeType,            // 'swing' | 'day' | null
    direction,            // 'long' | 'short' | null
    inSync,               // e.g. ['W','D']
    fullStack,            // all three aligned
    counterHigherTF,      // day trade against the weekly (retracement)
    awaitingPullback,     // swing bias waiting on the 4hr pullback into the AOI
    timeframes: {
      w:  { trend: tw, shift: sw.shift || null, ok: sw.ok, reason: sw.reason || null },
      d:  { trend: td, shift: sd.shift || null, ok: sd.ok, reason: sd.reason || null },
      h4: { trend: th4, shift: sh4.shift || null, ok: sh4.ok, reason: sh4.reason || null },
    },
    structure: {          // consumed by Layer 2 (AOI) + Layer 4 (TP)
      w: sw.ok ? sw.points : null,
      d: sd.ok ? sd.points : null,
    },
    eligibility: elig ? { eligible: elig.eligible, flags: elig.flags } : null,
    notes,
    evaluatedAt: Date.now(),
  };
}

async function evaluateUniverse(assets, opts = {}) {
  const list = (assets && assets.length) ? assets : ['gold', 'eurusd', 'gbpusd', 'usdjpy', 'nas100', 'us500', 'btc'];
  const settled = await Promise.all(list.map(async (a) => {
    try { return [a, await evaluateBias(a, opts)]; }
    catch (e) { return [a, { asset: a, tradeable: false, tradeType: null, direction: null, notes: ['threw: ' + e.message] }]; }
  }));
  const results = {}; let tradeableCount = 0;
  for (const [a, v] of settled) { results[a] = v; if (v.tradeable) tradeableCount++; }
  return { ok: true, results, tradeableCount, requested: list.length, evaluatedAt: Date.now() };
}

// ─── HTTP handler (read-only) ───────────────────────────────────────
//   GET /api/alexg-bias?asset=eurusd  → single
//   GET /api/alexg-bias               → batch
module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (q.asset) {
      if (!getAssetById(q.asset)) return res.status(400).json({ ok: false, error: 'unknown asset' });
      return res.status(200).json({ ok: true, bias: await evaluateBias(q.asset) });
    }
    const assets = q.assets ? String(q.assets).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
    return res.status(200).json(await evaluateUniverse(assets));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.evaluateBias = evaluateBias;
module.exports.evaluateUniverse = evaluateUniverse;
module.exports.buildStructure = buildStructure;
module.exports.zigzagPivots = zigzagPivots;
module.exports.atr = atr;
module.exports.CFG = CFG;