/* eslint-disable */
// api/alexg-entry.js
//
// ALEX G — "Full Set & Forget" strategy — LAYER 3: ENTRY TRIGGER
// ============================================================================
// The final gate. Only fires when Layer 2 says price is AT a zone in the trade
// direction. Then it demands the strategy's confirmation SEQUENCE:
//     shift of structure (LTF CHoCH at the AOI)  +  engulfing candle.
// No shift, no trade. A shift that's really one big impulsive candle ("mimic")
// is normally rejected, but per PDF the one-big-candle case is documented as a
// valid high-risk entry (see FIX3).
//
// MAPS DIRECTLY TO THE PDF:
//   - entry signal mandatory, no trade without it          (p.27, l.791)
//   - shift of structure on a LTF, aligned, AT the AOI      (l.800-835)
//   - no shift / too far from AOI => no trade               (l.~830)
//   - "mimic shift" exception: one big move, no internal
//     highs/lows — high-risk but valid per Alex's own trade (p.28)
//   - engulfing confirmation; higher TF stronger; cleanest  (l.860-870)
//   - PDF ideal: 4hr engulf coincides with LTF shift        (p.29)
//
// LTFs: 4h, 2h (FIX4), 1h, 30m, 15m — matching the PDF's full TF list.
//
// READ-ONLY. Consumes Layer 2 (location). Emits the entry verdict + the
// structure points (origin swing, broken level) that Layer 4 uses to place SL.
// ──────────────────────────────────────────────────────────────────────────────
// INSTRUMENTED PATCH FLAGS — flip any flag to `false` to revert that ONE fix.
// All default ON. Each new path writes a tagged entry to v13:alexg:fixlog so
// every new entry can be attributed to the exact fix that enabled it.
// ──────────────────────────────────────────────────────────────────────────────

const FIX1_UNBOUNDED_SCAN         = true;  // RANK1 — scan from origin idx, not just last 8 bars
const FIX2_ALLOW_HIGHER_TF_ENGULF = true;  // RANK2 — LTF shift + HTF engulf allowed (PDF ideal)
const FIX3_ALLOW_MIMIC_HIGHRISK   = true;  // RANK3 — one-big-candle = high-risk, not hard-reject
const FIX4_ADD_2H                 = true;  // RANK4 — include 2h TF (candle-source now supports it)
const FIX5_ALLOW_OVERSHOOT        = true;  // RANK5 — liquidity-grab overshoot past zone accepted
const FIX5_OVERSHOOT_ATR          = 1.0;   // extra ATRs allowed on the overshoot side (tunable)
// FIX6_TOUCH_COUNTING lives in alexg-aoi.js (zone formation, not entry logic)

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

// ── fixlog: fire-and-forget Redis list, capped at 1000 entries ───────────────
let _getRedisEntry = null;
const FIXLOG_KEY = 'v13:alexg:fixlog';
const FIXLOG_CAP = 1000;
function writeFixLog(entry) {
  try {
    if (!_getRedisEntry) { try { _getRedisEntry = require('./_lib').getRedis; } catch (_) {} }
    const r = _getRedisEntry ? _getRedisEntry() : null;
    if (!r) return;
    const line = JSON.stringify({ ...entry, ts: entry.ts || Date.now() });
    r.rpush(FIXLOG_KEY, line)
      .then(() => Promise.all([
        r.ltrim(FIXLOG_KEY, -FIXLOG_CAP, -1),
        r.expire(FIXLOG_KEY, 90 * 24 * 3600),
      ]))
      .catch(() => {});
  } catch (_) {}
}

// ── timeframe tables ─────────────────────────────────────────────────────────
// RANK4: 2h added between 4h and 1h to match the PDF's full list.
// Original LTFS_BASE preserved — flip FIX4_ADD_2H=false to revert.
const LTFS_BASE    = ['4h', '1h', '30m', '15m'];
const LTFS_WITH_2H = ['4h', '2h', '1h', '30m', '15m'];
const TF_RANK = { '4h': 5, '2h': 4, '1h': 3, '30m': 2, '15m': 1 };

