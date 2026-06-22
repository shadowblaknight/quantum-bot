/* eslint-disable */
// api/rules-store.js  (Pilot Dashboard v1.5)
//
// v1.5 CHANGE (the "my inputs are ignored" fix):
//   The backend only honored slMode === 'fixed-pips' / 'fixed-dollars' and
//   lotMode === 'fixed'. If the App.jsx settings panel saves the toggle under a
//   different spelling (e.g. slMode:'fixed', lotMode:'fixed-lot'), the mode
//   never matched, the code silently fell back to the Pine SL / risk-based lot,
//   and the user's entered values looked ignored even after flipping the toggle.
//   Fix: accept the common aliases so a fixed SL/lot is honored regardless of
//   which spelling the UI persists. Pine/risk-based behavior is unchanged when
//   no fixed mode is set.
//
// v1.4 (kept): RR float tolerance (0.001) so exact-1.0R trades aren't rejected.
// v1.3 (kept): TP recompute when (slWasOverridden OR effectiveMinRR > 1.0).
// v1.2 (kept): 'am-ifvg' in defaults/active/defensive; TP recompute on SL override.
//
// DEPENDS ONLY ON: ./_lib
// ----------------------------------------------------------------------------

const { getRedis, safeParse } = require('./_lib');
const { ACCEPTED_ACTIVE, ACCEPTED_DEFENSIVE, templateLabel } = require('./_templates');
// v14: cache-only regime read (never blocks the live path). Lazy-required inside
// applyRulesToSignal to avoid any load-order coupling.

const RULES_KEY = 'v13:pilot:rules';
const ACTIVITY_LOG_KEY = 'v13:pilot:activity';
const DAILY_PNL_KEY = (date) => `v13:pilot:daily-pnl:${date}`;
const RULES_TTL_DAYS = 365;

const RR_FLOAT_TOLERANCE = 0.001;

// v1.5: accepted spellings for the "fixed" modes, so a value the user entered
// in the app is honored no matter which string the settings panel saved.
const SL_FIXED_PIPS_MODES    = new Set(['fixed-pips', 'fixed', 'pips', 'fixed_pips']);
const SL_FIXED_DOLLARS_MODES = new Set(['fixed-dollars', 'dollars', 'fixed_dollars', 'fixed-usd']);
const LOT_FIXED_MODES        = new Set(['fixed', 'fixed-lot', 'fixed_lot', 'manual']);

// ───── Defaults ──────────────────────────────────────────────────────

const DEFAULT_RULES = {
  version: 14.0,

  tradingMode: 'auto',

  // v14: tier-B lot multiplier. 1.0 = OFF (your lot input is used as-is for
  // counter-bias / retest "tier B" signals). Set below 1.0 to size B trades down.
  tierBLotMultiplier: 1.0,

  account: {
    maxDailyLossPct: 5.0,
    maxConcurrentPositions: 5,
    maxRiskPerTradePct: 2.0,
    emergencyStop: false,
  },

  activeMode: 'active',

  modePresets: {
    sleep: {
      lotMultiplier: 0.50, minRR: 2.0,
      acceptedTemplates: ['ote-continuation'],
      maxConcurrent: 1,
      label: '🌙 Sleep',
      description: 'Only swing setups, half lot, set-and-forget, max 1 position',
    },
    active: {
      lotMultiplier: 1.00, minRR: 0,
      acceptedTemplates: [...ACCEPTED_ACTIVE],
      maxConcurrent: 5,
      label: '🐻 Active',
      description: 'All templates, full lot, full management',
    },
    defensive: {
      lotMultiplier: 0.50, minRR: 2.0,
      acceptedTemplates: [...ACCEPTED_DEFENSIVE],
      maxConcurrent: 2,
      label: '🛡 Defensive',
      description: 'High-confidence templates only, half lot, min 2R required',
    },
    vacation: {
      lotMultiplier: 0, minRR: 99,
      acceptedTemplates: [],
      maxConcurrent: 0,
      label: '🏖 Vacation',
      description: 'Block all new trades. Existing positions continue to manage.',
    },
  },

  instruments: {
    gold:   makeInstrumentDefault('gold',   { fixedLot: 0.20, maxLot: 0.50, fixedSLPips: 40 }),
    eurusd: makeInstrumentDefault('eurusd', { fixedLot: 0.50, maxLot: 1.50, fixedSLPips: 15 }),
    gbpusd: makeInstrumentDefault('gbpusd', { fixedLot: 0.50, maxLot: 1.50, fixedSLPips: 18 }),
    usdjpy: makeInstrumentDefault('usdjpy', { fixedLot: 0.50, maxLot: 1.50, fixedSLPips: 15 }),
    nas100: makeInstrumentDefault('nas100', { fixedLot: 0.20, maxLot: 0.50, fixedSLPips: 60 }),
    us500:  makeInstrumentDefault('us500',  { fixedLot: 0.20, maxLot: 1.00, fixedSLPips: 25 }),
    btc:    makeInstrumentDefault('btc',    { fixedLot: 0.03, maxLot: 0.08, fixedSLPips: 150 }),
  },

  templateOverrides: {
    'silver-bullet':    { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: '🥈 Silver Bullet' },
    'unicorn':          { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: '🦄 Unicorn' },
    'turtle-soup':      { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: '🐢 Turtle Soup' },
    'judas-swing':      { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: '🎭 Judas Swing' },
    'ote-continuation': { enabled: true, tradingStyle: 'swing',    lotMultiplier: 1.0, label: '🎯 OTE Continuation' },
    'am-ifvg':          { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: '🌅 AM IFVG Reversal' },
    'orb':              { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: '🚀 ORB Breakout' },
    'reaction':         { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: templateLabel('reaction') },
    'reaction-fvg':     { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: templateLabel('reaction-fvg') },
    'reaction-ifvg':    { enabled: true, tradingStyle: 'intraday', lotMultiplier: 1.0, label: templateLabel('reaction-ifvg') },
  },

  lastModified: null,
  modifiedBy: 'defaults',
};

