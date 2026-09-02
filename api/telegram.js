/* eslint-disable */
// api/telegram.js  v20.0 — V20 Specialist-first notification service
//
// Dead code removed from v15.6:
//   notifyKillZoneOpen, notifyKillZoneClose — noisy, irrelevant in V20 specialist mode
//   notifySetupBrewing — legacy autonomous watcher, not used in V20
//   notifyTPHit        — USE_PARTIALS=false, never called
//
// New in v20.0:
//   notifySpecialistTPConfirmed — clean TP hit message (was inline sendOnce in manage-trades)
//   notifySpecialistSLLocked    — SL ratchet confirmed (was inline sendOnce)
//   notifySpecialistSLWarning   — SL lock skipped/failed/rejected (was inline sendOnce)
//   notifyOCOFailed             — OCO cancel race condition alert (was inline sendOnce)
//
// Active zone types (V20 only — others blocked at webhook gate):
//   Gold:   FRB, NYORB
//   NAS100: AMD-FVG
//   GER40:  B, G
//   GBPUSD: SFP-L, SFP-H, AOI-D, AOI-W

const { getRedis } = require('./_lib');
const { templateLabelMap, SPECIALIST_META_MAP } = require('./_templates');

const TEMPLATE_LABELS = templateLabelMap();

// V20 active sub-signal labels only — dead zones removed
const ZONE_TYPE_LABELS = {
  // Gold Specialist (GS1) — H+M confirmed only
  'FRB':      'Frankfurt ORB Retest',
  'NYORB':    'NY ORB Retest',
  // NAS100 Specialist — AMD-FVG confirmed
  'AMD-FVG':  'Session Intel FVG',
  // GER40 B+G Specialist
  'B':        'Frankfurt ORB',
  'G':        'London FVG Retest',
  // GBPUSD Specialist (Alex G methodology)
  'SFP-L':    'Asian Sweep Low',
  'SFP-H':    'Asian Sweep High',
  'AOI-D':    'Daily Zone Approach',
  'AOI-W':    'Weekly Zone Approach',
};

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

// Push a proactive JARVIS alert to Telegram
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

const ASSET_LABELS = {
  eurusd: 'EUR/USD', gbpusd: 'GBP/USD', usdjpy: 'USD/JPY', usdchf: 'USD/CHF',
  audusd: 'AUD/USD', nzdusd: 'NZD/USD', usdcad: 'USD/CAD',
  eurjpy: 'EUR/JPY', gbpjpy: 'GBP/JPY', eurgbp: 'EUR/GBP',
  gold:   'XAU/USD', silver: 'XAG/USD',
  btc:    'BTC/USD', eth:    'ETH/USD',
  nas100: 'NAS100',  us30:   'US30', us500: 'US500',
  ger40:  'GER40',   uk100:  'FTSE 100',
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
  return `${d >= 0 ? '+' : ''}$${Math.abs(d).toFixed(2)}`;
}

