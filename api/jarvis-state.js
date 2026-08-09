/* eslint-disable */
// api/jarvis-state.js  v1.0
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jarvis-state
//
// Complete quantum bot state snapshot for JARVIS reasoning.
// JARVIS calls this endpoint first on every conversation turn so that every
// reasoner has full visibility into what the bot is actually doing:
//
//   killZone      — current ICT session window
//   watchers      — per-asset watcher state (what Pine saw, what bot is waiting for)
//   rules         — active trading mode, lot sizes, tier multipliers
//   gatingRules   — which template×instrument pairs are currently blocked
//   activityLog   — last 15 bot events (signals fired, rejections, trade opens/closes)
//   sqConfig      — 3-gate signal quality config (WICK / SESSION / CVD)
//   circuitBreakers — hardcoded webhook.js constraints JARVIS must never override
//   recentTrades  — last 10 closed trade summaries (for pattern context)
//   chartBias     — live H1 + H4 structural bias per asset (reaction-filter on broker candles)
//
// SAFETY: GET only. Aggregates existing Redis data and live candles.
//   No write path. No import of execute.js or placement modules.
//   chartBias is computed via detectBias() (pure math) — no trade decisions made.
// ─────────────────────────────────────────────────────────────────────────────

const { applyCors, getRedis, safeParse } = require('./_lib');
const { checkKillZone, killZoneDisplayName } = require('./kill-zones');
const { detectBias, detectSweep, detectChoch } = require('./reaction-filter');
const { loadRules: loadGatingRules } = require('./gating-store');

// The 7 assets Pine can send signals on (from webhook.js PINE_TO_ASSET map)
const WATCHED_ASSETS = ['gold', 'nas100', 'us500', 'gbpusd', 'eurusd', 'usdjpy', 'btc'];

// Redis key builders (mirrored from each source file — not imported to avoid circular deps)
const K = {
  watcherState:  (a) => `v12:watcher:${a}:state`,
  commentary:    (a) => `v12:watcher:${a}:commentary`,
  pending:       (a) => `v12:watcher:${a}:pending`,
  rules:         ()  => 'v13:pilot:rules',
  activity:      ()  => 'v13:pilot:activity',
  sqConfig:      ()  => 'v15:squality:config',
  tradeIndex:    ()  => 'v12:trades:index',
  trade:         (id) => `v12:trades:closed:${id}`,
};

// Hardcoded circuit breakers from webhook.js — JARVIS must know these are
// system constraints, not user-configurable flags. They cannot be toggled
// from the gating panel; they require a code change.
const CIRCUIT_BREAKERS = {
  DISABLED_TEMPLATES:       ['ote-continuation'],
  SB_IMMEDIATE_ONLY:        true,
  REACTION_RETEST_BLOCK:    true,
  TEMPLATE_INSTRUMENT_BLOCKS: { orb: ['btc', 'nas100'] },
  note: 'Hardcoded in webhook.js — require code change to modify. Not configurable at runtime.',
  rationale: {
    'ote-continuation':     'Disabled permanently: recognition memory showed >72% loss rate on retest entries.',
    'SB_IMMEDIATE_ONLY':    'Silver Bullet entries only on immediate break candle; retest limit orders suppressed.',
    'REACTION_RETEST_BLOCK':'Reaction templates always immediate-only; limit retests blocked.',
    'orb-btc-nas100':       'ORB on BTC and NAS100 blocked; opening range too wide, fakeout rate too high.',
  },
};

// Readable label for each Pine timeframe
const TF_LABEL = {
  '1m':'M1', '5m':'M5', '15m':'M15', '30m':'M30',
  '1h':'H1', '4h':'H4', '1d':'D1', '1w':'W1',
};

// HTF = forms the bias; LTF = entry/trigger timeframes
const HTF_SET = new Set(['1d', '4h', '1h']);
const LTF_SET = new Set(['30m', '15m', '5m', '1m']);

