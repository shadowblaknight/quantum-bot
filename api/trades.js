/* eslint-disable */
// api/trades.js -- Quantum Bot V9 Strategy Lab
// Redis namespace: v9:strat:*, v9:crown:*, v9:blacklist
// PERSISTENT FOREVER -- no TTL. Old namespaces (v820, v8, v7, v5, qbot) are ignored.

const { Redis } = require('@upstash/redis');

// ====================================================================
// V9.4: Strict crown rules (replacing V9's "5 wins = crown" which crowned noise)
// ====================================================================
const CROWN_MIN_TRADES       = 7;    // must have at least 7 trades to even be evaluated
const CROWN_MIN_WR           = 65;   // ≥65% win rate required
const CROWN_MIN_EXPECTANCY   = 3;    // average P&L per trade must be ≥ $3
const CROWN_MAX_CONSEC_LOSS  = 2;    // no more than 2 consecutive losses in history
const INCONCLUSIVE_THRESHOLD = 7;    // below this trade count, mark INCONCLUSIVE
const BAN_LOSSES             = 3;    // consecutive losses to ban on instrument
const DETHRONE               = 3;    // post-crown losses to dethrone
const BLACKLIST_PEERS        = 2;    // banned on this many instruments to globally blacklist

// V9.4: Best-session lock
const SESSION_LOCK_MIN_TRADES_PER_SESSION = 7;  // min trades in a session before lock-judging
const SESSION_LOCK_WR_EDGE_PCT            = 15; // best session must be >=15pp better than next

const normSym = (s) => {
  if (!s) return '';
  return s.toUpperCase().replace('.S', '').replace('.PRO', '').trim();
};

