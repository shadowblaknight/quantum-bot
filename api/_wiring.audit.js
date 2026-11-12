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
const FEED = R('dashboard-feed.js');
const MT = R('manage-trades.js');
const WH = R('webhook.js');
const TG = R('telegram.js');

let fails = 0;
function chk(ok, label, detail) {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

// knobs the user must be able to change from the panel
const WRITABLE = {
  staircase: ['stairGive', 'stairFinal'],
  oneshot:   ['osArm', 'osGive', 'osS1Arm', 'osS1Keep', 'osPartPct'],
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
    chk(UI.includes(`saveSettings({${k}:`), `panel can write ${k}`);
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

console.log('\n=== 10. notifications ===');
for (const [fn, label] of [['notifyStaircaseRung', 'staircase rung'],
                            ['notifyOneShotEvent', 'oneshot bank/lock']]) {
  const tg = require('./telegram.js');
  chk(typeof tg[fn] === 'function', `${label}: ${fn} exported`);
  chk(MT.includes(fn), `${label}: imported and called in manage-trades`);
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
