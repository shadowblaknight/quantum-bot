/* eslint-disable */
// V12 — api/cron.js
//
// THE single entry point Vercel cron calls. Chains:
//   1. WATCHER — updates mental model, detects coherent setups, queues pending
//   2. EXECUTE — places limit orders for pending setups (if trading enabled)
//   3. MANAGE  — manages open positions (TP/SL/BE), records closed trades
//
// Each step is independent and isolated. If watcher fails, execute and manage
// still run with last-known state.
// ----------------------------------------------------------------------------

const { applyCors } = require('./_lib');
const { runWatcherTick } = require('./watcher');
const { runExecuteTick } = require('./execute');
const { runManageTick } = require('./manage-trades');

async function runFullCronTick() {
  const t0 = Date.now();

  const [watcherResult, executeResult, manageResult] = await Promise.allSettled([
    runWatcherTick(),
    runExecuteTick(),
    runManageTick(),
  ]);

  return {
    ts: t0,
    durationMs: Date.now() - t0,
    watcher: watcherResult.status === 'fulfilled' ? watcherResult.value : { error: String(watcherResult.reason) },
    execute: executeResult.status === 'fulfilled' ? executeResult.value : { error: String(executeResult.reason) },
    manage:  manageResult.status === 'fulfilled' ? manageResult.value  : { error: String(manageResult.reason) },
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