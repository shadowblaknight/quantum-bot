/* eslint-disable */
// api/jarvis.js  v3.0 — Quantum-Coherent Intelligence Engine
//
// POST /api/jarvis
//   body: { message: string }
//   returns: { speech, focusPanel, action, claudeRequest, urgency }
//
// JARVIS is the intelligence layer of the Quantum Bot system.
// Quantum Bot = the api files (webhook, watcher, execute, manage-trades, etc.)
// JARVIS      = the reasoning, voice, and guidance layer on top of it.
//
// They are ONE system: JARVIS reads the bot's Redis state via /api/jarvis-state
// and understands every filter, every pending setup, every circuit breaker.
// JARVIS never runs a parallel trade system — it reasons about what THE BOT is doing.
//
// Architecture:
//   1. Fetch jarvis-state (full quantum bot snapshot) + live broker data in parallel
//   2. Parse user intent from message text (15 intent categories)
//   3. Route to domain reasoner (each reasoner is aware of the bot's actual state)
//   4. Generate contextual speech + panel focus + optional action
//   5. Run anomaly scan → emit claudeRequest if something needs attention
//
// SAFETY: GET-only on all sub-endpoints. No import of execute.js.
//   Trade actions returned as structured recommendations only, never executed here.
// ----------------------------------------------------------------------------

const { applyCors, getRedis, safeParse } = require('./_lib');
const { telegramPush } = require('./telegram');

const GOAL_DAILY_KEY   = 'v1:jarvis:goal:daily';
const GOAL_MONTHLY_KEY = 'v1:jarvis:goal:monthly';
const CONTEXT_TIMEOUT  = 6000;

// ─── Context fetcher ──────────────────────────────────────────────────────────
async function fetchCtx(base) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), CONTEXT_TIMEOUT) : null;
  const sig = controller?.signal;

  const get = (path) => fetch(`${base}${path}`, sig ? { signal: sig } : {})
    .then(r => r.ok ? r.json() : null).catch(() => null);

  // jarvis-state is the primary quantum bot snapshot (Redis + chart bias)
  // All other endpoints provide live broker/session data
  const [qState, analyst, account, positions, session, news, sigQual] = await Promise.all([
    get('/api/jarvis-state'),
    get('/api/analyst'),
    get('/api/broker?action=account'),
    get('/api/broker?action=positions'),
    get('/api/session-context-summary'),
    get('/api/news-context?all=1'),
    get('/api/signal-quality-summary'),
  ]);

  if (timer) clearTimeout(timer);
  return { qState, analyst, account, positions, session, news, sigQual };
}

