r"""WIRE THE ONE-SHOT INTO manage-trades.

HIS REQUEST: "wire one shot as well i want to try it".

It is also the only engine measured that survives his live 4% risk:
9.88% peak drawdown and 0.0% breach, against 16.6-22.1% and 17-20% for the
ratchet he is running and for his staircase ([[live-config-breaches]]).

THE ENGINE, as measured (blend, U dropped, 4.4yr: +47.94R, maxDD 2.47R,
R/DD 19.40, WR 58.1%, best win +7.79R):
  · stop 50 pts from the ORB level, no take-profit ever placed
  · STAGE 1  at +1.0 sigma of best CLOSE -> stop to entry - 0.25 x risk
  · THE LOCK at +3.0 sigma of best CLOSE -> stop to entry + 1.0 sigma, ONCE,
             and then never moved again. That "never again" is the whole
             design: the stop stops chasing, so price can run.
  · BANK 33% at tp1 (= ORB level + 0.75 x range), which for a specialist
             alert is exactly tpLevels[0]
  · hold cap 480 bars (5 days)

TWO THINGS THE LIVE PATH DID NOT HAVE, both now measured as REQUIRED:

1. SIGMA. api/session-sigma.js computes it, and f88 verified that algorithm
   reproduces the backtest's sigh on 100.00% of 100,147 bars with the engine
   byte-identical. Substituting the ORB range instead - which would have
   been free - costs R/DD 19.40 -> 13.86 and reintroduces a 3.9% breach.

2. THE BEST **CLOSE**. manage-trades tracks `state.extreme`, the favourable
   EXTREME. Arming the one-shot off the extreme instead of the bar close
   takes the breach rate from 0.0% to 38.0% and R/DD from 19.40 to 4.90,
   because a bar that merely WICKS through the arm fires it and the new stop
   is then clamped against a close that can sit below the entry. So a 15m
   CLOSE high-water is kept in position state. Same trap already measured on
   his staircase (totR +17.14 -> +6.83).

⚠ NOTE: the ratchet he is running right now is armed off `extreme` too, so
the live ratchet has never been the configuration that was backtested
either - it measures R/DD 2.41 rather than 3.76.
"""
import io
import sys

P = r'C:\Users\Omar Nasr\quantum-bot\api\manage-trades.js'
src = io.open(P, encoding='utf-8').read()
orig = src
n = 0


def sub(tag, old, new, count=1):
    global src, n
    c = src.count(old)
    assert c == count, '[%s] anchor count %d != %d' % (tag, c, count)
    src = src.replace(old, new)
    n += 1
    print('[%s] ok' % tag)


# ---- 1. imports -------------------------------------------------------
sub('import', "const { fetchPositions, fetchCandles, refreshBalanceCache } = require('./broker');",
    "const { fetchPositions, fetchCandles, refreshBalanceCache } = require('./broker');\n"
    "const { hourSigma } = require('./session-sigma');")

sub('notify-import',
    "  notifySpecialistTradeClosed, notifySpecialistTPConfirmed, notifyStaircaseRung,",
    "  notifySpecialistTradeClosed, notifySpecialistTPConfirmed, notifyStaircaseRung,\n"
    "  notifyOneShotEvent,")

# ---- 2. mode flag + sigma, before finalTPPrice is decided -------------
sub('mode', """  const _tpIdx = TP1_MODE ? 0 : tpLevels.length - 1;
  const finalTPPrice = RATCHET_MODE
    ? null
    : _stairOK
      ? _stairFinalPrice
      : (tpLevels.length ? tpLevels[_tpIdx].price : null);""",
    """  // ─── THE ONE-SHOT ────────────────────────────────────────────────────────
  // Stage 1 cuts the risk early, the lock fires ONCE and is then frozen, a
  // third is banked at tp1, and NO take-profit is ever placed - the runner
  // is uncapped and exits on the frozen stop or the clock. Same two guards
  // as the staircase: only the SPECIALIST grid encodes the ORB range the
  // banked leg needs, and the grid must be a true arithmetic progression.
  const ONESHOT_MODE = _qbSettings.exitMode === 'oneshot';
  const _osOK = ONESHOT_MODE && _stairSpecialist && _stairEven
    && _stairStep > 0 && _stairLevel != null;
  // Sigma is fetched ONLY in one-shot mode, and a failure degrades to
  // "leave the stop where it is" rather than guessing a distance. Sizing a
  // live stop off a fallback number nobody measured is worse than not
  // moving it at all.
  let _osSigma = null, _osSigmaErr = null;
  if (_osOK) {
    try {
      const _s = await hourSigma(asset);
      if (_s && isFinite(_s.sigma) && _s.sigma > 0) _osSigma = _s.sigma;
      else _osSigmaErr = (_s && _s.error) || 'no sigma';
    } catch (e) { _osSigmaErr = `sigma threw: ${e && e.message}`; }
  }

  const _tpIdx = TP1_MODE ? 0 : tpLevels.length - 1;
  const finalTPPrice = (RATCHET_MODE || _osOK)
    ? null
    : _stairOK
      ? _stairFinalPrice
      : (tpLevels.length ? tpLevels[_tpIdx].price : null);""")

