/* eslint-disable */
// api/ftmo-guard.js — FTMO 2-Step challenge safety guard
//
// Checks daily loss and total drawdown before every V20 specialist trade.
// Blocks execution when approaching FTMO's hard limits with a safety margin.
//
// FTMO 2-Step Standard (100k account):
//   Max daily loss:  5%  of balance at start of day  (equity-based)
//   Max total loss:  10% of initial challenge balance (equity-based)
//
// Our block thresholds (buffer before the FTMO wall):
//   Daily block:   4.0%  (1% buffer before the 5% wall)
//   Total block:   8.5%  (1.5% buffer before the 10% wall)
//
// Warning thresholds (Telegram alert, trading continues):
//   Daily warn:    3.0%
//   Total warn:    7.0%
//
// Redis keys:
//   v20:ftmo:initial_balance        — challenge starting balance (set once, never auto-reset)
//   v20:ftmo:day_start:<YYYY-MM-DD> — balance at first signal of each trading day
//
// API:
//   GET  /api/ftmo-guard                               → check limits, return status
//   GET  /api/ftmo-guard?action=set-initial&balance=N  → manually set initial balance
//   GET  /api/ftmo-guard?action=reset-day              → clear today's day-start (use after broker deposits)
// ----------------------------------------------------------------------------

const { getRedis, applyCors } = require('./_lib');
const { fetchAccount }        = require('./broker');
const { sendOnce }            = require('./telegram');

const DAILY_BLOCK_PCT = 4.0;   // hard stop — 1% buffer before FTMO 5% daily limit
const TOTAL_BLOCK_PCT = 8.5;   // hard stop — 1.5% buffer before FTMO 10% total limit
const DAILY_WARN_PCT  = 3.0;   // warning — signal alert, still trade
const TOTAL_WARN_PCT  = 7.0;   // warning — signal alert, still trade

const INITIAL_BAL_KEY   = 'v20:ftmo:initial_balance';
const DAY_START_KEY     = (d) => `v20:ftmo:day_start:${d}`;

function _today() { return new Date().toISOString().slice(0, 10); }
function _hour()  { return new Date().toISOString().slice(0, 13); }

// Seed a Redis key if not set; return whatever value is now in Redis
async function _seedIfAbsent(r, key, value, ex) {
  const existing = await r.get(key).catch(() => null);
  if (!existing) {
    await r.set(key, String(value), ex ? { ex } : undefined).catch(() => {});
    return value;
  }
  return parseFloat(existing);
}