const safe = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(500).json({ error: 'Missing Redis environment variables' });
  }

  const redis = new Redis({
    url:   process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  // ====================================================================
  // V9.3: Config persistence (cron reads this to know what to scan)
  // GET  ?action=get-config   -> { instruments: [...], riskMode, sessions }
  // POST ?action=set-config   -> body: { instruments, riskMode, sessions }
  // ====================================================================
  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}
  }
  const action = body.action || (req.query && req.query.action) || null;

  if (action === 'get-config') {
    try {
      const cfg = await redis.get('v9:config').catch(() => null);
      const parsed = (typeof cfg === 'string') ? (() => { try { return JSON.parse(cfg); } catch (_) { return null; } })() : cfg;
      return res.status(200).json(parsed || { instruments: [], riskMode: 'TEST', sessions: ['LONDON', 'NEW YORK'] });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'set-config') {
    try {
      const cfg = {
        instruments: Array.isArray(body.instruments) ? body.instruments.filter(Boolean) : [],
        riskMode:    body.riskMode || 'TEST',
        sessions:    Array.isArray(body.sessions) ? body.sessions : ['LONDON', 'NEW YORK'],
        updatedAt:   new Date().toISOString(),
      };
      await redis.set('v9:config', JSON.stringify(cfg));
      console.log('[CONFIG] saved', JSON.stringify(cfg));
      return res.status(200).json({ ok: true, config: cfg });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ====================================================================
  // V9.4: Wipe existing crowns and re-evaluate all stored stats with
  // the strict crown rules. Run this once after deploying V9.4 to clean
  // up crowns that were granted by the old lenient "5 wins = crown" rule.
  // ====================================================================
  if (action === 'rebuild-crowns') {
    try {
      const crownKeys = await redis.keys('v9:crown:*').catch(() => []);
      for (const k of crownKeys) await redis.del(k).catch(() => {});

      const stratKeys = await redis.keys('v9:strat:*').catch(() => []);
      const dataKeys = stratKeys.filter(k => !k.includes(':crown:') && !k.includes(':bl:'));

      const promoted = [];
      for (const key of dataKeys) {
        const d = safe(await redis.get(key).catch(() => null));
        if (!d || typeof d !== 'object') continue;
        const keyBody = key.replace('v9:strat:', '');
        const colon = keyBody.indexOf(':');
        if (colon === -1) continue;
        const inst  = normSym(keyBody.slice(0, colon));
        const strat = keyBody.slice(colon + 1);
        if (!inst || !strat) continue;

        const total = (d.wins || 0) + (d.losses || 0);
        const wr    = total > 0 ? ((d.wins || 0) / total) * 100 : 0;
        const exp   = total > 0 ? (d.totalPnl || 0) / total : 0;
        let maxCL = 0, curS = 0;
        for (const t of (d.trades || [])) {
          if (t.won === false) { curS++; if (curS > maxCL) maxCL = curS; }
          else curS = 0;
        }
        if (total >= CROWN_MIN_TRADES &&
            wr >= CROWN_MIN_WR &&
            exp >= CROWN_MIN_EXPECTANCY &&
            maxCL <= CROWN_MAX_CONSEC_LOSS) {
          const ck = 'v9:crown:' + inst;
          const existingCrown = safe(await redis.get(ck).catch(() => null));
          if (!existingCrown) {
            await redis.set(ck, JSON.stringify(strat));
            promoted.push({ instrument: inst, strategy: strat, wr: Math.round(wr), trades: total, expectancy: parseFloat(exp.toFixed(2)) });
          }
        }
      }
      console.log('[V9.4 REBUILD-CROWNS] wiped ' + crownKeys.length + ' old crowns, promoted ' + promoted.length + ' under strict rules');
      return res.status(200).json({
        ok: true,
        wipedOldCrowns: crownKeys.length,
        newCrowns: promoted,
        rules: {
          minTrades:     CROWN_MIN_TRADES,
          minWinRate:    CROWN_MIN_WR + '%',
          minExpectancy: '$' + CROWN_MIN_EXPECTANCY,
          maxConsecLoss: CROWN_MAX_CONSEC_LOSS,
        },
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ====================================================================
  // V9.4: Daily learnings log -- returns what the bot learned today.
  // ====================================================================
  if (action === 'daily-learnings') {
    const day = (req.query && req.query.date) || new Date().toISOString().slice(0, 10);
    try {
      const items = await redis.lrange('v9:learnings:' + day, 0, 199).catch(() => []);
      const parsed = (items || []).map(safe).filter(Boolean);
      return res.status(200).json({ date: day, count: parsed.length, learnings: parsed });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ====================================================================
  // GET -- return full strategy lab (V9 namespace only)
  // ====================================================================
  if (req.method === 'GET') {
    try {
      const allKeys  = await redis.keys('v9:strat:*').catch(() => []);
      const dataKeys = allKeys.filter(k => !k.includes(':crown:') && !k.includes(':bl:'));

      // Batch fetch values
      let allValues = [];
      for (let b = 0; b < dataKeys.length; b += 50) {
        const batch = dataKeys.slice(b, b + 50);
        if (!batch.length) continue;
        const bv = await redis.mget(...batch).catch(() => new Array(batch.length).fill(null));
        allValues = allValues.concat(Array.isArray(bv) ? bv : new Array(batch.length).fill(null));
      }

      // Build lab map: { [strategy]: { [instrument]: { stats } } }
      const lab = {};
      for (let i = 0; i < dataKeys.length; i++) {
        const raw = allValues[i];
        if (!raw) continue;
        const d = safe(raw);
        if (!d || typeof d !== 'object') continue;

        // Key format: v9:strat:{INSTRUMENT}:{STRATEGY}
        const keyBody = dataKeys[i].replace('v9:strat:', '');
        const colon   = keyBody.indexOf(':');
        if (colon === -1) continue;
        const rawInst = keyBody.slice(0, colon);
        const strat   = keyBody.slice(colon + 1);
        if (!rawInst || !strat || strat === 'EXPLORING' || strat === 'UNKNOWN' || strat.length < 3) continue;
        const inst = normSym(rawInst);
        if (!inst) continue;
        if (!lab[strat]) lab[strat] = {};

        const total    = (d.wins || 0) + (d.losses || 0);
        const wr       = total > 0 ? Math.round(((d.wins || 0) / total) * 100) : null;
        const recent   = (d.trades || []).slice(-BAN_LOSSES).map(t => t.won);
        const banned   = recent.length >= BAN_LOSSES && recent.every(r => r === false);

        // V9.4: Strict crown rule
        const trades   = d.trades || [];
        const totalPnl = d.totalPnl || 0;
        const expectancy = total > 0 ? totalPnl / total : 0;

        // Max consecutive loss streak in history
        let maxConsecLoss = 0, curStreak = 0;
        for (const t of trades) {
          if (t.won === false) { curStreak++; if (curStreak > maxConsecLoss) maxConsecLoss = curStreak; }
          else curStreak = 0;
        }

        const meetsCrown = total >= CROWN_MIN_TRADES &&
                           wr !== null && wr >= CROWN_MIN_WR &&
                           expectancy >= CROWN_MIN_EXPECTANCY &&
                           maxConsecLoss <= CROWN_MAX_CONSEC_LOSS;
        const crowned    = meetsCrown && !banned;
        const dethroned  = crowned && (d.postCrownLosses || 0) >= DETHRONE;
        const inconclusive = total < INCONCLUSIVE_THRESHOLD;

        // Failure analysis
        const losingTrades  = trades.filter(t => !t.won);
        const winningTrades = trades.filter(t => t.won);
        const lossSessions  = {};
        const winSessions   = {};
        losingTrades.forEach(t => {
          const s = t.session || 'UNKNOWN';
          lossSessions[s] = (lossSessions[s] || 0) + 1;
        });
        winningTrades.forEach(t => {
          const s = t.session || 'UNKNOWN';
          winSessions[s] = (winSessions[s] || 0) + 1;
        });

        // V9.4: Per-session performance + session lock
        const sessionStats = {};
        trades.forEach(t => {
          const s = t.session || 'UNKNOWN';
          if (!sessionStats[s]) sessionStats[s] = { wins: 0, losses: 0, pnl: 0, total: 0 };
          sessionStats[s].total++;
          sessionStats[s].pnl += (t.pnl || 0);
          if (t.won) sessionStats[s].wins++; else sessionStats[s].losses++;
        });
        Object.keys(sessionStats).forEach(s => {
          const ss = sessionStats[s];
          ss.wr = ss.total > 0 ? Math.round(ss.wins / ss.total * 100) : null;
          ss.expectancy = ss.total > 0 ? parseFloat((ss.pnl / ss.total).toFixed(2)) : 0;
          ss.pnl = parseFloat(ss.pnl.toFixed(2));
        });

        // Session lock: find best session with enough trades and a clear edge
        let sessionLock = null;
        const rankedSess = Object.entries(sessionStats)
          .filter(([, ss]) => ss.total >= SESSION_LOCK_MIN_TRADES_PER_SESSION && ss.wr !== null)
          .sort((a, b) => b[1].wr - a[1].wr);
        if (rankedSess.length >= 1) {
          const [bestSess, bestStats] = rankedSess[0];
          const nextWR = rankedSess[1] ? rankedSess[1][1].wr : 0;
          if (bestStats.wr - nextWR >= SESSION_LOCK_WR_EDGE_PCT && bestStats.wr >= 55) {
            sessionLock = bestSess;
          }
        }

        // Average win / loss size
        const avgWin  = winningTrades.length ? winningTrades.reduce((s,t)=>s+(t.pnl||0),0)/winningTrades.length : 0;
        const avgLoss = losingTrades.length  ? losingTrades.reduce((s,t)=>s+(t.pnl||0),0)/losingTrades.length  : 0;

        // TP hit distribution
        const tpDist = {
          tp1Only: 0, tp2Reached: 0, tp3Reached: 0, tp4Reached: 0, slHit: 0,
        };
        trades.forEach(t => {
          if (t.tp4Hit) tpDist.tp4Reached++;
          else if (t.tp3Hit) tpDist.tp3Reached++;
          else if (t.tp2Hit) tpDist.tp2Reached++;
          else if (t.tp1Hit) tpDist.tp1Only++;
          else if (!t.won)   tpDist.slHit++;
        });

        lab[strat][inst] = {
          wins:              d.wins              || 0,
          losses:            d.losses            || 0,
          total,
          winRate:           wr,
          totalPnl:          d.totalPnl != null ? parseFloat(d.totalPnl.toFixed(2)) : 0,
          avgPnl:            (d.totalPnl != null && total > 0) ? parseFloat((d.totalPnl / total).toFixed(2)) : null,
          expectancy:        parseFloat(expectancy.toFixed(2)),
          avgWin:            parseFloat(avgWin.toFixed(2)),
          avgLoss:           parseFloat(avgLoss.toFixed(2)),
          maxConsecLoss,
          crown:             crowned && !dethroned,
          banned,
          inconclusive,
          consecutiveLosses: d.consecutiveLosses || 0,
          postCrownLosses:   d.postCrownLosses   || 0,
          lastSeen:          d.lastSeen          || null,
          firstSeen:         d.firstSeen         || null,
          tpDistribution:    tpDist,
          lossSessions,
          winSessions,
          sessionStats,
          sessionLock,
          trades:            trades.slice(-15),
        };
      }

      // Crown locks
      const crownKeys = allKeys.filter(k => k.startsWith('v9:crown:'));
      const crownVals = crownKeys.length
        ? await redis.mget(...crownKeys).catch(() => new Array(crownKeys.length).fill(null))
        : [];
      const crownLocks = {};
      crownKeys.forEach((key, i) => {
        const inst = key.replace('v9:crown:', '');
        const val  = safe(crownVals[i]);
        if (val && typeof val === 'string' && val !== 'EXPLORING' && val !== 'UNKNOWN') {
          crownLocks[inst] = val;
        }
      });

      // Global blacklist
      const blacklist = safe(await redis.get('v9:blacklist').catch(() => null)) || [];

      // Build per-strategy summary with failure analysis
      const summary = {};
      for (const [strat, instData] of Object.entries(lab)) {
        const ks = Object.keys(instData);
        const tw = ks.reduce((s, k) => s + (instData[k].wins   || 0), 0);
        const tl = ks.reduce((s, k) => s + (instData[k].losses || 0), 0);
        const tt = tw + tl;

        // Aggregate failure reasons across instruments
        const aggLossSessions = {};
        const aggTpDist = { tp1Only: 0, tp2Reached: 0, tp3Reached: 0, tp4Reached: 0, slHit: 0 };
        ks.forEach(k => {
          const d = instData[k];
          Object.entries(d.lossSessions || {}).forEach(([s, c]) => {
            aggLossSessions[s] = (aggLossSessions[s] || 0) + c;
          });
          Object.entries(d.tpDistribution || {}).forEach(([k2, v]) => {
            aggTpDist[k2] = (aggTpDist[k2] || 0) + v;
          });
        });

        // Identify worst session
        const worstSession = Object.entries(aggLossSessions).sort((a, b) => b[1] - a[1])[0];

        // Failure narrative
        let failureNote = null;
        if (tl > 0) {
          const slPct = tt > 0 ? Math.round((aggTpDist.slHit / tt) * 100) : 0;
          const tp1OnlyPct = tt > 0 ? Math.round((aggTpDist.tp1Only / tt) * 100) : 0;
          const reachedTp4Pct = tt > 0 ? Math.round((aggTpDist.tp4Reached / tt) * 100) : 0;
          const parts = [];
          if (slPct >= 30) parts.push(`hits SL ${slPct}% of trades`);
          if (tp1OnlyPct >= 40) parts.push(`stalls at TP1 ${tp1OnlyPct}% of the time`);
          if (worstSession && worstSession[1] >= 3) parts.push(`weakest in ${worstSession[0]} session (${worstSession[1]} losses)`);
          if (reachedTp4Pct < 10 && tt >= 10) parts.push('rarely reaches TP4');
          failureNote = parts.length ? parts.join('; ') : null;
        }

        summary[strat] = {
          instruments:    instData,
          totalWins:      tw,
          totalLosses:    tl,
          total:          tt,
          totalPnl:       parseFloat(ks.reduce((s, k) => s + (instData[k].totalPnl || 0), 0).toFixed(2)),
          overallWinRate: tt > 0 ? Math.round((tw / tt) * 100) : null,
          crowns:         ks.filter(k => instData[k].crown).length,
          bannedOn:       ks.filter(k => instData[k].banned),
          isBlacklisted:  Array.isArray(blacklist) && blacklist.includes(strat),
          isLocked:       Object.values(crownLocks).includes(strat),
          aggLossSessions,
          aggTpDistribution: aggTpDist,
          failureNote,
        };
      }

      // Analytics
      const allT = Object.values(lab).flatMap(s => Object.values(s).flatMap(d => d.trades || []));
      const now  = new Date();
      const isTdy = (dateStr) => new Date(dateStr).toDateString() === now.toDateString();
      const cmp = (arr) => {
        const w = arr.filter(t => t.won).length;
        return {
          trades:  arr.length,
          wins:    w,
          losses:  arr.length - w,
          winRate: arr.length ? Math.round((w / arr.length) * 100) : 0,
          pnl:     parseFloat(arr.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2)),
        };
      };

      const sessAcc = {};
      allT.forEach(t => {
        const s = t.session || 'UNKNOWN';
        if (!sessAcc[s]) sessAcc[s] = { trades: 0, wins: 0, pnl: 0 };
        sessAcc[s].trades++;
        if (t.won) sessAcc[s].wins++;
        sessAcc[s].pnl += t.pnl || 0;
      });
      const sessions = {};
      Object.entries(sessAcc).forEach(([s, d]) => {
        sessions[s] = {
          ...d,
          winRate: d.trades ? Math.round((d.wins / d.trades) * 100) : 0,
          pnl:     parseFloat(d.pnl.toFixed(2)),
        };
      });

      return res.status(200).json({
        lab:             summary,
        crownLocks,
        blacklist:       Array.isArray(blacklist) ? blacklist : [],
        totalStrategies: Object.keys(summary).length,
        analytics: {
          all:      cmp(allT),
          today:    cmp(allT.filter(t => t.date && isTdy(t.date))),
          sessions,
        },
        version: 'v9',
        persistent: true,
      });

    } catch (e) {
      console.error('trades GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ====================================================================
  // POST -- record a closed trade result (V9 namespace only, no TTL)
  // ====================================================================
  if (req.method === 'POST') {
    try {
      let body = {};
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (_) { return res.status(400).json({ error: 'Invalid JSON body' }); }

      const {
        instrument, direction, won, pnl,
        strategy, session, tp1Hit, tp2Hit, tp3Hit, tp4Hit,
        confidence, closeTime, openPrice, closePrice, volume,
      } = body;

      if (!instrument || !direction || won === undefined) {
        return res.status(400).json({ error: 'Missing required fields: instrument, direction, won' });
      }

      const strat = (strategy || '').trim();
      if (!strat || strat === 'EXPLORING' || strat === 'UNKNOWN' || strat.length < 3) {
        return res.status(200).json({ skipped: true, reason: 'No valid strategy label' });
      }

      const inst = normSym(instrument);
      if (!inst) return res.status(400).json({ error: 'Invalid instrument' });

      const now = new Date().toISOString();
      const key = 'v9:strat:' + inst + ':' + strat;

      const existing = safe(await redis.get(key).catch(() => null));
      const cur = (existing && typeof existing === 'object')
        ? existing
        : { wins: 0, losses: 0, totalPnl: 0, consecutiveLosses: 0, postCrownLosses: 0, trades: [], firstSeen: now };

      const newConsec    = won ? 0 : (cur.consecutiveLosses || 0) + 1;

      // V9.4: Check crown using STRICT rules (not old "5 wins = crown")
      const newTotal  = (updated.wins || cur.wins || 0) + (updated.losses || cur.losses || 0) + 0;
      // Note: `updated` is defined below. Compute pre-update "was strictly crowned" from current state.
      const preTotal  = (cur.wins || 0) + (cur.losses || 0);
      const preWR     = preTotal > 0 ? ((cur.wins || 0) / preTotal) * 100 : 0;
      const preExp    = preTotal > 0 ? (cur.totalPnl || 0) / preTotal : 0;
      let   preMaxCL  = 0, preCurStreak = 0;
      for (const t of (cur.trades || [])) {
        if (t.won === false) { preCurStreak++; if (preCurStreak > preMaxCL) preMaxCL = preCurStreak; }
        else preCurStreak = 0;
      }
      const wasCrowned = preTotal >= CROWN_MIN_TRADES &&
                         preWR >= CROWN_MIN_WR &&
                         preExp >= CROWN_MIN_EXPECTANCY &&
                         preMaxCL <= CROWN_MAX_CONSEC_LOSS;
      const newPostCrown = wasCrowned ? (won ? 0 : (cur.postCrownLosses || 0) + 1) : 0;

      const updated = {
        wins:              won ? (cur.wins   || 0) + 1 : (cur.wins   || 0),
        losses:            won ? (cur.losses  || 0)     : (cur.losses || 0) + 1,
        totalPnl:          parseFloat(((cur.totalPnl || 0) + (pnl || 0)).toFixed(2)),
        consecutiveLosses: newConsec,
        postCrownLosses:   newPostCrown,
        lastSeen:          now,
        firstSeen:         cur.firstSeen || now,
        trades: [
          ...(cur.trades || []).slice(-99),
          {
            won,
            pnl:        pnl        || 0,
            direction:  direction  || 'UNKNOWN',
            session:    session    || 'UNKNOWN',
            tp1Hit:     !!tp1Hit,
            tp2Hit:     !!tp2Hit,
            tp3Hit:     !!tp3Hit,
            tp4Hit:     !!tp4Hit,
            confidence: confidence || 0,
            date:       closeTime  || now,
            openPrice:  openPrice  || null,
            closePrice: closePrice || null,
            volume:     volume     || 0.01,
          },
        ],
      };

      // PERSISTENT: NO TTL. Data lives forever.
      await redis.set(key, JSON.stringify(updated));

      // V9.4: Strict crown promotion check on the UPDATED stats
      const postTotal = (updated.wins || 0) + (updated.losses || 0);
      const postWR    = postTotal > 0 ? (updated.wins / postTotal) * 100 : 0;
      const postExp   = postTotal > 0 ? (updated.totalPnl || 0) / postTotal : 0;
      let   postMaxCL = 0, postCurStreak = 0;
      for (const t of (updated.trades || [])) {
        if (t.won === false) { postCurStreak++; if (postCurStreak > postMaxCL) postMaxCL = postCurStreak; }
        else postCurStreak = 0;
      }
      const meetsCrown = postTotal >= CROWN_MIN_TRADES &&
                         postWR    >= CROWN_MIN_WR &&
                         postExp   >= CROWN_MIN_EXPECTANCY &&
                         postMaxCL <= CROWN_MAX_CONSEC_LOSS;

      let justCrowned = false;
      if (!wasCrowned && meetsCrown) {
        const ck = 'v9:crown:' + inst;
        const ex = safe(await redis.get(ck).catch(() => null));
        if (!ex || ex === 'EXPLORING' || ex === 'UNKNOWN') {
          await redis.set(ck, JSON.stringify(strat));
          justCrowned = true;
          console.log('[V9.4 CROWN]', strat, 'on', inst, 'wr=' + postWR.toFixed(1) + '% trades=' + postTotal + ' exp=$' + postExp.toFixed(2));

          // Daily learnings log (daily summary will read this)
          const today = new Date().toISOString().slice(0, 10);
          await redis.lpush('v9:learnings:' + today,
            JSON.stringify({ type: 'CROWN', strategy: strat, instrument: inst, wr: Math.round(postWR), trades: postTotal, expectancy: parseFloat(postExp.toFixed(2)), ts: now })
          ).catch(() => {});
          await redis.expire('v9:learnings:' + today, 86400 * 30).catch(() => {});
        }
      }

      // Dethrone check
      let dethroned = false;
      if (wasCrowned && newPostCrown >= DETHRONE) {
        const ck     = 'v9:crown:' + inst;
        const locked = safe(await redis.get(ck).catch(() => null));
        if (locked === strat) {
          await redis.del(ck);
          dethroned = true;
          console.log('V9 DETHRONED:', strat, 'on', inst);
          const today = new Date().toISOString().slice(0, 10);
          await redis.lpush('v9:learnings:' + today,
            JSON.stringify({ type: 'DETHRONE', strategy: strat, instrument: inst, ts: now })
          ).catch(() => {});
          await redis.expire('v9:learnings:' + today, 86400 * 30).catch(() => {});
        }
      }

      // Ban on this instrument (consec losses triggered)
      let bannedNow = false;
      if (!won && newConsec >= BAN_LOSSES) {
        bannedNow = true;
        const today = new Date().toISOString().slice(0, 10);
        await redis.lpush('v9:learnings:' + today,
          JSON.stringify({ type: 'BAN', strategy: strat, instrument: inst, consecLosses: newConsec, ts: now })
        ).catch(() => {});
        await redis.expire('v9:learnings:' + today, 86400 * 30).catch(() => {});
      }

      // Blacklist check
      let blacklisted = false;
      if (!won && newConsec >= BAN_LOSSES) {
        const peerKeys  = await redis.keys('v9:strat:*:' + strat).catch(() => []);
        const otherKeys = peerKeys.filter(k => normSym(k.replace('v9:strat:', '').split(':')[0]) !== inst);
        if (otherKeys.length >= BLACKLIST_PEERS) {
          const peerVals = await redis.mget(...otherKeys).catch(() => []);
          const allBanned = peerVals.every(r => {
            const d = safe(r);
            return d && typeof d === 'object' && (d.consecutiveLosses || 0) >= BAN_LOSSES;
          });
          if (allBanned) {
            const blRaw = safe(await redis.get('v9:blacklist').catch(() => null));
            const bl    = Array.isArray(blRaw) ? blRaw : [];
            if (!bl.includes(strat)) {
              bl.push(strat);
              await redis.set('v9:blacklist', JSON.stringify(bl));
              blacklisted = true;
              console.log('V9 BLACKLISTED:', strat);
              const today = new Date().toISOString().slice(0, 10);
              await redis.lpush('v9:learnings:' + today,
                JSON.stringify({ type: 'BLACKLIST', strategy: strat, ts: now })
              ).catch(() => {});
              await redis.expire('v9:learnings:' + today, 86400 * 30).catch(() => {});
            }
          }
        }
      }

      const total = updated.wins + updated.losses;
      return res.status(200).json({
        success:    true,
        strategy:   strat,
        instrument: inst,
        result:     won ? 'WIN' : 'LOSS',
        stats: {
          wins:    updated.wins,
          losses:  updated.losses,
          total,
          winRate: total ? Math.round((updated.wins / total) * 100) : null,
          consecutiveLosses: newConsec,
          totalPnl: updated.totalPnl,
        },
        justCrowned,
        dethroned,
        blacklisted,
      });

    } catch (e) {
      console.error('trades POST error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};