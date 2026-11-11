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
  }
  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
