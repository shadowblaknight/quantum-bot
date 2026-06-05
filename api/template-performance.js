// =====================================================================
// QUANTUM BOT V13 · /api/template-performance  (v1.1 — fixed Redis keys)
// =====================================================================
// v1.1 FIX (the critical one):
//   v1.0 read from "qb:trades:closed" — a key that NEVER EXISTED. The actual
//   trade data is stored by recognition-memory.js under:
//     - v12:trades:index             (sorted index of {id, closedAt})
//     - v12:trades:closed:{id}       (per-trade feature vectors)
//   This file now reads from the correct location and translates the
//   feature-vector field names into the shape App.jsx expects.
//
// Field-name translations:
//   templateName  →  contributingTactics[0]   (Pine template name is here)
//   profit        →  pnl
//   rMultiple     →  pnlR
//   exitReason    →  outcome ('WIN' | 'LOSS' | 'BREAKEVEN')
//
// Endpoint contract unchanged — App.jsx does not need to change:
//   GET /api/template-performance              → all templates, all-time
//   GET /api/template-performance?days=30      → last 30 days
//
// Response:
//   {
//     byTemplate: { "silver-bullet": { sample, wins, losses, winRate,
//                                       profitFactor, avgR, verdict, trend,
//                                       lastN, bySession, byAsset }, ... },
//     overall:    { sample, winRate, profitFactor, avgR, ... },
//     totalTrades, windowDays, updatedAt
//   }
// =====================================================================

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

const INDEX_KEY = "v12:trades:index";
const TRADE_KEY = (id) => `v12:trades:closed:${id}`;

// ─── Upstash REST helpers ───────────────────────────────────────────