async function getGoals(r) {
  if (!r) return null;
  try {
    const [d, m] = await Promise.all([
      r.get(GOAL_DAILY_KEY).catch(() => null),
      r.get(GOAL_MONTHLY_KEY).catch(() => null),
    ]);
    return {
      daily:   safeParse(d)  || { target: 0, achieved: 0 },
      monthly: safeParse(m)  || { target: 0, achieved: 0 },
    };
  } catch (_) { return null; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmtEU = n => n == null ? '—' : `€${Math.abs(Number(n)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const fmt$ = n => n == null ? '—' : `$${Math.abs(Number(n)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const fmtPct = n => n == null ? '—' : `${Number(n).toFixed(1)}%`;
const signStr = n => Number(n) >= 0 ? 'up' : 'down';

const INST_NAMES = {
  XAUUSD:'Gold', GOLD:'Gold', US500:'S and P 500', NAS100:'Nasdaq 100', NDX100:'Nasdaq 100',
  GER40:'Dax 40', UK100:'FTSE 100', GBPUSD:'Cable', EURUSD:'Euro Dollar', USDJPY:'Dollar Yen',
  BTC:'Bitcoin', ETH:'Ethereum', OIL:'crude oil', XAGUSD:'Silver',
  gold:'Gold', nas100:'Nasdaq 100', us500:'S and P 500', gbpusd:'Cable',
  eurusd:'Euro Dollar', usdjpy:'Dollar Yen', btc:'Bitcoin',
};
function instName(sym) {
  if (!sym) return 'the instrument';
  const key = sym.toLowerCase().replace(/[^a-z0-9]/g,'');
  if (INST_NAMES[key]) return INST_NAMES[key];
  const up = sym.toUpperCase().replace(/[^A-Z0-9]/g,'');
  for (const [k,v] of Object.entries(INST_NAMES)) if (up.includes(k.toUpperCase())) return v;
  return sym;
}

function sessionLabel(s) {
  if (!s) return 'current session';
  const cur = s.current || s.session || s.name || '';
  if (/ny.?am/i.test(cur)) return 'New York AM';
  if (/ny.?pm/i.test(cur)) return 'New York PM';
  if (/lon/i.test(cur))    return 'London';
  if (/asia/i.test(cur))   return 'Asian';
  return cur || 'current session';
}

// Humanize watcher commentary
function latestCommentary(watcherEntry) {
  const lines = watcherEntry?.recentCommentary;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines[lines.length - 1]?.text || null;
}

// Find any asset with an active pending setup in the watcher
function findPendingSetups(watchers) {
  if (!watchers) return [];
  const found = [];
  for (const [asset, w] of Object.entries(watchers)) {
    if (Array.isArray(w.activePending) && w.activePending.length > 0) {
      w.activePending.forEach(p => found.push({ asset, ...p }));
    }
  }
  return found;
}

// DXY macro intelligence
function dxyImpact(eventName, forecast) {
  const ev = (eventName || '').toLowerCase();
  const fc = (forecast || '').toLowerCase();
  if (/fomc|rate decision|federal reserve|fed funds/i.test(ev)) {
    if (/cut|dovish|lower/i.test(fc)) return { dxy:'down', long:['Gold','Nasdaq 100','S and P 500'], short:['Dollar Yen'], note:'Rate cut expectations weaken the dollar.' };
    if (/hike|hawkish|raise/i.test(fc)) return { dxy:'up', long:['Dollar Yen'], short:['Gold','Euro Dollar'], note:'Rate hike expectations strengthen the dollar.' };
    return { dxy:'unknown', long:[], short:[], note:'Direction uncertain — position after the initial spike settles.' };
  }
  if (/nfp|non.farm|payroll/i.test(ev)) {
    if (/strong|beat|above/i.test(fc)) return { dxy:'up', long:['Dollar Yen'], short:['Gold'], note:'Strong jobs data supports the dollar.' };
    if (/weak|miss|below/i.test(fc))   return { dxy:'down', long:['Gold','Nasdaq 100'], short:[], note:'Weak jobs data pressures the dollar, supports risk-on.' };
    return { dxy:'unknown', long:[], short:[], note:'Wait for the print before positioning.' };
  }
  if (/cpi|inflation|consumer price/i.test(ev)) {
    if (/hot|high|above/i.test(fc)) return { dxy:'up', long:['Dollar Yen'], short:['Gold','Nasdaq 100'], note:'Hot CPI raises rate hike expectations.' };
    if (/cool|low|below/i.test(fc)) return { dxy:'down', long:['Gold','Nasdaq 100'], short:[], note:'Cooling inflation supports rate cut bets.' };
    return { dxy:'unknown', long:[], short:[], note:'Asymmetric reaction expected — size accordingly.' };
  }
  return null;
}

// ─── INTENT PARSER ────────────────────────────────────────────────────────────
// Asset detection helper — used to route watcher/chart queries to the right asset
const ASSET_PATTERNS = [
  { key: 'gold',   pattern: /gold|xauusd|xau/i },
  { key: 'nas100', pattern: /nas(daq)?|nas100|ndx|nasdaq|tech/i },
  { key: 'us500',  pattern: /s.?p|us500|spx|sp500/i },
  { key: 'gbpusd', pattern: /cable|gbp|pound|gbpusd/i },
  { key: 'eurusd', pattern: /euro|eur|eurusd/i },
  { key: 'usdjpy', pattern: /yen|jpy|usdjpy|dollar.?yen/i },
  { key: 'btc',    pattern: /btc|bitcoin/i },
];

function detectAsset(msg) {
  for (const a of ASSET_PATTERNS) {
    if (a.pattern.test(msg)) return a.key;
  }
  return null;
}

// Extract a new goal amount from the message.
// Only returns a value when the message contains explicit goal-setting language —
// avoids confusing "I made $500 today" (reporting) with "I want $500 today" (setting).
function parseNewGoal(msg) {
  const v = msg.toLowerCase();

  // Must have a setting verb/phrase; otherwise this is a query, not a new target
  const isSetting = /\bi\s+want\b|\bset\b|\bmy\s+target\b|\bchange.*to\b|\blower.*to\b|\braise.*to\b|\bbump.*to\b|\bmake\s+it\b|\bi\s+need\s+to\s+make\b|\btarget\s+is\b|\bgoal\s+is\b/.test(v)
    || /(\$|€|£)\s*\d/.test(v)                    // "$1000" with currency symbol
    || /\b\d+\s*k?\s*(per\s+(day|month)|today$|daily|monthly)/.test(v); // "1000 per day"

  if (!isSetting) return null;

  const isMonthly = /month|monthly/i.test(v);

  // k-notation first: "2k", "2.5k", "30k"
  const kMatch = v.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (kMatch) {
    const amount = parseFloat(kMatch[1]) * 1000;
    return amount > 0 ? { amount, isMonthly } : null;
  }

  // Plain number, allowing currency symbol before or after and comma separators
  const numMatch = v.match(/[$€£]?\s*(\d[\d,]*(?:\.\d+)?)\s*[$€£]?/);
  if (numMatch) {
    const amount = parseFloat(numMatch[1].replace(/,/g, ''));
    return amount >= 1 ? { amount, isMonthly } : null;
  }

  return null;
}

function parseIntent(msg) {
  const v = msg.toLowerCase();
  if (/fomc|nfp|cpi|pce|gdp|news|event|macro|calendar|inflation|payroll|interest rate/i.test(v))
    return 'MACRO';
  if (/^(yes|confirm|go|ok|apply\s+it|do\s+it|go\s+ahead|apply\s+sizing|execute\s+it)[.,!?\s]*$/i.test(v.trim()))
    return 'CONFIRM';
  if (/close\s+(my\s+)?(trade|position|order|gold|nas|btc|eurusd|gbpusd|usdjpy|us500|cable)|breakeven|move\s+(to\s+)?be\b|lock\s+in\s+profit|tighten\s+(the\s+)?(stop|sl)|move\s+(the\s+)?(stop|sl|tp)\b|modify\s+(the\s+)?(position|trade|stop|sl|tp)/i.test(v))
    return 'TRADE_ACTION';
  if (/calibrat|lot\s*siz|lot\s*mult|how\s+much\s+should\s+i\s+(trade|size|use)|what\s+(size|lot)\s+should/i.test(v))
    return 'CALIBRATE';
  if (/watcher|watching|pending setup|zone tap|coil|arm(ed)?|break|what.*see(ing)?|see.*chart|chart.*see/i.test(v))
    return 'WATCHER';
  if (/filter|block(ed)?|why.*not.*fire|why.*reject|gate.*reason|block.*reason|why.*fail|template.*block|circuit breaker|disabled/i.test(v))
    return 'FILTER';
  if (/signal|entry|setup|confirm|fire|armed|reaction|orb|silver.?bullet|fvg/i.test(v))
    return 'SIGNAL';
  if (/gate|filter|check|ready|block|pass|fail/i.test(v))
    return 'GATES';
  if (/position|open|exposure|float|unreali/i.test(v))
    return 'POSITIONS';
  if (/performance|p&l|pnl|equity|how.*doing|doing|today.*money|money.*today|profit|loss|stat/i.test(v))
    return 'PERFORMANCE';
  if (/goal|target|want|need|make|month|thousand|k€|€|euros?/i.test(v) && /\d/.test(v))
    return 'GOAL';
  if (/session|ny|london|asia|kill.?zone|window|time/i.test(v))
    return 'SESSION';
  if (/pine|qb.ict|qb.rxn|qb.orb|reaction.*engine|script|timeframe|ict|cvd|adr/i.test(v))
    return 'PINE';
  if (/compass|momentum|regime|trend|direction/i.test(v))
    return 'COMPASS';
  if (/knn|similar|nearest|confidence|neighbor|pattern match/i.test(v))
    return 'KNN';
  if (/advise|recommend|what should|best move|next step|what do you think|should i/i.test(v))
    return 'ADVISE';
  if (/risk|danger|draw.?down|stop|protect|safe/i.test(v))
    return 'RISK';
  return 'OPEN';
}

// ─── REASONERS ───────────────────────────────────────────────────────────────

// WATCHER: Report what the quantum bot is currently observing per asset
function reasonWatcher(ctx, message) {
  const { qState, analyst } = ctx;
  const watchers  = qState?.watchers || {};
  const chartBias = qState?.chartBias || {};
  const killZone  = qState?.killZone;

  const assetKey = detectAsset(message);

  // Single asset query
  if (assetKey && watchers[assetKey]) {
    const w  = watchers[assetKey];
    const cb = chartBias[assetKey] || {};
    const last = latestCommentary(w);
    const pending = w.activePending || [];

    let speech = `${instName(assetKey)} watcher report, Sir.`;

    if (pending.length > 0) {
      const s = pending[0];
      speech += ` Active pending setup: ${s.templateName || 'setup'} — ${s.narrative || 'armed for entry'}.`;
      if (s.plannedEntry) speech += ` Entry target: ${s.plannedEntry}.`;
    } else {
      speech += ' No active pending setup.';
    }

    // Full MTF bias read (same view Pine has)
    const conf = cb.confluence;
    if (conf) {
      const longTFs  = conf.longTFs  || [];
      const shortTFs = conf.shortTFs || [];
      if (conf.strong && conf.direction) {
        speech += ` ${conf.direction === 'LONG' ? 'Bullish' : 'Bearish'} across ${conf.direction === 'LONG' ? longTFs : shortTFs} — strong ${conf.direction === 'LONG' ? longTFs.length : shortTFs.length} of ${conf.totalTFs} timeframes.`;
      } else if (longTFs.length || shortTFs.length) {
        if (longTFs.length) speech += ` Bullish on ${longTFs.join(', ')}.`;
        if (shortTFs.length) speech += ` Bearish on ${shortTFs.join(', ')}.`;
      }
      if (conf.countertrend) speech += ` HTF says ${conf.htfDirection === 'LONG' ? 'bullish' : 'bearish'}, LTF says ${conf.ltfDirection === 'LONG' ? 'bullish' : 'bearish'} — countertrend tap scenario. Reaction filter will check location.`;
      if (conf.triggerConfirmed?.length) speech += ` ${conf.triggerConfirmed.join(', ')} CHoCH confirmed in HTF direction — entry trigger present.`;
    } else {
      const d1b  = cb.tfs?.['1d']?.bias;
      const h4b  = cb.tfs?.['4h']?.bias;
      const h1b  = cb.tfs?.['1h']?.bias;
      if (d1b)  speech += ` Daily: ${d1b === 'LONG' ? 'bullish' : 'bearish'}.`;
      if (h4b)  speech += ` H4: ${h4b === 'LONG' ? 'bullish' : 'bearish'}.`;
      if (h1b)  speech += ` H1: ${h1b === 'LONG' ? 'bullish' : 'bearish'}.`;
    }
    // H1 sweep from MTF structure
    const h1Sweep = cb.tfs?.['1h']?.sweep;
    if (h1Sweep) speech += ` H1 shows recent ${h1Sweep.direction === 'LONG' ? 'low sweep' : 'high sweep'} at ${h1Sweep.level} — structure disruption confirmed.`;
    if (last) speech += ` Bot commentary: "${last}".`;

    return { speech, focusPanel: 'signal', urgency: pending.length > 0 ? 'elevated' : 'normal' };
  }

  // No asset specified — scan all watchers for any active state
  const activePending = findPendingSetups(watchers);

  if (activePending.length > 0) {
    const lines = activePending.map(p =>
      `${instName(p.asset)} — ${p.templateName || 'setup'}, ${p.narrative || 'armed'}`
    ).join('; ');
    return {
      speech: `The bot has ${activePending.length} active pending setup${activePending.length > 1 ? 's' : ''}, Sir: ${lines}. These are armed and waiting for the break confirmation from Pine.`,
      focusPanel: 'signal',
      urgency: 'elevated',
    };
  }

  // Summarise chart bias across all assets (using new MTF structure)
  const bullish  = Object.entries(chartBias).filter(([,b]) => b.confluence?.aligned && b.confluence?.htfDirection === 'LONG').map(([a]) => instName(a));
  const bearish  = Object.entries(chartBias).filter(([,b]) => b.confluence?.aligned && b.confluence?.htfDirection === 'SHORT').map(([a]) => instName(a));
  const mixed    = Object.entries(chartBias).filter(([,b]) => b.confluence?.countertrend).map(([a]) => instName(a));
  const kzStr    = killZone?.inKillZone ? `Inside the ${killZone.label} kill zone.` : (killZone?.nextKillZone ? `Next kill zone: ${killZoneDisplayName(killZone.nextKillZone)} in ${killZone.minutesUntilNext} minutes.` : '');

  let speech = `Quantum bot is monitoring all 7 instruments, Sir. No active pending setups.`;
  if (bullish.length)  speech += ` Bullish-aligned: ${bullish.join(', ')}.`;
  if (bearish.length)  speech += ` Bearish-aligned: ${bearish.join(', ')}.`;
  if (mixed.length)    speech += ` Countertrend scenarios: ${mixed.join(', ')}.`;
  if (kzStr) speech += ` ${kzStr}`;
  speech += ` Pine will alert me the moment a setup fires. I am watching.`;

  return { speech, focusPanel: 'signal', urgency: 'normal' };
}

// Exported for use in reasonWatcher when no qState available
function killZoneDisplayName(name) {
  const names = {
    LONDON:'London', NY_AM:'New York AM',
    LONDON_CLOSE:'London Close', NY_PM:'New York PM Silver Bullet', OFF_HOURS:'Off-Hours',
  };
  return names[name] || name;
}

// FILTER: Explain the bot's filter stack — why something was or wasn't taken
function reasonFilter(ctx, message) {
  const { qState } = ctx;
  const cb   = qState?.circuitBreakers || {};
  const ts   = qState?.templateStatus  || {};
  const sq   = qState?.sqConfig        || {};
  const gating = qState?.gatingRules   || [];
  const mode   = qState?.currentMode   || 'active';

  const assetKey    = detectAsset(message);
  const v = message.toLowerCase();

  // Check for specific circuit breaker questions
  if (/ote|ote.cont/i.test(v)) {
    return {
      speech: `OTE-continuation is permanently disabled, Sir. It is a hardcoded circuit breaker in webhook.js — not a gating flag. Recognition memory showed it had a very high loss rate on retest entries, so it was switched off at the code level. It cannot be re-enabled from the dashboard.`,
      focusPanel: 'gates',
      urgency: 'normal',
    };
  }
  if (/silver.?bullet|sb/i.test(v) && /retest|limit|block/i.test(v)) {
    return {
      speech: `Silver Bullet limit-entry retests are blocked, Sir. The S-B-immediate-only circuit breaker is active in webhook.js. Only the immediate break candle entry is allowed. Recognition memory showed a 72% loss rate on short-hold retest positions. This is a hardcoded protection, not a gating flag.`,
      focusPanel: 'gates',
      urgency: 'normal',
    };
  }
  if (/reaction.*retest|retest.*reaction/i.test(v)) {
    return {
      speech: `Reaction template retests are also blocked, Sir. The REACTION-RETEST-BLOCK flag is active in webhook.js. Reaction entries are always immediate — no limit re-entries. Same reasoning as Silver Bullet: retest entries on this template family showed poor expectancy.`,
      focusPanel: 'gates',
      urgency: 'normal',
    };
  }

  // Asset-specific gating query
  if (assetKey) {
    const assetBlocks = gating.filter(g => g.instrument === assetKey && g.on === false);
    if (assetBlocks.length > 0) {
      const lines = assetBlocks.map(b => `${b.template} in ${b.session === '*' ? 'all sessions' : b.session}`).join('; ');
      return {
        speech: `${instName(assetKey)} has ${assetBlocks.length} active block${assetBlocks.length > 1 ? 's' : ''} in the gating store, Sir: ${lines}. These were set because of historically poor template-instrument fit on this asset. They override the general template availability.`,
        focusPanel: 'gates',
        urgency: 'normal',
      };
    }

    // ORB instrument block check
    const orbBlocked = cb.TEMPLATE_INSTRUMENT_BLOCKS?.orb?.includes(assetKey);
    if (orbBlocked) {
      return {
        speech: `ORB is hardcoded-blocked on ${instName(assetKey)}, Sir. The opening range on this instrument is too wide and generates too many fakeouts. This block lives in webhook.js alongside the other circuit breakers.`,
        focusPanel: 'gates',
        urgency: 'normal',
      };
    }

    return {
      speech: `No specific blocks on ${instName(assetKey)}, Sir. It is subject to the standard filter stack: kill zone timing, signal quality gates (wick ratio, session score, CVD), current mode — ${mode} — and any general gating rules. The bot will trade it if all gates clear and Pine fires a qualifying signal.`,
      focusPanel: 'gates',
      urgency: 'normal',
    };
  }

  // General filter stack explanation
  const gated = ts.gated || [];
  const hardDisabled = ts.hardDisabled || [];
  const sqLines = [
    sq.wickGateEnabled ? `wick ratio must be below ${sq.wickThreshold || 0.50}` : null,
    sq.sessionGateEnabled ? 'session structural score must be NEUTRAL or better' : null,
    sq.cvdGateEnabled ? 'CVD must not be counter-trend on low-trust candles' : null,
  ].filter(Boolean);

  return {
    speech: `Filter stack summary, Sir. Hard-disabled in code: ${hardDisabled.join(', ')}. Gating-store blocks: ${gated.length > 0 ? gated.join(', ') : 'none beyond hardcoded'}. Signal quality gates: ${sqLines.join('; ')}. Mode is ${mode} — ${qState?.modeImplication || ''}. Kill zone gate is also active — only signals arriving inside a recognised session window pass.`,
    focusPanel: 'gates',
    urgency: 'normal',
  };
}

function reasonSignal(ctx) {
  const { analyst, sigQual, qState } = ctx;
  const watchers      = qState?.watchers || {};
  const chartBias     = qState?.chartBias || {};
  const top    = analyst?.brief?.topSetup  || analyst?.brief?.latestSignal || null;
  const knn    = top?.knn  || analyst?.brief?.knnScore  || sigQual?.knnScore || null;
  const gates  = analyst?.brief?.gatesPass || null;
  const total  = analyst?.brief?.gatesTotal || 8;
  const template   = top?.template   || analyst?.brief?.template   || null;
  const instrument = top?.symbol     || top?.instrument || analyst?.brief?.symbol || null;
  const direction  = top?.direction  || null;

  // Check watcher for any pending setups
  const pending = findPendingSetups(watchers);

  if (!top && pending.length === 0 && !knn) {
    // Report full MTF bias as a substitute signal read
    const bullish = Object.entries(chartBias).filter(([,b]) => b.confluence?.aligned && b.confluence?.htfDirection === 'LONG').map(([a]) => instName(a));
    const bearish = Object.entries(chartBias).filter(([,b]) => b.confluence?.aligned && b.confluence?.htfDirection === 'SHORT').map(([a]) => instName(a));
    let speech = `No confirmed setup in the pipeline right now, Sir.`;
    if (bullish.length) speech += ` Charts favour bullish on ${bullish.slice(0,2).join(' and ')}.`;
    if (bearish.length) speech += ` Bearish structure on ${bearish.slice(0,2).join(' and ')}.`;
    speech += ` I am armed across all templates and waiting for Pine to send a qualifying alert.`;
    return { speech, focusPanel: 'signal', urgency: 'normal' };
  }

  if (pending.length > 0 && !top) {
    const p  = pending[0];
    const cb = chartBias[p.asset] || {};
    const conf = cb.confluence;
    const biasLine = conf?.htfDirection ? ` HTF bias: ${conf.htfDirection === 'LONG' ? 'bullish' : 'bearish'} (${conf.longTFs?.length || 0} of ${conf.totalTFs} TFs aligned).` : '';
    return {
      speech: `Bot has an armed setup pending, Sir: ${p.templateName || 'setup'} on ${instName(p.asset)}.${biasLine} ${p.narrative || 'Waiting for break confirmation.'} No live signal from analyst yet — this is a watcher-held setup.`,
      focusPanel: 'signal',
      urgency: 'elevated',
    };
  }

  const knnStr  = knn != null ? `K-N-N match at ${knn}%.` : '';
  const gateStr = gates != null ? `${gates} of ${total} gates clear.` : 'All gates nominal.';
  const instStr = instrument ? instName(instrument) : 'the primary instrument';
  const dirStr  = direction === 'SHORT' ? 'short' : 'long';
  const tplStr  = template ? `${template} template.` : '';
  const cb      = instrument ? (chartBias[instrument] || chartBias[instrument?.toLowerCase()] || {}) : {};
  const conf    = cb.confluence;
  const biasConf = conf?.aligned ? ` HTF structure aligned — ${conf.longTFs?.length || conf.shortTFs?.length} of ${conf.totalTFs} timeframes in sync.`
                 : conf?.countertrend ? ` Countertrend tap — HTF ${conf.htfDirection === 'LONG' ? 'bullish' : 'bearish'}, LTF ${conf.ltfDirection === 'LONG' ? 'bullish' : 'bearish'}. Location filter applied.`
                 : '';

  return {
    speech: `${direction === 'SHORT' ? 'Bearish' : 'Bullish'} signal from analyst, Sir. ${dirStr} on ${instStr} via ${tplStr}${biasConf} ${knnStr} ${gateStr}`,
    focusPanel: 'signal',
    urgency: knn != null && knn >= 85 ? 'elevated' : 'normal',
  };
}

function reasonGates(ctx) {
  const { analyst, qState } = ctx;
  const brief  = analyst?.brief || {};
  const pass   = brief.gatesPass  ?? null;
  const total  = brief.gatesTotal ?? 8;
  const readiness = brief.signalReady ?? (pass != null && pass >= total * 0.875);
  const sqCfg  = qState?.sqConfig || {};
  const mode   = qState?.currentMode || 'active';
  const ts     = qState?.templateStatus || {};

  const sqSummary = [
    sqCfg.wickGateEnabled !== false ? `wick gate on (${sqCfg.wickThreshold || 0.50})` : 'wick gate OFF',
    sqCfg.sessionGateEnabled !== false ? 'session gate on' : 'session gate OFF',
    sqCfg.cvdGateEnabled !== false ? 'CVD gate on' : 'CVD gate OFF',
  ].join(', ');

  if (pass == null) {
    return {
      speech: `Gate system nominal, Sir. Mode: ${mode}. Signal quality: ${sqSummary}. Hard-disabled templates: ${(ts.hardDisabled || []).join(', ') || 'none'}. ${(ts.gated || []).length > 0 ? `Gating-store blocks: ${ts.gated.join(', ')}.` : ''} Waiting for a qualified Pine signal.`,
      focusPanel: 'gates',
      urgency: 'normal',
    };
  }

  const blocked = total - pass;
  const statusLine = readiness
    ? `Signal ready — ${pass} of ${total} gates clear.`
    : `${blocked} gate${blocked !== 1 ? 's' : ''} blocking — not signal ready.`;

  return {
    speech: `${statusLine} ${brief.gateBlockReason ? `Blocking condition: ${brief.gateBlockReason}.` : ''} Signal quality: ${sqSummary}. Mode: ${mode}. ${readiness ? 'Good to execute on next qualifying setup.' : 'Holding until blocked condition resolves.'}`,
    focusPanel: 'gates',
    urgency: readiness ? 'normal' : 'elevated',
  };
}

function reasonPositions(ctx) {
  const { positions, account } = ctx;
  const pos = Array.isArray(positions) ? positions : [];

  if (pos.length === 0) {
    const eq = account?.balance || account?.equity;
    return {
      speech: `No open positions at the moment, Sir. ${eq ? `Equity at ${fmt$(eq)}.` : ''} Capital liquid and ready.`,
      focusPanel: 'positions',
      urgency: 'normal',
    };
  }

  const totalFloat = pos.reduce((s, p) => s + (Number(p.unrealizedProfit) || 0), 0);
  const floatSign  = totalFloat >= 0 ? 'positive' : 'negative';
  const posLines   = pos.map(p => `${instName(p.symbol)} ${(p.type||'').toLowerCase()} ${p.volume ? p.volume + ' lot' : ''}`).join(', ');

  return {
    speech: `${pos.length} open position${pos.length !== 1 ? 's' : ''}, Sir. ${posLines}. Float ${floatSign}: ${fmt$(totalFloat)}. ${totalFloat < 0 ? 'Monitoring for structural invalidation.' : 'Tracking in your favour.'}`,
    focusPanel: 'positions',
    urgency: totalFloat < -200 ? 'elevated' : 'normal',
  };
}

function reasonPerformance(ctx, goals) {
  const { account, positions } = ctx;
  const eq  = account?.balance || account?.equity || 0;
  const pnl = account?.todayPnl || account?.profit || 0;
  const pct  = eq > 0 ? (pnl / eq * 100) : 0;
  const pos  = Array.isArray(positions) ? positions.length : 0;

  let goalLine = '';
  if (goals?.daily?.target > 0) {
    const rem  = Math.max(0, goals.daily.target - goals.daily.achieved);
    const dpct = (goals.daily.achieved / goals.daily.target * 100).toFixed(0);
    goalLine = ` Daily goal: ${dpct}%. ${rem > 0 ? `${fmtEU(rem)} remaining.` : 'Daily target reached.'}`;
  }

  return {
    speech: `Equity at ${fmt$(eq)}, ${signStr(pnl)} ${fmt$(pnl)} today — ${fmtPct(Math.abs(pct))} on the session. ${pos > 0 ? `${pos} position${pos > 1 ? 's' : ''} running.` : 'All flat.'}${goalLine}`,
    focusPanel: 'performance',
    urgency: pnl < -500 ? 'elevated' : 'normal',
  };
}

async function reasonGoal(goals, ctx, message, r, base) {
  // ── Try to set a new goal from the message ─────────────────────────────
  const newGoal = message ? parseNewGoal(message) : null;

  if (newGoal) {
    try {
      const body = newGoal.isMonthly
        ? { monthlyTarget: newGoal.amount }
        : { dailyTarget:   newGoal.amount };

      const resp = await fetch(`${base}/api/jarvis-goal`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));

      if (data.ok) {
        // Use the freshly written values for calibration
        const updatedGoals = {
          daily:   data.daily   || goals?.daily   || { target: 0, achieved: 0 },
          monthly: data.monthly || goals?.monthly || { target: 0, achieved: 0 },
        };

        // Auto-chain into sizing calibration with the new target
        const sizing = await reasonCalibrate(ctx, updatedGoals, r);
        const typeStr = newGoal.isMonthly ? 'Monthly' : 'Daily';
        const amtStr  = fmt$(newGoal.amount);

        return {
          speech:     `${typeStr} target set at ${amtStr}, Sir. ${sizing.speech}`,
          focusPanel: 'goal',
          urgency:    sizing.urgency || 'normal',
          action:     sizing.action,
        };
      }
    } catch (_) {
      // Fall through to reporting if the write fails
    }
  }

  // ── Report existing goal state ─────────────────────────────────────────
  if (!goals || (!goals.daily?.target && !goals.monthly?.target)) {
    return {
      speech:     `No profit targets set, Sir. Tell me what you want — for example: "I want $1000 per day" or "monthly target $30,000". I will calibrate session priorities accordingly.`,
      focusPanel: 'goal',
      urgency:    'normal',
    };
  }

  if (goals.monthly?.target > 0) {
    const remaining   = Math.max(0, goals.monthly.target - goals.monthly.achieved);
    const pct         = (goals.monthly.achieved / goals.monthly.target * 100).toFixed(0);
    const now         = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth  = now.getDate();
    const tradingDone = Math.round(dayOfMonth * 5 / 7);
    const tradingFull = Math.round(daysInMonth * 5 / 7);
    const expectedPct = ((tradingDone / tradingFull) * 100).toFixed(0);
    const onTrack     = goals.monthly.achieved >= (goals.monthly.target * tradingDone / tradingFull * 0.85);
    const sessionsLeft= Math.max(1, (tradingFull - tradingDone) * 2);
    const reqPerSess  = (remaining / sessionsLeft).toFixed(0);

    const trackLine = onTrack
      ? `On track — ${pct}% versus ${expectedPct}% expected.`
      : `Behind pace — ${pct}% complete, ${expectedPct}% expected. Calibrating for higher-conviction setups only.`;

    return {
      speech:     `Monthly target: ${fmt$(goals.monthly.target)}. Achieved: ${fmt$(goals.monthly.achieved)}. ${remaining > 0 ? `${fmt$(remaining)} remaining across ${sessionsLeft} sessions — ${fmt$(reqPerSess)} per session.` : 'Monthly target achieved, Sir.'} ${trackLine}`,
      focusPanel: 'goal',
      urgency:    onTrack ? 'normal' : 'elevated',
    };
  }

  // Prefer daily.achieved (maintained by addGoalPnL). Fall back to broker todayPnl if not yet tracking.
  const todayPnl      = ctx?.account?.todayPnl || 0;
  const dailyAchieved = goals.daily.achieved !== 0 ? goals.daily.achieved : Math.max(0, todayPnl);
  const rem  = Math.max(0, goals.daily.target - dailyAchieved);
  const dpct = goals.daily.target > 0 ? (dailyAchieved / goals.daily.target * 100).toFixed(0) : 0;
  return {
    speech:     `Daily target: ${fmt$(goals.daily.target)}. At ${fmt$(dailyAchieved)} — ${dpct}% complete. ${rem > 0 ? `${fmt$(rem)} still needed today.` : 'Daily target met, Sir.'}`,
    focusPanel: 'goal',
    urgency:    'normal',
  };
}

function reasonSession(ctx) {
  const { session, news, qState } = ctx;
  const kz    = qState?.killZone;
  const cur   = sessionLabel(session);
  const stage = session?.stage || null;
  const bias  = session?.bias  || null;
  const minsIn   = session?.minutesIntoSession ?? null;
  const minsLeft = session?.minutesRemaining   ?? null;

  const nextNews = Array.isArray(news?.upcoming)
    ? news.upcoming.find(n => n.impact === 'high')
    : null;

  let speech = `${cur} session is${stage ? ` in the ${stage} phase` : ' active'}, Sir.`;
  if (kz?.inKillZone)    speech += ` Currently inside the ${kz.label} kill zone.`;
  else if (kz?.nextKillZone) speech += ` Next kill zone: ${killZoneDisplayName(kz.nextKillZone)} in ${kz.minutesUntilNext} minutes.`;
  if (bias)       speech += ` Structural bias: ${bias}.`;
  if (minsIn  != null) speech += ` ${minsIn} minutes in.`;
  if (minsLeft!= null) speech += ` ${minsLeft} minutes remaining.`;
  if (nextNews)   speech += ` Next high-impact event: ${nextNews.event} in ${nextNews.minutesAway} minutes.`;

  return {
    speech,
    focusPanel: 'signal',
    urgency: minsLeft != null && minsLeft < 15 ? 'elevated' : 'normal',
  };
}

function reasonMacro(ctx, message) {
  const { news, session } = ctx;
  const upcoming = Array.isArray(news?.upcoming) ? news.upcoming : [];
  const high = upcoming.filter(n => n.impact === 'high');

  if (high.length === 0) {
    return {
      speech: `Economic calendar clear of high-impact events for the next several hours, Sir. Pure technical conditions — ideal for our templates.`,
      focusPanel: 'news',
      urgency: 'normal',
    };
  }

  const mentioned = high.find(n =>
    message.toLowerCase().split(/\s+/).some(w => n.event?.toLowerCase().includes(w))
  ) || high[0];

  const impact = dxyImpact(mentioned.event, mentioned.forecast || '');
  const timeStr = mentioned.minutesAway != null
    ? (mentioned.minutesAway < 60 ? `in ${mentioned.minutesAway} minutes` : `in ${Math.round(mentioned.minutesAway/60)} hours`)
    : `at ${mentioned.time || 'an upcoming time'}`;

  let speech = `${mentioned.event}, ${mentioned.currency || ''}, ${timeStr}.`;
  if (impact) {
    if (impact.dxy === 'down') {
      speech += ` ${impact.note} I favour ${impact.long.slice(0,2).join(' and ')} long${impact.short.length ? `, watching ${impact.short[0]} short` : ''}.`;
    } else if (impact.dxy === 'up') {
      speech += ` ${impact.note} Positioning favours ${impact.long.length ? impact.long[0] + ' long' : ''}${impact.short.length ? ` and ${impact.short.slice(0,2).join(', ')} short` : ''}.`;
    } else {
      speech += ` ${impact.note} Reduced size and wait for the initial move to commit.`;
    }
    speech += ` This is not a time to step aside — it is a time to be positioned correctly.`;
  } else {
    speech += mentioned.minutesAway < 20
      ? ` That is close — no new entries until we clear this event.`
      : ` Sufficient time for clean setups before the event window.`;
  }

  return { speech, focusPanel: 'news', urgency: mentioned.minutesAway < 15 ? 'elevated' : 'normal' };
}

function reasonPine(ctx, message) {
  const v = message.toLowerCase();
  const { analyst, session, qState } = ctx;
  const brief     = analyst?.brief || {};
  const chartBias = qState?.chartBias || {};
  const watchers  = qState?.watchers  || {};

  let script = 'ict';
  if (/rxn|reaction|impulse|tap/.test(v)) script = 'rxn';
  if (/orb/.test(v)) script = 'orb';

  const panels = { ict: 'pine-ict', rxn: 'pine-rxn', orb: 'pine-orb' };
  const labels = { ict: 'QB-ICT', rxn: 'QB-Reaction', orb: 'QB-ORB-Pro' };
  const kz     = qState?.killZone;

  let speech = `${labels[script]} status, Sir.`;

  // Kill zone context from live state
  if (kz?.inKillZone) speech += ` Active window: ${kz.label}.`;
  else if (kz?.nextKillZone) speech += ` Next window: ${killZoneDisplayName(kz.nextKillZone)} in ${kz.minutesUntilNext} minutes.`;

  // Full MTF structure across all instruments (same view Pine has)
  const aligned = Object.entries(chartBias)
    .filter(([, b]) => b.confluence?.aligned)
    .map(([a, b]) => {
      const dir = b.confluence.htfDirection === 'LONG' ? 'bull' : 'bear';
      const tfs = b.confluence.htfDirection === 'LONG' ? b.confluence.longTFs : b.confluence.shortTFs;
      return `${instName(a)} ${dir} (${(tfs || []).join('/')})`;
    });
  const counterTrend = Object.entries(chartBias)
    .filter(([, b]) => b.confluence?.countertrend)
    .map(([a, b]) => `${instName(a)} HTF ${b.confluence.htfDirection === 'LONG' ? 'bull' : 'bear'}/LTF ${b.confluence.ltfDirection === 'LONG' ? 'bull' : 'bear'}`);
  if (aligned.length)      speech += ` Aligned: ${aligned.slice(0,4).join(', ')}.`;
  if (counterTrend.length) speech += ` Countertrend taps: ${counterTrend.slice(0,2).join(', ')}.`;

  if (script === 'rxn') {
    // Find any reaction pending setups in watcher
    const rxnPending = findPendingSetups(watchers).filter(p =>
      p.templateName?.includes('reaction')
    );
    if (rxnPending.length > 0) {
      speech += ` Active reaction setup: ${rxnPending[0].asset} — ${rxnPending[0].narrative || 'armed for impulse confirmation'}.`;
    } else {
      speech += ` QB-Reaction monitors tap → coil → break sequences on H1 and H4 zones. Three paths: FVG-confirm, IFVG-inversion, and impulse direct. Currently scanning — no active reaction setup.`;
    }
  }

  if (script === 'orb') {
    const minsIn = session?.minutesIntoSession;
    speech += ` ORB-Pro activates at session open. ${minsIn != null && minsIn < 15 ? 'We are inside the ORB formation window.' : ''} Note: ORB is hardcoded-blocked on BTC and Nasdaq.`;
  }

  return { speech, focusPanel: panels[script], urgency: 'normal' };
}

function reasonCompass(ctx) {
  const { analyst, session, qState } = ctx;
  const regime     = analyst?.brief?.regime || analyst?.brief?.marketRegime || null;
  const bias       = session?.bias || analyst?.brief?.sessionBias || null;
  const chartBias  = qState?.chartBias || {};

  // Full MTF confluence per instrument
  const bullish    = Object.entries(chartBias).filter(([,b]) => b.confluence?.aligned && b.confluence?.htfDirection === 'LONG')
    .map(([a, b]) => `${instName(a)} (${(b.confluence.longTFs || []).join('/')})`);
  const bearish    = Object.entries(chartBias).filter(([,b]) => b.confluence?.aligned && b.confluence?.htfDirection === 'SHORT')
    .map(([a, b]) => `${instName(a)} (${(b.confluence.shortTFs || []).join('/')})`);
  const divergent  = Object.entries(chartBias).filter(([,b]) => b.confluence?.countertrend)
    .map(([a, b]) => `${instName(a)} HTF-${b.confluence.htfDirection}/LTF-${b.confluence.ltfDirection}`);
  const triggered  = Object.entries(chartBias).filter(([,b]) => b.confluence?.triggerConfirmed?.length > 0)
    .map(([a, b]) => `${instName(a)} (${b.confluence.triggerConfirmed?.join(',')} CHoCH)`);

  let speech = regime ? `Market regime: ${regime}.` : `Full multi-timeframe scan across all instruments, Sir.`;
  if (bias)            speech += ` Session structural bias: ${bias}.`;
  if (bullish.length)  speech += ` Bullish: ${bullish.join(', ')}.`;
  if (bearish.length)  speech += ` Bearish: ${bearish.join(', ')}.`;
  if (divergent.length) speech += ` Countertrend: ${divergent.join(', ')}.`;
  if (triggered.length) speech += ` Entry triggers confirmed: ${triggered.slice(0,2).join(', ')}.`;

  return { speech, focusPanel: 'compass', urgency: 'normal' };
}

function reasonKNN(ctx) {
  const { analyst, sigQual, qState } = ctx;
  const knn    = sigQual?.knnScore    || analyst?.brief?.knnScore    || null;
  const n      = sigQual?.knnNeighbours || analyst?.brief?.knnN       || null;
  const avgR   = sigQual?.knnAvgR      || analyst?.brief?.knnAvgR     || null;
  const knnWR  = sigQual?.knnWinRate   || analyst?.brief?.knnWR       || null;
  const trades = qState?.recentTrades  || [];

  if (!knn) {
    const tradeCount = trades.length;
    return {
      speech: `The K-N-N recognition model is scanning against the trade history, Sir. ${tradeCount > 0 ? `Last ${tradeCount} closed trades are in memory.` : ''} It scores each new setup against the nearest structural matches. Above 80% confidence is the execution threshold.`,
      focusPanel: 'knn',
      urgency: 'normal',
    };
  }

  const level  = knn >= 85 ? 'exceptional' : knn >= 75 ? 'high' : knn >= 60 ? 'moderate' : 'below threshold';
  const speech = `K-N-N score: ${knn}% — ${level} confidence. ${n ? `${n} nearest neighbours.` : ''} ${avgR ? `Average outcome on matched setups: ${avgR} R.` : ''} ${knnWR ? `Win rate on similar setups: ${knnWR}%.` : ''} ${knn >= 80 ? 'This is executable.' : 'Waiting for a higher-confidence read.'}`;

  return { speech, focusPanel: 'knn', urgency: knn >= 85 ? 'elevated' : 'normal' };
}

function reasonAdvise(ctx, goals) {
  const { account, positions, analyst, session, news, qState } = ctx;
  const pos    = Array.isArray(positions) ? positions : [];
  const eq     = account?.balance || account?.equity || 0;
  const pnl    = account?.todayPnl || 0;
  const knn    = analyst?.brief?.knnScore || null;
  const gates  = analyst?.brief?.gatesPass || null;
  const total  = analyst?.brief?.gatesTotal || 8;
  const regime = analyst?.brief?.regime || null;
  const top    = analyst?.brief?.topSetup || null;
  const mode   = qState?.currentMode || 'active';
  const pending = findPendingSetups(qState?.watchers || {});

  const imminent = Array.isArray(news?.upcoming)
    ? news.upcoming.find(n => n.impact === 'high' && (n.minutesAway || 999) < 20)
    : null;

  if (imminent) {
    return {
      speech: `Hold fire, Sir. ${imminent.event} in ${imminent.minutesAway} minutes — high impact. Spread will widen on entry. Wait for the initial reaction to commit, then look for a retest with clean structure.`,
      focusPanel: 'news',
      urgency: 'elevated',
      action: { type: 'wait', reason: 'imminent_news' },
    };
  }

  if (top && knn >= 80 && gates != null && gates >= total * 0.875) {
    const inst = instName(top.symbol || top.instrument);
    const dir  = top.direction === 'SHORT' ? 'short' : 'long';
    return {
      speech: `Execute the ${top.template || 'current'} ${dir} on ${inst}, Sir. K-N-N at ${knn}%, ${gates} of ${total} gates clear. ${regime ? `Regime is ${regime}.` : ''} This is the setup we wait for.`,
      focusPanel: 'signal',
      urgency: 'elevated',
      action: { type: 'recommend_trade', details: top },
    };
  }

  if (pending.length > 0) {
    const p = pending[0];
    return {
      speech: `The bot has a watcher-held setup on ${instName(p.asset)}, Sir: ${p.templateName || 'setup'} — ${p.narrative || 'armed'}. This will auto-execute when Pine sends the break confirmation. No manual action needed — the system is handling it.`,
      focusPanel: 'signal',
      urgency: 'elevated',
    };
  }

  if (goals?.monthly?.target > 0) {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expectedPct = now.getDate() / daysInMonth;
    const achievedPct = goals.monthly.achieved / goals.monthly.target;
    if (achievedPct < expectedPct * 0.7) {
      return {
        speech: `Behind on the monthly target, Sir. My recommendation: tighten the filter — Tier A setups only, K-N-N above 80%, all gates green, kill zone active. The mode is currently ${mode}. Consider switching to defensive to enforce minimum 2R. Fewer but better trades. The remaining sessions are enough if we are selective.`,
        focusPanel: 'goal',
        urgency: 'elevated',
      };
    }
  }

  const cur = sessionLabel(session);
  return {
    speech: `Conditions, Sir: ${cur} session${session?.stage ? `, ${session.stage} phase` : ''}. ${gates != null ? `${gates} of ${total} gates clear.` : ''} ${knn ? `K-N-N at ${knn}%.` : ''} ${regime ? `Regime: ${regime}.` : ''} Mode: ${mode}. Remain patient — no marginal setups. I will alert you when conditions reach execution grade.`,
    focusPanel: 'gates',
    urgency: 'normal',
  };
}

function reasonRisk(ctx, goals) {
  const { account, positions, news, analyst } = ctx;
  const pos    = Array.isArray(positions) ? positions : [];
  const eq     = account?.balance || account?.equity || 0;
  const pnl    = account?.todayPnl || 0;
  const ddPct  = eq > 0 ? (pnl / eq * 100) : 0;
  const imminent = Array.isArray(news?.upcoming)
    ? news.upcoming.filter(n => n.impact === 'high' && (n.minutesAway || 999) < 30)
    : [];

  let risks = [];
  if (ddPct < -1.5) risks.push(`drawdown at ${fmtPct(Math.abs(ddPct))} — approaching limit`);
  if (imminent.length > 0) risks.push(`${imminent.map(n => n.event).join(', ')} within 30 minutes`);
  if (pos.length > 2) risks.push(`${pos.length} concurrent positions open`);

  if (risks.length === 0) {
    return {
      speech: `Risk parameters within normal bounds, Sir. ${eq ? `Equity: ${fmt$(eq)}.` : ''} ${pos.length > 0 ? `${pos.length} position${pos.length > 1 ? 's' : ''} monitored.` : 'No open positions.'}`,
      focusPanel: 'performance',
      urgency: 'normal',
    };
  }

  return {
    speech: `Flagging ${risks.length} risk factor${risks.length > 1 ? 's' : ''}, Sir: ${risks.join('; ')}. Review exposure and reduce size until conditions normalise.`,
    focusPanel: 'performance',
    urgency: 'elevated',
  };
}

// TRADE_ACTION: Interpret a trade control request and stage it as a pending action
async function reasonTradeAction(ctx, message, r) {
  const v = message.toLowerCase();
  const positions = Array.isArray(ctx.positions) ? ctx.positions : [];

  const isClose     = /close|exit|cut\s+the\s+trade/i.test(v);
  const isBreakeven = /breakeven|break.?even|lock.?in|move.?to.?be\b/i.test(v);
  const isModify    = /tighten|widen|adjust|modify|move\s*(the\s+)?(stop|sl|tp)|change\s*(the\s+)?(stop|sl|tp)/i.test(v);
  const asset       = detectAsset(message);

  if (positions.length === 0) {
    return { speech: `No open positions to act on, Sir.`, focusPanel: 'performance', urgency: 'normal' };
  }

  const match = positions.find(p => {
    if (!asset) return true;
    const sym = (p.symbol || p.instrument || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return sym.includes(asset.replace(/[^a-z0-9]/g, ''))
      || (asset === 'gold'   && (sym.includes('xauusd') || sym.includes('gold')))
      || (asset === 'nas100' && (sym.includes('nas')    || sym.includes('ndx')))
      || (asset === 'us500'  && (sym.includes('us500')  || sym.includes('spx')));
  }) || positions[0];

  const positionId = match.id || match.positionId;
  const assetId    = asset || (match.symbol || '').toLowerCase();
  const direction  = (match.type === 'SELL' || match.type === 'SHORT') ? 'SELL' : 'BUY';
  const entry      = match.openPrice || match.entryPrice || match.price;
  const instN      = instName(match.symbol || assetId);

  if (isBreakeven && entry != null) {
    const pending = { action: 'MOVE_BREAKEVEN', positionId: String(positionId), entryPrice: entry, direction, assetId };
    if (r) await r.set('v1:jarvis:pending_action', JSON.stringify(pending), { ex: 300 }).catch(() => {});
    return {
      speech:     `I will move the stop loss on your ${instN} position to breakeven — entry plus a 2-pip buffer at ${entry}. The trade becomes risk-free. Say confirm to execute.`,
      focusPanel: 'performance', urgency: 'normal',
      action:     { type: 'pending_trade', pending },
    };
  }

  if (isClose) {
    const pending = { action: 'CLOSE_POSITION', positionId: String(positionId), confirmed: true, assetId, reason: 'JARVIS manual close' };
    if (r) await r.set('v1:jarvis:pending_action', JSON.stringify(pending), { ex: 300 }).catch(() => {});
    return {
      speech:     `I am ready to close your ${instN} position at market. This is irreversible. Say confirm to execute.`,
      focusPanel: 'performance', urgency: 'elevated',
      action:     { type: 'pending_trade', pending },
    };
  }

  if (isModify) {
    const priceM   = message.match(/(?:to|at)\s*([\d]+(?:[.,][\d]+)?)/i);
    const newLevel = priceM ? parseFloat(priceM[1].replace(',', '.')) : null;
    const isSL     = /stop|sl/i.test(v)     && !/tp|take.?profit/i.test(v);
    const isTP     = /tp|take.?profit/i.test(v) && !/stop\b|sl\b/i.test(v);

    if (!newLevel) {
      return {
        speech:     `Tell me the new level, Sir. For example: move stop loss to 2000.`,
        focusPanel: 'performance', urgency: 'normal',
      };
    }
    const pending = { action: 'MODIFY_POSITION', positionId: String(positionId), assetId, ...(isTP ? { tp: newLevel } : { sl: newLevel }) };
    if (r) await r.set('v1:jarvis:pending_action', JSON.stringify(pending), { ex: 300 }).catch(() => {});
    return {
      speech:     `I will move the ${isTP ? 'take profit' : 'stop loss'} on your ${instN} position to ${newLevel}. Say confirm to execute.`,
      focusPanel: 'performance', urgency: 'normal',
      action:     { type: 'pending_trade', pending },
    };
  }

  return {
    speech:     `${positions.length} position${positions.length > 1 ? 's' : ''} open, Sir. I can: move to breakeven, close, or modify the stop or take profit. Specify what you need.`,
    focusPanel: 'performance', urgency: 'normal',
  };
}

// CALIBRATE: Goal-driven sizing recommendation
async function reasonCalibrate(ctx, goals, r) {
  const { computeSizing } = require('./jarvis-sizing');
  const { account, qState } = ctx;
  const rules      = qState?.rules || {};
  const eq         = account?.balance || account?.equity || 0;
  const kz         = qState?.killZone;
  const daily      = goals?.daily  || { target: 1000, achieved: 0 };
  const todayPnl   = account?.todayPnl || 0;
  const knnWR      = ctx.sigQual?.knnWinRate  || ctx.analyst?.brief?.knnWR  || 0.55;
  const knnAvgR    = ctx.sigQual?.knnAvgR     || ctx.analyst?.brief?.knnAvgR || 1.6;
  const drawdownPct= eq > 0 && todayPnl < 0 ? Math.abs(todayPnl / eq * 100) : 0;
  const sessionsLeft = kz?.inKillZone ? 1 : 2;
  // daily.achieved is now maintained by addGoalPnL on every trade close.
  // Fall back to broker's todayPnl only if goal tracking hasn't fired yet today.
  const achieved   = daily.achieved !== 0 ? daily.achieved : Math.max(0, todayPnl);

  const sizing = computeSizing(
    { equity: eq, dailyTarget: daily.target, achieved, winRate: knnWR, avgR: knnAvgR, sessionsLeft, drawdownPct },
    rules
  );

  if (r) {
    await r.set('v1:jarvis:sizing_rec', JSON.stringify({ ts: Date.now(), tierB: sizing.tierBMultiplier, tierA: sizing.tierAMultiplier }), { ex: 1800 }).catch(() => {});
  }

  const speech = sizing.speech + (sizing.warnings?.length ? '' : ` Say "apply sizing" to update the bot multipliers now.`);

  return {
    speech,
    focusPanel: 'goal',
    urgency:    sizing.mode === 'defensive' ? 'elevated' : 'normal',
    action:     { type: 'sizing_recommendation', sizing },
  };
}

// CONFIRM: Execute the staged pending action or apply the pending sizing recommendation
async function reasonConfirm(ctx, message, r, base) {
  if (!r) return { speech: 'Redis unavailable — cannot execute the pending action, Sir.', focusPanel: null, urgency: 'elevated' };
  const v = message.toLowerCase();

  const rawSizing = await r.get('v1:jarvis:sizing_rec').catch(() => null);
  if (rawSizing && /apply\s*(sizing|it|the\s*lot|lot)/i.test(v)) {
    const sizing = safeParse(rawSizing);
    if (!sizing) return { speech: 'No sizing recommendation found. Run calibrate first, Sir.', focusPanel: 'goal', urgency: 'normal' };
    try {
      const resp = await fetch(`${base}/api/jarvis-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SET_LOT_MULT', tierA: sizing.tierA, tierB: sizing.tierB, triggeredBy: 'JARVIS:CALIBRATE:CONFIRM' }),
      });
      const data = await resp.json().catch(() => ({}));
      await r.del('v1:jarvis:sizing_rec').catch(() => {});
      return { speech: data.speech || 'Sizing applied, Sir.', focusPanel: 'goal', urgency: 'normal' };
    } catch (e) {
      return { speech: `Failed to apply sizing, Sir: ${e.message}`, focusPanel: 'goal', urgency: 'elevated' };
    }
  }

  const rawPending = await r.get('v1:jarvis:pending_action').catch(() => null);
  if (!rawPending) return { speech: 'Nothing pending to confirm, Sir. Specify an action first.', focusPanel: null, urgency: 'normal' };

  const pending = safeParse(rawPending);
  if (!pending?.action) return { speech: 'Pending action corrupted. Please repeat the command, Sir.', focusPanel: null, urgency: 'normal' };

  try {
    const resp = await fetch(`${base}/api/jarvis-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...pending, confirmed: true, triggeredBy: 'JARVIS:CONFIRM' }),
    });
    const data = await resp.json().catch(() => ({}));
    await r.del('v1:jarvis:pending_action').catch(() => {});
    return {
      speech:     data.speech || (data.ok ? 'Action executed, Sir.' : `Execution failed: ${data.error || 'unknown error'}`),
      focusPanel: 'performance',
      urgency:    data.ok ? 'normal' : 'elevated',
    };
  } catch (e) {
    return { speech: `Execution failed, Sir: ${e.message}`, focusPanel: 'performance', urgency: 'elevated' };
  }
}

// OPEN: Scans everything — surfaces the highest-priority insight from the FULL quantum state
function reasonOpen(ctx, goals) {
  const { account, positions, analyst, session, news, sigQual, qState } = ctx;
  const pos    = Array.isArray(positions) ? positions : [];
  const eq     = account?.balance || account?.equity || 0;
  const pnl    = account?.todayPnl || 0;
  const knn    = sigQual?.knnScore || analyst?.brief?.knnScore || null;
  const gates  = analyst?.brief?.gatesPass || null;
  const total  = analyst?.brief?.gatesTotal || 8;
  const top    = analyst?.brief?.topSetup || null;
  const watchers  = qState?.watchers  || {};
  const chartBias = qState?.chartBias || {};
  const mode      = qState?.currentMode || 'active';
  const kz        = qState?.killZone;
  const pending   = findPendingSetups(watchers);

  // Priority 1: Imminent news + open positions
  const imminent = Array.isArray(news?.upcoming)
    ? news.upcoming.find(n => n.impact === 'high' && (n.minutesAway || 999) < 10)
    : null;
  if (imminent && pos.length > 0) {
    return {
      speech: `Sir, ${imminent.event} in ${imminent.minutesAway} minutes — high impact. You have ${pos.length} open position${pos.length > 1 ? 's' : ''}. Review exposure immediately.`,
      focusPanel: 'news',
      urgency: 'critical',
    };
  }

  // Priority 2: Live analyst signal + high KNN
  if (top && knn != null && knn >= 85 && gates != null && gates >= total * 0.875) {
    return reasonSignal(ctx);
  }

  // Priority 3: Watcher has armed pending setup
  if (pending.length > 0) {
    const p    = pending[0];
    const cb   = chartBias[p.asset] || {};
    const conf = cb.confluence;
    const kzLine  = kz?.inKillZone ? ` Kill zone active: ${kz.label}.` : '';
    const biasLine = conf?.htfDirection ? ` HTF: ${conf.htfDirection === 'LONG' ? 'bullish' : 'bearish'} (${Math.max(conf.longTFs?.length || 0, conf.shortTFs?.length || 0)} of ${conf.totalTFs} TFs).` : '';
    const trigLine = conf?.triggerConfirmed?.length ? ` ${conf.triggerConfirmed.join(',')} CHoCH confirmed.` : '';
    return {
      speech: `Bot has a live setup armed, Sir: ${p.templateName || 'setup'} on ${instName(p.asset)}.${biasLine}${trigLine}${kzLine} Awaiting Pine break confirmation. The system is watching.`,
      focusPanel: 'signal',
      urgency: 'elevated',
    };
  }

  // Priority 4: Goal off track
  if (goals?.monthly?.target > 0) {
    const now = new Date();
    const expected = goals.monthly.target * (now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
    if (goals.monthly.achieved < expected * 0.6) {
      return reasonGoal(goals, ctx, null, null, null);
    }
  }

  // Priority 5: Drawdown alert
  const ddPct = eq > 0 ? (pnl / eq * 100) : 0;
  if (ddPct < -1.5) {
    return reasonRisk(ctx, goals);
  }

  // Priority 6: Chart bias summary + kill zone context
  const bullish  = Object.entries(chartBias).filter(([,b]) => b.confluence?.aligned && b.confluence?.htfDirection === 'LONG').map(([a]) => instName(a));
  const bearish  = Object.entries(chartBias).filter(([,b]) => b.confluence?.aligned && b.confluence?.htfDirection === 'SHORT').map(([a]) => instName(a));
  const cur  = sessionLabel(session);
  const kzLine = kz?.inKillZone
    ? `${kz.label} kill zone active.`
    : (kz?.nextKillZone ? `Next kill zone: ${killZoneDisplayName(kz.nextKillZone)} in ${kz.minutesUntilNext} minutes.` : '');
  const pnlStr = eq > 0 ? ` ${signStr(pnl)} ${fmt$(pnl)} on the day.` : '';

  return {
    speech: `Current picture, Sir. ${cur} session. ${kzLine}${pnlStr} ${bullish.length ? `Bullish: ${bullish.slice(0,2).join(', ')}.` : ''} ${bearish.length ? `Bearish: ${bearish.slice(0,2).join(', ')}.` : ''} Mode: ${mode}. ${pos.length > 0 ? `${pos.length} position${pos.length > 1 ? 's' : ''} running.` : 'Flat.'} ${knn ? `K-N-N: ${knn}%.` : ''} All templates armed, monitoring for Pine signal.`,
    focusPanel: knn && knn >= 75 ? 'signal' : 'performance',
    urgency: 'normal',
  };
}

// ─── ANOMALY SCANNER ─────────────────────────────────────────────────────────
function scanForAnomalies(ctx) {
  const { analyst, qState } = ctx;
  const brief = analyst?.brief || {};

  if ((brief.shadowUnresolved || 0) > 25) {
    return {
      type: 'bug_fix',
      title: 'Shadow system backlog exceeding 25 unresolved records',
      description: `The analyst reports ${brief.shadowUnresolved} unresolved shadow records. The ledger join may not be firing on trade close, or trades are closing without triggering the resolver. Audit the trade-close webhook path and recognition-memory resolver.`,
      priority: 'medium',
    };
  }

  if ((brief.brokerErrors || 0) > 5) {
    return {
      type: 'bug_fix',
      title: 'Broker fetch error rate elevated',
      description: `${brief.brokerErrors} broker fetch errors in the last analyst run. MetaAPI may be timing out or credentials need rotation. Check METAAPI_TOKEN validity and timeout configuration in broker.js.`,
      priority: 'high',
    };
  }

  // New: detect gating inconsistency (gating-store has rules for non-existent templates)
  if (qState?.gatingRules) {
    const knownTemplates = [
      'silver-bullet','unicorn','turtle-soup','judas-swing',
      'ote-continuation','am-ifvg','reaction','reaction-fvg',
      'reaction-ifvg','reaction-impulse','orb','orb-pro','alexg',
    ];
    const stale = qState.gatingRules.filter(g =>
      g.template !== '*' && !knownTemplates.includes(g.template)
    );
    if (stale.length > 3) {
      return {
        type: 'maintenance',
        title: `${stale.length} stale gating rules reference unknown templates`,
        description: `Gating store contains rules for templates not in the current template list: ${stale.map(g=>g.template).join(', ')}. These rules have no effect but indicate the gating store may need a clean sweep of obsolete entries.`,
        priority: 'low',
      };
    }
  }

  return null;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  const r    = getRedis();
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000');

  try {
    const [ctx, goals] = await Promise.all([fetchCtx(base), getGoals(r)]);
    const intent = parseIntent(message);

    let result;
    switch (intent) {
      case 'WATCHER':     result = reasonWatcher(ctx, message);        break;
      case 'FILTER':      result = reasonFilter(ctx, message);         break;
      case 'SIGNAL':      result = reasonSignal(ctx);                  break;
      case 'GATES':       result = reasonGates(ctx);                   break;
      case 'POSITIONS':   result = reasonPositions(ctx);               break;
      case 'PERFORMANCE': result = reasonPerformance(ctx, goals);      break;
      case 'GOAL':        result = await reasonGoal(goals, ctx, message, r, base); break;
      case 'SESSION':     result = reasonSession(ctx);                 break;
      case 'MACRO':       result = reasonMacro(ctx, message);          break;
      case 'PINE':        result = reasonPine(ctx, message);           break;
      case 'COMPASS':     result = reasonCompass(ctx);                 break;
      case 'KNN':         result = reasonKNN(ctx);                     break;
      case 'ADVISE':      result = reasonAdvise(ctx, goals);                        break;
      case 'RISK':        result = reasonRisk(ctx, goals);                          break;
      case 'TRADE_ACTION':result = await reasonTradeAction(ctx, message, r);        break;
      case 'CALIBRATE':   result = await reasonCalibrate(ctx, goals, r);            break;
      case 'CONFIRM':     result = await reasonConfirm(ctx, message, r, base);      break;
      default:            result = reasonOpen(ctx, goals);                          break;
    }

    // Push critical and elevated alerts to Telegram proactively
    if (result.urgency === 'critical' || (result.urgency === 'elevated' && result.action?.type === 'pending_trade')) {
      const withConfirm = result.action?.type === 'pending_trade';
      telegramPush(result.speech, withConfirm).catch(() => {});
    }

    const anomaly = scanForAnomalies(ctx);
    if (anomaly && r) {
      const reqId = `req_${Date.now()}`;
      const rec   = { id: reqId, ts: new Date().toISOString(), status: 'pending', triggeredBy: message.trim().slice(0,120), ...anomaly };
      await Promise.all([
        r.set(`v1:jarvis:claude-requests:${reqId}`, JSON.stringify(rec), { ex: 7 * 24 * 3600 }),
        r.lpush('v1:jarvis:claude-requests', reqId),
        r.ltrim('v1:jarvis:claude-requests', 0, 49),
      ]).catch(() => {});
    }

    return res.status(200).json({
      speech:        result.speech        || 'Systems nominal, Sir.',
      focusPanel:    result.focusPanel    || null,
      action:        result.action        || null,
      claudeRequest: anomaly              || null,
      urgency:       result.urgency       || 'normal',
    });

  } catch (err) {
    return res.status(500).json({
      speech:        'Sir, I encountered a processing error. I am investigating the cause.',
      focusPanel:    null,
      action:        null,
      claudeRequest: null,
      urgency:       'elevated',
      _error:        err.message,
    });
  }
};
