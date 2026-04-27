/* eslint-disable */
// api/manage-trades.js -- Quantum Bot V9.3
// Changes vs V9.2:
//   - Consolidated endpoints (12-file Vercel limit): news, calendar, telegram-test
//   - All Telegram errors logged visibly
//   - POSITION_MODIFY results checked
//   - Instruments stay fully open (no hardcoding anywhere)

const { Redis } = require('@upstash/redis');

const BASE = 'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + (process.env.METAAPI_ACCOUNT_ID || '');
const HEADERS = { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN || '' };

const safe = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };

// ---- Telegram ----
const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const tg = async (msg) => {
  if (!TG_TOKEN || !TG_CHAT) { console.warn('[TG] disabled: missing env vars'); return { ok: false, reason: 'missing env vars' }; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { console.error('[TG] FAIL ' + r.status + ' ' + JSON.stringify(d).slice(0, 200)); return { ok: false, status: r.status, resp: d }; }
    return { ok: true };
  } catch (e) { console.error('[TG] throw ' + e.message); return { ok: false, error: e.message }; }
};

// ---- Broker modify ----
const modifyPosition = async (positionId, stopLoss, takeProfit, comment) => {
  const dp = (p) => (p > 100 ? 2 : 5);
  const modBody = { actionType: 'POSITION_MODIFY', positionId };
  if (stopLoss   != null) modBody.stopLoss   = parseFloat(stopLoss.toFixed(dp(stopLoss)));
  if (takeProfit != null) modBody.takeProfit = parseFloat(takeProfit.toFixed(dp(takeProfit)));
  if (comment) modBody.comment = comment;
  try {
    const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify(modBody) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) { console.error('[MODIFY] FAIL positionId=' + positionId + ' status=' + r.status + ' ' + JSON.stringify(d).slice(0, 300)); return { ok: false, status: r.status, resp: d }; }
    console.log('[MODIFY] OK positionId=' + positionId + ' sl=' + modBody.stopLoss + ' tp=' + modBody.takeProfit);
    return { ok: true, resp: d };
  } catch (e) { console.error('[MODIFY] throw ' + e.message); return { ok: false, error: e.message }; }
};

const getPipMult = (sym) => {
  const s = (sym || '').toUpperCase();
  if (s.includes('BTC') || s.includes('ETH')) return 1;
  if (s.includes('XAU') || s.includes('GOLD')) return 100;
  return 100000;
};
const priceDp = (price) => (price > 100 ? 2 : 5);

