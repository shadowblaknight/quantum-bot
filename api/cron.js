/* eslint-disable */
// V12.2 — api/cron.js
//
// THE single entry point Vercel cron calls. Chains:
//   1. KILL ZONE STATE MACHINE — detect open/close transitions, fire telegram
//   2. WATCHER — updates mental model, detects coherent setups, queues pending
//   3. EXECUTE — places limit orders for pending setups (gated by KZ)
//   4. MANAGE  — manages open positions (TP/SL/BE), records closed trades
//
// Each step is independent and isolated. If watcher fails, execute and manage
// still run with last-known state.
// ----------------------------------------------------------------------------

const { applyCors, getRedis, safeParse } = require('./_lib');
const { runWatcherTick } = require('./watcher');
const { runExecuteTick } = require('./execute');
const { runManageTick } = require('./manage-trades');
const { checkKillZone, killZoneDisplayName } = require('./kill-zones');
const { notifyKillZoneOpen, notifyKillZoneClose } = require('./telegram');
const { runEntryStyleEvaluator } = require('./entrystyle-evaluator');

const KZ_STATE_KEY = 'v12:killzone:lastSeen';

// =================================================================
// KILL ZONE STATE MACHINE
// =================================================================
// Compares current KZ state to last-seen state. Fires open/close
// telegram notifications on transitions. State is persisted in Redis.
//
// Transitions:
//   off  → in_kz      → fire OPEN
//   in_kz_A → in_kz_B → fire CLOSE(A) then OPEN(B)
//   in_kz → off       → fire CLOSE
//   any  → same       → no fire

async function updateKillZoneState(watchlist) {
  const r = getRedis();
  const current = checkKillZone();

  const events = [];

  if (!r) {
    return { current, events, note: 'no-redis' };
  }

  // Read previous state
  let prev = null;
  try {
    const raw = await r.get(KZ_STATE_KEY).catch(() => null);
    prev = safeParse(raw);
  } catch (_) {
    prev = null;
  }

  const prevName = prev?.name || 'OFF_HOURS';
  const currentName = current.name;

  if (prevName !== currentName) {
    // Transition occurred
    if (prevName !== 'OFF_HOURS') {
      events.push({ type: 'close', name: prevName });
      try {
        await notifyKillZoneClose(killZoneDisplayName(prevName));
      } catch (_) {}
    }
    if (currentName !== 'OFF_HOURS') {
      events.push({ type: 'open', name: currentName });
      try {
        await notifyKillZoneOpen(killZoneDisplayName(currentName), watchlist);
      } catch (_) {}
    }

    // Persist new state
    try {
      await r.set(KZ_STATE_KEY, JSON.stringify({
        name: currentName,
        startedAt: Date.now(),
      }), { ex: 86400 * 2 });
    } catch (_) {}
  }

  return { current, events, prev: prevName };
}

// =================================================================
// MAIN CRON ORCHESTRATOR
// =================================================================

async function runFullCronTick() {
  const t0 = Date.now();

  // Step 1: KZ state-machine first (fires telegram on edge transitions)
  // We need the watchlist for the open notification — read cheap from Redis
  const r = getRedis();
  let watchlist = ['gold', 'eurusd'];
  if (r) {
    try {
      const raw = await r.get('v12:watchlist').catch(() => null);
      const parsed = safeParse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) watchlist = parsed;
    } catch (_) {}
  }

  const kzUpdate = await updateKillZoneState(watchlist).catch((e) => ({ error: String(e) }));

  // Steps 2-4: SEQUENTIAL watcher → execute → manage.
  // Parallelizing them causes races:
  //   - Watcher's clearExpiredAndInvalidated cancels pendings while
  //     execute is mid-flight placing them → broker order placed but
  //     pending already marked cancelled (or vice versa).
  //   - Watcher writes new pendings after execute already read the list →
  //     new pending sits idle for 1 minute unnecessarily.
  //   - manage-trades reads positions while watcher fetches them →
  //     duplicate broker API calls.
  // Sequential ordering ensures each step sees the latest state and there's
  // a single source of truth at each phase.
  let watcherResult, executeResult, manageResult;
  try {
    watcherResult = await runWatcherTick();
  } catch (e) {
    watcherResult = { error: String(e) };
  }
  try {
    executeResult = await runExecuteTick();
  } catch (e) {
    executeResult = { error: String(e) };
  }
  try {
    manageResult = await runManageTick();
  } catch (e) {
    manageResult = { error: String(e) };
  }

  // Step 5: entrystyle shadow evaluator (fire-and-forget style; never blocks)
  let entryStyleResult;
  try {
    entryStyleResult = await runEntryStyleEvaluator();
  } catch (e) {
    entryStyleResult = { error: String(e) };
  }

  return {
    ts: t0,
    durationMs: Date.now() - t0,
    killZone: kzUpdate,
    watcher: watcherResult,
    execute: executeResult,
    manage:  manageResult,
    entryStyle: entryStyleResult,
  };
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const result = await runFullCronTick();
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.runFullCronTick = runFullCronTick;
module.exports.updateKillZoneState = updateKillZoneState;