/* eslint-disable */
// api/alexg-trade.js
//
// ALEX G — "Full Set & Forget" strategy — LAYER 4: TRADE CONSTRUCTION + GRADE
// ============================================================================
// Turns a confirmed entry into a concrete, gradeable order: stop, target, RR,
// the A–F confluence grade, and the session gate. This is the last layer before
// wiring; its output is a complete trade plan the bot can place and forget.
//
// MAPS DIRECTLY TO THE PDF:
//   - SL 5–7 pips beyond the AOI, never moved                 (l.880+)
//   - TP at the nearest respected D/W structure point, capped
//     just before an opposing AOI; NO partials                (l.887-896)
//   - 1:2.5 RR minimum => "No Grade"                          (l.~)
//   - exact weighted checklist; Shift + Engulfing "Required";
//     grade A>=90 B>=80 C>=70 D>=60 F>=50 (can exceed 100)    (l.950-1245)
//   - sessions: London open -> 2h before NY close; avoid Asia (l.1186-1214)
//
// HONEST SCOPE: candlestick-rejection patterns and chart patterns (H&S, double
// top/bottom) are NOT detected yet, so those checklist weights are marked
// `detectable:false` and excluded from the denominator. The grade is therefore
// "% of the DETECTABLE confluences present", and the response lists exactly
// which items aren't measured yet. When those detectors are built, the grade
// converges to the full PDF scale automatically.
//
// READ-ONLY planner. Consumes Layers 1-3. Trades nothing itself.
// ----------------------------------------------------------------------------

const { getAssetById } = require('./asset-registry');
const BIAS = require('./alexg-bias');
const AOI = require('./alexg-aoi');
const ENTRY = require('./alexg-entry');
const P = require('./alexg-patterns');

let _fetchCandlesCached = null;
function defaultFetchCandles() {
  if (!_fetchCandlesCached) { try { _fetchCandlesCached = require('./candle-source').fetchCandles; } catch (_) {} }
  return _fetchCandlesCached;
}

const CFG = {
  slPips:        6,      // PDF: 5–7 pips beyond the AOI (forex)
  slAtrFrac:     0.10,   // …or this fraction of Daily ATR, whichever is larger (non-fx scale)
  rrFloor:       2.0,    // hard reject below this
  rrPreferred:   2.5,    // PDF "1:2.5 minimum" — below this dings the grade
  minGradePct:   70,     // minimum normalised grade to fire (C). TUNABLE.
  minTpAtrFrac:  0.75,   // TP must be at least this many ATRs away (avoid micro-targets)
  sessionStartUTC: 7,    // London open (~07:00–08:00 UTC)
  sessionEndUTC:   20,   // ~2h before NY close
  dLookback:     240,
};

