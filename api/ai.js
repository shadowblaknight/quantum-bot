/* eslint-disable */
// api/ai.js — V8 Brain — Read First, Label After. Crown-aware dual mode.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};

    if (body.prompt && !body.marketSnapshot) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY||'', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: body.prompt }] }),
      });
      const d = await r.json();
      return res.status(200).json({ analysis: d.content?.map(b=>b.text||'').join('')||'' });
    }

    const { marketSnapshot: snap, instrument, previousDecisions, learnedPatterns, blacklistedStrategies, crownedStrategy } = body;
    if (!snap || !instrument) return res.status(400).json({ error: 'Missing marketSnapshot' });

    const balance  = Number(snap.account_balance) || 10000;
    const lossStrk = Number(snap.inst_loss_streak ?? snap.loss_streak) || 0;
    const winStrk  = Number(snap.inst_win_streak  ?? snap.win_streak)  || 0;
    const atr      = parseFloat(snap.atr14) || (instrument==='XAUUSD'?15:instrument==='BTCUSDT'?300:0.0012);

    // Per-instrument risk profiles
    const RISK = {
      XAUUSD:  { riskPct:0.01, pipVal:100, minSL:10, maxSL:40,  maxLot:0.50, slMult:1.5, tp1Mult:2.0, tp2Mult:3.5, tp3Mult:5.5, tp1Pct:50, tp2Pct:30, tp3Pct:20 },
      BTCUSDT: { riskPct:0.005,pipVal:1,   minSL:200,maxSL:1200,maxLot:0.30, slMult:2.0, tp1Mult:1.8, tp2Mult:3.5, tp3Mult:6.0, tp1Pct:50, tp2Pct:30, tp3Pct:20 },
      GBPUSD:  { riskPct:0.01, pipVal:10,  minSL:8,  maxSL:35,  maxLot:2.00, slMult:1.2, tp1Mult:1.8, tp2Mult:3.0, tp3Mult:5.0, tp1Pct:50, tp2Pct:30, tp3Pct:20 },
    };
    const R = RISK[instrument] || RISK.XAUUSD;

    // ATR-based SL/TP
    const slPips  = Math.max(R.minSL, Math.min(R.maxSL, Math.round(atr * R.slMult)));
    const tp1Pips = Math.round(slPips * R.tp1Mult);
    const tp2Pips = Math.round(slPips * R.tp2Mult);
    const tp3Pips = Math.round(slPips * R.tp3Mult);

    // Lot sizing
    const riskDollar = balance * R.riskPct;
    const rawBaseLot = riskDollar / (slPips * R.pipVal);
    const baseLot    = Math.max(0.01, Math.min(R.maxLot, Math.round(rawBaseLot/0.01)*0.01));

    const winScale  = winStrk>=10?3.0:winStrk>=7?2.5:winStrk>=5?2.0:winStrk>=4?1.75:winStrk>=3?1.5:winStrk>=2?1.25:1.0;
    const lossScale = lossStrk>=4?0.25:lossStrk>=3?0.5:lossStrk>=2?0.75:1.0;
    const fullVol   = Math.max(0.01, Math.min(R.maxLot, Math.round((baseLot*winScale*lossScale)/0.01)*0.01));

    // Learned context
    const goodPatterns = learnedPatterns
      ? Object.entries(learnedPatterns)
          .filter(([k,d])=>d.instruments?.[instrument]?.winRate>=60&&d.instruments?.[instrument]?.total>=3&&!d.instruments?.[instrument]?.banned)
          .sort((a,b)=>(b[1].instruments?.[instrument]?.winRate||0)-(a[1].instruments?.[instrument]?.winRate||0))
          .slice(0,5) : [];
    const badPatterns = learnedPatterns
      ? Object.entries(learnedPatterns)
          .filter(([k,d])=>d.instruments?.[instrument]?.banned||(blacklistedStrategies||[]).includes(k)) : [];

    const learnedCtx = goodPatterns.length>0||badPatterns.length>0
      ? '\nWHAT I LEARNED FOR ' + instrument + ':\n' +
        (goodPatterns.length>0 ? 'Proven winners:\n' + goodPatterns.map(([k,d])=>'  WIN: '+k+' '+d.instruments[instrument].winRate+'% ('+d.instruments[instrument].total+' trades)').join('\n') + '\n' : '') +
        (badPatterns.length>0  ? 'Banned (never use):\n' + badPatterns.map(([k])=>'  BAN: '+k).join('\n') + '\n' : '')
      : '\nNo learned patterns yet for ' + instrument + '. Explore freely.\n';

    const prevCtx = previousDecisions?.length>0
      ? '\nRECENT DECISIONS:\n' + previousDecisions.map((d,i)=>
          '  '+(d.decision||'?')+' @ '+(d.price||'?')+' -> '+(d.outcome||'open')+
          (d.pnl!=null?' $'+(d.pnl>0?'+':'')+d.pnl.toFixed(2):'')+
          ' ['+(d.strategy||'?')+'] - '+(d.reason||'')
        ).join('\n') : '';

    const instChar = {
      XAUUSD:  'Gold: $5-150/session. 1pip=$1/0.01lot. Round $10 levels matter. USD+geopolitics sensitive. Best: London 07-10 UTC and NY 13-16 UTC.',
      BTCUSDT: 'BTC: $200-3000/day. 24/7. Round $1000 levels matter. Trend-following dominates. Best: NY session and high-volume hours.',
      GBPUSD:  'GBP/USD: 50-150pips/day. 1pip=$10/lot. BOE/Fed sensitive. Best: London open 07-10 UTC and NY open 13-16 UTC.',
    };

    const slTpGuide = 'SL/TP FOR ' + instrument + ': SL=' + slPips + 'p  TP1=' + tp1Pips + 'p(close 50%)  TP2=' + tp2Pips + 'p(close 30%)  TP3=' + tp3Pips + 'p(let 20% run)  Vol=' + fullVol + 'L';

    const sizingGuide = 'SIZING FOR ' + instrument + ' (live calculation):\n' +
      'Risk/trade: $' + riskDollar.toFixed(2) + ' | Win streak ' + winStrk + ' x' + winScale + ' | Loss streak ' + lossStrk + ' x' + lossScale + '\n' +
      'Confidence 35-49: 0.01 lots (micro - learning)\n' +
      'Confidence 50-64: ' + Math.max(0.01,Math.round(fullVol*0.5/0.01)*0.01) + ' lots\n' +
      'Confidence 65-79: ' + fullVol + ' lots\n' +
      'Confidence 80-100: ' + Math.min(R.maxLot,Math.round(fullVol*1.25/0.01)*0.01) + ' lots\n' +
      'Max: ' + R.maxLot + ' lots. NEVER null when confidence>=35 and LONG/SHORT.';

    const jsonSchema = '{\n  "decision": "LONG or SHORT or WAIT",\n  "confidence": 0-100,\n  "entry": price or null,\n  "stopLoss": price or null,\n  "takeProfit1": price or null,\n  "takeProfit2": price or null,\n  "takeProfit3": price or null,\n  "volume": lots,\n  "strategy": "TACTIC1+TACTIC2 from the label list",\n  "reason": "what you see and why",\n  "risk": "LOW or MEDIUM or HIGH",\n  "slPips": number,\n  "rrRatio": number\n}';

    const crownMode = !!crownedStrategy;

    // ── CROWN MODE system prompt ──
    const crownPrompt = 'You are executing the CROWNED STRATEGY for ' + instrument + '.\n' +
      'Crowned = proven through 5+ real wins. Your ONLY job: find this exact setup and execute it.\n\n' +
      (instChar[instrument]||'') + '\n\n' +
      'CROWNED STRATEGY: ' + crownedStrategy + '\n\n' +
      'Parse each tactic and apply its logic:\n' +
      'ICT_KILLZONE=only trade 07-10 or 13-16 UTC\n' +
      'ICT_SWEEP=price swept asian H/L or PDH/PDL then returned\n' +
      'ICT_FVG=smc_fvg zone exists and price inside or near it\n' +
      'ICT_PDH_PDL=price reacting to pdh/pdl levels\n' +
      'ICT_ASIAN_RANGE=asian range broken, trade continuation\n' +
      'TREND_H4=candles_h4 shows clear direction, trade with it\n' +
      'TREND_EMA_ALIGN=ema_alignment is BULLISH_STACK or BEARISH_STACK\n' +
      'TREND_BREAKOUT_RETEST=smc_bos confirmed, price retesting broken level\n' +
      'TREND_MA_BOUNCE=price pulled back to ema21 or ema50, bouncing\n' +
      'MOM_SESSION_OPEN=first move at London/NY open, enter first pullback\n' +
      'MOM_MACD_CROSS=macd histogram flipped direction\n' +
      'MOM_RSI_DIVERGENCE=rsi14 diverging from price action\n' +
      'MR_ROUND_NUMBER=round_levels reaction\n' +
      'MR_BB_SQUEEZE=bbands SQUEEZE detected, enter breakout\n' +
      'MR_RANGE_TRADING=clear range on h1/h4, trade within it\n' +
      'PA_ENGULFING=strong engulfing candle at key level\n' +
      'PA_REJECTION_WICK=long rejection wick at structure\n' +
      'PA_INSIDE_BAR=inside bar breakout on h1/h4\n' +
      'PA_DOUBLE_TOP_BOT=double top/bottom reversal on h1/h4\n' +
      'SMC_ORDER_BLOCK=smc_order_block zone, enter at it\n' +
      'SMC_BOS_RETEST=smc_bos confirmed, retest entry\n' +
      'SMC_CHOCH=change of character on m15/h1\n\n' +
      '70%+ tactics present = TRADE full size\n' +
      '50-70% present = TRADE half size\n' +
      '<50% present = WAIT\n\n' +
      'WAIT only if: setup absent, news in <15min, position already open, daily -5% hit.\n' +
      'Dethrone warning: 3 consecutive losses after crown = dethroned. Do NOT force weak entries.\n\n' +
      slTpGuide + '\n' + sizingGuide + '\n' + learnedCtx + prevCtx + '\n\nRESPOND JSON ONLY:\n' + jsonSchema;

    // ── EXPLORE MODE system prompt ──
    const explorePrompt = 'You are a professional trader with 15 years experience trading ' + instrument + '.\n' +
      'Look at the market. Make a decision. Execute it.\n\n' +
      (instChar[instrument]||'') + '\n\n' +
      'YOU ARE BIASED TOWARD TRADING.\n' +
      'WAIT only when: dead Asian hours (00:00-06:30 UTC) with no catalyst, position already open, daily -5% hit, high-impact news in <15min, or pure noise.\n' +
      'Everything else = find a trade. A 40% confidence trade at 0.01 lots is better than WAIT.\n\n' +
      'TOOLS AVAILABLE:\n' +
      '7 timeframes (W1 to M1), ATR, RSI, EMA 21/50/200, MACD, Bollinger,\n' +
      'Asian range, PDH/PDL, liquidity sweep, FVG, Order Blocks, BOS,\n' +
      'Fibonacci, equilibrium zone, session timing, news.\n' +
      'One clear signal = small size. Two signals = normal. Three+ = full size.\n\n' +
      'STRATEGY LABELS (use AFTER deciding):\n' +
      'ICT_KILLZONE ICT_SWEEP ICT_FVG ICT_PDH_PDL ICT_ASIAN_RANGE\n' +
      'TREND_H4 TREND_EMA_ALIGN TREND_BREAKOUT_RETEST TREND_MA_BOUNCE\n' +
      'MOM_SESSION_OPEN MOM_MACD_CROSS MOM_RSI_DIVERGENCE\n' +
      'MR_ROUND_NUMBER MR_BB_SQUEEZE MR_RANGE_TRADING\n' +
      'PA_ENGULFING PA_REJECTION_WICK PA_INSIDE_BAR PA_DOUBLE_TOP_BOT\n' +
      'SMC_ORDER_BLOCK SMC_BOS_RETEST SMC_CHOCH\n' +
      'Join with +. Example: ICT_FVG+TREND_H4\n\n' +
      slTpGuide + '\n' + sizingGuide + '\n' + learnedCtx + prevCtx + '\n\nRESPOND JSON ONLY:\n' + jsonSchema;

    const systemPrompt = crownMode ? crownPrompt : explorePrompt;

    const userPrompt = instrument + ' - what do you see?\n\n' +
      'PRICE: ' + snap.price + '  UTC: ' + snap.utc_hour + ':xx  SESSION: ' + snap.session + '\n' +
      (snap.in_kill_zone ? 'IN KILL ZONE: ' + snap.kill_zone + '\n' : 'Outside kill zone\n') +
      (crownMode ? 'CROWN MODE: executing ' + crownedStrategy + '\n' : 'EXPLORE MODE: find best combination\n') +
      '\nCANDLES:\n' +
      'W:   ' + (snap.candles_weekly||'no data') + '\n' +
      'D1:  ' + (snap.candles_d1||'no data') + '\n' +
      'H4:  ' + (snap.candles_h4||'no data') + '\n' +
      'H1:  ' + (snap.candles_h1||'no data') + '\n' +
      'M15: ' + (snap.candles_m15||'no data') + '\n' +
      'M5:  ' + (snap.candles_m5||'no data') + '\n' +
      'M1:  ' + (snap.candles_m1||'no data') + '\n' +
      '\nKEY LEVELS:\n' +
      'Asian H/L: ' + (snap.asian_high||'-') + ' / ' + (snap.asian_low||'-') + '  range ' + (snap.asian_range_pips||'-') + 'p\n' +
      'PDH/PDL: ' + (snap.pdh||'-') + ' / ' + (snap.pdl||'-') + '\n' +
      'Sweep: ' + (snap.liquidity_sweep||'none') + '  dir: ' + (snap.sweep_direction||'NONE') + '\n' +
      'Round levels: ' + (snap.round_levels||'-') + '\n' +
      '\nINDICATORS:\n' +
      'RSI: ' + (snap.rsi14||'-') + '\n' +
      'EMA stack: 21=' + (snap.ema21||'-') + ' 50=' + (snap.ema50||'-') + ' 200=' + (snap.ema200||'-') + ' -> ' + (snap.ema_alignment||'-') + '\n' +
      'MACD: ' + (snap.macd||'-') + '\n' +
      'BB: ' + (snap.bbands||'-') + '\n' +
      'ATR: ' + (snap.atr14||'-') + '\n' +
      '\nSTRUCTURE:\n' +
      'BOS: ' + (snap.smc_bos||'none') + '\n' +
      'FVG: ' + (snap.smc_fvg||'none') + '\n' +
      'OB: ' + (snap.smc_order_block||'none') + '\n' +
      'Fib: ' + (snap.fib_nearest||'-') + '\n' +
      'Equilibrium: ' + (snap.equilibrium_zone||'-') + '  Weekly bias: ' + (snap.weekly_bias||'-') + '\n' +
      '\nACCOUNT:\n' +
      'Balance: $' + balance.toFixed(2) + '  Today P&L: $' + (snap.today_pnl||0) + '\n' +
      'Loss streak: ' + lossStrk + '  Win streak: ' + winStrk + '  Win rate: ' + (snap.overall_win_rate||0) + '%\n' +
      'Longs: ' + (snap.today_long_results||'none') + '\n' +
      'Shorts: ' + (snap.today_short_results||'none') + '\n' +
      'Open: ' + (snap.open_positions?.length||0) + '\n' +
      '\nNEWS: ' + (snap.news?.map(n=>n.title).join(' | ')||'none') + '\n' +
      'EVENTS: ' + (snap.calendar_events?.length>0?snap.calendar_events.map(e=>e.name).join(', '):'none') + '\n' +
      '\nJSON only.';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY||'', 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role:'user', content:userPrompt }],
      }),
    });

    const data = await response.json();
    const raw  = data.content?.map(b=>b.text||'').join('')||'';

    let dec;
    try { dec = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    catch(e) { return res.status(200).json({ decision:'WAIT', reason:'Parse error: '+e.message, raw:raw.slice(0,200) }); }

    if (!['LONG','SHORT','WAIT'].includes(dec.decision)) dec.decision = 'WAIT';

    // Enforce volume by confidence
    if (dec.decision !== 'WAIT') {
      const conf = dec.confidence||0;
      if (conf < 35) {
        dec.decision = 'WAIT';
        dec.reason   = 'Confidence ' + conf + '% below 35% minimum';
        dec.volume   = null;
      } else {
        dec.volume =
          conf>=80 ? Math.min(R.maxLot, Math.round(fullVol*1.25/0.01)*0.01) :
          conf>=65 ? fullVol :
          conf>=50 ? Math.max(0.01, Math.round(fullVol*0.5/0.01)*0.01) : 0.01;
      }
    }

    // RR gate
    if (dec.decision !== 'WAIT' && dec.stopLoss && dec.takeProfit1) {
      const slD  = Math.abs((dec.entry||snap.price) - dec.stopLoss);
      const tp1D = Math.abs(dec.takeProfit1 - (dec.entry||snap.price));
      const minRR = instrument==='BTCUSDT' ? 0.8 : 1.0;
      if (slD > 0 && tp1D/slD < minRR) {
        dec.decision = 'WAIT';
        dec.reason   = 'RR ' + (tp1D/slD).toFixed(2) + ':1 below ' + minRR + ':1 minimum';
        dec.volume   = null;
      }
    }

    // ATR gate
    if (dec.decision !== 'WAIT' && dec.stopLoss) {
      const slD    = Math.abs((dec.entry||snap.price) - dec.stopLoss);
      const minATR = instrument==='XAUUSD'?0.6:instrument==='BTCUSDT'?0.4:0.5;
      if (slD < atr * minATR) {
        dec.decision = 'WAIT';
        dec.reason   = 'SL ' + slD.toFixed(instrument==='BTCUSDT'?0:2) + ' below ' + minATR + 'xATR minimum - will be hunted';
        dec.volume   = null;
      }
    }

    console.log(JSON.stringify({
      instrument, mode: crownMode?'CROWN':'EXPLORE',
      decision:dec.decision, confidence:dec.confidence,
      volume:dec.volume, strategy:dec.strategy,
      slPips:dec.slPips, rrRatio:dec.rrRatio,
      reason:(dec.reason||'').slice(0,100),
    }));

    return res.status(200).json(dec);

  } catch(e) {
    console.error('Brain error:', e);
    return res.status(500).json({ error: e.message });
  }
};