/* eslint-disable */
// api/execute.js -- Quantum Bot V9.2
// Changes vs V9.1:
//   - Hard LONG/SHORT structure validation (reject, not just auto-fix)
//   - Telegram notification sent DIRECTLY on successful open (no fragile 3s chain)
//   - Verifies broker actually set SL/TP (fetches position back)
//   - Supports TELEGRAM_TOKEN and TELEGRAM_BOT_TOKEN env var names
//   - Instruments remain fully open -- no hardcoded symbol list

const { Redis } = require('@upstash/redis');

const BASE = 'https://mt-client-api-v1.' + (process.env.META_REGION || 'london') + '.agiliumtrade.ai/users/current/accounts/' + (process.env.METAAPI_ACCOUNT_ID || '');
const HEADERS = { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN || '' };

// ---- Telegram helper: logs errors visibly (does not swallow) ----
const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const tg = async (msg) => {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('[TG] disabled: missing env vars (TELEGRAM_TOKEN / TELEGRAM_CHAT_ID)');
    return { ok: false, reason: 'missing env vars' };
  }
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      console.error('[TG] FAIL ' + r.status + ' ' + JSON.stringify(d).slice(0, 200));
      return { ok: false, status: r.status, resp: d };
    }
    return { ok: true };
  } catch (e) {
    console.error('[TG] throw ' + e.message);
    return { ok: false, error: e.message };
  }
};

// Category detection (pattern-based, no hardcoded symbol lists)
const categoryOf = (sym) => {
  const s = (sym || '').toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 'GOLD';
  if (s.includes('BTC') || s.includes('ETH') || s.includes('CRYPTO') || s.includes('COIN')) return 'CRYPTO';
  return 'OTHER';
};

