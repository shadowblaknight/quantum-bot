// session_liq_analysis.js
// Tests session-liquidity coincidence for silver-bullet, orb, orb-pro, am-ifvg.
// Run from quantum-bot root: node session_liq_analysis.js

'use strict';
require('dotenv').config({ path: '.env.fresh' });

const TDKEY    = process.env.TWELVEDATA_API_KEY;
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const API_BASE = (process.env.QB_PUBLIC_URL || 'https://quantum-bot-mocha.vercel.app').replace(/\/$/, '');

const TARGET_TEMPLATES = new Set(['silver-bullet', 'orb', 'orb-pro', 'am-ifvg']);

// TwelveData symbol map
const TD_SYM = {
  btc:    'BTC/USD',
  eurusd: 'EUR/USD',
  gbpusd: 'GBP/USD',
  usdjpy: 'USD/JPY',
  gold:   'XAU/USD',
  us500:  'SPX',
  nas100: 'NDX',
  eth:    'ETH/USD',
};

// TwelveData free tier: 8 req/min → 8.2s spacing
const TD_RATE_MS = 8200;
let lastTDCallMs = 0;
const tdCache = new Map(); // symbol+startDate → candles (dedupe same-day fetches)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── TwelveData fetch ────────────────────────────────────────────────
async function tdFetch(symbol, startDate, endDate) {
  const cacheKey = `${symbol}|${startDate}|${endDate}`;
  if (tdCache.has(cacheKey)) return tdCache.get(cacheKey);

  const wait = TD_RATE_MS - (Date.now() - lastTDCallMs);
  if (wait > 0) await sleep(wait);
  lastTDCallMs = Date.now();

  const url = `https://api.twelvedata.com/time_series`
    + `?symbol=${encodeURIComponent(symbol)}`
    + `&interval=1min&start_date=${encodeURIComponent(startDate)}`
    + `&end_date=${encodeURIComponent(endDate)}`
    + `&outputsize=5000&apikey=${TDKEY}&timezone=UTC&order=ASC`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (!data.values || !Array.isArray(data.values)) {
    const msg = data.message || data.code || JSON.stringify(data).slice(0, 100);
    console.error(`  TD error for ${symbol}: ${msg}`);
    tdCache.set(cacheKey, null);
    return null;
  }

  const candles = data.values.map(v => ({
    time:  v.datetime.slice(0, 16),
    ts:    new Date(v.datetime.slice(0, 16).replace(' ', 'T') + ':00Z').getTime(),
    open:  parseFloat(v.open),
    high:  parseFloat(v.high),
    low:   parseFloat(v.low),
    close: parseFloat(v.close),
  })).filter(c => isFinite(c.open) && isFinite(c.ts));

  tdCache.set(cacheKey, candles);
  return candles;
}