const CFG = {
  ltfLookback:     120,
  ltfAtrMult:      1.0,    // structure granularity on LTFs (finer than HTF bias)
  originGateAtr:   0.50,   // the shift's origin swing must be within this many
                           // ATRs of the AOI for the shift to count "at the AOI"
  maxSingleFrac:   0.80,   // if one candle is >80% of the breaking leg => mimic
  minLegCandles:   2,      // a leg of <2 candles is too abrupt to be real structure
  engulfScan:      8,      // legacy scan window (used when FIX1_UNBOUNDED_SCAN=false)
};

// ─── candlestick helpers ──────────────────────────────────────────────────────
function isBullEngulf(c, p) {
  return c.close > c.open && p.close < p.open && c.close >= p.open && c.open <= p.close;
}
function isBearEngulf(c, p) {
  return c.close < c.open && p.close > p.open && c.close <= p.open && c.open >= p.close;
}

// RANK1 fix: when a real origin anchor is known (afterIdx > 0), scan from it
// backward — not just the last CFG.engulfScan bars. Without an anchor we keep
// the original window to avoid surfacing stale engulfings on TFs with no shift.
function findEngulfing(candles, direction, scan, afterIdx, opts) {
  afterIdx = afterIdx || 0;
  opts = opts || {};
  const n = candles.length;
  const hasAnchor = afterIdx > 0;
  const lowerBound = (FIX1_UNBOUNDED_SCAN && hasAnchor)
    ? Math.max(1, afterIdx + 1)
    : Math.max(1, n - scan, afterIdx + 1);
  for (let i = n - 1; i >= lowerBound; i--) {
    const c = candles[i], p = candles[i - 1];
    const hit = (direction === 'long' && isBullEngulf(c, p)) ||
                (direction === 'short' && isBearEngulf(c, p));
    if (!hit) continue;
    const barsBack = n - 1 - i;
    // FIX1 log: engulfing was found outside the old 8-bar window
    if (FIX1_UNBOUNDED_SCAN && hasAnchor && barsBack > scan && opts.assetId) {
      writeFixLog({ fix: 'RANK1', reason: 'engulfing found outside old 8-bar window', tf: opts.tf, assetId: opts.assetId, detail: { barsBack, oldWindow: scan } });
    }
    return { found: true, idx: i, kind: direction === 'long' ? 'bullish' : 'bearish', barsBack };
  }
  return { found: false, idx: -1, kind: null };
}

// RANK3 fix: instead of hard-rejecting a one-candle leg, tag it highRisk:true
// and allow it — PDF explicitly shows Alex traded this case and it "played out
// to TP." Flip FIX3_ALLOW_MIMIC_HIGHRISK=false to revert to hard-reject.
function isMimicLeg(candles, originIdx) {
  const leg = candles.slice(originIdx);
  if (leg.length < CFG.minLegCandles) return { mimic: true, highRisk: false, why: `leg only ${leg.length} candle(s)` };
  let legHi = -Infinity, legLo = Infinity, maxRange = 0;
  for (const c of leg) {
    if (c.high > legHi) legHi = c.high;
    if (c.low < legLo) legLo = c.low;
    const r = c.high - c.low;
    if (r > maxRange) maxRange = r;
  }
  const legRange = legHi - legLo;
  const singlePct = legRange > 0 ? Math.round((maxRange / legRange) * 100) : 0;
  if (legRange > 0 && (maxRange / legRange) > CFG.maxSingleFrac) {
    if (FIX3_ALLOW_MIMIC_HIGHRISK) {
      return { mimic: false, highRisk: true, why: `single candle ${singlePct}% of leg — high-risk (FIX3)` };
    }
    return { mimic: true, highRisk: false, why: `single candle is ${singlePct}% of the leg — one big move, not a real shift` };
  }
  return { mimic: false, highRisk: false, why: null };
}

