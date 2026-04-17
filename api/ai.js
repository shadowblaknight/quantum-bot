/* eslint-disable */
// api/ai.js -- V8.2.0 Brain
// Session-gating is enforced here (backend is source of truth).
// Instrument categories are detected dynamically -- no hardcoded symbol names.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};

    // Manual prompt mode (Brain page)
    if (body.prompt && !body.snap) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: body.prompt }],
        }),
      });
      const d = await r.json();
      return res.status(200).json({ text: d.content?.map(b => b.text || '').join('') || '' });
    }

    const { snap, instrument, riskMode, prevDecisions, lab, crownLocks, blacklist } = body;
    if (!snap || !instrument) return res.status(400).json({ error: 'Missing snap or instrument' });

    // ---------------------------------------------------------------------------
    // Instrument category detection -- dynamic, no hardcoded symbol names
    // ---------------------------------------------------------------------------
    const sym = (instrument || '').toUpperCase().replace('.S', '').replace('.PRO', '').trim();

    const isGoldInstrument = sym.includes('XAU') || sym.includes('GOLD');
    const isCryptoInstrument = sym.includes('BTC') || sym.includes('ETH') || sym.includes('CRYPTO') || sym.includes('COIN');
    const isForexInstrument = !isGoldInstrument && !isCryptoInstrument;

    // Category string for prompts and TP selection
    const category = isGoldInstrument ? 'GOLD' : isCryptoInstrument ? 'CRYPTO' : 'FOREX';

    // ---------------------------------------------------------------------------
    // Session gate -- backend enforces this. Frontend is advisory only.
    // ---------------------------------------------------------------------------
    const now = new Date();
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
    const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;

    if (isWeekend && !isCryptoInstrument) {
      return res.status(200).json({
        decision: 'WAIT',
        reason: 'Weekend -- forex and gold markets are closed.',
        confidence: 0,
        volume: null,
      });
    }

    if (isCryptoInstrument && (utcH < 7 || utcH >= 23)) {
      return res.status(200).json({
        decision: 'WAIT',
        reason: 'Outside crypto active hours (07:00-23:00 UTC).',
        confidence: 0,
        volume: null,
      });
    }

    if (!isCryptoInstrument && (utcH < 8 || utcH >= 21)) {
      return res.status(200).json({
        decision: 'WAIT',
        reason: 'Outside trading hours (08:00-21:00 UTC) for ' + category + '.',
        confidence: 0,
        volume: null,
      });
    }

    // ---------------------------------------------------------------------------
    // ATR fallback by category
    // ---------------------------------------------------------------------------
    const atrFallback = isGoldInstrument ? 12 : isCryptoInstrument ? 300 : 0.0008;
    const atr = parseFloat(snap.atr14) || atrFallback;

    const balance  = Number(snap.balance)   || 10000;
    const lossStrk = Number(snap.lossStreak) || 0;
    const winStrk  = Number(snap.winStreak)  || 0;

    // ---------------------------------------------------------------------------
    // Risk-based sizing
    // ---------------------------------------------------------------------------
    const RISK = {
      TEST:       { pct: 0.005, maxLot: 0.05 },
      REGULAR:    { pct: 0.01,  maxLot: 0.20 },
      AGGRESSIVE: { pct: 0.02,  maxLot: 0.50 },
    };
    const risk = RISK[riskMode || 'TEST'] || RISK.TEST;
    const baseVol = Math.max(0.01, Math.min(risk.maxLot,
      parseFloat(((balance * risk.pct) / (atr * 100)).toFixed(2))));
    const lossAdj = lossStrk >= 4 ? 0.25 : lossStrk >= 3 ? 0.5 : lossStrk >= 2 ? 0.75 : 1.0;
    const winAdj  = winStrk  >= 5 ? 2.0  : winStrk  >= 3 ? 1.5 : winStrk  >= 2 ? 1.25 : 1.0;
    const fullVol = Math.max(0.01, Math.min(risk.maxLot, parseFloat((baseVol * lossAdj * winAdj).toFixed(2))));

    // ---------------------------------------------------------------------------
    // TP/SL configuration by category -- not by hardcoded symbol
    // ---------------------------------------------------------------------------
    let tp;
    if (isGoldInstrument) {
      // Gold special mode: fixed pip distances
      tp = { tp1: 5, tp2: 10, tp3: 15, tp4: 20, sl: 10, isGold: true };
    } else if (isCryptoInstrument) {
      // Crypto: ATR-based distances
      tp = {
        tp1: Math.round(atr * 0.5),
        tp2: Math.round(atr * 1.0),
        tp3: Math.round(atr * 1.5),
        tp4: Math.round(atr * 2.0),
        sl:  Math.round(atr * 0.8),
        isGold: false,
      };
    } else {
      // Forex: ATR-based pip distances (in price units)
      tp = {
        tp1: parseFloat((atr * 0.5).toFixed(5)),
        tp2: parseFloat((atr * 1.0).toFixed(5)),
        tp3: parseFloat((atr * 1.5).toFixed(5)),
        tp4: parseFloat((atr * 2.0).toFixed(5)),
        sl:  parseFloat((atr * 0.8).toFixed(5)),
        isGold: false,
      };
    }

    // ---------------------------------------------------------------------------
    // Learned context from strategy lab
    // ---------------------------------------------------------------------------
    const instLab = lab
      ? Object.entries(lab)
          .filter(([, d]) => d.instruments && d.instruments[instrument])
          .map(([strat, d]) => ({ strat, ...d.instruments[instrument] }))
      : [];

    const proven = instLab.filter(s => s.crown).sort((a, b) => (b.winRate || 0) - (a.winRate || 0)).slice(0, 3);
    const banned = instLab.filter(s => s.banned).map(s => s.strat);
    const blList = Array.isArray(blacklist) ? blacklist : [];
    const crown  = crownLocks && crownLocks[instrument] ? crownLocks[instrument] : null;

    const provenLines = proven.length
      ? 'Proven winners:\n' + proven.map(s => '  ' + s.strat + ': ' + s.winRate + '% WR, ' + s.total + ' trades').join('\n')
      : 'No proven strategies yet -- explore freely.';

    const bannedLines = banned.length
      ? 'Banned on ' + instrument + ':\n' + banned.map(s => '  ' + s).join('\n')
      : '';

    const blLines = blList.length
      ? 'Globally blacklisted:\n' + blList.map(s => '  ' + s).join('\n')
      : '';

    const crownLine = crown
      ? 'CROWN STRATEGY ACTIVE: Prefer "' + crown + '" if market supports it.'
      : 'No crown lock -- explore freely.';

    const learnedCtx = [
      'WHAT I KNOW FOR ' + instrument + ':',
      provenLines,
      bannedLines,
      blLines,
      crownLine,
    ].filter(Boolean).join('\n');

    const prevCtx = (prevDecisions && prevDecisions.length)
      ? '\nRECENT DECISIONS:\n' + prevDecisions.slice(-3).map(d =>
          '  ' + d.decision + ' @ ' + d.price + ' [' + (d.strategy || '?') + '] -> ' +
          (d.outcome || 'open') +
          (d.pnl != null ? ' $' + (d.pnl > 0 ? '+' : '') + d.pnl.toFixed(2) : '')
        ).join('\n')
      : '';

    // Instrument description by category
    const catDescriptions = {
      GOLD:   'Gold: $5-150/session. Round $10 price levels act as magnets. Best: 08-10 UTC (London) and 13-16 UTC (NY overlap).',
      CRYPTO: 'Crypto: High volatility, $200-3000/day moves common. 24/7 but best liquidity 09-22 UTC. Round thousand levels matter. Trend-following dominates.',
      FOREX:  'Forex pair: 50-150 pips/day typical. Best: 08-10 UTC (London open) and 13-16 UTC (NY open). Follow USD strength/weakness.',
    };
    const instDescription = catDescriptions[category] || 'Unknown instrument type. Analyze structure and use conservative sizing.';

    const tpSection = isGoldInstrument
      ? 'GOLD TP SYSTEM (FIXED PIPS):\nSL: ' + tp.sl + ' pips from entry\nTP1: +' + tp.tp1 + ' pips -> close 40%, SL to BE\nTP2: +' + tp.tp2 + ' pips -> close 30%, SL to TP1\nTP3: +' + tp.tp3 + ' pips -> close 20%, SL to TP2\nTP4: +' + tp.tp4 + ' pips -> close final 10%'
      : 'TP SYSTEM (' + category + '):\nSL: ' + tp.sl + ' minimum\nTP1: +' + tp.tp1 + ' -> close 40%, SL to BE\nTP2: +' + tp.tp2 + ' -> close 30%, SL to TP1\nTP3: +' + tp.tp3 + ' -> close 20%, SL to TP2\nTP4: +' + tp.tp4 + ' -> close final 10%';

    const sizingSmall  = Math.max(0.01, parseFloat((fullVol * 0.5).toFixed(2)));
    const sizingLarge  = Math.min(risk.maxLot, parseFloat((fullVol * 1.5).toFixed(2)));

    const sysPrompt = 'You are a professional trader executing for Quantum Bot V8.2.0.\n' +
      'Instrument: ' + instrument + ' (category: ' + category + '). ' + instDescription + '\n\n' +
      'YOUR JOB: Read the market. Make a call. Execute it.\n\n' +
      'TRADE BIAS: You are biased TOWARD TRADING.\n' +
      'WAIT only when:\n' +
      '1. Pure consolidation noise -- no readable structure\n' +
      '2. High-impact news in next 15 minutes\n' +
      '3. Already have an open position on this instrument\n\n' +
      '"Not perfect" is NOT a reason to wait.\n' +
      'A trade at 40% confidence with tiny size is better than no trade.\n\n' +
      'SIZING (' + (riskMode || 'TEST') + ' mode):\n' +
      'confidence 35-49 -> 0.01 lots (learning trade)\n' +
      'confidence 50-64 -> ' + sizingSmall + ' lots\n' +
      'confidence 65-79 -> ' + fullVol + ' lots\n' +
      'confidence 80+   -> ' + sizingLarge + ' lots\n\n' +
      tpSection + '\n\n' +
      'STRATEGY LABELS (label AFTER deciding, join with +):\n' +
      'ICT: ICT_KILLZONE, ICT_SWEEP, ICT_FVG, ICT_PDH_PDL, ICT_ASIAN_RANGE\n' +
      'TREND: TREND_H4, TREND_EMA_ALIGN, TREND_BREAKOUT, TREND_MA_BOUNCE\n' +
      'MOMENTUM: MOM_SESSION, MOM_MACD, MOM_RSI_DIV\n' +
      'MEAN_REV: MR_ROUND, MR_BB_SQUEEZE, MR_RANGE\n' +
      'PRICE_ACTION: PA_ENGULFING, PA_REJECTION, PA_INSIDE_BAR\n' +
      'SMC: SMC_OB, SMC_BOS, SMC_CHOCH\n' +
      'Example: ICT_FVG+TREND_H4\n\n' +
      learnedCtx + prevCtx + '\n\n' +
      'RESPOND WITH VALID JSON ONLY. No markdown fences. No explanation outside the JSON object.\n' +
      '{\n' +
      '  "decision": "LONG" or "SHORT" or "WAIT",\n' +
      '  "confidence": 0-100,\n' +
      '  "entry": price or null,\n' +
      '  "stopLoss": price or null,\n' +
      '  "takeProfit1": price or null,\n' +
      '  "takeProfit2": price or null,\n' +
      '  "takeProfit3": price or null,\n' +
      '  "takeProfit4": price or null,\n' +
      '  "volume": lots (never null if confidence >= 35 and decision is LONG or SHORT),\n' +
      '  "strategy": "TACTIC1+TACTIC2",\n' +
      '  "reason": "2-3 sentences describing what you see and why",\n' +
      '  "risk": "LOW" or "MEDIUM" or "HIGH"\n' +
      '}';

    const utcTimeStr = now.getUTCHours() + ':' + String(now.getUTCMinutes()).padStart(2, '0');
    const killZoneStr = snap.inKillZone ? ('IN KILL ZONE: ' + (snap.killZone || '')) : 'Outside kill zone';

    const userPrompt = instrument + ' -- what do you see?\n\n' +
      'PRICE: ' + snap.price + ' | UTC: ' + utcTimeStr + ' | SESSION: ' + (snap.session || 'UNKNOWN') + '\n' +
      killZoneStr + '\n\n' +
      'CANDLES:\n' +
      'W:   ' + (snap.weekly || 'no data') + '\n' +
      'D1:  ' + (snap.d1    || 'no data') + '\n' +
      'H4:  ' + (snap.h4    || 'no data') + '\n' +
      'H1:  ' + (snap.h1    || 'no data') + '\n' +
      'M15: ' + (snap.m15   || 'no data') + '\n' +
      'M5:  ' + (snap.m5    || 'no data') + '\n' +
      'M1:  ' + (snap.m1    || 'no data') + '\n\n' +
      'KEY LEVELS:\n' +
      'Asian H/L: ' + (snap.asianHigh || 'n/a') + ' / ' + (snap.asianLow || 'n/a') + '\n' +
      'PDH/PDL:   ' + (snap.pdh || 'n/a') + ' / ' + (snap.pdl || 'n/a') + '\n' +
      'Sweep:     ' + (snap.sweep || 'none') + ' -> ' + (snap.sweepDir || 'NONE') + '\n' +
      'Round:     ' + (snap.roundLevels || 'n/a') + '\n\n' +
      'INDICATORS:\n' +
      'RSI: ' + (snap.rsi || 'n/a') + ' | EMA: 21=' + (snap.ema21 || 'n/a') + ' 50=' + (snap.ema50 || 'n/a') + ' 200=' + (snap.ema200 || 'n/a') + ' stack=' + (snap.emaStack || 'n/a') + '\n' +
      'MACD: ' + (snap.macd || 'n/a') + ' | BB: ' + (snap.bb || 'n/a') + '\n' +
      'ATR: ' + snap.atr14 + ' -> ' + (snap.atrGuide || '') + '\n\n' +
      'STRUCTURE:\n' +
      'BOS: ' + (snap.bos || 'none') + ' | FVG: ' + (snap.fvg || 'none') + ' | OB: ' + (snap.ob || 'none') + '\n' +
      'Fib: ' + (snap.fibNearest || 'n/a') + ' | Weekly bias: ' + (snap.weeklyBias || 'n/a') + '\n\n' +
      'ACCOUNT:\n' +
      'Balance: $' + balance.toFixed(2) + ' | P&L today: $' + (snap.todayPnl || '0.00') + '\n' +
      'Loss streak: ' + lossStrk + ' | Win streak: ' + winStrk + '\n' +
      'Open positions: ' + (snap.openCount || 0) + '\n\n' +
      'NEWS: ' + ((snap.news && snap.news.length) ? snap.news.slice(0, 2).map(n => n.title || '').join(' | ') : 'none') + '\n\n' +
      'Make your call. JSON only.';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: sysPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await resp.json();
    const raw  = (data.content || []).map(b => b.text || '').join('');

    let dec;
    try {
      // Strip any markdown fences Claude might add despite instructions
      const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      dec = JSON.parse(cleaned);
    } catch (e) {
      return res.status(200).json({
        decision: 'WAIT',
        reason: 'Response parse error: ' + e.message,
        confidence: 0,
        volume: null,
        raw: raw.slice(0, 200),
      });
    }

    if (!['LONG', 'SHORT', 'WAIT'].includes(dec.decision)) dec.decision = 'WAIT';

    // Enforce volume by confidence
    if (dec.decision !== 'WAIT') {
      const c = dec.confidence || 0;
      if (c < 35) {
        dec.decision = 'WAIT';
        dec.reason = 'Confidence ' + c + '% is below the 35% minimum threshold.';
        dec.volume = null;
      } else {
        dec.volume = c >= 80 ? sizingLarge
                   : c >= 65 ? fullVol
                   : c >= 50 ? sizingSmall
                   : 0.01;
      }
    }

    // Blacklist gate
    if (dec.decision !== 'WAIT' && dec.strategy && blList.includes(dec.strategy)) {
      dec.decision = 'WAIT';
      dec.reason   = 'Strategy "' + dec.strategy + '" is globally blacklisted.';
      dec.volume   = null;
    }

    console.log(JSON.stringify({
      instrument,
      category,
      decision:   dec.decision,
      confidence: dec.confidence,
      strategy:   dec.strategy,
      volume:     dec.volume,
    }));

    return res.status(200).json(dec);

  } catch (e) {
    console.error('AI error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};