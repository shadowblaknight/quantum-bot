/* eslint-disable */
// V10 — api/cron.js
// Orchestrator. Runs every minute via vercel.json cron.
//
// Per-tick flow:
//   1. Load user config (instruments, sessions, riskMode)
//   2. For each instrument:
//      a. Skip if outside session hours
//      b. Skip if news blackout (high-impact news within next 30min)
//      c. Acquire symbol-atomic lock (kills the long+short race condition)
//      d. Check chaos detector — if chaos active, skip new trades
//      e. Call /api/ai for decision (with full multi-TF + memory + regime)
//      f. If BUY/SELL with sufficient confidence, call /api/execute
//      g. Release lock
//   3. Call /api/manage-trades to handle TP ladder on existing positions
//   4. Detect closed positions, write outcomes to memory + family stats
//   5. At 21:00 UTC daily, trigger /api/reflect

const { applyCors, getRedis, safeParse, normSym, instCategory, selfBase, tg } = require('./_lib');
const { fetchPositions, fetchPrice } = require('./broker');
const { getRegimeFor } = require('./regime');
const { recordOutcome } = require('./memory');
const { recordTrade } = require('./trades');

const SYMBOL_LOCK_TTL = 90; // seconds — long enough to cover full AI + execute roundtrip

// Session check
function isTradeable(sym, utcH, isWeekend) {
  if (!sym || isWeekend) return false;
  const cat = instCategory(sym);
  if (cat === 'CRYPTO') return utcH >= 7 && utcH < 23;
  // Forex/Gold/Indices: 08-18 UTC (cuts late NY losing zone)
  return utcH >= 8 && utcH < 18;
}

function sessionOf(utcH) {
  if (utcH >= 13 && utcH < 16) return 'OVERLAP';
  if (utcH >= 13 && utcH < 18) return 'NEW_YORK';
  if (utcH >= 8  && utcH < 16) return 'LONDON';
  return 'ASIAN';
}

// Daily reflection trigger (only fire once per day at 21:00 UTC)
async function maybeRunReflection() {
  const r = getRedis(); if (!r) return false;
  const now = new Date();
  if (now.getUTCHours() !== 21) return false;
  const today = now.toISOString().slice(0, 10);
  const sentKey = 'v10:reflection_sent:' + today;
  const already = await r.get(sentKey).catch(() => null);
  if (already) return false;
  await r.set(sentKey, '1', { ex: 86400 * 2 }).catch(() => {});
  // Fire and forget
  fetch(selfBase() + '/api/reflect').catch(() => {});
  return true;
}

// Cleanup stale closed positions — record outcomes that haven't been recorded yet
async function detectClosedAndRecord() {
  const r = getRedis(); if (!r) return { detected: 0 };
  // Compare current positions vs last-seen
  const lastSeenRaw = await r.get('v10:cron_last_pos').catch(() => null);
  const lastSeen = safeParse(lastSeenRaw) || [];
  const { positions } = await fetchPositions();
  const currentIds = positions.map(p => String(p.id));
  const closedIds = lastSeen.filter(id => !currentIds.includes(id));

  // For each closed id, fetch from history and record
  if (closedIds.length) {
    try {
      const hr = await fetch(selfBase() + '/api/history');
      if (hr.ok) {
        const hd = await hr.json();
        const closed = (hd.trades || hd.deals || []).filter(t => closedIds.includes(String(t.id)));
        for (const ct of closed) {
          const cmt = ct.comment || '';
          const strategy = cmt.startsWith('QB:') ? cmt.slice(3).trim() : 'UNKNOWN';
          if (strategy === 'UNKNOWN' || strategy.length < 3) continue;
          const won = (ct.profit || 0) > 0;
          const sessionLabel = sessionOf(new Date(ct.time || Date.now()).getUTCHours());
          await recordTrade({
            symbol: ct.symbol,
            strategy,
            pnl: ct.profit || 0,
            won,
            positionId: ct.id,
            session: sessionLabel,
          }).catch(() => {});
          await recordOutcome({ sym: normSym(ct.symbol), pnl: ct.profit || 0, won }).catch(() => {});
        }
      }
    } catch (_) {}
  }
  await r.set('v10:cron_last_pos', JSON.stringify(currentIds), { ex: 7 * 24 * 60 * 60 }).catch(() => {});
  return { detected: closedIds.length };
}

