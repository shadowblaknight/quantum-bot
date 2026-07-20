/* eslint-disable */
// orb_sweep_redo.js — Fully traceable ORB sweep analysis
// Run: node orb_sweep_redo.js  (from quantum-bot root, Node 18+)
// Data source: live /api/perf-ranking, TwelveData 1-min candles, Upstash KV ledger

const TDKEY    = '7a56659902cd4756a8a65068af305db4';
const KV_URL   = 'https://talented-doe-70974.upstash.io';
const KV_TOKEN = 'gQAAAAAAARU-AAIncDJiN2Q2MjA1NzgxZWQ0ZGY4OWUxZWQxNTI1YTQ4Njk4MHAyNzA5NzQ';
const API_BASE = 'https://quantum-bot-mocha.vercel.app';

// TwelveData symbol map
const TD_SYM = {
  btc:    'BTC/USD',
  eurusd: 'EUR/USD',
  gbpusd: 'GBP/USD',
  usdjpy: 'USD/JPY',
  us500:  'SPX',
  nas100: 'NDX',
  gold:   'XAU/USD',
};

// Rate: free tier = 8 req/min. Use 8.2s between calls.
const RATE_MS  = 8200;
let lastTDCall = 0;
const candleCache = new Map();

// ─── helpers ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function utcStr(ms) {
  // "2026-07-06 14:30" — TwelveData start_date / end_date format
  return new Date(ms).toISOString().replace('T',' ').slice(0,16);
}

function barKey(ms) {
  // floor to minute, returns "2026-07-06 14:30"
  return utcStr(Math.floor(ms / 60000) * 60000);
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${KV_TOKEN}` },
      signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}

async function fetchCandles(tdSymbol, startMs, endMs) {
  const ck = `${tdSymbol}|${startMs}|${endMs}`;
  if (candleCache.has(ck)) return candleCache.get(ck);

  const wait = RATE_MS - (Date.now() - lastTDCall);
  if (wait > 0) await sleep(wait);
  lastTDCall = Date.now();

  const url = `https://api.twelvedata.com/time_series`
    + `?symbol=${encodeURIComponent(tdSymbol)}`
    + `&interval=1min`
    + `&start_date=${encodeURIComponent(utcStr(startMs))}`
    + `&end_date=${encodeURIComponent(utcStr(endMs))}`
    + `&timezone=UTC&outputsize=500&format=JSON&apikey=${TDKEY}`;

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) { candleCache.set(ck, null); return null; }
    const d = await r.json();
    if (d.status === 'error' || !Array.isArray(d.values)) {
      console.error(`  TD error for ${tdSymbol}: ${d.message || JSON.stringify(d).slice(0,80)}`);
      candleCache.set(ck, null); return null;
    }
    const candles = d.values
      .map(v => ({
        time:  v.datetime.slice(0, 16),    // normalize to "YYYY-MM-DD HH:mm"
        open:  parseFloat(v.open),
        high:  parseFloat(v.high),
        low:   parseFloat(v.low),
        close: parseFloat(v.close),
      }))
      .filter(c => isFinite(c.close))
      .reverse();                          // oldest-first
    candleCache.set(ck, candles);
    return candles;
  } catch(e) {
    console.error(`  TD fetch exception for ${tdSymbol}: ${e.message}`);
    candleCache.set(ck, null); return null;
  }
}

// Find candle whose bar-open time equals targetKey ("YYYY-MM-DD HH:mm")
function findBar(candles, targetKey) {
  return candles.find(c => c.time === targetKey) || null;
}

// Bars at minute positions [startKey+1min, +2min, ..., +N*1min]
function barsAfter(candles, signalKey, N) {
  const idx = candles.findIndex(c => c.time === signalKey);
  if (idx < 0) return [];
  return candles.slice(idx + 1, idx + 1 + N);
}

// Candles whose open-time is in [startMs, endMs)
function barsInWindow(candles, startMs, endMs) {
  return candles.filter(c => {
    const t = new Date(c.time + ':00Z').getTime();
    return t >= startMs && t < endMs;
  });
}

