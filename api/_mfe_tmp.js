// ORB winner truncation deep-dive: MFE, exit reason, management state
// Q1: individual sub-TP1 winners; Q2: management logic summary; Q3: comparison; Q4: MFE
'use strict';

const { Redis } = require('@upstash/redis');

const KV_URL   = 'https://talented-doe-70974.upstash.io';
const KV_TOKEN = 'gQAAAAAAARU-AAIncDJiN2Q2MjA1NzgxZWQ0ZGY4OWUxZWQxNTI1YTQ4Njk4MHAyNzA5NzQ';
const r = new Redis({ url: KV_URL, token: KV_TOKEN });

function safeParse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
function r4(x) { return Math.round((x||0)*10000)/10000; }
function r2(x) { return Math.round((x||0)*100)/100; }
function classifySession(openedAt) {
  if (!openedAt) return 'UNKNOWN';
  const ms = typeof openedAt === 'number' ? openedAt : new Date(openedAt).getTime();
  if (!isFinite(ms)) return 'UNKNOWN';
  const d = new Date(ms), day = d.getUTCDay();
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 0 || day === 6) return 'WEEKEND';
  if (h >= 23 || h < 8)      return 'ASIAN';
  if (h >= 8  && h < 13)     return 'LONDON';
  if (h >= 13 && h < 16)     return 'NY_AM';
  if (h >= 16 && h < 21)     return 'NY_PM';
  return 'OFF';
}

