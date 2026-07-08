/* eslint-disable */
// api/alexg-run.js
//
// ALEX G — "Full Set & Forget" strategy — LAYER 5: ORCHESTRATOR / RUNNER
// ============================================================================
// The cron that makes the strategy trade. Each tick it:
//   1. reads the live rules (mode, emergency stop, daily-loss, concurrency)
//   2. loops the 7 instruments and asks Layer 4 "is there a trade here?"
//   3. for each tradeable setup, sizes the lot from the instrument's OWN risk
//      rules, places a set-and-forget LIMIT at the AOI retest, and records a
//      pending setup so manage-trades / recognition / Telegram pick it up.
//
// WHY IT PLACES DIRECTLY (not through the webhook / applyRulesToSignal):
// applyRulesToSignal recomputes SL/TP from the INSTRUMENT's slMode/tpMode — for
// forex that's your 50-pip stop + RR ladder, which would overwrite Alex's
// STRUCTURAL stop and single structure TP and stop testing his actual strategy.
// So this runner keeps alexg's structural SL/TP intact, while still honoring
// every risk input you set in the app: risk %, lotMode, maxLot, lotMultiplier,
// max-concurrent, daily-loss, mode presets, per-instrument enable. Nothing here
// hardcodes around an app setting — gates only SKIP; they never place worse.
//
// SET-AND-FORGET ENTRY: enters with a LIMIT at the zone's near edge (long →
// top of demand, short → bottom of supply). That's both faithful to Alex (mark
// the AOI, set the order, walk away) and guarantees a valid broker limit
// (a buy-limit below market / sell-limit above it). The broker's resting SL+TP
// then runs the trade; with a single TP the manager's ratchet stays inert, so
// the stop genuinely never moves.
//
// ONE-PER-PAIR: skips if an alexg position OR an active alexg pending already
// exists on that instrument — so it never stacks, and never holds a long and a
// short on the same pair at once.
//
// All external deps are injectable for testing (broker / rules / execute /
// watcher / telegram / candle source).
// ----------------------------------------------------------------------------

const { getAssetById } = require('./asset-registry');
const TRADE = require('./alexg-trade');

const INSTRUMENTS = ['eurusd', 'gbpusd', 'usdjpy', 'usdchf', 'audusd', 'nzdusd', 'usdcad', 'eurjpy', 'gbpjpy', 'gold', 'nas100', 'us500', 'btc'];
const CFG = {
  rrFloor:      2.0,                 // re-checked against the retest entry
  minGradePct:  70,                  // C or better
  expiryMs:     4 * 60 * 60 * 1000,  // unfilled limit expires in 4h (watcher sweeps it)
  tpConfirmR:   0.10,
};

// Hard requires with literal paths so Vercel's webpack/ncc bundler includes each
// file in the Lambda bundle. safeReq(m) used a variable — webpack can't trace it,
// so all six modules were absent from the bundle and returned null at runtime.
// Each try/catch preserves graceful-degradation: if a module is genuinely absent
// (e.g. in a stripped test bundle) the dep stays null and the missing-deps guard
// handles it cleanly. Injection via opts still works for unit tests.
let _broker    = null; try { _broker    = require('./broker');          } catch (_) {}
let _rules     = null; try { _rules     = require('./rules-store');     } catch (_) {}
let _execute   = null; try { _execute   = require('./execute');         } catch (_) {}
let _watcher   = null; try { _watcher   = require('./watcher');         } catch (_) {}
let _telegram  = null; try { _telegram  = require('./telegram');        } catch (_) {}
let _heartbeat = null; try { _heartbeat = require('./alexg-heartbeat'); } catch (_) {}

function deps(o = {}) {
  return {
    broker:   o.broker   || _broker,
    rules:    o.rules    || _rules,
    execute:  o.execute  || _execute,
    watcher:  o.watcher  || _watcher,
    telegram: o.telegram || _telegram,
    fetchCandlesFn: o.fetchCandlesFn,
    tradeFn: o.tradeFn || TRADE.evaluateTrade,
    now: o.now,
    dryRun: !!o.dryRun,
  };
}

// round to the broker tick increment (mirrors webhook _roundTick)
function roundTick(x, pip, dir) {
  if (x == null || !isFinite(x)) return null;
  const n = x / pip;
  const r = dir === 'down' ? Math.floor(n) : dir === 'up' ? Math.ceil(n) : Math.round(n);
  return Math.round(r * pip * 1e8) / 1e8;
}