// ─── grade checklists (exact PDF weights) ───────────────────────────
// detectable=false => weight excluded from the denominator (not yet measured).
function swingChecklist(ctx) {
  return [
    { key: 'inSyncWD',        w: ctx.fullStack ? 30 : 20, det: true, on: true },
    { key: 'atWAOI',          w: 10, det: true, on: ctx.atWAOI },
    { key: 'atDAOI',          w: 10, det: true, on: ctx.atDAOI },
    { key: 'wEMA50',          w: 5,  det: true, on: ctx.wEMA },
    { key: 'dEMA50',          w: 5,  det: true, on: ctx.dEMA },
    { key: 'roundNumber',     w: 5,  det: true, on: ctx.round },
    { key: 'wPrevStructure',  w: 10, det: true, on: ctx.wPrev },
    { key: 'dPrevStructure',  w: 10, det: true, on: ctx.dPrev },
    { key: 'wCandleRejection',w: 10, det: true, on: ctx.wCandleRej },
    { key: 'dCandleRejection',w: 10, det: true, on: ctx.dCandleRej },
    { key: 'wPatterns',       w: 10, det: true, on: ctx.wPattern },
    { key: 'dPatterns',       w: 10, det: true, on: ctx.dPattern },
    { key: 'shift',           w: 10, det: true, on: ctx.shift, required: true },
    { key: 'engulfing',       w: 10, det: true, on: ctx.engulf, required: true },
    { key: 'entryPattern',    w: 5,  det: true, on: ctx.entryPattern },
  ];
}
function dayChecklist(ctx) {
  return [
    { key: 'inSyncD4',        w: 20, det: true, on: true },
    { key: 'atDAOI',          w: 10, det: true, on: ctx.atDAOI },
    { key: 'at4hAOI',         w: 5,  det: true, on: ctx.at4hAOI },
    { key: 'dEMA50',          w: 5,  det: true, on: ctx.dEMA },
    { key: 'h4EMA50',         w: 5,  det: true, on: ctx.h4EMA },
    { key: 'roundNumber',     w: 5,  det: true, on: ctx.round },
    { key: 'dPrevStructure',  w: 10, det: true, on: ctx.dPrev },
    { key: 'h4PrevStructure', w: 5,  det: true, on: ctx.h4Prev },
    { key: 'dCandleRejection',w: 10, det: true, on: ctx.dCandleRej },
    { key: 'h4CandleRejection',w: 10, det: true, on: ctx.h4CandleRej },
    { key: 'dPatterns',       w: 10, det: true, on: ctx.dPattern },
    { key: 'h4Patterns',      w: 10, det: true, on: ctx.h4Pattern },
    { key: 'shift',           w: 10, det: true, on: ctx.shift, required: true },
    { key: 'engulfing',       w: 10, det: true, on: ctx.engulf, required: true },
    { key: 'entryPattern',    w: 5,  det: true, on: ctx.entryPattern },
  ];
}

function gradeSetup(tradeType, ctx) {
  const items = (tradeType === 'day' ? dayChecklist : swingChecklist)(ctx);
  let raw = 0, maxDet = 0, maxFull = 0;
  for (const it of items) {
    maxFull += it.w;
    if (it.det) { maxDet += it.w; if (it.on) raw += it.w; }
  }
  const pct = maxDet > 0 ? (raw / maxDet) * 100 : 0;
  const letter = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : pct >= 50 ? 'F' : 'F-';
  const undetected = items.filter((i) => !i.det).map((i) => i.key);
  return { pct: Math.round(pct * 10) / 10, letter, rawScore: raw, maxDetectable: maxDet, maxFull, undetected, items: items.map((i) => ({ key: i.key, w: i.w, on: !!i.on, detectable: i.det, required: !!i.required })) };
}

// ─── structure-based TP, capped before an opposing AOI ──────────────
function structureTP(pivots, wPivots, entry, direction, opposingZones, atrVal) {
  const minDist = CFG.minTpAtrFrac * atrVal;
  const all = [...(pivots || []), ...(wPivots || [])];
  let target = null;
  if (direction === 'long') {
    const highs = all.filter((p) => p.type === 'H' && p.close > entry + minDist).map((p) => p.close);
    if (highs.length) target = Math.min(...highs);            // nearest respected high above
    // cap just before the nearest opposing supply zone above entry
    const caps = (opposingZones || []).filter((z) => z.lo > entry).map((z) => z.lo);
    if (caps.length) { const nc = Math.min(...caps); if (target == null || nc < target) target = nc - 0.05 * atrVal; }
  } else {
    const lows = all.filter((p) => p.type === 'L' && p.close < entry - minDist).map((p) => p.close);
    if (lows.length) target = Math.max(...lows);
    const caps = (opposingZones || []).filter((z) => z.hi < entry).map((z) => z.hi);
    if (caps.length) { const nc = Math.max(...caps); if (target == null || nc > target) target = nc + 0.05 * atrVal; }
  }
  return target;
}