// ---- ForexFactory calendar (cached) ----
let _ffCache = { data: null, ts: 0 };
const FF_TTL_MS = 30 * 60 * 1000;
const fetchFFCalendar = async () => {
  const now = Date.now();
  if (_ffCache.data && (now - _ffCache.ts) < FF_TTL_MS) return _ffCache.data;
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!r.ok) return _ffCache.data || [];
    const d = await r.json();
    if (Array.isArray(d)) { _ffCache = { data: d, ts: now }; return d; }
  } catch (_) {}
  return _ffCache.data || [];
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}
  }
  const action = body.action || (req.query && req.query.action) || null;

  // ========================================================================
  // ?action=telegram-test
  // ========================================================================
  if (action === 'telegram-test') {
    console.log('[TG-TEST] invoked');
    const r = await tg('✅ <b>Quantum Bot V9.4</b>\n\n<pre>Telegram connection test successful.\nNotifications are active.</pre>');
    return res.status(200).json({
      ok: r.ok, result: r,
      envCheck: {
        TELEGRAM_TOKEN:     !!process.env.TELEGRAM_TOKEN,
        TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID:   !!process.env.TELEGRAM_CHAT_ID,
      },
    });
  }

  // ========================================================================
  // ?action=cleanup-legacy
  // One-shot wipe of keys left behind by the old broken cron (fake trades,
  // hardcoded BTC/GBP/XAU price history, leftover cooldowns).
  // Safe to run multiple times. Does NOT touch v9:* namespace.
  // ========================================================================
  if (action === 'cleanup-legacy') {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(500).json({ error: 'Missing Redis env vars' });
    }
    const r = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const deleted = { prices: 0, cooldowns: 0, fakeTrades: 0 };
    try {
      const priceKeys = await r.keys('prices:*').catch(() => []);
      for (const k of priceKeys) { await r.del(k); deleted.prices++; }
      const cdKeys = await r.keys('lastCronTrade:*').catch(() => []);
      for (const k of cdKeys) { await r.del(k); deleted.cooldowns++; }
      const tradesLen = await r.llen('trades').catch(() => 0);
      if (tradesLen > 0) { await r.del('trades'); deleted.fakeTrades = tradesLen; }
      console.log('[CLEANUP] legacy keys deleted: ' + JSON.stringify(deleted));
      return res.status(200).json({ ok: true, deleted });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ========================================================================
  // ?action=redis-audit
  // Count all keys grouped by namespace so you can see what's polluting Redis.
  // Uses ONE keys("*") call to stay cheap. No deletion.
  // ========================================================================
  if (action === 'redis-audit') {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(500).json({ error: 'Missing Redis env vars' });
    }
    const r = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    try {
      const allKeys = await r.keys('*').catch(() => []);
      const buckets = {};
      for (const k of allKeys) {
        const parts = k.split(':');
        const bucket = parts.length >= 2 ? parts[0] + ':' + parts[1] : parts[0];
        buckets[bucket] = (buckets[bucket] || 0) + 1;
      }
      const classified = { current_v9: 0, legacy: 0, legacy_buckets: {}, v9_buckets: {} };
      for (const [bucket, count] of Object.entries(buckets)) {
        if (bucket.startsWith('v9:')) {
          classified.current_v9 += count;
          classified.v9_buckets[bucket] = count;
        } else {
          classified.legacy += count;
          classified.legacy_buckets[bucket] = count;
        }
      }
      return res.status(200).json({
        totalKeys: allKeys.length,
        buckets,
        classified,
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ========================================================================
  // ?action=redis-export
  // Export ALL v9:* keys as JSON so you can migrate to a new Redis database
  // without losing strategy lab history, crowns, blacklists, etc.
  //
  // Usage:
  //   Invoke-RestMethod -Uri ".../api/manage-trades?action=redis-export" -Method POST |
  //     ConvertTo-Json -Depth 20 | Out-File -Encoding utf8 redis-backup.json
  //
  // Only exports v9:* keys (current namespace). Skips legacy junk.
  // Handles 3 Redis data types: string, list, set. If you have other types,
  // the response will flag them.
  // ========================================================================
  if (action === 'redis-export') {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(500).json({ error: 'Missing Redis env vars' });
    }
    const r = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    try {
      const keys = await r.keys('v9:*').catch(() => []);
      const data = {};
      const stats = { strings: 0, lists: 0, sets: 0, hashes: 0, unknown: 0, errors: [] };

      for (const k of keys) {
        try {
          const type = await r.type(k).catch(() => 'unknown');
          if (type === 'string') {
            const v = await r.get(k);
            data[k] = { type: 'string', value: v };
            stats.strings++;
          } else if (type === 'list') {
            const v = await r.lrange(k, 0, -1);
            data[k] = { type: 'list', value: v };
            stats.lists++;
          } else if (type === 'set') {
            const v = await r.smembers(k);
            data[k] = { type: 'set', value: v };
            stats.sets++;
          } else if (type === 'hash') {
            const v = await r.hgetall(k);
            data[k] = { type: 'hash', value: v };
            stats.hashes++;
          } else {
            stats.unknown++;
            stats.errors.push({ key: k, type });
          }
        } catch (e) {
          stats.errors.push({ key: k, error: e.message });
        }
      }

      return res.status(200).json({
        ok:        true,
        exportedAt: new Date().toISOString(),
        keyCount:  keys.length,
        stats,
        data,
        note:      'Save this entire JSON response. Use action=redis-import to restore into a new Upstash DB.',
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ========================================================================
  // ?action=redis-import
  // Restore data from a previous redis-export into the CURRENT Redis.
  // This is what you run AFTER switching Vercel env vars to the new Upstash DB.
  //
  // Usage:
  //   $backup = Get-Content redis-backup.json | ConvertFrom-Json
  //   $body = @{ action="redis-import"; confirm="YES_IMPORT"; data=$backup.data } | ConvertTo-Json -Depth 20
  //   Invoke-RestMethod -Uri ".../api/manage-trades" -Method POST -Body $body -ContentType "application/json"
  //
  // REQUIRES body: { "action":"redis-import", "confirm":"YES_IMPORT", "data":{...} }
  // ========================================================================
  if (action === 'redis-import') {
    if (body.confirm !== 'YES_IMPORT') {
      return res.status(400).json({
        error:  'Missing confirmation',
        needed: 'POST body must include "confirm": "YES_IMPORT" and "data": {...}',
      });
    }
    if (!body.data || typeof body.data !== 'object') {
      return res.status(400).json({ error: 'Missing data object in POST body' });
    }
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(500).json({ error: 'Missing Redis env vars' });
    }
    const r = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const stats = { strings: 0, lists: 0, sets: 0, hashes: 0, errors: [] };

    try {
      for (const [key, entry] of Object.entries(body.data)) {
        try {
          if (entry.type === 'string') {
            await r.set(key, entry.value);
            stats.strings++;
          } else if (entry.type === 'list' && Array.isArray(entry.value)) {
            // Delete existing key first, then push in order
            await r.del(key).catch(() => {});
            if (entry.value.length > 0) {
              // rpush preserves order (lpush would reverse it)
              await r.rpush(key, ...entry.value);
            }
            stats.lists++;
          } else if (entry.type === 'set' && Array.isArray(entry.value)) {
            await r.del(key).catch(() => {});
            if (entry.value.length > 0) {
              await r.sadd(key, ...entry.value);
            }
            stats.sets++;
          } else if (entry.type === 'hash' && entry.value && typeof entry.value === 'object') {
            await r.del(key).catch(() => {});
            const flat = [];
            for (const [f, v] of Object.entries(entry.value)) { flat.push(f, v); }
            if (flat.length > 0) {
              await r.hset(key, entry.value);
            }
            stats.hashes++;
          } else {
            stats.errors.push({ key, reason: 'unknown type ' + entry.type });
          }
        } catch (e) {
          stats.errors.push({ key, error: e.message });
        }
      }
      return res.status(200).json({ ok: true, imported: Object.keys(body.data).length, stats });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ========================================================================
  // ?action=backfill-history
  // One-shot recovery: scan recent /api/history closed trades and record
  // each into the strategy lab. Use this after deploying V9.5 cron to
  // recover trades that closed while only the cron was running (no browser).
  //
  // Optional body params:
  //   "days":   how many days back to scan (default 2)
  //   "dryRun": true => report what WOULD be recorded without writing
  //
  // Idempotent: skips trades that look already-recorded by checking the
  // strategy's stored trade history for matching positionId/closeTime.
  // ========================================================================
  if (action === 'backfill-history') {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(500).json({ error: 'Missing Redis env vars' });
    }
    const r = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const days = parseInt(body.days || 2, 10);
    const dryRun = body.dryRun === true;

    // Build self URL for fetching history
    const selfBase = process.env.QB_PUBLIC_URL
      ? process.env.QB_PUBLIC_URL.replace(/\/$/, '')
      : (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '');
    if (!selfBase) return res.status(500).json({ error: 'Missing QB_PUBLIC_URL' });

    try {
      const histUrl = selfBase + '/api/history?limit=500';
      const hR = await fetch(histUrl);
      if (!hR.ok) {
        const errText = await hR.text().catch(() => '');
        return res.status(502).json({ error: 'history fetch failed: ' + hR.status, url: histUrl, body: errText.slice(0, 500) });
      }
      const hD = await hR.json();
      const trades = Array.isArray(hD.trades) ? hD.trades
                   : Array.isArray(hD.deals) ? hD.deals
                   : Array.isArray(hD) ? hD
                   : [];

      // Diagnostic: if no trades, return what we got
      if (trades.length === 0) {
        return res.status(200).json({
          scanned: 0, eligible: 0, recorded: 0, skipped: [], wouldRecord: [],
          DIAG: {
            url: histUrl,
            keys_in_response: Object.keys(hD || {}),
            count_field: hD.count,
            source_field: hD.source,
            trades_field_type: typeof hD.trades,
            trades_field_isArray: Array.isArray(hD.trades),
            trades_field_length: Array.isArray(hD.trades) ? hD.trades.length : null,
            sample: JSON.stringify(hD).slice(0, 500),
          },
        });
      }

      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const recent = trades.filter(t => {
        // MetaAPI returns 'time' as the close timestamp; fall back to other names
        const closeT = t.time || t.closeTime || t.closeDate || t.date || t.closeBrokerTime || t.brokerTime;
        if (!closeT) return false;
        const ts = new Date(closeT).getTime();
        return !isNaN(ts) && ts >= cutoff;
      });

      const result = { scanned: trades.length, eligible: recent.length, recorded: 0, skipped: [], wouldRecord: [] };

      for (const t of recent) {
        // Extract strategy from comment (QB:STRATNAME format)
        const comment = t.comment || t.tradeComment || '';
        const strategy = comment.startsWith('QB:') ? comment.slice(3).trim() : null;
        if (!strategy || strategy === 'EXPLORING' || strategy === 'UNKNOWN' || strategy.length < 3) {
          result.skipped.push({ id: t.positionId || t.id, reason: 'no strategy label', comment });
          continue;
        }

        const inst = (t.symbol || '').toUpperCase().replace('.S', '').replace('.PRO', '').trim();
        if (!inst) { result.skipped.push({ id: t.positionId || t.id, reason: 'no symbol' }); continue; }

        const pnl = t.profit != null ? t.profit : (t.pnl || 0);
        const direction = t.type === 'POSITION_TYPE_BUY' || t.direction === 'LONG' ? 'LONG' : 'SHORT';
        const closeTime = t.time || t.closeTime || t.closeDate || t.date || new Date().toISOString();
        const positionId = t.positionId || t.id || null;

        // Idempotency: check if this positionId already exists in the strategy's recorded trades
        const stratKey = 'v9:strat:' + inst + ':' + strategy;
        const existingRaw = safe(await r.get(stratKey).catch(() => null));
        if (existingRaw && Array.isArray(existingRaw.trades)) {
          const dup = existingRaw.trades.some(x => x.positionId && positionId && String(x.positionId) === String(positionId));
          if (dup) { result.skipped.push({ id: positionId, reason: 'already recorded' }); continue; }
        }

        // Determine session from close time
        const closeDt = new Date(closeTime);
        const hr = closeDt.getUTCHours() + closeDt.getUTCMinutes() / 60;
        const session = (hr >= 13 && hr < 16) ? 'OVERLAP'
                      : (hr >= 13 && hr < 21) ? 'NEW YORK'
                      : (hr >=  8 && hr < 16) ? 'LONDON'
                      : 'ASIAN';

        const payload = {
          instrument: inst,
          direction,
          won: pnl > 0,
          pnl,
          strategy,
          session,
          confidence: 0,
          closeTime,
          openPrice:  t.openPrice  || null,
          closePrice: t.closePrice || null,
          volume:     t.volume     || 0.01,
          positionId,
        };

        if (dryRun) {
          result.wouldRecord.push({ id: positionId, strategy, inst, pnl, session });
          continue;
        }

        try {
          const recR = await fetch(selfBase + '/api/trades', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (recR.ok) {
            result.recorded++;
          } else {
            result.skipped.push({ id: positionId, reason: 'POST failed ' + recR.status });
          }
        } catch (e) {
          result.skipped.push({ id: positionId, reason: 'POST throw: ' + e.message });
        }
      }

      console.log('[BACKFILL] scanned=' + result.scanned + ' eligible=' + result.eligible + ' recorded=' + result.recorded + ' skipped=' + result.skipped.length + (dryRun ? ' [DRY RUN]' : ''));
      return res.status(200).json(result);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ========================================================================
  // ?action=news  or  ?action=calendar
  // Returns ForexFactory economic calendar events (high impact only by default).
  // Optional query params: ?impact=high|medium|all  &days=7
  // ========================================================================
  if (action === 'news' || action === 'calendar') {
    const impact = (req.query && req.query.impact) || 'high';
    const days   = parseInt((req.query && req.query.days) || '7', 10);
    const cal = await fetchFFCalendar();
    const now = Date.now();
    const horizon = now + days * 24 * 60 * 60 * 1000;
    const events = (cal || [])
      .filter(ev => ev && ev.date && ev.country)
      .filter(ev => {
        const t = new Date(ev.date).getTime();
        return !isNaN(t) && t >= now - 24*60*60*1000 && t <= horizon;
      })
      .filter(ev => {
        if (impact === 'all') return true;
        if (impact === 'high') return ev.impact === 'High';
        if (impact === 'medium') return ev.impact === 'High' || ev.impact === 'Medium';
        return true;
      })
      .map(ev => ({
        name:       ev.title || ev.event || 'Event',
        date:       ev.date,
        country:    ev.country,
        importance: (ev.impact || 'Low').toLowerCase(),
        actual:     ev.actual ?? null,
        forecast:   ev.forecast ?? null,
        previous:   ev.previous ?? null,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    return res.status(200).json({ events, count: events.length, source: 'forexfactory' });
  }

  // ========================================================================
  // The remaining actions need Redis
  // ========================================================================
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(500).json({ error: 'Missing Redis env vars' });
  }
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  // ========================================================================
  // Post-fill TP correction (broker-verified)
  // ========================================================================
  if (req.method === 'POST' && body.correctTPs) {
    const { positionId, instrument, direction, fillPrice, tp1, tp2, tp3, tp4, sl } = body.correctTPs;
    if (!positionId || !fillPrice) return res.status(400).json({ error: 'correctTPs requires positionId and fillPrice' });

    if (direction === 'LONG') {
      if (sl && sl >= fillPrice) return res.status(200).json({ corrected: false, error: 'LONG SL must be below fillPrice' });
      if (tp1 && tp1 <= fillPrice) return res.status(200).json({ corrected: false, error: 'LONG TPs must be above fillPrice' });
    } else if (direction === 'SHORT') {
      if (sl && sl <= fillPrice) return res.status(200).json({ corrected: false, error: 'SHORT SL must be above fillPrice' });
      if (tp1 && tp1 >= fillPrice) return res.status(200).json({ corrected: false, error: 'SHORT TPs must be below fillPrice' });
    }

    const finalTP = tp4 || tp3 || tp2 || tp1;

    // V9.4: Check if broker already has acceptable SL/TP. If so, skip modify entirely
    // (this fixes the false "TP correction FAILED" notifications when execute.js
    // already set fine values and our recalculated values are basically identical).
    let needsModify = true;
    let brokerSL = null, brokerTP = null;
    try {
      const pr = await fetch(BASE + '/positions', { headers: HEADERS });
      if (pr.ok) {
        const posList = await pr.json().catch(() => []);
        const pos = Array.isArray(posList) ? posList.find(p => String(p.id) === String(positionId)) : null;
        if (pos) {
          brokerSL = pos.stopLoss || null;
          brokerTP = pos.takeProfit || null;
          // Tolerance: within 0.5% = already correct
          const within = (a, b) => {
            if (!a || !b) return false;
            return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-6) < 0.005;
          };
          const slOK = sl == null || within(brokerSL, sl);
          const tpOK = finalTP == null || within(brokerTP, finalTP);
          if (slOK && tpOK) {
            needsModify = false;
            console.log('[CORRECT] positionId=' + positionId + ' broker already has acceptable SL/TP, skipping modify');
          }
        }
      }
    } catch (_) {}

    let modResult = { ok: true, skipped: !needsModify };
    if (needsModify) {
      modResult = await modifyPosition(positionId, sl, finalTP, 'QB:FILL_CORRECT');
    }

    const stateKey = 'v9:tp:' + positionId;
    const existing = safe(await redis.get(stateKey).catch(() => null)) || {};
    await redis.set(stateKey, JSON.stringify({
      ...existing, tp1, tp2, tp3, tp4, sl,
      fillCorrected: modResult.ok, instrument, direction, fillPrice,
      openTs: Date.now(),
      modifyError: modResult.ok ? null : (modResult.resp || modResult.error || 'unknown'),
    }), { ex: 86400 * 7 });

    // V9.4: Clean structured Telegram notification with ALL TPs shown
    if (modResult.ok) {
      const dp = priceDp(fillPrice);
      const dir = direction || '?';
      const icon = dir === 'LONG' ? '🟢' : '🔴';
      const arrow = dir === 'LONG' ? '↑' : '↓';
      const pad = (v, w = 10) => String(v).padStart(w);
      const fmt = (v) => v != null ? Number(v).toFixed(dp) : '—';
      const lines = [
        icon + ' <b>' + dir + ' · ' + (instrument || positionId) + '</b>',
        '',
        '<pre>',
        'Fill:  ' + pad(fmt(fillPrice)),
        '──────────────────',
        'SL:    ' + pad(fmt(sl)) + '  ' + arrow,
        'TP1:   ' + pad(fmt(tp1)),
        tp2 ? 'TP2:   ' + pad(fmt(tp2)) : null,
        tp3 ? 'TP3:   ' + pad(fmt(tp3)) : null,
        tp4 ? 'TP4:   ' + pad(fmt(tp4)) : null,
        '</pre>',
        modResult.skipped ? '<i>Levels already set by broker</i>' : '<i>Levels confirmed on broker</i>',
      ].filter(Boolean);
      await tg(lines.join('\n'));
    } else {
      // Real failure: show what went wrong
      const errMsg = modResult.resp && modResult.resp.message ? modResult.resp.message : (modResult.error || 'unknown');
      await tg(
        '⚠️ <b>TP setup issue · ' + (instrument || positionId) + '</b>\n\n' +
        '<pre>' +
        'Error: ' + errMsg + '\n' +
        (brokerSL ? 'Broker SL: ' + brokerSL.toFixed(priceDp(brokerSL)) + '\n' : '') +
        (brokerTP ? 'Broker TP: ' + brokerTP.toFixed(priceDp(brokerTP)) + '\n' : '') +
        '</pre>\n' +
        '<i>Trade is still active with original broker SL/TP</i>'
      );
    }
    return res.status(200).json({ corrected: modResult.ok, skipped: modResult.skipped, positionId, modifyResult: modResult });
  }

  // ========================================================================
  // Manage open positions (TP ladder + retrace)
  // ========================================================================
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only for management' });
  const { positions } = body;
  if (!Array.isArray(positions) || positions.length === 0) return res.status(200).json({ managed: [], message: 'No positions to manage' });

  const managed = [];
  for (const pos of positions) {
    const { id, symbol, openPrice, currentPrice, stopLoss, volume, direction, tp1, tp2, tp3, tp4 } = pos;
    if (!id || !currentPrice || !openPrice || !tp1) continue;
    const result = { id, symbol, actions: [] };

    try {
      const stateKey = 'v9:tp:' + id;
      const stateRaw = safe(await redis.get(stateKey).catch(() => null));
      let state = (stateRaw && typeof stateRaw === 'object') ? stateRaw : { tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false, openTs: Date.now() };

      const fTP1 = state.tp1 || tp1;
      const fTP2 = state.tp2 || tp2;
      const fTP3 = state.tp3 || tp3;
      const fTP4 = state.tp4 || tp4;

      const profit = direction === 'LONG' ? currentPrice - openPrice : openPrice - currentPrice;
      const d1 = Math.abs(fTP1 - openPrice);
      const d2 = fTP2 ? Math.abs(fTP2 - openPrice) : null;
      const d3 = fTP3 ? Math.abs(fTP3 - openPrice) : null;
      const d4 = fTP4 ? Math.abs(fTP4 - openPrice) : null;
      const mult = getPipMult(symbol);
      const dp   = priceDp(currentPrice);

      const saveState = async (s) => { await redis.set(stateKey, JSON.stringify(s), { ex: 86400 * 7 }).catch(() => {}); };
      const closeFull = async (comment) => {
        try {
          const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: id, comment }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) { console.error('[CLOSE_FULL] FAIL ' + r.status + ' ' + JSON.stringify(d).slice(0, 200)); return false; }
          return !!(d.orderId || d.positionId);
        } catch (e) { console.error('[CLOSE_FULL] throw ' + e.message); return false; }
      };
      const closePartial = async (pct, comment) => {
        const vol = Math.max(0.01, Math.round((volume * pct) / 0.01) * 0.01);
        const pnl = parseFloat((profit * vol * mult).toFixed(2));
        try {
          const r = await fetch(BASE + '/trade', { method: 'POST', headers: HEADERS, body: JSON.stringify({ actionType: 'POSITION_PARTIAL', positionId: id, volume: vol, comment }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) { console.error('[CLOSE_PARTIAL] FAIL ' + r.status + ' ' + JSON.stringify(d).slice(0, 200)); return { ok: false, vol, pnl }; }
          return { ok: !!(d.orderId || d.positionId), vol, pnl };
        } catch (e) { console.error('[CLOSE_PARTIAL] throw ' + e.message); return { ok: false, vol, pnl }; }
      };
      const modifySL = async (newSL, label) => {
        if (newSL == null) return { ok: false, reason: 'null SL' };
        // V9.6: Retry up to 3x with backoff. Broker may reject if SL too close to price,
        // network glitch, or rate limit. If price has retraced past the desired SL,
        // adjust to a safer level before retry.
        let lastResp = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          // For LONG: SL must be BELOW current price. For SHORT: ABOVE.
          // If desired SL is on the wrong side, fall back to entry (BE).
          let safeSL = newSL;
          if (direction === 'LONG'  && safeSL >= currentPrice) safeSL = Math.min(newSL, openPrice);
          if (direction === 'SHORT' && safeSL <= currentPrice) safeSL = Math.max(newSL, openPrice);
          // Final guard: if even BE is on wrong side, give up (emergency close will handle it)
          if (direction === 'LONG'  && safeSL >= currentPrice) return { ok: false, reason: 'price below desired SL' };
          if (direction === 'SHORT' && safeSL <= currentPrice) return { ok: false, reason: 'price above desired SL' };

          const r = await modifyPosition(id, safeSL, null, 'QB:' + (label || 'SL_TRAIL'));
          if (r.ok) return { ok: true, sl: safeSL };
          lastResp = r;
          console.warn('[SL_RETRY] ' + id + ' attempt ' + attempt + '/3 failed:', JSON.stringify(r).slice(0, 200));
          await new Promise(rs => setTimeout(rs, 400 * attempt));
        }
        return { ok: false, reason: 'all retries failed', lastResp };
      };

      // ---- V9.6: SELF-HEALING SL RECOVERY ----
      // If a previous tick fired TP1 but the SL move silently failed, the broker SL is still
      // at the original loss level. Detect this and retry. If retry fails too, emergency close.
      if (state.tp1Hit && !state.tp4Hit && !state.slMovedConfirmed) {
        const desiredSL = direction === 'LONG' ? openPrice + d1 * 0.3 : openPrice - d1 * 0.3;
        const slBad = direction === 'LONG' ? (stopLoss == null || stopLoss < openPrice) : (stopLoss == null || stopLoss > openPrice);
        if (slBad) {
          console.warn('[SELF_HEAL] ' + id + ' tp1Hit but SL not moved. broker SL=' + stopLoss + ' desired=' + desiredSL);
          const slr = await modifySL(desiredSL, 'TP1_HEAL');
          if (slr.ok) {
            state.slMovedConfirmed = true;
            await saveState(state);
            await tg('🔧 <b>SL recovered · ' + symbol + '</b>\n\n<pre>Previous SL move had failed.\nSL now at: ' + slr.sl.toFixed(dp) + '</pre>');
          } else {
            // SL still cannot be moved → close remainder immediately
            const pnl = parseFloat((profit * volume * mult).toFixed(2));
            const closed = await closeFull('QB:HEAL_FAILSAFE');
            if (closed) {
              state.tp4Hit = true;
              await redis.del(stateKey).catch(() => {});
              result.actions.push({ type: 'HEAL_FAILSAFE_CLOSE', price: currentPrice, pnl });
              await tg(
                '🚨 <b>FAILSAFE close · ' + symbol + '</b>\n\n' +
                '<pre>' +
                'Could not protect SL after TP1.\n' +
                '──────────────────\n' +
                'Closed:   remainder @ ' + currentPrice.toFixed(dp) + '\n' +
                'P&L:      ' + (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2) + '\n' +
                'Reason:   ' + (slr.reason || 'broker rejected SL') +
                '</pre>'
              );
              if (result.actions.length) managed.push(result);
              continue;
            }
          }
        } else {
          // SL is past entry already — mark confirmed so we stop checking
          state.slMovedConfirmed = true;
          await saveState(state);
        }
      }

      // ---- POST-TP1 PRE-TP2 RETRACE GUARD ----
      if (state.tp1Hit && !state.tp2Hit && !state.tp1RetraceClose) {
        const retracing = profit <= d1 * 0.25 && profit > 0;
        if (retracing) {
          const { ok, vol, pnl } = await closePartial(0.3, 'QB:T1_RETRACE');
          if (ok) {
            state.tp1RetraceClose = true;
            const tightSL = direction === 'LONG' ? openPrice + d1 * 0.15 : openPrice - d1 * 0.15;
            const slr = await modifySL(tightSL, 'RETRACE_TIGHT');
            result.actions.push({ type: 'TP1_RETRACE_PROTECT', volume: vol, price: currentPrice, pnl });

            if (slr.ok) {
              await saveState(state);
              await tg(
                '⚠️ <b>Retrace protect · ' + symbol + '</b>\n\n' +
                '<pre>' +
                'Price retraced toward entry after TP1.\n' +
                '──────────────────\n' +
                'Closed:  30% @ ' + currentPrice.toFixed(dp) + '\n' +
                'P&L:     ' + (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2) + '\n' +
                'SL:      tightened to ' + slr.sl.toFixed(priceDp(slr.sl)) +
                '</pre>'
              );
            } else {
              // V9.6: Tightened SL failed → close remainder. Already losing momentum.
              console.error('[RETRACE] SL tighten FAILED — closing remainder');
              const remainderPnl = parseFloat((profit * (volume - vol) * mult).toFixed(2));
              const closed = await closeFull('QB:RETRACE_FAILSAFE');
              if (closed) {
                state.tp4Hit = true;
                await redis.del(stateKey).catch(() => {});
                result.actions.push({ type: 'RETRACE_FAILSAFE_CLOSE', price: currentPrice, pnl: remainderPnl });
                await tg(
                  '🛡️ <b>Retrace · SL failed · ' + symbol + '</b>\n\n' +
                  '<pre>' +
                  'Could not tighten SL after retrace.\n' +
                  'Emergency-closed remainder.\n' +
                  '──────────────────\n' +
                  'Retrace P&L: ' + (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2) + '\n' +
                  'Remainder:   ' + (remainderPnl >= 0 ? '+$' : '-$') + Math.abs(remainderPnl).toFixed(2) +
                  '</pre>'
                );
              } else {
                await saveState(state);
              }
            }
          }
        }
      }

      // ---- TP2/TP3 retrace guard ----
      const retraceLevel = state.tp3Hit && !state.tp4Hit ? fTP3 : state.tp2Hit && !state.tp3Hit ? fTP2 : state.tp1Hit && !state.tp2Hit ? fTP1 : null;
      if (retraceLevel && state.tp1Hit) {
        const retraced = direction === 'LONG' ? currentPrice <= retraceLevel : currentPrice >= retraceLevel;
        if (retraced && state.tp2Hit) {
          const pnl = parseFloat((profit * volume * mult).toFixed(2));
          const closed = await closeFull('QB:RETRACE');
          if (closed) {
            const lbl = state.tp3Hit ? 'TP3' : 'TP2';
            result.actions.push({ type: 'RETRACE_CLOSE', price: currentPrice, pnl });
            state.tp4Hit = true;
            await redis.del(stateKey).catch(() => {});
            await tg(
              '🛡️ <b>Retrace protected · ' + symbol + '</b>\n\n' +
              '<pre>' +
              lbl + ' was hit, price retraced to protection.\n' +
              '──────────────────\n' +
              'Closed:   remainder @ ' + currentPrice.toFixed(dp) + '\n' +
              'P&L:      ' + (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2) +
              '</pre>'
            );
          }
          if (result.actions.length) managed.push(result);
          continue;
        }
      }

      // ---- TP1 ----
      if (!state.tp1Hit && profit >= d1 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.4, 'QB:TP1');
        if (ok) {
          state.tp1Hit = true;
          const beLevel = direction === 'LONG' ? openPrice + d1 * 0.3 : openPrice - d1 * 0.3;
          const slr = await modifySL(beLevel, 'TP1_BE');
          result.actions.push({ type: 'TP1', volume: vol, price: currentPrice, pnl });

          if (slr.ok) {
            state.slMovedConfirmed = true;
            await saveState(state);
            await tg(
              '🎯 <b>TP1 · ' + symbol + '</b>\n\n' +
              '<pre>' +
              direction + '\n' +
              '──────────────────\n' +
              'Closed:   40% @ ' + currentPrice.toFixed(dp) + '\n' +
              'P&L:      +$' + pnl.toFixed(2) + '\n' +
              'SL:       BE+ ' + slr.sl.toFixed(priceDp(slr.sl)) + '\n' +
              'Running:  60%' +
              '</pre>'
            );
          } else {
            // V9.6: SL move FAILED → emergency close remainder to lock TP1 profit
            console.error('[TP1] SL move FAILED after retries — closing remainder');
            const remainderPnl = parseFloat((profit * (volume - vol) * mult).toFixed(2));
            const closed = await closeFull('QB:TP1_FAILSAFE');
            if (closed) {
              state.tp4Hit = true;
              await redis.del(stateKey).catch(() => {});
              result.actions.push({ type: 'TP1_FAILSAFE_CLOSE', price: currentPrice, pnl: remainderPnl });
              await tg(
                '⚠️ <b>TP1 hit · SL failed · ' + symbol + '</b>\n\n' +
                '<pre>' +
                'TP1 hit but broker rejected SL move.\n' +
                'Emergency-closed remainder to lock profit.\n' +
                '──────────────────\n' +
                'TP1 P&L:    +$' + pnl.toFixed(2) + '\n' +
                'Remainder:  ' + (remainderPnl >= 0 ? '+$' : '-$') + Math.abs(remainderPnl).toFixed(2) + '\n' +
                'Total:      ' + ((pnl + remainderPnl) >= 0 ? '+$' : '-$') + Math.abs(pnl + remainderPnl).toFixed(2) + '\n' +
                'Reason:     ' + (slr.reason || 'broker rejected SL') +
                '</pre>'
              );
            } else {
              // Even close failed — save state, self-heal will try next tick
              await saveState(state);
              await tg('🚨 <b>CRITICAL · ' + symbol + '</b>\n\nTP1 hit, SL move failed, emergency close failed. Manual intervention may be required.');
            }
          }
        }
      }
      else if (state.tp1Hit && !state.tp2Hit && d2 && profit >= d2 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.3, 'QB:TP2');
        if (ok) {
          state.tp2Hit = true;
          const slr = fTP1 ? await modifySL(fTP1, 'TP2_TRAIL') : { ok: true, sl: null };
          result.actions.push({ type: 'TP2', volume: vol, price: currentPrice, pnl });

          if (slr.ok) {
            await saveState(state);
            await tg(
              '🎯 <b>TP2 · ' + symbol + '</b>\n\n' +
              '<pre>' +
              direction + '\n' +
              '──────────────────\n' +
              'Closed:   30% @ ' + currentPrice.toFixed(dp) + '\n' +
              'P&L:      +$' + pnl.toFixed(2) + '\n' +
              'SL:       TP1 ' + (fTP1||0).toFixed(priceDp(fTP1||0)) + '\n' +
              'Running:  30%' +
              '</pre>'
            );
          } else {
            // V9.6 failsafe: trail failed, close remainder
            const remainderPnl = parseFloat((profit * (volume - vol) * mult).toFixed(2));
            const closed = await closeFull('QB:TP2_FAILSAFE');
            if (closed) {
              state.tp4Hit = true;
              await redis.del(stateKey).catch(() => {});
              result.actions.push({ type: 'TP2_FAILSAFE_CLOSE', price: currentPrice, pnl: remainderPnl });
              await tg('⚠️ <b>TP2 · SL trail failed · ' + symbol + '</b>\n\n<pre>Closed remainder. TP2 P&L: +$' + pnl.toFixed(2) + ' | Remainder: ' + (remainderPnl >= 0 ? '+$' : '-$') + Math.abs(remainderPnl).toFixed(2) + '</pre>');
            } else {
              await saveState(state);
            }
          }
        }
      }
      else if (state.tp2Hit && !state.tp3Hit && d3 && profit >= d3 * 0.95) {
        const { ok, vol, pnl } = await closePartial(0.2, 'QB:TP3');
        if (ok) {
          state.tp3Hit = true;
          const slr = fTP2 ? await modifySL(fTP2, 'TP3_TRAIL') : { ok: true, sl: null };
          result.actions.push({ type: 'TP3', volume: vol, price: currentPrice, pnl });

          if (slr.ok) {
            await saveState(state);
            await tg(
              '🎯 <b>TP3 · ' + symbol + '</b>\n\n' +
              '<pre>' +
              direction + '\n' +
              '──────────────────\n' +
              'Closed:   20% @ ' + currentPrice.toFixed(dp) + '\n' +
              'P&L:      +$' + pnl.toFixed(2) + '\n' +
              'SL:       TP2 ' + (fTP2||0).toFixed(priceDp(fTP2||0)) + '\n' +
              'Running:  10%' +
              '</pre>'
            );
          } else {
            const remainderPnl = parseFloat((profit * (volume - vol) * mult).toFixed(2));
            const closed = await closeFull('QB:TP3_FAILSAFE');
            if (closed) {
              state.tp4Hit = true;
              await redis.del(stateKey).catch(() => {});
              result.actions.push({ type: 'TP3_FAILSAFE_CLOSE', price: currentPrice, pnl: remainderPnl });
              await tg('⚠️ <b>TP3 · SL trail failed · ' + symbol + '</b>\n\n<pre>Closed remainder. TP3 P&L: +$' + pnl.toFixed(2) + ' | Remainder: ' + (remainderPnl >= 0 ? '+$' : '-$') + Math.abs(remainderPnl).toFixed(2) + '</pre>');
            } else {
              await saveState(state);
            }
          }
        }
      }
      else if (state.tp3Hit && !state.tp4Hit && d4 && profit >= d4 * 0.95) {
        const pnl = parseFloat((profit * volume * 0.1 * mult).toFixed(2));
        const closed = await closeFull('QB:TP4');
        if (closed) {
          state.tp4Hit = true;
          result.actions.push({ type: 'TP4_FINAL', price: currentPrice, pnl });
          await redis.del(stateKey).catch(() => {});
          await tg(
            '🏆 <b>TP4 COMPLETE · ' + symbol + '</b>\n\n' +
            '<pre>' +
            'All targets achieved.\n' +
            '──────────────────\n' +
            'Final:   10% @ ' + currentPrice.toFixed(dp) + '\n' +
            'P&L:     +$' + pnl.toFixed(2) +
            '</pre>'
          );
        }
      }

      if (result.actions.length) managed.push(result);
    } catch (e) { console.error('[MANAGE] error for ' + id + ': ' + e.message); }
  }

  return res.status(200).json({ managed });
};