# ---- 3. no rung is the close in one-shot mode either -------------------
sub('nofinal', "    if (i === finalIdx && !_stairOK) { finalTouched = true; continue; }",
    "    if (i === finalIdx && !_stairOK && !_osOK) { finalTouched = true; continue; }")

sub('nobackstop', "  if (!RATCHET_MODE && finalTouched && !state.tpsHit.includes(finalName)) {",
    "  if (!RATCHET_MODE && !_osOK && finalTouched && !state.tpsHit.includes(finalName)) {")

# ---- 4. the 15m CLOSE high-water + the banked third --------------------
sub('bestclose', "  // ─── STAIRCASE: the rung high-water, and the rung-stairFinal close ───────",
    """  // ─── ONE-SHOT: the best CLOSE, and the banked third ──────────────────────
  // ★ CLOSES, NOT THE EXTREME. Measured: arming off state.extreme takes the
  // breach rate at 4% risk from 0.0% to 38.0%. Only bars that have actually
  // CLOSED count, and only bars at or after the fill bar. The high-water
  // lives in state, so a missed cron tick costs nothing as long as the next
  // fetch still covers the gap - 60 bars is 15 hours of cover.
  if (_osOK && _osSigma) {
    try {
      const _BAR = 15 * 60 * 1000;
      const _cr = await fetchCandles(asset, '15m', 60);
      const _cs = (_cr && _cr.candles) || [];
      const _now = Date.now();
      const _fill = state.createdAt || _now;
      let _bc = (typeof state.osBestClose === 'number' && isFinite(state.osBestClose))
        ? state.osBestClose : null;
      let _bts = state.osBestCloseTs || 0;
      for (const c of _cs) {
        const t = new Date(c.time).getTime();
        if (!isFinite(t)) continue;
        if (t + _BAR > _now) continue;        // still forming
        if (t + _BAR <= _fill) continue;      // closed before the fill
        if (t <= _bts) continue;              // already folded in
        const cl = Number(c.close);
        if (!isFinite(cl)) continue;
        _bc = _bc == null ? cl : (isLong ? Math.max(_bc, cl) : Math.min(_bc, cl));
        if (t > _bts) _bts = t;
      }
      if (_bc != null) {
        state.osBestClose = _bc;
        state.osBestCloseTs = _bts;
      }
    } catch (_) {}

    // THE BANKED THIRD, at tp1 = ORB level + 0.75 x range = tpLevels[0].
    // Fires on the same CONFIRMED touch the TP detector uses, so it is a
    // touch price has genuinely traded through, not a wick.
    const _pp = _qbSettings.osPartPct;
    if (_pp > 0 && !state.osPartDone && state.tpsHit.includes('TP1')) {
      // 0.01 is the gold lot step. Both legs must clear it or the broker
      // rejects the order and the position is left in an odd state.
      const _lot = Math.round(position.volume * _pp * 100) / 100;
      const _rest = Math.round((position.volume - _lot) * 100) / 100;
      if (_lot >= 0.01 && _rest >= 0.01) {
        const _pc = await partialClose(position.id, _lot);
        if (_pc.ok) {
          state.osPartDone = true;
          state.partialCloses.push({
            tpName: 'TP1-bank', lotClosed: _lot,
            atPrice: tpLevels[0].price, ts: Date.now(),
          });
          actions.push({ action: 'oneshot-bank', lot: _lot, ok: true });
          await pushCommentary(asset, 'tp-hit',
            `ONE-SHOT banked ${(_pp * 100).toFixed(0)}% (${_lot} lot) at tp1 `
            + `${tpLevels[0].price.toFixed(2)} — ${_rest} lot runs on`);
          try {
            await notifyOneShotEvent({
              positionId: position.id, asset, direction, kind: 'bank',
              price: tpLevels[0].price, lot: _lot, rest: _rest,
            });
          } catch (_) {}
          await setPositionState(position.id, state);
        } else {
          actions.push({ action: 'oneshot-bank', error: _pc.error });
        }
      } else {
        // too small to split - say so instead of silently running full size
        state.osPartDone = true;
        actions.push({ action: 'oneshot-bank', skipped: 'lot step',
                       lot: _lot, rest: _rest });
        await setPositionState(position.id, state);
      }
    }
  }

  // ─── STAIRCASE: the rung high-water, and the rung-stairFinal close ───────""")