// Max lot by category (risk cap only, not a symbol whitelist)
const getMaxLot = (sym) => {
  const cat = categoryOf(sym);
  if (cat === 'CRYPTO') return 0.30;
  if (cat === 'GOLD')   return 0.50;
  return 2.00;
};

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };
const priceDp = (p) => (p > 100 ? 2 : 5);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.METAAPI_TOKEN || !process.env.METAAPI_ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing MetaAPI env vars' });
  }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }

  console.log('[EXECUTE] IN', JSON.stringify(body).slice(0, 400));

  const { instrument, direction, entry, stopLoss, takeProfit, volume, comment, lossStreak, riskPaused } = body;

  // ---- Basic validation ----
  if (!instrument)                            return res.status(400).json({ error: 'Missing instrument' });
  if (!['LONG', 'SHORT'].includes(direction)) return res.status(400).json({ error: 'direction must be LONG or SHORT' });
  if (!stopLoss)                              return res.status(400).json({ error: 'Missing stopLoss' });
  if (!volume || volume <= 0)                 return res.status(400).json({ error: 'Missing or invalid volume' });
  if (!entry || entry <= 0)                   return res.status(400).json({ error: 'Missing or invalid entry price' });

  // ---- Kill switches ----
  if (riskPaused) return res.status(200).json({ success: false, blocked: true, reason: 'riskPaused active' });
  if (typeof lossStreak === 'number' && lossStreak >= 5) {
    return res.status(200).json({ success: false, blocked: true, reason: 'lossStreak >= 5' });
  }

  // ---- HARD LONG/SHORT STRUCTURE VALIDATION ----
  const entryPrice = entry;
  const sl = stopLoss;
  const tp = takeProfit || null;

  if (direction === 'LONG') {
    if (sl >= entryPrice) {
      const msg = 'LONG rejected: stopLoss ' + sl + ' must be < entry ' + entryPrice;
      console.error('[EXECUTE] ' + msg);
      return res.status(200).json({ success: false, blocked: true, reason: msg });
    }
    if (tp && tp <= entryPrice) {
      const msg = 'LONG rejected: takeProfit ' + tp + ' must be > entry ' + entryPrice;
      console.error('[EXECUTE] ' + msg);
      return res.status(200).json({ success: false, blocked: true, reason: msg });
    }
  } else {
    if (sl <= entryPrice) {
      const msg = 'SHORT rejected: stopLoss ' + sl + ' must be > entry ' + entryPrice;
      console.error('[EXECUTE] ' + msg);
      return res.status(200).json({ success: false, blocked: true, reason: msg });
    }
    if (tp && tp >= entryPrice) {
      const msg = 'SHORT rejected: takeProfit ' + tp + ' must be < entry ' + entryPrice;
      console.error('[EXECUTE] ' + msg);
      return res.status(200).json({ success: false, blocked: true, reason: msg });
    }
  }

  const maxLot  = getMaxLot(instrument);
  const safeVol = Math.max(0.01, Math.min(maxLot, Math.round(volume / 0.01) * 0.01));

  // ---- Broker symbol resolution ----
  const baseSym = instrument.toUpperCase().replace('.S', '').replace('.PRO', '').trim();
  const candidates = [];

  let redis = null;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const cached = safe(await redis.get('v9:sym:' + baseSym).catch(() => null));
      if (cached && typeof cached === 'string') candidates.push(cached);
    }
  } catch (_) {}

  if (instrument !== baseSym && !candidates.includes(instrument)) candidates.unshift(instrument);
  for (const s of [baseSym + '.s', baseSym + '.pro', baseSym + '.S', baseSym + '.PRO', baseSym]) {
    if (!candidates.includes(s)) candidates.push(s);
  }

  const orderType = direction === 'LONG' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
  console.log('[EXECUTE] ' + direction + ' ' + orderType + ' vol=' + safeVol + ' sl=' + sl + ' tp=' + tp + ' candidates=', candidates);

  let lastErr = null;
  let lastStatus = null;
  let lastResponse = null;
  let success = null;

  for (const trySym of candidates) {
    const orderBody = {
      actionType: orderType,
      symbol:     trySym,
      volume:     safeVol,
      stopLoss:   parseFloat(sl.toFixed(priceDp(sl))),
      comment:    (comment || 'QB:V9').slice(0, 32),
    };
    if (tp) orderBody.takeProfit = parseFloat(tp.toFixed(priceDp(tp)));

    try {
      console.log('[EXECUTE] POST ' + trySym + ' ' + JSON.stringify(orderBody));
      const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify(orderBody) });
      const d = await r.json().catch(() => ({}));
      lastStatus = r.status; lastResponse = d;
      console.log('[EXECUTE] RESP ' + r.status + ' ' + JSON.stringify(d).slice(0, 400));

      if (r.ok && !d.error && (d.orderId || d.positionId)) {
        success = { d, trySym };
        if (redis) { try { await redis.set('v9:sym:' + baseSym, JSON.stringify(trySym)); } catch (_) {} }
        break;
      }
      lastErr = d.message || d.error || ('HTTP ' + r.status);
      const looksLikeSymbolErr = (lastErr || '').toLowerCase().match(/symbol|not.?found|invalid.?symbol|unknown/);
      if (!looksLikeSymbolErr) break;
    } catch (e) { lastErr = e.message; console.error('[EXECUTE] throw ' + e.message); break; }
  }

  if (!success) {
    console.error('[EXECUTE] FAILED ' + direction + ' ' + instrument + ' err=' + lastErr + ' status=' + lastStatus + ' tried=', candidates);
    await tg(
      '❌ <b>Trade FAILED · ' + instrument + '</b>\n\n' +
      '<pre>' +
      'Direction:  ' + direction + '\n' +
      'Volume:     ' + safeVol + 'L\n' +
      'Entry:      ' + entryPrice + '\n' +
      'SL:         ' + sl + (tp ? '\nTP:         ' + tp : '') + '\n' +
      '──────────────────\n' +
      'Reason:     ' + (lastErr || 'unknown').slice(0, 80) + '\n' +
      'Status:     ' + lastStatus +
      '</pre>'
    );
    return res.status(200).json({
      success:    false,
      error:      lastErr || 'All symbol candidates failed',
      httpStatus: lastStatus,
      brokerResp: lastResponse,
      tried:      candidates,
      direction,
    });
  }

  const { d, trySym } = success;
  const positionId = d.positionId || null;
  const orderId    = d.orderId    || null;
  console.log('[EXECUTE] OK ' + trySym + ' ' + direction + ' ' + safeVol + 'L orderId=' + orderId + ' positionId=' + positionId);

  // ---- Verify broker actually attached SL/TP by fetching position back ----
  // V9.6: If SL is missing after open, retry up to 2x. If still missing,
  // emergency close to prevent unbounded risk.
  let verified = { slSet: false, tpSet: false, fillPrice: null };
  if (positionId) {
    let attempt = 0;
    while (attempt < 3) {
      attempt++;
      try {
        await new Promise(r => setTimeout(r, 500 * attempt));
        const pr = await fetch(BASE + '/positions', { headers: HEADERS });
        if (pr.ok) {
          const posList = await pr.json().catch(() => []);
          const pos = Array.isArray(posList) ? posList.find(p => String(p.id) === String(positionId)) : null;
          if (pos) {
            verified = {
              slSet:     pos.stopLoss != null && pos.stopLoss > 0,
              tpSet:     pos.takeProfit != null && pos.takeProfit > 0,
              fillPrice: pos.openPrice || null,
              brokerSL:  pos.stopLoss  || null,
              brokerTP:  pos.takeProfit || null,
            };
            console.log('[EXECUTE] VERIFY attempt=' + attempt + ' positionId=' + positionId + ' slSet=' + verified.slSet + ' tpSet=' + verified.tpSet + ' fill=' + verified.fillPrice);

            // V9.6: Critical -- if SL is missing, RETRY attaching it
            if (!verified.slSet) {
              console.warn('[EXECUTE] SL not attached on attempt ' + attempt + ', retrying modify');
              const modifyBody = {
                actionType: 'POSITION_MODIFY',
                positionId,
                stopLoss: parseFloat(sl.toFixed(priceDp(sl))),
              };
              if (tp) modifyBody.takeProfit = parseFloat(tp.toFixed(priceDp(tp)));
              try {
                const mr = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify(modifyBody) });
                const md = await mr.json().catch(() => ({}));
                console.log('[EXECUTE] SL retry resp=' + mr.status + ' ' + JSON.stringify(md).slice(0, 200));
                if (mr.ok && !md.error) continue; // re-verify on next attempt
              } catch (e) { console.error('[EXECUTE] SL retry throw ' + e.message); }
            } else {
              break; // SL is attached, we're done
            }
          } else {
            console.warn('[EXECUTE] VERIFY: position ' + positionId + ' not found yet (attempt ' + attempt + ')');
          }
        }
      } catch (e) { console.warn('[EXECUTE] VERIFY error ' + e.message); }
    }

    // V9.6: If SL STILL not attached after retries, emergency close to prevent unbounded risk
    if (!verified.slSet) {
      console.error('[EXECUTE] SL FAILED to attach after retries, emergency closing positionId=' + positionId);
      try {
        const cr = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId, comment: 'QB:NO_SL_FAILSAFE' }) });
        const cd = await cr.json().catch(() => ({}));
        console.log('[EXECUTE] FAILSAFE close resp=' + cr.status + ' ' + JSON.stringify(cd).slice(0, 200));
      } catch (e) { console.error('[EXECUTE] FAILSAFE close throw ' + e.message); }
      await tg(
        '🚨 <b>Trade closed FAILSAFE · ' + (trySym || instrument) + '</b>\n\n' +
        '<pre>' +
        'Broker rejected SL attachment.\n' +
        'Position closed immediately to prevent unbounded loss.\n' +
        '──────────────────\n' +
        'Direction: ' + direction + '\n' +
        'Volume:    ' + safeVol + 'L\n' +
        'Entry:     ' + entryPrice +
        '</pre>'
      );
      return res.status(200).json({
        success:  false,
        blocked:  true,
        positionId,
        reason:   'SL failed to attach -- position emergency closed',
        verified,
      });
    }
  }

  // ---- Telegram: brief notification on open. Full TP ladder shown after
  // post-fill correction (see /api/manage-trades correctTPs). ----
  const dp = priceDp(entryPrice);
  const icon = direction === 'LONG' ? '🟢' : '🔴';
  const strategy = (comment || '').replace('QB:', '') || 'V9';
  const tgResult = await tg(
    icon + ' <b>' + direction + ' · ' + (trySym || instrument) + ' · ' + safeVol + 'L</b>\n\n' +
    '<pre>' +
    'Entry:  ' + entryPrice.toFixed(dp) +
      (verified.fillPrice ? '\nFill:   ' + verified.fillPrice.toFixed(dp) : '') + '\n' +
    'Strat:  ' + strategy.slice(0, 24) +
    '</pre>\n' +
    '<i>Placing TP ladder...</i>'
  );
  if (!tgResult.ok) {
    console.error('[EXECUTE] Telegram open notification FAILED: ' + JSON.stringify(tgResult));
  }

  return res.status(200).json({
    success:    true,
    orderId,
    positionId,
    instrument: trySym,
    direction,
    volume:     safeVol,
    stopLoss:   sl,
    takeProfit: tp,
    comment:    (comment || 'QB:V9').slice(0, 32),
    verified,
    tgOk:       tgResult.ok,
  });
};