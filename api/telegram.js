/* eslint-disable */
// api/telegram.js  v15.6
//
// Telegram notification service — single source for all Telegram messages.
//
// Principles:
//   1. Idempotent   — Redis dedupe (7-day TTL) prevents duplicate sends
//   2. Resilient    — Telegram errors never propagate; always wrapped in try/catch
//   3. Informative  — every message gives full context at a glance
//   4. Consistent   — all prices, R-multiples, and asset names use the same helpers

const { getRedis } = require('./_lib');
const { templateLabelMap, TEMPLATE_META } = require('./_templates');

const TEMPLATE_LABELS = templateLabelMap();

const TG_BOT_TOKEN_ENV = 'TELEGRAM_BOT_TOKEN';
const TG_CHAT_ID_ENV   = 'TELEGRAM_CHAT_ID';

const NOTIF_DEDUPE_PREFIX = 'v12:tg:dedupe:';
const NOTIF_DEDUPE_TTL    = 7 * 24 * 60 * 60; // 7 days

// ─── Low-level send ───────────────────────────────────────────────────────────

async function sendTelegram(text, opts = {}) {
  const token  = process.env[TG_BOT_TOKEN_ENV];
  const chatId = opts.chatId || process.env[TG_CHAT_ID_ENV];
  if (!token || !chatId) return { ok: false, error: 'telegram-credentials-missing' };

  try {
    const body = {
      chat_id:                  chatId,
      text:                     String(text).slice(0, 4096),
      parse_mode:               'HTML',
      disable_web_page_preview: true,
      disable_notification:     opts.silent === true,
    };
    if (opts.reply_markup) body.reply_markup = opts.reply_markup;

    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `tg-${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, messageId: data.result?.message_id };
  } catch (e) {
    return { ok: false, error: `tg-fetch: ${e.message}` };
  }
}

// Low-level API call for non-sendMessage methods (editMessageText, answerCallbackQuery)
async function tgCall(method, body) {
  const token = process.env[TG_BOT_TOKEN_ENV];
  if (!token) return { ok: false };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    return resp.json().catch(() => ({ ok: false }));
  } catch (_) { return { ok: false }; }
}

// Confirm/cancel inline keyboard for staged JARVIS actions
function confirmKeyboard() {
  return { inline_keyboard: [[
    { text: '✅ Confirm', callback_data: 'confirm' },
    { text: '❌ Cancel',  callback_data: 'cancel'  },
  ]]};
}

// Push a proactive JARVIS alert to Telegram (used by jarvis.js for critical urgency)
async function telegramPush(text, withConfirmKeyboard = false) {
  const opts = withConfirmKeyboard ? { reply_markup: confirmKeyboard() } : {};
  return sendTelegram(`🤖 <b>JARVIS</b>\n\n${text}`, opts);
}

// ─── Dedupe ───────────────────────────────────────────────────────────────────

async function alreadySent(key) {
  if (!key) return false;
  const r = getRedis();
  if (!r) return false;
  try {
    return (await r.get(NOTIF_DEDUPE_PREFIX + key).catch(() => null)) != null;
  } catch (_) { return false; }
}

async function markSent(key) {
  if (!key) return;
  const r = getRedis();
  if (!r) return;
  try { await r.set(NOTIF_DEDUPE_PREFIX + key, '1', { ex: NOTIF_DEDUPE_TTL }); } catch (_) {}
}

async function sendOnce(dedupeKey, text, opts) {
  if (await alreadySent(dedupeKey)) return { sent: false, reason: 'already-sent' };
  const result = await sendTelegram(text, opts);
  if (result.ok) { await markSent(dedupeKey); return { sent: true }; }
  return { sent: false, reason: result.error };
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

// Full asset name map — every id in asset-registry.js
const ASSET_LABELS = {
  // Forex majors
  eurusd:   'EUR/USD',
  gbpusd:   'GBP/USD',
  usdjpy:   'USD/JPY',
  usdchf:   'USD/CHF',
  audusd:   'AUD/USD',
  nzdusd:   'NZD/USD',
  usdcad:   'USD/CAD',
  // Forex crosses
  eurjpy:   'EUR/JPY',
  gbpjpy:   'GBP/JPY',
  eurgbp:   'EUR/GBP',
  eurcad:   'EUR/CAD',
  audjpy:   'AUD/JPY',
  // Metals
  gold:     'XAU/USD',
  silver:   'XAG/USD',
  platinum: 'XPT/USD',
  // Crypto
  btc:      'BTC/USD',
  eth:      'ETH/USD',
  sol:      'SOL/USD',
  xrp:      'XRP/USD',
  // Indices
  nas100:   'NAS100',
  us30:     'US30',
  us500:    'US500',
  ger40:    'GER40',
  uk100:    'FTSE 100',
  jp225:    'Nikkei 225',
  usdx:     'DXY',
};

function assetLabel(asset) {
  return ASSET_LABELS[asset] || (asset ? asset.toUpperCase() : '?');
}

function formatPrice(p, asset) {
  if (p == null || !isFinite(p)) return '?';
  const isForex = asset && /^(eur|gbp|jpy|usd|chf|aud|nzd|cad)/i.test(asset);
  return isForex ? p.toFixed(5) : p.toFixed(2);
}

function formatMoney(d) {
  if (d == null || !isFinite(d)) return '?';
  return `${d >= 0 ? '+' : ''}$${d.toFixed(2)}`;
}

function formatR(totalPnL, riskDollars) {
  if (!riskDollars || !isFinite(riskDollars) || riskDollars <= 0) return null;
  const r = totalPnL / riskDollars;
  return `${r >= 0 ? '+' : ''}${r.toFixed(1)}R`;
}

// "47 min"  |  "1h 23m"  |  "2h 05m"
function formatDuration(ms) {
  if (ms == null || ms < 0) return '?';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function dirArrow(direction) {
  return direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
}

// Quality tier: colour-coded badge
function qualityBadge(tier) {
  const map = { A: '🟢 Tier A', B: '🟡 Tier B', C: '🟠 Tier C', D: '🔴 Tier D' };
  return tier ? (map[tier] || `[${tier}]`) : null;
}

// Template glyph + label, e.g. "🥈 Silver Bullet"
function templateLine(template) {
  if (!template) return null;
  return TEMPLATE_LABELS[template] || template;
}

// TP source → human-readable label
function tpSourceLabel(src) {
  const map = { rr: 'RR', fib: 'Fib', structure: 'Structure', alexg: 'Structure' };
  return src ? (map[src] || src) : '';
}

// =================================================================
// EVENT 1: KILL ZONE OPEN
// =================================================================

const KZ_EMOJIS = {
  LONDON:       '🏦',
  NY_AM:        '🗽',
  LONDON_CLOSE: '⏳',
  NY_PM:        '🌆',
};
const KZ_SUBTITLES = {
  LONDON:       'London open — liquidity hunt begins.',
  NY_AM:        'New York AM — highest volume window.',
  LONDON_CLOSE: 'London close — last liquidity sweep.',
  NY_PM:        'Silver Bullet window — precision entries only.',
};

async function notifyKillZoneOpen(killZoneName, watchlist) {
  const dateKey    = new Date().toISOString().slice(0, 10);
  const dedupeKey  = `kz-open:${killZoneName}:${dateKey}`;
  const kzEmoji    = KZ_EMOJIS[killZoneName]  || '🔔';
  const kzSubtitle = KZ_SUBTITLES[killZoneName] || 'Execution window is open.';

  const assetList = (watchlist || []).map(assetLabel).join('  ·  ');

  const text =
    `${kzEmoji} <b>${killZoneName.replace(/_/g, ' ')} Kill Zone — OPEN</b>\n\n` +
    `${kzSubtitle}\n\n` +
    (assetList ? `<b>Watching:</b>  ${assetList}\n\n` : '') +
    `Execution armed. 🎯`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 2: KILL ZONE CLOSE
// =================================================================

async function notifyKillZoneClose(killZoneName) {
  const dateKey   = new Date().toISOString().slice(0, 10);
  const dedupeKey = `kz-close:${killZoneName}:${dateKey}`;
  const kzEmoji   = KZ_EMOJIS[killZoneName] || '🔕';

  const text =
    `${kzEmoji} <b>${killZoneName.replace(/_/g, ' ')} Kill Zone — CLOSED</b>\n\n` +
    `Execution paused. Watcher stays active for the next window.`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 3: SETUP BREWING
// =================================================================

async function notifySetupBrewing({ asset, direction, mode, entry, sl, atrValue, contributingTactics, biasTactics }) {
  const sigEntry  = atrValue > 0 ? Math.round((entry / atrValue) * 2) / 2 : entry;
  const sigSL     = atrValue > 0 ? Math.round((sl    / atrValue) * 2) / 2 : sl;
  const dedupeKey = `brewing:${asset}:${direction}:${sigEntry}:${sigSL}`;

  const slDistance    = Math.abs(entry - sl);
  const slDistanceATR = atrValue > 0 ? (slDistance / atrValue).toFixed(1) + ' ATR' : slDistance.toFixed(2) + ' pts';

  const text =
    `👁 <b>Setup brewing — ${assetLabel(asset)}</b>\n\n` +
    `${dirArrow(direction)}  ${mode || ''}\n` +
    `Entry  <code>${formatPrice(entry, asset)}</code>\n` +
    `SL     <code>${formatPrice(sl, asset)}</code>  (${slDistanceATR})\n` +
    (biasTactics?.length       ? `\n📊 Bias: ${biasTactics.join(' + ')}` : '') +
    (contributingTactics?.length ? `\n🎯 Trigger: ${contributingTactics.join(' + ')}` : '') +
    `\n\n<i>Waiting for kill zone. Will auto-place on activation.</i>`;

  return sendOnce(dedupeKey, text, { silent: true });
}

// =================================================================
// EVENT 4: TRADE PLACED
// =================================================================
// qualityTier: 'A' | 'B' | 'C' | 'D' | null  (from signal-quality gate)

async function notifyTradePlaced({ asset, direction, lot, entry, sl, tpLevels, riskDollars, brokerOrderId, template, qualityTier }) {
  const dedupeKey = `placed:${brokerOrderId || `${asset}-${entry}-${Date.now()}`}`;

  const tpLines = (tpLevels || []).slice(0, 4).map((tp, i) => {
    const r   = tp.rMultiple?.toFixed(1) ?? '?';
    const src = tp.source ? `  <i>${tpSourceLabel(tp.source)}</i>` : '';
    return `TP${i + 1}    <code>${formatPrice(tp.price, asset)}</code>    ${r}R${src}`;
  }).join('\n');

  const slDist = (entry != null && sl != null) ? Math.abs(entry - sl) : null;
  const riskStr = riskDollars != null
    ? `${slDist?.toFixed(slDist > 10 ? 1 : 2) ?? '?'} pts  ·  <b>$${Math.abs(riskDollars).toFixed(2)} risk</b>`
    : (slDist?.toFixed(slDist > 10 ? 1 : 2) ?? '?') + ' pts';

  const tmplLine  = template    ? `${templateLine(template)}\n`                 : '';
  const qualLine  = qualityTier ? `${qualityBadge(qualityTier)}\n`              : '';

  const text =
    `📤 <b>Order Placed — ${assetLabel(asset)}</b>\n\n` +
    tmplLine +
    qualLine +
    `${dirArrow(direction)}  ·  ${lot} lot\n\n` +
    `Entry  <code>${formatPrice(entry, asset)}</code>\n` +
    `SL     <code>${formatPrice(sl, asset)}</code>    (${riskStr})\n` +
    `\n${tpLines}`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 5: TP HIT (partial-close mode — USE_PARTIALS)
// =================================================================
// In v14 all-or-nothing mode the live TP-CONFIRMED / LOCKED messages
// are sent inline from manage-trades.js via sendOnce. This function is
// reserved for when USE_PARTIALS is re-enabled.

async function notifyTPHit({ dedupeKey, asset, direction, tpName, tpPrice, lotClosed, dollarsSecured, cumulativeDollars, slMovedTo }) {
  const key = dedupeKey || `tphit:${asset}:${tpName}:${(tpPrice ?? 0).toFixed(4)}`;
  const tpEmoji = tpName === 'TP1' ? '🥉' : tpName === 'TP2' ? '🥈' : tpName === 'TP3' ? '🥇' : '🎯';

  const text =
    `${tpEmoji} <b>${tpName} hit — ${assetLabel(asset)}</b>\n\n` +
    `${dirArrow(direction)} @ <code>${formatPrice(tpPrice, asset)}</code>\n` +
    `Closed:  ${lotClosed} lot\n` +
    `Secured: <b>${formatMoney(dollarsSecured)}</b>\n` +
    (cumulativeDollars != null ? `Cumulative: ${formatMoney(cumulativeDollars)}\n` : '') +
    (slMovedTo ? `\n🔒 SL locked at <code>${formatPrice(slMovedTo, asset)}</code>` : '');

  return sendOnce(key, text);
}

// =================================================================
// EVENT 6: SL HIT (clean loss — no TPs reached before close)
// =================================================================

async function notifySLHit({ asset, direction, slPrice, dollarsLost, positionId, riskDollars, openedAt }) {
  const dedupeKey   = `slhit:${asset}:${positionId || (slPrice != null ? slPrice.toFixed(4) : 'unknown')}`;
  const durationStr = openedAt ? formatDuration(Date.now() - openedAt) : null;
  const rStr        = formatR(dollarsLost, riskDollars);

  const text =
    `🛑 <b>SL Hit — ${assetLabel(asset)}</b>\n\n` +
    `${dirArrow(direction)}\n` +
    `Exit: <code>${formatPrice(slPrice, asset)}</code>\n` +
    `Loss: <b>${formatMoney(dollarsLost)}</b>${rStr ? `    ${rStr}` : ''}\n` +
    (durationStr ? `Duration: ${durationStr}\n` : '') +
    `\n<i>Risk controlled. Next setup.</i>`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 7: TRADE CLOSED (full lifecycle summary)
// =================================================================
// Covers: wins (with TP level coloring), losses that reached TPs before
// reversing, and breakeven outcomes. Not called for clean SL hits (see above).
//
// Optional params (passed by manage-trades.js close detection):
//   template    — from matchedPending.setup.template
//   session     — from matchedPending.setup.session
//   riskDollars — from matchedPending.sizing.baseRisk (for R-multiple)

async function notifyTradeClosed({ asset, direction, totalPnL, tpsHit, positionId, openedAt, closedAt, template, session, riskDollars }) {
  const dedupeKey = `closed:${positionId || `${asset}-${closedAt}`}`;

  const tpCount    = (tpsHit || []).length;
  const isWin      = totalPnL >  0.5;
  const isLoss     = totalPnL < -0.5;
  const durationMs = (closedAt && openedAt) ? (closedAt - openedAt) : null;
  const duration   = durationMs != null ? formatDuration(durationMs) : null;
  const rStr       = formatR(totalPnL, riskDollars);
  const tpTag      = tpCount > 0 ? `Tagged ${(tpsHit || []).join(' · ')}` : null;

  // Context line: "🥈 Silver Bullet  ·  Asian" (whatever is available)
  const ctxParts = [
    template ? templateLine(template) : null,
    session  ? session                : null,
  ].filter(Boolean);
  const ctxLine = ctxParts.length ? ctxParts.join('  ·  ') + '\n' : '';

  let header, body;

  if (isWin) {
    const icon  = tpCount >= 4 ? '🎯💎' : tpCount === 3 ? '🏆' : tpCount === 2 ? '✅' : '💰';
    const label = tpCount >= 4 ? 'GRAND SLAM' : tpCount === 3 ? 'Strong Win' : tpCount === 2 ? 'Solid Win' : 'Win';
    header = `${icon} <b>${label} — ${assetLabel(asset)}</b>`;
    body   =
      ctxLine +
      `${dirArrow(direction)}\n` +
      (tpTag ? `${tpTag}\n` : '') +
      `<b>${formatMoney(totalPnL)}</b>${rStr ? `    ${rStr}` : ''}\n` +
      (duration ? `${duration}\n` : '') +
      (tpCount >= 4 ? `\nAlhamdulillah. 🤲` : '');

  } else if (isLoss) {
    header = `❌ <b>Loss — ${assetLabel(asset)}</b>`;
    body   =
      ctxLine +
      `${dirArrow(direction)}\n` +
      (tpTag ? `${tpTag}, then reversed past stop\n` : '') +
      `<b>${formatMoney(totalPnL)}</b>${rStr ? `    ${rStr}` : ''}\n` +
      (duration ? `${duration}\n` : '') +
      `\n<i>Risk respected. Next setup.</i>`;

  } else {
    header = `⚖️ <b>Breakeven — ${assetLabel(asset)}</b>`;
    body   =
      ctxLine +
      `${dirArrow(direction)}\n` +
      (tpTag ? `${tpTag}, price came back\n` : '') +
      `Net: <b>${formatMoney(totalPnL)}</b>\n` +
      (duration ? `${duration}\n` : '');
  }

  const text = `${header}\n\n${body}`;
  return sendOnce(dedupeKey, text);
}

// ─── Session-expiry alert ─────────────────────────────────────────────────────
// Fires once when a managed position is still open after its session kill zone
// has closed. Telegram only — no broker action. Redis flag prevents duplicates.
async function notifySessionExpired({ asset, template, direction, positionId, entry, minsExpired, sessionName }) {
  const dedupeKey = `v17:session-expired-notified:${positionId}`;
  const dir       = direction === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴';
  const label     = TEMPLATE_LABELS[template] || template || 'trade';
  const text = [
    `⏰ <b>SESSION EXPIRED — trade still open</b>`,
    `${assetLabel(asset)} · ${label} · ${dir}`,
    `Entry: ${formatPrice(entry, asset)} · ${minsExpired}m past ${sessionName || 'session'} close`,
    `Position still open — your call.`,
  ].join('\n');
  return sendOnce(dedupeKey, text);
}

// =================================================================
// EXPORTS
// =================================================================

module.exports = {
  sendTelegram,
  sendOnce,
  tgCall,
  confirmKeyboard,
  telegramPush,
  // Formatting helpers (exposed for testing and inline use in manage-trades)
  formatPrice,
  formatMoney,
  assetLabel,
  // Event notifiers
  notifyKillZoneOpen,
  notifyKillZoneClose,
  notifySetupBrewing,
  notifyTradePlaced,
  notifyTPHit,
  notifySLHit,
  notifyTradeClosed,
  notifySessionExpired,
};
