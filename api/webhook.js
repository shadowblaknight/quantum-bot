/* eslint-disable */
// api/webhook.js  (Pilot Dashboard v1.1 — manual mode routing)
//
// Adds: when decision.tradingMode === 'manual', writes setup to watched-setups
// for the cron to monitor + notifies user via Telegram. Does NOT place an order.
// Auto mode flow is unchanged.
// ----------------------------------------------------------------------------

const { getRedis, applyCors, roundToPipSize } = require('./_lib');
const { resolveSymbol } = require('./symbol-resolver');
const { fetchAccount, fetchPositions, fetchCandles } = require('./broker');
const { placeLimitOrder, placeMarketOrder } = require('./execute');
const { notifyTradePlaced, sendOnce } = require('./telegram');
const { getAssetById } = require('./asset-registry');
const { applyRulesToSignal, logActivity, getTodaysPnL } = require('./rules-store');
const { addWatchedSetup } = require('./watched-setups');
const { templateLabelMap, REACTION_TEMPLATES, SPECIALIST_SIGNALS, LEGACY_TEMPLATES } = require('./_templates');
const { evaluateReactionMTF, tfSetForMode } = require('./reaction-filter');
const { evaluateSignalQuality }             = require('./signal-quality');
const { checkKillZone }                     = require('./kill-zones');
const { notifySpecialistTradePlaced }       = require('./telegram');
const TEMPLATE_LABELS = templateLabelMap();

// ── V20 Specialist Mode ───────────────────────────────────────────────────────
// true  = only specialist signals accepted; ALL legacy templates are history
// false = legacy templates still active alongside specialists (pre-V20 behaviour)
const V20_SPECIALIST_MODE = true;

// Active sub-signals per specialist — API-level hard gate.
// If zoneType is NOT in this list the signal is silently dropped.
// Update here when a new confirmed signal is unlocked in a specialist Pine.
const SPECIALIST_ALLOWED_ZONES = {
  // All 8 confirmed sub-signals from qb-gold-specialist.pine:
  //   A=FVG  B=Asian-H/L (Judas)  C=SB-FVG  D=PSYCH  D2=PSYCH-EXT  M=FRB  H=NYORB
  'gold-specialist':   ['FRB', 'NYORB', 'FVG', 'Asian-H', 'Asian-L', 'SB-FVG', 'PSYCH', 'PSYCH-EXT'],
  // Gold Specialist 2 — H1 chart, 3 confirmed setups (A/B/D backtest: WR 55.4%, PF 1.27, 6yr)
  'gold-specialist-2': ['gold-s2-a', 'gold-s2-b', 'gold-s2-d'],
  'nas100-specialist': ['AMD-FVG'],        // Session Intel: Asian range → London sweep → ORB BOS → NY FVG entry (14:00–16:00 UTC)
  'gbpusd-specialist': ['SFP-L', 'SFP-H', 'AOI-D', 'AOI-W'], // Alex G: Asian SFP + Daily/Weekly AOI zones (London KZ + NY)
  'ger40-bg-specialist': ['B', 'G'], // Frankfurt ORB (B) + London 3-Phase FVG (G), Tue+Thu only
};

// v14: tick-rounding must NOT depend on _lib exporting roundToPipSize. If that
// import is ever undefined, calling it would throw mid-placement and silently
// drop EVERY auto-mode trade (skips bypass this path), which looks exactly like
// "signals deliver but never trade". Use the import when it's a real function,
// otherwise fall back to an identical local implementation.
const _roundTick = (typeof roundToPipSize === 'function')
  ? roundToPipSize
  : (value, step, mode) => {
      const s = (step && isFinite(step) && step > 0) ? step : 0.0001;
      const q = value / s;
      const r = mode === 'down' ? Math.floor(q) : mode === 'up' ? Math.ceil(q) : Math.round(q);
      const dec = Math.max(0, Math.min(10, ((String(s).split('.')[1]) || '').length));
      return parseFloat((r * s).toFixed(dec));
    };

const PINE_TO_ASSET = {
  XAUUSD: 'gold', GOLD: 'gold', XAUUSDPRO: 'gold',  // gold aliases (TVC:GOLD, broker PRO variant)
  EURUSD: 'eurusd', GBPUSD: 'gbpusd', USDJPY: 'usdjpy',
  // NAS100 aliases — NAS100.s (Spreadex) strips to NAS100S; NDQ was previously the feed symbol.
  NAS100: 'nas100', NAS100S: 'nas100', NDQ: 'nas100', US100: 'nas100', USTEC: 'nas100',
  NDX: 'nas100', USTECH: 'nas100', NASDAQ: 'nas100', NAS100M: 'nas100', USTECCASH: 'nas100',
  // SP500 aliases
  SP500: 'us500', US500: 'us500', SPX500: 'us500', SPX: 'us500',
  BTCUSD: 'btc', BTCUSDT: 'btc', BTCUSDC: 'btc',
  // GER40 aliases — GER40.s (Spreadex) strips to GER40S; others map directly
  GER40: 'ger40', GER40S: 'ger40', DE40: 'ger40', DAX: 'ger40', DAX40: 'ger40', GER40M: 'ger40',
};

const DEDUPE_PREFIX = 'v13:webhook:dedupe:';
const DEDUPE_TTL = 60 * 60;

// V20: specialists accepted; legacy templates still listed so stale TV alerts
// get a 200 (not a 400) and are silently classified as history.
const ACCEPTED_TEMPLATES = V20_SPECIALIST_MODE
  ? [...SPECIALIST_SIGNALS, ...LEGACY_TEMPLATES]
  : ['reaction','reaction-fvg','reaction-ifvg','reaction-ext','orb','orb-pro',
     'silver-bullet','unicorn','turtle-soup','judas-swing','ote-continuation',
     'am-ifvg','gold-fvg','gold-sb','frankfurt-orb','ny-orb',
     ...SPECIALIST_SIGNALS];

// V20: ALL legacy templates are history — silently accepted but never executed.
// Returns 200 with executed:false so TradingView does not retry.
const DISABLED_TEMPLATES = V20_SPECIALIST_MODE
  ? LEGACY_TEMPLATES
  : ['ote-continuation'];

// SB_IMMEDIATE_ONLY: when true, silver-bullet signals that route as retest
// (limit) entries are suppressed. Immediate (market) entries are unaffected.
// Set to false to restore silver-bullet retest entries.
const SB_IMMEDIATE_ONLY = true;

// REACTION_RETEST_BLOCK: reaction templates fire when price is AT the zone, so a
// pending limit either sits above market (→ INVALID_PRICE) or misses the move.
// Recognition memory drill: retest entries on reaction templates = 72% loss rate in
// the short-hold bucket (≤33 min). Explicit retest payloads (actualStyle='retest') are
// already converted to immediate in the sync handler; this catches pre-v15.7 fallthrough.
// Set to false to restore reaction retest (limit) entries.
const REACTION_RETEST_BLOCK = true;

// ── Per-template instrument blocklist ────────────────────────────────────────
// ORB bleeds on BTC and NAS100 (wide opening ranges → far stops → fakeouts).
// All other templates on those instruments remain fully active.
// To re-enable ORB on BTC/NAS100: remove the key or empty the array.
const TEMPLATE_INSTRUMENT_BLOCKS = {
  'orb': ['btc', 'nas100'],
};

// ── Session-open cooldown ─────────────────────────────────────────────────
// Recognition memory simulation: NY 13:30 open catches only losses (0W/4L).
// London 08:00 was removed — it blocked ORB/ORB-pro wins that are designed to
// fire at London open. NY-only window is safe but small; kept for now.
// To disable: set to 0.
const SESSION_OPEN_COOLDOWN_MINS = 0; // was 15 — dropped: blocks ORB/ORB-PRO which fire exactly at NY open

function _escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const BALANCE_CACHE_KEY = 'v13:account:balance';
async function getCapitalFast() {
  const r = getRedis();
  const account = await withTimeout(fetchAccount(), 2000, null);
  if (account && (account.balance || account.equity)) {
    const bal = account.balance || account.equity;
    if (r) { try { await r.set(BALANCE_CACHE_KEY, String(bal), { ex: 86400 }); } catch (_) {} }
    return bal;
  }
  if (r) {
    try { const raw = await r.get(BALANCE_CACHE_KEY); if (raw) return parseFloat(raw); }
    catch (_) {}
  }
  return 10000;
}

