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
  // 'staircase'— HIS ENGINE, live from 2026-11-11. The ORB-range staircase:
  //              clearing rung n moves the stop to rung n minus HALF a rung,
  //              and rung `stairFinal` closes the position outright.
  //                TP1 0.75 -> SL 0.375    TP3 2.25 -> SL 1.875
  //                TP2 1.50 -> SL 1.125    TP4 3.00 -> full exit
  //              Unlike 'ratchet' the stop is a FIXED distance behind the last
  //              rung cleared rather than a fraction of the whole excursion,
  //              so the giveback does not grow with the win.
  //              ⚠ MEASURED 4.4yr, blend, U dropped: 91.5% win rate against
  //              58.1% for the one-shot, and 6.1%/yr against 35.3%/yr once
  //              both are sized to the same 8% account drawdown. The win rate
  //              is real; so is the cost. He chose it knowing both numbers -
  //              see the his-orb-staircase note.
  // * $ LADDER IS THE DEFAULT, 2026-11-28, HIS CALL. His own design, and the
  // only exit measured here that beats production on his own metric AND
  // survives both walk-forward halves: $113,867 over 4.4 years against the
  // staircase's $87,115, with sub-$500 wins falling from 191 to 4.
  // ! A STORED exitMode BEATS THIS. Production Redis carried 'staircase'
  // (updatedBy control-panel), so changing this default alone changes
  // nothing live - the stored value has to be rewritten too, and only AFTER
  // the deploy, because an older build would reject an unknown mode and fall
  // back to 'ratchet'.
  exitMode: 'dladder',

  // ── ENTRY MODE ───────────────────────────────────────────────
  // 'limit'  rest a pending order AT the signal entry (level + retestDepth x
  //          range) and let it fill on a pullback, or not at all.
  // 'market' probe the live price and send a market order immediately.
  //
  // WAS a hardcoded `const GOLD_MARKET_ENTRY = true` in webhook.js, turned on
  // 2026-10-21 after a Sydney sell-limit missed by 0.75 points. Measured
  // 2026-11-16 against the 4.4yr blend, with the SAME staircase exit in both
  // arms and the market chase calibrated to the three real `entry-routing`
  // fills in the production log (mean 8.4 pts):
  //
  //     limit  (depth 0.25)   685 tr  89.05% WR  +$126/trade  +$86,381
  //     market (live chase)   731 tr  72.09% WR  -$136/trade  -$99,484
  //
  // ★ THAT -$136 WAS WRONG AND IS CORRECTED, 2026-11-16. The calibration
  // forced the modelled mean chase to match a 3-sample live mean by adding a
  // flat 4.7 pts to every historical trade. But the model already reproduces
  // each live fill individually (16 Nov: modelled 7.87 against 7.89 paid) and
  // real broker slippage is ~0.4 pts. Three above-average days are not a
  // biased model. Paired signal by signal the honest figures are:
  //
  //     limit  +$126/trade      market  +$96/trade      gap  +$30
  //
  // ★★ AND HE CHOSE MARKET, 2026-11-17: "No entry mode stays market". The
  // DEFAULT IS THEREFORE 'market', not 'limit'. This is load-bearing: the
  // deployed settings blob predates this key, so a 'limit' default would
  // silently flip live routing the moment this ships - the opposite of his
  // decision. A $30/trade gap does not get to override an explicit call.
  // See bt/f99_calibrate.py, bt/f101_paired.py, [[entry-chase-kills-staircase]].
  entryMode: 'market',

  // ── HIS STAIRCASE ─────────────────────────────────────────────────────────
  // stairGive  — giveback behind the last rung cleared, in RUNG units. 0.5 is
  //              his spec ("0.75/2"). Hard-capped at 0.60 below, and that cap
  //              is load-bearing: the entry sits depth x range past the ORB
  //              level, which on the live geometry (depth 0.25, rung 0.75) is
  //              0.333 rungs. So a giveback of 1 - 0.333 = 0.667 puts the rung-1
  //              stop exactly AT the entry - breakeven, not profit. Measured:
  //              at that point the win rate collapses 91.6% -> 47.0%, because a
  //              scratch is not a win. Everything above 0.60 is that cliff.
  // stairFinal — the rung that closes the position. 4 is his spec (TP4). The
  //              Pine only sends tp1/tp2/tp3, so rung 4 is COMPUTED from the
  //              rung spacing rather than received.
  // stairArm   — ★ FIX 2, 2026-11-17. Excursion FROM THE FILL, in ORB-RANGE
  //              units, required before ANY stop move. 0 is the old behaviour
  //              and it is pathological: the rungs are anchored on the ORB
  //              LEVEL, a market fill lands past it (1.891 rungs past on
  //              16 Nov), so rung 1 was already cleared at open and a 59.6-pt
  //              stop became 7.1 pt on the first tick. Over 4.4 yr at 4% that
  //              setting is WORSE THAN NO STAIRCASE AT ALL - $13/trade against
  //              $246 - and 20 of 20 coin-flip arm times beat it.
  //              1.25 is DERIVED: stop = cleared - stairGive >= fill +
  //              stairArm - 1.5 rungs, so above 1.125 ranges the first stop
  //              move is always a profit lock, which is his own "never move
  //              the SL to a loss" rule enforced by arithmetic.
  //              ⚠ The VALUE is not established (arm 2.00 vs 1.00 is t=+1.71;
  //              the best cell sits inside the coin-flip spread). It is a
  //              delay chosen on principle - do not tune it off a sweep.
  // stairQ     — ★ FIX 1. The grid the stop steps on, in RUNGS. 1 = whole
  //              rungs, which DISCARDS the fractional reach: 16 Nov reached
  //              3.828 and was paid at 2.5, and that rounding cost $286 where
  //              the designed giveback cost $172. Mean 0.482 rungs discarded
  //              per trade across the tape. 0.25 steps on quarter-rungs and
  //              reprices 16 Nov from $210 to $469.
  //              ⚠ On the whole tape 0.25 is a WASH ($171/trade vs $179,
  //              maxDD 34.4% vs 29.8%). It moves money toward deep-reach
  //              trades and away from the rest. That trade-off was his call.
  // stairArmZone - * PER-SIGNAL ARM, 2026-11-27. The arm is the one staircase
  //              parameter whose best value differs by SIGNAL, and it is the
  //              only configuration found that moves BOTH ways at once: more
  //              big wins AND fewer big losses. On the 4.4-yr book:
  //                global 1.25  486 tr  +20.53 R  maxDD 6.73  R/DD 3.05  57 losses
  //                FRB 2.00 +
  //                NYORB 0.50   472 tr  +31.04 R  maxDD 5.17  R/DD 6.01  48 losses
  //              Both walk-forward halves agreed on the DIRECTION: FRB chose
  //              2.00 in both, NYORB chose below 1.25 in both (0.75 and 0.50).
  //              LORB and SYD are deliberately ABSENT - their two folds picked
  //              opposite ends (G 0.75 vs 2.00, U 2.00 vs 0.25), which is no
  //              information, so they stay on the global arm.
  //              An absent or non-numeric entry falls back to `stairArm`, so
  //              {} restores the single-arm behaviour exactly.
  //              ! GOLD ONLY, scoped by TEMPLATE in manage-trades.js.
  //                sp500-specialist uses the SAME zoneType keys ('FRB',
  //                'NYORB') and was never measured for this.
  //              ! Counter-intuitive, and it must be said plainly: FRB arming
  //                LATER accepts MORE full stops (17 vs 14) to collect bigger
  //                wins. It would NOT have saved the 27-Nov -$4,036 FRB trade.
  //                All of the loss-cutting comes from NYORB at 0.50.
  //              ! The measured gain is concentrated in 2026 (+18.52 R of the
  //                book's +20.53), as is every other 4.4-yr figure here.
  stairGive: 0.5,
  stairFinal: 4,
  stairArm: 1.25,
  stairArmZone: { FRB: 2.0, NYORB: 0.5 },
  // stairQ     - 0.25 -> 0.10 on 2026-11-27, and the reason is HIS RULE, not
  //              performance. The first stop move is a profit lock only when
  //                  arm  >  STAIR_RUNG_STEP x (stairQ + stairGive)
  //              because the quantiser can give back up to stairQ of a rung
  //              and the giveback takes stairGive more. That threshold is
  //                  stairQ 1.00 -> arm > 1.1250   (the old derivation)
  //                  stairQ 0.25 -> arm > 0.5625
  //                  stairQ 0.10 -> arm > 0.4500
  //              NYORB's measured arm is 0.50, which FAILS at 0.25: 43 of 120
  //              H trades would park their first stop at or below the fill, by
  //              up to 6.1% of an ORB range. At 0.10 it is 0 of 120.
  //              The grid change is near-neutral on its own - production at
  //              0.10 scores +20.99 R against +20.53, maxDD 6.67 vs 6.73 - so
  //              it buys the rule without buying a new bet. With the arms it
  //              is +30.51 R / maxDD 5.08 / R/DD 6.01 against the 0.25
  //              version's +31.04 / 5.17 / 6.01: the same R/DD, 0.53 R less,
  //              and H itself is marginally BETTER (+0.0562 vs +0.0551 R/tr).
  //              ! _wiring.audit.js section 10e FAILS if any shipped arm
  //                breaks the inequality above. Do not change one without it.
  stairQ: 0.10,

  // -- THE DOLLAR LADDER ----------------------------------------------------
  // 'dladder' exitMode. HIS DESIGN, 2026-11-27, spec verbatim:
  //   "if price reaches 1000$ move sl to 800$ then when it reaches 2000$ move
  //    sl to 1800$ then when it reaches 3000$ move sl to 2800$ continue like
  //    that until reaching final tp 5K take the hole profit"
  //
  // * WHY IT NEEDS NOTHING FROM THE SIGNAL. Every other engine here measures
  // distance in a volatility unit, so the staircase needs the specialist TP
  // grid to recover the ORB range and the one-shot needs an hourly sigma -
  // and each degrades when its input is missing. This one measures in
  // DOLLARS, which the position itself carries exactly:
  //     $ = (price - entry) x dir x volume x contractSize
  // so it has no grid and no sigma precondition that can fail.
  //
  // * SIZING MAKES IT EQUIVALENT TO AN R LADDER, WHICH IS WHY IT BACKTESTS.
  // Risk-based sizing keeps the dollar risk D constant and sets
  // lot = D / (stopPts x contractSize), so $P of profit is P/D in R whatever
  // the stop distance. At his 1R = $4,150 the spec is a rung every 0.241 R
  // with a 0.024 R giveback.
  //
  // dladLock - the profit the stop parks at on rung 1; rung n parks at
  //            (n-1) x dladStep + dladLock, so the giveback is a FIXED
  //            number of dollars at every rung. That is the property his
  //            spec has and 'ratchet' does not (there the giveback grows
  //            with the win).
  //            900 is MEASURED, not chosen: over 4.4 yr his five candidates
  //            scored $700 +$98,074 / $750 +$97,272 / $800 +$99,297 /
  //            $850 +$102,801 / $900 +$107,598 against the staircase's
  //            +$87,115, monotone in the tightness of the giveback, and
  //            BOTH walk-forward halves picked $900 and ranked all five the
  //            same way on the half they had not seen.
  // dladFinal- close the whole position at this profit. His spec says
  //            $5,000; $3,000 MEASURES BETTER (+27.44 R against +25.93) and
  //            in 4.4 years NOT ONE trade ever climbed past rung 4, so the
  //            $5,000 target never fired at all. 0 disables the target.
  // dladTouch- false fires the rungs on a 15m bar CLOSE, true on an
  //            intrabar touch. "If price reaches" literally means touch, but
  //            touch measures +18.74 R against the close's +25.93 - a wick
  //            arms a rung the bar then gives back, the same lesson as the
  //            arm-on-bar-1 bug. Left FALSE.
  dladStep: 1000,
  dladLock: 900,
  dladFinal: 3000,
  dladTouch: false,

  // tgMode - HOW MUCH TELEGRAM. "telegram has too much notification i want
  //          somthing new and clean", 2026-11-28, and the count was the
  //          problem: one trade that climbed three rungs produced ELEVEN
  //          messages (1 placed + 3 TP-confirmed + 3 rung + 3 SL-locked +
  //          1 closed), and stairQ 0.10 can move the stop on tenth-of-a-rung
  //          steps, so the SL-locked line alone could fire dozens of times.
  //   'card'    ONE message per position, EDITED in place as the trade moves.
  //             Telegram does not re-notify on an edit, so he is pinged once
  //             on open and once on close and can read the current state any
  //             time in between. The per-event messages this replaces are
  //             suppressed; ERRORS (SL warnings, OCO failures) are NOT - a
  //             failure must always be loud.
  //   'verbose' exactly the previous behaviour, kept so the card can be
  //             turned off without a deploy if it ever misbehaves.
  tgMode: 'card',

  // ── THE ONE-SHOT ──────────────────────────────────────────────────────────
  // 'oneshot' exitMode. Stage 1 cuts the risk early, the lock fires ONCE and
  // is then FROZEN, a third is banked at tp1, and no take-profit is ever
  // placed. The freeze is the design: the stop stops chasing, so a winner can
  // actually run - best win +7.79R against +2.14R for the staircase.
  //
  // MEASURED, blend, U dropped, 4.4yr: +47.94R, maxDD 2.47R, R/DD 19.40,
  // WR 58.1%. ★ AND IT IS THE ONLY ENGINE MEASURED THAT SURVIVES HIS LIVE 4%
  // RISK: peak drawdown 9.88% and 0.0% breach, against 16.6-22.1% / 17-20%
  // for the ratchet currently live and for the staircase.
  //
  // osArm / osGive are in SIGMA - the hour-of-day unit from session-sigma.js,
  // NOT ORB range. 3.0/2.0 means: arm when the best CLOSE is 3 sigma up, then
  // park the stop at entry + 1 sigma. Verified a plateau, not a spike: the
  // neighbours (2.0/1.0, 4.0/3.0, 2.5/1.5) measure R/DD 16.04, 15.33, 14.73
  // with breach <= 3.3%, so this is not one lucky cell.
  //
  // ⚠ SIGMA IS NOT OPTIONAL. On the ORB range instead - which would have been
  // free, since the specialist TPs encode it - R/DD falls 19.40 -> 13.86 and
  // the breach rate returns to 3.9%.
  osArm: 3.0,
  osGive: 2.0,
  osS1Arm: 1.0,
  osS1Keep: 0.25,
  // the banked fraction, taken at tp1 (= ORB level + 0.75 x range), which for
  // a specialist alert IS tpLevels[0] - so there is no separate multiplier to
  // configure here, unlike the staircase.
  osPartPct: 0.33,
  // The day he switched to it. Recorded here as well as in Redis so the fact
  // survives a cache flush - a start date that can silently reset is worse
  // than no start date, because day counts would quietly restart.
  staircaseSince: '2026-11-11',

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

