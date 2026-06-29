'use strict';
// ─── Alex G watchdog (the thing that catches a fully-dead cron) ──────────
// alexg-run stamps a heartbeat on every execution. If alexg-run dies entirely
// it can't report its own death — so this independent cron checks the heartbeat
// and pushes a deduped Telegram alert when the run is stale (silent) or failed.
// It is deliberately tiny (one Redis read + maybe one Telegram send) so it is
// far less likely to fail than alexg-run itself. Read-only; never trades.

const HEARTBEAT = (() => { try { return require('./alexg-heartbeat'); } catch (_) { return null; } })();

module.exports = async (req, res) => {
  try {
    const q = (req && req.query) || {};
    const key = q.key || (req.headers && (req.headers['x-api-key'] || req.headers['authorization']));
    const expected = process.env.WEBHOOK_API_KEY || process.env.CRON_SECRET;
    const isCron = req.headers && req.headers['x-vercel-cron'];
    if (expected && !isCron && key !== expected && key !== `Bearer ${expected}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (!HEARTBEAT || !HEARTBEAT.runWatchdog) {
      return res.status(200).json({ ok: true, watchdog: { alerted: false, status: 'heartbeat-unavailable' } });
    }
    const watchdog = await HEARTBEAT.runWatchdog();
    return res.status(200).json({ ok: true, watchdog });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};