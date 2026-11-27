/* eslint-disable */
// api/_wiring.audit.js
//
// "confirme that both tp engines are wiered correctly in every aspect of the
//  backend and i have full control throught the dashboard"
//
// This answers that by READING THE SOURCE rather than by assertion. Every
// knob of both engines is traced along the whole path it has to travel:
//
//     DEFAULTS -> sanitize -> GET /settings -> the panel reads it
//                          -> POST set-settings whitelist -> the panel writes it
//                          -> the execution path actually branches on it
//
// A knob that is missing any link is live-looking and dead. The two that
// this audit caught on its first run were osS1Arm and osS1Keep: present in
// settings, clamped, returned by the API, branched on in manage-trades, and
// with NO CONTROL IN THE PANEL - so "full control" was false for exactly the
// half of the one-shot that cuts losses.
//
// Run: node api/_wiring.audit.js

const fs = require('fs');
const path = require('path');
const { DEFAULTS, sanitizeForTest } = require('./settings-store');

const R = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const UI = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'TerminalLayout.jsx'), 'utf8');
// whitespace-stripped view of the panel, for checks that must not depend on
// how a JSX expression happens to be line-wrapped
const UIC = UI.replace(/\s+/g, '');
const FEED = R('dashboard-feed.js');
const MT = R('manage-trades.js');
const WH = R('webhook.js');
const TG = R('telegram.js');
const SRC_SETTINGS = R('settings-store.js');