// ─── session gate ───────────────────────────────────────────────────
function sessionGate(now) {
  const h = (now ? new Date(now) : new Date()).getUTCHours();
  const ok = h >= CFG.sessionStartUTC && h < CFG.sessionEndUTC;
  return { ok, hourUTC: h, window: `${CFG.sessionStartUTC}:00–${CFG.sessionEndUTC}:00 UTC (London→NY, Asia blocked)` };
}

// ─── main ───────────────────────────────────────────────────────────
// Memoize candle fetches for the life of ONE evaluation so the same
// (asset,tf,n) is fetched once instead of re-fetched by every layer
// (eligibility→bias→aoi→entry→grade). Caches the in-flight promise to also
// dedupe concurrent identical fetches; drops the entry on rejection so a
// transient error can be retried on a later call.
function makeMemoFetch(base) {
  const cache = new Map();
  return function (asset, tf, n) {
    const key = asset + '|' + tf + '|' + n;
    const hit = cache.get(key);
    if (hit) return hit;
    const p = Promise.resolve().then(() => base(asset, tf, n));
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
  };
}

async function evaluateTrade(asset, opts = {}) {
  const baseFc = opts.fetchCandlesFn || defaultFetchCandles();
  const fc = makeMemoFetch(baseFc);            // one shared cache per evaluation
  const subOpts = { ...opts, fetchCandlesFn: fc };
  const m = getAssetById(asset) || {};
  const pip = m.pipSize || 0.0001;

  // resolution / data probe — distinguishes "symbol didn't resolve / no history"
  // from "resolved but no setup", so the dashboard shows a clear status. Uses the
  // memoized fetcher, so this daily pull is shared with the chain (no extra cost).
  try {
    const probe = await fc(asset, '1d', 50);
    const nD = (probe && probe.candles && probe.candles.length) || 0;
    if (nD < 40) {
      const dReason = nD === 0 ? 'no candle data — symbol may be unresolved on broker' : `insufficient history (${nD} daily candles)`;
      return plan(asset, { tradeable: false, reason: dReason,
        funnel: { stage: 'data', reached: [], waitingFor: dReason, direction: null, bias: null, aoi: null, entry: null, session: null, grade: null } });
    }
  } catch (e) {
    return plan(asset, { tradeable: false, reason: 'data fetch failed — symbol may be unresolved: ' + e.message,
      funnel: { stage: 'data', reached: [], waitingFor: 'data fetch failed — ' + e.message, direction: null, bias: null, aoi: null, entry: null, session: null, grade: null } });
  }

  // chain (memoized fetches make re-calls free); allow injection for tests
  let bias = opts.bias, loc = opts.location, entry = opts.entry;
  try {
    if (!bias) bias = await BIAS.evaluateBias(asset, subOpts);
    if (!loc) loc = await AOI.evaluateLocation(asset, { ...subOpts, bias });
    if (!entry) entry = await ENTRY.evaluateEntry(asset, { ...subOpts, location: loc });
  } catch (e) { return plan(asset, { tradeable: false, reason: 'pipeline threw: ' + e.message, funnel: { stage: 'error', reached: ['data'], waitingFor: 'pipeline error — ' + e.message, direction: null, bias: null, aoi: null, entry: null, session: null, grade: null } }); }

  const session = sessionGate(opts.now);

  if (!entry || !entry.entrySignal) {
    return plan(asset, { direction: entry && entry.direction, tradeType: entry && entry.tradeType, tradeable: false, reason: 'no entry signal', session, funnel: buildFunnel(bias, loc, entry, session, null, null) });
  }

  const dir = entry.direction, zone = entry.activeZone;
  const price = (loc && loc.price) || null;
  if (!zone || price == null) return plan(asset, { direction: dir, tradeType: entry.tradeType, tradeable: false, reason: 'missing zone/price', session, funnel: buildFunnel(bias, loc, entry, session, null, null) });

  // candles across all relevant TFs for ATR, TP structure, and confluences
  let d = [], w = [], h4 = [], trig = [];
  const trigTF = entry.triggerTF || '4h';
  try {
    const [dr, wr, hr, tr] = await Promise.all([
      fc(asset, '1d', CFG.dLookback), fc(asset, '1w', 90),
      fc(asset, '4h', 180), fc(asset, trigTF, 150),
    ]);
    d = (dr && dr.candles) || []; w = (wr && wr.candles) || [];
    h4 = (hr && hr.candles) || []; trig = (tr && tr.candles) || [];
  } catch (_) {}
  const atrD = BIAS.atr(d) || (zone.hi - zone.lo) || (pip * 50);
  const atrW = BIAS.atr(w) || atrD;
  const atr4 = BIAS.atr(h4) || atrD;
  const sd = BIAS.buildStructure(d, 'D', opts);
  const sw = BIAS.buildStructure(w, 'W', opts);
  const s4 = BIAS.buildStructure(h4, '4h', opts);
  const strig = BIAS.buildStructure(trig, trigTF, opts);

  // ── SL: 5–7 pips (or ATR-scaled) beyond the zone, never moved ──
  const buffer = Math.max(CFG.slPips * pip, CFG.slAtrFrac * atrD);
  const entryPx = price;
  const sl = dir === 'long' ? zone.lo - buffer : zone.hi + buffer;

  // ── TP: nearest respected structure, capped before opposing AOI ──
  const opposing = dir === 'long'
    ? [...((loc.zones && loc.zones.dSupply) || []), ...((loc.zones && loc.zones.wSupply) || [])]
    : [...((loc.zones && loc.zones.dDemand) || []), ...((loc.zones && loc.zones.wDemand) || [])];
  let tp = structureTP(sd.ok ? sd.pivots : [], sw.ok ? sw.pivots : [], entryPx, dir, opposing, atrD);

  const risk = Math.abs(entryPx - sl);
  let rr = null, tpSource = 'structure';
  if (tp != null && risk > 0) rr = dir === 'long' ? (tp - entryPx) / risk : (entryPx - tp) / risk;
  // fallback: if no structure target or RR too low, project the preferred RR
  if (tp == null || rr == null || rr < CFG.rrFloor) {
    const projected = dir === 'long' ? entryPx + CFG.rrPreferred * risk : entryPx - CFG.rrPreferred * risk;
    // only accept the projection if structure doesn't block it earlier
    tp = (tp != null && ((dir === 'long' && tp > entryPx) || (dir === 'short' && tp < entryPx))) ? tp : projected;
    rr = risk > 0 ? (dir === 'long' ? (tp - entryPx) / risk : (entryPx - tp) / risk) : null;
    tpSource = (tp === projected) ? 'projected-RR' : 'structure';
  }

  // ── full confluence context (everything now detectable) ──
  const dClose = d.length ? d[d.length - 1].close : price;
  const wClose = w.length ? w[w.length - 1].close : price;
  const h4Close = h4.length ? h4[h4.length - 1].close : price;
  const dirKind = dir === 'long' ? 'demand' : 'supply';

  const wZone = dirZoneAt(loc, dir, 'W', price);
  const dZone = dirZoneAt(loc, dir, 'D', price) || (zone.source === 'D' ? zone : null);
  let h4Zone = null;
  if (s4.ok) { const z4 = AOI.buildZones(h4, s4.pivots, dirKind, atr4, opts); h4Zone = z4.find((z) => price >= z.lo && price <= z.hi) || null; }

  const emaW = AOI.ema(w.map((c) => c.close), 50), emaD = AOI.ema(d.map((c) => c.close), 50), ema4 = AOI.ema(h4.map((c) => c.close), 50);
  const nearZone = (v, z, a) => !!(z && v != null && v >= z.lo - 0.2 * a && v <= z.hi + 0.2 * a);

  const rejD = P.detectCandleRejection(d, dir, { zone: dZone });
  const rejW = P.detectCandleRejection(w, dir, { zone: wZone });
  const rej4 = P.detectCandleRejection(h4, dir, { zone: h4Zone });
  const patD = P.detectChartPattern(sd.ok ? sd.pivots : [], dir, dClose, atrD);
  const patW = P.detectChartPattern(sw.ok ? sw.pivots : [], dir, wClose, atrW);
  const pat4 = P.detectChartPattern(s4.ok ? s4.pivots : [], dir, h4Close, atr4);
  const patTrig = P.detectChartPattern(strig.ok ? strig.pivots : [], dir, (trig.length ? trig[trig.length - 1].close : price), BIAS.atr(trig) || atrD);
  const rejTrig = P.detectCandleRejection(trig, dir, {});

  const ctx = {
    fullStack: !!(bias && bias.fullStack),
    atWAOI: !!wZone, atDAOI: !!dZone, at4hAOI: !!h4Zone,
    wEMA: nearZone(emaW, wZone, atrW), dEMA: nearZone(emaD, dZone, atrD), h4EMA: nearZone(ema4, h4Zone, atr4),
    round: !!(entry.confluences && entry.confluences.roundNumber),
    wPrev: prevStructAtZone(sw.ok ? sw.pivots : [], wZone, dirKind),
    dPrev: prevStructAtZone(sd.ok ? sd.pivots : [], dZone, dirKind),
    h4Prev: prevStructAtZone(s4.ok ? s4.pivots : [], h4Zone, dirKind),
    wCandleRej: rejW.found, dCandleRej: rejD.found, h4CandleRej: rej4.found,
    wPattern: patW.found, dPattern: patD.found, h4Pattern: pat4.found,
    shift: !!entry.shift, engulf: !!entry.engulfing,
    entryPattern: patTrig.found || rejTrig.found,
  };
  const grade = gradeSetup(entry.tradeType, ctx);
  const patternsFound = [patD, patW, pat4].filter((p) => p.found).map((p) => p.type);

  // ── gates ──
  const notes = [];
  const rrOK = rr != null && rr >= CFG.rrFloor;
  if (!rrOK) notes.push(`RR ${rr == null ? 'n/a' : rr.toFixed(2)} below floor ${CFG.rrFloor} — No Grade`);
  if (rr != null && rr < CFG.rrPreferred && rrOK) notes.push(`RR ${rr.toFixed(2)} below preferred ${CFG.rrPreferred}`);
  const gradeOK = grade.pct >= (opts.minGradePct != null ? opts.minGradePct : CFG.minGradePct);
  if (!gradeOK) notes.push(`grade ${grade.letter} (${grade.pct}%) below minimum ${opts.minGradePct != null ? opts.minGradePct : CFG.minGradePct}%`);
  if (!session.ok) notes.push(`outside session (now ${session.hourUTC}:00 UTC, window ${session.window})`);

  const tradeable = rrOK && gradeOK && session.ok;

  return plan(asset, {
    direction: dir, tradeType: entry.tradeType, triggerTF: entry.triggerTF,
    tradeable,
    reason: tradeable ? 'all gates passed' : notes.join('; '),
    entry: round(entryPx, pip), sl: round(sl, pip), tp: round(tp, pip),
    rr: rr == null ? null : Math.round(rr * 100) / 100,
    riskPips: Math.round((risk / pip) * 10) / 10,
    rewardPips: tp == null ? null : Math.round((Math.abs(tp - entryPx) / pip) * 10) / 10,
    tpSource,
    zone: zone,
    grade,
    patterns: patternsFound,
    session,
    confluences: entry.confluences,
    notes,
    funnel: buildFunnel(bias, loc, entry, session, grade, { tradeable, notes }),
  });
}

