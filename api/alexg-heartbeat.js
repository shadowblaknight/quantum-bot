'use strict';
// ─── Alex G cron observability (heartbeat) ──────────────────────────────
// Turns a SILENT alexg-run cron failure into a VISIBLE / pushed one.
//   • records every run (success or throw) with counts + duration
//   • exposes health: last run, age, stale? (cron is */15 — overdue ⇒ suspect)
//   • read-only HTTP endpoint feeds the dashboard
//   • opt-in watchdog pushes a deduped Telegram alert on a dead/failed cron
// Degrades gracefully: if Redis (./_lib) is unavailable it falls back to an
// in-memory record so the heartbeat itself can never crash the cron, and so
// the module is unit-testable without Upstash.

function safeReq(m) { try { return require(m); } catch (_) { return null; } }
const _lib = safeReq('./_lib') || {};
const getRedis  = _lib.getRedis  || (() => null);
const safeParse = _lib.safeParse || ((s) => { try { return JSON.parse(s); } catch (_) { return null; } });
const applyCors = _lib.applyCors || (() => {});

const KEY               = 'v13:alexg:heartbeat';
const HIST_KEY          = 'v13:alexg:heartbeat:history';
const UNKNOWN_SINCE_KEY = 'v13:alexg:heartbeat:unknown-since';
const CFG = {
  staleMs: 35 * 60 * 1000,   // cron is */15 ⇒ >35min without a run = stale (one miss + margin)
  histMax: 30,
  ttlSec:  30 * 24 * 3600,   // keep ~30 days
};

// in-memory fallback (also the unit-test substrate)
const _mem = { latest: null, history: [], unknownSince: null };
function _resetMem() { _mem.latest = null; _mem.history = []; _mem.unknownSince = null; } // test helper

function _redis(opts) { return (opts && opts.redis) || getRedis(); }
function _now(opts)   { return (opts && opts.now != null) ? opts.now : Date.now(); }

async function _readLatest(opts) {
  const r = _redis(opts);
  if (!r) return _mem.latest;
  try { const raw = await r.get(KEY).catch(() => null); return raw ? (safeParse(raw) || _mem.latest) : null; }
  catch (_) { return _mem.latest; }
}
async function _writeLatest(rec, opts) {
  _mem.latest = rec;
  const r = _redis(opts);
  if (!r) return;
  try { await r.set(KEY, JSON.stringify(rec), { ex: CFG.ttlSec }); } catch (_) {}
}
async function _pushHistory(rec, opts) {
  _mem.history.push(rec);
  if (_mem.history.length > CFG.histMax) _mem.history = _mem.history.slice(-CFG.histMax);
  const r = _redis(opts);
  if (!r) return;
  try {
    const raw = await r.get(HIST_KEY).catch(() => null);
    let arr = (raw ? safeParse(raw) : null) || [];
    arr.push(rec);
    if (arr.length > CFG.histMax) arr = arr.slice(-CFG.histMax);
    await r.set(HIST_KEY, JSON.stringify(arr), { ex: CFG.ttlSec });
  } catch (_) {}
}

function _summarize(summary) {
  const s = summary || {};
  const evald = Array.isArray(s.evaluated) ? s.evaluated : [];
  return {
    placed:    Array.isArray(s.placed) ? s.placed.length : 0,
    evaluated: evald.length,
    skipped:   Array.isArray(s.skipped) ? s.skipped.length : 0,
    tradeable: evald.filter((e) => e && e.tradeable).length,
    blocked:   s.blocked || null,
  };
}

async function recordRun(summary, meta = {}, opts = {}) {
  const rec = {
    ts: _now(opts), ok: true, dryRun: !!meta.dryRun,
    durationMs: meta.durationMs != null ? meta.durationMs : null,
    ..._summarize(summary),
    error: null,
  };
  await _writeLatest(rec, opts);
  await _pushHistory(rec, opts);
  return rec;
}

async function recordError(err, meta = {}, opts = {}) {
  const msg = (err && err.message) ? err.message : String(err);
  const rec = {
    ts: _now(opts), ok: false, dryRun: !!meta.dryRun,
    durationMs: meta.durationMs != null ? meta.durationMs : null,
    placed: 0, evaluated: 0, skipped: 0, tradeable: 0, blocked: null,
    error: msg,
  };
  await _writeLatest(rec, opts);
  await _pushHistory(rec, opts);
  // push alert on a hard failure (deduped per message so a retry loop can't spam)
  const tg = opts.telegram || safeReq('./telegram');
  if (tg && tg.sendOnce) {
    try { await tg.sendOnce('alexg-cron-fail:' + msg.slice(0, 60), `⚠️ <b>Alex G cron failed</b>\n${msg}`); } catch (_) {}
  }
  return rec;
}