// ─── Full multi-timeframe chart analysis ─────────────────────────────────────
// Uses fetchMultiTF (same function the bot uses) to get ALL timeframes at once:
//   1m, 5m, 15m, 30m, 1h, 4h, 1d — exactly what Pine scripts see.
// Then runs detectBias, detectSweep, detectChoch on every timeframe.
// Each asset call is independently try-catched so one timeout never blocks the rest.
async function buildChartBias(assets) {
  let fetchMultiTF;
  try { fetchMultiTF = require('./broker').fetchMultiTF; } catch (_) { return {}; }

  const result = {};
  await Promise.all(assets.map(async (asset) => {
    try {
      const mtf = await fetchMultiTF(asset).catch(() => null);
      if (!mtf || mtf.error || !mtf.timeframes) {
        result[asset] = { error: mtf?.error || 'no data', tfs: {} };
        return;
      }

      const tfs = {};
      for (const [tf, data] of Object.entries(mtf.timeframes)) {
        const candles = data?.candles || [];
        if (candles.length < 12) {
          tfs[tf] = { bias: null, sweep: null, choch: null, lastClose: null, candleCount: candles.length, label: TF_LABEL[tf] || tf };
          continue;
        }

        const last  = candles[candles.length - 1];
        const bias  = detectBias(candles);

        // Sweep — check the direction the bias implies, and the opposite (for countertrend taps)
        let sweep = null;
        if (candles.length >= 20) {
          const sL = detectSweep(candles, 'LONG');
          const sS = detectSweep(candles, 'SHORT');
          if (sL.swept)      sweep = { direction: 'LONG',  level: round5(sL.level), extreme: round5(sL.extreme) };
          else if (sS.swept) sweep = { direction: 'SHORT', level: round5(sS.level), extreme: round5(sS.extreme) };
        }

        // CHoCH — structural break; signals a likely direction change
        const cL = detectChoch(candles, 'LONG');
        const cS = detectChoch(candles, 'SHORT');
        let choch = null;
        if (cL.choch)      choch = { direction: 'LONG',  brokeLevel: round5(cL.brokeLevel) };
        else if (cS.choch) choch = { direction: 'SHORT', brokeLevel: round5(cS.brokeLevel) };

        tfs[tf] = {
          bias,
          sweep,
          choch,
          lastClose:   last?.close ?? null,
          candleCount: candles.length,
          label:       TF_LABEL[tf] || tf,
          isHTF:       HTF_SET.has(tf),
          isLTF:       LTF_SET.has(tf),
        };
      }

      // ── Confluence analysis ───────────────────────────────────────────────
      const biasEntries  = Object.entries(tfs).filter(([, t]) => t.bias);
      const htfEntries   = biasEntries.filter(([tf]) => HTF_SET.has(tf));
      const ltfEntries   = biasEntries.filter(([tf]) => LTF_SET.has(tf));

      const longTFs  = biasEntries.filter(([, t]) => t.bias === 'LONG').map(([tf]) => TF_LABEL[tf] || tf);
      const shortTFs = biasEntries.filter(([, t]) => t.bias === 'SHORT').map(([tf]) => TF_LABEL[tf] || tf);

      const htfLong  = htfEntries.filter(([, t]) => t.bias === 'LONG').length;
      const htfShort = htfEntries.filter(([, t]) => t.bias === 'SHORT').length;
      const htfDir   = htfLong > htfShort ? 'LONG' : htfShort > htfLong ? 'SHORT' : null;

      const ltfLong  = ltfEntries.filter(([, t]) => t.bias === 'LONG').length;
      const ltfShort = ltfEntries.filter(([, t]) => t.bias === 'SHORT').length;
      const ltfDir   = ltfLong > ltfShort ? 'LONG' : ltfShort > ltfLong ? 'SHORT' : null;

      const majority = longTFs.length > shortTFs.length ? 'LONG'
                     : shortTFs.length > longTFs.length ? 'SHORT' : null;

      // Countertrend: HTF and LTF diverge — this is a pullback / reaction tap scenario
      const countertrend = htfDir && ltfDir && htfDir !== ltfDir;
      // Aligned: all readable HTFs agree (D1 + H4 + H1 same direction)
      const aligned = htfEntries.length >= 2 && (htfLong === htfEntries.length || htfShort === htfEntries.length);

      // Any LTF CHoCH that matches HTF direction = entry trigger confirmed
      const triggerConfirmed = Object.entries(tfs)
        .filter(([tf, t]) => LTF_SET.has(tf) && t.choch && htfDir && t.choch.direction === htfDir)
        .map(([tf]) => TF_LABEL[tf] || tf);

      // H1 last close as the reference price for speech
      const lastClose = tfs['1h']?.lastClose ?? tfs['4h']?.lastClose ?? null;

      result[asset] = {
        tfs,
        confluence: {
          direction:        majority,
          htfDirection:     htfDir,
          ltfDirection:     ltfDir,
          longTFs,
          shortTFs,
          totalTFs:         biasEntries.length,
          strong:           Math.max(longTFs.length, shortTFs.length) >= Math.ceil(biasEntries.length * 0.7),
          aligned,
          countertrend,
          triggerConfirmed,
        },
        lastClose,
      };
    } catch (e) {
      result[asset] = { error: e.message, tfs: {}, confluence: null };
    }
  }));

  return result;
}