// ─── metric functions ────────────────────────────────────────────────────────

function computeOR(orBars) {
  if (!orBars.length) return null;
  return {
    orbH:     Math.max(...orBars.map(b => b.high)),
    orbL:     Math.min(...orBars.map(b => b.low)),
    orbRange: Math.max(...orBars.map(b => b.high)) - Math.min(...orBars.map(b => b.low)),
  };
}

// wickRatio: wick on the side AGAINST the trade (upper for LONG, lower for SHORT)
// 0 = no rejection wick, 1 = entire bar is wick
function metricWickRatio(bar, dir) {
  const range = bar.high - bar.low;
  if (range < 1e-12) return 0;
  return dir === 'LONG'
    ? (bar.high - bar.close) / range
    : (bar.close - bar.low)  / range;
}

// closePosition direction-normalised: 1 = close at the favourable extreme
// LONG: 1 = close at bar high   SHORT: 1 = close at bar low
function metricClosePos(bar, dir) {
  const range = bar.high - bar.low;
  if (range < 1e-12) return 0.5;
  return dir === 'LONG'
    ? (bar.close - bar.low)  / range
    : (bar.high - bar.close) / range;
}

// breakoutMagnitude = (close − orbEdge) / orbSLDist, sign-adjusted for direction
// LONG: positive when close > orbH (broke out)
// SHORT: positive when close < orbL
function metricBkMag(bar, orbH, orbL, orbSLDist, dir) {
  if (!orbSLDist || orbSLDist < 1e-12) return null;
  return dir === 'LONG'
    ? (bar.close - orbH) / orbSLDist
    : (orbL - bar.close) / orbSLDist;
}

// orRangeATR = orbRange / h1ATR_estimate
// h1ATR_estimate = high-low range of the 60 1-min bars immediately before OR start
function metricOrRangeATR(orbRange, preBars) {
  if (!preBars.length) return null;
  const h = Math.max(...preBars.map(b => b.high));
  const l = Math.min(...preBars.map(b => b.low));
  const h1atr = h - l;
  if (h1atr < 1e-12) return null;
  return orbRange / h1atr;
}

// Post-entry: first bar (1-indexed) where price closed back INSIDE OR range.
// LONG: inside = close < orbH.  SHORT: inside = close > orbL.
// Returns null if not within 12 bars.
function firstReclaim(postBars, orbH, orbL, dir) {
  for (let i = 0; i < postBars.length; i++) {
    const b = postBars[i];
    if (dir === 'LONG'  && b.close < orbH) return i + 1;
    if (dir === 'SHORT' && b.close > orbL) return i + 1;
  }
  return null;
}

// ─── Cohen's d ──────────────────────────────────────────────────────────────

function cohenD(groupA, groupB) {
  const meanA = groupA.reduce((s,x) => s+x, 0) / groupA.length;
  const meanB = groupB.reduce((s,x) => s+x, 0) / groupB.length;
  const varA  = groupA.reduce((s,x) => s+(x-meanA)**2, 0) / (groupA.length - 1 || 1);
  const varB  = groupB.reduce((s,x) => s+(x-meanB)**2, 0) / (groupB.length - 1 || 1);
  const pooledSD = Math.sqrt((varA*(groupA.length-1) + varB*(groupB.length-1))
                           / (groupA.length + groupB.length - 2 || 1));
  return pooledSD < 1e-12 ? 0 : (meanA - meanB) / pooledSD;
}