// lot sizing — verbatim mirror of applyRulesToSignal's risk-based formula, but
// using alexg's STRUCTURAL stop distance. Honors lotMode / risk% / maxLot /
// mode & template lotMultiplier exactly as the rest of the bot does.
function sizeLot(prof, capital, maxRiskPct, slDistance, meta, preset, tmplOverride) {
  const lotModeRaw = String(prof.lotMode || 'risk-based').toLowerCase();
  let lot;
  if (lotModeRaw.includes('fixed')) {
    lot = prof.fixedLot;
  } else {
    const riskPct = Math.min(maxRiskPct, 2.0) / 100;
    const riskDollars = capital * riskPct;
    if (meta && meta.pipSize && meta.dollarPerPipPerLot) {
      const pips = slDistance / meta.pipSize;
      lot = riskDollars / (pips * meta.dollarPerPipPerLot);
    } else {
      lot = prof.fixedLot;
    }
  }
  lot = lot * (preset.lotMultiplier || 1.0) * (tmplOverride.lotMultiplier || 1.0);
  if (lot > prof.maxLot) lot = prof.maxLot;
  return Math.max(0.01, Math.round(lot * 100) / 100);
}

async function runAlexg(opts = {}) {
  const D = deps(opts);
  const summary = { ok: true, blocked: null, evaluated: [], placed: [], skipped: [], at: Date.now() };
  if (!D.rules || !D.broker || !D.execute) { summary.ok = false; summary.blocked = 'missing-deps'; return summary; }

  const rules = await D.rules.getRules();

  // ── global gates (mirror applyRulesToSignal's account/mode checks) ──
  if (rules.account.emergencyStop) { summary.blocked = 'emergency-stop'; return summary; }
  const preset = rules.modePresets[rules.activeMode];
  if (!preset) { summary.blocked = `unknown-mode:${rules.activeMode}`; return summary; }
  if (preset.lotMultiplier === 0 || !preset.acceptedTemplates.includes('alexg')) {
    summary.blocked = `mode-${rules.activeMode}-excludes-alexg`; return summary;
  }
  const tmplOverride = rules.templateOverrides['alexg'];
  if (!tmplOverride || !tmplOverride.enabled) { summary.blocked = 'alexg-template-disabled'; return summary; }

  const tradingMode = rules.tradingMode || 'auto';
  const tradingEnabled = D.execute.isTradingEnabled ? D.execute.isTradingEnabled() : true;
  const autoPlace = !D.dryRun && tradingMode === 'auto' && tradingEnabled;

  const account = await D.broker.fetchAccount().catch(() => null);
  const capital = (account && (account.equity || account.balance)) || 0;
  const positions = (await D.broker.fetchPositions().catch(() => [])) || [];
  const maxConc = Math.min(
    rules.account.maxConcurrentPositions,
    preset.maxConcurrent != null ? preset.maxConcurrent : Infinity
  );

  let todaysPnL = 0;
  try { todaysPnL = await D.rules.getTodaysPnL(); } catch (_) {}
  if (capital > 0 && (todaysPnL / capital) * -100 >= rules.account.maxDailyLossPct) {
    summary.blocked = 'daily-loss-limit'; return summary;
  }

  let liveCount = positions.length;

  // Phase 1 — evaluate all pairs concurrently (the slow, read-only part).
  // Each pair runs its full candle-fetch + bias/AOI/entry pipeline in parallel,
  // cutting wall time from sum(pairs) to max(pairs). One pair erroring cannot
  // reject the batch — each is isolated in its own try/catch.
  const evalBatch = await Promise.all(INSTRUMENTS.map(async (asset) => {
    const meta = getAssetById(asset);
    const inst = rules.instruments[asset];
    if (!inst || !inst.enabled) return { asset, meta, inst, skip: 'instrument-disabled' };

    // one-per-pair gate reads the pre-loop positions/pending snapshot — safe to check concurrently
    const hasOpen = positions.some((p) => (p.assetId === asset || (p.symbol && meta && p.symbol.toUpperCase().includes((meta.pineTicker || '').toUpperCase()))) && p.comment && /^QB-V1[23]-alexg-/.test(p.comment));
    let hasPending = false;
    try {
      const pend = await D.watcher.getPendingSetups(asset);
      hasPending = (pend || []).some((p) => p && p.setup && p.setup.template === 'alexg' && ['pending', 'placed', 'filled'].includes(p.status));
    } catch (_) {}
    if (hasOpen || hasPending) return { asset, meta, inst, skip: 'alexg-already-active-on-pair' };

    // trade evaluation — the candle-heavy work; concurrent is the goal
    try {
      const plan = await D.tradeFn(asset, { fetchCandlesFn: D.fetchCandlesFn, now: D.now, minGradePct: CFG.minGradePct });
      return { asset, meta, inst, plan };
    } catch (e) {
      return { asset, meta, inst, skip: 'eval-threw:' + e.message };
    }
  }));

  // Phase 2 — sequential placement. liveCount is mutated here, so this must be
  // serialized. Each iteration is fast (sizing math + at most one broker order
  // call), so the serialization cost is negligible vs. the evaluation savings.
  for (const r of evalBatch) {
    const { asset, skip, meta, inst, plan } = r;
    if (skip) { summary.skipped.push({ asset, reason: skip }); continue; }

    summary.evaluated.push({ asset, tradeable: plan.tradeable, grade: plan.grade && plan.grade.letter, direction: plan.direction, reason: plan.reason });
    if (!plan.tradeable) { summary.skipped.push({ asset, reason: plan.reason }); continue; }

    if (liveCount >= maxConc) { summary.skipped.push({ asset, reason: `max-concurrent (${liveCount}/${maxConc})` }); continue; }

    const dir = plan.direction === 'long' ? 'LONG' : 'SHORT';
    const isLong = dir === 'LONG';
    const pip = (meta && meta.pipSize) || 0.0001;
    const zone = plan.zone;

    // set-and-forget LIMIT at the AOI retest edge; recompute RR from THIS entry
    const entryRaw = isLong ? zone.hi : zone.lo;
    const slRaw = plan.sl, tpRaw = plan.tp;
    const risk = Math.abs(entryRaw - slRaw);
    const rr = risk > 0 ? (isLong ? (tpRaw - entryRaw) : (entryRaw - tpRaw)) / risk : null;
    if (rr == null || rr < CFG.rrFloor) { summary.skipped.push({ asset, reason: `retest RR ${rr == null ? 'n/a' : rr.toFixed(2)} < ${CFG.rrFloor}` }); continue; }

    // ── sizing (instrument's own rules) ──
    const prof = D.rules.resolveProfile ? D.rules.resolveProfile(inst) : inst;
    const lot = sizeLot(prof, capital, rules.account.maxRiskPerTradePct, risk, meta, preset, tmplOverride);

    // risk-ceiling guard (mirror applyRulesToSignal)
    if (meta && meta.pipSize && meta.dollarPerPipPerLot && capital > 0) {
      const pips = risk / meta.pipSize;
      const actualRisk = pips * meta.dollarPerPipPerLot * lot;
      const maxRiskD = capital * (rules.account.maxRiskPerTradePct / 100);
      if (actualRisk > maxRiskD * 1.05) { summary.skipped.push({ asset, reason: `risk-exceeds-max ($${actualRisk.toFixed(2)} > $${maxRiskD.toFixed(2)})` }); continue; }
    }

    const brokerSymbol = D.broker.toBrokerSymbol ? await D.broker.toBrokerSymbol(asset) : asset;
    const rEntry = roundTick(entryRaw, pip, 'nearest');
    const rSL = roundTick(slRaw, pip, isLong ? 'down' : 'up');
    const rTP = roundTick(tpRaw, pip, isLong ? 'down' : 'up');
    const ts = Date.now();
    const comment = `QB-V13-alexg-${dir}-${plan.triggerTF || 'na'}`.slice(0, 64);
    const style = plan.tradeType === 'swing' ? 'swing' : 'day';
    const rOf = (tp) => (risk > 0 ? Math.round(Math.abs(tp - rEntry) / risk * 10) / 10 : null);

    // manual mode (or dry run): log the plan, don't place
    if (!autoPlace) {
      summary.skipped.push({ asset, reason: D.dryRun ? 'dry-run' : 'manual-mode', plan: { dir, entry: rEntry, sl: rSL, tp: rTP, lot, rr: +rr.toFixed(2), grade: plan.grade.letter } });
      continue;
    }

    // ── place the limit (set-and-forget retest at the AOI edge) ──
    let placement, entryTypeFinal = 'retest', execKindFinal = 'limit';
    try { placement = await D.execute.placeLimitOrder(brokerSymbol, dir, lot, rEntry, rSL, rTP, comment); }
    catch (e) { placement = { ok: false, error: e.message }; }

    // Inside-zone fallback: if price is already at/through the AOI, a retest limit
    // sits on the wrong side of market and the broker rejects it INVALID_PRICE.
    // Enter at MARKET instead — for a long the fill is at/below zone.hi, for a
    // short at/above zone.lo, so RR can only improve vs the planned retest. SL/TP
    // are unchanged, so risk is preserved. (Needs placeMarketOrder, now in execute.)
    if (!placement.ok && /INVALID_PRICE/i.test(String(placement.error || '')) && D.execute.placeMarketOrder) {
      try { placement = await D.execute.placeMarketOrder(brokerSymbol, dir, lot, rSL, rTP, comment); }
      catch (e) { placement = { ok: false, error: e.message }; }
      if (placement.ok) { entryTypeFinal = 'immediate'; execKindFinal = 'market'; }
    }

    if (!placement.ok) {
      summary.skipped.push({ asset, reason: 'place-failed: ' + String(placement.error || '').slice(0, 120) });
      try { await D.rules.logActivity({ type: 'placement-failed', asset, template: 'alexg', direction: dir, reason: placement.error }); } catch (_) {}
      continue;
    }

    // ── pending record (shape manage-trades + recognition consume) ──
    const pendingRecord = {
      id: `setup_${asset}_alexg_${ts}`, asset,
      templateName: 'alexg', plannedEntry: rEntry, slPrice: rSL,
      setup: {
        direction: dir, mode: style === 'swing' ? 'SWING' : 'DAY',
        session: plan.session && plan.session.window, contributingTactics: ['alexg'],
        timeframesInPlay: [plan.triggerTF], slDistance: risk, entry: rEntry, sl: rSL,
        style, template: 'alexg',
        targets: [{ price: rTP, rMultiple: rOf(rTP) }],
        grade: { letter: plan.grade.letter, pct: plan.grade.pct }, patterns: plan.patterns || [],
      },
      recognition: { advice: 'neutral', matchCount: 0, wins: 0, losses: 0, confidence: 'none' },
      sizing: { baseLot: lot, recommendedLot: lot },
      tpLevels: [{ price: rTP, rMultiple: rOf(rTP), source: 'alexg-structure' }],
      tpConfirmR: CFG.tpConfirmR,
      createdAt: ts, expiresAt: ts + CFG.expiryMs, status: 'placed',
      brokerOrderId: placement.orderId, comment, positionId: null,
      entryType: entryTypeFinal, execKind: execKindFinal, v13: true,
    };
    try { await D.watcher.addPendingSetup(asset, pendingRecord); } catch (e) { /* non-fatal */ }
    try { await D.rules.logActivity({ type: 'trade-placed', asset, template: 'alexg', direction: dir, lot, entry: rEntry, sl: rSL, tp1: rTP, entryType: entryTypeFinal, execKind: execKindFinal, activeMode: rules.activeMode, brokerOrderId: placement.orderId }); } catch (_) {}
    try {
      if (D.telegram && D.telegram.notifyTradePlaced) {
        await D.telegram.notifyTradePlaced({
          asset, direction: dir, lot, entry: rEntry, sl: rSL,
          tpLevels: [{ price: rTP, rMultiple: rOf(rTP), source: 'alexg-structure' }],
          riskDollars: (meta && meta.dollarPerPipPerLot && meta.pipSize) ? (meta.dollarPerPipPerLot / meta.pipSize) * risk * lot : null,
          brokerOrderId: placement.orderId, template: 'alexg',
        });
      }
    } catch (_) {}

    liveCount++;
    summary.placed.push({ asset, dir, entry: rEntry, sl: rSL, tp: rTP, lot, rr: +rr.toFixed(2), grade: plan.grade.letter, orderId: placement.orderId });
  }

  return summary;
}