function round5(n) {
  return n != null && isFinite(n) ? +Number(n).toFixed(5) : null;
}

// ─── Recent trades summary ────────────────────────────────────────────────────
// Reads the last N closed trade IDs and fetches each record.
// Returns lightweight summaries only — JARVIS never gets raw prices/PnL/outcomes
// that could be re-computed or acted on (security constraint honoured).
async function recentTradeSummaries(r, n = 10) {
  try {
    const indexRaw = await r.get(K.tradeIndex()).catch(() => null);
    const index = safeParse(indexRaw);
    if (!Array.isArray(index) || index.length === 0) return [];

    const ids = index.slice(-n);
    const raws = await Promise.all(ids.map(id => r.get(K.trade(id)).catch(() => null)));
    return raws
      .map(raw => safeParse(raw))
      .filter(Boolean)
      .map(t => ({
        id:        t.id,
        asset:     t.asset,
        template:  t.template,
        direction: t.direction,
        outcome:   t.outcome,          // win / loss / be — read-only
        tier:      t.tier,
        session:   t.session,
        closedAt:  t.closedAt,
        // DO NOT include entry, sl, tp, pnl, mfe — security constraint
      }));
  } catch (_) {
    return [];
  }
}

// ─── Template status summary ──────────────────────────────────────────────────
// Combines circuit breakers + gating rules to give JARVIS a clear picture
// of which templates are currently active and why some are blocked.
function buildTemplateStatus(gatingRulesArr) {
  const allTemplates = [
    'silver-bullet','unicorn','turtle-soup','judas-swing',
    'ote-continuation','am-ifvg',
    'reaction','reaction-fvg','reaction-ifvg','reaction-impulse',
    'orb','orb-pro','alexg',
  ];

  const hardDisabled = CIRCUIT_BREAKERS.DISABLED_TEMPLATES;

  // Extract templates with any active block in gating store
  const gatedBlocks = gatingRulesArr
    .filter(r => r.on === false)
    .map(r => ({ template: r.template, session: r.session, instrument: r.instrument, reason: r.reason }));

  const gatedTemplates = [...new Set(gatedBlocks.map(b => b.template))];

  const enabled = allTemplates.filter(t =>
    !hardDisabled.includes(t) && !gatedTemplates.includes(t)
  );

  return {
    enabled,
    hardDisabled,
    gated:   gatedTemplates,
    gatedDetails: gatedBlocks,
    total:   allTemplates.length,
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const r = getRedis();
  if (!r) return res.status(503).json({ error: 'Redis unavailable' });

  try {
    // 1. Kill zone — pure computation, no I/O
    const killZone = checkKillZone();
    const killZoneLabel = killZoneDisplayName(killZone.name);

    // 2. Parallel Redis reads for all watcher state, rules, activity, config
    const watcherKeys = WATCHED_ASSETS.flatMap(a => [
      K.watcherState(a), K.commentary(a), K.pending(a),
    ]);

    const [
      ...watcherRaws
    ] = await Promise.all([
      ...watcherKeys.map(k => r.get(k).catch(() => null)),
    ]);

    // Reassemble per-asset watcher objects
    const watchers = {};
    WATCHED_ASSETS.forEach((asset, i) => {
      const base = i * 3;
      const state     = safeParse(watcherRaws[base])     || null;
      const commentary= safeParse(watcherRaws[base + 1]) || [];
      const pending   = safeParse(watcherRaws[base + 2]) || [];

      // Commentary: return last 5 lines only (JARVIS needs recent context, not full history)
      const recentCommentary = Array.isArray(commentary)
        ? commentary.slice(-5).map(c => ({ ts: c.ts, category: c.category, text: c.text }))
        : [];

      // Pending: active setups only
      const activePending = Array.isArray(pending)
        ? pending.filter(p => p.status === 'pending')
        : [];

      watchers[asset] = { state, recentCommentary, activePending };
    });

    // 3. Trading rules, activity log, signal quality config, gating rules
    const [rawRules, rawActivity, rawSqConfig, gatingRulesArr] = await Promise.all([
      r.get(K.rules()).catch(() => null),
      r.get(K.activity()).catch(() => null),
      r.get(K.sqConfig()).catch(() => null),
      loadGatingRules(r).then(rulesObj =>
        Object.entries(rulesObj).map(([key, v]) => {
          const [template, session, instrument] = key.split('|');
          return { key, template, session, instrument, on: v.on, updatedBy: v.updatedBy || null, reason: v.reason || null };
        })
      ).catch(() => []),
    ]);

    const rules       = safeParse(rawRules)    || {};
    const activityLog = (safeParse(rawActivity) || []).slice(-15); // last 15 events
    const sqConfig    = safeParse(rawSqConfig)  || {
      wickGateEnabled: true, wickThreshold: 0.50,
      sessionGateEnabled: true, cvdGateEnabled: true,
    };

    // 4. Recent closed trades (summary only)
    const recentTrades = await recentTradeSummaries(r);

    // 5. Chart bias (async candle fetch + detectBias) — best-effort
    const chartBias = await buildChartBias(WATCHED_ASSETS);

    // 6. Template status (cross-reference circuit breakers + gating)
    const templateStatus = buildTemplateStatus(gatingRulesArr);

    // 7. Mode summary for JARVIS quick reference
    const currentMode = rules.activeMode || 'active';
    const modeImplications = {
      active:    'All templates enabled, full lot sizing, max 5 concurrent positions.',
      defensive: 'High-confidence templates only, half lot, minimum 2R, max 2 positions.',
      sleep:     'Effectively halted — ote-continuation is the only sleep-mode template but is permanently disabled.',
      vacation:  'No new trades. Existing positions continue under manage-trades.',
    };

    return res.status(200).json({
      ts: Date.now(),
      killZone: { ...killZone, label: killZoneLabel },
      watchers,
      rules,
      currentMode,
      modeImplication: modeImplications[currentMode] || '',
      gatingRules: gatingRulesArr,
      activityLog,
      sqConfig,
      circuitBreakers: CIRCUIT_BREAKERS,
      templateStatus,
      recentTrades,
      chartBias,
      watchedAssets: WATCHED_ASSETS,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
