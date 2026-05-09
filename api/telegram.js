/* eslint-disable */
// V12.2 — api/telegram.js
//
// Telegram notification service. One central place for formatting and dispatch.
//
// Core principles:
//   1. Idempotent — won't double-send the same event (Redis dedupe)
//   2. Resilient — Telegram errors never break the main pipeline
//   3. Quiet — uses HTML formatting for clean rendering, no markdown noise
//
// Notification types:
//   - kill-zone-open / kill-zone-close
//   - setup-brewing (with re-emit on significant entry/SL change)
//   - trade-placed (full setup details: TP1-4, SL, $risk)
//   - tp-hit (which TP, $ secured this leg, cumulative)
//   - sl-hit (full loss amount)
//   - trade-closed (final outcome with style varying by tier)
//
// All messages use Telegram HTML mode for safe formatting.
// ----------------------------------------------------------------------------

const { getRedis } = require('./_lib');

const TG_BOT_TOKEN_ENV = 'TELEGRAM_BOT_TOKEN';
const TG_CHAT_ID_ENV = 'TELEGRAM_CHAT_ID';

const NOTIF_DEDUPE_PREFIX = 'v12:tg:dedupe:';
const NOTIF_DEDUPE_TTL = 7 * 24 * 60 * 60; // 7 days — long enough that a setup cannot re-fire after expiry

// =================================================================
// LOW-LEVEL SEND
// =================================================================

