/* eslint-disable */
// api/alexg-entry.js
//
// ALEX G — "Full Set & Forget" strategy — LAYER 3: ENTRY TRIGGER
// ============================================================================
// The final gate. Only fires when Layer 2 says price is AT a zone in the trade
// direction. Then it demands the strategy's confirmation SEQUENCE:
//     shift of structure (LTF CHoCH at the AOI)  +  engulfing candle.
// No shift, no trade. A shift that's really one big impulsive candle ("mimic")
// is rejected. This is the layer that separates a real reversal from the kind
// of fake break that's burned the account before.
//
// MAPS DIRECTLY TO THE PDF:
//   - entry signal mandatory, no trade without it          (p.27, l.791)
//   - shift of structure on a LTF, aligned, AT the AOI      (l.800-835)
//   - no shift / too far from AOI => no trade               (l.~830)
//   - "mimic shift" exception: one big move, no internal
//     highs/lows, is NOT a real shift                       (l.837-842)  [false-shift filter]
//   - engulfing confirmation; higher TF stronger; cleanest  (l.860-870)
//
// LTFs available from candle-source: 4h, 1h, 30m, 15m (no 2h). Cleanest =
// highest TF that shows BOTH a valid shift and an engulfing.
//
// READ-ONLY. Consumes Layer 2 (location). Emits the entry verdict + the
// structure points (origin swing, broken level) that Layer 4 uses to place SL.
// ----------------------------------------------------------------------------

const { getAssetById } = require('./asset-registry');
const BIAS = require('./alexg-bias');
const AOI = require('./alexg-aoi');

let _fetchCandlesCached = null;
function defaultFetchCandles() {
  if (!_fetchCandlesCached) {
    try { _fetchCandlesCached = require('./candle-source').fetchCandles; } catch (_) {}
  }
  return _fetchCandlesCached;
}

const LTFS = ['4h', '1h', '30m', '15m'];          // highest -> lowest
const TF_RANK = { '4h': 4, '1h': 3, '30m': 2, '15m': 1 };

const CFG = {
  ltfLookback:     120,
  ltfAtrMult:      1.0,    // structure granularity on LTFs (finer than HTF bias)
  originGateAtr:   0.50,   // the shift's origin swing must be within this many
                           // ATRs of the AOI for the shift to count "at the AOI"
  maxSingleFrac:   0.80,   // if one candle is >80% of the breaking leg => mimic
  minLegCandles:   2,      // a leg of <2 candles is too abrupt to be real structure
  engulfScan:      8,      // scan the last N candles for the engulfing
};

// ─── candlestick + leg helpers ──────────────────────────────────────
function isBullEngulf(c, p) {
  return c.close > c.open && p.close < p.open && c.close >= p.open && c.open <= p.close;
}
function isBearEngulf(c, p) {
  return c.close < c.open && p.close > p.open && c.close <= p.open && c.open >= p.close;
}
// find an engulfing in `direction` within the last `scan` candles; return the most recent
function findEngulfing(candles, direction, scan, afterIdx = 0) {
  const n = candles.length;
  for (let i = n - 1; i >= Math.max(1, n - scan, afterIdx + 1); i--) {
    const c = candles[i], p = candles[i - 1];
    if (direction === 'long' && isBullEngulf(c, p)) return { found: true, idx: i, kind: 'bullish' };
    if (direction === 'short' && isBearEngulf(c, p)) return { found: true, idx: i, kind: 'bearish' };
  }
  return { found: false, idx: -1, kind: null };
}

// false-shift / "mimic" filter: the leg from the origin swing to now must have
// real internal structure, not be one oversized candle.
function isMimicLeg(candles, originIdx) {
  const leg = candles.slice(originIdx);
  if (leg.length < CFG.minLegCandles) return { mimic: true, why: `leg only ${leg.length} candle(s)` };
  let legHi = -Infinity, legLo = Infinity, maxRange = 0;
  for (const c of leg) {
    if (c.high > legHi) legHi = c.high;
    if (c.low < legLo) legLo = c.low;
    const r = c.high - c.low;
    if (r > maxRange) maxRange = r;
  }
  const legRange = legHi - legLo;
  if (legRange > 0 && (maxRange / legRange) > CFG.maxSingleFrac) {
    return { mimic: true, why: `single candle is ${Math.round((maxRange / legRange) * 100)}% of the leg — one big move, not a real shift` };
  }
  return { mimic: false, why: null };
}