function makeInstrumentDefault(assetId, overrides) {
  return {
    enabled: true,
    // v14: which risk profile is live for this instrument — 'day' | 'swing'.
    style: 'day',
    // Flat fields below stay as the fallback / legacy values. They are also what
    // the Day and Swing profiles inherit from until you split them in the UI, so
    // nothing you've already saved is lost.
    lotMode: 'risk-based',
    fixedLot: 0.10,
    maxLot: 1.0,
    slMode: 'pine',
    fixedSLPips: 15,
    fixedSLDollars: 5.0,
    tpMode: 'pine-three',
    minRR: 1.0,
    tp1RR: 1.5,
    tp2RR: 3.0,
    tp3RR: 5.0,
    numTPs: 3,
    label: assetId.toUpperCase(),
    // dayProfile / swingProfile are created lazily by the app the first time you
    // edit one. Absent profile => that style falls back to the flat fields above.
    ...overrides,
  };
}

// v14: resolve the ACTIVE risk profile for an instrument based on its style.
// Migration-safe: if the chosen style's profile hasn't been configured yet, fall
// back to the instrument's flat fields (your existing settings). A configured but
// partial profile fills its gaps from the flat fields too.
function resolveProfile(inst) {
  const style = inst.style === 'swing' ? 'swing' : 'day';
  const flat = {
    slMode:         inst.slMode || 'pine',
    fixedSLPips:    inst.fixedSLPips != null ? inst.fixedSLPips : 15,
    fixedSLDollars: inst.fixedSLDollars != null ? inst.fixedSLDollars : 5.0,
    tpMode:         inst.tpMode || 'pine-three',
    lotMode:        inst.lotMode || 'risk-based',
    fixedLot:       inst.fixedLot != null ? inst.fixedLot : 0.10,
    maxLot:         inst.maxLot != null ? inst.maxLot : 1.0,
    minRR:          inst.minRR != null ? inst.minRR : 1.0,
    tp1RR:          inst.tp1RR != null ? inst.tp1RR : 1.5,
    tp2RR:          inst.tp2RR != null ? inst.tp2RR : 3.0,
    tp3RR:          inst.tp3RR != null ? inst.tp3RR : 5.0,
    numTPs:         inst.numTPs != null ? inst.numTPs : 3,
  };
  const p = inst[style + 'Profile'];
  if (!p || typeof p !== 'object') return { style, ...flat };
  return {
    style,
    slMode:         p.slMode || flat.slMode,
    fixedSLPips:    p.fixedSLPips != null ? p.fixedSLPips : flat.fixedSLPips,
    fixedSLDollars: p.fixedSLDollars != null ? p.fixedSLDollars : flat.fixedSLDollars,
    tpMode:         p.tpMode || flat.tpMode,
    lotMode:        p.lotMode || flat.lotMode,
    fixedLot:       p.fixedLot != null ? p.fixedLot : flat.fixedLot,
    maxLot:         p.maxLot != null ? p.maxLot : flat.maxLot,
    minRR:          p.minRR != null ? p.minRR : flat.minRR,
    tp1RR:          p.tp1RR != null ? p.tp1RR : flat.tp1RR,
    tp2RR:          p.tp2RR != null ? p.tp2RR : flat.tp2RR,
    tp3RR:          p.tp3RR != null ? p.tp3RR : flat.tp3RR,
    numTPs:         p.numTPs != null ? p.numTPs : flat.numTPs,
  };
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = out[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

// `acceptedTemplates` per mode is CODE-OWNED config (derived from _templates),
// not user-editable — the dashboard only toggles individual templates via
// templateOverrides.enabled. deepMerge replaces arrays wholesale, so a list
// frozen in Redis from before a new template existed would silently block it
// ("template-not-in-mode"). Always refresh these lists from the canonical
// default after merge, so adding a template needs no Redis reset.
function applySystemConfig(merged) {
  if (merged && merged.modePresets) {
    for (const mode of Object.keys(DEFAULT_RULES.modePresets)) {
      if (merged.modePresets[mode] && DEFAULT_RULES.modePresets[mode]) {
        merged.modePresets[mode].acceptedTemplates =
          [...DEFAULT_RULES.modePresets[mode].acceptedTemplates];
      }
    }
    // v14: the Active mode must not impose its own concurrent-position cap below
    // the account-level setting the user controls in the app. Keep it in lock-step
    // with account.maxConcurrentPositions so changing "max positions" in the app
    // actually takes effect (otherwise a stale stored mode cap of 5 silently wins).
    // The throttled modes (sleep / defensive / vacation) keep their own lower caps
    // as intentional safety limits.
    if (merged.modePresets.active && merged.account &&
        merged.account.maxConcurrentPositions != null) {
      merged.modePresets.active.maxConcurrent = merged.account.maxConcurrentPositions;
    }
  }
  return merged;
}

// ───── Get / set rules ───────────────────────────────────────────────

async function getRules() {
  const r = getRedis();
  if (!r) return DEFAULT_RULES;
  try {
    const raw = await r.get(RULES_KEY);
    const stored = safeParse(raw);
    if (!stored || typeof stored !== 'object') return DEFAULT_RULES;
    return applySystemConfig(deepMerge(DEFAULT_RULES, stored));
  } catch (e) {
    console.error('[rules-store] getRules error:', e.message);
    return DEFAULT_RULES;
  }
}

async function setRules(rules) {
  const r = getRedis();
  if (!r) return { ok: false, error: 'redis-unavailable' };
  try {
    const merged = applySystemConfig(deepMerge(DEFAULT_RULES, rules || {}));
    merged.lastModified = Date.now();
    merged.modifiedBy = rules.modifiedBy || 'user';
    await r.set(RULES_KEY, JSON.stringify(merged), { ex: RULES_TTL_DAYS * 86400 });
    return { ok: true, rules: merged };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function updateInstrumentRule(assetId, patch) {
  const current = await getRules();
  if (!current.instruments[assetId]) return { ok: false, error: `unknown asset: ${assetId}` };
  // v14: deep-merge so a partial { dayProfile:{ fixedLot:0.2 } } patch updates just
  // that field instead of replacing the whole profile object.
  current.instruments[assetId] = deepMerge(current.instruments[assetId], patch);
  return setRules(current);
}

async function updateAccountSafety(patch) {
  const current = await getRules();
  current.account = { ...current.account, ...patch };
  return setRules(current);
}

async function setActiveMode(mode) {
  if (!['sleep','active','defensive','vacation'].includes(mode)) {
    return { ok: false, error: `invalid mode: ${mode}` };
  }
  const current = await getRules();
  current.activeMode = mode;
  return setRules(current);
}

async function setTradingMode(mode) {
  if (!['auto','manual'].includes(mode)) {
    return { ok: false, error: `invalid trading mode: ${mode} (must be 'auto' or 'manual')` };
  }
  const current = await getRules();
  current.tradingMode = mode;
  return setRules(current);
}

async function updateTemplateOverride(template, patch) {
  const current = await getRules();
  if (!current.templateOverrides[template]) return { ok: false, error: `unknown template: ${template}` };
  current.templateOverrides[template] = { ...current.templateOverrides[template], ...patch };
  return setRules(current);
}

async function emergencyStopAll(enable) {
  const current = await getRules();
  current.account.emergencyStop = !!enable;
  return setRules(current);
}

// ───── Rules engine — apply rules to incoming signal ─────────────────

async function applyRulesToSignal({
  assetId, template, direction, entry, sl, tp1, tp2, tp3,
  htfTier, htfBiasAlign,
  capital, openPositions, todaysPnL, assetMeta,
}) {
  const rules = await getRules();

  if (rules.account.emergencyStop) return { allow: false, reason: 'emergency-stop-active' };
  if (todaysPnL != null && capital > 0) {
    const dailyLossPct = (todaysPnL / capital) * -100;
    if (dailyLossPct >= rules.account.maxDailyLossPct) {
      return { allow: false, reason: `daily-loss-limit (${dailyLossPct.toFixed(1)}% >= ${rules.account.maxDailyLossPct}%)` };
    }
  }
  const openCount = Array.isArray(openPositions) ? openPositions.length : 0;
  if (openCount >= rules.account.maxConcurrentPositions) {
    return { allow: false, reason: `max-concurrent-positions (${openCount} >= ${rules.account.maxConcurrentPositions})` };
  }

  const preset = rules.modePresets[rules.activeMode];
  if (!preset) return { allow: false, reason: `unknown-mode: ${rules.activeMode}` };
  if (preset.lotMultiplier === 0) return { allow: false, reason: `mode-blocks-trades (${rules.activeMode})` };
  if (!preset.acceptedTemplates.includes(template)) {
    return { allow: false, reason: `template-not-in-mode (${template} not allowed in ${rules.activeMode})` };
  }
  if (preset.maxConcurrent != null && openCount >= preset.maxConcurrent) {
    return { allow: false, reason: `mode-max-concurrent (${openCount} >= ${preset.maxConcurrent})` };
  }

  const tmplOverride = rules.templateOverrides[template];
  if (!tmplOverride || !tmplOverride.enabled) return { allow: false, reason: `template-disabled (${template})` };

  const inst = rules.instruments[assetId];
  if (!inst) return { allow: false, reason: `no-rules-for-asset (${assetId})` };
  if (!inst.enabled) return { allow: false, reason: `instrument-disabled (${assetId})` };

  // v14: resolve the active Day/Swing risk profile for this instrument. All SL/TP/
  // lot reads below come from `prof` (which falls back to the flat fields).
  const prof = resolveProfile(inst);

  // ─── Compute final SL ─────
  // v1.5: tolerate alias spellings for the fixed SL mode so the value the user
  // typed in the app is actually applied (previously only 'fixed-pips' matched).
  const slModeRaw        = String(prof.slMode || 'pine').toLowerCase();
  const slIsFixedPips    = SL_FIXED_PIPS_MODES.has(slModeRaw);
  const slIsFixedDollars = SL_FIXED_DOLLARS_MODES.has(slModeRaw);
  const slWasOverridden  = slIsFixedPips || slIsFixedDollars;

  let finalSL = sl;
  if (slIsFixedPips && assetMeta && assetMeta.pipSize) {
    const distance = prof.fixedSLPips * assetMeta.pipSize;
    finalSL = direction === 'LONG' ? entry - distance : entry + distance;
  } else if (slIsFixedDollars && assetMeta && assetMeta.pipSize && assetMeta.dollarPerPipPerLot) {
    const pips = prof.fixedSLDollars / assetMeta.dollarPerPipPerLot;
    const distance = pips * assetMeta.pipSize;
    finalSL = direction === 'LONG' ? entry - distance : entry + distance;
  }

  // v14 regime modulation: read the cached macro regime. This is cache-only and
  // NEVER blocks (falls back to NORMAL = no change), so it can't stall placement.
  // In elevated/crisis we WIDEN the stop (room for volatility) and SHRINK size
  // (below). It multiplies the user's SL/lot — it never replaces them. Applied
  // before the SL distance so RR-based TPs and risk-sizing stay consistent.
  let _regime = { level: 'normal', sizeMult: 1.0, slWiden: 1.0 };
  try { _regime = await require('./market-regime').getRegimeFast(); } catch (_) {}
  const regimeSizeMult = (_regime && Number(_regime.sizeMult)) || 1.0;
  const regimeSlWiden  = (_regime && Number(_regime.slWiden))  || 1.0;
  if (regimeSlWiden && regimeSlWiden !== 1.0) {
    const widened = Math.abs(entry - finalSL) * regimeSlWiden;
    finalSL = direction === 'LONG' ? entry - widened : entry + widened;
  }

  const finalSLDistance = Math.abs(entry - finalSL);
  if (finalSLDistance <= 0) return { allow: false, reason: 'invalid-sl-distance' };

  const effectiveMinRR = Math.max(prof.minRR || 0, preset.minRR || 0);

  // ─── Compute final TPs ─────
  let finalTP1 = tp1, finalTP2 = tp2, finalTP3 = tp3;
  let tpsAutoPromoted = false;
  if (prof.tpMode === 'trail-only') {
    finalTP1 = null; finalTP2 = null; finalTP3 = null;
  } else if (prof.tpMode === 'rr') {
    // v14: TPs placed by RR multiple, per-instrument (default 1.5R / 3R / 5R).
    // All-or-nothing: the full position rides to the LAST configured TP; the
    // earlier TPs are SL-ratchet checkpoints (manage-trades moves SL to each as
    // it's touched, no partial closes).
    const n = Math.max(1, Math.min(3, Math.round(prof.numTPs || 3)));
    const r1 = prof.tp1RR > 0 ? prof.tp1RR : 1.5;
    const r2 = prof.tp2RR > 0 ? prof.tp2RR : 3.0;
    const r3 = prof.tp3RR > 0 ? prof.tp3RR : 5.0;
    const mk = (r) => direction === 'LONG' ? entry + finalSLDistance * r : entry - finalSLDistance * r;
    finalTP1 = mk(r1);
    finalTP2 = n >= 2 ? mk(r2) : null;
    finalTP3 = n >= 3 ? mk(r3) : null;
    tpsAutoPromoted = true;
  } else if (slWasOverridden || effectiveMinRR >= 1.0) {
    // v14 fix: was `> 1.0`, which skipped the exact 1.0 boundary — the default
    // instrument minRR. Immediate reaction entries (entry=close, TPs measured
    // from the zone) often arrive sub-1R; at minRR=1.0 they were neither
    // promoted nor passed, so they got rejected as rr-below-threshold and never
    // traded. `>= 1.0` promotes their TPs to 1R/2R/3R so they trade as intended.
    const tp1R = Math.max(1.0, effectiveMinRR);
    finalTP1 = direction === 'LONG' ? entry + finalSLDistance * tp1R       : entry - finalSLDistance * tp1R;
    finalTP2 = direction === 'LONG' ? entry + finalSLDistance * (tp1R + 1) : entry - finalSLDistance * (tp1R + 1);
    finalTP3 = direction === 'LONG' ? entry + finalSLDistance * (tp1R + 2) : entry - finalSLDistance * (tp1R + 2);
    tpsAutoPromoted = true;
  }

  if (finalTP1 != null) {
    const tp1Distance = Math.abs(finalTP1 - entry);
    const tp1RR = tp1Distance / finalSLDistance;
    if (tp1RR < effectiveMinRR - RR_FLOAT_TOLERANCE) {
      return { allow: false, reason: `rr-below-threshold (${tp1RR.toFixed(2)} < ${effectiveMinRR.toFixed(2)})` };
    }
  }

  // ─── Compute final lot ─────
  // v1.5: tolerate alias spellings for the fixed lot mode.
  const lotModeRaw = String(prof.lotMode || 'risk-based').toLowerCase();
  let finalLot;
  if (LOT_FIXED_MODES.has(lotModeRaw)) {
    finalLot = prof.fixedLot;
  } else {
    const riskPct = Math.min(rules.account.maxRiskPerTradePct, 2.0) / 100;
    const riskDollars = capital * riskPct;
    if (assetMeta && assetMeta.pipSize && assetMeta.dollarPerPipPerLot) {
      const pips = finalSLDistance / assetMeta.pipSize;
      finalLot = riskDollars / (pips * assetMeta.dollarPerPipPerLot);
    } else {
      finalLot = prof.fixedLot;
    }
  }
  // v14: tier multiplier. Tier B (counter-bias / retest) can be sized down via
  // rules.tierBLotMultiplier. DEFAULT 1.0 = NO change — your lot input is honored
  // untouched unless you deliberately set this below 1.0 in settings.
  const tierMult = (htfTier === 'B') ? (rules.tierBLotMultiplier != null ? rules.tierBLotMultiplier : 1.0) : 1.0;
  finalLot = finalLot * (preset.lotMultiplier || 1.0) * (tmplOverride.lotMultiplier || 1.0) * tierMult;
  // v14 regime: shrink size in elevated/crisis (1.0 = no change in NORMAL).
  finalLot = finalLot * regimeSizeMult;
  if (finalLot > prof.maxLot) finalLot = prof.maxLot;
  finalLot = Math.max(0.01, Math.round(finalLot * 100) / 100);

  if (assetMeta && assetMeta.pipSize && assetMeta.dollarPerPipPerLot) {
    const pips = finalSLDistance / assetMeta.pipSize;
    const actualRisk = pips * assetMeta.dollarPerPipPerLot * finalLot;
    const maxRiskDollars = capital * (rules.account.maxRiskPerTradePct / 100);
    if (actualRisk > maxRiskDollars * 1.05) {
      return {
        allow: false,
        reason: `risk-exceeds-max ($${actualRisk.toFixed(2)} > $${maxRiskDollars.toFixed(2)})`,
        actualRisk, maxRiskDollars,
      };
    }
  }

  return {
    allow: true,
    tradingMode: rules.tradingMode || 'auto',
    finalLot, finalSL,
    finalTP1, finalTP2, finalTP3,
    finalSLDistance,
    activeMode: rules.activeMode,
    // v14 macro regime that was applied to this trade (normal = no change).
    regime: (_regime && _regime.level) || 'normal',
    regimeSizeMult, regimeSlWiden,
    instrument: inst,
    template: tmplOverride,
    rulesApplied: {
      style: prof.style,
      slMode: prof.slMode, slModeResolved: slIsFixedPips ? 'fixed-pips' : slIsFixedDollars ? 'fixed-dollars' : 'pine',
      tpMode: prof.tpMode,
      lotMode: prof.lotMode, lotModeResolved: LOT_FIXED_MODES.has(lotModeRaw) ? 'fixed' : 'risk-based',
      slWasOverridden,
      tpsAutoPromoted,
      effectiveMinRR,
      modeLotMultiplier: preset.lotMultiplier, templateLotMultiplier: tmplOverride.lotMultiplier,
      htfTier: htfTier || null, htfBiasAlign: htfBiasAlign != null ? htfBiasAlign : null, tierLotMultiplier: tierMult,
      tradingMode: rules.tradingMode || 'auto',
    },
  };
}

// ───── Activity log ──────────────────────────────────────────────────

async function logActivity(entry) {
  const r = getRedis();
  if (!r) return;
  try {
    const raw = await r.get(ACTIVITY_LOG_KEY);
    let arr = safeParse(raw) || [];
    arr.push({ ts: Date.now(), ...entry });
    if (arr.length > 200) arr = arr.slice(-200);
    await r.set(ACTIVITY_LOG_KEY, JSON.stringify(arr), { ex: 86400 * 7 });
  } catch (_) {}
}

async function getActivity(limit = 50) {
  const r = getRedis();
  if (!r) return [];
  try {
    const raw = await r.get(ACTIVITY_LOG_KEY);
    const arr = safeParse(raw) || [];
    return arr.slice(-limit).reverse();
  } catch (_) { return []; }
}

// ───── Daily P&L ─────────────────────────────────────────────────────

function todayDateKey() { return new Date().toISOString().slice(0, 10); }

async function addDailyPnL(amount) {
  const r = getRedis();
  if (!r) return;
  try {
    const key = DAILY_PNL_KEY(todayDateKey());
    const raw = await r.get(key);
    const current = raw ? parseFloat(raw) : 0;
    await r.set(key, String(current + amount), { ex: 86400 * 7 });
  } catch (_) {}
}

async function getTodaysPnL() {
  const r = getRedis();
  if (!r) return 0;
  try {
    const raw = await r.get(DAILY_PNL_KEY(todayDateKey()));
    return raw ? parseFloat(raw) : 0;
  } catch (_) { return 0; }
}

module.exports = {
  getRules,
  setRules,
  updateInstrumentRule,
  updateAccountSafety,
  setActiveMode,
  setTradingMode,
  updateTemplateOverride,
  emergencyStopAll,
  DEFAULT_RULES,
  applyRulesToSignal,
  logActivity,
  getActivity,
  addDailyPnL,
  getTodaysPnL,
};