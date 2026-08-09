/* eslint-disable */
// api/telegram-webhook.js  v1.0 — JARVIS Telegram Bot Receiver
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/telegram-webhook
//
// Telegram sends all incoming updates here. Two flows:
//
//   Text message  → forward to /api/jarvis → reply with speech
//                   if result.action.type === 'pending_trade' → add confirm buttons
//
//   Callback query (✅/❌ button tap):
//     confirm → call /api/jarvis-action EXECUTE_PENDING → reply with result
//     cancel  → delete pending action from Redis → reply "Cancelled"
//
// All Telegram sends go through telegram.js (single source, deduplication, etc.)
//
// Setup (run once after deploying):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//     -d url="https://YOUR_DOMAIN/api/telegram-webhook" \
//     -d secret_token="YOUR_TELEGRAM_SECRET"
// ─────────────────────────────────────────────────────────────────────────────

const { applyCors, getRedis, safeParse } = require('./_lib');
const { sendTelegram, tgCall, confirmKeyboard } = require('./telegram');

const PENDING_KEY = 'v1:jarvis:pending_action';

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function askJarvis(message, base) {
  try {
    const resp = await fetch(`${base}/api/jarvis`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message }),
    });
    if (!resp.ok) return { speech: `JARVIS returned HTTP ${resp.status}.`, action: null, urgency: 'normal' };
    return resp.json();
  } catch (e) {
    return { speech: `Could not reach JARVIS: ${e.message}`, action: null, urgency: 'normal' };
  }
}

async function executePending(base) {
  try {
    const resp = await fetch(`${base}/api/jarvis-action`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'EXECUTE_PENDING', triggeredBy: 'TELEGRAM:CONFIRM' }),
    });
    const data = await resp.json().catch(() => ({}));
    return data.speech || (data.ok ? 'Done, Sir.' : `Failed: ${data.error || 'unknown error'}`);
  } catch (e) {
    return `Execution failed: ${e.message}`;
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Verify Telegram secret token
  const secret = process.env.TELEGRAM_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const allowedChatId = process.env.TELEGRAM_CHAT_ID;
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000');

  const update = req.body || {};

  // ── Callback query (button tap) ─────────────────────────────────────────
  if (update.callback_query) {
    const cb     = update.callback_query;
    const chatId = String(cb.message?.chat?.id);
    const msgId  = cb.message?.message_id;
    const data   = cb.data;

    if (allowedChatId && chatId !== allowedChatId) {
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not authorized.' });
      return res.status(200).json({ ok: true });
    }

    await tgCall('answerCallbackQuery', { callback_query_id: cb.id });

    let replyText;
    if (data === 'confirm') {
      const speech = await executePending(base);
      replyText = `⚡ <b>JARVIS</b>\n\n${speech}`;
    } else if (data === 'cancel') {
      const r = getRedis();
      if (r) await r.del(PENDING_KEY).catch(() => {});
      replyText = `<b>JARVIS</b>\n\nAction cancelled.`;
    }

    if (replyText) {
      await tgCall('editMessageText', { chat_id: chatId, message_id: msgId, text: replyText, parse_mode: 'HTML' });
    }

    return res.status(200).json({ ok: true });
  }

  // ── Text message ────────────────────────────────────────────────────────
  const msg    = update.message || update.edited_message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId = String(msg.chat?.id);
  const text   = (msg.text || '').trim();
  if (!text) return res.status(200).json({ ok: true });

  if (allowedChatId && chatId !== allowedChatId) {
    await sendTelegram('🔒 Not authorized.', { chatId });
    return res.status(200).json({ ok: true });
  }

  try {
    const jarvis     = await askJarvis(text, base);
    const speech     = jarvis.speech || 'No response.';
    const hasPending = jarvis.action?.type === 'pending_trade';
    const urgency    = jarvis.urgency || 'normal';

    const prefix = urgency === 'critical' ? '🚨 ' : urgency === 'elevated' ? '⚠️ ' : '🤖 ';
    const replyText = `${prefix}<b>JARVIS</b>\n\n${speech}`;

    const opts = hasPending ? { reply_markup: confirmKeyboard() } : {};
    await sendTelegram(replyText, { chatId, ...opts });

  } catch (e) {
    await sendTelegram(`⚠️ <b>JARVIS</b>\n\nError: ${e.message}`, { chatId });
  }

  return res.status(200).json({ ok: true });
};