function isTradingEnabled() {
  return process.env.QB_TRADING_ENABLED === 'true';
}

function parseDualFormat(body) {
  if (!body) return { ok: false, error: 'empty body' };
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return { ok: true, payload: body };
  }
  const text = typeof body === 'string' ? body : String(body);
  const delimIdx = text.indexOf('\n---');
  if (delimIdx < 0) {
    try { return { ok: true, payload: JSON.parse(text.trim()) }; }
    catch (_) { return { ok: false, error: 'no --- delimiter and body is not JSON' }; }
  }
  const jsonPart = text.slice(delimIdx + 4).trim();
  try { return { ok: true, payload: JSON.parse(jsonPart) }; }
  catch (e) { return { ok: false, error: `JSON parse failed: ${e.message}` }; }
}

async function alreadyExecuted(dedupeKey) {
  if (!dedupeKey) return false;
  const r = getRedis();
  if (!r) return false;
  try { return (await r.get(DEDUPE_PREFIX + dedupeKey)) != null; }
  catch (e) { console.warn('[webhook] Redis dedupe check failed — dedupe disabled for this request:', e && e.message); return false; }
}

async function markExecuted(dedupeKey, info, ttlSeconds = DEDUPE_TTL) {
  const r = getRedis();
  if (!r || !dedupeKey) return;
  try { await r.set(DEDUPE_PREFIX + dedupeKey, JSON.stringify(info), { ex: ttlSeconds }); }
  catch (_) {}
}

async function skipWithReason({ res, dedupeKey, pineTicker, template, reason, extras = {}, notify = true }) {
  await logActivity({
    type: 'skip', asset: extras.assetId || null, template,
    direction: extras.direction || null, reason, ...extras,
  });
  if (notify) {
    try {
      await sendOnce(`skip:${dedupeKey || reason}`,
        `⚠️ <b>Signal SKIPPED — ${pineTicker || extras.assetId || ''}</b>\n\n` +
        (template ? `Template: ${template}\n` : '') +
        `Reason: <code>${reason}</code>`);
    } catch (_) {}
  }
  return res.status(200).json({ ok: true, executed: false, reason, ...extras });
}

// =====================================================================
// FAST-ACK REFACTOR (v1.2)
//   TradingView's webhook waits only a few seconds and does NOT retry. The
//   old flow placed the MetaAPI order INLINE before responding, so a slow
//   broker round-trip blew that budget -> "request took too long and timed
//   out", even though the order usually still placed late. Fix: validate just
//   enough to ACK TradingView instantly (sub-second), then run the heavy
//   pipeline (fetch, rules, place, notify) AFTER the response via waitUntil.
//   The broker latency no longer has TradingView waiting on it.
//   Behaviour (auto place, manual watch, skips, dedupe, Telegram) is identical
//   to v1.1 — only the response timing changed.
// =====================================================================

// Vercel's waitUntil keeps the function alive for post-response work. Optional:
// if '@vercel/functions' isn't installed we fall back to awaiting the pipeline
// (the async handler stays pending, so Node serverless keeps it alive anyway).
let _waitUntil = null;
try { ({ waitUntil: _waitUntil } = require('@vercel/functions')); } catch (_) {}

// Background skip = skipWithReason without res (used after the ACK).
async function bgSkip({ dedupeKey, pineTicker, template, reason, extras = {}, notify = true }) {
  await logActivity({
    type: 'skip', asset: extras.assetId || null, template,
    direction: extras.direction || null, reason, ...extras,
  });
  if (notify) {
    try {
      await sendOnce(`skip:${dedupeKey || reason}`,
        `\u26a0\ufe0f <b>Signal SKIPPED \u2014 ${pineTicker || extras.assetId || ''}</b>\n\n` +
        (template ? `Template: ${template}\n` : '') +
        `Reason: <code>${reason}</code>`);
    } catch (_) {}
  }
}

