/* eslint-disable */
// api/settings-store.js
//
// LIVE TRADE SETTINGS — the single place the control panel and the execution
// path agree on. Before this existed, the panel POSTed to /api/manage (which
// does not exist, so every write 404'd) while webhook.js used a hardcoded
// `const _RISK_PCT = 0.01`. Setting 2% in the UI therefore did nothing at all.
//
// Everything here controls REAL MONEY, so every field is clamped on write and
// re-clamped on read — a bad value in Redis can never widen risk beyond the
// hard ceilings below.
// ----------------------------------------------------------------------------

const { getRedis, safeParse } = require('./_lib');

const SETTINGS_KEY = 'v20:trade:settings';

// Hard ceilings. These are NOT user-configurable on purpose: they are the last
// line of defence between a typo in the UI and a blown FTMO account.
const MAX_RISK_PCT   = 0.05;   // 5% — above this one loss breaches the daily cap
const MIN_RISK_PCT   = 0.001;  // 0.1%
const MAX_TP_R       = 20.0;
const MIN_TP_R       = 0.1;
const MAX_LADDER_LEN = 6;

const DEFAULTS = {
  riskPct: 0.04,          // fraction of equity risked per trade (0.04 = 4%)
  // 4% since 2026-09-22, paired with the gold specialist's 76-pt stop:
  // entry->SL is ~80 pts, so 4% of ~$100k buys exactly 0.50 lots. The two
  // numbers are a matched pair — moving either one moves the live lot.
  // NOTE this is GLOBAL: it sizes sp500-specialist too, not just gold.
  // NOTE this is only the FALLBACK. getTradeSettings() reads Redis first,
  // so a value saved from the control panel overrides this.

  // 'ratchet'  — NO take-profit is ever placed. The stop ratchets one rung
  //              behind price, forever: reach rung n, stop moves to rung n-1.
  //              A runner is never capped; it exits only when the stop catches
  //              it. Rungs are spaced by the TP spacing the Pine already sends
  //              (tp2-tp1), extended past TP3 indefinitely.
  // 'final-tp' — legacy: full position rides to the last TP and closes there.
  exitMode: 'ratchet',

  // Ratchet trail geometry, both measured in ORB-range units from the ORB
  // structural level (the same unit tp1/tp2/tp3 use).
  //   trailArm  — how far price must travel before the trail takes over from
  //               the original stop. 0.75 = the old TP1 distance.
  //   trailKeep — fraction of the furthest excursion that is LOCKED. The stop
  //               sits at trailKeep x reach, so giveback is (1 - trailKeep).
  //               0.75 means reaching 0.75 range locks ~0.56 range — profit,
  //               never breakeven-at-entry.
  trailArm: 0.75,
  trailKeep: 0.75,

  tpR: 3.0,               // final take-profit, in R (R = entry→SL distance)
  ladderEnabled: true,    // master switch for the R-ladder stop management
  // Each rung: when price reaches `trigger` R of profit, move SL to `slAt` R.
  // slAt > 0 locks profit; slAt = 0 is breakeven; slAt < 0 is a partial stop cut.
  ladder: [
    { trigger: 0.75, slAt: 0.5 },
    { trigger: 1.0,  slAt: 0.75 },
    { trigger: 2.0,  slAt: 1.5 },
  ],
  updatedAt: null,
  updatedBy: null,
};

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// RISK_PCT ENV OVERRIDE - added 2026-09-22.
//
// The control panel is the intended way to set risk, but it is not usable on
// this deployment, which leaves whatever is sitting in Redis in charge with no
// way to see or change it. This gives a lever that does not need the panel:
// set RISK_PCT in the Vercel dashboard and it wins over the stored value.
//
// PRECEDENCE: env  >  Redis  >  DEFAULTS.
//
// THE TRAP: while this is set, saving risk from a control panel APPEARS to
// work (setTradeSettings writes Redis and echoes the new number back) but does
// NOT change live sizing, because every read re-applies the env value on top.
// getTradeSettings reports riskPctSource:'env' so that is at least visible.
// If a working panel ever arrives, UNSET THIS VAR.
//
// Accepts either a fraction (0.04) or a percent (4). Anything >= 1 is read as
// a percent, because 4 meaning 400% risk is never what anyone intended. Still
// clamped to [0.1%, 5%], so a typo here cannot widen risk past the ceiling.
function envRiskPct() {
  const raw = process.env.RISK_PCT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1) n = n / 100;
  return clampNum(n, MIN_RISK_PCT, MAX_RISK_PCT, null);
}