async function main() {
  console.log('=== ORB WINNER TRUNCATION ANALYSIS ===\n');

  // ─── Load all ledger records ────────────────────────────────────────────────
  const indexRaw = await r.get('v14:ledger:index').catch(() => null);
  const index = safeParse(indexRaw) || [];
  const pipe = r.pipeline();
  for (const e of index) pipe.get(`v14:ledger:trade:${e.id}`);
  const results = await pipe.exec();
  const ledger = results
    .map(raw => { const v = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null; return v; })
    .filter(Boolean)
    .filter(t => !t._legacy);
  console.log(`Ledger records: ${ledger.length}`);

  // ─── Load recog ─────────────────────────────────────────────────────────────
  const ridxRaw = await r.get('v12:trades:index').catch(() => null);
  const ridx = safeParse(ridxRaw) || [];
  const rpipe = r.pipeline();
  for (const e of ridx.slice(0,1000)) rpipe.get(`v12:trades:closed:${e.id}`);
  const rresults = await rpipe.exec();
  const recog = rresults
    .map(raw => { const v = raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null; return v; })
    .filter(Boolean);
  console.log(`Recog records: ${recog.length}\n`);

  const ledgerMap = new Map(ledger.map(t => [t.id, t]));
  const recogMap  = new Map(recog.map(t => [t.id, t]));

  // ─── Merge and filter: ORB NY_AM wins ───────────────────────────────────────
  const allIds = new Set([...ledgerMap.keys(), ...recogMap.keys()]);
  const orbNyam = [];
  for (const id of allIds) {
    const l = ledgerMap.get(id) ?? null;
    const g = recogMap.get(id)  ?? null;
    const tmpl = l?.template || g?.template || 'unknown';
    if (tmpl !== 'orb' && tmpl !== 'orb-pro') continue;
    const openedAt = l?.openedAt ?? g?.openedAt ?? null;
    const sess = classifySession(openedAt);
    if (sess !== 'NY_AM') continue;
    const outcome = l?.outcome ?? g?.outcome ?? 'BREAKEVEN';
    if (outcome !== 'WIN') continue;
    orbNyam.push({ id, l, g, tmpl,
      openedAt, closedAt: l?.closedAt ?? g?.closedAt,
      netPnl: l?.netPnl ?? g?.pnl ?? 0,
      pnlR:   l?.pnlR   ?? g?.pnlR ?? null,
      tpsHit: l?.tpsHit ?? g?.tpsHit ?? [],
      maxTP:  l?.maxTP  ?? g?.maxTP  ?? 0,
      entryType: l?.entryType ?? g?.entryType ?? null,
      // ledger-only precise fields
      actualEntry: l?.actualEntry ?? null,
      exitPrice:   l?.exitPrice   ?? null,
      slPrice:     l?.slPrice     ?? null,
      exitReason:  l?.exitReason  ?? null,
      holdTime:    l?.holdTimeMinutes ?? null,
      riskDollars: l?.riskDollars ?? null,
      asset:       l?.asset ?? g?.asset ?? '?',
      src: l && g ? 'both' : l ? 'ledger' : 'recog',
    });
  }
  orbNyam.sort((a,b) => (a.openedAt||'') < (b.openedAt||'') ? -1 : 1);

  const subTP1 = orbNyam.filter(t => t.maxTP === 0);
  const reachedTP1 = orbNyam.filter(t => t.maxTP >= 1);
  console.log(`ORB NY_AM winners: total=${orbNyam.length}  maxTP=0: ${subTP1.length}  maxTP≥1: ${reachedTP1.length}\n`);

  // ─── For each sub-TP1 winner: try to get position state (MFE, slMoves) ──────
  // Position state key: v12:position:{positionId}:state  (TTL 7 days)
  // positionId is embedded in the id: trade_{asset}_{positionId}
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Q4/Q1  SUB-TP1 (maxTP=0) WINNERS — INDIVIDUAL DETAIL');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('For each: netPnl, R, entry, SL, exit, exitReason, holdTime,');
  console.log('          positionState (extreme=MFE, slMoves, tpsHit if available)\n');

  for (const t of subTP1) {
    const posId = t.id.replace(`trade_${t.asset}_`, '');
    const stateRaw = await r.get(`v12:position:${posId}:state`).catch(() => null);
    const state = safeParse(stateRaw);

    const dt = t.openedAt ? new Date(t.openedAt).toISOString().slice(0,16) : 'no-date';
    const dur = t.holdTime != null ? `${t.holdTime}m` : '?m';

    // compute exit as fraction of SL distance (MFE proxy from prices)
    let exitFracOfSL = null, slDistPrice = null, tp1Approx = null;
    if (t.actualEntry != null && t.slPrice != null && t.exitPrice != null) {
      const isLong = t.l?.direction === 'LONG';
      slDistPrice = Math.abs(t.actualEntry - t.slPrice);
      const exitDist = isLong ? (t.exitPrice - t.actualEntry) : (t.actualEntry - t.exitPrice);
      exitFracOfSL = slDistPrice > 0 ? r4(exitDist / slDistPrice) : null;
    }

    // MFE from position state
    let mfe = null, mfeR = null, slMoves = null, stateTpsHit = null;
    if (state) {
      const isLong = state.direction === 'LONG';
      const entry = state.entry;
      const initSL = Math.abs(entry - (t.slPrice || entry));
      if (state.extreme != null && initSL > 0) {
        mfe = isLong ? state.extreme - entry : entry - state.extreme;
        mfeR = r4(mfe / initSL);
      }
      slMoves = state.slMoves || [];
      stateTpsHit = state.tpsHit || [];
    }

    console.log(`── ${t.asset.toUpperCase().padEnd(8)} ${dt}  ${t.tmpl.padEnd(8)}  ${t.entryType||'?'}  src=${t.src}`);
    console.log(`   netPnl=$${r2(t.netPnl)}  pnlR=${t.pnlR != null ? t.pnlR+'R' : '?R'}  holdTime=${dur}`);
    if (t.actualEntry != null) {
      console.log(`   entry=${r4(t.actualEntry)}  SL=${r4(t.slPrice)}  exit=${r4(t.exitPrice)}  slDist=${slDistPrice != null ? r4(slDistPrice) : '?'}`);
      if (exitFracOfSL != null) console.log(`   exit was ${(exitFracOfSL*100).toFixed(0)}% of SL distance from entry`);
    }
    if (t.exitReason) console.log(`   exitReason: ${t.exitReason}`);
    if (state) {
      console.log(`   PositionState: extreme(MFE)=${state.extreme != null ? r4(state.extreme) : '?'}  mfeR=${mfeR != null ? mfeR+'R' : '?'}  tpsHit=${JSON.stringify(stateTpsHit)}  slMoves=${slMoves.length}`);
      if (slMoves.length) {
        for (const m of slMoves) console.log(`     slMove: ${m.atTP||'trail'} → ${r4(m.newSL)}  ts=${new Date(m.ts).toISOString().slice(0,16)}`);
      }
    } else {
      console.log(`   PositionState: EXPIRED (>7 days old)`);
    }
    console.log();
  }

  // ─── Q3: reached-TP1 group summary ──────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Q3  COMPARISON: reached TP1+ (n='+reachedTP1.length+') vs sub-TP1 (n='+subTP1.length+')');
  console.log('═══════════════════════════════════════════════════════════════');

  function grpSummary(trades, label) {
    const pnls  = trades.map(t => t.netPnl||0);
    const Rs    = trades.filter(t=>t.pnlR!=null).map(t=>t.pnlR);
    const holds = trades.filter(t=>t.holdTime!=null).map(t=>t.holdTime);
    const avg = a => a.length ? r2(a.reduce((s,v)=>s+v,0)/a.length) : null;
    console.log(`${label}:`);
    console.log(`  avgPnl=$${avg(pnls)}  avgR=${avg(Rs)}  avgHoldTime=${avg(holds)}m`);
    console.log(`  pnlR range: ${Rs.length ? r4(Math.min(...Rs))+' to '+r4(Math.max(...Rs)) : 'n/a'}`);
    const medPnl = [...pnls].sort((a,b)=>a-b)[Math.floor(pnls.length/2)];
    console.log(`  median netPnl=$${r2(medPnl)}`);

    // entryType split
    const byType = {};
    for (const t of trades) { const k = t.entryType||'?'; (byType[k]=byType[k]||[]).push(t); }
    for (const [k,v] of Object.entries(byType)) {
      const ps = v.map(t=>t.netPnl||0);
      console.log(`  entryType=${k}: n=${v.length}  avgPnl=$${avg(ps)}`);
    }
  }

  grpSummary(reachedTP1, 'Reached TP1+ (maxTP≥1)');
  console.log();
  grpSummary(subTP1, 'Sub-TP1 (maxTP=0)');
  console.log();

  // For trades with ledger data in both groups: compute exit fraction
  console.log('Exit as % of SL distance (ledger trades only):');
  for (const [label, grp] of [['Reached TP1+', reachedTP1], ['Sub-TP1', subTP1]]) {
    const withPrices = grp.filter(t => t.actualEntry != null && t.slPrice != null && t.exitPrice != null && t.l?.direction);
    const fracs = withPrices.map(t => {
      const isLong = t.l.direction === 'LONG';
      const slDist = Math.abs(t.actualEntry - t.slPrice);
      const exitDist = isLong ? (t.exitPrice - t.actualEntry) : (t.actualEntry - t.exitPrice);
      return slDist > 0 ? exitDist / slDist : null;
    }).filter(Boolean);
    const avg = a => a.length ? r4(a.reduce((s,v)=>s+v,0)/a.length) : null;
    console.log(`  ${label} (n=${fracs.length} with prices): avg exit frac=${avg(fracs)}  range=${fracs.length?r4(Math.min(...fracs))+' to '+r4(Math.max(...fracs)):'n/a'}`);
  }
  console.log();

  // ─── Q5: same analysis for OTHER templates and sessions ─────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Q5  WINNER TRUNCATION COMPARISON ACROSS TEMPLATES/SESSIONS');
  console.log('═══════════════════════════════════════════════════════════════');

  // Build all merged wins
  const allWins = [];
  for (const id of allIds) {
    const l = ledgerMap.get(id) ?? null;
    const g = recogMap.get(id)  ?? null;
    const tmpl = l?.template || g?.template || 'unknown';
    if (['unknown','legacy','legacy-unknown'].includes(tmpl)) continue;
    const openedAt = l?.openedAt ?? g?.openedAt ?? null;
    const outcome = l?.outcome ?? g?.outcome ?? 'BREAKEVEN';
    if (outcome !== 'WIN') continue;
    allWins.push({
      id, tmpl,
      session: classifySession(openedAt),
      netPnl: l?.netPnl ?? g?.pnl ?? 0,
      pnlR:   l?.pnlR   ?? g?.pnlR ?? null,
      maxTP:  l?.maxTP  ?? g?.maxTP  ?? 0,
      tpsHit: l?.tpsHit ?? g?.tpsHit ?? [],
    });
  }

  // Group by template × session
  const groups = {};
  for (const t of allWins) {
    const k = `${t.tmpl}|${t.session}`;
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  }

  // For each group with n≥4 wins: compute sub-TP1 fraction and avg values
  console.log(`${'Template'.padEnd(22)} ${'Session'.padEnd(8)} ${'nWins'.padEnd(6)} ${'subTP1%'.padEnd(9)} ${'avgPnl'.padEnd(10)} ${'avgR'.padEnd(8)} ${'avgSubTP1Pnl'}`);
  const rows = Object.entries(groups)
    .map(([k, ts]) => {
      const [tmpl, sess] = k.split('|');
      const subTP1 = ts.filter(t => t.maxTP === 0);
      const Rs = ts.filter(t=>t.pnlR!=null).map(t=>t.pnlR);
      const subRs = subTP1.filter(t=>t.pnlR!=null).map(t=>t.pnlR);
      return {
        tmpl, sess, n: ts.length,
        subTP1n: subTP1.length,
        subTP1pct: ts.length > 0 ? subTP1.length / ts.length : 0,
        avgPnl: ts.length ? r2(ts.reduce((s,t)=>s+(t.netPnl||0),0)/ts.length) : 0,
        avgR: Rs.length ? r4(Rs.reduce((s,v)=>s+v,0)/Rs.length) : null,
        avgSubPnl: subTP1.length ? r2(subTP1.reduce((s,t)=>s+(t.netPnl||0),0)/subTP1.length) : null,
        avgSubR: subRs.length ? r4(subRs.reduce((s,v)=>s+v,0)/subRs.length) : null,
      };
    })
    .filter(r => r.n >= 3)
    .sort((a,b) => b.subTP1pct - a.subTP1pct);

  for (const r of rows) {
    const pct = (r.subTP1pct*100).toFixed(0)+'%';
    console.log(`${(r.tmpl).padEnd(22)} ${r.sess.padEnd(8)} ${String(r.n).padEnd(6)} ${pct.padEnd(9)} $${String(r.avgPnl).padEnd(9)} ${r.avgR!=null?r.avgR+'R':'?R  '} avgSubTP1=$${r.avgSubPnl} (${r.avgSubR!=null?r.avgSubR+'R':'?R'})`);
  }
  console.log();

  // ─── Q4: check recent position states for MFE on ALL recent trades (July 12+) ─
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Q4  POSITION STATES WITH MFE — ALL RECENT TRADES (July 12+)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('(position states expire after 7 days, only recent trades survive)\n');

  const recentLedger = ledger.filter(t => {
    if (!t.closedAt) return false;
    const ms = typeof t.closedAt === 'number' ? t.closedAt : new Date(t.closedAt).getTime();
    return ms > Date.now() - 7 * 86400000;
  });

  console.log(`Recent ledger records (closed within 7 days): ${recentLedger.length}`);

  for (const t of recentLedger) {
    const posId = t.id.replace(`trade_${t.asset}_`, '');
    const stateRaw = await r.get(`v12:position:${posId}:state`).catch(() => null);
    const state = safeParse(stateRaw);
    if (!state) continue;

    const isLong = state.direction === 'LONG' || t.direction === 'LONG';
    const entry = state.entry || t.actualEntry;
    const slDist = entry && t.slPrice ? Math.abs(entry - t.slPrice) : null;
    let mfeR = null, mfeDist = null, tp1R_approx = null;
    if (state.extreme != null && entry && slDist > 0) {
      mfeDist = isLong ? state.extreme - entry : entry - state.extreme;
      mfeR = r4(mfeDist / slDist);
    }

    const tpLevels = state.tpLevels; // might not be there but check
    const sess = classifySession(t.openedAt);
    const dt = t.openedAt ? new Date(t.openedAt).toISOString().slice(0,16) : 'no-date';

    console.log(`${t.asset.toUpperCase().padEnd(8)} ${dt} sess=${sess} tmpl=${(t.template||'?').padEnd(8)} ${t.outcome.padEnd(8)}`);
    console.log(`  entry=${r4(entry)}  SL=${r4(t.slPrice)}  exit=${r4(t.exitPrice)}  netPnl=$${r2(t.netPnl)}  maxTP=${t.maxTP}`);
    console.log(`  state.extreme=${state.extreme!=null?r4(state.extreme):'null'}  mfeR=${mfeR!=null?mfeR+'R':'?'}  slMoves=${(state.slMoves||[]).length}  stateTpsHit=${JSON.stringify(state.tpsHit||[])}`);
    if ((state.slMoves||[]).length > 0) {
      for (const m of state.slMoves) console.log(`    slMove: ${m.atTP||'trail'} → ${r4(m.newSL)}`);
    }
    console.log();
  }

  // ─── Check pending setups for any active ORB trades (tpLevels) ──────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PENDING SETUPS — ORB tpLevels (if any active/recent)');
  console.log('═══════════════════════════════════════════════════════════════');
  const ORB_ASSETS = ['eurusd','gbpusd','usdjpy','usdchf','audusd','nzdusd','usdcad','eurjpy','gbpjpy','gold','nas100','us500','btc'];
  for (const asset of ORB_ASSETS) {
    const raw = await r.get(`v12:watcher:${asset}:pending`).catch(() => null);
    const setups = safeParse(raw) || [];
    const orbSetups = setups.filter(s => s.setup && (s.setup.template === 'orb' || s.setup.template === 'orb-pro'));
    if (!orbSetups.length) continue;
    console.log(`${asset}: ${orbSetups.length} ORB setups`);
    for (const s of orbSetups) {
      console.log(`  id=${s.id}  status=${s.status}  dir=${s.setup?.direction}  entry=${r4(s.plannedEntry)}  sl=${r4(s.slPrice)}`);
      for (const tp of (s.tpLevels||[])) {
        console.log(`    TP: price=${r4(tp.price)}  rMultiple=${tp.rMultiple}R`);
      }
    }
  }
  console.log();

  // ─── Rules: current ORB instrument settings (tpMode, tp1RR) ────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('RULES: current instrument TP/SL settings for ORB');
  console.log('═══════════════════════════════════════════════════════════════');
  const rulesRaw = await r.get('v12:rules').catch(() => null);
  const rules = safeParse(rulesRaw);
  if (rules) {
    console.log(`tpConfirmR (global): ${rules.tpConfirmR != null ? rules.tpConfirmR : 'default 0.10'}`);
    for (const asset of ORB_ASSETS) {
      const inst = rules.instruments && rules.instruments[asset];
      if (!inst) continue;
      const relevant = ['tpMode','tp1RR','tp2RR','tp3RR','numTPs','slMode','minRR'];
      const fields = relevant.filter(k => inst[k] != null).map(k => `${k}=${inst[k]}`).join('  ');
      if (fields) console.log(`  ${asset.padEnd(10)}: ${fields}`);
    }
    const tmplOvr = rules.templateOverrides && rules.templateOverrides['orb'];
    if (tmplOvr) console.log(`  orb override: ${JSON.stringify(tmplOvr)}`);
    console.log(`  tpConfirmR on pending setups (from webhook): set per-setup via tpConfirmR field`);
  } else {
    console.log('  Rules not found at v12:rules');
    // try alternate key
    const r2raw = await r.get('v14:rules').catch(() => null);
    const r2obj = safeParse(r2raw);
    if (r2obj) { console.log('  Found at v14:rules'); console.log(JSON.stringify(r2obj.account||{}, null, 2)); }
  }
  console.log();

  // ─── Activity log: any ORB-related tplock/tp-hit entries ─────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('ACTIVITY LOG: recent ORB tp-hits and sl-moves');
  console.log('═══════════════════════════════════════════════════════════════');
  const actRaw = await r.get('v12:activity:log').catch(() => null);
  const actLog = safeParse(actRaw) || [];
  const orbAct = actLog.filter(a => a.template === 'orb' || a.template === 'orb-pro').slice(0,30);
  if (orbAct.length) {
    for (const a of orbAct) {
      const dt = a.ts ? new Date(a.ts).toISOString().slice(0,16) : 'no-date';
      console.log(`  ${dt}  ${a.type}  ${a.asset}  dir=${a.direction}  ${JSON.stringify(a).slice(0,120)}`);
    }
  } else {
    console.log('  No ORB entries in activity log (or log key not at v12:activity:log)');
    // try alternate key
    const actRaw2 = await r.get('v14:activity:log').catch(() => null);
    const actLog2 = safeParse(actRaw2) || [];
    console.log(`  v14:activity:log entries: ${actLog2.length}`);
    const orbAct2 = actLog2.filter(a => a.template === 'orb' || a.template === 'orb-pro').slice(0,20);
    for (const a of orbAct2) {
      const dt = a.ts ? new Date(a.ts).toISOString().slice(0,16) : 'no-date';
      console.log(`  ${dt}  ${a.type}  ${a.asset}  ${JSON.stringify(a).slice(0,100)}`);
    }
  }
  console.log();

  // ─── Check commentary for recent ORB trades (sl-moved, tp-hit notes) ─────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('COMMENTARY: recent ORB sl-moved and tp-hit notes');
  console.log('═══════════════════════════════════════════════════════════════');
  for (const asset of ORB_ASSETS) {
    const comRaw = await r.get(`v12:watcher:${asset}:commentary`).catch(() => null);
    const com = safeParse(comRaw) || [];
    const slMoveEntries = com.filter(c => c.type === 'sl-moved' || c.type === 'tp-hit' || c.type === 'sl-trailing');
    if (!slMoveEntries.length) continue;
    console.log(`${asset}:`);
    for (const c of slMoveEntries.slice(0,8)) {
      const dt = c.ts ? new Date(c.ts).toISOString().slice(0,16) : 'no-date';
      console.log(`  ${dt}  ${c.type}  ${c.message||''}`);
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
