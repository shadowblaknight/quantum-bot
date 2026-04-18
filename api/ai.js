/* eslint-disable */
// api/ai.js -- Quantum Bot V9 Brain
// Session gating + ForexFactory news blocking + V9 lab integration

const FF_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

// In-memory cache for FF calendar (per cold-start)
let _ffCache = { data: null, ts: 0 };
const FF_TTL_MS = 30 * 60 * 1000; // refresh every 30 minutes

const fetchFFCalendar = async () => {
  const now = Date.now();
  if (_ffCache.data && (now - _ffCache.ts) < FF_TTL_MS) return _ffCache.data;
  try {
    const r = await fetch(FF_CALENDAR_URL);
    if (!r.ok) return _ffCache.data || [];
    const d = await r.json();
    if (Array.isArray(d)) { _ffCache = { data: d, ts: now }; return d; }
  } catch (_) {}
  return _ffCache.data || [];
};

// Map instrument -> currencies it depends on
const instrumentCurrencies = (sym) => {
  const u = (sym || '').toUpperCase();
  if (u.includes('XAU') || u.includes('GOLD')) return ['USD'];
  if (u.includes('BTC') || u.includes('ETH'))  return ['USD'];
  if (u.includes('US30') || u.includes('NAS') || u.includes('SPX')) return ['USD'];
  // Forex pair: extract base + quote
  if (u.length >= 6) return [u.slice(0,3), u.slice(3,6)];
  return ['USD'];
};