// ─── HTTP handler (cron + key-guarded manual trigger) ───────────────
module.exports = async (req, res) => {
  const heartbeat = _heartbeat;
  const started = Date.now();
  try {
    const q = req.query || {};
    const key = q.key || (req.headers && (req.headers['x-api-key'] || req.headers['authorization']));
    const ua = (req.headers && req.headers['user-agent']) || '';
    // Vercel's scheduler is identified by User-Agent (confirmed in logs) and/or x-vercel-cron header.
    const isCron = ua.startsWith('vercel-cron') || !!(req.headers && req.headers['x-vercel-cron']);
    const webhookKey = process.env.WEBHOOK_API_KEY;
    const cronSecret = process.env.CRON_SECRET;
    if ((webhookKey || cronSecret) && !isCron) {
      const keyOk = (webhookKey && (key === webhookKey || key === `Bearer ${webhookKey}`)) ||
                    (cronSecret  && (key === cronSecret  || key === `Bearer ${cronSecret}`));
      if (!keyOk) return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const dryRun = q.dry === '1' || q.dry === 'true';
    const summary = await runAlexg({ dryRun });
    // heartbeat: record a healthy run (proves the cron is alive). Never throws.
    if (heartbeat && heartbeat.recordRun) {
      try { await heartbeat.recordRun(summary, { durationMs: Date.now() - started, dryRun }); } catch (_) {}
    }
    return res.status(200).json(summary);
  } catch (e) {
    // heartbeat: record + alert on a hard failure so it isn't silent.
    if (heartbeat && heartbeat.recordError) {
      try { await heartbeat.recordError(e, { durationMs: Date.now() - started }); } catch (_) {}
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.runAlexg = runAlexg;
module.exports.sizeLot = sizeLot;
module.exports.roundTick = roundTick;
module.exports.INSTRUMENTS = INSTRUMENTS;
module.exports.CFG = CFG;