function formatR(totalPnL, riskDollars) {
  if (!riskDollars || !isFinite(riskDollars) || riskDollars <= 0) return null;
  const r = totalPnL / riskDollars;
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

function formatDuration(ms) {
  if (ms == null || ms < 0) return '?';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function dirArrow(direction) {
  return direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
}

function signalHeader(template, zoneType) {
  const meta  = SPECIALIST_META_MAP[template] || { glyph: '🎯', label: template || 'Trade' };
  const zone  = ZONE_TYPE_LABELS[zoneType] || zoneType || '';
  return zone ? `${meta.glyph} <b>${meta.label} — ${zone}</b>` : `${meta.glyph} <b>${meta.label}</b>`;
}

function pFmt(p, asset) { return `<code>${formatPrice(p, asset)}</code>`; }

// =================================================================
// V20 EVENT 1: SPECIALIST TRADE PLACED
// =================================================================
// c2Mode: 'OCO' | null — shows C2 LIMIT tag when set

async function notifySpecialistTradePlaced({ asset, direction, lot, entry, sl, tpLevels, riskDollars, brokerOrderId, template, zoneType, session, tier, filterStr, c2Mode }) {
  const dedupeKey  = `placed:${brokerOrderId || `${asset}-${entry}-${Date.now()}`}`;
  const header     = signalHeader(template, zoneType);
  const sessLabel  = session ? session.replace(/_/g, ' ') : '';
  const tierLabel  = tier    ? `Tier ${tier}`              : '';
  const c2Label    = c2Mode === 'OCO' ? '⚡ C2 OCO LIMIT' : '';
  const ctxParts   = [sessLabel, tierLabel, c2Label].filter(Boolean);

  const slDist  = (entry != null && sl != null) ? Math.abs(entry - sl) : null;
  const riskStr = riskDollars != null
    ? `${slDist?.toFixed(slDist > 10 ? 1 : 2) ?? '?'} pts  ·  <b>$${Math.abs(riskDollars).toFixed(2)}</b>`
    : `${slDist?.toFixed(slDist > 10 ? 1 : 2) ?? '?'} pts`;

  const tpLines = (tpLevels || []).slice(0, 3).map((tp, i) => {
    const r = tp.rMultiple != null ? `${tp.rMultiple.toFixed(1)}R` : '';
    return `TP${i + 1}  ${pFmt(tp.price, asset)}  ${r}`;
  }).join('\n');

  const text =
    `${header}\n` +
    (ctxParts.length ? `${ctxParts.join('  ·  ')}\n` : '') +
    `\n${dirArrow(direction)}  ·  ${lot} lot\n\n` +
    `Entry  ${pFmt(entry, asset)}\n` +
    `SL     ${pFmt(sl, asset)}  (${riskStr})\n` +
    (tpLines ? `\n${tpLines}` : '') +
    (filterStr ? `\n\n<i>${filterStr.slice(0, 100)}</i>` : '');

  return sendOnce(dedupeKey, text);
}

// =================================================================
// V20 EVENT 2: SPECIALIST TP CONFIRMED
// =================================================================
// Replaces the inline sendOnce in manage-trades for TP detection.

async function notifySpecialistTPConfirmed({ positionId, asset, direction, tpName, tpPrice, rMult }) {
  const dedupeKey = `tp-confirmed:${positionId}:${tpName}`;
  const emoji     = tpName === 'TP1' ? '🥉' : tpName === 'TP2' ? '🥈' : '🥇';
  const isLong    = direction === 'LONG';

  const text =
    `${emoji} <b>${tpName} hit — ${assetLabel(asset)}</b>\n\n` +
    `${isLong ? '🟢' : '🔴'} ${direction}  ·  ${pFmt(tpPrice, asset)}  (${rMult != null ? rMult.toFixed(1) + 'R' : '?'})\n` +
    `SL ratchet pending — locking on next tick`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// V20 EVENT 3: SL RATCHET LOCKED
// =================================================================
// Fires when broker confirms the new SL after a TP hit.

async function notifySpecialistSLLocked({ positionId, asset, direction, tpName, slPrice, rMult }) {
  const dedupeKey  = `tplock:${positionId}:${tpName}`;
  const isBE       = tpName.endsWith('-be');
  const label      = isBE ? `BE locked 🔒` : `SL → TP${parseInt(tpName.replace('TP','').replace('-be',''))-1} 🔒`;
  const emoji      = isBE ? '🛡' : '🔒';
  const isLong     = direction === 'LONG';

  const text =
    `${emoji} <b>${label} — ${assetLabel(asset)}</b>\n\n` +
    `${isLong ? '🟢' : '🔴'} ${direction}  ·  SL now ${pFmt(slPrice, asset)}` +
    (rMult != null ? `  (${rMult.toFixed(1)}R protected)` : '') +
    `\nTrade is risk-free — riding to final TP`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// V20 EVENT 4: SL RATCHET WARNING (skipped / failed / rejected)
// =================================================================

async function notifySpecialistSLWarning({ positionId, asset, tpName, type, detail }) {
  const dedupeKey = `slwarn-${type}:${positionId}:${tpName}`;
  const labels    = { skip: 'SKIPPED', fail: 'FAILED', reject: 'REJECTED' };
  const text =
    `⚠️ <b>SL lock ${labels[type] || type} — ${assetLabel(asset)}</b>\n` +
    `${tpName}  ·  ${detail || ''}`;
  return sendOnce(dedupeKey, text);
}

// =================================================================
// V20 EVENT 5: OCO CANCEL FAILED
// =================================================================

async function notifyOCOFailed({ orderId, error }) {
  const dedupeKey = `oco-fail:${orderId}`;
  const text =
    `⚠️ <b>OCO cancel FAILED — both legs may be open!</b>\n\n` +
    `Order: <code>${orderId}</code>\n` +
    `Error: ${error || 'unknown'}\n\n` +
    `<i>Check broker immediately — manual close may be needed.</i>`;
  return sendOnce(dedupeKey, text);
}

// =================================================================
// V20 EVENT 6: SPECIALIST TRADE CLOSED
// =================================================================

async function notifySpecialistTradeClosed({ asset, direction, template, zoneType, session, totalPnL, tpsHit, riskDollars, positionId, openedAt }) {
  const dedupeKey   = `v20:closed:${positionId}`;
  const header      = signalHeader(template, zoneType);
  const isWin       = totalPnL >  0.5;
  const isLoss      = totalPnL < -0.5;
  const pnlStr      = formatMoney(totalPnL);
  const rStr        = formatR(totalPnL, riskDollars);
  const durStr      = openedAt ? formatDuration(Date.now() - openedAt) : null;
  const sessLabel   = session ? session.replace(/_/g, ' ') : null;

  const outcomeEmoji = isWin ? (
    (tpsHit || []).length >= 3 ? '🏆' :
    (tpsHit || []).length >= 2 ? '✅' : '💰'
  ) : isLoss ? '❌' : '⚖️';

  const outcomeLabel = isWin  ? 'WIN'       :
                       isLoss ? 'LOSS'      : 'BREAKEVEN';

  const tpLine = (tpsHit && tpsHit.length > 0)
    ? `Rungs: ${tpsHit.join(' → ')}`
    : (isLoss ? 'No TPs hit' : '');

  const meta  = [sessLabel, durStr].filter(Boolean).join('  ·  ');

  const text =
    `${header}\n` +
    `${outcomeEmoji} <b>${outcomeLabel}</b>  ${pnlStr}${rStr ? `  ${rStr}` : ''}\n\n` +
    `${dirArrow(direction)}\n` +
    (tpLine ? `${tpLine}\n` : '') +
    (meta    ? `${meta}\n`   : '') +
    (isWin && (tpsHit || []).length >= 3 ? `\nAlhamdulillah 🤲` : '');

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 7: SL HIT (clean stop — 0 TPs reached)
// =================================================================

async function notifySLHit({ asset, direction, slPrice, dollarsLost, positionId, riskDollars, openedAt }) {
  const dedupeKey = `slhit:${asset}:${positionId || (slPrice != null ? slPrice.toFixed(4) : 'unknown')}`;
  const rStr      = formatR(dollarsLost, riskDollars);
  const durStr    = openedAt ? formatDuration(Date.now() - openedAt) : null;

  const text =
    `🛑 <b>SL Hit — ${assetLabel(asset)}</b>\n\n` +
    `${dirArrow(direction)}\n` +
    `Exit: ${pFmt(slPrice, asset)}\n` +
    `Loss: <b>${formatMoney(dollarsLost)}</b>${rStr ? `  ${rStr}` : ''}\n` +
    (durStr ? `Duration: ${durStr}\n` : '') +
    `\n<i>Risk controlled. Next setup.</i>`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 8: TRADE CLOSED — generic (legacy + reconstructed closes)
// =================================================================

async function notifyTradeClosed({ asset, direction, totalPnL, tpsHit, positionId, openedAt, closedAt, template, session, riskDollars }) {
  const dedupeKey  = `closed:${positionId || `${asset}-${closedAt}`}`;
  const tpCount    = (tpsHit || []).length;
  const isWin      = totalPnL >  0.5;
  const isLoss     = totalPnL < -0.5;
  const durationMs = (closedAt && openedAt) ? (closedAt - openedAt) : null;
  const rStr       = formatR(totalPnL, riskDollars);
  const tpTag      = tpCount > 0 ? `Tagged ${(tpsHit || []).join(' → ')}` : null;

  const ctxLine = [
    template ? (TEMPLATE_LABELS[template] || template) : null,
    session  ? session                                  : null,
  ].filter(Boolean).join('  ·  ');

  const icon  = isWin  ? (tpCount >= 3 ? '🏆' : tpCount >= 2 ? '✅' : '💰')
              : isLoss ? '❌' : '⚖️';
  const label = isWin  ? (tpCount >= 3 ? 'Strong Win' : 'Win')
              : isLoss ? 'Loss' : 'Breakeven';

  const text =
    `${icon} <b>${label} — ${assetLabel(asset)}</b>\n\n` +
    (ctxLine ? `${ctxLine}\n` : '') +
    `${dirArrow(direction)}\n` +
    (tpTag ? `${tpTag}\n` : '') +
    `<b>${formatMoney(totalPnL)}</b>${rStr ? `  ${rStr}` : ''}\n` +
    (durationMs != null ? `${formatDuration(durationMs)}\n` : '');

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 9: SESSION EXPIRED (position held past kill zone close)
// =================================================================

async function notifySessionExpired({ asset, template, direction, positionId, entry, minsExpired, sessionName }) {
  const dedupeKey = `v17:session-expired-notified:${positionId}`;
  const label     = TEMPLATE_LABELS[template] || template || 'trade';
  const dir       = direction === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴';
  const text =
    `⏰ <b>Session expired — ${assetLabel(asset)}</b>\n\n` +
    `${label} · ${dir}\n` +
    `Entry ${pFmt(entry, asset)} · ${minsExpired}m past ${sessionName || 'session'} close\n` +
    `Position still open — your call.`;
  return sendOnce(dedupeKey, text);
}

// =================================================================
// EXPORTS
// =================================================================

module.exports = {
  // Core
  sendTelegram,
  sendOnce,
  tgCall,
  confirmKeyboard,
  telegramPush,
  // Formatting helpers
  formatPrice,
  formatMoney,
  assetLabel,
  // V20 specialist events
  notifySpecialistTradePlaced,
  notifySpecialistTPConfirmed,
  notifySpecialistSLLocked,
  notifySpecialistSLWarning,
  notifyOCOFailed,
  notifySpecialistTradeClosed,
  // Generic events (legacy + reconstructed closes)
  notifyTradeClosed,
  notifySLHit,
  notifySessionExpired,
};