// ─── shift-of-structure (CHoCH) on one LTF ───────────────────────────────────
// RANK5 fix: widen the origin gate on the OVERSHOOT side only (below demand /
// above supply). A liquidity-grab overshoot is a VALID setup per the PDF ("price
// might slightly overshoot an AOI before reversing"). The inward side gate is
// unchanged. Flip FIX5_ALLOW_OVERSHOOT=false or lower FIX5_OVERSHOOT_ATR to revert.
function detectShiftOnTF(candles, direction, zone, atrVal, opts) {
  opts = opts || {};
  const s = BIAS.buildStructure(candles, 'LTF', { atrMult: opts.ltfAtrMult != null ? opts.ltfAtrMult : CFG.ltfAtrMult });
  if (!s.ok) return { found: false, reason: s.reason };
  const piv = s.pivots;
  const lastClose = candles[candles.length - 1].close;
  const gate = (opts.originGateAtr != null ? opts.originGateAtr : CFG.originGateAtr) * atrVal;
  // FIX5: extra tolerance on the "into zone" overshoot side only
  const overshootGate = FIX5_ALLOW_OVERSHOOT ? gate + FIX5_OVERSHOOT_ATR * atrVal : gate;

  const lastOf = (type, beforeIdx) => {
    for (let i = piv.length - 1; i >= 0; i--)
      if (piv[i].type === type && (beforeIdx == null || piv[i].idx < beforeIdx)) return piv[i];
    return null;
  };

  if (direction === 'long') {
    const origin = lastOf('L', null);
    if (!origin) return { found: false, reason: 'no origin low' };
    const broken = lastOf('H', origin.idx);
    if (!broken) return { found: false, reason: 'no prior swing high to break' };
    const closedBeyond = lastClose > broken.close;
    // Old gate (both sides at `gate`); FIX5 widens BELOW zone (grab direction)
    const originOldGateOk = zone ? (origin.low >= zone.lo - gate && origin.low <= zone.hi + gate) : true;
    const originNearZone  = zone ? (origin.low >= zone.lo - overshootGate && origin.low <= zone.hi + gate) : true;
    const mimic = isMimicLeg(candles, origin.idx);
    const found = closedBeyond && originNearZone && !mimic.mimic;
    return {
      found, closedBeyond, originNearZone, originOldGateOk,
      falseShift: mimic.mimic, falseShiftWhy: mimic.why, highRisk: mimic.highRisk,
      overshootEnabled: FIX5_ALLOW_OVERSHOOT && !originOldGateOk && originNearZone,
      brokenLevel: broken.close, origin: { idx: origin.idx, low: origin.low, close: origin.close },
    };
  } else {
    const origin = lastOf('H', null);
    if (!origin) return { found: false, reason: 'no origin high' };
    const broken = lastOf('L', origin.idx);
    if (!broken) return { found: false, reason: 'no prior swing low to break' };
    const closedBeyond = lastClose < broken.close;
    // FIX5: widen ABOVE zone (grab direction for supply)
    const originOldGateOk = zone ? (origin.high >= zone.lo - gate && origin.high <= zone.hi + gate) : true;
    const originNearZone  = zone ? (origin.high >= zone.lo - gate && origin.high <= zone.hi + overshootGate) : true;
    const mimic = isMimicLeg(candles, origin.idx);
    const found = closedBeyond && originNearZone && !mimic.mimic;
    return {
      found, closedBeyond, originNearZone, originOldGateOk,
      falseShift: mimic.mimic, falseShiftWhy: mimic.why, highRisk: mimic.highRisk,
      overshootEnabled: FIX5_ALLOW_OVERSHOOT && !originOldGateOk && originNearZone,
      brokenLevel: broken.close, origin: { idx: origin.idx, high: origin.high, close: origin.close },
    };
  }
}

