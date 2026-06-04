// =====================================================================
// QUANTUM BOT V13 · /api/template-performance
// =====================================================================
// Aggregates closed trades by template name, returns rolling stats.
//
// Source of truth: Redis list "qb:trades:closed" — your watcher should
// push every closed trade here with shape:
//   {
//     id, assetId, templateName, direction, entry, sl, tp,
//     exitPrice, exitReason, profit, rMultiple,
//     openedAt, closedAt
//   }
//
// Endpoint:
//   GET /api/template-performance       → all templates, all-time
//   GET /api/template-performance?days=30
//
// Response:
//   {
//     byTemplate: {
//       "silver-bullet": { sample, wins, losses, winRate, profitFactor, avgR, verdict, trend, lastN },
//       ...
//     },
//     overall: { sample, winRate, profitFactor, avgR },
//     updatedAt: 1234567890
//   }
//
// Defensive: if Redis is empty / not set up, returns { byTemplate: {} } so
// the dashboard renders "no data yet" rows instead of crashing.
// =====================================================================

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
const CLOSED_KEY  = "qb:trades:closed";

async function redisLRANGE(key, start, stop) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Upstash env vars missing");
  const res = await fetch(
    `${REDIS_URL}/lrange/${encodeURIComponent(key)}/${start}/${stop}`,
    { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
  );
  const j = await res.json();
  return j.result || [];
}

function parseTrades(rawList) {
  return rawList
    .map((s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch (_) { return null; }})
    .filter(Boolean);
}

function statsFor(trades) {
  if (trades.length === 0) {
    return { sample: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, avgR: 0, verdict: "too-few-trades", trend: "flat", lastN: [] };
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

  // Verdict
  let verdict = "too-few-trades";
  if (sample >= 5) {
    if (profitFactor >= 1.5)      verdict = "profitable";
    else if (profitFactor >= 1.0) verdict = "marginal";
    else                          verdict = "underperforming";
  }

  // Recent-trend: compare last 5 vs prior 5
  let trend = "flat";
  if (sample >= 10) {
    const recent = trades.slice(-5);
    const prior  = trades.slice(-10, -5);
    const recentR = recent.reduce((a, t) => a + (t.rMultiple || 0), 0) / 5;
    const priorR  = prior.reduce((a, t) => a + (t.rMultiple || 0), 0) / 5;
    if (recentR > priorR + 0.2)      trend = "improving";
    else if (recentR < priorR - 0.2) trend = "declining";
  }

  const lastN = trades.slice(-5).map((t) => (t.rMultiple || 0));

  return { sample, wins, losses, winRate, profitFactor, avgR, verdict, trend, lastN };
}

function bySession(trades) {
  const out = {};
  for (const t of trades) {
    const s = t.session || classifySession(t.closedAt || t.openedAt);
    if (!out[s]) out[s] = [];
    out[s].push(t);
  }
  const result = {};
  for (const [s, arr] of Object.entries(out)) {
    result[s] = statsFor(arr);
  }
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
  for (const [a, arr] of Object.entries(out)) {
    result[a] = statsFor(arr);
  }
  return result;
}

function classifySession(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts);
  const dow = d.getUTCDay();
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (dow === 0 || dow === 6) return "weekend";
  if (utcMin < 6 * 60)        return "asia";
  if (utcMin < 7 * 60)        return "frankfurt-open";
  if (utcMin < 9 * 60)        return "london-open";
  if (utcMin < 12 * 60)       return "london-mid";
  if (utcMin < 13 * 60)       return "pre-ny";
  if (utcMin < 15 * 60)       return "ny-open";
  if (utcMin < 19 * 60)       return "ny-mid";
  if (utcMin < 22 * 60)       return "ny-late";
  return "asia";
}

export default async function handler(req, res) {
  try {
    const days = parseInt(req.query?.days || "0", 10);
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;

    let trades = [];
    try {
      const raw = await redisLRANGE(CLOSED_KEY, 0, -1);
      trades = parseTrades(raw);
    } catch (_) {
      // Redis empty / not set up — return empty stats, not an error
    }

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
        byAsset:   byAsset(arr),
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