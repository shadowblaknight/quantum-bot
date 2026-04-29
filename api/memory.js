/* eslint-disable */
// V10 — api/memory.js
// 3-layer memory system that gives the AI persistent context across calls.
//
// Layer 1 (short, 24h TTL):  v10:mem:short -- last 20 decisions, current open positions context, today's anomalies
// Layer 2 (mid, 7-day):      v10:mem:mid   -- per-instrument rolling stats, recent learning insights
// Layer 3 (long, permanent): v10:mem:long  -- per-instrument-per-family lifetime priors, curated lessons
//
// All three layers are injected into the AI prompt header on every call.

const { getRedis, safeParse, applyCors } = require('./_lib');

const KEY_SHORT = 'v10:mem:short';
const KEY_MID   = 'v10:mem:mid';
const KEY_LONG  = 'v10:mem:long';

const SHORT_TTL = 24 * 60 * 60;       // 24 hours
const MID_TTL   = 7  * 24 * 60 * 60;  // 7 days
const SHORT_MAX_DECISIONS = 20;

// Default empty structures
const emptyShort = () => ({
  decisions:    [],     // [{ ts, sym, decision, family, conf, regime, outcome }]
  positions:    {},     // { symbolId: { reason, family, regime, openTs } }
  anomalies:    [],     // [{ ts, type, sym, detail }]
  todayDigest:  null,   // brief end-of-session reflection text
});
const emptyMid = () => ({
  perInstrument: {},    // { sym: { sevenDayWR, sevenDayPnl, bestSession, currentRegime, lastUpdate } }
  recentInsights: [],   // [{ ts, insight, source }]  -- last 10 reflections
});
const emptyLong = () => ({
  priors: {},           // { sym_family: { wins, losses, avgPnl, regimes:{TRENDING:n, RANGING:n}, sessions:{LONDON:n, NY:n} } }
  lessons: [],          // [{ added, lesson, source }]  -- curated, never expires
});

// === Public read API ===
async function readMemory() {
  const r = getRedis();
  if (!r) return { short: emptyShort(), mid: emptyMid(), long: emptyLong() };
  const [s, m, l] = await Promise.all([
    r.get(KEY_SHORT).catch(() => null),
    r.get(KEY_MID).catch(() => null),
    r.get(KEY_LONG).catch(() => null),
  ]);
  return {
    short: safeParse(s) || emptyShort(),
    mid:   safeParse(m) || emptyMid(),
    long:  safeParse(l) || emptyLong(),
  };
}

// === Write helpers ===
async function writeShort(short) {
  const r = getRedis(); if (!r) return false;
  return await r.set(KEY_SHORT, JSON.stringify(short), { ex: SHORT_TTL }).catch(() => false);
}
async function writeMid(mid) {
  const r = getRedis(); if (!r) return false;
  return await r.set(KEY_MID, JSON.stringify(mid), { ex: MID_TTL }).catch(() => false);
}
async function writeLong(long) {
  const r = getRedis(); if (!r) return false;
  return await r.set(KEY_LONG, JSON.stringify(long)).catch(() => false);
}

// === Convenience appenders ===
async function appendDecision({ sym, decision, family, conf, regime, reason }) {
  const mem = await readMemory();
  mem.short.decisions = (mem.short.decisions || []).concat({
    ts: Date.now(), sym, decision, family, conf, regime, reason: reason || null, outcome: null,
  }).slice(-SHORT_MAX_DECISIONS);
  if (decision !== 'WAIT') {
    mem.short.positions = mem.short.positions || {};
    mem.short.positions[sym] = { family, regime, conf, reason, openTs: Date.now() };
  }
  await writeShort(mem.short);
}

async function recordOutcome({ sym, pnl, won }) {
  const mem = await readMemory();
  // Find most recent decision for this symbol that has no outcome yet
  const idx = (mem.short.decisions || []).map((d, i) => ({ d, i }))
    .reverse().find(({ d }) => d.sym === sym && d.outcome == null);
  if (idx) {
    mem.short.decisions[idx.i].outcome = { pnl, won, ts: Date.now() };
  }
  // Clear position record
  if (mem.short.positions && mem.short.positions[sym]) delete mem.short.positions[sym];
  await writeShort(mem.short);

  // Update long-term family priors
  const dec = idx ? mem.short.decisions[idx.i] : null;
  if (dec && dec.family && dec.family !== 'UNKNOWN') {
    const key = sym + '_' + dec.family;
    mem.long.priors = mem.long.priors || {};
    if (!mem.long.priors[key]) mem.long.priors[key] = { wins: 0, losses: 0, totalPnl: 0, regimes: {}, sessions: {} };
    const p = mem.long.priors[key];
    if (won) p.wins += 1; else p.losses += 1;
    p.totalPnl = (p.totalPnl || 0) + (pnl || 0);
    if (dec.regime) p.regimes[dec.regime] = (p.regimes[dec.regime] || 0) + 1;
    await writeLong(mem.long);
  }
}