// ─── Entry evaluation ─────────────────────────────────────────────────────────
async function evaluateEntry(asset, opts) {
  opts = opts || {};
  const fc = opts.fetchCandlesFn || defaultFetchCandles();
  if (typeof fc !== 'function') return entryFail(asset, 'candle source unavailable');

  let loc = opts.location;
  if (!loc) {
    try { loc = await AOI.evaluateLocation(asset, opts); }
    catch (e) { return entryFail(asset, 'location threw: ' + e.message); }
  }

  const direction = loc.direction, zone = loc.activeZone;
  if (!loc.locationOK) {
    return { ...entryShell(asset, loc), entrySignal: false, notes: ['not at a valid AOI / location blocked — ' + (loc.notes || []).join('; ')] };
  }

  // RANK4: include 2h when flag is on (candle-source.js now has 2h in TF_MS)
  const LTFS = FIX4_ADD_2H ? LTFS_WITH_2H : LTFS_BASE;

  // evaluate each LTF; collect candidates with shift + engulfing data
  const candidates = [];
  for (const tf of LTFS) {
    let candles;
    try {
      const r = await fc(asset, tf, CFG.ltfLookback);
      candles = (r && r.candles) || [];
    } catch (_) { continue; }
    if (candles.length < 10) continue;
    const atrVal = BIAS.atr(candles) || 0;
    const shift = detectShiftOnTF(candles, direction, zone, atrVal, opts);
    const originIdx = (shift.found && shift.origin) ? shift.origin.idx : 0;
    // Pass assetId + tf so FIX1 log can attribute which pair/TF triggered it
    const eng = findEngulfing(candles, direction, CFG.engulfScan, shift.found ? originIdx : 0, { assetId: asset, tf });
    candidates.push({ tf, candles, shift, engulfing: eng, hasShift: !!shift.found, hasEngulf: eng.found });
  }

  // RANK2: allow engulfing on any TF, including HIGHER than the shift TF.
  // PDF ideal: "4hr engulfing will coincide with a lower timeframe shift."
  // Original: engulf must be same-or-lower TF than shift (inverted from PDF ideal).
  // With FIX2 on: pick the highest-ranked shift; pair with the highest-ranked engulf
  // available across all TFs.
  const shiftByRank = candidates.filter((c) => c.hasShift).sort((a, b) => TF_RANK[b.tf] - TF_RANK[a.tf]);
  let chosen = null;
  for (const sc of shiftByRank) {
    let engulfMatch;
    if (FIX2_ALLOW_HIGHER_TF_ENGULF) {
      // Search ALL TFs; take the highest-ranked engulf available (PDF ideal = HTF engulf)
      const allWithEngulf = candidates.filter((ec) => ec.hasEngulf)
        .sort((a, b) => TF_RANK[b.tf] - TF_RANK[a.tf]);
      engulfMatch = allWithEngulf[0] || null;
    } else {
      engulfMatch = candidates.find((ec) => TF_RANK[ec.tf] <= TF_RANK[sc.tf] && ec.hasEngulf) || null;
    }
    if (!engulfMatch) continue;

    // FIX2 log: engulf TF is HIGHER than shift TF — this is the PDF's ideal scenario
    if (FIX2_ALLOW_HIGHER_TF_ENGULF && TF_RANK[engulfMatch.tf] > TF_RANK[sc.tf]) {
      writeFixLog({ fix: 'RANK2', reason: 'HTF engulf + LTF shift (PDF ideal scenario)', tf: sc.tf, assetId: asset, detail: { shiftTF: sc.tf, engulfTF: engulfMatch.tf } });
    }
    // FIX4 log: 2h contributed to the chosen setup
    if (FIX4_ADD_2H && (sc.tf === '2h' || engulfMatch.tf === '2h')) {
      writeFixLog({ fix: 'RANK4', reason: '2h timeframe contributed to entry', tf: sc.tf, assetId: asset, detail: { shiftTF: sc.tf, engulfTF: engulfMatch.tf } });
    }
    chosen = { ...sc, engulfTF: engulfMatch.tf, engulfing: engulfMatch.engulfing };
    break;
  }

  // FIX3 log: high-risk (mimic) shift was accepted
  if (chosen && chosen.shift && chosen.shift.highRisk) {
    writeFixLog({ fix: 'RANK3', reason: 'high-risk mimic shift accepted (PDF exception p.28)', tf: chosen.tf, assetId: asset, detail: { falseShiftWhy: chosen.shift.falseShiftWhy } });
  }
  // FIX5 log: origin overshoot was the enabler
  if (chosen && chosen.shift && chosen.shift.overshootEnabled) {
    const originPos = direction === 'long' ? chosen.shift.origin.low : chosen.shift.origin.high;
    const zoneEdge  = direction === 'long' ? (zone && zone.lo) : (zone && zone.hi);
    writeFixLog({ fix: 'RANK5', reason: 'liquidity-grab overshoot tolerated past zone edge', tf: chosen.tf, assetId: asset, detail: { originPos, zoneEdge } });
  }

  const notes = [];
  for (const c of candidates) {
    if (c.shift && c.shift.falseShift)                                   notes.push(`${c.tf}: shift rejected — ${c.shift.falseShiftWhy}`);
    else if (c.shift && c.shift.highRisk)                                notes.push(`${c.tf}: HIGH-RISK shift (single big candle — FIX3 allowed)`);
    else if (c.hasShift && !c.hasEngulf)                                 notes.push(`${c.tf}: shift present but no engulfing yet`);
    else if (c.shift && c.shift.closedBeyond && !c.shift.originNearZone) notes.push(`${c.tf}: shift away from AOI — skipped`);
  }
  if (!chosen) notes.push('no LTF shows shift + engulfing at the AOI — no entry');

  return {
    asset,
    direction, tradeType: loc.tradeType,
    locationOK: true,
    activeZone: zone,
    entrySignal: !!chosen,
    highRisk: chosen ? !!(chosen.shift && chosen.shift.highRisk) : false,
    triggerTF: chosen ? chosen.tf : null,
    shift: chosen ? { tf: chosen.tf, brokenLevel: chosen.shift.brokenLevel, origin: chosen.shift.origin } : null,
    engulfing: chosen ? { tf: chosen.engulfTF || chosen.tf, idx: chosen.engulfing.idx, kind: chosen.engulfing.kind } : null,
    candidates: candidates.map((c) => ({
      tf: c.tf, shift: c.hasShift, engulfing: c.hasEngulf,
      falseShift: !!(c.shift && c.shift.falseShift),
      highRisk:   !!(c.shift && c.shift.highRisk),
    })),
    confluences: loc.confluences,
    notes,
    evaluatedAt: Date.now(),
  };
}