// ─── shift-of-structure (CHoCH) on one LTF ──────────────────────────
function detectShiftOnTF(candles, direction, zone, atrVal, opts = {}) {
  const s = BIAS.buildStructure(candles, 'LTF', { atrMult: opts.ltfAtrMult != null ? opts.ltfAtrMult : CFG.ltfAtrMult });
  if (!s.ok) return { found: false, reason: s.reason };
  const piv = s.pivots;
  const lastClose = candles[candles.length - 1].close;
  const gate = (opts.originGateAtr != null ? opts.originGateAtr : CFG.originGateAtr) * atrVal;

  const lastOf = (type, beforeIdx) => { for (let i = piv.length - 1; i >= 0; i--) if (piv[i].type === type && (beforeIdx == null || piv[i].idx < beforeIdx)) return piv[i]; return null; };

  if (direction === 'long') {
    // origin = most recent swing LOW (the LL at the demand); broken = the LH before it
    const origin = lastOf('L', null);
    if (!origin) return { found: false, reason: 'no origin low' };
    const broken = lastOf('H', origin.idx);
    if (!broken) return { found: false, reason: 'no prior swing high to break' };
    const closedBeyond = lastClose > broken.close;
    const originNearZone = zone ? (origin.low >= zone.lo - gate && origin.low <= zone.hi + gate) : true;
    const mimic = isMimicLeg(candles, origin.idx);
    return {
      found: closedBeyond && originNearZone && !mimic.mimic,
      closedBeyond, originNearZone, falseShift: mimic.mimic, falseShiftWhy: mimic.why,
      brokenLevel: broken.close, origin: { idx: origin.idx, low: origin.low, close: origin.close },
    };
  } else {
    const origin = lastOf('H', null);
    if (!origin) return { found: false, reason: 'no origin high' };
    const broken = lastOf('L', origin.idx);
    if (!broken) return { found: false, reason: 'no prior swing low to break' };
    const closedBeyond = lastClose < broken.close;
    const originNearZone = zone ? (origin.high >= zone.lo - gate && origin.high <= zone.hi + gate) : true;
    const mimic = isMimicLeg(candles, origin.idx);
    return {
      found: closedBeyond && originNearZone && !mimic.mimic,
      closedBeyond, originNearZone, falseShift: mimic.mimic, falseShiftWhy: mimic.why,
      brokenLevel: broken.close, origin: { idx: origin.idx, high: origin.high, close: origin.close },
    };
  }
}

