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
const { fetchPositions, fetchPrice, fetchCandles } = require('./broker');
const { getRegimeFor } = require('./regime');
const { recordOutcome } = require('./memory');
const { recordTrade } = require('./trades');
const { scanAndStore } = require('./setup-detector');
const { invalidateBrokenObservations } = require('./observation-memory');

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
          const won = (ct.profit || 0) > 0;
          const sessionLabel = sessionOf(new Date(ct.time || Date.now()).getUTCHours());

          // V9 path: only record family stats when we have a real strategy
          if (strategy !== 'UNKNOWN' && strategy.length >= 3) {
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

          // V11 STEP 3: Always join entry features + outcome → store for pattern learner.
          // This runs even for broker-auto-closes (SL/TP hit) where comment is empty.
          // The entry record we wrote at open time has the strategy/family/mode, so we
          // don't need to derive them from the close comment.
          try {
            const entryRaw = await r.get('v11:entry:' + ct.id).catch(() => null);
            const entry = safeParse(entryRaw);
            if (entry) {
              const closeTs = new Date(ct.time || Date.now()).getTime();
              const holdMin = entry.openTs ? Math.round((closeTs - entry.openTs) / 60000) : null;
              const joined = {
                ...entry,
                closedTs: closeTs,
                pnl: ct.profit || 0,
                won,
                holdMin,
                closingComment: cmt,
              };
              const dateKey = new Date(closeTs).toISOString().slice(0, 10);  // YYYY-MM-DD
              const dayKey = 'v11:closed:' + dateKey;
              const existingRaw = await r.get(dayKey).catch(() => null);
              const existing = safeParse(existingRaw);
              const arr = Array.isArray(existing) ? existing : [];
              arr.push(joined);
              await r.set(dayKey, JSON.stringify(arr), { ex: 60 * 24 * 60 * 60 }).catch(() => {}); // 60 days
              // Cleanup the entry record (no longer needed)
              await r.del('v11:entry:' + ct.id).catch(() => {});
              console.log('[CRON] V11 closed-trade record stored for ' + ct.id + ' (won=' + won + ', pnl=$' + (ct.profit || 0).toFixed(2) + ', cmt=' + (cmt || 'broker-auto') + ')');
            }
          } catch (e) {
            console.warn('[CRON] V11 close-feature join failed: ' + e.message);
          }
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
        // V11: Get regime + chaos for AI's awareness, but DON'T veto on it.
        // AI sees chaos info in its prompt and decides whether to trade through it.
        const regime = await getRegimeFor(sym);

        // V11 STEP 2: Run setup detector. Stores active setups to Redis. AI reads them
        // via observation-memory's read paths in ai.js. Cheap (broker candles cached).
        try {
          await scanAndStore(sym);
        } catch (e) { console.warn('[CRON] setup scan ' + sym + ': ' + e.message); }

        // V11 STEP 2: Invalidate any observations broken by current price.
        try {
          const px = await fetchPrice(sym);
          if (px && px.price) await invalidateBrokenObservations(sym, px.price);
        } catch (e) { console.warn('[CRON] obs-invalidate ' + sym + ': ' + e.message); }

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

        // V11: No confidence floor. AI decided BUY/SELL — we trust it.
        // Only sanity check is positive volume (zero-volume trade is a no-op).
        if (!decision.volume || decision.volume <= 0) {
          symInfo.action = 'wait-zerovol';
          symInfo.detail = 'AI returned 0 volume';
          continue;
        }

        // Get price for SL/TP calculation
        const priceData = await fetchPrice(sym);
        if (!priceData || !priceData.price) {
          symInfo.action = 'no-price';
          continue;
        }
        const entry = decision.decision === 'BUY' ? priceData.ask : priceData.bid;

        // V11: Mode-aware SL distance.
        // AI is required to return mode + slPips. If AI omits mode (legacy), default DAY.
        // If AI omits slPips, use ATR-aware default (volatility-aware, much better than fixed table).
        const tradeMode = (decision.mode || 'DAY').toUpperCase();
        const cat = instCategory(sym);
        let pipMult;
        if (cat === 'GOLD' || cat === 'METAL') pipMult = 0.01;
        else if (cat === 'CRYPTO')             pipMult = 1.0;
        else if (cat === 'INDEX')              pipMult = 1.0;
        else if (sym.includes('JPY'))          pipMult = 0.01;
        else                                   pipMult = 0.0001;

        // SL distance: AI value if given, else ATR-aware default
        let slPips = decision.slPips;
        if (!slPips || !isFinite(slPips) || slPips <= 0) {
          const { getRDistance } = require('./_lib');
          // Use current H1 ATR for volatility-aware default
          const currentH1ATR = (regime.indicators && regime.indicators.h1Atr14) || null;
          slPips = getRDistance(sym, tradeMode, currentH1ATR);
        }
        // Sanity caps per category (defense against AI hallucinations — these are minimums)
        if (cat === 'CRYPTO' && slPips < 100) slPips = 300;
        if (cat === 'INDEX'  && slPips < 20)  slPips = 30;
        if (cat === 'GOLD'   && slPips < 50)  slPips = 150;
        if (cat === 'FOREX'  && slPips < 8)   slPips = 12;

        // TP for broker: use the mode's TP4 R-multiple (final target).
        const { getTradingMode, capTPDistance } = require('./_lib');
        const modeDef = getTradingMode(tradeMode);
        const tp4Mult = modeDef.tps[3];

        // V11 FIX (Nov 2): Cap TP4 distance as % of price.
        // Prevents unreachable TP4 like "BTC +$3000 in DAY mode". If the cap kicks in,
        // slPips is reduced so all 4 TPs scale down proportionally.
        const slPipsBeforeCap = slPips;
        slPips = capTPDistance(sym, tradeMode, entry, slPips, tp4Mult);
        if (slPips !== slPipsBeforeCap) {
          console.log('[CRON] TP4 cap applied for ' + sym + ' ' + tradeMode +
                      ': slPips ' + slPipsBeforeCap + ' → ' + slPips +
                      ' (TP4 reach=' + (slPips * tp4Mult * pipMult).toFixed(2) + ' price units)');
        }

        const sign = decision.decision === 'BUY' ? 1 : -1;
        const sl = entry - sign * slPips * pipMult;

        // V11 STRUCTURAL TPs: if AI returned a tps array of 4 prices, validate and use them.
        // Otherwise fall back to R-multiple ladder.
        let aiTps = null;
        if (Array.isArray(decision.tps) && decision.tps.length === 4) {
          const valid = decision.tps.every(p => typeof p === 'number' && isFinite(p) && p > 0);
          // Direction sanity: all TPs must be on correct side of entry, monotonically progressive
          if (valid) {
            const okSide = decision.tps.every(p => sign === 1 ? p > entry : p < entry);
            const okOrder = sign === 1
              ? decision.tps[0] < decision.tps[1] && decision.tps[1] < decision.tps[2] && decision.tps[2] < decision.tps[3]
              : decision.tps[0] > decision.tps[1] && decision.tps[1] > decision.tps[2] && decision.tps[2] > decision.tps[3];

            // TP4 reach validation: use the same % cap as the R-multiple path.
            // Compute the maximum allowed TP4 distance based on the per-mode % cap.
            // We re-derive it by calling capTPDistance with a large slPips and seeing how it caps.
            // This is the price-units distance allowed.
            const cappedSlPips = capTPDistance(sym, tradeMode, entry, 99999, tp4Mult);
            const maxAllowedTp4Dist = cappedSlPips * tp4Mult * pipMult;
            const tp4Reach = Math.abs(decision.tps[3] - entry);
            // Allow a 50% buffer over the R-multiple cap because structural levels can
            // legitimately extend beyond R-multiples (that's the point).
            const okReach = tp4Reach <= maxAllowedTp4Dist * 1.5;

            if (okSide && okOrder && okReach) {
              aiTps = decision.tps;
              const reachStr = entry > 100 ? tp4Reach.toFixed(2) : tp4Reach.toFixed(5);
              console.log('[CRON] Using AI structural TPs for ' + sym + ' ' + tradeMode + ': ' +
                          decision.tps.map(p => p > 1000 ? p.toFixed(2) : p.toFixed(5)).join(', ') +
                          ' (TP4 reach=' + reachStr + ', max=' + (maxAllowedTp4Dist * 1.5).toFixed(entry > 100 ? 2 : 5) + ')');
            } else {
              console.warn('[CRON] AI tps rejected for ' + sym + ': okSide=' + okSide +
                           ' okOrder=' + okOrder + ' okReach=' + okReach +
                           ' (TP4 reach=' + tp4Reach.toFixed(2) + ', max=' + (maxAllowedTp4Dist * 1.5).toFixed(2) + ')' +
                           '. Falling back to R-multiple ladder.');
            }
          } else {
            console.warn('[CRON] AI tps invalid (non-numeric). Falling back to R-multiple ladder.');
          }
        }
        // tp4 for broker — either AI's TP4 or R-multiple
        const tp = aiTps ? aiTps[3] : (entry + sign * slPips * tp4Mult * pipMult);

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
            mode:       tradeMode,
            customTps:  aiTps,                    // V11: AI's structural TP1..TP4 prices, null if using R-multiples
            comment:    'QB:' + (decision.rawTactic || decision.family || 'AI').slice(0, 28),
          }),
        });
        const execData = await execResp.json().catch(() => ({}));
        symInfo.action = execData.success ? 'opened' : 'exec-failed';
        symInfo.detail = execData.success ? ('positionId=' + execData.positionId) : (execData.reason || 'unknown');
        symInfo.decision = decision;
        symInfo.exec = execData;

        // V11 STEP 3: Capture entry-time features for the pattern learner.
        // Stored under v11:entry:{positionId}, joined with closing-trade outcome later.
        if (execData.success && execData.positionId) {
          try {
            const { readSetupsFor } = require('./setup-detector');
            const activeSetups = await readSetupsFor(sym);
            // Determine multi-TF alignment (H1 + H4 same direction at entry)
            let h1h4Aligned = null;
            try {
              const [h1Resp, h4Resp] = await Promise.all([
                fetchCandles(sym, '1h', 5),
                fetchCandles(sym, '4h', 5),
              ]);
              const h1 = h1Resp.candles || [];
              const h4 = h4Resp.candles || [];
              if (h1.length >= 2 && h4.length >= 2) {
                const h1Sign = h1[h1.length - 1].close > h1[0].close ? 1 : h1[h1.length - 1].close < h1[0].close ? -1 : 0;
                const h4Sign = h4[h4.length - 1].close > h4[0].close ? 1 : h4[h4.length - 1].close < h4[0].close ? -1 : 0;
                h1h4Aligned = h1Sign !== 0 && h1Sign === h4Sign;
              }
            } catch (_) {}

            const features = {
              positionId:  execData.positionId,
              symbol:      sym,
              direction:   decision.decision === 'BUY' ? 'LONG' : 'SHORT',
              family:      decision.family || null,
              rawTactic:   decision.rawTactic || null,
              mode:        tradeMode,
              confidence:  decision.confidence || 0,
              aiRawConf:   decision.aiRawConfidence || 0,
              session:     decision.session || null,
              regime:      decision.regime || regime.regime || null,
              chaos:       !!(regime.chaos && regime.chaos.chaos),
              chaosRatio:  (regime.chaos && regime.chaos.ratio) || 0,
              setupPattern: activeSetups[0] ? activeSetups[0].pattern : null,
              setupQuality: activeSetups[0] ? activeSetups[0].quality : null,
              h1h4Aligned: h1h4Aligned,
              entryPrice:  entry,
              sl:          sl,
              slPips:      slPips,
              tp4:         tp,
              volume:      decision.volume,
              riskMode:    config.riskMode,
              openTs:      Date.now(),
            };
            await r.set('v11:entry:' + execData.positionId, JSON.stringify(features), { ex: 30 * 24 * 60 * 60 }).catch(() => {});
            console.log('[CRON] entry features captured for ' + execData.positionId);
          } catch (e) {
            console.warn('[CRON] entry-feature capture failed: ' + e.message);
          }
        }

        // Telegram notification on success
        if (execData.success) {
          // V11 STEP 5: Pull active setups + observations to surface in the open message
          let setupsLine = '';
          let obsLine = '';
          try {
            const { readSetupsFor }     = require('./setup-detector');
            const { readObservations }  = require('./observation-memory');
            const [activeSetups, obs] = await Promise.all([
              readSetupsFor(sym),
              readObservations(sym),
            ]);
            if (activeSetups.length > 0) {
              const top = activeSetups.sort((a, b) => b.quality - a.quality)[0];
              setupsLine = 'Setup:     ' + top.pattern + ' ' + top.direction + ' (' + (top.quality * 100).toFixed(0) + '%)\n';
            }
            if (obs.length > 0) {
              const matching = obs.filter(o =>
                (decision.decision === 'BUY' && o.direction === 'LONG') ||
                (decision.decision === 'SELL' && o.direction === 'SHORT')
              );
              if (matching.length > 0) {
                obsLine = 'Obs:       [' + matching[0].id + '] ' + matching[0].text.slice(0, 80) + '\n';
              }
            }
          } catch (_) {}

          // Compute all 4 TP levels for the telegram message (matches what execute.js stores)
          const tpMults = modeDef.tps;  // e.g. [1, 2, 3, 4] for DAY
          const closesPct = modeDef.closes.map(c => Math.round(c * 100));
          const tpPrice = (rMult) => entry + sign * slPips * rMult * pipMult;
          const fmt = (px) => px > 1000 ? px.toFixed(2) : px.toFixed(5);

          await tg(
            '✨ <b>V11 OPEN · ' + sym + ' · ' + tradeMode + '</b>\n\n' +
            '<pre>' +
            decision.decision + ' ' + decision.volume + 'L @ ' + fmt(entry) + '\n' +
            'Mode:      ' + tradeMode + '\n' +
            'Family:    ' + decision.family + '\n' +
            'Tactic:    ' + (decision.rawTactic || '?') + '\n' +
            'Confidence: ' + decision.confidence + '% (raw ' + decision.aiRawConfidence + ')\n' +
            'Regime:    ' + decision.regime + '\n' +
            'Session:   ' + decision.session + '\n' +
            setupsLine +
            obsLine +
            '──────────────────\n' +
            'SL:        ' + fmt(sl) + ' (' + slPips + ' pips)\n' +
            'TP1:       ' + fmt(tpPrice(tpMults[0])) + ' (' + tpMults[0] + 'R, close ' + closesPct[0] + '%)\n' +
            'TP2:       ' + fmt(tpPrice(tpMults[1])) + ' (' + tpMults[1] + 'R, close ' + closesPct[1] + '%)\n' +
            'TP3:       ' + fmt(tpPrice(tpMults[2])) + ' (' + tpMults[2] + 'R, close ' + closesPct[2] + '%)\n' +
            'TP4:       ' + fmt(tpPrice(tpMults[3])) + ' (' + tpMults[3] + 'R, close ' + closesPct[3] + '%)' +
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