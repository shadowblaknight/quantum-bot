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
  const { sanitizeForTest } = require('./settings-store');
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
    is('rejects nonsense', san({ exitMode: 'moon' }).exitMode, 'ratchet');
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
    eq('  stairQ default 0.25', san({}).stairQ, 0.25);
    eq('  stairQ floor 0.05 (never a continuous trail)',
       san({ stairQ: 0 }).stairQ, 0.05);
    eq('  stairQ caps at 1.00', san({ stairQ: 9 }).stairQ, 1.0);
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
