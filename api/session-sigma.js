/* eslint-disable */
// api/session-sigma.js
//
// HOUR-MATCHED SESSION SIGMA — the unit the one-shot exit measures in.
//
// WHY THIS FILE EXISTS. The one-shot arms at 3 x sigma and locks at 1 x
// sigma, and sigma is NOT a quantity the live path had: webhook and
// manage-trades see the entry, the SL and tp1/tp2/tp3, nothing else.
// Measured on 4.4yr of broker 15m, blend, U dropped, at his live 4% risk:
//
//     unit          best R/DD   peak DD@4%   breach@4%
//     sigma             19.40        9.88%        0.0%
//     ORB range         13.86       11.62%        3.9%
//     ATR15             12.83       13.89%        2.6%
//
// So sigma is not a preference, it is the difference between an engine that
// survives 4% risk and one that does not. Substituting the ORB range - which
// would have been free, since the specialist TPs encode it - reintroduces a
// 3.9% breach rate. Hence this module.
//
// THE DEFINITION, mirroring g15.build_ctx exactly:
//   sigma(hour) = mean of (high - low) for THAT HOUR-OF-DAY, over the last
//                 `LOOK` days on which the hour traded, using days STRICTLY
//                 BEFORE today.
// It is an hour-of-day volatility profile, not an average of ORB ranges.
// 14:00 UTC is a different animal from 03:00 UTC, and a single global ATR is
// mis-specified by about 2x across the four sessions this bot trades.
//
// ★ THE STRICT INEQUALITY IS LOAD-BEARING. Including the current day's own
// range would let a trade's exit distance be set by the very move it is
// trying to measure. g15 carries a comment that this exact lookahead faked a
// project best once already, so the cutoff is reproduced here deliberately
// rather than inherited by accident.
//
// ⚠ ONE KNOWN DEVIATION FROM THE BACKTEST. g15 groups bars by the BROKER's
// daily bar boundary; this groups by UTC calendar day, because the live path
// has no daily series to hand. The hour's own range is identical either way
// - only WHICH 14 prior days get averaged can shift by one. On a 14-sample
// mean that is second order. It would matter most at 22:00, which sits near
// a typical broker rollover, and that is the Sydney hour his blend drops.

const { getRedis, safeParse } = require('./_lib');
const { fetchCandles } = require('./broker');

const LOOK = 14;          // days per hour-of-day, as sighLook in the backtest
const MIN_DAYS = 6;       // below this the mean is too thin to size a stop on
const FETCH = 500;        // fetchCandles hard cap; ~20 calendar days of 1h
const TTL_SEC = 6 * 3600; // the value only changes when a new day closes

function hourOf(ms) { return Math.floor((ms % 86400000) / 3600000); }
function dayOf(ms)  { return Math.floor(ms / 86400000); }

// ---------------------------------------------------------------------------
// Returns { sigma, hour, days, source } or { error }. NEVER throws: the exit
// path must degrade to "no sigma, leave the stop alone" rather than blow up
// mid-manage and leave a position unmanaged.
// ---------------------------------------------------------------------------
async function hourSigma(asset, nowMs = Date.now()) {
  const hour = hourOf(nowMs);
  const today = dayOf(nowMs);
  const key = `v20:sigma:${asset}:${today}:${hour}`;

  try {
    const r = await getRedis();
    if (r) {
      const hit = safeParse(await r.get(key));
      if (hit && isFinite(hit.sigma) && hit.sigma > 0) {
        return { ...hit, source: 'cache' };
      }
    }
  } catch (_) {}

  let candles = [];
  try {
    const res = await fetchCandles(asset, '1h', FETCH);
    candles = (res && res.candles) || [];
    if (res && res.error && candles.length === 0) {
      return { error: `candles: ${res.error}` };
    }
  } catch (e) {
    return { error: `candles threw: ${e && e.message}` };
  }
  if (candles.length < 24 * MIN_DAYS) {
    return { error: `only ${candles.length} 1h candles` };
  }

  // One 1h candle IS that hour's range, so no regrouping is needed - unlike
  // the backtest, which had to fold 15m bars up into hours first.
  const byDay = new Map();
  for (const c of candles) {
    const t = new Date(c.time).getTime();
    if (!isFinite(t)) continue;
    if (hourOf(t) !== hour) continue;
    const d = dayOf(t);
    if (d >= today) continue;              // STRICTLY BEFORE today
    const rng = Number(c.high) - Number(c.low);
    if (!isFinite(rng) || rng <= 0) continue;
    // if a day somehow yields two bars for the hour, keep the wider
    const prev = byDay.get(d);
    if (prev == null || rng > prev) byDay.set(d, rng);
  }

  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).slice(-LOOK);
  if (days.length < MIN_DAYS) {
    return { error: `only ${days.length} prior days at hour ${hour}` };
  }
  const sigma = days.reduce((s, [, v]) => s + v, 0) / days.length;
  if (!isFinite(sigma) || sigma <= 0) return { error: 'sigma not finite' };

  const out = { sigma: +sigma.toFixed(5), hour, days: days.length };
  try {
    const r = await getRedis();
    if (r) await r.set(key, JSON.stringify(out), { ex: TTL_SEC });
  } catch (_) {}
  return { ...out, source: 'computed' };
}

module.exports = { hourSigma, LOOK, MIN_DAYS };