// Check if a high-impact event is within +/- 15 min for the given instrument
const newsBlockReason = async (instrument) => {
  const cal = await fetchFFCalendar();
  if (!cal.length) return null;
  const ccys = instrumentCurrencies(instrument);
  const now = Date.now();
  const window = 15 * 60 * 1000;
  for (const ev of cal) {
    if (!ev || ev.impact !== 'High') continue;
    if (!ccys.includes(ev.country)) continue;
    const evTs = new Date(ev.date).getTime();
    if (isNaN(evTs)) continue;
    const diff = evTs - now;
    if (Math.abs(diff) <= window) {
      const mins = Math.round(diff / 60000);
      return `High-impact ${ev.country} news: ${ev.title} (${mins >= 0 ? 'in ' + mins + ' min' : Math.abs(mins) + ' min ago'})`;
    }
  }
  return null;
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};
    const { snap, instrument, riskMode, prevDecisions, lab, crownLocks, blacklist } = body;
    if (!snap || !instrument) return res.status(400).json({ error: 'Missing snap or instrument' });

    const sym = (instrument || '').toUpperCase().replace('.S', '').replace('.PRO', '').trim();
    const isGold   = sym.includes('XAU') || sym.includes('GOLD');
    const isCrypto = sym.includes('BTC') || sym.includes('ETH') || sym.includes('CRYPTO') || sym.includes('COIN');
    const category = isGold ? 'GOLD' : isCrypto ? 'CRYPTO' : 'FOREX';

    // Session gates (backend authoritative)
    const now = new Date();
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
    const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
    if (isWeekend) return res.status(200).json({ decision:'WAIT', reason:'Weekend -- markets closed.', confidence:0, volume:null });
    if (isCrypto && (utcH < 7 || utcH >= 23)) return res.status(200).json({ decision:'WAIT', reason:'Outside crypto hours (07:00-23:00 UTC).', confidence:0, volume:null });
    if (!isCrypto && (utcH < 8 || utcH >= 21)) return res.status(200).json({ decision:'WAIT', reason:'Outside trading hours (08:00-21:00 UTC).', confidence:0, volume:null });

    // News block
    const newsBlock = await newsBlockReason(instrument);
    if (newsBlock) return res.status(200).json({ decision:'WAIT', reason:newsBlock, confidence:0, volume:null, newsBlocked:true });

    // ATR & sizing
    const atrFallback = isGold ? 12 : isCrypto ? 300 : 0.0008;
    const atr      = parseFloat(snap.atr14) || atrFallback;
    const balance  = Number(snap.balance)   || 10000;
    const lossStrk = Number(snap.lossStreak) || 0;
    const winStrk  = Number(snap.winStreak)  || 0;

    const RISK = {
      TEST:       { pct: 0.005, maxLot: 0.05 },
      REGULAR:    { pct: 0.01,  maxLot: 0.20 },
      AGGRESSIVE: { pct: 0.02,  maxLot: 0.50 },
    };
    const risk = RISK[riskMode || 'TEST'] || RISK.TEST;
    const baseVol = Math.max(0.01, Math.min(risk.maxLot, parseFloat(((balance * risk.pct) / (atr * 100)).toFixed(2))));
    const lossAdj = lossStrk >= 4 ? 0.25 : lossStrk >= 3 ? 0.5 : lossStrk >= 2 ? 0.75 : 1.0;
    const winAdj  = winStrk  >= 5 ? 2.0  : winStrk  >= 3 ? 1.5 : winStrk  >= 2 ? 1.25 : 1.0;
    const fullVol = Math.max(0.01, Math.min(risk.maxLot, parseFloat((baseVol * lossAdj * winAdj).toFixed(2))));
    const sizingSmall = Math.max(0.01, parseFloat((fullVol * 0.5).toFixed(2)));
    const sizingLarge = Math.min(risk.maxLot, parseFloat((fullVol * 1.5).toFixed(2)));

    // TP/SL config
    let tp;
    if (isGold) {
      tp = { tp1: 5, tp2: 10, tp3: 15, tp4: 20, sl: 10, isGold: true };
    } else if (isCrypto) {
      tp = { tp1: Math.round(atr*0.5), tp2: Math.round(atr*1.0), tp3: Math.round(atr*1.5), tp4: Math.round(atr*2.0), sl: Math.round(atr*0.8), isGold: false };
    } else {
      tp = { tp1: parseFloat((atr*0.5).toFixed(5)), tp2: parseFloat((atr*1.0).toFixed(5)), tp3: parseFloat((atr*1.5).toFixed(5)), tp4: parseFloat((atr*2.0).toFixed(5)), sl: parseFloat((atr*0.8).toFixed(5)), isGold: false };
    }

    // Learned context (V9 lab)
    const instLab = lab
      ? Object.entries(lab).filter(([, d]) => d.instruments && d.instruments[instrument]).map(([strat, d]) => ({ strat, ...d.instruments[instrument] }))
      : [];
    const proven = instLab.filter(s => s.crown && !s.banned).sort((a,b) => (b.winRate||0)-(a.winRate||0)).slice(0,3);
    const banned  = instLab.filter(s => s.banned).map(s => s.strat);
    const blList  = Array.isArray(blacklist) ? blacklist : [];
    const crown   = crownLocks && crownLocks[instrument] ? crownLocks[instrument] : null;

    const provenLines = proven.length
      ? 'Proven on ' + instrument + ':\n' + proven.map(s => '  WIN: ' + s.strat + ' -- ' + s.winRate + '% WR (' + s.total + ' trades)').join('\n')
      : 'No proven strategies yet -- explore freely.';
    const bannedLines = banned.length ? 'Banned on ' + instrument + ' (avoid):\n' + banned.map(s => '  ' + s).join('\n') : '';
    const blLines = blList.length ? 'Globally blacklisted (never use):\n' + blList.map(s => '  ' + s).join('\n') : '';
    const crownLine = crown ? 'CROWN LOCK: Use "' + crown + '" if setup supports it.' : 'No crown lock -- explore all combinations freely.';
    const learnedCtx = ['=== STRATEGY KNOWLEDGE FOR ' + instrument + ' ===', provenLines, bannedLines || null, blLines || null, crownLine].filter(Boolean).join('\n');

    const prevCtx = (prevDecisions && prevDecisions.length)
      ? '\nRECENT DECISIONS:\n' + prevDecisions.slice(-3).map(d => '  ' + d.decision + ' @ ' + d.price + ' [' + (d.strategy || '?') + ']').join('\n')
      : '';

    const catDescriptions = {
      GOLD:   'Gold: $5-150/session. Round $10 levels are magnets. Best: London 08-10, NY 13-16 UTC.',
      CRYPTO: 'Crypto: $200-3000/day moves. Best 09-22 UTC. Round thousand levels matter. Trend-following dominates.',
      FOREX:  'Forex: 50-150 pips/day. Best London 08-10, NY 13-16 UTC. Follow USD strength.',
    };

    const tpSection = isGold
      ? 'GOLD TP SYSTEM (fixed pips):\nSL: -' + tp.sl + ' pips\nTP1: +' + tp.tp1 + ' pips -> close 40%, SL to BE\nTP2: +' + tp.tp2 + ' pips -> close 30%, SL to TP1\nTP3: +' + tp.tp3 + ' pips -> close 20%, SL to TP2\nTP4: +' + tp.tp4 + ' pips -> close final 10%'
      : 'TP SYSTEM (' + category + ', ATR-based):\nSL: -' + tp.sl + '\nTP1: +' + tp.tp1 + ' -> close 40%, SL to BE\nTP2: +' + tp.tp2 + ' -> close 30%, SL to TP1\nTP3: +' + tp.tp3 + ' -> close 20%, SL to TP2\nTP4: +' + tp.tp4 + ' -> close final 10%';

    const sysPrompt =
      'You are the trading brain of Quantum Bot V9.\n' +
      'Instrument: ' + instrument + ' (' + category + '). ' + (catDescriptions[category] || '') + '\n\n' +
      'YOUR JOB: Read the market data. Make a decisive call.\n\n' +
      'TRADE BIAS: Toward trading. WAIT only if:\n' +
      '1. Pure noise, no readable structure\n' +
      '2. Already an open position on this instrument\n' +
      '"Suboptimal" is not a reason to wait.\n\n' +
      tpSection + '\n\n' +
      'SIZING (' + (riskMode || 'TEST') + '):\n' +
      '35-49%: 0.01 lots (learning)\n' +
      '50-64%: ' + sizingSmall + ' lots\n' +
      '65-79%: ' + fullVol + ' lots\n' +
      '80%+:   ' + sizingLarge + ' lots\n\n' +
      'STRATEGY LABELS (combine with +):\n' +
      'ICT: ICT_KILLZONE, ICT_SWEEP, ICT_FVG, ICT_PDH_PDL, ICT_ASIAN_RANGE\n' +
      'TREND: TREND_H4, TREND_EMA_ALIGN, TREND_BREAKOUT, TREND_MA_BOUNCE\n' +
      'MOMENTUM: MOM_SESSION, MOM_MACD, MOM_RSI_DIV\n' +
      'MEAN_REV: MR_ROUND, MR_BB_SQUEEZE, MR_RANGE\n' +
      'PRICE_ACTION: PA_ENGULFING, PA_REJECTION, PA_INSIDE_BAR\n' +
      'SMC: SMC_OB, SMC_BOS, SMC_CHOCH\n' +
      'Example: ICT_FVG+TREND_H4+SMC_BOS\n\n' +
      learnedCtx + prevCtx + '\n\n' +
      'JSON ONLY. No markdown fences.\n' +
      '{"decision":"LONG|SHORT|WAIT","confidence":0-100,"entry":price|null,"stopLoss":price|null,"takeProfit1":price|null,"takeProfit2":price|null,"takeProfit3":price|null,"takeProfit4":price|null,"volume":lots,"strategy":"TACTIC1+TACTIC2","reason":"2-3 sentences","risk":"LOW|MEDIUM|HIGH"}';

    const utcStr = String(now.getUTCHours()).padStart(2,'0') + ':' + String(now.getUTCMinutes()).padStart(2,'0');
    const userPrompt =
      instrument + ' -- analysis?\n\n' +
      'PRICE: ' + snap.price + ' | UTC: ' + utcStr + ' | SESSION: ' + (snap.session || '') + '\n' +
      (snap.inKillZone ? 'IN KILL ZONE: ' + (snap.killZone || '') : 'Outside kill zone') + '\n\n' +
      'CANDLES:\nW: ' + (snap.weekly||'no data') + '\nD1: ' + (snap.d1||'no data') + '\nH4: ' + (snap.h4||'no data') + '\nH1: ' + (snap.h1||'no data') + '\nM15: ' + (snap.m15||'no data') + '\nM5: ' + (snap.m5||'no data') + '\nM1: ' + (snap.m1||'no data') + '\n\n' +
      'ATR: ' + snap.atr14 + ' -> ' + (snap.atrGuide||'') + '\n\n' +
      'ACCOUNT:\nBalance: $' + balance.toFixed(2) + ' | Today P&L: $' + (snap.todayPnl||'0.00') + '\nLoss streak: ' + lossStrk + ' | Win streak: ' + winStrk + '\nOpen on this instrument: ' + (snap.openCount||0) + '\n\n' +
      'Make the call. JSON only.';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 600, system: sysPrompt, messages: [{ role: 'user', content: userPrompt }] }),
    });

    const data = await resp.json();
    const raw  = (data.content || []).map(b => b.text || '').join('');

    let dec;
    try { dec = JSON.parse(raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()); }
    catch (e) { return res.status(200).json({ decision:'WAIT', reason:'Parse error: '+e.message, confidence:0, volume:null, raw:raw.slice(0,200) }); }

    if (!['LONG','SHORT','WAIT'].includes(dec.decision)) dec.decision = 'WAIT';
    if (dec.decision !== 'WAIT') {
      const c = dec.confidence || 0;
      if (c < 35) { dec.decision = 'WAIT'; dec.reason = 'Confidence ' + c + '% below 35% min.'; dec.volume = null; }
      else { dec.volume = c >= 80 ? sizingLarge : c >= 65 ? fullVol : c >= 50 ? sizingSmall : 0.01; }
    }
    if (dec.decision !== 'WAIT' && dec.strategy) {
      const s = (dec.strategy || '').trim();
      if (blList.includes(s)) { dec.decision = 'WAIT'; dec.reason = 'Strategy "'+s+'" globally blacklisted.'; dec.volume = null; }
    }

    console.log(JSON.stringify({ instrument, category, decision: dec.decision, confidence: dec.confidence, strategy: dec.strategy, volume: dec.volume }));
    return res.status(200).json(dec);

  } catch (e) {
    console.error('ai.js error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};