// The only zoneTypes a per-signal arm may name. Anything else is DROPPED
// rather than carried, because a typo that silently becomes a live arm value
// is exactly the failure this function exists to prevent. Mirrors
// SPECIALIST_ALLOWED_ZONES['gold-specialist'] in webhook.js.
const STAIR_ARM_ZONES = ['FRB', 'NYORB', 'SYD', 'LORB'];

function clampArmZone(v) {
  // undefined (an older Redis blob) -> the researched defaults.
  // {} (a deliberate clear) -> {}, which restores the single global arm.
  if (v === undefined || v === null) return { ...DEFAULTS.stairArmZone };
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { ...DEFAULTS.stairArmZone };
  }
  const out = {};
  for (const k of STAIR_ARM_ZONES) {
    const n = Number(v[k]);
    // Same band as the global arm: 0 stays reachable for a deliberate A/B,
    // 3.00 ranges is the top beyond which the arm never clears.
    if (Number.isFinite(n)) out[k] = Math.min(3.0, Math.max(0.0, n));
  }
  return out;
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
  // ONE-SHOT: the giveback must stay strictly BELOW the arm. At osGive >=
  // osArm the lock would be placed at or beyond the price that armed it and
  // would fill on the very next tick, turning a 3-sigma runner into an
  // instant scratch. Clamping the two independently cannot catch that, so
  // the RELATION is enforced here.
  const _osArm = clampNum(base.osArm, 0.5, 10.0, DEFAULTS.osArm);
  let _osGive  = clampNum(base.osGive, 0.1, 9.0, DEFAULTS.osGive);
  if (_osGive >= _osArm) _osGive = Math.max(0.1, +(_osArm * 0.5).toFixed(3));
  return {
    riskPct: clampNum(base.riskPct, MIN_RISK_PCT, MAX_RISK_PCT, DEFAULTS.riskPct),
    // 'tp1' added 2026-09-30. Measured on the G+H+M+U baseline, 3y, same
    // config, only the exit changed:
    //   TP1  288 trades   4 losses   PF 7.047   net 4990   maxDD  547
    //   TP2  241 trades  18 losses   PF 2.770   net 6864   maxDD  792
    //   TP3  203 trades  28 losses   PF 2.016   net 6509   maxDD 1002
    // TP1 wins net/DD (9.13) and carries 4 losses in three years, which is
    // the number that decides whether 4% risk survives a losing streak.
    // Anything unrecognised still falls back to 'ratchet', so a bad write
    // can never invent a mode. 'staircase' added 2026-11-11.
    // ! 'ratchet' sits IN the list now rather than acting as the fallback.
    // It used to be both, which made DEFAULTS.exitMode unreachable: an empty
    // store returned the hardcoded 'ratchet' and changing the default did
    // nothing at all. Caught while making the $ ladder the default.
    exitMode: ['ratchet', 'final-tp', 'tp1', 'staircase', 'oneshot',
      'dladder'].includes(base.exitMode)
      ? base.exitMode : DEFAULTS.exitMode,
    // Same shape: anything unrecognised falls back to the measured default
    // rather than inventing a third routing mode.
    entryMode: base.entryMode === 'limit' ? 'limit' : 'market',
    // osGive must stay BELOW osArm or the lock would sit at or beyond the
    // price that armed it and fill on the spot. That relation is enforced
    // after both are clamped, below.
    osArm:    _osArm,
    osGive:   _osGive,
    osS1Arm:  clampNum(base.osS1Arm,  0.0,  5.0, DEFAULTS.osS1Arm),
    osS1Keep: clampNum(base.osS1Keep, 0.0,  1.0, DEFAULTS.osS1Keep),
    osPartPct: clampNum(base.osPartPct, 0.0, 0.9, DEFAULTS.osPartPct),
    // stairGive is capped at 0.60, NOT 0.95. See the note on DEFAULTS: past
    // ~0.667 the rung-1 stop lands at or below the entry and the engine stops
    // locking profit at all. This clamp is the only thing standing between a
    // typo in the panel and a staircase that scratches every winner.
    stairGive:  clampNum(base.stairGive, 0.10, 0.60, DEFAULTS.stairGive),
    stairFinal: Math.round(clampNum(base.stairFinal, 2, 8, DEFAULTS.stairFinal)),
    // stairArm: 0 IS ALLOWED, and it is the old pathological behaviour, so it
    // stays reachable only for a deliberate A/B. The top is 3.00 ranges —
    // beyond that the arm never clears on a normal day and the staircase is
    // off in all but name, which is what `exitMode` is for.
    stairArm: clampNum(base.stairArm, 0.0, 3.0, DEFAULTS.stairArm),
    // Per-signal overrides on top of that global. Unknown keys dropped,
    // values clamped to the same 0.0-3.0 band. See DEFAULTS for the study.
    stairArmZone: clampArmZone(base.stairArmZone),
    // stairQ: 1.0 is whole rungs (the old grid). The floor is 0.05 rather
    // than 0 because a continuous stop is a TRAIL, not a staircase, and a
    // trail is the one shape this engine exists to avoid — at q -> 0 the
    // "fires once per rung" property that makes it scorable disappears.
    stairQ: clampNum(base.stairQ, 0.05, 1.0, DEFAULTS.stairQ),
    // The dollar ladder. dladLock is clamped BELOW dladStep because a lock at
    // or above the rung that fires it would park the stop at or past the
    // price that triggered the move - the broker rejects it and the trade is
    // left on its original stop. 0.95 leaves at least 5% of a rung of room.
    dladStep: clampNum(base.dladStep, 100, 20000, DEFAULTS.dladStep),
    dladLock: Math.min(
      clampNum(base.dladLock, 0, 20000, DEFAULTS.dladLock),
      clampNum(base.dladStep, 100, 20000, DEFAULTS.dladStep) * 0.95),
    // 0 = no final target, which the measurements support: at lock $900 a
    // $3,000 cap scores +27.44 R, no cap +26.48, his $5,000 +25.93.
    dladFinal: clampNum(base.dladFinal, 0, 100000, DEFAULTS.dladFinal),
    dladTouch: base.dladTouch === true,
    tgMode: ['card', 'verbose'].includes(base.tgMode)
      ? base.tgMode : DEFAULTS.tgMode,
    staircaseSince: (typeof base.staircaseSince === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(base.staircaseSince))
      ? base.staircaseSince : DEFAULTS.staircaseSince,
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
  // Exported for _staircase.test.js: the clamps on stairGive are the only
  // thing between a typo in the panel and an engine that scratches every
  // winner, so they are tested directly rather than through Redis.
  sanitizeForTest: sanitize,
  DEFAULTS,
  MAX_RISK_PCT,
  SETTINGS_KEY,
};
