/* eslint-disable */
// api/alexg-aoi.js
//
// ALEX G — "Full Set & Forget" strategy — LAYER 2: AOI MAPPER + LOCATION GATE
// ============================================================================
// Builds the Daily & Weekly supply/demand zones (AOIs) from Layer 1's
// structure, then answers the question the current bot never asks: "is price
// actually AT a zone, in the trade direction, with room to run?" No location,
// no trade. This is what stops mid-move entries like the GBPUSD ORB long.
//
// MAPS DIRECTLY TO THE PDF:
//   - AOI = supply/demand zone, >=3 BODY touches, D & W only, <=60 pips,
//     marked at structure points                          (p.~9-13, l.340-470)
//   - no trade unless price is AT an AOI (+/-5 pips); rank by proximity (l.~)
//   - break & retest: if price CLOSED THROUGH the AOI, wait for reclaim (l.320-324)
//   - "Avoiding Incompetent Trades": never trade INTO an opposing stronger
//     Weekly AOI                                          (p.6, conflict rule)
//   - round numbers / 50 EMA / previous structure point = confluences (l.480-660)
//
// SCALING: the PDF's 5-pip / 60-pip figures are forex heuristics. Here zone
// width and the location gate are ATR-relative, so the same code works on
// forex, gold, BTC and indices. Round-number increments are per-asset.
//
// READ-ONLY. Consumes Layer 1 (bias + structure). Produces the location verdict
// + confluences that Layer 3 (entry) and Layer 4 (grade/TP) will use.
// ----------------------------------------------------------------------------

const { getAssetById } = require('./asset-registry');
const BIAS = require('./alexg-bias');

let _fetchCandlesCached = null;
function defaultFetchCandles() {
  if (!_fetchCandlesCached) {
    try { _fetchCandlesCached = require('./candle-source').fetchCandles; } catch (_) {}
  }
  return _fetchCandlesCached;
}

const CFG = {
  wLookback:       90,
  dLookback:       240,
  atrPeriod:       14,
  zoneMaxWidthAtr: 0.80,  // AOI total width cap, in Daily ATRs (~"60 pips" on fx)
  zoneMinWidthAtr: 0.10,  // floor so a zone is a band, not a line
  minTouches:      3,     // PDF: a valid AOI needs >=3 touches (TUNABLE)
  gateAtr:         0.15,  // price within this many ATRs of a zone edge = "at AOI"
  conflictAtr:     0.50,  // opposing Weekly zone within this distance = conflict
  emaPeriod:       50,    // the 50 EMA confluence
};

// ─── helpers ────────────────────────────────────────────────────────
function bodyLowOf(c)  { return Math.min(c.open, c.close); }
function bodyHighOf(c) { return Math.max(c.open, c.close); }
function bodyOverlap(c, lo, hi) { return bodyHighOf(c) >= lo && bodyLowOf(c) <= hi; }