async function evaluateUniverse(assets, opts) {
  opts = opts || {};
  const list = (assets && assets.length) ? assets : ['gold', 'eurusd', 'gbpusd', 'usdjpy', 'nas100', 'us500', 'btc'];
  const settled = await Promise.all(list.map(async (a) => {
    try { return [a, await evaluateEntry(a, opts)]; }
    catch (e) { return [a, entryFail(a, 'threw: ' + e.message)]; }
  }));
  const results = {}; let fireCount = 0;
  for (const [a, v] of settled) { results[a] = v; if (v.entrySignal) fireCount++; }
  return { ok: true, results, entrySignalCount: fireCount, requested: list.length, evaluatedAt: Date.now() };
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function entryShell(asset, loc) {
  return {
    asset, direction: loc ? loc.direction : null, tradeType: loc ? loc.tradeType : null,
    locationOK: !!(loc && loc.locationOK), activeZone: loc ? loc.activeZone : null,
    triggerTF: null, shift: null, engulfing: null, candidates: [],
    confluences: loc ? loc.confluences : null, evaluatedAt: Date.now(),
  };
}
function entryFail(asset, reason) {
  return {
    asset, direction: null, tradeType: null, locationOK: false,
    entrySignal: false, highRisk: false, triggerTF: null,
    shift: null, engulfing: null, candidates: [], notes: [reason], evaluatedAt: Date.now(),
  };
}

// ─── HTTP handler (read-only) ─────────────────────────────────────────────────
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

module.exports.evaluateEntry    = evaluateEntry;
module.exports.evaluateUniverse = evaluateUniverse;
module.exports.detectShiftOnTF  = detectShiftOnTF;
module.exports.findEngulfing    = findEngulfing;
module.exports.isMimicLeg       = isMimicLeg;
module.exports.isBullEngulf     = isBullEngulf;
module.exports.isBearEngulf     = isBearEngulf;
module.exports.writeFixLog      = writeFixLog;
module.exports.CFG              = CFG;
module.exports.FIXLOG_KEY       = FIXLOG_KEY;