// Main cron tick
async function runCronTick() {
  const summary = { ts: Date.now(), instruments: [], errors: [] };
  const r = getRedis();
  if (!r) return { error: 'no redis' };

  // Load config
  const configRaw = await r.get('v9:config').catch(() => null);
  const config = safeParse(configRaw) || { instruments: [], sessions: [], riskMode: 'TEST' };
  const instruments = (config.instruments || []).filter(Boolean);

  if (!instruments.length) {
    return { ok: true, message: 'no instruments configured', summary };
  }

  const utcH = new Date().getUTCHours();
  const utcD = new Date().getUTCDay();
  const isWeekend = utcD === 0 || utcD === 6;

  // Manage existing positions FIRST (TP ladder, retrace, etc.)
  try {
    const { positions } = await fetchPositions();
    if (positions.length) {
      // V10 BUGFIX: manage-trades.js expects each position to have tp1/tp2/tp3/tp4 fields,
      // but fetchPositions() returns broker shape (only takeProfit). Build TP ladder here,
      // either from existing v9:tp:{id} state or from broker SL distance (2.5R default).
      const managePositions = [];
      for (const pos of positions) {
        const stateRaw = await r.get('v9:tp:' + pos.id).catch(() => null);
        const state = safeParse(stateRaw);
        if (state && state.tp1) {
          // Already have ladder — use stored values
          managePositions.push({
            ...pos,
            tp1: state.tp1, tp2: state.tp2, tp3: state.tp3, tp4: state.tp4,
          });
        } else if (pos.openPrice && (pos.takeProfit || pos.stopLoss)) {
          // Backfill ladder. Prefer broker TP as TP4. If no TP, estimate from SL distance.
          const sign = pos.direction === 'LONG' ? 1 : -1;
          let tp4Ref;
          if (pos.takeProfit) {
            tp4Ref = pos.takeProfit;
          } else if (pos.stopLoss) {
            const slDist = Math.abs(pos.openPrice - pos.stopLoss);
            tp4Ref = pos.openPrice + sign * slDist * 2.5;
          } else continue;
          const tp1Dist = Math.abs(tp4Ref - pos.openPrice);
          managePositions.push({
            ...pos,
            tp1: pos.openPrice + sign * tp1Dist * 0.25,
            tp2: pos.openPrice + sign * tp1Dist * 0.50,
            tp3: pos.openPrice + sign * tp1Dist * 0.75,
            tp4: tp4Ref,
          });
        }
      }
      if (managePositions.length) {
        await fetch(selfBase() + '/api/manage-trades', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positions: managePositions }),
        }).catch(() => {});
      }
    }
    // Detect closures
    await detectClosedAndRecord();
  } catch (e) { summary.errors.push('manage: ' + e.message); }

  // For each instrument, attempt new trade
  for (const sym of instruments) {
    const symInfo = { sym, action: null };
    try {
      if (!isTradeable(sym, utcH, isWeekend)) {
        symInfo.action = 'skip-session';
        summary.instruments.push(symInfo);
        continue;
      }

      // V10 SYMBOL-ATOMIC LOCK — kills long+short race condition
      const lockKey = 'v10:open:' + sym;
      const lockOk = await r.set(lockKey, String(Date.now()), { nx: true, ex: SYMBOL_LOCK_TTL }).catch(() => null);
      if (!lockOk) {
        symInfo.action = 'skip-locked';
        summary.instruments.push(symInfo);
        continue;
      }

      try {
        // Get regime + chaos for this symbol
        const regime = await getRegimeFor(sym);
        if (regime.chaos && regime.chaos.chaos) {
          symInfo.action = 'skip-chaos';
          symInfo.detail = 'ratio ' + regime.chaos.ratio + 'x';
          continue;
        }

        // Call AI for decision
        const aiResp = await fetch(selfBase() + '/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, riskMode: config.riskMode }),
        });
        if (!aiResp.ok) {
          symInfo.action = 'ai-error';
          symInfo.detail = String(aiResp.status);
          continue;
        }
        const decision = await aiResp.json();

        if (decision.decision === 'WAIT' || !decision.decision) {
          symInfo.action = 'wait';
          symInfo.detail = (decision.reason || '').slice(0, 80);
          continue;
        }

        if (decision.confidence < 30 || !decision.volume || decision.volume <= 0) {
          symInfo.action = 'wait-lowconf';
          symInfo.detail = 'conf ' + decision.confidence;
          continue;
        }

        // Get price for SL/TP calculation
        const priceData = await fetchPrice(sym);
        if (!priceData || !priceData.price) {
          symInfo.action = 'no-price';
          continue;
        }
        const entry = decision.decision === 'BUY' ? priceData.ask : priceData.bid;

        // Calculate SL/TP from pip values returned by AI
        const cat = instCategory(sym);
        // V10: Per-instrument pip multiplier. AI returns slPips/tpPips in INSTRUMENT-NATIVE pips.
        // - Forex non-JPY: 0.0001  (1 pip = 0.0001)
        // - Forex JPY: 0.01
        // - Gold/Silver: 0.01      (XAUUSD pip is conventionally $0.01)
        // - Crypto BTC: 1.0        (1 BTC pip = $1; AI should return slPips ~ 200-500 for BTC)
        // - Indices: 1.0           (NAS100 pip = 1 point)
        let pipMult;
        if (cat === 'GOLD' || cat === 'METAL') pipMult = 0.01;
        else if (cat === 'CRYPTO')             pipMult = 1.0;
        else if (cat === 'INDEX')              pipMult = 1.0;
        else if (sym.includes('JPY'))          pipMult = 0.01;
        else                                   pipMult = 0.0001;

        // Sanity-check AI pip values against realistic ranges per category
        let slPips = decision.slPips || 30;
        let tpPips = decision.tp1Pips || (slPips * 2.5);
        if (cat === 'CRYPTO' && slPips < 100) slPips = 200;     // BTC needs wider SL
        if (cat === 'INDEX'  && slPips < 20)  slPips = 30;      // index pip is 1pt
        if (slPips > 500 && cat !== 'CRYPTO') slPips = 100;     // sanity cap
        if (tpPips < slPips) tpPips = slPips * 2;               // ensure positive R:R
        const sign = decision.decision === 'BUY' ? 1 : -1;
        const sl = entry - sign * slPips * pipMult;
        const tp = entry + sign * tpPips * pipMult;

        // Execute
        const execResp = await fetch(selfBase() + '/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instrument: sym,
            direction:  decision.decision === 'BUY' ? 'LONG' : 'SHORT',
            entry,
            stopLoss:   sl,
            takeProfit: tp,
            volume:     decision.volume,
            comment:    'QB:' + (decision.rawTactic || decision.family || 'AI').slice(0, 28),
          }),
        });
        const execData = await execResp.json().catch(() => ({}));
        symInfo.action = execData.success ? 'opened' : 'exec-failed';
        symInfo.detail = execData.success ? ('positionId=' + execData.positionId) : (execData.reason || 'unknown');
        symInfo.decision = decision;
        symInfo.exec = execData;

        // Telegram notification on success
        if (execData.success) {
          await tg(
            '✨ <b>V10 OPEN · ' + sym + '</b>\n\n' +
            '<pre>' +
            decision.decision + ' ' + decision.volume + 'L @ ' + entry.toFixed(5) + '\n' +
            'Family:    ' + decision.family + '\n' +
            'Tactic:    ' + (decision.rawTactic || '?') + '\n' +
            'Confidence: ' + decision.confidence + '% (raw ' + decision.aiRawConfidence + ')\n' +
            'Regime:    ' + decision.regime + '\n' +
            'Session:   ' + decision.session + '\n' +
            '──────────────────\n' +
            'SL:        ' + sl.toFixed(5) + ' (' + slPips + ' pips)\n' +
            'TP:        ' + tp.toFixed(5) + ' (' + tpPips + ' pips)' +
            '</pre>\n' +
            '<i>' + (decision.reason || '').slice(0, 200) + '</i>'
          );
        }
      } finally {
        await r.del(lockKey).catch(() => {});
      }
    } catch (e) {
      symInfo.action = 'error';
      symInfo.detail = e.message;
    }
    summary.instruments.push(symInfo);
  }

  // Daily reflection at 21:00 UTC
  await maybeRunReflection().catch(() => {});

  return { ok: true, summary };
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    // V10: Weekly backtest refresh (called by Sunday 22:00 UTC cron)
    const action = String((req.query && req.query.action) || '');
    if (action === 'weekly-backtest') {
      return res.status(200).json(await runWeeklyBacktest());
    }
    return res.status(200).json(await runCronTick());
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'unknown' });
  }
};