// The heavy pipeline. Runs AFTER TradingView has been acked. NEVER touches res.
async function processSignalBackground({ p, assetId, pineTicker, dedupeKey, entry, sl, tp1, tp2, tp3 }) {
  const isSpecialist = SPECIALIST_SIGNALS.includes(p.template);

  // Specialist sub-signal gate: only the confirmed-active zoneType executes.
  // Any other zoneType (inactive Pine module that still fires) is dropped silently.
  if (isSpecialist) {
    const allowed = SPECIALIST_ALLOWED_ZONES[p.template];
    if (allowed && p.zoneType && !allowed.includes(p.zoneType)) {
      try { await logActivity({ type: 'skip', asset: assetId, template: p.template, direction: p.direction || null, reason: `specialist-zone-inactive:${p.zoneType}` }); } catch (_) {}
      return; // silent — expected; Pine module is disabled but can still compile an alert
    }
  }
  // ── SESSION OPEN COOLDOWN ─────────────────────────────────────────────────
  // Block signals fired within SESSION_OPEN_COOLDOWN_MINS of London (08:00 UTC)
  // or NY (13:30 UTC). Checked before shadows/positions so no wasted work.
  if (SESSION_OPEN_COOLDOWN_MINS > 0) {
    const _d   = new Date(p.timestamp || Date.now());
    const _hm  = _d.getUTCHours() * 60 + _d.getUTCMinutes();
    const _opens = [{ label: 'NY-13:30', hm: 810 }];
    const _hit  = _opens.find(o => (_hm - o.hm + 1440) % 1440 < SESSION_OPEN_COOLDOWN_MINS);
    if (_hit) {
      const _minsIn = (_hm - _hit.hm + 1440) % 1440;
      return bgSkip({
        dedupeKey, pineTicker, template: p.template,
        reason: `session-open-cooldown:${_hit.label}+${_minsIn}min`,
        extras: { assetId, direction: p.direction },
        notify: true,
      });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── PHASE 1 REGIME SHADOW (read-only) ────────────────────────────────────
  // Assess market regime and write what the detector WOULD have done.
  // Entirely isolated: wrapped in try/catch, hard-capped at 2.5s, no variable
  // from this block is read by any downstream code. Trade execution is unchanged.
  try {
    const { assessRegime, writeShadowLog } = require('./regime-detector');
    const _ra = await withTimeout(
      assessRegime({ assetId, template: p.template, nowTs: p.timestamp || Date.now() }),
      2500, null
    );
    if (_ra) {
      writeShadowLog({
        signalId:     dedupeKey,
        assetId,
        template:     p.template,
        direction:    p.direction,
        ts:           p.timestamp || Date.now(),
        regime:       _ra.regime,
        newsState:    _ra.newsState,
        macroVol:     _ra.macroVol,
        vix:          _ra.vix,
        vixDate:      _ra.vixDate,
        instrumentVol: _ra.instrumentVol,
        wouldAction:  _ra.wouldAction,
        wouldSizeMult: _ra.wouldSizeMult,
        reasons:      _ra.reasons,
      }).catch(() => {});  // fire-and-forget; Redis failure never reaches the trade path
    }
  } catch (_regimeErr) {}
  // ─────────────────────────────────────────────────────────────────────────

  // ── PHASE 2 ENTRYSTYLE SHADOW (read-only) ────────────────────────────────
  // For signals that carry immediateEntry + retestEntry (branching templates),
  // write a shadow record comparing what WOULD have happened under each entry
  // style. Entirely isolated: try/catch, no downstream code reads from this block.
  try {
    if (p.immediateEntry != null && p.retestEntry != null && p.template !== 'ote-continuation') {
      const { writeEntryStyleShadow } = require('./entrystyle-shadow');
      writeEntryStyleShadow(p, dedupeKey, assetId).catch(() => {});
    }
  } catch (_esErr) {}
  // ─────────────────────────────────────────────────────────────────────────

  // ── PHASE 3 ORDERFLOW SHADOW (read-only) ─────────────────────────────────
  // Stores the CVD snapshot (slope, confirms, divergence, lowTrust) attached to
  // this signal for later win-rate comparison against cvdConfirms=false signals.
  // Entirely isolated: try/catch, no downstream code reads from this block.
  try {
    if (p.cvdSlope != null || p.cvdDivergence != null) {
      const { writeOrderflowShadow } = require('./orderflow-shadow');
      writeOrderflowShadow(p, dedupeKey, assetId).catch(() => {});
    }
  } catch (_ofErr) {}
  // ─────────────────────────────────────────────────────────────────────────

  // ── PHASE 4 SESSION-CONTEXT SHADOW ───────────────────────────────────────
  // Registered directly with _waitUntil in the main handler (see below), NOT
  // here. waitUntil() called from inside background async code is a no-op —
  // Vercel captures the lifecycle set before res is sent. Keeping this block
  // empty prevents a double-call; the main handler owns the registration.
  // ─────────────────────────────────────────────────────────────────────────

  // 6. Bounded fetch
  const [positions, capital] = await Promise.all([
    withTimeout(fetchPositions(), 1500, []),
    getCapitalFast(),
  ]);

  // 7. Position-already-open check.
  // Specialists (V20): one position per asset — any open QB-V20 position on the
  //   same instrument blocks a second specialist entry. Specialists handle their
  //   own multi-position logic at the Pine level.
  // Legacy templates: block only the SAME template on the same instrument.
  const _known = Object.keys(TEMPLATE_LABELS).sort((a, b) => b.length - a.length);
  const _tmplFromComment = (c) => {
    if (!c) return null;
    if (/^QB-V20-GS2-/.test(c)) return 'specialist-2'; // gold-specialist-2 positions (H1)
    if (/^QB-V20-/.test(c)) return 'specialist';        // all other V20 specialist positions (15m)
    const m = c.match(/^QB-V1[23]-(.+)$/);
    if (!m) return null;
    const rest = m[1];
    for (const t of _known) { if (rest === t || rest.startsWith(t + '-')) return t; }
    return rest.split('-')[0];
  };
  const existing = (Array.isArray(positions) ? positions : []).find((pos) => {
    const sameInstrument = (pos.assetId === assetId) ||
      (pos.symbol && pineTicker && pos.symbol.toUpperCase().includes(pineTicker));
    if (!sameInstrument) return false;
    if (isSpecialist) {
      const posKind = _tmplFromComment(pos.comment);
      // gold-specialist-2 has its own slot — only blocked by another S2 position.
      // gold-specialist (15m) and gold-specialist-2 (H1) can coexist.
      if (p.template === 'gold-specialist-2') return posKind === 'specialist-2';
      // ger40-bg-specialist: B and G are independent setups — allow both to coexist.
      // Comment format: QB-V20-ger40-B or QB-V20-ger40-G. Block only same zone.
      if (p.template === 'ger40-bg-specialist' && posKind === 'specialist') {
        const existingZone = (pos.comment || '').match(/QB-V20-\w+-(\w+)$/)?.[1];
        if (existingZone && existingZone !== p.zoneType) return false;
      }
      return posKind === 'specialist';
    }
    return _tmplFromComment(pos.comment) === p.template;
  });
  if (existing) {
    return bgSkip({
      dedupeKey, pineTicker, template: p.template,
      reason: isSpecialist ? 'specialist-already-open' : 'same-template-already-open',
      extras: { assetId, positionTicket: existing.id }, notify: true,
    });
  }

  // 8. Resolve broker symbol
  const brokerSymbol = await resolveSymbol(assetId);
  if (!brokerSymbol) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: `cannot resolve broker symbol for ${assetId}` });
    try { await sendOnce(`diag-nosym:${dedupeKey}`, `\u26a0\ufe0f DIAG \u2014 ${assetId} \u00b7 ${p.template}: cannot resolve broker symbol`); } catch (_) {}
    return;
  }

  // 10. Asset meta
  const assetMeta = getAssetById(assetId);
  if (!assetMeta) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: `no asset registry for ${assetId}` });
    try { await sendOnce(`diag-noreg:${dedupeKey}`, `\u26a0\ufe0f DIAG \u2014 ${assetId} \u00b7 ${p.template}: no asset registry entry`); } catch (_) {}
    return;
  }

  // 11. RULES ENGINE
  const todaysPnL = await getTodaysPnL();
  const managedOpen = (positions || []).filter((pos) =>
    pos.comment && (
      pos.comment.startsWith('QB-V12-') ||
      pos.comment.startsWith('QB-V13-') ||
      pos.comment.startsWith('QB-V20-')
    )
  );
  const decision = await applyRulesToSignal({
    assetId, template: p.template, direction: p.direction,
    entry, sl, tp1, tp2, tp3,
    htfTier: p.htfTier || null, htfBiasAlign: p.htfBiasAlign,
    capital, openPositions: managedOpen, todaysPnL, assetMeta,
  });

  if (!decision.allow) {
    return bgSkip({
      dedupeKey, pineTicker, template: p.template,
      reason: decision.reason,
      extras: { assetId, direction: p.direction, pineSL: sl, pineTP1: tp1 },
      notify: true,
    });
  }

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550 MANUAL MODE \u2550\u2550\u2550\u2550\u2550\u2550\u2550
  if (decision.tradingMode === 'manual') {
    const watchId = `watch_${assetId}_${p.timestamp}_${Date.now()}`;
    await addWatchedSetup({
      id: watchId,
      asset: assetId,
      template: p.template,
      direction: p.direction,
      entry,
      sl: decision.finalSL,
      tp1: decision.finalTP1, tp2: decision.finalTP2, tp3: decision.finalTP3,
      finalLot: decision.finalLot,
      zoneUpper: parseFloat(p.zoneUpper) || null,
      zoneLower: parseFloat(p.zoneLower) || null,
      zoneType: p.zoneType || null,
      pineSL: sl, pineTP1: tp1, pineTP2: tp2, pineTP3: tp3,
      brokerSymbol,
      window: p.window || null,
      swept: p.swept || null,
      timeframe: p.timeframe,
      status: 'watching',
      createdAt: Date.now(),
      expiresAt: Date.now() + 90 * 60 * 1000,
      rulesApplied: decision.rulesApplied,
    });

    await markExecuted(dedupeKey, { watchId, mode: 'manual', placedAt: Date.now() });

    await logActivity({
      type: 'manual-watching',
      asset: assetId, template: p.template, direction: p.direction,
      entry, sl: decision.finalSL, tp1: decision.finalTP1,
      watchId,
    });

    try {
      const tmplLabel = TEMPLATE_LABELS[p.template] || p.template;
      const dirEmoji = p.direction === 'LONG' ? '\ud83d\udfe2' : '\ud83d\udd34';
      await sendOnce(`watching:${watchId}`,
        `\ud83d\udd14 <b>SETUP FORMING \u2014 ${pineTicker}</b>\n\n` +
        `Setup: ${tmplLabel}\n` +
        `${dirEmoji} ${p.direction}  \u2022  Lot to place: ${decision.finalLot}\n` +
        `Entry: <code>${entry}</code>\n` +
        `SL: <code>${decision.finalSL}</code>\n` +
        `TP1: <code>${decision.finalTP1}</code>\n\n` +
        `\u23f3 Watching for price to enter the zone. You'll get a "TIME TO ENTER" alert when it does.\n` +
        `<i>Manual mode: bot will not auto-place this trade.</i>`
      );
    } catch (_) {}
    return;
  }

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550 AUTO MODE \u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // 11b. Reaction MTF and signal-quality gates are SKIPPED for specialist signals.
  // Specialists embed bias + quality checks directly in the Pine script — these
  // generic middleware gates would add false positives on top of stricter
  // instrument-specific logic that already ran at the source.

  // 11b. v14.3 — REACTION MTF confirmation (legacy templates only).
  if (!isSpecialist && REACTION_TEMPLATES.includes(p.template)) {
    const rxnMode = decision.activeMode === 'sleep' ? 'swing' : 'day';
    const TFS = tfSetForMode(rxnMode);
    const grab = async (tf, n) => {
      try {
        const r = await withTimeout(fetchCandles(assetId, tf, n), 2500, { candles: [] });
        return (r && r.candles) || [];
      } catch (_) { return []; }
    };
    const [b0, b1, t0, t1] = await Promise.all([
      grab(TFS.bias[0], 40), grab(TFS.bias[1], 40),
      grab(TFS.trigger[0], 60), grab(TFS.trigger[1], 60),
    ]);
    const verdict = evaluateReactionMTF(
      { template: p.template, direction: p.direction, entry, session: p.session, mode: rxnMode, htfBiasAlign: p.htfBiasAlign },
      { biasCandles: [b0, b1], triggerCandles: [t0, t1], combine: 'or' }
    );
    if (verdict.applies && !verdict.pass) {
      await logActivity({
        type: 'reaction-filtered', asset: assetId, template: p.template,
        direction: p.direction, reason: verdict.reason, mode: rxnMode, checks: verdict.checks,
      });
      return bgSkip({
        dedupeKey, pineTicker, template: p.template,
        reason: `reaction-filter:${verdict.reason}`,
        extras: { assetId, direction: p.direction, mode: rxnMode, checks: verdict.checks },
        notify: true,
      });
    }
  }

  // ── FTMO 2-Step guard: block if daily DD ≥ 4% or total DD ≥ 8.5% ─────────
  // Fails open on broker timeout — never silently drops a signal.
  if (isSpecialist) {
    try {
      const { checkFTMOLimits } = require('./ftmo-guard');
      const _ftmo = await checkFTMOLimits().catch(() => ({ canTrade: true }));
      if (!_ftmo.canTrade) {
        return bgSkip({
          dedupeKey, pineTicker, template: p.template,
          reason: _ftmo.reason || 'ftmo-limit',
          extras: { assetId, direction: p.direction,
                    dailyLossPct: _ftmo.dailyLossPct, totalDDPct: _ftmo.totalDDPct },
          notify: true,
        });
      }
    } catch (_ftmoErr) {}
  }

  // ── News filter: block ±1h around high-impact events (impact=3) ────────────
  if (isSpecialist) {
    try {
      const { checkNewsBlock } = require('./news-filter');
      const _news = await checkNewsBlock(p.template).catch(() => ({ canTrade: true }));
      if (!_news.canTrade) {
        try {
          const _dirEmoji = p.direction === 'LONG' ? '🟢' : '🔴';
          const _evTimeStr = _news.evTime
            ? new Date(_news.evTime).toUTCString().replace(/:\d\d GMT$/, ' UTC')
            : '—';
          await sendOnce(`news-block:${dedupeKey}`,
            `📰 <b>NEWS BLOCK — ${pineTicker}</b>\n\n` +
            `${_dirEmoji} ${p.direction}  ·  ${p.template}\n` +
            `Event: <b>${_escHtml(_news.event || 'high-impact event')}</b>\n` +
            `Currency: ${_news.currency || '—'}\n` +
            `Event time: <code>${_evTimeStr}</code>\n\n` +
            `<i>Trade blocked — within ±1h of HIGH impact news window.</i>`);
        } catch (_) {}
        return bgSkip({
          dedupeKey, pineTicker, template: p.template,
          reason: 'news-block',
          extras: { assetId, direction: p.direction,
                    event: _news.event, currency: _news.currency, evTime: _news.evTime },
          notify: false,
        });
      }
    } catch (_newsErr) {}
  }

  // ── V20 Specialist: FTMO 1% risk-based lot sizing ────────────────────────
  // Lot = (capital × 1%) ÷ (SL_distance_in_pips × dollar_per_pip_per_lot)
  // Replaces the momentum ±0.1/±0.5 Redis system.
  if (isSpecialist) {
    try {
      const _RISK_PCT = 0.01;
      const _LOT_CFG = {
        gold:   { minLot: 0.01, maxLot: 50.0, lotStep: 0.01 },
        nas100: { minLot: 0.01, maxLot: 50.0, lotStep: 0.01 },
        ger40:  { minLot: 0.01, maxLot: 50.0, lotStep: 0.01 },
      };
      const _slDist = Math.abs(entry - sl);
      if (_slDist > 0 && assetMeta.pipSize > 0 && assetMeta.dollarPerPipPerLot > 0) {
        const _riskDollars   = (capital || 0) * _RISK_PCT;
        const _dollarPerLot  = (_slDist / assetMeta.pipSize) * assetMeta.dollarPerPipPerLot;
        const _cfg = _LOT_CFG[assetId] || { minLot: 0.01, maxLot: 50.0, lotStep: 0.01 };
        if (_riskDollars > 0 && _dollarPerLot > 0) {
          const _raw = _riskDollars / _dollarPerLot;
          decision.finalLot = Math.max(_cfg.minLot, Math.min(_cfg.maxLot,
            Math.floor(_raw / _cfg.lotStep) * _cfg.lotStep));
        }
      }
    } catch (_) {}
  }
  const finalLot = decision.finalLot;
  const finalSL = decision.finalSL;
  const finalTP1 = decision.finalTP1 != null ? decision.finalTP1 : tp1;
  // v14 all-or-nothing: broker TP parks at the LAST configured target so the full
  // position rides there. SL ratchets to TP1/TP2 in manage-trades (no partials).
  const _bTP2 = decision.finalTP2 != null ? decision.finalTP2 : tp2;
  const _bTP3 = decision.finalTP3 != null ? decision.finalTP3 : tp3;
  const brokerTP = _bTP3 != null ? _bTP3 : (_bTP2 != null ? _bTP2 : finalTP1);
  // V20 specialists use QB-V20-{asset}-{signalType}; legacy stays QB-V13-{template}-{window}
  // gold-specialist-2 uses QB-V20-GS2-* prefix so its positions don't block gold-specialist
  // (15m) trades — each specialist has its own 1-per-asset slot.
  const comment = isSpecialist
    ? p.template === 'gold-specialist-2'
      ? `QB-V20-GS2-${assetId.slice(0, 4)}-${(p.zoneType || 'sig').slice(0, 8)}`.slice(0, 64)
      : `QB-V20-${assetId.slice(0, 5)}-${(p.zoneType || p.window || 'sig').slice(0, 10)}`.slice(0, 64)
    : `QB-V13-${p.template}-${(p.window || p.swept || '').slice(0, 12)}`.slice(0, 64);

  // v14: round to the broker's tick increment. Raw Pine prices can carry more
  // decimals than the symbol allows, which the broker rejects as INVALID_PRICE.
  const isLong = p.direction === 'LONG';
  const pipSz = assetMeta.pipSize || 0.0001;

  // v15.7: when actualStyle is present, use the matching entry price from the payload.
  //   immediate -> p.immediateEntry (at-market close Pine computed for this signal path)
  //   retest    -> p.retestEntry   (zone/ORB edge to wait for on a pending limit)
  //   missing   -> p.entry         (pre-v15.7 payload -- geometry probe handles it below)
  const _pStyle = p.actualStyle;
  const _pImmE  = parseFloat(p.immediateEntry);
  const _pRetE  = parseFloat(p.retestEntry);
  const routingEntry = _pStyle === 'immediate' && isFinite(_pImmE) ? _pImmE
                     : _pStyle === 'retest'    && isFinite(_pRetE) ? _pRetE
                     : entry;

  const rEntry = _roundTick(routingEntry, pipSz, 'nearest');
  let   rSL    = _roundTick(finalSL, pipSz, isLong ? 'down' : 'up');
  const rTP    = brokerTP != null ? _roundTick(brokerTP, pipSz, isLong ? 'down' : 'up') : null;

  // Minimum stop distance guard: MT5 brokers enforce a per-symbol stopsLevel that
  // defines how far SL must be from entry. Tight FVG entries (e.g. EURUSD am-ifvg
  // with a 5-pip gap) produce SLs within this freeze zone → INVALID_STOPS rejection.
  // Expand SL outward to the floor. Lot is unchanged (risk increases slightly, but
  // the alternative is the trade being dropped entirely with no notification).
  const _minStopDist = (assetMeta.minStopPips || 0) * pipSz;
  if (_minStopDist > 0 && Math.abs(rSL - rEntry) < _minStopDist) {
    const _prevSL = rSL;
    rSL = _roundTick(isLong ? rEntry - _minStopDist : rEntry + _minStopDist, pipSz, isLong ? 'down' : 'up');
    try { await logActivity({ type: 'sl-expanded-min-stop', asset: assetId, template: p.template, direction: p.direction, from: _prevSL, to: rSL, minStopPips: assetMeta.minStopPips }); } catch (_) {}
  }

  // v15.7: route MARKET vs LIMIT by actualStyle when present; fall back to geometry probe.
  //   immediate -> ORDER_TYPE_BUY/SELL  (fill now, no geometry check)
  //   retest    -> ORDER_TYPE_BUY/SELL_LIMIT at rEntry (= retestEntry, no geometry check)
  //   missing   -> existing _canLimit geometry probe (all pre-v15.7 behavior unchanged)
  let entryType = 'retest';
  let useMarket = false;
  let _dbgProbed = null, _dbgProbeOk = false, _dbgCanLimit = null, _dbgDriftPips = null;

  if (_pStyle === 'immediate') {
    // Pine explicitly flagged this as an immediate fill -- send MARKET unconditionally.
    useMarket = true;
    entryType = 'immediate';
  } else if (_pStyle === 'retest') {
    // Pine explicitly flagged this as a retest -- place LIMIT at rEntry.
    useMarket = false;
    entryType = 'retest';
  } else {
    // No actualStyle: pre-v15.7 payload. Run geometry probe unchanged.
    try {
      const { fetchCandles: _fcSrc } = require('./candle-source');
      const _cr = await withTimeout(_fcSrc(assetId, '5m', 3), 1200, null);
      const _last = _cr && _cr.candles && _cr.candles.length ? _cr.candles[_cr.candles.length - 1] : null;
      const _cur = _last && _last.close;
      if (_cur && isFinite(_cur)) {
        _dbgProbeOk = true; _dbgProbed = _cur;
        const _tol = Math.max((_last.high - _last.low) * 0.5, pipSz * 5);
        // A LIMIT is only valid when the entry sits AWAY from price on the correct
        // side: a LONG buy-limit must be BELOW market, a SHORT sell-limit ABOVE it.
        // Anything else -- entry at/through the market (immediate), or so close the
        // broker won't accept it -- must go in as a MARKET order, otherwise MT5
        // rejects the limit with TRADE_RETCODE_INVALID_PRICE.
        const _canLimit = isLong ? (rEntry < _cur - _tol) : (rEntry > _cur + _tol);
        _dbgCanLimit = _canLimit;
        if (!_canLimit) {
          const _slDist = Math.abs(rEntry - rSL);
          const _budget = Math.max(_slDist * 0.25, pipSz * 10); // 25% of stop, min 10 pips
          // Adverse drift only: skip just when a MARKET fill would be WORSE than the
          // signalled entry by more than budget (don't chase a runaway). A favorable
          // gap (market better than entry) still fills.
          const _drift = isLong ? (_cur - rEntry) : (rEntry - _cur);
          _dbgDriftPips = +(_drift / pipSz).toFixed(1);
          if (_drift > _budget) {
            await logActivity({ type: 'placement-skipped', asset: assetId, template: p.template, direction: p.direction, reason: 'market-beyond-slippage-budget', signalEntry: rEntry, marketPrice: _cur, driftPips: _dbgDriftPips });
            try {
              await sendOnce(`webhook-stale:${dedupeKey}`,
              `\u26a0\ufe0f <b>Signal SKIPPED \u2014 ${pineTicker}</b>\n\n` +
              `Template: ${p.template}\nDirection: ${p.direction}\n` +
              `Reason: market moved past entry beyond slippage budget \u2014 not chasing`);
            } catch (_) {}
            return;
          }
          useMarket = true;
          entryType = 'immediate';
        }
      }
    } catch (_) { /* candle fetch failed -- fall through to limit; broker is final guard */ }
  }

  // SB_IMMEDIATE_ONLY: silver-bullet retest (limit) entries are converted to
  // immediate market fills. A pending limit at the FVG edge is never placed —
  // price fills NOW at market. This avoids missed entries when price is already
  // past the FVG by the time the limit would trigger.
  if (SB_IMMEDIATE_ONLY && (p.template === 'silver-bullet' || p.template === 'gold-sb') && !useMarket) {
    useMarket  = true;
    entryType  = 'immediate';
    try { await logActivity({ type: 'sb-retest-to-immediate', asset: assetId, template: p.template, direction: p.direction, note: 'retest converted to market fill' }); } catch (_) {}
  }

  // REACTION_RETEST_BLOCK: reaction templates execute on the bar they fire — a limit
  // order to "wait for a retest" has 72% loss rate in recognition memory (short-hold
  // bucket). Explicit actualStyle='retest' is already patched to 'immediate' in the
  // sync handler; this catches the pre-v15.7 geometry-probe fallthrough path.
  if (REACTION_RETEST_BLOCK && REACTION_TEMPLATES.includes(p.template) && !useMarket) {
    try { await logActivity({ type: 'skip', asset: assetId, template: p.template, direction: p.direction, reason: 'reaction-retest-suppressed', entryType }); } catch (_) {}
    return bgSkip({
      dedupeKey, pineTicker, template: p.template,
      reason: 'reaction-retest-suppressed',
      extras: { assetId, direction: p.direction },
      notify: false,
    });
  }

  // v16.0 signal-quality gate (legacy templates only).
  // Specialists skip this — their Pine scripts already apply stricter quality gates.
  // sqQualityTier is still written for both paths (null for specialists).
  let sqQualityTier = null;
  {
    const sq = isSpecialist
      ? { pass: true, qualityTier: null }
      : await evaluateSignalQuality(p, assetId, dedupeKey).catch(() => ({ pass: true }));
    if (!sq.pass) {
      try { await logActivity({ type: 'skip', asset: assetId, template: p.template, direction: p.direction, reason: `signal-quality-blocked`, blockedBy: sq.blockedBy, qualityTier: sq.qualityTier }); } catch (_) {}
      // ── Telegram: rich blocked-signal notification ───────────────────────────
      try {
        const _dirEmoji = p.direction === 'LONG' ? '🟢' : '🔴';
        const _tierCol  = sq.qualityTier === 'D' ? '🔴' : '🟠';
        const _wickLine = sq.wick
          ? (sq.wick.pass ? `✅ Wick gate — ${Math.round((sq.wick.wickRatio ?? 0) * 100)}% (ok)`
                          : `❌ Wick gate — ${Math.round((sq.wick.wickRatio ?? 0) * 100)}% wick ratio (&gt;50% → blocked)`)
          : null;
        const _sessLine = sq.session
          ? (sq.session.pass ? `✅ Session gate — aligned with prior session`
                             : `❌ Session gate — opposes London/prior session close`)
          : null;
        const _cvdLine  = sq.cvd
          ? (sq.cvd.pass ? `✅ CVD gate — ok`
                         : `❌ CVD gate — low-trust + ${sq.cvd.cvdDivergence || 'divergence'} divergence`)
          : null;
        const _gateLines = [_wickLine, _sessLine, _cvdLine].filter(Boolean).join('\n');
        const _tgResult = await sendOnce(`sq-blocked:${dedupeKey}`,
          `🚫 <b>Signal BLOCKED — ${pineTicker}</b>\n\n` +
          `${_dirEmoji} ${p.template} · ${p.direction}\n` +
          `Tier: ${_tierCol} <b>${sq.qualityTier}</b> (${sq.qualityTier === 'D' ? '2+ gates triggered' : '1 gate triggered'})\n\n` +
          `${_gateLines}\n\n` +
          `<i>Trade will not be placed.</i>`);
        if (_tgResult && !_tgResult.sent) {
          logActivity({ type: 'tg-blocked-notify-fail', reason: _tgResult.reason, dedupeKey }).catch(() => {});
        }
      } catch (_sqNotifyErr) {
        logActivity({ type: 'tg-blocked-notify-error', error: _sqNotifyErr?.message }).catch(() => {});
      }
      // ─────────────────────────────────────────────────────────────────────────
      return bgSkip({
        dedupeKey, pineTicker, template: p.template,
        reason: `signal-quality-blocked:${sq.blockedBy}`,
        extras: { assetId, direction: p.direction, qualityTier: sq.qualityTier, blockedBy: sq.blockedBy },
        notify: false,
      });
    }
    // ── v16.1 NY Open Specialist journal (fire-and-forget) ───────────────────
    try {
      const { isNYSpecialistSignal, recordNYSignal } = require('./ny-session-journal');
      if (isNYSpecialistSignal(assetId, p.template, p.timestamp || Date.now())) {
        recordNYSignal(p, assetId, sq).then(nyCtx => {
          if (nyCtx) logActivity({ type: 'ny-specialist-signal', asset: assetId, template: p.template, direction: p.direction, nyContext: nyCtx }).catch(() => {});
        }).catch(() => {});
      }
    } catch (_nyJErr) {}
    sqQualityTier = sq.qualityTier || null;
    // ─────────────────────────────────────────────────────────────────────────
  }

  // v14.1: one-line record of HOW this signal was routed and WHY, so a suspected
  // immediate/retest mis-route can be diagnosed straight from the activity log.
  try {
    await logActivity({
      type: 'entry-routing', asset: assetId, template: p.template, direction: p.direction,
      pineActualStyle: _pStyle || null, signalEntry: rEntry, routingEntry,
      marketPrice: _dbgProbed, probeOk: _dbgProbeOk,
      canLimit: _dbgCanLimit, driftPips: _dbgDriftPips,
      decided: useMarket ? 'immediate(market)' : 'retest(limit)',
    });
  } catch (_) {}

  let placement = useMarket
    ? await placeMarketOrder(brokerSymbol, p.direction, finalLot, rSL, rTP, comment)
    : await placeLimitOrder(brokerSymbol, p.direction, finalLot, rEntry, rSL, rTP, comment);

  // Catch-all for the last INVALID_PRICE causes. A limit can still be rejected
  // when the price probe failed (blind, possibly wrong-side limit) or when a
  // correct-side limit lands inside the broker's minimum stop distance. Rather
  // than drop the trade, retry once as MARKET — a market fill is always
  // price-valid and, for these near-market cases, lands at the intended entry.
  // SL/TP/lot are unchanged, so risk is preserved.
  if (!placement.ok && !useMarket && /INVALID_PRICE/i.test(placement.error || '')) {
    await logActivity({
      type: 'limit-invalid-retry-market', asset: assetId, template: p.template,
      direction: p.direction, attemptedEntry: rEntry, error: (placement.error || '').slice(0, 120),
    });
    const _mkt = await placeMarketOrder(brokerSymbol, p.direction, finalLot, rSL, rTP, comment);
    placement = _mkt;
    if (_mkt.ok) { useMarket = true; entryType = 'immediate'; }
  }

  if (!placement.ok) {
    await logActivity({ type: 'placement-failed', asset: assetId, template: p.template, direction: p.direction, reason: placement.error });
    try {
      await sendOnce(`webhook-fail:${dedupeKey}`,
        `\u26a0\ufe0f <b>Order REJECTED by broker \u2014 ${pineTicker}</b>\n\n` +
        `Template: ${p.template}\nDirection: ${p.direction}\nLot: ${finalLot}\n` +
        `Error: <code>${(placement.error || 'unknown').slice(0, 200)}</code>`);
    } catch (_) {}
    // Downgrade pending marker to a short-lived failure record. Blocks an immediate
    // TV retry of the same bad signal for 60 s; allows a genuine later signal after.
    await markExecuted(dedupeKey, { status: 'failed', failedAt: Date.now() }, 60);
    return;
  }

  await markExecuted(dedupeKey, { brokerOrderId: placement.orderId, template: p.template, placedAt: Date.now() });

  // v2.3: real R-multiples from actual prices — the SL/minRR recompute can put
  // TP1 at 2R (etc.), so the old hardcoded 1/2/3 labels misreported the trade
  // AND corrupted recognition-memory R-data. Compute the truth from prices.
  const _slDist = Math.abs(entry - finalSL);
  const rOf = (tp) => (tp == null || _slDist <= 0) ? null : Math.round(Math.abs(tp - entry) / _slDist * 10) / 10;

  try {
    const { addPendingSetup } = require('./watcher');
    const finalTP2 = decision.finalTP2 != null ? decision.finalTP2 : tp2;
    const finalTP3 = decision.finalTP3 != null ? decision.finalTP3 : tp3;
    const slDistance = Math.abs(entry - finalSL);
    const _kzAtSignal  = checkKillZone(new Date(p.timestamp || Date.now()));
    const _sigUtcMin   = (() => { const d = new Date(p.timestamp || Date.now()); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
    const _minsIntoWindow  = _kzAtSignal.inKillZone ? _sigUtcMin - _kzAtSignal.startUtcMin : null;
    const _sessionClosesAt = _kzAtSignal.inKillZone ? Date.now() + (_kzAtSignal.minutesUntilClose * 60 * 1000) : null;
    const pendingRecord = {
      id: `setup_${assetId}_v13_${p.timestamp}_${Date.now()}`,
      asset: assetId,
      setup: {
        direction: p.direction,
        mode: decision.activeMode === 'sleep' ? 'SWING' : 'DAY',
        session: p.window || (p.swept ? `swept ${p.swept}` : 'unknown'),
        contributingTactics: [p.template], timeframesInPlay: [p.timeframe],
        slDistance, slDistanceATR: parseFloat(p.impulseATR) || null,
        entry, sl: finalSL,
        style: decision.rulesApplied ? decision.rulesApplied.style : null,
        targets: [
          { price: finalTP1, rMultiple: rOf(finalTP1) },
          { price: finalTP2, rMultiple: rOf(finalTP2) },
          { price: finalTP3, rMultiple: rOf(finalTP3) },
        ].filter((t) => t.price != null),
        template: p.template,
        zoneType: p.zoneType || null,
      },
      recognition: { advice: 'neutral', matchCount: 0, wins: 0, losses: 0, confidence: 'none' },
      sizing: { baseLot: finalLot, recommendedLot: finalLot, baseRisk: slDistance * (assetMeta.dollarPerPipPerLot / assetMeta.pipSize) * finalLot },
      plannedEntry: entry, slPrice: finalSL,
      tpLevels: [
        { price: finalTP1, rMultiple: rOf(finalTP1), source: decision.rulesApplied.tpMode },
        { price: finalTP2, rMultiple: rOf(finalTP2), source: decision.rulesApplied.tpMode },
        { price: finalTP3, rMultiple: rOf(finalTP3), source: decision.rulesApplied.tpMode },
      ].filter((t) => t.price != null),
      newsFeature: { newsState: 'none', highImpactWithin60min: false },
      createdAt: Date.now(),
      expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      status: 'placed',
      brokerOrderId: placement.orderId, comment, positionId: null,
      entryType, execKind: useMarket ? 'market' : 'limit',
      htfTier: p.htfTier || null,
      dedupeKey,
      minsIntoWindow: _minsIntoWindow,
      sessionClosesAt: _sessionClosesAt,
      killZoneName: _kzAtSignal.inKillZone ? _kzAtSignal.name : null,
      adrConsumed: parseFloat(p.adrConsumed) || null,
      v13: true, pilotRulesApplied: decision.rulesApplied,
    };
    await addPendingSetup(assetId, pendingRecord);

    // Shadow write: log recognition advice at signal time using the same pendingRecord.id
    // that manage-trades.js stamps with the outcome at close — this is the join key.
    // Runs in its own try/catch so a recognition failure never blocks the trade record.
    try {
      const { findSimilarTrades, getSizeMultiplier } = require('./recognition-memory');
      const _recog = await findSimilarTrades({
        asset:               assetId,
        direction:           p.direction,
        template:            p.template,
        session:             p.window || (p.swept ? `swept ${p.swept}` : 'unknown'),
        contributingTactics: [p.template],
        timeframesInPlay:    [p.timeframe],
        newsFeature:         null,
        minsIntoWindow:      _minsIntoWindow,
        adrConsumed:         parseFloat(p.adrConsumed) || null,
        dedupeKey,
      });
      const _adv = _recog && _recog.summary;
      if (_adv) {
        const _advisorMultiplier = getSizeMultiplier(_adv.advice);
        const _sr = getRedis();
        if (_sr) {
          const _shadow = {
            setupId:           pendingRecord.id,
            asset:             assetId,
            direction:         p.direction,
            template:          p.template,
            advice:            _adv.advice,
            matchCount:        _adv.matchCount,
            winRate:           _adv.winRate,
            confidence:        _adv.confidence,
            advisorMultiplier: _advisorMultiplier,
            ts:                Date.now(),
          };
          await _sr.set(`v14:shadow:advice:${pendingRecord.id}`, JSON.stringify(_shadow), { ex: 86400 * 90 });
          await _sr.lpush('v14:shadow:index', JSON.stringify({ setupId: pendingRecord.id, ts: _shadow.ts, asset: assetId }));
          await _sr.ltrim('v14:shadow:index', 0, 499);
        }
      }
    } catch (_) {}
  } catch (e) { console.error('[webhook] pending setup write failed:', e.message); }

  await logActivity({
    type: 'trade-placed', asset: assetId, template: p.template, direction: p.direction,
    lot: finalLot, entry, sl: finalSL, tp1: decision.finalTP1,
    entryType, execKind: useMarket ? 'market' : 'limit',
    activeMode: decision.activeMode, rulesApplied: decision.rulesApplied,
    brokerOrderId: placement.orderId,
  });

  const _tpLevels = [
    { price: decision.finalTP1, rMultiple: rOf(decision.finalTP1), source: decision.rulesApplied.tpMode },
    { price: decision.finalTP2, rMultiple: rOf(decision.finalTP2), source: decision.rulesApplied.tpMode },
    { price: decision.finalTP3, rMultiple: rOf(decision.finalTP3), source: decision.rulesApplied.tpMode },
  ].filter((t) => t.price != null);

  try {
    if (isSpecialist) {
      await notifySpecialistTradePlaced({
        asset: assetId, direction: p.direction,
        lot: finalLot, entry, sl: finalSL,
        tpLevels: _tpLevels,
        riskDollars: Math.abs(entry - finalSL) * (assetMeta.dollarPerPipPerLot / assetMeta.pipSize) * finalLot,
        brokerOrderId: placement.orderId,
        template: p.template,
        zoneType:  p.zoneType  || null,   // FVG / Judas / SB / ORB / PSYCH / FRB / NYORB
        session:   p.window    || null,   // LONDON / NY_AM / NY_PM …
        tier:      p.htfTier   || null,   // A / B
        filterStr: p.filters   || null,
      });
    } else {
      const { notifyTradePlaced: _ntp } = require('./telegram');
      await _ntp({
        asset: assetId, direction: p.direction,
        lot: finalLot, entry, sl: finalSL,
        tpLevels: _tpLevels,
        riskDollars: Math.abs(entry - finalSL) * (assetMeta.dollarPerPipPerLot / assetMeta.pipSize) * finalLot,
        brokerOrderId: placement.orderId, template: p.template,
        qualityTier: sqQualityTier,
      });
    }
  } catch (_) {}
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  const t0 = Date.now();

  // ---- FAST PATH: only sub-second work, then ACK so TradingView never times out ----

  // 1-2. Parse + auth
  const parsed = parseDualFormat(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  const p = parsed.payload;

  const expectedKey = process.env.WEBHOOK_API_KEY || '';
  if (!expectedKey) return res.status(500).json({ ok: false, error: 'WEBHOOK_API_KEY not set' });
  if (p.apiKey !== expectedKey) return res.status(401).json({ ok: false, error: 'invalid-api-key' });

  // 3. Master kill switch (fast skip, no order)
  if (!isTradingEnabled()) {
    return skipWithReason({
      res, dedupeKey: null, pineTicker: p.symbol, template: p.template,
      reason: 'trading-disabled (QB_TRADING_ENABLED != true)', notify: false,
    });
  }

  // 4. Resolve ticker (in-memory, fast)
  const rawSymbol = (p.symbol || '').toUpperCase();
  const colonIdx = rawSymbol.lastIndexOf(':');
  const pineTicker = (colonIdx >= 0 ? rawSymbol.slice(colonIdx + 1) : rawSymbol).replace(/[^A-Z0-9]/g, '');
  // Broker-suffix fallback: some feeds append .s/.m/.d after the pair name.
  // The regex above strips the dot but keeps the letter (XAUUSD.s → XAUUSDS).
  // Try stripping 1 then 2 trailing chars to recover the base symbol.
  const assetId = PINE_TO_ASSET[pineTicker]
    || PINE_TO_ASSET[pineTicker.slice(0, -1)]
    || PINE_TO_ASSET[pineTicker.slice(0, -2)];
  if (!assetId) return res.status(400).json({ ok: false, error: `unknown symbol: ${p.symbol}` });

  // 4b. v14 — Pine SKIP alert (tier-C open-space, or ORB width filter). This is
  // NOT a trade: it has no entry/sl/tp. Notify Telegram so the user SEES what the
  // filter rejected, log it, and stop. Fast/inline — no broker, no background.
  if ((p.action || 'trade') === 'skip') {
    const reason = p.reason || 'filtered';
    const note   = p.note || 'setup formed but filtered';
    const extra  = (p.htfTier ? `\nTier: ${_escHtml(p.htfTier)}` : '') + (p.widthATR != null ? `\nWidth: ${p.widthATR}× ATR` : '') + (p.session ? `\nSession: ${_escHtml(p.session)}` : '');
    try {
      await sendOnce(`pineskip:${assetId}:${p.template}:${reason}:${p.timestamp || ''}`,
        `⚪ ${assetId.toUpperCase()} · ${p.template} · SKIPPED\n${_escHtml(note)}${extra}`);
    } catch (_) {}
    try { await logActivity({ type: 'skip', asset: assetId, template: p.template, direction: p.direction || null, reason: `pine-skip: ${reason}` }); } catch (_) {}
    return res.status(200).json({ ok: true, skipped: true, reason });
  }

  // alexg is backend-only (cron via /api/alexg-run). It has no Pine script and
  // must never be sent as a webhook signal. Return a clear 400 so accidental
  // misconfiguration is caught immediately rather than silently misrouted.
  if (p.template === 'alexg') {
    return res.status(400).json({ ok: false, error: 'alexg is a backend-only strategy — it runs via its own cron (/api/alexg-run) and does not accept Pine webhook signals' });
  }

  if (!ACCEPTED_TEMPLATES.includes(p.template)) {
    return res.status(400).json({ ok: false, error: `unknown template: ${p.template}` });
  }

  // Template blocklist — single-array change to re-enable. Logged for audit.
  if (DISABLED_TEMPLATES.includes(p.template)) {
    try { await logActivity({ type: 'skip', asset: assetId, template: p.template, direction: p.direction || null, reason: 'template-disabled' }); } catch (_) {}
    return res.status(200).json({ ok: true, executed: false, reason: 'template-disabled', template: p.template });
  }

  // Per-template instrument block.
  // Primary: gating-store (Redis, user-configurable via /api/gating-rules).
  // Fallback: TEMPLATE_INSTRUMENT_BLOCKS hardcoded constant if store is unreachable.
  // Returns 200 so TradingView does not retry.
  {
    let _gateResult = null;  // null = allowed; { blocked, ruleKey, updatedBy } = blocked
    try {
      const { isGated } = require('./gating-store');
      _gateResult = await isGated(p.template, p.activeSession || '*', assetId);
    } catch (_gateErr) {
      // Redis unreachable — FAIL OPEN (signal allowed) and log loudly.
      //
      // RETIRED: TEMPLATE_INSTRUMENT_BLOCKS is no longer applied here. Applying
      // it would silently override an explicit user enable (e.g. user un-blocks
      // ORB×BTC in the panel; Redis hiccups; hardcoded constant re-blocks it with
      // no trace). There must be ONE source of truth: the Redis store.
      //
      // Trade-off: during a Redis outage a previously-user-blocked combo could fire.
      // That is the lesser evil compared to silently overriding an explicit user
      // enable. The loud log + Telegram alert below ensures the operator knows.
      const _fallbackMsg = `GATING FALLBACK: Redis threw (${(_gateErr && _gateErr.message) || 'unknown'}) for ${p.template}×${assetId} — FAILING OPEN (signal allowed). Fix Redis immediately; user-set blocks are NOT being enforced.`;
      try {
        const _rErr = getRedis();
        if (_rErr) {
          await _rErr.lpush('v14:gating:errors', JSON.stringify({ ts: Date.now(), error: _fallbackMsg, template: p.template, assetId, failOpen: true, dedupeKey: `${assetId}:${p.template}:${p.direction}:${p.timestamp}` }));
          await _rErr.ltrim('v14:gating:errors', 0, 49);
        }
      } catch (_) {}
      try { sendOnce(`gating-fallback:${p.template}:${assetId}`, `⚠️ ${_fallbackMsg}`); } catch (_) {}
      // _gateResult remains null → signal passes
    }
    if (_gateResult?.blocked) {
      // Build descriptive reason: includes template, session used, and instrument.
      const _ruleKeyParts = (_gateResult.ruleKey || '').split('|');
      const _gatedSess    = _ruleKeyParts[1] || '*';
      const _gateReason   = `gated: user-disabled ${p.template}×${_gatedSess}×${assetId}`;
      try { await logActivity({ type: 'skip', asset: assetId, template: p.template, direction: p.direction || null, reason: _gateReason, gatedBy: _gateResult.updatedBy || null }); } catch (_) {}
      return res.status(200).json({ ok: true, executed: false, reason: _gateReason, template: p.template, asset: assetId });
    }
  }

  // Reaction-family retest signals → convert to immediate market entry.
  // A reaction retest arrives with actualStyle='retest' (SELL LIMIT at zone edge), but
  // by the time the signal fires price is already at/through the zone — a limit would
  // either sit above market (INVALID_PRICE) or miss the move. Convert to 'immediate'
  // so the background executor routes to placeMarketOrder instead of placeLimitOrder.
  if (['reaction', 'reaction-fvg', 'reaction-ifvg', 'reaction-ext'].includes(p.template) && p.actualStyle === 'retest') {
    p.actualStyle = 'immediate';
  }

  // 9. Parse numerics (fast) — fail fast on a malformed payload
  const entry = parseFloat(p.entry);
  const sl    = parseFloat(p.sl);
  const tp1   = parseFloat(p.tp1);
  const _tp2r = parseFloat(p.tp2);
  const _tp3r = parseFloat(p.tp3);
  const tp2   = isFinite(_tp2r) ? _tp2r : null;
  const tp3   = isFinite(_tp3r) ? _tp3r : null;

  // Helper: notify Telegram and return 400. Used below so payload rejections
  // are always visible — previously these were silent 400s with no trace.
  const _reject400 = async (reason) => {
    const _tag = `${assetId}:${p.template}:${p.direction}:${p.timestamp || Date.now()}`;
    try {
      await sendOnce(`wh-reject:${_tag}`,
        `❌ <b>Signal REJECTED — ${pineTicker || assetId}</b>\n` +
        `Template: ${_escHtml(p.template || '?')}\n` +
        `Direction: ${_escHtml(p.direction || '?')}\n` +
        `Reason: <code>${_escHtml(reason)}</code>\n` +
        `E: ${p.entry}  SL: ${p.sl}  TP1: ${p.tp1}`);
    } catch (_) {}
    return res.status(400).json({ ok: false, error: reason });
  };

  if (!isFinite(entry) || !isFinite(sl) || !isFinite(tp1)) {
    return _reject400('invalid entry/sl/tp1 in payload');
  }
  if (Math.abs(entry - sl) === 0) {
    return _reject400('zero-risk payload: sl equals entry');
  }
  if (p.direction !== 'LONG' && p.direction !== 'SHORT') {
    return _reject400('invalid direction');
  }
  const _isLong = p.direction === 'LONG';
  // v15.8: validate TP/SL sides against the ROUTING entry — the price the order
  // actually fills at — not p.entry. For immediate signals p.immediateEntry is the
  // fill reference; for retest p.retestEntry; fallback is p.entry.
  // Independent catch for the immediate-path slDist mis-anchor bug: even if Pine
  // sends entry = OR edge, the guard will reject a TP that lands on the wrong side
  // of the actual fill price.
  const _guardImmE = parseFloat(p.immediateEntry);
  const _guardRetE = parseFloat(p.retestEntry);
  const guardEntry = p.actualStyle === 'immediate' && isFinite(_guardImmE) ? _guardImmE
                   : p.actualStyle === 'retest'    && isFinite(_guardRetE) ? _guardRetE
                   : entry;
  if (_isLong ? (sl >= guardEntry || tp1 <= guardEntry) : (sl <= guardEntry || tp1 >= guardEntry)) {
    return _reject400(`TP/SL wrong side: E=${entry} SL=${sl} TP1=${tp1} dir=${p.direction}`);
  }
  if (tp2 !== null && (_isLong ? tp2 <= guardEntry : tp2 >= guardEntry)) {
    return _reject400(`TP2 wrong side: E=${entry} TP2=${tp2} dir=${p.direction}`);
  }
  if (tp3 !== null && (_isLong ? tp3 <= guardEntry : tp3 >= guardEntry)) {
    return _reject400(`TP3 wrong side: E=${entry} TP3=${tp3} dir=${p.direction}`);
  }

  // 5. Dedupe (fast Redis read)
  const dedupeKey = `${assetId}:${p.template}:${p.direction}:${p.timestamp}`;
  if (await alreadyExecuted(dedupeKey)) {
    return res.status(200).json({ ok: true, executed: false, reason: 'duplicate-signal', dedupeKey });
  }

  // Write a 'pending' dedupe marker BEFORE the ACK. Any TradingView retry that
  // arrives while the order is in-flight will hit alreadyExecuted and be blocked
  // as a duplicate. Overwritten with the real order record on success; downgraded
  // to a short-lived failure record on broker rejection or exception.
  await markExecuted(dedupeKey, { status: 'pending', startedAt: Date.now() });

  // ---- Run the heavy pipeline. Placement MUST survive the response. ----
  // With @vercel/functions installed _waitUntil is a real function (expected
  // production path): ACK TradingView sub-second, then run the full pipeline
  // post-response via waitUntil so Vercel keeps the function alive. Without it
  // (local/dev fallback): inline-await so nothing silently drops — TV may log a
  // timeout but the order still places.
  if (typeof _waitUntil === 'function') {
    res.status(202).json({ ok: true, accepted: true, dedupeKey, ackMs: Date.now() - t0 });
    _waitUntil(
      processSignalBackground({ p, assetId, pineTicker, dedupeKey, entry, sl, tp1, tp2, tp3 })
        .catch(async (e) => {
          try { console.error('[webhook bg] error:', e && e.message); } catch (_) {}
          // QB-DIAG: surface swallowed background throws over Telegram.
          try { sendOnce(`diag-throw:${dedupeKey}`, `\ud83d\udca5 DIAG THROW \u2014 ${assetId} \u00b7 ${p.template}\n${(e && (e.stack || e.message)) ? String(e.stack || e.message).slice(0, 400) : 'unknown error'}`); } catch (_) {}
          // Downgrade pending marker so an unhandled throw doesn't block this signal for a full hour.
          await markExecuted(dedupeKey, { status: 'failed', failedAt: Date.now() }, 60);
        })
    );
    // Session-context shadow needs a live MetaAPI candle fetch and must be
    // registered here \u2014 NOT inside processSignalBackground \u2014 so Vercel includes
    // it in the lifecycle set captured before the response is sent.
    try {
      const { writeSessionCtxShadow } = require('./session-context-shadow');
      _waitUntil(writeSessionCtxShadow(p, dedupeKey, assetId).catch(() => {}));
    } catch (_scErr) {}
    // Wick-ratio shadow \u2014 capture signal bar OHLC (from Pine payload).
    // barOpen/barHigh/barLow/barClose absent until Pine scripts updated:
    // records store hasBarData:false until then.
    try {
      const { writeWickRatioShadow } = require('./wickratio-shadow');
      _waitUntil(writeWickRatioShadow(p, dedupeKey, assetId).catch(() => {}));
    } catch (_wrErr) {}
  } else {
    // Local / dev fallback: Node keeps the process alive for pending promises,
    // so a plain fire-and-forget is sufficient.
    try {
      const { writeSessionCtxShadow } = require('./session-context-shadow');
      writeSessionCtxShadow(p, dedupeKey, assetId).catch(() => {});
    } catch (_scErr) {}
    try {
      const { writeWickRatioShadow } = require('./wickratio-shadow');
      writeWickRatioShadow(p, dedupeKey, assetId).catch(() => {});
    } catch (_wrErr) {}
    try {
      await processSignalBackground({ p, assetId, pineTicker, dedupeKey, entry, sl, tp1, tp2, tp3 });
      if (!res.headersSent) res.status(200).json({ ok: true, dedupeKey, ms: Date.now() - t0 });
    } catch (e) {
      try { console.error('[webhook] inline pipeline error:', e && e.message); } catch (_) {}
      // QB-DIAG: surface swallowed inline throws over Telegram.
      try { await sendOnce(`diag-throw:${dedupeKey}`, `\ud83d\udca5 DIAG THROW (inline) \u2014 ${assetId} \u00b7 ${p.template}\n${(e && (e.stack || e.message)) ? String(e.stack || e.message).slice(0, 400) : 'unknown error'}`); } catch (_) {}
      // Downgrade pending marker on exception.
      try { await markExecuted(dedupeKey, { status: 'failed', failedAt: Date.now() }, 60); } catch (_) {}
      if (!res.headersSent) res.status(200).json({ ok: false, error: (e && e.message) || 'pipeline-error', dedupeKey });
    }
  }
};

module.exports.parseDualFormat = parseDualFormat;