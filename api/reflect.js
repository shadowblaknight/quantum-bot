/* eslint-disable */
// V10 — api/reflect.js
// End-of-session AI reflection cycle. Runs once at the end of NY session (21:00 UTC).
//
// Pulls today's trades, sends them to Claude with a structured prompt, asks:
//   * What pattern do you see in today's WINNERS?
//   * What pattern do you see in today's LOSERS?
//   * One concrete lesson for tomorrow.
//
// Stores resulting insights into memory layer 2 (mid-term, 7-day rolling)
// and the most actionable insight into memory layer 3 (long-term, permanent).

const { applyCors, getRedis, safeParse, tg, selfBase } = require('./_lib');
const { readMemory, appendInsight, addLesson } = require('./memory');

async function fetchTodayTrades() {
  // Fetch from /api/history then filter to today UTC
  try {
    const r = await fetch(selfBase() + '/api/history');
    if (!r.ok) return [];
    const data = await r.json();
    const trades = Array.isArray(data.trades) ? data.trades : (Array.isArray(data.deals) ? data.deals : []);
    const today = new Date().toISOString().slice(0, 10);
    return trades.filter(t => {
      const d = t.time || t.closeTime || '';
      return String(d).startsWith(today);
    });
  } catch (_) { return []; }
}

function summarizeTrades(trades) {
  if (!trades.length) return 'No trades today.';
  const wins = trades.filter(t => (t.profit || 0) > 0);
  const losses = trades.filter(t => (t.profit || 0) < 0);
  const totalPnl = trades.reduce((s, t) => s + (t.profit || 0), 0);
  const lines = [
    'Total trades: ' + trades.length + ' (' + wins.length + 'W / ' + losses.length + 'L)',
    'Net P&L: $' + totalPnl.toFixed(2),
    '',
    'WINNERS:',
  ];
  wins.forEach(t => {
    const cmt = (t.comment || '').replace(/^QB:/, '');
    lines.push('  ' + t.symbol + ' ' + (t.type || '?') + ' +$' + (t.profit || 0).toFixed(2) + ' [' + cmt + ']');
  });
  lines.push('LOSERS:');
  losses.forEach(t => {
    const cmt = (t.comment || '').replace(/^QB:/, '');
    lines.push('  ' + t.symbol + ' ' + (t.type || '?') + ' $' + (t.profit || 0).toFixed(2) + ' [' + cmt + ']');
  });
  return lines.join('\n');
}

async function callClaudeForReflection(tradesSummary, memoryContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'no api key' };

  const prompt = `You are reviewing a trading bot's day to help it learn.

=== TODAY'S TRADES ===
${tradesSummary}

=== BOT'S CURRENT MEMORY ===
${memoryContext.slice(0, 3000)}

=== YOUR JOB ===
Analyze the day. Be specific. No fluff. Output JSON:
{
  "winnersPattern": "1-2 sentences. Common trait of today's winning trades. e.g. 'all winners were TREND family during London session on XAUUSD'",
  "losersPattern": "1-2 sentences. Common trait of today's losing trades.",
  "topInsight": "1 sentence. The single most important takeaway.",
  "actionableLesson": "1 sentence. A concrete rule the bot should follow tomorrow. Will be added to permanent memory."
}

If there were no trades or insufficient data, return all fields as "Insufficient data."
DO NOT include anything before or after the JSON.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { error: 'Anthropic ' + r.status + ': ' + txt.slice(0, 200) };
    }
    const data = await r.json();
    const text = (data.content || []).map(c => c.text || '').join('').trim();
    let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return { error: 'unparseable', raw: text };
    try {
      return { parsed: JSON.parse(cleaned.slice(start, end + 1)), usage: data.usage };
    } catch (_) { return { error: 'JSON parse failed', raw: text }; }
  } catch (e) { return { error: e && e.message ? e.message : 'unknown' }; }
}

async function runReflection() {
  const trades = await fetchTodayTrades();
  const memory = await readMemory();
  const tradesSummary = summarizeTrades(trades);
  const { buildPromptContext } = require('./memory');
  const memCtx = buildPromptContext(memory, '');

  const result = await callClaudeForReflection(tradesSummary, memCtx);
  if (result.error) return { error: result.error, raw: result.raw };

  const insights = result.parsed;

  // Store winnersPattern + losersPattern as mid-term insights
  if (insights.winnersPattern && insights.winnersPattern !== 'Insufficient data.') {
    await appendInsight('Winners: ' + insights.winnersPattern, 'reflection');
  }
  if (insights.losersPattern && insights.losersPattern !== 'Insufficient data.') {
    await appendInsight('Losers: ' + insights.losersPattern, 'reflection');
  }
  if (insights.topInsight && insights.topInsight !== 'Insufficient data.') {
    await appendInsight(insights.topInsight, 'reflection');
  }
  // Store actionableLesson permanently
  if (insights.actionableLesson && insights.actionableLesson !== 'Insufficient data.') {
    await addLesson(insights.actionableLesson, 'daily-reflection-' + new Date().toISOString().slice(0, 10));
  }

  // Telegram notification
  await tg(
    '🧠 <b>Daily Reflection</b>\n\n' +
    '<pre>' +
    'Trades: ' + trades.length + ' (' + trades.filter(t => (t.profit || 0) > 0).length + 'W / ' + trades.filter(t => (t.profit || 0) < 0).length + 'L)\n' +
    'Net: $' + trades.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2) + '\n' +
    '──────────────────\n' +
    'Winners: ' + (insights.winnersPattern || '—') + '\n' +
    'Losers:  ' + (insights.losersPattern || '—') + '\n' +
    'Insight: ' + (insights.topInsight || '—') + '\n' +
    'Lesson:  ' + (insights.actionableLesson || '—') +
    '</pre>'
  );

  return { ok: true, trades: trades.length, insights };
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  // Manual trigger or cron — accept GET or POST
  try {
    return res.status(200).json(await runReflection());
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'unknown' });
  }
};

module.exports.runReflection = runReflection;