async function redisGET(key) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Upstash env vars missing");
  const res = await fetch(
    `${REDIS_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
  );
  const j = await res.json();
  return j.result || null;
}

async function redisMGET(keys) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Upstash env vars missing");
  if (keys.length === 0) return [];
  // Upstash MGET path: /mget/key1/key2/...
  const path = keys.map((k) => encodeURIComponent(k)).join("/");
  const res = await fetch(
    `${REDIS_URL}/mget/${path}`,
    { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
  );
  const j = await res.json();
  return j.result || [];
}

function safeJSON(s) {
  if (s == null) return null;
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ─── Load all closed trades from v12 namespace ──────────────────────

async function loadClosedTrades() {
  const indexRaw = await redisGET(INDEX_KEY);
  const index = safeJSON(indexRaw) || [];
  if (!Array.isArray(index) || index.length === 0) return [];

  const ids = index.map((e) => e.id).filter(Boolean);
  if (ids.length === 0) return [];

  const keys = ids.map(TRADE_KEY);

  // Batch read — but Upstash REST MGET has practical URL-length limits.
  // Chunk at 100 keys per call to stay safe.
  const trades = [];
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunkKeys = keys.slice(i, i + CHUNK);
    const results = await redisMGET(chunkKeys);
    for (const raw of results) {
      const t = safeJSON(raw);
      if (t && typeof t === "object") trades.push(t);
    }
  }
  return trades;
}

// ─── Translate feature-vector → expected shape ──────────────────────

function adaptTrade(fv) {
  // template name lives in contributingTactics[0] (webhook passes it as a
  // single-element array)
  const templateName =
    (Array.isArray(fv.contributingTactics) && fv.contributingTactics[0]) ||
    fv.templateName ||
    "unknown";

  return {
    id: fv.id,
    assetId: fv.asset,
    templateName,
    direction: fv.direction,
    mode: fv.mode,
    session: fv.session,
    profit: fv.pnl,           // ← field rename
    rMultiple: fv.pnlR,       // ← field rename
    outcome: fv.outcome,
    openedAt: fv.openedAt,
    closedAt: fv.closedAt,
    holdTimeMinutes: fv.holdTimeMinutes,
    synthetic: fv.synthetic || false,
  };
}

// ─── Stats math (unchanged from v1.0 semantics) ─────────────────────

function statsFor(trades) {
  if (trades.length === 0) {
    return {
      sample: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, avgR: 0,
      verdict: "too-few-trades", trend: "flat", lastN: [],
    };
  }

  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, sumR = 0;
  for (const t of trades) {
    const p = t.profit || 0;
    const r = t.rMultiple || 0;
    if (p > 0) { wins++; grossProfit += p; }
    else if (p < 0) { losses++; grossLoss += Math.abs(p); }
    sumR += r;
  }

  const sample = trades.length;
  const winRate = wins / sample;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 0);
  const avgR = sumR / sample;

  let verdict = "too-few-trades";
  if (sample >= 5) {
    if (profitFactor >= 1.5) verdict = "profitable";
    else if (profitFactor >= 1.0) verdict = "marginal";
    else verdict = "underperforming";
  }

  let trend = "flat";
  if (sample >= 10) {
    const recent = trades.slice(-5);
    const prior = trades.slice(-10, -5);
    const recentR = recent.reduce((a, t) => a + (t.rMultiple || 0), 0) / 5;
    const priorR = prior.reduce((a, t) => a + (t.rMultiple || 0), 0) / 5;
    if (recentR > priorR + 0.2) trend = "improving";
    else if (recentR < priorR - 0.2) trend = "declining";
  }

  const lastN = trades.slice(-5).map((t) => (t.rMultiple || 0));

  return { sample, wins, losses, winRate, profitFactor, avgR, verdict, trend, lastN };
}

function classifySession(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts);
  const dow = d.getUTCDay();
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (dow === 0 || dow === 6) return "weekend";
  if (utcMin < 6 * 60) return "asia";
  if (utcMin < 7 * 60) return "frankfurt-open";
  if (utcMin < 9 * 60) return "london-open";
  if (utcMin < 12 * 60) return "london-mid";
  if (utcMin < 13 * 60) return "pre-ny";
  if (utcMin < 15 * 60) return "ny-open";
  if (utcMin < 19 * 60) return "ny-mid";
  if (utcMin < 22 * 60) return "ny-late";
  return "asia";
}

function bySession(trades) {
  const out = {};
  for (const t of trades) {
    const s = t.session || classifySession(t.closedAt || t.openedAt);
    if (!out[s]) out[s] = [];
    out[s].push(t);
  }
  const result = {};
  for (const [s, arr] of Object.entries(out)) result[s] = statsFor(arr);
  return result;
}

function byAsset(trades) {
  const out = {};
  for (const t of trades) {
    const a = t.assetId || "unknown";
    if (!out[a]) out[a] = [];
    out[a].push(t);
  }
  const result = {};
  for (const [a, arr] of Object.entries(out)) result[a] = statsFor(arr);
  return result;
}

// ─── HTTP handler ───────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    const days = parseInt(req.query?.days || "0", 10);
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;

    let rawTrades = [];
    try {
      rawTrades = await loadClosedTrades();
    } catch (e) {
      // Redis empty / not set up — return empty stats, not an error.
      // App.jsx will render "no data yet" rows.
      return res.status(200).json({
        byTemplate: {}, overall: statsFor([]),
        totalTrades: 0, windowDays: days || null, updatedAt: Date.now(),
        warning: `redis read failed: ${e.message}`,
      });
    }

    // Adapt every trade to the expected field shape
    let trades = rawTrades.map(adaptTrade);

    if (cutoff > 0) {
      trades = trades.filter((t) => (t.closedAt || 0) >= cutoff);
    }

    // Sort chronologically for trend math
    trades.sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));

    // Bucket by template
    const buckets = {};
    for (const t of trades) {
      const tpl = t.templateName || "unknown";
      if (!buckets[tpl]) buckets[tpl] = [];
      buckets[tpl].push(t);
    }

    const byTemplate = {};
    for (const [tpl, arr] of Object.entries(buckets)) {
      const base = statsFor(arr);
      byTemplate[tpl] = {
        ...base,
        bySession: bySession(arr),
        byAsset: byAsset(arr),
      };
    }

    const overall = statsFor(trades);

    return res.status(200).json({
      byTemplate,
      overall,
      totalTrades: trades.length,
      windowDays: days || null,
      updatedAt: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "template-performance error" });
  }
}