async function appendAnomaly(type, sym, detail) {
  const mem = await readMemory();
  mem.short.anomalies = (mem.short.anomalies || []).concat({ ts: Date.now(), type, sym, detail }).slice(-30);
  await writeShort(mem.short);
}

async function appendInsight(insight, source) {
  const mem = await readMemory();
  mem.mid.recentInsights = (mem.mid.recentInsights || []).concat({ ts: Date.now(), insight, source: source || 'reflection' }).slice(-10);
  await writeMid(mem.mid);
}

async function addLesson(lesson, source) {
  const mem = await readMemory();
  mem.long.lessons = (mem.long.lessons || []).concat({ added: Date.now(), lesson, source: source || 'manual' });
  await writeLong(mem.long);
}

// Build a compact prompt-ready memory snapshot
function buildPromptContext(mem, sym) {
  const out = [];
  // Recent decisions on THIS symbol (last 5)
  const recent = (mem.short.decisions || []).filter(d => d.sym === sym).slice(-5);
  if (recent.length) {
    out.push('Recent decisions on ' + sym + ':');
    for (const d of recent) {
      const age = Math.round((Date.now() - d.ts) / 60000);
      const outc = d.outcome ? (d.outcome.won ? 'WIN +$' + d.outcome.pnl.toFixed(0) : 'LOSS $' + d.outcome.pnl.toFixed(0)) : 'open/pending';
      out.push('  ' + age + 'm ago: ' + d.decision + ' (' + (d.family || 'unknown') + ', ' + (d.conf || 0) + '%) -> ' + outc);
    }
  }
  // Open positions across all symbols
  const openSyms = Object.keys(mem.short.positions || {});
  if (openSyms.length) {
    out.push('Currently open positions:');
    for (const s of openSyms) {
      const p = mem.short.positions[s];
      out.push('  ' + s + ': ' + (p.family || '?') + ' / ' + (p.regime || '?'));
    }
  }
  // Family priors for this symbol
  const longPriors = Object.entries(mem.long.priors || {}).filter(([k]) => k.startsWith(sym + '_'));
  if (longPriors.length) {
    out.push('Lifetime family priors on ' + sym + ':');
    for (const [k, p] of longPriors) {
      const fam = k.split('_')[1];
      const total = (p.wins || 0) + (p.losses || 0);
      const wr = total > 0 ? Math.round((p.wins / total) * 100) : 0;
      out.push('  ' + fam + ': ' + p.wins + 'W/' + p.losses + 'L (' + wr + '% WR, $' + Math.round(p.totalPnl || 0) + ' total)');
    }
  }
  // Recent insights from reflection cycles
  if ((mem.mid.recentInsights || []).length) {
    out.push('Recent insights (from end-of-day reflections):');
    for (const i of mem.mid.recentInsights.slice(-3)) {
      out.push('  - ' + i.insight);
    }
  }
  // Long-term curated lessons (always included)
  if ((mem.long.lessons || []).length) {
    out.push('Lessons learned:');
    for (const l of mem.long.lessons.slice(-5)) {
      out.push('  - ' + l.lesson);
    }
  }
  // Current anomalies
  const recentAnomalies = (mem.short.anomalies || []).filter(a => Date.now() - a.ts < 4 * 60 * 60 * 1000);
  if (recentAnomalies.length) {
    out.push('Recent anomalies (last 4h):');
    for (const a of recentAnomalies.slice(-3)) {
      out.push('  - ' + a.type + (a.sym ? ' on ' + a.sym : '') + ': ' + a.detail);
    }
  }
  return out.join('\n');
}

// === HTTP handler — for inspection/debugging from the UI ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    const mem = await readMemory();
    return res.status(200).json(mem);
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    if (!body) return res.status(400).json({ error: 'Invalid body' });

    if (body.action === 'add-lesson') {
      if (!body.lesson) return res.status(400).json({ error: 'lesson required' });
      await addLesson(body.lesson, body.source);
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'clear-short') {
      const r = getRedis(); if (r) await r.del(KEY_SHORT);
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'clear-all') {
      const r = getRedis();
      if (r) await Promise.all([r.del(KEY_SHORT), r.del(KEY_MID), r.del(KEY_LONG)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports.readMemory     = readMemory;
module.exports.writeShort     = writeShort;
module.exports.writeMid       = writeMid;
module.exports.writeLong      = writeLong;
module.exports.appendDecision = appendDecision;
module.exports.recordOutcome  = recordOutcome;
module.exports.appendAnomaly  = appendAnomaly;
module.exports.appendInsight  = appendInsight;
module.exports.addLesson      = addLesson;
module.exports.buildPromptContext = buildPromptContext;