function sameDirZoneAtPrice(loc, dir, source, price) {
  if (!loc || !loc.zones) return false;
  const key = (dir === 'long' ? 'Demand' : 'Supply');
  const arr = loc.zones[source.toLowerCase() + key] || [];
  return arr.some((z) => price >= z.lo && price <= z.hi);
}
function dirZoneAt(loc, dir, source, price) {
  if (!loc || !loc.zones) return null;
  const key = source.toLowerCase() + (dir === 'long' ? 'Demand' : 'Supply');
  const arr = loc.zones[key] || [];
  return arr.find((z) => price >= z.lo && price <= z.hi) || null;
}
// previous structure point = an OLD opposite-side swing now sitting in the zone
// (e.g. prior resistance turned support for a demand AOI) — a role-reversal level.
function prevStructAtZone(pivots, zone, kind) {
  if (!zone) return false;
  const opp = kind === 'demand' ? 'H' : 'L';
  return (pivots || []).some((p) => p.type === opp && Math.max(p.bodyLow, zone.lo) <= Math.min(p.bodyHigh, zone.hi));
}

async function evaluateUniverse(assets, opts = {}) {
  const list = (assets && assets.length) ? assets : ['eurusd', 'gbpusd', 'usdjpy', 'usdchf', 'audusd', 'nzdusd', 'usdcad', 'eurjpy', 'gbpjpy', 'gold', 'nas100', 'us500', 'btc'];
  const settled = await Promise.all(list.map(async (a) => {
    try { return [a, await evaluateTrade(a, opts)]; }
    catch (e) { return [a, plan(a, { tradeable: false, reason: 'threw: ' + e.message })]; }
  }));
  const results = {}; let fire = 0;
  for (const [a, v] of settled) { results[a] = v; if (v.tradeable) fire++; }
  return { ok: true, results, tradeableCount: fire, requested: list.length, evaluatedAt: Date.now() };
}

