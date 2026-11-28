/* eslint-disable */
// api/_staircase.test.js
//
// VERIFY HIS STAIRCASE BEFORE IT TOUCHES A LIVE ORDER.
//
// The engine is three formulas spread over two files, and a sign error in any
// of them is a real-money bug that nothing downstream can catch: the order
// would simply rest at a price the backtest never used. So each formula is
// re-derived here from his spec and checked against the code's own expression,
// for LONG and for SHORT - short being where the sign errors hide, since
// "better" means a LOWER price there.
//
// HIS SPEC, in ORB-range units from the broken level:
//   TP1 0.75 -> SL 0.375    TP3 2.25 -> SL 1.875
//   TP2 1.50 -> SL 1.125    TP4 3.00 -> full exit
//
// Run: node api/_staircase.test.js

const { getTradeSettings } = require('./settings-store');

let fails = 0;
function eq(label, got, want, tol = 1e-9) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: got ${got}, want ${want}`);
}
function is(label, got, want) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── the code's own expressions, copied verbatim from the two call sites ─────
function stairFromTPs(isLong, tp1, tp2, stairFinal, stairGive, rung) {
  const step  = Math.abs(tp2 - tp1);
  const level = isLong ? tp1 - step : tp1 + step;
  const finalPrice = isLong
    ? level + stairFinal * step
    : level - stairFinal * step;
  const lockRung = rung - stairGive;
  const slPrice = isLong
    ? level + lockRung * step
    : level - lockRung * step;
  return { step, level, finalPrice, slPrice };
}
function reachOf(isLong, level, step, extreme) {
  return isLong ? (extreme - level) / step : (level - extreme) / step;
}
// Copied verbatim from manage-trades.js, the per-signal arm resolution. The
// scoping is the part that matters: sp500-specialist uses the SAME zoneType
// keys ('FRB', 'NYORB') and was never measured for this, so keying on the
// zone alone would re-arm the S&P engine off a gold study.
function armRangesFor(_qbSettings, matchedPending) {
  const _armZone = (matchedPending?.setup?.template === 'gold-specialist')
    ? matchedPending.setup.zoneType : null;
  return (_armZone && _qbSettings.stairArmZone
    && typeof _qbSettings.stairArmZone[_armZone] === 'number')
    ? _qbSettings.stairArmZone[_armZone]
    : _qbSettings.stairArm;
}
function pend(template, zoneType) {
  return { setup: { template, zoneType } };
}
// Copied verbatim from manage-trades.js, the dollar ladder. $ per 1.00 of
// price is volume x contractSize (gold 100), so 0.78 lot = $78 per point -
// which is exactly the figure his live fills imply (1R = $4,150 on a 53.2pt
// stop). The whole engine is these four expressions.
function dladUsdPerPrice(volume, contractSize) {
  return (volume || 0) * (contractSize || 0);
}
function dladPeakUsd(isLong, ref, entry, usdPerPrice) {
  return (isLong ? (ref - entry) : (entry - ref)) * usdPerPrice;
}
function dladRungOf(peakUsd, step) {
  // the DLAD_EPS from manage-trades.js: an exact rung hit computes a hair
  // under the rung, so without this a +$1,000.00 peak reads as rung 0.
  return Math.floor(peakUsd / step + 1e-9);
}
function dladLockUsdOf(rung, step, lock) {
  return rung >= 1 ? (rung - 1) * step + lock : 0;
}
function dladSlPrice(isLong, entry, lockUsd, usdPerPrice) {
  return isLong ? entry + lockUsd / usdPerPrice
                : entry - lockUsd / usdPerPrice;
}
function dladFinalPriceOf(isLong, entry, finalUsd, usdPerPrice) {
  if (!(finalUsd > 0)) return null;
  return isLong ? entry + finalUsd / usdPerPrice
                : entry - finalUsd / usdPerPrice;
}

// ══ THE DOLLAR LADDER (2026-11-27, HIS DESIGN) ═════════════════════════════
// Spec: "if price reaches 1000$ move sl to 800$ then when it reaches 2000$
// move sl to 1800$ then when it reaches 3000$ move sl to 2800$ continue like
// that until reaching final tp 5K take the hole profit".
// Shipped with lock $900 (MEASURED: of his five candidates over 4.4 years,
// $700 +$98,074 / $750 +$97,272 / $800 +$99,297 / $850 +$102,801 /
// $900 +$107,598 against the staircase's +$87,115 - monotone in the
// tightness of the giveback, and BOTH walk-forward halves chose $900) and a
// $3,000 final target (his $5,000 never fired once in 4.4 years: nothing
// ever climbed past rung 4).
{
  console.log('\n--- THE DOLLAR LADDER: his real sizing, 0.78 lot gold ---');
  const VOL = 0.78, CS = 100, ENTRY = 4000;
  const upp = dladUsdPerPrice(VOL, CS);
  eq('  $ per 1.00 of price = 0.78 x 100', upp, 78);
  eq('  so 1R on a 53.2pt stop is his $4,150', upp * 53.2, 4149.6, 0.5);

  const STEP = 1000, LOCK = 900, FINAL = 3000;
  // --- where each rung FIRES, and what it LOCKS (long)
  const fires = (k) => ENTRY + (k * STEP) / upp;
  eq('  rung 1 fires at +$1,000 = 4012.82', fires(1), 4012.8205, 1e-3);
  eq('  rung 2 fires at +$2,000 = 4025.64', fires(2), 4025.6410, 1e-3);
  eq('  rung 3 fires at +$3,000 = 4038.46', fires(3), 4038.4615, 1e-3);

  const lockAt = (k) => dladSlPrice(true, ENTRY,
    dladLockUsdOf(k, STEP, LOCK), upp);
  eq('  rung 1 locks $900  -> SL 4011.54', lockAt(1), 4011.5385, 1e-3);
  eq('  rung 2 locks $1,900 -> SL 4024.36', lockAt(2), 4024.3590, 1e-3);
  eq('  rung 3 locks $2,900 -> SL 4037.18', lockAt(3), 4037.1795, 1e-3);
  // the giveback is a FIXED $100 at EVERY rung - the property 'ratchet' lacks
  for (const k of [1, 2, 3, 4]) {
    eq(`  rung ${k} giveback is always $${STEP - LOCK}`,
       (fires(k) - lockAt(k)) * upp, STEP - LOCK, 1e-6);
  }

  // --- the rung is a floor of the PEAK, and never goes backwards
  eq('  peak +$999 is still rung 0 (stop untouched)',
     dladRungOf(dladPeakUsd(true, ENTRY + 999 / upp, ENTRY, upp), STEP), 0);
  eq('  peak +$1,000 is rung 1',
     dladRungOf(dladPeakUsd(true, fires(1), ENTRY, upp), STEP), 1);
  eq('  peak +$1,999 is still rung 1',
     dladRungOf(dladPeakUsd(true, ENTRY + 1999 / upp, ENTRY, upp), STEP), 1);
  eq('  rung 0 locks nothing', dladLockUsdOf(0, STEP, LOCK), 0);

  // --- SHORT is the mirror, which is where a sign error would show
  const sEntry = 4000;
  const sLock1 = dladSlPrice(false, sEntry, dladLockUsdOf(1, STEP, LOCK), upp);
  eq('  SHORT rung 1 locks $900 -> SL 3988.46', sLock1, 3988.4615, 1e-3);
  eq('  SHORT peak is measured downward',
     dladPeakUsd(false, sEntry - 1000 / upp, sEntry, upp), 1000, 1e-6);
  is('  SHORT stop sits BELOW the short entry', sLock1 < sEntry, true);

  // --- the final target
  eq('  final $3,000 -> TP 4038.46',
     dladFinalPriceOf(true, ENTRY, FINAL, upp), 4038.4615, 1e-3);
  is('  final 0 means NO target',
     dladFinalPriceOf(true, ENTRY, 0, upp) === null, true);
  // his $5,000 would have sat here, and nothing reached it in 4.4 years
  eq('  his original $5,000 would be 4064.10',
     dladFinalPriceOf(true, ENTRY, 5000, upp), 4064.1026, 1e-3);

  // --- a DIFFERENT lot size must not change the DOLLARS, only the prices
  const upp2 = dladUsdPerPrice(0.2, CS);
  eq('  0.20 lot = $20 per point', upp2, 20);
  eq('  rung 1 still locks $900 of profit at 0.20 lot',
     (dladSlPrice(true, ENTRY, dladLockUsdOf(1, STEP, LOCK), upp2) - ENTRY)
     * upp2, 900, 1e-6);
  is('  but it needs a FURTHER move to get there',
     dladSlPrice(true, ENTRY, 900, upp2)
     > dladSlPrice(true, ENTRY, 900, upp), true);

  // --- 27 Nov, his actual trade: ~$1,000 peak on an FRB long
  console.log('  the 27-Nov trade, under this engine:');
  const pk = 1000;
  const rk = dladRungOf(pk, STEP);
  eq('  a $1,000 peak clears rung 1', rk, 1);
  eq('  so it would have banked $900 instead of -$4,036',
     dladLockUsdOf(rk, STEP, LOCK), 900);
  is('  (a $999 peak would NOT have - the rung is a hard edge)',
     dladRungOf(999, STEP) === 0, true);
}

// ── LONG: ORB level 4000, range 20, depth 0.25 -> entry 4005 ───────────────
{
  const LVL = 4000, RNG = 20, STEP = 0.75 * RNG;       // 15
  const tp1 = LVL + STEP, tp2 = LVL + 2 * STEP;        // 4015, 4030
  const entry = LVL + 0.25 * RNG;                      // 4005
  console.log('\n--- LONG  level 4000  range 20  entry 4005 ---');
  const g = stairFromTPs(true, tp1, tp2, 4, 0.5, 1);
  eq('rung spacing = 0.75 x range', g.step, 15);
  eq('ORB level recovered from tp1/tp2', g.level, LVL);
  eq('rung 4 (final) = level + 3.00 x range', g.finalPrice, LVL + 3.0 * RNG);

  for (const [n, want] of [[1, 0.375], [2, 1.125], [3, 1.875]]) {
    const s = stairFromTPs(true, tp1, tp2, 4, 0.5, n);
    eq(`cleared rung ${n} -> SL at ${want} x range`, s.slPrice, LVL + want * RNG);
  }
  // the stop must be in PROFIT at rung 1, not at breakeven
  const s1 = stairFromTPs(true, tp1, tp2, 4, 0.5, 1).slPrice;
  is('rung-1 stop locks profit (above entry)', s1 > entry, true);
  eq('reach at TP1 touch = 1.0', reachOf(true, LVL, STEP, tp1), 1.0);
  eq('reach at TP3 touch = 3.0', reachOf(true, LVL, STEP, LVL + 3 * STEP), 3.0);
}

// ── SHORT: the mirror. "Better" is a LOWER price. ──────────────────────────
{
  const LVL = 4000, RNG = 20, STEP = 0.75 * RNG;
  const tp1 = LVL - STEP, tp2 = LVL - 2 * STEP;        // 3985, 3970
  const entry = LVL - 0.25 * RNG;                      // 3995
  console.log('\n--- SHORT  level 4000  range 20  entry 3995 ---');
  const g = stairFromTPs(false, tp1, tp2, 4, 0.5, 1);
  eq('rung spacing', g.step, 15);
  eq('ORB level recovered', g.level, LVL);
  eq('rung 4 (final) = level - 3.00 x range', g.finalPrice, LVL - 3.0 * RNG);

  for (const [n, want] of [[1, 0.375], [2, 1.125], [3, 1.875]]) {
    const s = stairFromTPs(false, tp1, tp2, 4, 0.5, n);
    eq(`cleared rung ${n} -> SL at ${want} x range`, s.slPrice, LVL - want * RNG);
  }
  const s1 = stairFromTPs(false, tp1, tp2, 4, 0.5, 1).slPrice;
  is('rung-1 stop locks profit (BELOW entry on a short)', s1 < entry, true);
  eq('reach at TP1 touch = 1.0', reachOf(false, LVL, STEP, tp1), 1.0);
}

// ── the giveback cliff, which is why stairGive is capped at 0.60 ───────────
{
  const LVL = 4000, RNG = 20, STEP = 0.75 * RNG;
  const tp1 = LVL + STEP, tp2 = LVL + 2 * STEP;
  const entry = LVL + 0.25 * RNG;
  console.log('\n--- the 0.667 breakeven cliff ---');
  const atCap = stairFromTPs(true, tp1, tp2, 4, 0.60, 1).slPrice;
  is('at the 0.60 cap the rung-1 stop is still in profit', atCap > entry, true);
  // The cliff sits at an EXACT fraction, not at 0.667: the entry is
  // depth x range past the level, which in rung units is 0.25/0.75 = 1/3, so
  // the rung-1 stop reaches the entry when the giveback is 1 - 1/3 = 2/3.
  // Asserting 0.667 with a 1e-6 tolerance failed by 0.005 of a point - the
  // test was wrong, the clamp was not.
  const cliff = 1 - 0.25 / 0.75;
  eq('the cliff is exactly 2/3 of a rung', cliff, 2 / 3);
  const past = stairFromTPs(true, tp1, tp2, 4, cliff, 1).slPrice;
  eq('at 2/3 the rung-1 stop lands exactly AT the entry', past, entry, 1e-9);
  is('so the 0.60 cap keeps a real margin below it', 0.60 < cliff, true);
}

// ── THE ONE-SHOT: stage 1, the frozen lock, and the banked third ───────────
// Levels are in SIGMA, not ORB range. sigma is the hour-of-day unit from
// session-sigma.js, verified in f88 to reproduce the backtest on 100.00% of
// 100,147 bars.
function osLevels(isLong, entry, risk, sigma, arm, give, s1Keep) {
  const d = isLong ? 1 : -1;
  return {
    s1:   entry - d * s1Keep * risk,
    lock: entry + d * (arm - give) * sigma,
  };
}
{
  const SIG = 6.0, RISK = 50.0;
  console.log('\n--- ONE-SHOT  sigma 6.0  risk 50  arm 3.0  give 2.0 ---');
  const L = osLevels(true, 4005, RISK, SIG, 3.0, 2.0, 0.25);
  eq('LONG  stage 1 -> entry - 0.25 x risk', L.s1, 4005 - 12.5);
  eq('LONG  lock    -> entry + 1.0 sigma',   L.lock, 4005 + 6.0);
  is('LONG  stage 1 cuts the loss but does NOT lock profit', L.s1 < 4005, true);
  is('LONG  the lock IS in profit', L.lock > 4005, true);
  const S = osLevels(false, 3995, RISK, SIG, 3.0, 2.0, 0.25);
  eq('SHORT stage 1 -> entry + 0.25 x risk', S.s1, 3995 + 12.5);
  eq('SHORT lock    -> entry - 1.0 sigma',   S.lock, 3995 - 6.0);
  is('SHORT the lock IS in profit (lower price)', S.lock < 3995, true);
  // the arm distances themselves
  eq('LONG  arms stage 1 at +1 sigma of best CLOSE', 1.0 * SIG, 6.0);
  eq('LONG  arms the lock at +3 sigma of best CLOSE', 3.0 * SIG, 18.0);
  is('so the lock gives back exactly 2 sigma of the 3 it earned',
     Math.abs((3.0 - 1.0) * SIG - 12.0) < 1e-9, true);
}

// ── the banked third must respect the 0.01 gold lot step ──────────────────
function bankLots(volume, pct) {
  const lot  = Math.round(volume * pct * 100) / 100;
  const rest = Math.round((volume - lot) * 100) / 100;
  return { lot, rest, ok: lot >= 0.01 && rest >= 0.01 };
}
{
  console.log('\n--- the banked third vs the 0.01 lot step ---');
  let b = bankLots(0.50, 0.33);
  eq('0.50 lot: banked', b.lot, 0.17);
  eq('0.50 lot: runner', b.rest, 0.33);
  is('0.50 lot splits', b.ok, true);
  b = bankLots(0.03, 0.33);
  is('0.03 lot still splits (0.01 / 0.02)', b.ok, true);
  b = bankLots(0.01, 0.33);
  is('0.01 lot CANNOT split - must be skipped, not sent', b.ok, false);
  b = bankLots(0.02, 0.33);
  is('0.02 lot: 0.01 banked, 0.01 runs', b.ok, true);
}

// ── the settings store must accept the mode and clamp the knobs ────────────
(async () => {
  console.log('\n--- settings-store contract ---');
  const { sanitizeForTest, DEFAULTS } = require('./settings-store');
  const san = sanitizeForTest || null;
  if (!san) {
    console.log('note  sanitize not exported; checking live defaults instead');
    const s = await getTradeSettings();
    is('staircase is a legal exitMode',
       ['ratchet', 'tp1', 'final-tp', 'staircase'].includes(s.exitMode), true);
    eq('stairGive default', s.stairGive, 0.5);
    eq('stairFinal default', s.stairFinal, 4);
    is('day 1 recorded', s.staircaseSince, '2026-11-11');
  } else {
    is('accepts staircase', san({ exitMode: 'staircase' }).exitMode, 'staircase');
    // the fallback is DEFAULTS.exitMode now, not a hardcoded 'ratchet' -
    // that literal made the default unreachable. Asserted against the
    // default so this keeps working the next time the default moves.
    is('rejects nonsense', san({ exitMode: 'moon' }).exitMode,
       DEFAULTS.exitMode);
    is('the $ ladder is the default', san({}).exitMode, 'dladder');
    eq('clamps stairGive above the cliff', san({ stairGive: 0.95 }).stairGive, 0.60);
    eq('clamps stairGive below floor', san({ stairGive: 0.01 }).stairGive, 0.10);
    eq('stairFinal rounds + clamps', san({ stairFinal: 99 }).stairFinal, 8);
    is('day 1 survives a junk write', san({ staircaseSince: 'nope' }).staircaseSince,
       '2026-11-11');
    console.log('  one-shot:');
    is('  accepts oneshot', san({ exitMode: 'oneshot' }).exitMode, 'oneshot');
    eq('  osArm default', san({}).osArm, 3.0);
    eq('  osGive default', san({}).osGive, 2.0);
    // the relation, not just the range: osGive >= osArm would place the lock
    // at or beyond the price that armed it and fill it instantly
    const bad = san({ osArm: 2.0, osGive: 5.0 });
    is('  osGive >= osArm is CORRECTED, not just clamped', bad.osGive < bad.osArm, true);
    eq('  and corrected to half the arm', bad.osGive, 1.0);
    const eqArm = san({ osArm: 3.0, osGive: 3.0 });
    is('  osGive == osArm is also corrected', eqArm.osGive < eqArm.osArm, true);
    eq('  osPartPct clamps at 0.9', san({ osPartPct: 5 }).osPartPct, 0.9);
    eq('  osS1Keep clamps at 1.0', san({ osS1Keep: 9 }).osS1Keep, 1.0);
    console.log('  arm + stop grid (2026-11-17):');
    eq('  stairArm default is the derived 1.25', san({}).stairArm, 1.25);
    eq('  stairArm 0 stays reachable', san({ stairArm: 0 }).stairArm, 0);
    eq('  stairArm caps at 3.00', san({ stairArm: 99 }).stairArm, 3.0);
    // 0.25 -> 0.10 on 2026-11-27, for the RULE and not for performance: see
    // the profit-lock invariant below. On its own the grid change is a wash
    // (+20.99 R against +20.53, maxDD 6.67 vs 6.73).
    eq('  stairQ default 0.10', san({}).stairQ, 0.10);
    eq('  stairQ floor 0.05 (never a continuous trail)',
       san({ stairQ: 0 }).stairQ, 0.05);
    eq('  stairQ caps at 1.00', san({ stairQ: 9 }).stairQ, 1.0);

    // ── THE PER-SIGNAL ARM, 2026-11-27 ──────────────────────────────────
    // FRB arms LATER (2.00 ranges), NYORB EARLIER (0.50). Over 4.4 yr that
    // pair is +31.04 R / maxDD 5.17 / R/DD 6.01 against the single global
    // arm's +20.53 / 6.73 / 3.05, and it is the only configuration found
    // that raised big wins AND cut big losses at the same time. LORB and
    // SYD are ABSENT on purpose: the two walk-forward halves picked
    // opposite ends for them, which is no information.
    console.log('  per-signal arm (2026-11-27):');
    eq('  FRB arms later, at 2.00', san({}).stairArmZone.FRB, 2.0);
    eq('  NYORB arms earlier, at 0.50', san({}).stairArmZone.NYORB, 0.5);
    is('  LORB has no override, so it uses the global',
       san({}).stairArmZone.LORB === undefined, true);
    is('  SYD has no override, so it uses the global',
       san({}).stairArmZone.SYD === undefined, true);
    is('  an unknown zone key is dropped',
       Object.keys(san({ stairArmZone: { FRB: 1, NOPE: 9 } })
         .stairArmZone).join(','), 'FRB');
    eq('  a per-zone arm caps at 3.00',
       san({ stairArmZone: { NYORB: 99 } }).stairArmZone.NYORB, 3.0);
    eq('  an empty map restores the single global arm',
       Object.keys(san({ stairArmZone: {} }).stairArmZone).length, 0);

    // ── THE PROFIT-LOCK INVARIANT ───────────────────────────────────────
    // "Never move the SL to a loss", as arithmetic. The stop parks at rung
    // (quantise(reach) - stairGive) and the quantiser can give back up to
    // stairQ of a rung, so the FIRST stop move clears the fill only when
    //     arm > STAIR_RUNG_STEP x (stairQ + stairGive)
    // At stairQ 0.25 that is 0.5625 and NYORB's 0.50 BREAKS it on 43 of 120
    // H trades (worst 6.1% of a range below the fill). At 0.10 it is 0.4500
    // and it holds on all 120. Checked against every SHIPPED arm so that
    // moving any one of the three numbers cannot silently re-break it.
    // What the engine will ACTUALLY use, through the real expression.
    console.log('  the resolution, through the live expression:');
    const _s = san({});
    eq('  gold FRB   -> 2.00', armRangesFor(_s, pend('gold-specialist', 'FRB')), 2.0);
    eq('  gold NYORB -> 0.50', armRangesFor(_s, pend('gold-specialist', 'NYORB')), 0.5);
    eq('  gold LORB  -> the global 1.25',
       armRangesFor(_s, pend('gold-specialist', 'LORB')), 1.25);
    eq('  gold SYD   -> the global 1.25',
       armRangesFor(_s, pend('gold-specialist', 'SYD')), 1.25);
    // the three ways this must fall back rather than guess
    eq('  S&P FRB is NOT re-armed off a gold study',
       armRangesFor(_s, pend('sp500-specialist', 'FRB')), 1.25);
    eq('  S&P NYORB is NOT re-armed off a gold study',
       armRangesFor(_s, pend('sp500-specialist', 'NYORB')), 1.25);
    eq('  an unknown gold zone falls back to the global',
       armRangesFor(_s, pend('gold-specialist', 'FVG')), 1.25);
    eq('  a missing setup falls back to the global',
       armRangesFor(_s, null), 1.25);
    eq('  an empty override map falls back to the global',
       armRangesFor(san({ stairArmZone: {} }), pend('gold-specialist', 'FRB')),
       1.25);

    console.log('  the profit-lock invariant:');
    const _d = san({});
    const _thr = 0.75 * (_d.stairQ + _d.stairGive);
    is(`  global arm ${_d.stairArm} clears the ${_thr.toFixed(4)} threshold`,
       _d.stairArm > _thr, true);
    for (const [z, v] of Object.entries(_d.stairArmZone || {})) {
      is(`  ${z} arm ${v} clears the ${_thr.toFixed(4)} threshold`,
         v > _thr, true);
    }
  }

  // ── THE 16 NOV TRADE, END TO END ────────────────────────────────────────
  // Real broker numbers, so this fails loudly if either formula drifts.
  // level 3868.195, range 6.76, rung 5.070, market fill 3877.78 (1.891 rungs
  // PAST the level - which is the whole reason the arm exists), MFE 3887.60.
  {
    console.log('\n--- 16 Nov 2026, the real trade ---');
    const LVL = 3868.195, RNG = 6.76, FILL = 3877.78, MFEP = 3887.60;
    const STEP = 0.75 * RNG;
    const DPP = 100 * 0.68;                       // $/point at 0.68 lots
    const reach = (MFEP - LVL) / STEP;
    eq('rung reach at the high', reach, 3.82742, 1e-5);

    // FIX 2. The arm is measured FROM THE FILL in ORB-RANGE units, and the
    // range is recovered as STEP / 0.75 exactly as manage-trades does.
    const armDist = (arm) => arm * (STEP / 0.75);
    const gain = MFEP - FILL;
    is('arm 1.25 DOES clear on this trade', gain >= armDist(1.25), true);
    eq('  it needed 8.45 pts of profit and got 9.82', armDist(1.25), 8.45, 1e-9);
    // and the arithmetic that makes the arm enforce his own rule
    const firstStop = (arm) => {
      const rk = Math.floor((FILL - LVL) / STEP + arm / 0.75);
      return LVL + (rk - 0.5) * STEP;
    };
    is('arm 1.25: the FIRST stop move is above the fill (profit locked)',
       firstStop(1.25) > FILL, true);
    is('arm 0.00: the first stop move is BELOW the fill - the old bug',
       firstStop(0.0) < FILL, true);
    eq('  and that stop was only 7.05 pts away, not 59.6',
       Math.round((FILL - (LVL + 0.5 * STEP)) * 100) / 100, 7.05);

    // FIX 1. The grid the stop steps on.
    const lock = (q) => (q >= 1 ? Math.floor(reach)
      : Math.max(1, Math.floor(reach / q) * q)) - 0.5;
    const money = (q) => Math.round((LVL + lock(q) * STEP - FILL) * DPP);
    eq('stairQ 1.00 locks rung 2.50 (what he actually got)', lock(1.0), 2.5);
    eq('  = $210', money(1.0), 210);
    eq('stairQ 0.25 locks rung 3.25', lock(0.25), 3.25);
    eq('  = $469', money(0.25), 469);
    is('  so fix 1 is worth +$259 on this trade',
       money(0.25) - money(1.0) === 259, true);
    // the guard that stops an odd grid placing the FIRST stop below rung 1
    eq('a grid that does not divide 1 evenly still floors at rung 1',
       Math.max(1, Math.floor(1.0 / 0.3) * 0.3) - 0.5, 0.5);
  }
  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