// A ladder is only usable if it is strictly ascending by trigger and every rung
// locks LESS than it triggers at (slAt < trigger) — otherwise the stop would sit
// at or beyond the price that armed it and fill instantly.
function sanitizeLadder(raw) {
  if (!Array.isArray(raw)) return DEFAULTS.ladder.slice();
  const rungs = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const trigger = clampNum(r.trigger, 0.05, MAX_TP_R, NaN);
    const slAt    = clampNum(r.slAt, -1.0, MAX_TP_R, NaN);
    if (!Number.isFinite(trigger) || !Number.isFinite(slAt)) continue;
    if (slAt >= trigger) continue;               // would fill the moment it arms
    rungs.push({ trigger: +trigger.toFixed(3), slAt: +slAt.toFixed(3) });
  }
  rungs.sort((a, b) => a.trigger - b.trigger);
  // drop duplicate/non-ascending triggers and anything past the rung cap
  const out = [];
  for (const r of rungs) {
    if (out.length && r.trigger <= out[out.length - 1].trigger) continue;
    if (out.length && r.slAt <= out[out.length - 1].slAt) continue;  // must ratchet UP
    out.push(r);
    if (out.length >= MAX_LADDER_LEN) break;
  }
  return out;
}

function sanitize(s) {
  const base = s && typeof s === 'object' ? s : {};
  const tpR = clampNum(base.tpR, MIN_TP_R, MAX_TP_R, DEFAULTS.tpR);
  let ladder = sanitizeLadder(base.ladder);
  // A rung at or beyond the final target can never fire — drop those.
  ladder = ladder.filter(r => r.trigger < tpR);
  return {
    riskPct: clampNum(base.riskPct, MIN_RISK_PCT, MAX_RISK_PCT, DEFAULTS.riskPct),
    exitMode: base.exitMode === 'final-tp' ? 'final-tp' : 'ratchet',
    // trailKeep capped below 1.0 — at 1.0 the stop would sit exactly on the
    // current extreme and get taken out by the first tick of noise.
    trailArm:  clampNum(base.trailArm,  0.05, 10.0, DEFAULTS.trailArm),
    trailKeep: clampNum(base.trailKeep, 0.10, 0.95, DEFAULTS.trailKeep),
    tpR,
    ladderEnabled: base.ladderEnabled !== false,
    ladder,
    updatedAt: base.updatedAt || null,
    updatedBy: base.updatedBy || null,
  };
}

async function getTradeSettings() {
  // Applied on EVERY path, including the Redis-unavailable fallbacks, so the
  // override holds even when the store is down.
  const envPct = envRiskPct();
  const withEnv = (s) => envPct === null
    ? { ...s, riskPctSource: s.updatedAt ? 'redis' : 'default' }
    : { ...s, riskPct: envPct, riskPctSource: 'env' };

  const r = getRedis();
  if (!r) return withEnv({ ...DEFAULTS });
  try {
    const raw = await r.get(SETTINGS_KEY);
    const parsed = safeParse(raw);
    if (!parsed) return withEnv({ ...DEFAULTS });
    return withEnv(sanitize(parsed));
  } catch (_) {
    return withEnv({ ...DEFAULTS });
  }
}

// Partial update — only the keys supplied are changed. Returns the stored result
// so the caller can show the user exactly what was persisted after clamping
// (which may differ from what they typed).
async function setTradeSettings(patch, who = 'control-panel') {
  const r = getRedis();
  if (!r) return { ok: false, error: 'redis unavailable' };
  try {
    const current = await getTradeSettings();
    const merged = sanitize({
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
      updatedAt: Date.now(),
      updatedBy: who,
    });
    await r.set(SETTINGS_KEY, JSON.stringify(merged));
    return { ok: true, settings: merged };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Given entry/SL and a direction, turn the R-ladder into absolute prices so
// manage-trades can compare them against live price without re-deriving R.
function ladderToPrices(entry, slInitial, isLong, settings) {
  const R = Math.abs(entry - slInitial);
  if (!(R > 0)) return { R: 0, rungs: [], tpPrice: null };
  const sgn = isLong ? 1 : -1;
  const rungs = (settings.ladder || []).map(r => ({
    trigger: r.trigger,
    slAt: r.slAt,
    triggerPrice: entry + sgn * r.trigger * R,
    slPrice: entry + sgn * r.slAt * R,
  }));
  return { R, rungs, tpPrice: entry + sgn * settings.tpR * R };
}

module.exports = {
  getTradeSettings,
  setTradeSettings,
  ladderToPrices,
  DEFAULTS,
  MAX_RISK_PCT,
  SETTINGS_KEY,
};