// ── Upstash Redis REST ───────────────────────────────────────────────
async function kvGet(key) {
  const encoded = encodeURIComponent(key);
  const resp = await fetch(`${KV_URL}/get/${encoded}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await resp.json();
  if (data.result == null) return null;
  if (typeof data.result === 'object') return data.result;
  try { return JSON.parse(data.result); } catch (_) { return data.result; }
}

// ── h1ATR: max(high)−min(low) of up to 60 1-min bars before signalTs ─
function computeATR(candles, signalTs) {
  const pre = candles.filter(c => c.ts < signalTs);
  if (pre.length < 10) return null;
  const slice = pre.slice(-60);
  const hi = Math.max(...slice.map(c => c.high));
  const lo = Math.min(...slice.map(c => c.low));
  return hi > lo ? hi - lo : null;
}

// ── Session high/low within a UTC ms window ──────────────────────────
function sessionHL(candles, startMs, endMs) {
  const s = candles.filter(c => c.ts >= startMs && c.ts < endMs);
  if (!s.length) return null;
  return { high: Math.max(...s.map(c => c.high)), low: Math.min(...s.map(c => c.low)) };
}

// ── Compute all completed session levels for a given signal ──────────
// Only uses sessions that CLOSED before signalTs (no look-ahead).
function computeSessionLevels(candles, signalTs, signalDateStr) {
  const mdn    = new Date(signalDateStr + 'T00:00:00Z').getTime(); // signal-day midnight UTC
  const prevMdn = mdn - 86400000;                                   // prev-day midnight UTC

  const levels = {};

  // Previous-day high/low — always available (full day has closed)
  // Use 00:00–00:00 next day = full UTC calendar day
  const prevDayHL = sessionHL(candles, prevMdn, mdn);
  if (prevDayHL) { levels.prevDayHigh = prevDayHL.high; levels.prevDayLow = prevDayHL.low; }

  // Asian session 00:00–07:00 UTC on signal day — available if signalTs ≥ 07:00
  const asianEnd = mdn + 7 * 3600 * 1000;
  if (signalTs >= asianEnd) {
    const aHL = sessionHL(candles, mdn, asianEnd);
    if (aHL) { levels.asianHigh = aHL.high; levels.asianLow = aHL.low; }
  }

  // London session 07:00–12:00 UTC on signal day — available if signalTs ≥ 12:00
  const londonStart = mdn + 7  * 3600 * 1000;
  const londonEnd   = mdn + 12 * 3600 * 1000;
  if (signalTs >= londonEnd) {
    const lHL = sessionHL(candles, londonStart, londonEnd);
    if (lHL) { levels.londonHigh = lHL.high; levels.londonLow = lHL.low; }
  }

  return levels;
}

// ── Find nearest session level and ATR distance ───────────────────────
function findNearest(entryLevel, levels, atr) {
  let nearest = null;
  let minDist = Infinity;
  for (const [name, lvl] of Object.entries(levels)) {
    const dist = Math.abs(entryLevel - lvl);
    if (dist < minDist) { minDist = dist; nearest = { name, lvl, dist, distATR: dist / atr }; }
  }
  return nearest;
}

// ── Session-trend context ─────────────────────────────────────────────
function sessionTrend(candles, signalTs, signalDateStr) {
  const mdn         = new Date(signalDateStr + 'T00:00:00Z').getTime();
  const asianEnd    = mdn + 7  * 3600 * 1000;
  const londonStart = mdn + 7  * 3600 * 1000;
  const londonEnd   = mdn + 12 * 3600 * 1000;

  // Price position vs Asian range at signal time
  let asianContext = null;
  const asianHL = signalTs >= asianEnd ? sessionHL(candles, mdn, asianEnd) : null;
  if (asianHL) {
    const signalBars = candles.filter(c => c.ts <= signalTs);
    const lastClose  = signalBars.length ? signalBars[signalBars.length - 1].close : null;
    if (lastClose != null) {
      if (lastClose > asianHL.high)      asianContext = 'aboveAsian';
      else if (lastClose < asianHL.low)  asianContext = 'belowAsian';
      else                               asianContext = 'insideAsian';
    }
  }

  // London trend: did London close higher than it opened?
  let londonTrend = null;
  if (signalTs >= londonEnd) {
    const lonOpen  = candles.find(c => c.ts >= londonStart && c.ts < londonEnd);
    const lonBars  = candles.filter(c => c.ts >= londonStart && c.ts < londonEnd);
    const lonClose = lonBars.length ? lonBars[lonBars.length - 1] : null;
    if (lonOpen && lonClose) {
      londonTrend = lonClose.close > lonOpen.open ? 'bullish' : 'bearish';
    }
  }

  return { asianContext, londonTrend };
}

// ── R stats helper ────────────────────────────────────────────────────
function stats(arr) {
  const n    = arr.length;
  if (!n) return { n: 0, wr: null, netR: null, avgR: null };
  const wins = arr.filter(t => t.outcome === 'WIN').length;
  const rs   = arr.filter(t => t.pnlR != null).map(t => t.pnlR);
  const net  = rs.reduce((s, v) => s + v, 0);
  return {
    n, wr: Math.round(wins / n * 1000) / 10,
    netR: Math.round(net * 100) / 100,
    avgR: rs.length ? Math.round(net / rs.length * 100) / 100 : null,
  };
}

// ────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────
async function main() {

  // ── STEP 1: Fetch perf-ranking ─────────────────────────────────────
  console.log('Fetching /api/perf-ranking ...');
  const pr = await fetch(`${API_BASE}/api/perf-ranking`).then(r => r.json());
  const allTrades = Array.isArray(pr.trades) ? pr.trades : [];

  const targets = allTrades.filter(t => TARGET_TEMPLATES.has(t.template));

  console.log(`\nAll perf-ranking trades: ${allTrades.length}`);
  console.log(`Filtered (${[...TARGET_TEMPLATES].join(', ')}): ${targets.length}`);

  // ── STEP 2: Print full trade ID list ────────────────────────────────
  console.log('\n=== FULL TRADE LIST ===');
  for (const t of targets) {
    console.log(`  ${t.id}  tmpl=${t.template}  asset=${t.asset}  dir=${t.direction || '?'}  outcome=${t.outcome || '?'}  pnlR=${t.pnlR != null ? t.pnlR : '?'}  src=${t._source}`);
  }
  console.log(`COUNT: ${targets.length}`);

  // ── STEP 3: Per-trade analysis ───────────────────────────────────────
  const results = [];

  for (const t of targets) {

    // EXCLUDE: us500/nas100 — TwelveData paid plan required
    if (t.asset === 'us500' || t.asset === 'nas100') {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: 'SPX/NDX requires TwelveData Grow+ plan (free tier returns 404)', outcome: t.outcome, pnlR: t.pnlR });
      continue;
    }

    // EXCLUDE: unknown symbol
    const tdSym = TD_SYM[t.asset];
    if (!tdSym) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: `No TwelveData symbol mapping for asset "${t.asset}"`, outcome: t.outcome, pnlR: t.pnlR });
      continue;
    }

    // EXCLUDE: weekend (no session levels make sense)
    const openedMs = t.openedAt ? new Date(t.openedAt).getTime() : null;
    if (!openedMs || !isFinite(openedMs)) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: 'Missing or invalid openedAt', outcome: t.outcome, pnlR: t.pnlR });
      continue;
    }
    const openedDay = new Date(openedMs).getUTCDay();
    if (openedDay === 0 || openedDay === 6) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: 'WEEKEND — no trading session', outcome: t.outcome, pnlR: t.pnlR });
      continue;
    }

    // Fetch ledger record for entry/SL prices
    let ledger = null;
    try { ledger = await kvGet(`v14:ledger:trade:${t.id}`); } catch (_) {}

    if (!ledger || (!ledger.actualEntry && !ledger.plannedEntry)) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: `No ledger record or missing entry price (_source=${t._source})`, outcome: t.outcome, pnlR: t.pnlR });
      continue;
    }

    const entryLevel = parseFloat(ledger.actualEntry ?? ledger.plannedEntry);
    const slPrice    = parseFloat(ledger.slPrice ?? 'NaN');
    const direction  = ledger.direction ?? t.direction;
    const pnlR       = ledger.pnlR  != null ? ledger.pnlR  : t.pnlR;
    const outcome    = ledger.outcome ?? t.outcome;
    const openedAt   = ledger.openedAt ?? t.openedAt;

    if (!isFinite(entryLevel)) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: 'actualEntry and plannedEntry are both non-numeric', outcome, pnlR });
      continue;
    }

    const signalTs   = new Date(openedAt).getTime();
    const signalDate = new Date(signalTs).toISOString().slice(0, 10); // UTC date

    // Fetch 3-day candle window: from 3 days before entry to 1h after
    const startMs = signalTs - 3 * 86400 * 1000;
    const endMs   = signalTs + 3600 * 1000;
    const startStr = new Date(startMs).toISOString().slice(0, 16).replace('T', ' ');
    const endStr   = new Date(endMs).toISOString().slice(0, 16).replace('T', ' ');

    let candles;
    try {
      candles = await tdFetch(tdSym, startStr, endStr);
    } catch (e) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: `TwelveData fetch error: ${e.message}`, outcome, pnlR });
      continue;
    }

    if (!candles || candles.length < 10) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: 'TwelveData returned <10 candles (symbol unavailable or market closed)', outcome, pnlR });
      continue;
    }

    // ATR: 60 bars before signal
    const atr = computeATR(candles, signalTs);
    if (!atr) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: 'Insufficient pre-signal candles for ATR (<10 bars)', outcome, pnlR });
      continue;
    }

    // Session levels (no look-ahead)
    const sessionLevels = computeSessionLevels(candles, signalTs, signalDate);
    if (Object.keys(sessionLevels).length === 0) {
      results.push({ id: t.id, template: t.template, asset: t.asset, status: 'EXCLUDED',
        reason: 'No completed session levels available at signal time', outcome, pnlR });
      continue;
    }

    // Nearest level and coincidence
    const nearest = findNearest(entryLevel, sessionLevels, atr);
    const LIQ_THRESHOLD = 0.25; // ATR
    const liqCoin = nearest && nearest.distATR <= LIQ_THRESHOLD;

    // Direction: is the entry BREAKING THROUGH that level (sweep candidate)?
    // Sweep = LONG breaking above a HIGH level, or SHORT breaking below a LOW level
    let sweepCandidate = null;
    if (liqCoin && nearest) {
      const isHigh = nearest.name.toLowerCase().includes('high');
      const isLow  = nearest.name.toLowerCase().includes('low');
      if (direction === 'LONG')  sweepCandidate = isHigh;
      if (direction === 'SHORT') sweepCandidate = isLow;
    }

    // Session trend context
    const { asianContext, londonTrend } = sessionTrend(candles, signalTs, signalDate);

    // Trade WITH prior session direction?
    let withPriorSession = null;
    if (londonTrend) {
      withPriorSession = (direction === 'LONG'  && londonTrend === 'bullish')
                      || (direction === 'SHORT' && londonTrend === 'bearish');
    } else if (asianContext && asianContext !== 'insideAsian') {
      withPriorSession = (direction === 'LONG'  && asianContext === 'aboveAsian')
                      || (direction === 'SHORT' && asianContext === 'belowAsian');
    }

    const row = {
      id: t.id, template: t.template, asset: t.asset, direction,
      outcome, pnlR, openedAt, signalDate,
      entryLevel: +entryLevel.toFixed(6), slPrice: isFinite(slPrice) ? +slPrice.toFixed(6) : null,
      atr: +atr.toFixed(6),
      sessionLevels: Object.fromEntries(Object.entries(sessionLevels).map(([k, v]) => [k, +v.toFixed(6)])),
      nearest: nearest ? { name: nearest.name, lvl: +nearest.lvl.toFixed(6), distATR: +nearest.distATR.toFixed(4) } : null,
      liqCoin, sweepCandidate,
      asianContext, londonTrend, withPriorSession,
      status: 'ANALYZED',
    };
    results.push(row);
    console.log(`  [ANALYZED] ${t.id}  liq=${liqCoin}  nearest=${nearest?.name}@${nearest?.distATR?.toFixed(3)}ATR  sweep=${sweepCandidate}  asian=${asianContext}  london=${londonTrend}`);
  }

  // ── STEP 4: Audit table ──────────────────────────────────────────────
  const analyzed = results.filter(r => r.status === 'ANALYZED');
  const excluded = results.filter(r => r.status === 'EXCLUDED');

  console.log('\n=== AUDIT TABLE ===');
  console.log(`Total filtered: ${targets.length}`);
  console.log(`ANALYZED:       ${analyzed.length}`);
  console.log(`EXCLUDED:       ${excluded.length}`);
  if (analyzed.length + excluded.length !== targets.length) {
    console.error(`ERROR: ${analyzed.length} + ${excluded.length} = ${analyzed.length + excluded.length} ≠ ${targets.length}`);
    process.exit(1);
  }
  console.log('Row counts verified ✓');

  for (const r of excluded) console.log(`  EXCLUDED  ${r.id}  tmpl=${r.template}  ${r.reason}`);

  // ── STEP 5: Per-trade data dump ──────────────────────────────────────
  console.log('\n=== PER-TRADE DETAIL ===');
  for (const r of analyzed) {
    const lvls = Object.entries(r.sessionLevels).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`${r.id}|${r.template}|${r.asset}|${r.direction}|${r.outcome}|${r.pnlR}|liq=${r.liqCoin}|nearest=${r.nearest?.name}@${r.nearest?.distATR}|sweep=${r.sweepCandidate}|asian=${r.asianContext}|london=${r.londonTrend}|withSess=${r.withPriorSession}|${lvls}`);
  }

  // ── STEP 6: Statistics per template ─────────────────────────────────
  console.log('\n=== TEMPLATE BREAKDOWN ===');
  const TMPL_ORDER = ['orb', 'orb-pro', 'silver-bullet', 'am-ifvg'];

  for (const tmpl of TMPL_ORDER) {
    const group = analyzed.filter(r => r.template === tmpl);
    if (!group.length) { console.log(`\n${tmpl.toUpperCase()}: no analyzed trades`); continue; }
    const coin   = group.filter(r => r.liqCoin);
    const nocoin = group.filter(r => !r.liqCoin);
    const sweep  = coin.filter(r => r.sweepCandidate === true);
    const nosweep = coin.filter(r => r.sweepCandidate === false);

    console.log(`\n${tmpl.toUpperCase()} (n=${group.length} analyzed):`);
    console.log(`  ALL:               n=${group.length}  ${JSON.stringify(stats(group))}`);
    console.log(`  Coincident:        n=${coin.length}   ${JSON.stringify(stats(coin))}   (within 0.25ATR of a session level)`);
    console.log(`  Non-coincident:    n=${nocoin.length} ${JSON.stringify(stats(nocoin))}`);
    if (coin.length) {
      console.log(`    ↳ sweep-direct:  n=${sweep.length}   ${JSON.stringify(stats(sweep))}   (breaking THROUGH high/low)`);
      console.log(`    ↳ non-sweep:     n=${nosweep.length} ${JSON.stringify(stats(nosweep))}  (near level but not sweeping)`);
    }

    // Nearest level type breakdown for coincident trades
    if (coin.length) {
      const byType = {};
      for (const r of coin) {
        const k = r.nearest?.name || 'unknown';
        (byType[k] = byType[k] || []).push(r);
      }
      console.log(`    Level types: ${Object.entries(byType).map(([k, v]) => `${k}=${v.length}`).join(' ')}`);
    }

    if (group.length < 8) console.log(`    ⚠  n < 8 — insufficient for reliable inference`);
    if (coin.length   < 8) console.log(`    ⚠  coincident group n=${coin.length} < 8`);
    if (nocoin.length < 8) console.log(`    ⚠  non-coincident group n=${nocoin.length} < 8`);
  }

  // ── STEP 7: Pooled analysis ──────────────────────────────────────────
  const coin   = analyzed.filter(r => r.liqCoin);
  const nocoin = analyzed.filter(r => !r.liqCoin);
  const sweep  = coin.filter(r => r.sweepCandidate === true);

  console.log('\n=== POOLED (all 4 templates) ===');
  console.log(`ALL:               ${JSON.stringify(stats(analyzed))}`);
  console.log(`Coincident:        ${JSON.stringify(stats(coin))}`);
  console.log(`Non-coincident:    ${JSON.stringify(stats(nocoin))}`);
  console.log(`Sweep-direction:   ${JSON.stringify(stats(sweep))}`);
  if (analyzed.length < 8) console.log('⚠  pooled n < 8 — do not interpret');
  if (coin.length < 8)     console.log(`⚠  coincident group n=${coin.length} < 8 — insufficient`);

  // ── STEP 8: Session-trend analysis ──────────────────────────────────
  const withSess    = analyzed.filter(r => r.withPriorSession === true);
  const againstSess = analyzed.filter(r => r.withPriorSession === false);
  const noSessData  = analyzed.filter(r => r.withPriorSession == null);

  console.log('\n=== SESSION TREND ===');
  console.log(`London trend available: ${analyzed.filter(r => r.londonTrend).length} trades`);
  console.log(`Asian context available: ${analyzed.filter(r => r.asianContext).length} trades`);
  console.log(`WITH prior session:    n=${withSess.length}    ${JSON.stringify(stats(withSess))}`);
  console.log(`AGAINST prior session: n=${againstSess.length}  ${JSON.stringify(stats(againstSess))}`);
  console.log(`No session data:       n=${noSessData.length}`);

  // Asian position breakdown
  for (const ctx of ['aboveAsian', 'insideAsian', 'belowAsian']) {
    const g = analyzed.filter(r => r.asianContext === ctx);
    if (g.length) console.log(`  ${ctx}: ${JSON.stringify(stats(g))}`);
  }

  // London trend breakdown
  for (const tr of ['bullish', 'bearish']) {
    const g = analyzed.filter(r => r.londonTrend === tr);
    if (g.length) console.log(`  London ${tr}: ${JSON.stringify(stats(g))}`);
  }

  console.log('\n=== DONE ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