function ema(values, period) {
  // A real N-EMA needs at least N samples. On fewer, return null (honest "not
  // measurable") rather than a seed-dominated garbage number — every caller
  // null-guards, so this simply drops the EMA confluence instead of faking it.
  if (!Array.isArray(values) || !(period > 0) || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` closes (textbook EMA seed) so the
  // result isn't biased toward the oldest close on shorter series.
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i];
  e /= period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Round-number increment per asset (PDF "every 500" generalised).
function roundIncrementFor(asset) {
  const m = getAssetById(asset) || {};
  const cat = m.category, pip = m.pipSize || 0.0001;
  if (cat === 'crypto') return 1000;
  if (cat === 'index')  return 100;
  if (cat === 'metal')  return 10;
  if (pip === 0.01)     return 0.5;     // JPY pairs
  return 0.0050;                         // 4-decimal fx: the 50-pip "round" levels
}
function nearestRound(price, inc) { return Math.round(price / inc) * inc; }

// ─── Zone builder ───────────────────────────────────────────────────
// kind: 'demand' (from swing lows) | 'supply' (from swing highs).
// Anchored on Layer 1 pivots, tightened to the body-touch cluster, width-capped,
// kept only with >= minTouches distinct visits.
function buildZones(candles, pivots, kind, atrVal, opts = {}) {
  if (!Array.isArray(pivots) || !Array.isArray(candles) || !(atrVal > 0)) return [];
  const maxW = (opts.zoneMaxWidthAtr != null ? opts.zoneMaxWidthAtr : CFG.zoneMaxWidthAtr) * atrVal;
  const minW = (opts.zoneMinWidthAtr != null ? opts.zoneMinWidthAtr : CFG.zoneMinWidthAtr) * atrVal;
  const minTouches = opts.minTouches != null ? opts.minTouches : CFG.minTouches;
  const anchors = pivots.filter((p) => kind === 'demand' ? p.type === 'L' : p.type === 'H');

  const raw = [];
  for (const a of anchors) {
    const center = kind === 'demand' ? a.bodyLow : a.bodyHigh;
    let lo = center - maxW / 2, hi = center + maxW / 2;
    // tighten to the cluster of STRUCTURAL pivot levels inside the band — NOT
    // every touching candle. Using all candles let a single candle that closes
    // through the zone widen it downward and hide the break; pivots keep the
    // zone anchored to structure so break & retest can be detected later.
    const pivLevels = anchors
      .map((p) => kind === 'demand' ? p.bodyLow : p.bodyHigh)
      .filter((x) => x >= lo && x <= hi);
    if (pivLevels.length) {
      lo = Math.min(...pivLevels);
      hi = Math.max(...pivLevels);
    }
    if (hi - lo < minW) { const mid = (lo + hi) / 2; lo = mid - minW / 2; hi = mid + minW / 2; }
    if (hi - lo > maxW) { const mid = (lo + hi) / 2; lo = mid - maxW / 2; hi = mid + maxW / 2; }
    // count touches + distinct visits on the tightened zone
    let touches = 0, visits = 0, inRun = false, lastTouchIdx = -1;
    for (let i = 0; i < candles.length; i++) {
      const ov = bodyOverlap(candles[i], lo, hi);
      if (ov) { touches++; lastTouchIdx = i; if (!inRun) { visits++; inRun = true; } }
      else inRun = false;
    }
    if (visits >= minTouches) {
      raw.push({ kind, lo, hi, mid: (lo + hi) / 2, touches, visits, anchorIdx: a.idx, lastTouchIdx });
    }
  }

  // merge overlapping zones (keep the union, capped at maxW; carry max visits)
  raw.sort((x, y) => x.lo - y.lo);
  const merged = [];
  for (const z of raw) {
    const last = merged[merged.length - 1];
    if (last && z.lo <= last.hi) {
      last.hi = Math.max(last.hi, z.hi);
      if (last.hi - last.lo > maxW) (z.mid >= last.mid ? (last.lo = last.hi - maxW) : (last.hi = last.lo + maxW));
      last.mid = (last.lo + last.hi) / 2;
      last.touches += z.touches;
      last.visits = Math.max(last.visits, z.visits);
      last.lastTouchIdx = Math.max(last.lastTouchIdx, z.lastTouchIdx);
    } else merged.push({ ...z });
  }
  // strongest / most-recent first
  merged.sort((a, b) => (b.lastTouchIdx - a.lastTouchIdx) || (b.visits - a.visits));
  return merged;
}

// ─── Location evaluation ────────────────────────────────────────────
async function evaluateLocation(asset, opts = {}) {
  const fc = opts.fetchCandlesFn || defaultFetchCandles();
  if (typeof fc !== 'function') return locFail(asset, 'candle source unavailable');

  // bias (direction + tradeType) — reuse Layer 1
  let bias = opts.bias;
  if (!bias) { try { bias = await BIAS.evaluateBias(asset, opts); } catch (e) { return locFail(asset, 'bias threw: ' + e.message); } }

  let w, d, recent1h = [];
  try {
    const [wr, dr, r1h] = await Promise.all([
      fc(asset, '1w', CFG.wLookback),
      fc(asset, '1d', CFG.dLookback),
      fc(asset, '1h', 3).catch(() => null),
    ]);
    w = (wr && wr.candles) || []; d = (dr && dr.candles) || [];
    recent1h = (r1h && r1h.candles) || [];
  } catch (e) { return locFail(asset, 'candle fetch threw: ' + e.message, bias); }

  const sd = BIAS.buildStructure(d, 'D', opts);
  const sw = BIAS.buildStructure(w, 'W', opts);
  const atrD = BIAS.atr(d) || sd.atr;
  if (!atrD || !sd.ok) return locFail(asset, 'no daily structure/ATR', bias);

  // Build all four zone sets
  const zones = {
    dDemand: buildZones(d, sd.pivots, 'demand', atrD, opts),
    dSupply: buildZones(d, sd.pivots, 'supply', atrD, opts),
    wDemand: sw.ok ? buildZones(w, sw.pivots, 'demand', BIAS.atr(w) || atrD, opts) : [],
    wSupply: sw.ok ? buildZones(w, sw.pivots, 'supply', BIAS.atr(w) || atrD, opts) : [],
  };

  // Use the most recent 1h close as live price — the daily close is yesterday's
  // bar and misses all intraday zone touches; 1h is current enough without noise.
  const price = recent1h.length
    ? recent1h[recent1h.length - 1].close
    : d[d.length - 1].close;
  const gate = CFG.gateAtr * atrD;
  const conflictDist = CFG.conflictAtr * atrD;
  const dir = bias.direction;            // 'long' | 'short' | null
  const notes = [];

  // candidate zones in the trade direction: longs buy DEMAND, shorts sell SUPPLY.
  // Prefer Daily zones; Weekly zones also valid (swing).
  const dirKind = dir === 'long' ? 'demand' : dir === 'short' ? 'supply' : null;
  let candidates = [];
  if (dirKind === 'demand') candidates = [...zones.dDemand.map(tag('D')), ...zones.wDemand.map(tag('W'))];
  if (dirKind === 'supply') candidates = [...zones.dSupply.map(tag('D')), ...zones.wSupply.map(tag('W'))];

  // nearest directional zone to price = the retracement target we'd trade.
  let activeZone = null, distancePips = null, broken = false;
  let nearest = null; // closest zone by price distance (for messaging)
  // Walk zones closest-first; skip zones price has broken through and try the next
  // rather than stopping — a broken upper demand often has a valid lower demand below.
  const byProximity = [...candidates].sort((a, b) => Math.abs(price - a.mid) - Math.abs(price - b.mid));
  for (const z of byProximity) {
    if (!nearest) nearest = z;
    const within = price >= z.lo - gate && price <= z.hi + gate;
    if (within) { activeZone = z; break; }
    const throughBelow = dirKind === 'demand' && price < z.lo - gate;
    const throughAbove = dirKind === 'supply' && price > z.hi + gate;
    if (throughBelow || throughAbove) { broken = true; continue; } // price broke this zone, try next
  }
  if (activeZone) {
    broken = false; // found a valid zone further down — not unrecoverably broken
    distancePips = priceToPips(asset, Math.max(0, activeZone.lo - price, price - activeZone.hi));
  }
  if (broken && !activeZone && nearest) notes.push(`price closed through the ${nearest.source} ${nearest.kind} AOI — needs break & retest before entry`);

  // conflict-zone rule: opposing WEEKLY zone too close in the danger direction.
  // long  -> a W SUPPLY just above will reject price down into the long's SL.
  // short -> a W DEMAND just below will bounce price up into the short's SL.
  let conflict = { blocked: false, reason: null };
  if (dir === 'long') {
    const above = zones.wSupply.filter((z) => z.lo > price && z.lo - price <= conflictDist);
    if (above.length) conflict = { blocked: true, reason: `Weekly supply ${fmt(above[0].lo)}–${fmt(above[0].hi)} within ${CFG.conflictAtr}xATR above — long would run into it` };
  } else if (dir === 'short') {
    const below = zones.wDemand.filter((z) => z.hi < price && price - z.hi <= conflictDist);
    if (below.length) conflict = { blocked: true, reason: `Weekly demand ${fmt(below[0].lo)}–${fmt(below[0].hi)} within ${CFG.conflictAtr}xATR below — short would get bounced into SL` };
  }
  if (conflict.blocked) notes.push(conflict.reason);

  // confluences (booleans + the levels) — feed Layer 4's grade
  const confluences = { roundNumber: false, ema50: false, prevStructure: false, details: {} };
  if (activeZone) {
    const inc = roundIncrementFor(asset);
    const rn = nearestRound(activeZone.mid, inc);
    if (rn >= activeZone.lo - gate && rn <= activeZone.hi + gate) { confluences.roundNumber = true; confluences.details.round = rn; }

    const ema50 = ema(d.map((c) => c.close), CFG.emaPeriod);
    if (ema50 != null && ema50 >= activeZone.lo - gate && ema50 <= activeZone.hi + gate) { confluences.ema50 = true; confluences.details.ema50 = round(ema50); }

    // previous structure point aligning with the zone (an old opposite pivot at this level)
    const prevHit = (sd.pivots || []).some((p) => p.idx < activeZone.anchorIdx && Math.max(p.bodyLow, activeZone.lo) <= Math.min(p.bodyHigh, activeZone.hi));
    if (prevHit) { confluences.prevStructure = true; }
  }

  const atAOI = !!activeZone;
  const locationOK = atAOI && !broken && !conflict.blocked;
  if (!atAOI && dirKind) notes.push(`price not at a ${dirKind} AOI (nearest ${candidates.length} zones out of gate range)`);

  return {
    asset,
    direction: dir, tradeType: bias.tradeType, tradeableBias: bias.tradeable,
    price,
    atAOI, locationOK, broken,
    activeZone: activeZone ? slim(activeZone, asset) : null,
    distancePips,
    conflict,
    confluences,
    zones: {
      dDemand: zones.dDemand.map((z) => slim(z, asset)),
      dSupply: zones.dSupply.map((z) => slim(z, asset)),
      wDemand: zones.wDemand.map((z) => slim(z, asset)),
      wSupply: zones.wSupply.map((z) => slim(z, asset)),
    },
    notes,
    evaluatedAt: Date.now(),
  };
}

async function evaluateUniverse(assets, opts = {}) {
  const list = (assets && assets.length) ? assets : ['gold', 'eurusd', 'gbpusd', 'usdjpy', 'nas100', 'us500', 'btc'];
  const settled = await Promise.all(list.map(async (a) => {
    try { return [a, await evaluateLocation(a, opts)]; }
    catch (e) { return [a, locFail(a, 'threw: ' + e.message)]; }
  }));
  const results = {}; let atCount = 0;
  for (const [a, v] of settled) { results[a] = v; if (v.locationOK) atCount++; }
  return { ok: true, results, locationOkCount: atCount, requested: list.length, evaluatedAt: Date.now() };
}

// ─── small helpers ──────────────────────────────────────────────────
function tag(src) { return (z) => ({ ...z, source: src }); }
function slim(z, asset) { return { source: z.source || null, kind: z.kind, lo: round(z.lo), hi: round(z.hi), mid: round(z.mid), widthPips: priceToPips(asset, z.hi - z.lo), visits: z.visits, touches: z.touches }; }
function priceToPips(asset, priceDist) { const m = getAssetById(asset); const pip = m ? m.pipSize : 0.0001; return Math.round((priceDist / pip) * 10) / 10; }
function round(x) { return (x == null || !isFinite(x)) ? null : Math.round(x * 1e5) / 1e5; }
function fmt(x) { return (x == null || !isFinite(x)) ? 'n/a' : (Math.round(x * 1e5) / 1e5).toString(); }
function locFail(asset, reason, bias) {
  return { asset, direction: bias ? bias.direction : null, tradeType: bias ? bias.tradeType : null, atAOI: false, locationOK: false, broken: false, activeZone: null, conflict: { blocked: false, reason: null }, confluences: { roundNumber: false, ema50: false, prevStructure: false, details: {} }, zones: null, notes: [reason], evaluatedAt: Date.now() };
}

// ─── HTTP handler (read-only) ───────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (q.asset) {
      if (!getAssetById(q.asset)) return res.status(400).json({ ok: false, error: 'unknown asset' });
      return res.status(200).json({ ok: true, location: await evaluateLocation(q.asset) });
    }
    const assets = q.assets ? String(q.assets).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
    return res.status(200).json(await evaluateUniverse(assets));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.evaluateLocation = evaluateLocation;
module.exports.evaluateUniverse = evaluateUniverse;
module.exports.buildZones = buildZones;
module.exports.roundIncrementFor = roundIncrementFor;
module.exports.ema = ema;
module.exports.CFG = CFG;