let fails = 0;
function chk(ok, label, detail) {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

// knobs the user must be able to change from the panel
const WRITABLE = {
  staircase: ['stairGive', 'stairFinal', 'stairArm', 'stairArmZone',
              'stairQ'],
  oneshot:   ['osArm', 'osGive', 'osS1Arm', 'osS1Keep', 'osPartPct'],
  // HIS dollar ladder, 2026-11-28, and the Telegram mode that replaced the
  // per-event spam. Registered here so sections 1-4 trace each one the whole
  // way: DEFAULTS -> sanitize -> GET /settings -> POST whitelist -> a control
  // in the panel. An unreachable knob is live-looking and dead.
  dladder:   ['dladStep', 'dladLock', 'dladFinal', 'dladTouch'],
  telegram:  ['tgMode'],
  entry:     ['entryMode'],
};
// deliberately read-only: a historical fact a control could erase by accident
const READONLY = ['staircaseSince'];

console.log('\n=== 1. DEFAULTS carry every knob ===');
for (const [eng, keys] of Object.entries(WRITABLE)) {
  for (const k of [...keys, ...(eng === 'staircase' ? READONLY : [])]) {
    chk(DEFAULTS[k] !== undefined, `DEFAULTS.${k} exists`,
        `= ${JSON.stringify(DEFAULTS[k])}`);
  }
}

console.log('\n=== 2. sanitize() returns them, so GET /settings serves them ===');
const clean = sanitizeForTest({});
for (const keys of Object.values(WRITABLE)) {
  for (const k of keys) {
    chk(clean[k] !== undefined, `sanitize({}).${k} is served`,
        `= ${JSON.stringify(clean[k])}`);
  }
}
for (const k of READONLY) {
  chk(clean[k] !== undefined, `sanitize({}).${k} is served (read-only)`);
}

console.log('\n=== 3. the POST whitelist accepts every writable knob ===');
for (const keys of Object.values(WRITABLE)) {
  for (const k of keys) {
    chk(FEED.includes(`body.${k} !== undefined`),
        `set-settings accepts ${k}`);
  }
}
for (const k of READONLY) {
  chk(!FEED.includes(`body.${k} !== undefined`),
      `set-settings REFUSES ${k} (by design)`);
}

console.log('\n=== 4. the panel has a control for every writable knob ===');
for (const keys of Object.values(WRITABLE)) {
  for (const k of keys) {
    // UIC is the panel with ALL whitespace stripped, so a line break after
    // `saveSettings({` cannot hide a control that is really there. A plain
    // includes() on UI reported entryMode as a broken link on 2026-11-17
    // while the button was wired correctly - a false FAIL in an audit is as
    // expensive as a missed one, because it trains you to ignore the output.
    chk(UIC.includes(`saveSettings({${k}:`), `panel can write ${k}`);
  }
}

console.log('\n=== 5. the panel can SELECT both engines ===');
chk(/MODE_SEQ\s*=\s*\[[^\]]*'staircase'/.test(UI), 'staircase is in the mode cycle');
chk(/MODE_SEQ\s*=\s*\[[^\]]*'oneshot'/.test(UI), 'oneshot is in the mode cycle');
// both spacings, because the file uses `=== 'x'` in the derivations and
// `==='x'` inside JSX expressions
const reads = (m) => UI.includes(`exitMode === '${m}'`)
  || UI.includes(`exitMode==='${m}'`);
chk(reads('oneshot'), 'panel reads exitMode oneshot');
chk(reads('staircase'), 'panel reads exitMode staircase');

console.log('\n=== 6. settings-store accepts the modes and rejects junk ===');
chk(sanitizeForTest({ exitMode: 'staircase' }).exitMode === 'staircase', 'accepts staircase');
chk(sanitizeForTest({ exitMode: 'oneshot' }).exitMode === 'oneshot', 'accepts oneshot');
chk(sanitizeForTest({ exitMode: 'nonsense' }).exitMode === 'ratchet', 'junk -> ratchet');

console.log('\n=== 7. the execution path branches on both ===');
chk(MT.includes("exitMode === 'staircase'"), 'manage-trades reads staircase');
chk(MT.includes("exitMode === 'oneshot'"), 'manage-trades reads oneshot');
chk(WH.includes("_exitMode === 'staircase'"), 'webhook reads staircase (broker TP on the final rung)');
chk(WH.includes("_exitMode === 'oneshot'"), 'webhook reads oneshot (no broker TP at all)');
chk(/brokerTP\s*=\s*_exitMode === 'oneshot'\s*\?\s*null/.test(WH),
    'oneshot places NO take-profit');

console.log('\n=== 8. the guards that keep them off the wrong TP grid ===');
chk(MT.includes('_stairSpecialist'), 'specialist-only guard present');
chk(MT.includes('_stairEven'), 'even-TP-grid guard present');
chk(/_osOK\s*=\s*ONESHOT_MODE\s*&&\s*_stairSpecialist\s*&&\s*_stairEven/.test(MT),
    'oneshot carries BOTH guards');
chk(/_stairOK\s*=\s*STAIR_MODE[\s\S]{0,120}_stairSpecialist\s*&&\s*_stairEven/.test(MT),
    'staircase carries BOTH guards');
chk(WH.includes('isSpecialist') && /_exitMode === 'staircase' && isSpecialist/.test(WH),
    'webhook staircase TP is specialist-only');

console.log('\n=== 9. neither engine is hijacked by the legacy stop logic ===');
chk(/hitRungs\.length > 0 && !_osOK && !_stairOK/.test(MT),
    'retrace emergency lock EXCLUDES both engines');
chk(MT.includes('!RATCHET_MODE && !_osOK && finalTouched'),
    'final-TP backstop close excludes oneshot');
chk(MT.includes('i === finalIdx && !_stairOK && !_osOK'),
    'tp3 is a rung, not the close, for both engines');
chk(/\} else if \(_osOK\) \{/.test(MT),
    'oneshot without sigma falls through to NOTHING, not the cascade');
chk(MT.includes('state.osLockPx'), 'the lock price is frozen in state, not recomputed');

// HIS RULE, 2026-11-13: nothing may move the stop before TP1. There are FOUR
// modifyPosition call sites in this file, not one, and auditing only the
// `chosen` path missed two of them. All three automatic ones are checked.
chk(/USE_TRAILING_STOP && !_osOK && !_stairOK/.test(MT),
    'the independent ATR trail excludes both engines');
chk(/isScalp && USE_SL_RATCHET && !_osOK && !_stairOK/.test(MT),
    'the 30-min scalp breakeven excludes both engines');
chk(/cleared >= 1/.test(MT),
    'the staircase moves the stop only once a whole rung is CLEARED');
chk(MT.includes('(_osOK && _osSigma) || _stairOK'),
    'the staircase arms on the bar CLOSE, not the wick');
{
  // exactly four modifyPosition sites are known and accounted for; a fifth
  // would be an unaudited way to move a live stop
  const n = (MT.match(/await modifyPosition\(/g) || []).length;
  chk(n === 4, 'no NEW stop-modifying call site has appeared', `found ${n}`);
}

console.log('\n=== 10. notifications ===');
for (const [fn, label] of [['notifyStaircaseRung', 'staircase rung'],
                            ['notifyOneShotEvent', 'oneshot bank/lock']]) {
  const tg = require('./telegram.js');
  chk(typeof tg[fn] === 'function', `${label}: ${fn} exported`);
  chk(MT.includes(fn), `${label}: imported and called in manage-trades`);
}

console.log('\n=== 10b. ENTRY ROUTING (2026-11-16) ===');
// The chase is worth more than the entire exit search: -$136/trade at the
// live 8.4-pt chase against +$126 resting at the signal entry. Three things
// have to hold or the limit arm is not the arm that was measured.
// HIS CALL, 2026-11-17: "No entry mode stays market". The deployed settings
// blob predates this key, so a 'limit' default would silently flip live
// routing the moment this ships.
chk(sanitizeForTest({}).entryMode === 'market',
    'the default is MARKET, as he decided');
chk(sanitizeForTest({ entryMode: 'market' }).entryMode === 'market',
    'market is still selectable for a live A/B');
chk(sanitizeForTest({ entryMode: 'limit' }).entryMode === 'limit',
    'limit is still selectable');
chk(sanitizeForTest({ entryMode: 'nonsense' }).entryMode === 'market',
    'junk -> market, never a third routing mode');
chk(!WH.includes('const GOLD_MARKET_ENTRY = true'),
    'the hardcoded GOLD_MARKET_ENTRY const is gone');
chk(/_forceMkt = _entryMode === 'market'/.test(WH),
    'webhook routes on the setting, not a constant');
// A limit IS the right answer to price having run past, so the run-past guard
// must yield to an order that is going to rest. Without this the limit arm
// silently drops exactly the pullback trades it exists to catch.
chk(/_drift >= _budget && !\(_restingOK && _canLimit\)/.test(WH),
    'the run-past guard yields to a resting limit');
// And a resting limit must die with its session, or a London order fills in
// NY against a stale 08:00 level. The backtest cancels at the window close
// (London 150 min, Frankfurt 210, NY 180, Sydney 90); production used a flat
// 4 h, which is longer than every one of them.
chk(/expiresAt: \(!useMarket && _sessionClosesAt\)/.test(WH),
    'an unfilled limit expires with its session, not after a flat 4 h');

console.log('\n=== 10c. THE ARM AND THE STOP GRID (2026-11-17) ===');
// FIX 2. Production had no entry-anchored arm at all, so with a market fill
// past the ORB level rung 1 was cleared at open and a 59.6-pt stop became
// 7.1 pt on the first tick. Over 4.4yr that is worse than having NO staircase
// ($13/trade vs $246), and 20 of 20 coin-flip arm times beat it. The arm must
// gate the stop move, be measured from the FILL, and be in RANGE units.
chk(sanitizeForTest({}).stairArm === 1.25,
    'the default arm is the derived 1.25 ranges');
chk(sanitizeForTest({ stairArm: 0 }).stairArm === 0,
    'arm 0 stays reachable for a deliberate A/B');
chk(sanitizeForTest({ stairArm: 99 }).stairArm === 3.0,
    'arm is capped at 3.00 ranges');
chk(/if \(_gain >= _armDist\) state\.stairArmed = true/.test(MT),
    'the arm latches in state, so a retrace cannot disarm it');
chk(/const _armDist = _armRanges \* \(_stairStep \/ STAIR_RUNG_STEP\)/
    .test(MT),
    'the arm is measured in ORB-RANGE units, recovered from the rung spacing');
chk(MT.includes('const STAIR_RUNG_STEP = 0.75'),
    'the rung step mirrors the Pine c2TpMult');
chk(/const _gain = isLong \? \(_ref - state\.entry\) : \(state\.entry - _ref\)/
    .test(MT),
    'the arm is measured from the FILL, not the ORB level');
chk(/if \(cleared >= 1 && _stairArmed\)/.test(MT),
    'NO stop move at all before the arm clears');
chk(MT.includes("action: 'stair-unarmed'"),
    'an unarmed trade is reported, not silently unmanaged');
console.log('\n=== 10d. THE PER-SIGNAL ARM (2026-11-27) ===');
// The arm is the one staircase parameter whose best value differs by SIGNAL,
// and the pair below is the only configuration found that moved BOTH ways at
// once - more big wins AND fewer big losses - instead of trading one for the
// other:
//   global 1.25            486 tr  +20.53 R  maxDD 6.73  R/DD 3.05  57 losses
//   FRB 2.00 + NYORB 0.50  472 tr  +31.04 R  maxDD 5.17  R/DD 6.01  48 losses
// Both walk-forward halves agreed on the DIRECTION (FRB 2.00 in both, NYORB
// below 1.25 in both). LORB and SYD picked opposite ends in the two folds, so
// they are deliberately absent and keep the global arm.
const AZ = sanitizeForTest({}).stairArmZone;
chk(!!AZ && AZ.FRB === 2.0, 'FRB arms LATER, at 2.00 ranges');
chk(!!AZ && AZ.NYORB === 0.5, 'NYORB arms EARLIER, at 0.50 ranges');
chk(!!AZ && AZ.LORB === undefined && AZ.SYD === undefined,
    'LORB and SYD are ABSENT, so they fall back to the global arm');
chk(Object.keys(sanitizeForTest({ stairArmZone: { FRB: 1, NOPE: 2 } })
      .stairArmZone).join(',') === 'FRB',
    'an unknown zone key is DROPPED, not carried into a live arm');
chk(sanitizeForTest({ stairArmZone: { NYORB: 99 } }).stairArmZone.NYORB === 3.0,
    'a per-zone arm is capped at 3.00 ranges, like the global');
chk(sanitizeForTest({ stairArmZone: { FRB: 0 } }).stairArmZone.FRB === 0,
    'arm 0 stays reachable per zone for a deliberate A/B');
chk(Object.keys(sanitizeForTest({ stairArmZone: {} }).stairArmZone).length === 0,
    'an EMPTY map restores the single global arm exactly');
chk(sanitizeForTest({ stairArmZone: 'nope' }).stairArmZone.FRB === 2.0,
    'a non-object falls back to the defaults rather than silently disarming');
// ! sp500-specialist uses the SAME zoneType keys ('FRB', 'NYORB') and was
// never measured for this, so the override MUST be scoped by template.
chk(MT.includes("matchedPending?.setup?.template === 'gold-specialist'"),
    'the per-signal arm is scoped BY TEMPLATE, not by zone (sp500 shares keys)');
chk(/\s+: _qbSettings\.stairArm;/.test(MT),
    'an unknown zone or other template falls back to the global arm');
chk(/needRanges: _armRanges/.test(MT),
    'the unarmed report names the arm ACTUALLY in force, not the global');

console.log('\n=== 10g. HIS DOLLAR LADDER (2026-11-28) ===');
// Spec: a rung every dladStep dollars of floating profit, the stop parked at
// dladLock, everything closed at dladFinal. Of the five locks he asked to
// have tested, over 4.4 years: $700 +$98,074 / $750 +$97,272 / $800 +$99,297
// / $850 +$102,801 / $900 +$107,598, against the staircase's +$87,115 -
// monotone in the tightness of the giveback - and BOTH walk-forward halves
// chose $900 AND ranked all five the same way on the half they had not seen.
const LD = sanitizeForTest({});
chk(LD.dladStep === 1000, 'a rung every $1,000 of profit (measured best)');
chk(LD.dladLock === 900, 'the stop locks $900 on rung 1 (measured best)');
chk(LD.dladFinal === 3000,
    'closes at $3,000 - his $5,000 never fired once in 4.4 years',
    'nothing ever climbed past rung 4');
chk(LD.dladTouch === false,
    'rungs fire on a BAR CLOSE, not a wick', 'close +$108k vs touch +$78k');
chk(sanitizeForTest({ exitMode: 'dladder' }).exitMode === 'dladder',
    "'dladder' is a selectable exitMode");
// ! a lock at or above its own rung parks the stop at the price that
// triggered the move; the broker rejects it and the trade is left unmanaged.
chk(sanitizeForTest({ dladStep: 1000, dladLock: 5000 }).dladLock === 950,
    'the lock is clamped BELOW its own rung, so the stop is always placeable');
chk(sanitizeForTest({ dladFinal: 0 }).dladFinal === 0,
    'final 0 means NO target, which the measurements support');
// the engine itself
chk(/\(position\.volume \|\| 0\)\s*\n?\s*\* \(\(_dladMeta && _dladMeta\.contractSize\) \|\| 0\)/
    .test(MT),
    'dollars come from volume x contractSize, exact for any symbol');
chk(MT.includes('const DLAD_EPS = 1e-9'),
    'the rung edge carries an epsilon',
    'a peak landing EXACTLY on a rung computed a hair under it and did not lock');
chk(/\(_dladRung - 1\) \* _qbSettings\.dladStep\s*\n?\s*\+ _qbSettings\.dladLock/
    .test(MT),
    'rung n locks (n-1) x step + lock, so the giveback is FIXED at every rung');
chk(/_dladOK\s*\n?\s*\? _dladFinalPrice/.test(MT),
    'the ladder owns the broker take-profit while it is the active engine');
chk(MT.includes('(_osOK && _osSigma) || _stairOK || _dladOK'),
    'the bar-CLOSE tracker runs for the ladder too, or its peak would be a wick');
chk(MT.includes("state.tpsHit.includes('DLAD-FINAL')"),
    'the final close is latched, so it cannot fire twice');

console.log('\n=== 10h. ONE TELEGRAM CARD INSTEAD OF ELEVEN MESSAGES ===');
// "telegram has too much notification i want somthing new and clean". A trade
// that climbed three rungs produced ELEVEN messages, and with a 0.10-rung stop
// grid the SL-locked line alone could fire dozens of times in one trade.
chk(LD.tgMode === 'card', 'the live card is the default');
chk(sanitizeForTest({ tgMode: 'verbose' }).tgMode === 'verbose',
    "'verbose' restores the old per-event behaviour without a deploy");
chk(sanitizeForTest({ tgMode: 'nope' }).tgMode === 'card',
    'an unknown mode falls back to the card rather than going silent');
chk(TG.includes("tgCall('editMessageText'"),
    'the card is EDITED in place, so Telegram does not re-notify');
chk(/not modified/i.test(TG),
    'an edit that changes nothing is treated as SUCCESS',
    'otherwise a quiet tick would post a duplicate card every minute');
chk(/const sent = await sendTelegram\(text, \{\}\);/.test(TG),
    'an unreachable card is RESENT, so a close can never be lost');
// the three it replaces, and the one class it must never swallow
for (const [fn, why] of [
  ['notifySpecialistTPConfirmed', 'the per-TP message'],
  ['notifyStaircaseRung', 'the per-rung message'],
  ['notifySpecialistSLLocked', 'the per-stop-move message'],
]) {
  const re = new RegExp("tgMode !== 'card'[\\s\\S]{0,400}" + fn);
  chk(re.test(MT), `card mode suppresses ${why}`);
}
chk(!/tgMode !== 'card'[\s\S]{0,300}notifySpecialistSLWarning/.test(MT),
    'but it NEVER suppresses an SL warning - a failure must stay loud');
chk(MT.includes('status: \'closed\''),
    "the card's last state is the close message");

console.log('\n=== 10f. THE RUNG MESSAGE TELLS THE TRUTH (2026-11-27) ===');
// The rung Telegram fired on the rung high-water alone and said "stop goes
// to rung X", while the stop move itself is gated on _stairArmed - so on an
// unarmed trade nothing moved and he was told it had. The per-signal arm
// makes it worse: FRB arms at 2.00 ranges, so several rungs can clear first.
chk(/cleared > \(state\.stairRungAnnounced \|\| 0\)/.test(MT)
    && /&& _stairArmed/.test(MT),
    'the "stop goes to rung X" message only fires when the stop really moved');
chk(/state\.stairRungWaiting = cleared/.test(MT),
    'the unarmed notice uses its OWN latch, so arming later still reports');
chk(MT.includes("'stair-rung-waiting'"),
    'a rung reached while parked is reported as waiting, not as a stop move');
chk(/armed, needRanges: _armRanges, haveRanges: _armHave/.test(MT),
    'the waiting notice carries the arm ACTUALLY in force, per signal');
// ! the dedupe key must separate the two events or the second is swallowed
chk(/stair-rung:\$\{positionId\}:\$\{rung\}:\$\{armed \? 'armed' : 'wait'\}/
    .test(TG),
    'the dedupe key separates "reached" from "stop moved" for the same rung');
chk(/The stop has <b>NOT<\/b> moved yet/.test(TG),
    'the waiting message says plainly that the stop has not moved');

console.log('\n=== 10e. THE PROFIT-LOCK INVARIANT (his own rule, in arithmetic) ===');
// "Never move the SL to a loss" is his rule, and 1.25 was DERIVED from it
// rather than fitted. The general form: the stop parks at rung
// (quantise(reach) - stairGive), the quantiser can give back up to stairQ of
// a rung, so the FIRST stop move clears the fill only when
//     arm > STAIR_RUNG_STEP x (stairQ + stairGive)
// At stairQ 0.25 that threshold is 0.5625 and NYORB's measured 0.50 BREAKS
// it on 43 of 120 H trades (worst 6.1% of a range below the fill). At 0.10
// the threshold is 0.4500 and it holds on all 120. This check exists so that
// moving any one of the three numbers cannot silently re-break the rule.
const _lk = sanitizeForTest({});
const RUNG_STEP = 0.75;
const _thr = RUNG_STEP * (_lk.stairQ + _lk.stairGive);
chk(SRC_SETTINGS.includes('stairQ + stairGive'),
    'the invariant is written down where the defaults are set');
chk(_lk.stairArm > _thr,
    'the GLOBAL arm locks profit on its first move',
    `arm ${_lk.stairArm} > ${_thr.toFixed(4)}`);
for (const [z, v] of Object.entries(_lk.stairArmZone || {})) {
  chk(v > _thr, `the ${z} arm locks profit on its first move`,
      `arm ${v} > ${_thr.toFixed(4)}`);
}

// FIX 1. floor() to whole rungs discarded a mean 0.482 rungs per trade; on
// 16 Nov that rounding cost $286 against the designed giveback's $172.
chk(sanitizeForTest({}).stairQ === 0.10,
    'the default stop grid is 0.10 rungs — see 10e, it is what lets the '
    + 'NYORB arm of 0.50 still lock profit on its first move');
chk(sanitizeForTest({ stairQ: 0 }).stairQ === 0.05,
    'stairQ cannot reach 0 — a continuous stop is a TRAIL, not a staircase');
chk(sanitizeForTest({ stairQ: 9 }).stairQ === 1.0, 'stairQ is capped at 1.00');
chk(/Math\.max\(1, Math\.floor\(_stairReach \/ _q\) \* _q\)/.test(MT),
    'the quantised reach never drops below rung 1');
// And the arm must not have opened a new way to move a live stop.
{
  const n = (MT.match(/await modifyPosition\(/g) || []).length;
  chk(n === 4, 'still exactly four stop-modifying call sites', `found ${n}`);
}

console.log('\n=== 11. the price probe is given a broker-sized budget ===');
// Regression guard for the 2026-11-12 08:30 skip: the probe gave the broker
// 2500 ms against a BROKER_TIMEOUT_MS of 14000, so a patient call was
// abandoned and a live gold signal was dropped. Same bug class as 9cce80b on
// the dashboard path. If anyone tightens this back toward 2.5 s, say so here
// rather than discovering it from a missed trade.
const qm = /_PROBE_QUOTE_MS\s*=\s*(\d+)/.exec(WH);
chk(!!qm, 'the quote budget is a named constant');
if (qm) {
  chk(+qm[1] >= 5000, 'quote budget >= 5000 ms', `= ${qm[1]} ms`);
}
const cm = /_PROBE_CANDLE_MS\s*=\s*(\d+)/.exec(WH);
chk(!!cm && +cm[1] >= 1200, 'candle budget >= 1200 ms',
    cm ? `= ${cm[1]} ms` : undefined);
chk(WH.includes('probeBudgetMs'),
    'a probe failure logs the budgets that were in force');

// ★★ 2026-11-24. The 11-12 fix widened the budgets; it did not stop a probe
// failure from COSTING THE TRADE. A gold SHORT was skipped again this morning
// with "No live price available" and he took it by hand. Both probes are
// MetaAPI (candle-source's only provider branch, then /current-price on the
// same account), so they fail together - and a FORCED-MARKET gold entry never
// needed a live price: _cur feeds _canLimit (irrelevant under _forceMkt),
// _drift (the run-past guard) and the log. The signal bar's own close is in
// the alert body, cannot time out, and is the price g15 models the fill at.
// Measured on the 4.4yr book: drift past rEntry has median 0.39 ranges and
// only 2 of 486 trades (0.41%) exceed the stairFinal-6 guard budget, so the
// fallback neither disables the guard nor waves a runaway through.
chk(/if \(_cur == null && _forceMkt\)/.test(WH),
    'a forced-market gold entry falls back to the payload close');
chk(/_pbc = parseFloat\(p\.barClose\)/.test(WH),
    'the fallback price is the signal bar close from the alert');
chk(WH.includes("_dbgProbeSrc = 'payload-barclose'"),
    'the fallback is attributed in the log, so it is measurable');
chk(WH.includes("type: 'price-probe-fallback'"),
    'using the fallback writes its own activity entry');
{
  // ORDER IS THE WHOLE SAFETY ARGUMENT: live quote first, payload close only
  // after it misses, skip only after BOTH. If the fallback ever moves above
  // the live probes it silently becomes the primary price source.
  const iQ = WH.indexOf("_dbgProbeSrc = 'broker-quote'");
  const iF = WH.indexOf('if (_cur == null && _forceMkt)');
  const iS = WH.indexOf("reason: 'price-probe-failed'");
  chk(iQ > 0 && iF > iQ && iS > iF,
      'live probes -> payload close -> skip, in that order');
}
// A LIMIT routing must STILL skip: a stale reference can put the resting
// order on the wrong side of the market and MT5 rejects it INVALID_PRICE.
chk(!/if \(_cur == null\)\s*\{\s*const _pbc/.test(WH),
    'the fallback is NOT applied to a limit routing');
chk(/No live price AND no barClose/.test(WH),
    'the skip message names the routing instead of always saying "limit"');

// ZERO MUST MEAN OFF, not "arm at zero excursion". The panel labels osS1Arm 0
// as "off"; without an explicit > 0 guard the engine fires stage 1 on the
// first tick of every trade and pulls the stop to a LOSS — the opposite of
// what the control says, and exactly the behaviour he objected to. Same bug
// class as trailArm = 0.
chk(MT.includes('_s1on = _qbSettings.osS1Arm > 0'),
    'osS1Arm <= 0 is treated as OFF, not arm-immediately');
chk(/_s1on && !state\.osS1/.test(MT), 'the stage-1 latch respects that guard');

console.log('\n=== 12. sigma, the unit the one-shot measures in ===');
const SS = require('./session-sigma.js');
chk(typeof SS.hourSigma === 'function', 'session-sigma.hourSigma exists');
chk(SS.LOOK === 14, 'lookback is 14 days, as the backtest');
chk(MT.includes("require('./session-sigma')"), 'manage-trades imports it');
chk(MT.includes('oneshot-no-sigma'), 'a sigma failure is reported, not guessed around');

console.log(`\n${fails === 0
  ? 'WIRING AUDIT: ALL LINKS PRESENT'
  : `WIRING AUDIT: ${fails} BROKEN LINK(S)`}`);
process.exit(fails === 0 ? 0 : 1);