async function sendTelegram(text, opts = {}) {
  const token = process.env[TG_BOT_TOKEN_ENV];
  const chatId = process.env[TG_CHAT_ID_ENV];
  if (!token || !chatId) {
    return { ok: false, error: 'telegram-credentials-missing' };
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: opts.silent === true,
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `tg-${resp.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `tg-fetch: ${e.message}` };
  }
}

// =================================================================
// DEDUPE
// =================================================================
// Prevents sending the same notification twice. Each notification has a
// natural dedupe key (event type + entity ID).

async function alreadySent(dedupeKey) {
  if (!dedupeKey) return false;
  const r = getRedis();
  if (!r) return false;
  try {
    const seen = await r.get(NOTIF_DEDUPE_PREFIX + dedupeKey).catch(() => null);
    return seen != null;
  } catch (_) {
    return false;
  }
}

async function markSent(dedupeKey) {
  if (!dedupeKey) return;
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(NOTIF_DEDUPE_PREFIX + dedupeKey, '1', { ex: NOTIF_DEDUPE_TTL });
  } catch (_) {}
}

// Send with dedupe — returns { sent, reason }
async function sendOnce(dedupeKey, text, opts) {
  if (await alreadySent(dedupeKey)) {
    return { sent: false, reason: 'already-sent' };
  }
  const result = await sendTelegram(text, opts);
  if (result.ok) {
    await markSent(dedupeKey);
    return { sent: true };
  }
  return { sent: false, reason: result.error };
}

// =================================================================
// FORMATTING HELPERS
// =================================================================

function formatPrice(p, asset) {
  if (p == null || !isFinite(p)) return '?';
  // Forex assets get 5 decimals, indices/metals/crypto get 2
  const isForex = asset && /^(eur|gbp|jpy|usd|chf|aud|nzd|cad)/i.test(asset);
  return isForex ? p.toFixed(5) : p.toFixed(2);
}

function formatMoney(d) {
  if (d == null || !isFinite(d)) return '?';
  const sign = d >= 0 ? '+' : '';
  return `${sign}$${d.toFixed(2)}`;
}

function assetLabel(asset) {
  const map = {
    gold: 'XAU/USD',
    eurusd: 'EUR/USD',
    btc: 'BTC/USD',
    gbpusd: 'GBP/USD',
  };
  return map[asset] || asset.toUpperCase();
}

function dirArrow(direction) {
  return direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
}

// =================================================================
// EVENT 1: KILL ZONE OPEN
// =================================================================
// Fires once per KZ open (dedupe by KZ name + date)

async function notifyKillZoneOpen(killZoneName, watchlist) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const dedupeKey = `kz-open:${killZoneName}:${dateKey}`;

  const assetList = (watchlist || []).map(assetLabel).join(' • ');
  const text =
    `🔔 <b>${killZoneName} Kill Zone — OPEN</b>\n\n` +
    `Watching: ${assetList || '(empty watchlist)'}\n` +
    `Trade execution is now enabled for the next window.`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 2: KILL ZONE CLOSE
// =================================================================

async function notifyKillZoneClose(killZoneName) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const dedupeKey = `kz-close:${killZoneName}:${dateKey}`;

  const text =
    `🔕 <b>${killZoneName} Kill Zone — CLOSED</b>\n\n` +
    `Trade execution paused. Watcher continues monitoring for next window.`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 3: SETUP BREWING
// =================================================================
// Fires when a new pending setup is created. Re-fires if entry or SL
// changes by >= 0.5 ATR vs the last brewing notification for that asset.
// Dedupe key includes a "rounded" entry/SL signature so small moves
// don't re-emit but big ones do.

async function notifySetupBrewing({ asset, direction, mode, entry, sl, atrValue, contributingTactics, biasTactics }) {
  const sigEntry = atrValue > 0 ? Math.round((entry / atrValue) * 2) / 2 : entry; // half-ATR buckets
  const sigSL = atrValue > 0 ? Math.round((sl / atrValue) * 2) / 2 : sl;
  const dedupeKey = `brewing:${asset}:${direction}:${sigEntry}:${sigSL}`;

  const slDistance = Math.abs(entry - sl);
  const slDistanceATR = atrValue > 0 ? slDistance / atrValue : 0;

  const text =
    `👁 <b>Setup brewing — ${assetLabel(asset)}</b>\n\n` +
    `${dirArrow(direction)} ${mode}\n` +
    `Entry zone: <code>${formatPrice(entry, asset)}</code>\n` +
    `SL: <code>${formatPrice(sl, asset)}</code> (${slDistanceATR.toFixed(1)} ATR)\n` +
    `\n` +
    (biasTactics?.length ? `📊 Bias: ${biasTactics.join(' + ')}\n` : '') +
    (contributingTactics?.length ? `🎯 Trigger: ${contributingTactics.join(' + ')}\n` : '') +
    `\n<i>Waiting for limit fill. Will execute only inside kill zone.</i>`;

  return sendOnce(dedupeKey, text, { silent: true });
}

// =================================================================
// EVENT 4: TRADE PLACED
// =================================================================
// Fires when limit order is actually placed by execute.js

async function notifyTradePlaced({ asset, direction, lot, entry, sl, tpLevels, riskDollars, brokerOrderId }) {
  const dedupeKey = `placed:${brokerOrderId || `${asset}-${entry}-${Date.now()}`}`;

  const tpLines = (tpLevels || []).slice(0, 4).map((tp, i) =>
    `TP${i + 1}: <code>${formatPrice(tp.price, asset)}</code> (${tp.rMultiple?.toFixed(1) || '?'}R) — ${tp.source || ''}`
  ).join('\n');

  const text =
    `📤 <b>Order Placed — ${assetLabel(asset)}</b>\n\n` +
    `${dirArrow(direction)}  •  ${lot} lot\n` +
    `Entry: <code>${formatPrice(entry, asset)}</code>\n` +
    `SL: <code>${formatPrice(sl, asset)}</code>\n` +
    (riskDollars != null ? `Risk: <b>${formatMoney(-Math.abs(riskDollars))}</b> if SL hit\n\n` : '\n') +
    `<b>Take Profits:</b>\n${tpLines}`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 5: TP HIT (partial close)
// =================================================================
// Fires for each TP1, TP2, TP3 (TP4 is handled as full-close in trade-closed)

async function notifyTPHit({ asset, direction, tpName, tpPrice, lotClosed, dollarsSecured, cumulativeDollars, slMovedTo }) {
  // Use position-id based dedupe: tp-hit:<asset>:<positionId>:<tpName>
  // Caller supplies dedupeKey via passing position context
  const dedupeKey = arguments[0].dedupeKey || `tphit:${asset}:${tpName}:${tpPrice.toFixed(4)}`;

  const tpEmoji = tpName === 'TP1' ? '🥉' : tpName === 'TP2' ? '🥈' : tpName === 'TP3' ? '🥇' : '🎯';

  const text =
    `${tpEmoji} <b>${tpName} hit — ${assetLabel(asset)}</b>\n\n` +
    `${dirArrow(direction)} @ <code>${formatPrice(tpPrice, asset)}</code>\n` +
    `Closed: ${lotClosed} lot\n` +
    `Secured: <b>${formatMoney(dollarsSecured)}</b>\n` +
    (cumulativeDollars != null ? `Total locked: ${formatMoney(cumulativeDollars)}\n` : '') +
    (slMovedTo ? `\n🔒 SL moved to <code>${formatPrice(slMovedTo, asset)}</code>` : '');

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 6: SL HIT (full loss)
// =================================================================

async function notifySLHit({ asset, direction, slPrice, dollarsLost, positionId }) {
  const dedupeKey = `slhit:${asset}:${positionId || slPrice.toFixed(4)}`;

  const text =
    `❌ <b>SL Hit — ${assetLabel(asset)}</b>\n\n` +
    `${dirArrow(direction)} closed @ <code>${formatPrice(slPrice, asset)}</code>\n` +
    `Loss: <b>${formatMoney(dollarsLost)}</b>\n\n` +
    `<i>Discipline preserved. Next setup awaits.</i>`;

  return sendOnce(dedupeKey, text);
}

// =================================================================
// EVENT 7: TRADE CLOSED (final summary, styled by tier)
// =================================================================
// tpsHit: ['TP1','TP2','TP3','TP4'] — full sweep
// tpsHit: ['TP1','TP2','TP3']      — strong
// tpsHit: ['TP1','TP2']             — solid
// tpsHit: ['TP1']                   — modest, BE on remainder
// tpsHit: []                        — straight loss

async function notifyTradeClosed({ asset, direction, totalPnL, tpsHit, positionId, openedAt, closedAt }) {
  const dedupeKey = `closed:${positionId || `${asset}-${closedAt}`}`;

  const tpCount = (tpsHit || []).length;
  const isWin = totalPnL > 0.5;
  const isLoss = totalPnL < -0.5;
  const durationMs = (closedAt && openedAt) ? (closedAt - openedAt) : null;
  const durationStr = durationMs != null
    ? (durationMs < 3600000
      ? `${Math.round(durationMs / 60000)} min`
      : `${(durationMs / 3600000).toFixed(1)} h`)
    : '?';

  let header;
  let body;

  if (tpCount === 4) {
    // Grand slam — all 4 TPs hit
    header = `🎯💎 <b>GRAND SLAM — ${assetLabel(asset)}</b>`;
    body = `All 4 TPs swept. Maximum extraction achieved.\n\n` +
           `${dirArrow(direction)}\n` +
           `Total: <b>${formatMoney(totalPnL)}</b>\n` +
           `Duration: ${durationStr}\n\n` +
           `Alhamdulillah. 🤲`;
  } else if (tpCount === 3) {
    header = `🏆 <b>Strong Win — ${assetLabel(asset)}</b>`;
    body = `Three TPs hit, trail closed remainder.\n\n` +
           `${dirArrow(direction)}\n` +
           `Total: <b>${formatMoney(totalPnL)}</b>\n` +
           `Duration: ${durationStr}`;
  } else if (tpCount === 2) {
    header = `✅ <b>Solid Win — ${assetLabel(asset)}</b>`;
    body = `Two TPs secured.\n\n` +
           `${dirArrow(direction)}\n` +
           `Total: <b>${formatMoney(totalPnL)}</b>\n` +
           `Duration: ${durationStr}`;
  } else if (tpCount === 1) {
    if (isWin) {
      header = `💰 <b>TP1 Win — ${assetLabel(asset)}</b>`;
      body = `TP1 secured, BE held remainder.\n\n` +
             `${dirArrow(direction)}\n` +
             `Total: <b>${formatMoney(totalPnL)}</b>\n` +
             `Duration: ${durationStr}`;
    } else {
      // TP1 hit but ran into BE = breakeven
      header = `⚖️ <b>Breakeven after TP1 — ${assetLabel(asset)}</b>`;
      body = `TP1 secured, BE stop tagged on remainder.\n\n` +
             `${dirArrow(direction)}\n` +
             `Net: <b>${formatMoney(totalPnL)}</b>\n` +
             `Duration: ${durationStr}\n\n` +
             `<i>No loss. Capital preserved.</i>`;
    }
  } else {
    // 0 TPs hit
    if (isLoss) {
      header = `❌ <b>Loss — ${assetLabel(asset)}</b>`;
      body = `${dirArrow(direction)}\n` +
             `Loss: <b>${formatMoney(totalPnL)}</b>\n` +
             `Duration: ${durationStr}\n\n` +
             `<i>Risk respected. Next setup.</i>`;
    } else {
      header = `— <b>Breakeven — ${assetLabel(asset)}</b>`;
      body = `${dirArrow(direction)}\n` +
             `Net: <b>${formatMoney(totalPnL)}</b>\n` +
             `Duration: ${durationStr}`;
    }
  }

  const text = `${header}\n\n${body}`;
  return sendOnce(dedupeKey, text);
}

// =================================================================
// EXPORTS
// =================================================================

module.exports = {
  // Low-level
  sendTelegram,
  sendOnce,
  // Formatting helpers (exposed for testing)
  formatPrice,
  formatMoney,
  assetLabel,
  // Event-specific notifiers
  notifyKillZoneOpen,
  notifyKillZoneClose,
  notifySetupBrewing,
  notifyTradePlaced,
  notifyTPHit,
  notifySLHit,
  notifyTradeClosed,
};