# ---- 5. the stop: stage 1, then the frozen lock -----------------------
STOP_ANCHOR = "  if (_stairOK) {\n    // ─── HIS STAIRCASE"
sub('stop', STOP_ANCHOR,
    """  if (_osOK && _osSigma) {
    // ─── THE ONE-SHOT STOP ───────────────────────────────────────────
    //   stage 1 at +osS1Arm sigma  -> entry - osS1Keep x risk
    //   the lock at +osArm  sigma  -> entry + (osArm - osGive) sigma, ONCE
    // Both latch, and the excursion is measured from the best CLOSE. The
    // lock never moves again once set: that is what lets a winner run,
    // and it is the single property separating this from the ratchet.
    const _bc = state.osBestClose;
    if (typeof _bc === 'number' && isFinite(_bc)) {
      const _exc = isLong ? (_bc - state.entry) : (state.entry - _bc);
      const _cands = [];
      if (!state.osS1 && _exc >= _qbSettings.osS1Arm * _osSigma) {
        state.osS1 = true;
        _cands.push(['s1', state.entry - (isLong ? 1 : -1)
          * _qbSettings.osS1Keep * initialSLForR]);
      } else if (state.osS1) {
        _cands.push(['s1', state.entry - (isLong ? 1 : -1)
          * _qbSettings.osS1Keep * initialSLForR]);
      }
      if (!state.osLocked && _exc >= _qbSettings.osArm * _osSigma) {
        state.osLocked = true;
        await setPositionState(position.id, state);
        try {
          await notifyOneShotEvent({
            positionId: position.id, asset, direction, kind: 'lock',
            price: state.entry + (isLong ? 1 : -1)
              * (_qbSettings.osArm - _qbSettings.osGive) * _osSigma,
            sigma: _osSigma,
          });
        } catch (_) {}
      }
      if (state.osLocked) {
        _cands.push(['lock', state.entry + (isLong ? 1 : -1)
          * (_qbSettings.osArm - _qbSettings.osGive) * _osSigma]);
      }
      for (const [nm, px] of _cands) {
        const valid    = isLong ? px <= currentPrice - stopBuffer : px >= currentPrice + stopBuffer;
        const improves = curSL == null ? true : (isLong ? px > curSL : px < curSL);
        if (!valid || !improves) continue;
        if (chosen == null
            || (isLong ? px > chosen.price : px < chosen.price)) {
          chosen = { name: `os-${nm}`, price: px };
        }
      }
    }
  } else if (_stairOK) {""" + STOP_ANCHOR[len("  if (_stairOK) {"):])

# ---- 6. visibility when sigma is missing ------------------------------
sub('why', "  if (USE_SL_RATCHET && chosen) {",
    """  if (_osOK && !_osSigma && _osSigmaErr) {
    // The engine cannot run without sigma. Say so on every tick rather than
    // appearing to manage a position that is in fact only on its hard stop.
    actions.push({ action: 'oneshot-no-sigma', reason: _osSigmaErr });
  }

  if (USE_SL_RATCHET && chosen) {""")

if src == orig:
    print('nothing to do')
    sys.exit(0)
io.open(P + '.pre-oneshot', 'w', encoding='utf-8', newline='').write(orig)
io.open(P, 'w', encoding='utf-8', newline='').write(src)
print('')
print('%d edits; lines %d -> %d' % (n, orig.count('\n') + 1, src.count('\n') + 1))