// ─── helpers ────────────────────────────────────────────────────────
function round(x, pip) { if (x == null || !isFinite(x)) return null; const dec = pip < 0.01 ? 5 : pip < 1 ? 3 : 2; return Math.round(x * 10 ** dec) / 10 ** dec; }
function plan(asset, o) { return { asset, direction: o.direction || null, tradeType: o.tradeType || null, triggerTF: o.triggerTF || null, tradeable: !!o.tradeable, reason: o.reason || null, entry: o.entry != null ? o.entry : null, sl: o.sl != null ? o.sl : null, tp: o.tp != null ? o.tp : null, rr: o.rr != null ? o.rr : null, riskPips: o.riskPips != null ? o.riskPips : null, rewardPips: o.rewardPips != null ? o.rewardPips : null, tpSource: o.tpSource || null, zone: o.zone || null, grade: o.grade || null, patterns: o.patterns || [], session: o.session || null, confluences: o.confluences || null, notes: o.notes || [], funnel: o.funnel || null, evaluatedAt: Date.now() }; }

// ─── FUNNEL: read-only progress trace for the dashboard ─────────────
// Purely diagnostic. Turns the discarded bias/AOI/entry objects into a
// per-pair "how far did this pair get, and what is it waiting for next"
// summary so the scanner is legible instead of a silent "no setup".
function buildFunnel(bias, loc, entry, session, grade, gates) {
  const dir = (entry && entry.direction) || (loc && loc.direction) || (bias && bias.direction) || null;
  const f = {
    stage: 'bias', reached: ['data'], waitingFor: null, direction: dir,
    bias: bias ? {
      direction: bias.direction || null, tradeType: bias.tradeType || null,
      fullStack: !!bias.fullStack, inSync: bias.inSync || [],
      awaitingPullback: !!bias.awaitingPullback, counterHigherTF: !!bias.counterHigherTF,
      trends: bias.timeframes ? {
        w: bias.timeframes.w && bias.timeframes.w.trend,
        d: bias.timeframes.d && bias.timeframes.d.trend,
        h4: bias.timeframes.h4 && bias.timeframes.h4.trend,
      } : null,
    } : null,
    aoi: loc ? {
      atAOI: !!loc.atAOI, locationOK: !!loc.locationOK, broken: !!loc.broken,
      activeZone: loc.activeZone || null,
      conflict: (loc.conflict && loc.conflict.blocked) ? (loc.conflict.reason || 'HTF conflict') : null,
      confluences: loc.confluences || null,
      zoneCounts: (loc.zones) ? {
        dDemand: (loc.zones.dDemand || []).length, dSupply: (loc.zones.dSupply || []).length,
        wDemand: (loc.zones.wDemand || []).length, wSupply: (loc.zones.wSupply || []).length,
      } : null,
    } : null,
    entry: entry ? {
      signal: !!entry.entrySignal, triggerTF: entry.triggerTF || null,
      shift: entry.shift ? entry.shift.tf : null,
      engulf: entry.engulfing ? entry.engulfing.tf : null,
      candidates: entry.candidates || [],
    } : null,
    session: session ? { ok: !!session.ok, hourUTC: session.hourUTC, window: session.window } : null,
    grade: grade ? { letter: grade.letter, pct: grade.pct } : null,
  };

  if (!bias || !dir) { f.stage = 'bias'; f.waitingFor = 'HTF bias unclear — waiting for a daily/weekly trend to form'; return f; }
  f.reached.push('bias');
  const dirWord = dir === 'long' ? 'demand' : 'supply';

  if (!(loc && (loc.atAOI || loc.activeZone))) {
    f.stage = 'aoi';
    if (loc && loc.conflict && loc.conflict.blocked) f.waitingFor = `blocked — ${loc.conflict.reason || 'HTF conflict'}`;
    else if (loc && loc.broken) f.waitingFor = `${dir} bias, but the ${dirWord} zone was broken — waiting for a fresh AOI`;
    else f.waitingFor = `bias ${dir}, price not at a ${dirWord} AOI yet — waiting for price to reach a zone`;
    return f;
  }
  f.reached.push('aoi');

  const cands = (entry && entry.candidates) || [];
  const anyShift = cands.some((c) => c.shift);
  const shiftNoEngulf = cands.find((c) => c.shift && !c.engulfing);
  const falseShift = cands.find((c) => c.falseShift);

  if (entry && entry.entrySignal) {
    f.reached.push('entry');
    if (gates && gates.tradeable) { f.stage = 'ready'; f.reached.push('ready'); f.waitingFor = 'SETUP READY — all gates passed'; return f; }
    f.stage = 'gates';
    if (session && !session.ok) f.waitingFor = `entry confirmed — outside session (now ${session.hourUTC}:00 UTC)`;
    else f.waitingFor = (gates && gates.notes && gates.notes.length) ? gates.notes.join('; ') : 'entry confirmed — checking gates';
    return f;
  }

  f.stage = 'entry';
  if (!anyShift) f.waitingFor = `at ${dirWord} AOI — waiting for an LTF shift of structure (CHoCH)`;
  else if (shiftNoEngulf) f.waitingFor = `shift on ${shiftNoEngulf.tf} — waiting for an engulfing candle to confirm`;
  else if (falseShift) f.waitingFor = `shift on ${falseShift.tf} was a mimic (one big candle) — waiting for a clean shift`;
  else f.waitingFor = `at ${dirWord} AOI — waiting for entry confirmation`;
  return f;
}

// ─── HTTP handler (read-only) ───────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (q.asset) {
      if (!getAssetById(q.asset)) return res.status(400).json({ ok: false, error: 'unknown asset' });
      return res.status(200).json({ ok: true, trade: await evaluateTrade(q.asset) });
    }
    const assets = q.assets ? String(q.assets).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
    return res.status(200).json(await evaluateUniverse(assets));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.evaluateTrade = evaluateTrade;
module.exports.evaluateUniverse = evaluateUniverse;
module.exports.gradeSetup = gradeSetup;
module.exports.structureTP = structureTP;
module.exports.sessionGate = sessionGate;
module.exports.CFG = CFG;