// ─── Entry evaluation ───────────────────────────────────────────────
async function evaluateEntry(asset, opts = {}) {
  const fc = opts.fetchCandlesFn || defaultFetchCandles();
  if (typeof fc !== 'function') return entryFail(asset, 'candle source unavailable');

  let loc = opts.location;
  if (!loc) { try { loc = await AOI.evaluateLocation(asset, opts); } catch (e) { return entryFail(asset, 'location threw: ' + e.message); } }

  const direction = loc.direction, zone = loc.activeZone;
  if (!loc.locationOK) {
    return { ...entryShell(asset, loc), entrySignal: false, notes: ['not at a valid AOI / location blocked — ' + (loc.notes || []).join('; ')] };
  }

  // evaluate each LTF; collect candidates with shift + engulfing data
  const candidates = [];
  for (const tf of LTFS) {
    let candles;
    try { const r = await fc(asset, tf, CFG.ltfLookback); candles = (r && r.candles) || []; }
    catch (_) { continue; }
    if (candles.length < 10) continue;
    const atrVal = BIAS.atr(candles) || 0;
    const shift = detectShiftOnTF(candles, direction, zone, atrVal, opts);
    const originIdx = (shift.found && shift.origin) ? shift.origin.idx : 0;
    // only count engulfing that formed AFTER the shift's origin candle
    const eng = findEngulfing(candles, direction, CFG.engulfScan, shift.found ? originIdx : 0);
    candidates.push({ tf, candles, shift, engulfing: eng, hasShift: !!shift.found, hasEngulf: eng.found });
  }

  // cleanest = highest-ranked TF with a valid shift; engulfing can be on the same
  // OR any lower TF (e.g. shift on 1h + engulf on 15m is a valid real-world sequence).
  const shiftByRank = candidates.filter((c) => c.hasShift).sort((a, b) => TF_RANK[b.tf] - TF_RANK[a.tf]);
  let chosen = null;
  for (const sc of shiftByRank) {
    const engulfMatch = candidates.find((ec) => TF_RANK[ec.tf] <= TF_RANK[sc.tf] && ec.hasEngulf);
    if (engulfMatch) { chosen = { ...sc, engulfTF: engulfMatch.tf, engulfing: engulfMatch.engulfing }; break; }
  }

  const notes = [];
  // surface why near-misses failed (helps calibration)
  for (const c of candidates) {
    if (c.shift && c.shift.falseShift) notes.push(`${c.tf}: shift rejected — ${c.shift.falseShiftWhy}`);
    else if (c.hasShift && !c.hasEngulf) notes.push(`${c.tf}: shift present but no engulfing yet (await pullback + engulfing)`);
    else if (c.shift && c.shift.closedBeyond && c.shift.originNearZone === false) notes.push(`${c.tf}: shift occurred away from the AOI — skipped`);
  }
  if (!chosen) notes.push('no LTF shows shift + engulfing at the AOI — no entry');

  return {
    asset,
    direction, tradeType: loc.tradeType,
    locationOK: true,
    activeZone: zone,
    entrySignal: !!chosen,
    triggerTF: chosen ? chosen.tf : null,
    shift: chosen ? { tf: chosen.tf, brokenLevel: chosen.shift.brokenLevel, origin: chosen.shift.origin } : null,
    engulfing: chosen ? { tf: chosen.engulfTF || chosen.tf, idx: chosen.engulfing.idx, kind: chosen.engulfing.kind } : null,
    candidates: candidates.map((c) => ({ tf: c.tf, shift: c.hasShift, engulfing: c.hasEngulf, falseShift: !!(c.shift && c.shift.falseShift) })),
    confluences: loc.confluences,
    notes,
    evaluatedAt: Date.now(),
  };
}

async function evaluateUniverse(assets, opts = {}) {
  const list = (assets && assets.length) ? assets : ['gold', 'eurusd', 'gbpusd', 'usdjpy', 'nas100', 'us500', 'btc'];
  const settled = await Promise.all(list.map(async (a) => {
    try { return [a, await evaluateEntry(a, opts)]; }
    catch (e) { return [a, entryFail(a, 'threw: ' + e.message)]; }
  }));
  const results = {}; let fireCount = 0;
  for (const [a, v] of settled) { results[a] = v; if (v.entrySignal) fireCount++; }
  return { ok: true, results, entrySignalCount: fireCount, requested: list.length, evaluatedAt: Date.now() };
}

// ─── helpers ────────────────────────────────────────────────────────
function entryShell(asset, loc) { return { asset, direction: loc ? loc.direction : null, tradeType: loc ? loc.tradeType : null, locationOK: !!(loc && loc.locationOK), activeZone: loc ? loc.activeZone : null, triggerTF: null, shift: null, engulfing: null, candidates: [], confluences: loc ? loc.confluences : null, evaluatedAt: Date.now() }; }
function entryFail(asset, reason) { return { asset, direction: null, tradeType: null, locationOK: false, entrySignal: false, triggerTF: null, shift: null, engulfing: null, candidates: [], notes: [reason], evaluatedAt: Date.now() }; }

// ─── HTTP handler (read-only) ───────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (q.asset) {
      if (!getAssetById(q.asset)) return res.status(400).json({ ok: false, error: 'unknown asset' });
      return res.status(200).json({ ok: true, entry: await evaluateEntry(q.asset) });
    }
    const assets = q.assets ? String(q.assets).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
    return res.status(200).json(await evaluateUniverse(assets));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.evaluateEntry = evaluateEntry;
module.exports.evaluateUniverse = evaluateUniverse;
module.exports.detectShiftOnTF = detectShiftOnTF;
module.exports.findEngulfing = findEngulfing;
module.exports.isMimicLeg = isMimicLeg;
module.exports.isBullEngulf = isBullEngulf;
module.exports.isBearEngulf = isBearEngulf;
module.exports.CFG = CFG;