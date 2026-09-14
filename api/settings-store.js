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
  riskPct: 0.01,          // fraction of equity risked per trade (0.01 = 1%)
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
    tpR,
    ladderEnabled: base.ladderEnabled !== false,
    ladder,
    updatedAt: base.updatedAt || null,
    updatedBy: base.updatedBy || null,
  };
}

async function getTradeSettings() {
  const r = getRedis();
  if (!r) return { ...DEFAULTS };
  try {
    const raw = await r.get(SETTINGS_KEY);
    const parsed = safeParse(raw);
    if (!parsed) return { ...DEFAULTS };
    return sanitize(parsed);
  } catch (_) {
    return { ...DEFAULTS };
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