// ── Main guard — call before every V20 specialist trade placement ─────────────
// Returns { canTrade: boolean, reason?: string, dailyLossPct, totalDDPct, warnings[] }
// Fails OPEN on broker timeouts or Redis errors — never silently blocks a trade.
async function checkFTMOLimits() {
  try {
    const r = getRedis();

    // Fetch account with 3 s hard timeout (broker can be slow)
    const acct = await Promise.race([
      fetchAccount(),
      new Promise((res) => setTimeout(() => res(null), 3000)),
    ]);

    if (!acct) return { canTrade: true, reason: 'guard-broker-timeout' };

    const balance = acct.balance || acct.equity || 0;
    const equity  = acct.equity  || acct.balance || 0;

    if (!balance || !equity) return { canTrade: true, reason: 'guard-no-balance' };

    // FTMO uses equity (floating P&L included) for daily loss calculation.
    // Taking min(balance, equity) is conservative and always safe.
    const currentValue = Math.min(balance, equity);

    let initialBal = balance;
    let dayStart   = balance;

    if (r) {
      // Auto-seed initial balance on first ever run
      initialBal = await _seedIfAbsent(r, INITIAL_BAL_KEY, balance, 0 /* no expiry */);
      // Auto-seed today's start-of-day balance on first signal of the day (25h TTL)
      dayStart = await _seedIfAbsent(r, DAY_START_KEY(_today()), balance, 90000);
    }

    const dailyLoss    = Math.max(0, dayStart - currentValue);
    const dailyLossPct = initialBal > 0 ? (dailyLoss / initialBal) * 100 : 0;

    const totalDD    = Math.max(0, initialBal - currentValue);
    const totalDDPct = initialBal > 0 ? (totalDD / initialBal) * 100 : 0;

    const warnings = [];

    // ── Hard blocks ───────────────────────────────────────────────────────────
    if (dailyLossPct >= DAILY_BLOCK_PCT) {
      await sendOnce(
        `ftmo-daily-block:${_today()}`,
        `🚨 <b>FTMO Daily Limit — TRADING BLOCKED</b>\n\n` +
        `Daily loss: <b>${dailyLossPct.toFixed(2)}%</b> of ${DAILY_BLOCK_PCT}% block threshold\n` +
        `FTMO hard limit: 5% · Remaining buffer: ${(5 - dailyLossPct).toFixed(2)}%\n\n` +
        `Balance: $${balance.toFixed(0)} · Equity: $${equity.toFixed(0)}\n` +
        `Day start: $${dayStart.toFixed(0)} · Loss today: $${dailyLoss.toFixed(0)}\n\n` +
        `No new trades today. Block lifts at midnight UTC.`
      ).catch(() => {});
      return {
        canTrade:     false,
        reason:       `ftmo-daily-limit:${dailyLossPct.toFixed(2)}%`,
        dailyLossPct: +dailyLossPct.toFixed(3),
        totalDDPct:   +totalDDPct.toFixed(3),
        warnings,
      };
    }

    if (totalDDPct >= TOTAL_BLOCK_PCT) {
      await sendOnce(
        `ftmo-total-block:${_today()}`,
        `🚨 <b>FTMO Max DD — TRADING BLOCKED</b>\n\n` +
        `Total drawdown: <b>${totalDDPct.toFixed(2)}%</b> of ${TOTAL_BLOCK_PCT}% block threshold\n` +
        `FTMO hard limit: 10% · Remaining buffer: ${(10 - totalDDPct).toFixed(2)}%\n\n` +
        `Initial balance: $${initialBal.toFixed(0)} · Current equity: $${equity.toFixed(0)}\n` +
        `Total loss: $${totalDD.toFixed(0)}\n\n` +
        `⛔ <b>Account approaching breach. Intervene immediately.</b>`
      ).catch(() => {});
      return {
        canTrade:     false,
        reason:       `ftmo-total-limit:${totalDDPct.toFixed(2)}%`,
        dailyLossPct: +dailyLossPct.toFixed(3),
        totalDDPct:   +totalDDPct.toFixed(3),
        warnings,
      };
    }

    // ── Soft warnings (trade allowed, Telegram alert) ─────────────────────────
    if (dailyLossPct >= DAILY_WARN_PCT) {
      warnings.push(`daily-dd-warn:${dailyLossPct.toFixed(2)}%`);
      await sendOnce(
        `ftmo-daily-warn:${_hour()}`,  // dedupe per hour
        `⚠️ <b>FTMO Daily DD Warning — ${dailyLossPct.toFixed(2)}%</b>\n\n` +
        `Daily loss: $${dailyLoss.toFixed(0)} · Limit: $${(initialBal * 0.05).toFixed(0)} (5%)\n` +
        `Block fires at ${DAILY_BLOCK_PCT}% — ${(DAILY_BLOCK_PCT - dailyLossPct).toFixed(2)}% remaining\n\n` +
        `Consider reducing risk or pausing trading for the day.`
      ).catch(() => {});
    }

    if (totalDDPct >= TOTAL_WARN_PCT) {
      warnings.push(`total-dd-warn:${totalDDPct.toFixed(2)}%`);
      await sendOnce(
        `ftmo-total-warn:${_today()}`,
        `⚠️ <b>FTMO Total DD Warning — ${totalDDPct.toFixed(2)}%</b>\n\n` +
        `Total drawdown: $${totalDD.toFixed(0)} · Limit: $${(initialBal * 0.10).toFixed(0)} (10%)\n` +
        `Block fires at ${TOTAL_BLOCK_PCT}% — ${(TOTAL_BLOCK_PCT - totalDDPct).toFixed(2)}% remaining`
      ).catch(() => {});
    }

    return {
      canTrade:     true,
      dailyLossPct: +dailyLossPct.toFixed(3),
      totalDDPct:   +totalDDPct.toFixed(3),
      warnings,
      debug: {
        initialBal:   +initialBal.toFixed(2),
        dayStart:     +dayStart.toFixed(2),
        balance:      +balance.toFixed(2),
        equity:       +equity.toFixed(2),
        currentValue: +currentValue.toFixed(2),
        dailyLoss:    +dailyLoss.toFixed(2),
        totalDD:      +totalDD.toFixed(2),
      },
    };
  } catch (e) {
    // Never block a trade because the guard threw — fail open
    return { canTrade: true, reason: `guard-error:${e.message}` };
  }
}

// ── API handler (dashboard + manual ops) ─────────────────────────────────────
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  const action = (req.query && req.query.action) || '';

  if (action === 'set-initial') {
    const bal = parseFloat(req.query.balance);
    if (!bal || bal <= 0) return res.status(400).json({ error: 'balance required (positive number)' });
    const r = getRedis();
    if (r) await r.set(INITIAL_BAL_KEY, String(bal)).catch(() => {});
    return res.status(200).json({ ok: true, initialBalanceSet: bal });
  }

  if (action === 'reset-day') {
    const r = getRedis();
    if (r) await r.del(DAY_START_KEY(_today())).catch(() => {});
    return res.status(200).json({ ok: true, dayStartCleared: _today() });
  }

  const status = await checkFTMOLimits();
  return res.status(200).json(status);
};

module.exports.checkFTMOLimits = checkFTMOLimits;