// V10: Weekly backtest refresh -- downloads recent historical data and runs all 6 families
// against each user instrument. Results cached for AI prompt to use.
async function runWeeklyBacktest() {
  const r = getRedis();
  if (!r) return { error: 'no redis' };
  const configRaw = await r.get('v9:config').catch(() => null);
  const config = safeParse(configRaw) || {};
  const instruments = (config.instruments || []).filter(Boolean);
  if (!instruments.length) return { ok: true, message: 'no instruments' };

  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);
  const summary = { instruments: [] };

  for (const sym of instruments) {
    const perSym = { sym, fetched: false, backtests: {} };
    try {
      // 1. Refresh historical data (if TWELVE_DATA_KEY is set)
      if (process.env.TWELVE_DATA_KEY) {
        const fetchResp = await fetch(selfBase() + '/api/historical-fetch?symbol=' + sym + '&tf=1h&start=' + start + '&end=' + end);
        if (fetchResp.ok) perSym.fetched = true;
      }
      // 2. Run backtest for all families
      const btResp = await fetch(selfBase() + '/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym, family: 'ALL', start, end, tf: '1h' }),
      });
      if (btResp.ok) {
        const bt = await btResp.json();
        for (const [fam, result] of Object.entries(bt.families || {})) {
          if (result.stats) perSym.backtests[fam] = result.stats;
        }
      }
    } catch (e) { perSym.error = e.message; }
    summary.instruments.push(perSym);
  }

  // Telegram summary
  await tg(
    '🧪 <b>Weekly Backtest Summary</b>\n\n' +
    '<pre>' +
    summary.instruments.map(s => {
      const lines = [s.sym + (s.fetched ? ' (data refreshed)' : '')];
      for (const [fam, stats] of Object.entries(s.backtests || {})) {
        lines.push('  ' + fam + ': ' + stats.winRate + '% (n=' + stats.total + ', PF=' + stats.profitFactor + ')');
      }
      return lines.join('\n');
    }).join('\n──────────\n') +
    '</pre>'
  ).catch(() => {});

  return { ok: true, summary };
}

module.exports.runCronTick = runCronTick;
module.exports.isTradeable = isTradeable;
module.exports.sessionOf = sessionOf;