async function getHealth(opts = {}) {
  const latest = await _readLatest(opts);
  const now = _now(opts);
  if (!latest) return { status: 'unknown', latest: null, ageMs: null, stale: null, staleMs: CFG.staleMs, now };
  const ageMs = now - latest.ts;
  const stale = ageMs > CFG.staleMs;
  const status = !latest.ok ? 'failed' : (stale ? 'stale' : 'ok');
  return { status, latest, ageMs, stale, staleMs: CFG.staleMs, now };
}

// Opt-in watchdog: a silent/dead cron can't report itself, so this is meant to
// be called by an always-on trigger (a watchdog cron, or manage-trades). It
// pushes a deduped Telegram alert when the last run failed or the cron is stale.
async function runWatchdog(opts = {}) {
  const h = await getHealth(opts);

  if (h.status === 'ok') {
    // cron healthy — clear the unknown-since marker so re-deploys get a clean grace window
    const r = _redis(opts);
    if (r) { try { await r.del(UNKNOWN_SINCE_KEY); } catch (_) {} }
    _mem.unknownSince = null;
    return { alerted: false, status: h.status };
  }

  if (h.status === 'unknown') {
    // Heartbeat was never written. Record when we first noticed; alert only after
    // staleMs (35 min) so a fresh deploy has time for its first cron run.
    const r = _redis(opts);
    const now = h.now;
    let unknownSince = null;
    if (r) {
      try {
        const raw = await r.get(UNKNOWN_SINCE_KEY).catch(() => null);
        if (raw) {
          unknownSince = parseInt(raw, 10) || null;
        } else {
          await r.set(UNKNOWN_SINCE_KEY, String(now), { ex: CFG.ttlSec });
          unknownSince = now;
        }
      } catch (_) {
        unknownSince = _mem.unknownSince || (_mem.unknownSince = now);
      }
    } else {
      unknownSince = _mem.unknownSince || (_mem.unknownSince = now);
    }
    const ageMs = now - (unknownSince || now);
    if (ageMs < CFG.staleMs) return { alerted: false, status: h.status };
    const tg = opts.telegram || safeReq('./telegram');
    if (tg && tg.sendOnce) {
      const ageMin = Math.round(ageMs / 60000);
      const txt = `⚠️ <b>Alex G cron — heartbeat NEVER written</b>\nNo confirmed run in ~${ageMin} min. Check Vercel logs for timeout (504) or auth error.`;
      const bucket = Math.floor(now / CFG.staleMs);
      try { await tg.sendOnce(`alexg-cron-unknown:${bucket}`, txt); } catch (_) {}
    }
    return { alerted: true, status: h.status };
  }

  // status === 'failed' or 'stale' — original behavior unchanged
  const tg = opts.telegram || safeReq('./telegram');
  if (tg && tg.sendOnce) {
    const ageMin = h.ageMs != null ? Math.round(h.ageMs / 60000) : '?';
    const txt = h.status === 'failed'
      ? `⚠️ <b>Alex G cron — last run FAILED</b>\n${(h.latest && h.latest.error) || ''}`
      : `⚠️ <b>Alex G cron is STALE</b>\nNo run in ~${ageMin} min (expected every 15).`;
    // bucket the dedupe key by staleMs so a persistent outage re-alerts periodically, not every minute
    const bucket = Math.floor(h.now / CFG.staleMs);
    try { await tg.sendOnce(`alexg-cron-${h.status}:${bucket}`, txt); } catch (_) {}
  }
  return { alerted: true, status: h.status };
}

// ─── read-only HTTP handler (dashboard) ─────────────────────────────────
module.exports = async (req, res) => {
  try {
    applyCors(req, res);
    const q = (req && req.query) || {};
    if (q.watchdog === '1') {
      const key = q.key || (req.headers && req.headers['x-api-key']);
      const expected = process.env.WEBHOOK_API_KEY || process.env.CRON_SECRET;
      const isCron = req.headers && req.headers['x-vercel-cron'];
      if (expected && !isCron && key !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });
      return res.status(200).json({ ok: true, watchdog: await runWatchdog() });
    }
    return res.status(200).json({ ok: true, health: await getHealth() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.recordRun   = recordRun;
module.exports.recordError = recordError;
module.exports.getHealth   = getHealth;
module.exports.runWatchdog = runWatchdog;
module.exports._resetMem   = _resetMem;
module.exports.CFG         = CFG;