function median(arr) {
  const s = [...arr].sort((a,b) => a-b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

function mean(arr) { return arr.reduce((s,x) => s+x, 0) / arr.length; }

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== ORB SWEEP ANALYSIS — FULLY TRACEABLE ===\n');

  // 1. Fetch perf-ranking
  console.log('Fetching /api/perf-ranking ...');
  const pr = await fetch(`${API_BASE}/api/perf-ranking`, { signal: AbortSignal.timeout(30000) });
  const prj = await pr.json();
  if (!prj.ok) { console.error('perf-ranking failed:', prj.error); process.exit(1); }
  const orb = prj.trades.filter(t => t.template === 'orb');
  console.log(`template==="orb" count: ${orb.length}\n`);

  // 2. Print all IDs
  console.log('FULL TRADE ID LIST:');
  orb.forEach((t, i) => console.log(`  ${String(i+1).padStart(2,'0')}. ${t.id}  ${t.outcome}  pnlR=${t.pnlR?.toFixed(3)}  ${t.session}  ${t.entryType||'null'}`));
  console.log();

  // 3. Fetch SL prices for ledger trades ("both" source)
  const slMap = {};
  const ledgerTrades = orb.filter(t => t._source === 'both');
  console.log(`Fetching SL prices for ${ledgerTrades.length} ledger trades...`);
  for (const t of ledgerTrades) {
    const rec = await kvGet(`v14:ledger:trade:${t.id}`);
    if (rec && rec.slPrice != null) {
      slMap[t.id] = rec.slPrice;
    }
  }
  console.log(`Got SL prices for ${Object.keys(slMap).length} trades.\n`);

  // 4. Classify each trade
  const results = [];

  for (const t of orb) {
    const openedMs = typeof t.openedAt === 'number' ? t.openedAt : new Date(t.openedAt).getTime();
    const d        = new Date(openedMs);
    const dayOfWeek = d.getUTCDay(); // 0=Sun, 6=Sat
    const hUTC     = d.getUTCHours() + d.getUTCMinutes() / 60;
    const dateStr  = d.toISOString().slice(0, 10); // "2026-07-06"

    // Exclusion check 1: weekend
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      results.push({ id: t.id, status: 'EXCLUDED', reason: `WEEKEND (${dateStr} dow=${dayOfWeek})`, ...t });
      continue;
    }

    // Determine OR window (UTC)
    let orStartH, orEndH;
    if (hUTC >= 8 && hUTC < 13) {
      // London session
      orStartH = 8; orEndH = 8.5; // 08:00-08:30 UTC
    } else {
      // NY_AM or NY_PM — OR is always 13:30-14:00 UTC
      orStartH = 13.5; orEndH = 14.0;
    }

    // NAS100/US500: SPX/NDX requires TwelveData paid plan — exclude all
    if (t.asset === 'us500' || t.asset === 'nas100') {
      results.push({ id: t.id, status: 'EXCLUDED', reason: 'SPX/NDX requires TwelveData Grow+ plan (not available on free tier)', ...t });
      continue;
    }

    const dayMs     = new Date(dateStr + 'T00:00:00Z').getTime();
    const orStartMs = dayMs + orStartH * 3600000;
    const orEndMs   = dayMs + orEndH   * 3600000;
    const signalMs  = Math.floor(openedMs / 60000) * 60000; // floor to minute

    // Fetch window: 60 bars before OR start → signal bar + 13 bars after
    const fetchStart = orStartMs - 60 * 60000;
    const fetchEnd   = signalMs  + 15 * 60000; // 15 min past signal bar

    const tdSym = TD_SYM[t.asset];
    if (!tdSym) {
      results.push({ id: t.id, status: 'EXCLUDED', reason: `No TwelveData symbol for asset=${t.asset}`, ...t });
      continue;
    }

    console.log(`Fetching ${tdSym} ${dateStr} (${t.id})...`);
    const candles = await fetchCandles(tdSym, fetchStart, fetchEnd);

    if (!candles || !candles.length) {
      results.push({ id: t.id, status: 'EXCLUDED', reason: `TwelveData returned no candles for ${tdSym} ${dateStr}`, ...t });
      continue;
    }

    // OR bars
    const orBars = barsInWindow(candles, orStartMs, orEndMs);
    if (orBars.length < 10) {
      results.push({ id: t.id, status: 'EXCLUDED',
        reason: `OR window has only ${orBars.length} bars (need ≥10) — market may be closed or data gap`,
        ...t });
      continue;
    }

    const { orbH, orbL, orbRange } = computeOR(orBars);
    if (orbRange < 1e-8) {
      results.push({ id: t.id, status: 'EXCLUDED', reason: 'orbRange ≈ 0 (degenerate OR)', ...t });
      continue;
    }

    // Signal bar
    const signalKey = utcStr(signalMs);
    const signalBar = findBar(candles, signalKey);
    if (!signalBar) {
      results.push({ id: t.id, status: 'EXCLUDED',
        reason: `Signal bar at ${signalKey} not found in candle data`,
        ...t });
      continue;
    }

    // 12 post-entry bars
    const post12 = barsAfter(candles, signalKey, 12);
    if (post12.length < 3) {
      results.push({ id: t.id, status: 'EXCLUDED',
        reason: `Only ${post12.length} post-entry bars available (need ≥3)`,
        ...t });
      continue;
    }

    // h1ATR: 60 bars before OR start
    const preBars = barsInWindow(candles, fetchStart, orStartMs);
    const h1atr   = preBars.length >= 10
      ? Math.max(...preBars.map(b => b.high)) - Math.min(...preBars.map(b => b.low))
      : null;

    // orbEdge and orbSLDist
    const orbEdge   = t.direction === 'LONG' ? orbH : orbL;
    const slPrice   = slMap[t.id] ?? null;
    let   orbSLDist = null;
    let   slSource  = null;
    if (slPrice != null) {
      orbSLDist = Math.abs(orbEdge - slPrice);
      slSource  = 'ledger';
    } else {
      orbSLDist = orbRange;  // approximation for recog-only trades
      slSource  = 'approx=orbRange';
    }

    // Pre-entry metrics
    const wr   = metricWickRatio(signalBar, t.direction);
    const cp   = metricClosePos(signalBar, t.direction);
    const bm   = metricBkMag(signalBar, orbH, orbL, orbSLDist, t.direction);
    const orat = h1atr ? orbRange / h1atr : null;

    // Post-entry: reclaim
    const btr12  = firstReclaim(post12, orbH, orbL, t.direction);
    const post3  = post12.slice(0, 3);
    const post6  = post12.slice(0, 6);
    const rec3   = post3.some((b, i) => t.direction === 'LONG' ? b.close < orbH : b.close > orbL) ? 1 : 0;
    const rec6   = post6.some((b, i) => t.direction === 'LONG' ? b.close < orbH : b.close > orbL) ? 1 : 0;
    const rec12  = post12.some((b, i) => t.direction === 'LONG' ? b.close < orbH : b.close > orbL) ? 1 : 0;

    results.push({
      id:         t.id,
      status:     'ANALYZED',
      asset:      t.asset,
      direction:  t.direction,
      outcome:    t.outcome,
      pnlR:       t.pnlR,
      session:    t.session,
      entryType:  t.entryType,
      dateStr,
      hUTC:       hUTC.toFixed(2),
      orbH:       +orbH.toFixed(5),
      orbL:       +orbL.toFixed(5),
      orbRange:   +orbRange.toFixed(5),
      orbEdge:    +orbEdge.toFixed(5),
      slSource,
      slPrice:    slPrice != null ? +slPrice.toFixed(5) : null,
      orbSLDist:  +orbSLDist.toFixed(5),
      signalClose:+signalBar.close.toFixed(5),
      // pre-entry metrics
      wickRatio:  +wr.toFixed(4),
      closePos:   +cp.toFixed(4),
      bkMag:      bm != null ? +bm.toFixed(4) : null,
      orRangeATR: orat != null ? +orat.toFixed(4) : null,
      // post-entry metrics
      rec3, rec6, rec12,
      barsToReclaim: btr12,
    });
  }

  // ─── report ────────────────────────────────────────────────────────────────

  const analyzed = results.filter(r => r.status === 'ANALYZED');
  const excluded  = results.filter(r => r.status === 'EXCLUDED');

  console.log('\n');
  console.log('='.repeat(80));
  console.log('STEP 2: TRADE AUDIT TABLE');
  console.log('='.repeat(80));
  console.log(`${'ID'.padEnd(30)} ${'STATUS'.padEnd(10)} REASON / METRICS`);
  results.forEach(r => {
    if (r.status === 'EXCLUDED') {
      console.log(`${r.id.padEnd(30)} EXCLUDED   ${r.reason}`);
    } else {
      console.log(`${r.id.padEnd(30)} ANALYZED   ${r.outcome} pnlR=${r.pnlR?.toFixed(3)} wr=${r.wickRatio} cp=${r.closePos} bm=${r.bkMag} orat=${r.orRangeATR} rec@12=${r.rec12} btr=${r.barsToReclaim}`);
    }
  });
  console.log(`\nTotal: ${results.length}  Analyzed: ${analyzed.length}  Excluded: ${excluded.length}`);
  if (results.length !== orb.length) {
    console.error(`\n!!! DISCREPANCY: orb.length=${orb.length} but results.length=${results.length} — STOP`);
    process.exit(1);
  }

  // ─── stats ─────────────────────────────────────────────────────────────────

  const wins   = analyzed.filter(r => r.outcome === 'WIN');
  const losses = analyzed.filter(r => r.outcome === 'LOSS');
  console.log('\n');
  console.log('='.repeat(80));
  console.log(`ANALYZED: ${analyzed.length} total  (${wins.length} WIN, ${losses.length} LOSS)`);
  console.log('='.repeat(80));

  // Post-entry reclaim
  function recStats(group, label) {
    if (!group.length) return;
    const r3  = group.filter(r => r.rec3).length;
    const r6  = group.filter(r => r.rec6).length;
    const r12 = group.filter(r => r.rec12).length;
    const btr = group.filter(r => r.barsToReclaim != null).map(r => r.barsToReclaim);
    const med = btr.length ? median(btr).toFixed(1) : 'N/A';
    const avg = btr.length ? mean(btr).toFixed(1) : 'N/A';
    console.log(`\n${label} (n=${group.length}):`);
    console.log(`  Reclaim@3:  ${r3}/${group.length} = ${(100*r3/group.length).toFixed(1)}%`);
    console.log(`  Reclaim@6:  ${r6}/${group.length} = ${(100*r6/group.length).toFixed(1)}%`);
    console.log(`  Reclaim@12: ${r12}/${group.length} = ${(100*r12/group.length).toFixed(1)}%`);
    console.log(`  barsToReclaim (reclaimers only): n=${btr.length} median=${med} mean=${avg}`);
  }

  console.log('\n--- POST-ENTRY: OR Reclaim (1-min bars) ---');
  recStats(wins,   'WINNERS');
  recStats(losses, 'LOSERS');

  // Pre-entry discrimination
  const metrics = [
    { key: 'wickRatio',  label: 'wickRatio (upper wick/LONG, lower wick/SHORT)',  higherWorse: true  },
    { key: 'closePos',   label: 'closePos (1=close at favourable extreme)',        higherWorse: false },
    { key: 'bkMag',      label: 'breakoutMagnitude (close−orbEdge)/orbSLDist',    higherWorse: false },
    { key: 'orRangeATR', label: 'orRangeATR (orbRange/h1ATR_estimate)',            higherWorse: null  },
  ];

  console.log('\n--- PRE-ENTRY DISCRIMINATION ---');
  const BONF_K = metrics.length; // 4 comparisons

  const thresholdResults = [];

  for (const m of metrics) {
    const wVals = wins.map(r => r[m.key]).filter(v => v != null);
    const lVals = losses.map(r => r[m.key]).filter(v => v != null);
    if (!wVals.length || !lVals.length) {
      console.log(`\n${m.label}: insufficient data`);
      continue;
    }
    const d    = cohenD(wVals, lVals);
    const mW   = mean(wVals);
    const medW = median(wVals);
    const mL   = mean(lVals);
    const medL = median(lVals);

    console.log(`\n${m.label}:`);
    console.log(`  WINNERS  n=${wVals.length}: mean=${mW.toFixed(3)} median=${medW.toFixed(3)}`);
    console.log(`  LOSERS   n=${lVals.length}: mean=${mL.toFixed(3)} median=${medL.toFixed(3)}`);
    console.log(`  Cohen's d = ${d.toFixed(3)} (winners vs losers, +d means winners higher)`);

    // Flag small groups
    if (wVals.length < 8 || lVals.length < 8) {
      console.log(`  *** n < 8 in at least one group — treat with caution ***`);
    }

    // Threshold sweep: try all midpoints between winner/loser values
    const allVals = [...new Set([...wVals, ...lVals])].sort((a,b) => a-b);
    let bestThreshold = null, bestNetPnlR = -Infinity, bestFiltered = 0, baseNetPnlR = 0;

    // Baseline: all analyzed trades
    baseNetPnlR = analyzed.reduce((s,r) => s + (r.pnlR || 0), 0);

    for (let i = 0; i < allVals.length - 1; i++) {
      const thresh = (allVals[i] + allVals[i+1]) / 2;
      // Try: PASS only if metric >= thresh (or <=thresh for each direction)
      // Direction: if m.higherWorse, pass trades where metric < thresh
      // If !m.higherWorse (higher is better), pass trades where metric >= thresh
      for (const dir of ['above', 'below']) {
        const kept = analyzed.filter(r => {
          const v = r[m.key];
          if (v == null) return true; // keep if metric unavailable (don't exclude blindly)
          return dir === 'above' ? v >= thresh : v < thresh;
        });
        const netR = kept.reduce((s,r) => s + (r.pnlR || 0), 0);
        const nFiltered = analyzed.length - kept.length;
        if (netR > bestNetPnlR) {
          bestNetPnlR = netR;
          bestThreshold = thresh;
          bestFiltered = nFiltered;
        }
      }
    }

    thresholdResults.push({ key: m.key, d, baseNetPnlR, bestNetPnlR, bestThreshold, bestFiltered });
    const netDelta = bestNetPnlR - baseNetPnlR;
    console.log(`  Best in-sample threshold: ${m.key} ${bestThreshold?.toFixed(4)}`);
    console.log(`    Filters out ${bestFiltered} of ${analyzed.length} trades`);
    console.log(`    Net pnlR: ${baseNetPnlR.toFixed(2)}R → ${bestNetPnlR.toFixed(2)}R (Δ ${netDelta >= 0 ? '+' : ''}${netDelta.toFixed(2)}R)`);
    console.log(`    *** IN-SAMPLE ONLY — Bonferroni threshold: p < ${(0.05/BONF_K).toFixed(3)} required ***`);
  }

  // Summary
  console.log('\n');
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total orb trades in perf-ranking: ${orb.length}`);
  console.log(`  EXCLUDED: ${excluded.length}`);
  excluded.forEach(r => console.log(`    ${r.id}: ${r.reason}`));
  console.log(`  ANALYZED: ${analyzed.length}  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Base net pnlR (analyzed): ${analyzed.reduce((s,r) => s+(r.pnlR||0), 0).toFixed(2)}R`);

  // Raw analyzed data for verification
  console.log('\n--- FULL ANALYZED DATA TABLE ---');
  console.log(['id','date','asset','dir','entryType','outcome','pnlR','orbH','orbL','orbRange','slSource','orbSLDist','sigClose','wickRatio','closePos','bkMag','orRangeATR','rec3','rec6','rec12','btr'].join('\t'));
  analyzed.forEach(r => {
    console.log([
      r.id, r.dateStr, r.asset, r.direction, r.entryType||'?', r.outcome,
      r.pnlR?.toFixed(3), r.orbH, r.orbL, r.orbRange, r.slSource, r.orbSLDist,
      r.signalClose, r.wickRatio, r.closePos,
      r.bkMag ?? 'N/A', r.orRangeATR ?? 'N/A',
      r.rec3, r.rec6, r.rec12, r.barsToReclaim ?? 'null'
    ].join('\t'));
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
