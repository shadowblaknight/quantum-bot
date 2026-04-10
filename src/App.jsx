import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const INSTRUMENTS = [
  { id: "GBPUSD",  label: "GBP/USD",  type: "FOREX",     color: "#00D4AA", icon: "₤" },
  { id: "BTCUSDT", label: "BTC/USDT", type: "CRYPTO",    color: "#F7931A", icon: "₿" },
  { id: "XAUUSD",  label: "XAU/USD",  type: "COMMODITY", color: "#FFD700", icon: "⬡" },
];

// ─── MARKET HOURS ─────────────────────────────────────────────────────────────
const getMarketStatus = () => {
  const now = new Date();
  const utcDay  = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;
  const crypto  = { open: true, session: "24/7" };
  let forex = { open: false, session: "WEEKEND" };
  if (utcDay >= 1 && utcDay <= 4) {
    const s = utcTime < 8 ? "SYDNEY/TOKYO" : utcTime < 16 ? "LONDON" : "NEW YORK";
    forex = { open: true, session: s };
  } else if (utcDay === 5 && utcTime < 22) {
    forex = { open: true, session: utcTime < 16 ? "LONDON" : "NEW YORK" };
  } else if (utcDay === 0 && utcTime >= 22) {
    forex = { open: true, session: "SYDNEY" };
  }
  const gold = forex.open ? { open: true, session: "COMMODITIES" } : { open: false, session: "WEEKEND" };
  return { GBPUSD: forex, BTCUSDT: crypto, XAUUSD: gold };
};

const isNearMarketClose = () => {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcTime = now.getUTCHours() + now.getUTCMinutes() / 60;
  return utcDay === 5 && utcTime >= 21.5;
};

const getSessionInfo = () => {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;
  const utcDay  = now.getUTCDay();

  if (utcDay === 6 || (utcDay === 0 && utcTime < 22)) {
    return { session: "WEEKEND", isLondon: false, isNY: false, tradingAllowed: false, utcTime };
  }

  const isSundayReopen = utcDay === 0 && utcTime >= 22;
  const isLondon  = utcTime >= 8  && utcTime < 16;
  const isNY      = utcTime >= 13 && utcTime < 21;
  const isOverlap = utcTime >= 13 && utcTime < 16;
  const isAsian   = (utcTime >= 0 && utcTime < 8) || isSundayReopen;

  let session = "OFF_HOURS";
  if (isSundayReopen) session = "SYDNEY_OPEN";
  else if (isOverlap) session = "LONDON_NY_OVERLAP";
  else if (isNY)      session = "NEW_YORK";
  else if (isLondon)  session = "LONDON";
  else if (isAsian)   session = "ASIAN";

  return { session, isLondon, isNY, isOverlap, isAsian, isSundayReopen,
    tradingAllowed: isLondon || isNY || isSundayReopen, utcTime };
};

// ─── RISK HELPERS ────────────────────────────────────────────────────────────
const getConsecutiveLosses = (closedTrades = []) => {
  if (!closedTrades.length) return 0;
  let streak = 0;
  for (let i = closedTrades.length - 1; i >= 0; i--) {
    if (Number(closedTrades[i]?.profit || 0) < 0) streak++;
    else break;
  }
  return streak;
};

const getTodayPnl = (closedTrades = []) => {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  return closedTrades.reduce((sum, t) => {
    const timeRaw = t.time || t.closeTime || t.createdAt || t.date;
    if (!timeRaw) return sum;
    const dt = new Date(timeRaw);
    if (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d)
      return sum + Number(t.profit || 0);
    return sum;
  }, 0);
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function TradingBotLive() {
  // ── State ──
  const [prices,        setPrices]        = useState({ GBPUSD: null, BTCUSDT: null, XAUUSD: null });
  const [prevPrices,    setPrevPrices]     = useState({ GBPUSD: null, BTCUSDT: null, XAUUSD: null });
  const [brokerCandles, setBrokerCandles]  = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
  const [m15Candles,    setM15Candles]     = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
  const [h4Candles,     setH4Candles]      = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
  const [d1Candles,     setD1Candles]      = useState({ BTCUSDT: [], XAUUSD: [], GBPUSD: [] });
  const [openPositions, setOpenPositions]  = useState([]);
  const [closedTrades,  setClosedTrades]   = useState([]);
  const [news,          setNews]           = useState([]);
  const [calendarEvents,setCalendarEvents] = useState([]);
  const [eventAlert,    setEventAlert]     = useState(null);
  const [accountBalance,setAccountBalance] = useState(null);
  const [marketStatus,  setMarketStatus]   = useState(getMarketStatus());
  const [sessionInfo,   setSessionInfo]    = useState(getSessionInfo());
  const [log,           setLog]            = useState([]);
  const [learnedStats,  setLearnedStats]   = useState({});
  const [tradeReports,  setTradeReports]   = useState({ reports: [], analytics: {} });
  const [notifications, setNotifications]  = useState([]);
  const [selected,      setSelected]       = useState("XAUUSD");
  const [activeTab,     setActiveTab]      = useState("signals");

  // ── V5: Claude brain state ──
  const [aiDecisions,       setAiDecisions]       = useState({});
  const [previousDecisions, setPreviousDecisions] = useState({});
  const [aiStatus,          setAiStatus]          = useState({});

  // ── Refs ──
  const lastTradeRef    = useRef({});
  const pendingTradeRef = useRef({});
  const logRef          = useRef(null);
  const lastBlockLogRef = useRef({});
  const prevPositionsRef = useRef([]);

  // ── Logging ──
  const addLog = useCallback((msg, type = "info") => {
    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;
    setLog(prev => [...prev.slice(-80), { time, msg, type }]);
  }, []);

  const shouldLogBlock = useCallback((key, cooldownMs = 60000) => {
    const now = Date.now();
    if (!lastBlockLogRef.current[key] || now - lastBlockLogRef.current[key] > cooldownMs) {
      lastBlockLogRef.current[key] = now;
      return true;
    }
    return false;
  }, []);

  // ── Fetch helpers ──
  const fetchLiveTrades = useCallback(async () => {
    try {
      const r = await fetch("/api/positions");
      if (r.ok) { const d = await r.json(); setOpenPositions(d.positions || []); }
    } catch(e) {}
  }, []);

  const fetchClosedTrades = useCallback(async () => {
    try {
      const r = await fetch("/api/history");
      if (r.ok) { const d = await r.json(); setClosedTrades(d.deals || []); }
    } catch(e) {}
  }, []);

  const fetchLearnedStats = useCallback(async () => {
    try {
      const r = await fetch('/api/trades?learn=true');
      if (r.ok) { const d = await r.json(); setLearnedStats(d.stats || {}); }
    } catch(e) {}
  }, []);

  const fetchTradeReports = useCallback(async () => {
    try {
      const r = await fetch('/api/manage-trades');
      if (r.ok) { const d = await r.json(); setTradeReports(d); }
    } catch(e) {}
  }, []);

  // ── Account balance ──
  useEffect(() => {
    const fetch_ = async () => {
      try {
        const r = await fetch("/api/account");
        if (!r.ok) return;
        const d = await r.json();
        const balance = Number(d.balance ?? d.equity ?? d.accountBalance);
        if (Number.isFinite(balance) && balance > 0) setAccountBalance(balance);
      } catch(e) {}
    };
    fetch_();
    const interval = setInterval(fetch_, 30000);
    return () => clearInterval(interval);
  }, []);

  // ── Price & candle feeds ──
  useEffect(() => {
    const symbolMap = { BTCUSDT: "BTCUSD", XAUUSD: "XAUUSD.s", GBPUSD: "GBPUSD" };

    const fetchCandles = async (instId) => {
      const symbol = symbolMap[instId];
      try {
        // M1
        const r = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=M1&limit=200`);
        const d = await r.json();
        if (d.candles && d.candles.length >= 50) {
          setBrokerCandles(prev => ({ ...prev, [instId]: d.candles }));
          const lastClose = d.candles[d.candles.length - 1].close;
          if (Number.isFinite(lastClose)) {
            setPrices(prev => { setPrevPrices(pp => ({ ...pp, [instId]: prev[instId] })); return { ...prev, [instId]: lastClose }; });
          }
        }
        // M15
        try {
          const r15 = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=M15&limit=100`);
          const d15 = await r15.json();
          if (d15.candles?.length >= 20) setM15Candles(prev => ({ ...prev, [instId]: d15.candles }));
        } catch(e) {}
        // H4
        try {
          const r4 = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=H4&limit=100`);
          const d4 = await r4.json();
          if (d4.candles?.length >= 20) setH4Candles(prev => ({ ...prev, [instId]: d4.candles }));
        } catch(e) {}
        // D1
        try {
          const rd = await fetch(`/api/broker-candles?symbol=${symbol}&timeframe=D1&limit=30`);
          const dd = await rd.json();
          if (dd.candles?.length >= 10) setD1Candles(prev => ({ ...prev, [instId]: dd.candles }));
        } catch(e) {}
      } catch(e) {
        setPrices(prev => ({ ...prev, [instId]: null }));
      }
    };

    const fetchPrice = async (instId) => {
      const symbol = symbolMap[instId];
      try {
        const r = await fetch(`/api/broker-price?symbol=${symbol}`);
        const d = await r.json();
        if (Number.isFinite(d.price)) {
          setPrices(prev => { setPrevPrices(pp => ({ ...pp, [instId]: prev[instId] })); return { ...prev, [instId]: d.price }; });
        }
      } catch(e) {}
    };

    INSTRUMENTS.forEach(inst => fetchCandles(inst.id));
    const priceIntervals  = INSTRUMENTS.map(inst => setInterval(() => fetchPrice(inst.id), 5000));
    const candleIntervals = INSTRUMENTS.map(inst => setInterval(() => fetchCandles(inst.id), 60000));
    addLog("V5 online — Claude is the brain 🧠", "success");
    return () => { priceIntervals.forEach(clearInterval); candleIntervals.forEach(clearInterval); };
  }, [addLog]);

  // ── Market status ──
  useEffect(() => {
    const interval = setInterval(() => { setMarketStatus(getMarketStatus()); setSessionInfo(getSessionInfo()); }, 60000);
    return () => clearInterval(interval);
  }, []);

  // ── News ──
  useEffect(() => {
    const fetch_ = async () => { try { const r = await fetch("/api/news"); const d = await r.json(); if (d.articles) setNews(d.articles); } catch(e) {} };
    fetch_();
    const interval = setInterval(fetch_, 300000);
    return () => clearInterval(interval);
  }, []);

  // ── Calendar ──
  useEffect(() => {
    const fetch_ = async () => {
      try {
        const r = await fetch("/api/calendar");
        const d = await r.json();
        if (d.source === "unavailable" || !Array.isArray(d.events)) {
          setEventAlert({ name: "Calendar unavailable", date: null });
          return;
        }
        setCalendarEvents(d.events);
        const now = Date.now();
        const upcoming = d.events.find(ev => { const t = new Date(ev.date).getTime(); return t > now && t < now + 30 * 60 * 1000; });
        setEventAlert(upcoming || null);
      } catch(e) { setEventAlert({ name: "Calendar error", date: null }); }
    };
    fetch_();
    const interval = setInterval(fetch_, 300000);
    return () => clearInterval(interval);
  }, []);

  // ── Trades & learning ──
  useEffect(() => {
    fetchLiveTrades(); fetchClosedTrades();
    const interval = setInterval(() => { fetchLiveTrades(); fetchClosedTrades(); }, 30000);
    return () => clearInterval(interval);
  }, [fetchLiveTrades, fetchClosedTrades]);

  useEffect(() => {
    fetchLearnedStats();
    const interval = setInterval(fetchLearnedStats, 300000);
    return () => clearInterval(interval);
  }, [fetchLearnedStats]);

  useEffect(() => {
    fetchTradeReports();
    const interval = setInterval(fetchTradeReports, 30000);
    return () => clearInterval(interval);
  }, [fetchTradeReports]);

  // ── Record trade result for learning ──
  const recordTradeResult = useCallback(async (position, aiDecision, session) => {
    if (!position || !aiDecision) return;
    const pips = position.profit || 0;
    const won  = pips > 0;
    const payload = {
      instrument: position.symbol?.replace('.s','').replace('.S','') || 'UNKNOWN',
      direction:  position.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT',
      won, pips,
      rr:         parseFloat((Math.abs(pips) / Math.max(1, Math.abs(pips))).toFixed(2)),
      session,
      grade:      aiDecision.confidence >= 80 ? 'A' : aiDecision.confidence >= 65 ? 'B' : 'C',
      confluenceScore: aiDecision.confidence,
      regime:     'AI_DECISION',
    };
    try {
      await fetch('/api/trades?learn=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      addLog(`🧠 Learned: ${payload.instrument} ${won ? 'WIN' : 'LOSS'} ${pips >= 0 ? '+' : ''}${pips.toFixed(2)}`, won ? 'success' : 'warn');

      // Update previous decisions outcome
      setPreviousDecisions(prev => {
        const existing = [...(prev[payload.instrument] || [])];
        const last = existing[existing.length - 1];
        if (last && !last.outcome) {
          existing[existing.length - 1] = { ...last, outcome: won ? 'WIN' : 'LOSS', pnl: pips };
        }
        return { ...prev, [payload.instrument]: existing };
      });

      fetchLearnedStats();
    } catch(e) {}
  }, [addLog, fetchLearnedStats]);

  // ── Watch for closed positions ──
  useEffect(() => {
    const prev    = prevPositionsRef.current;
    const current = openPositions;
    const justClosed = prev.filter(p => !current.find(c => (c.id || c.positionId) === (p.id || p.positionId)));
    justClosed.forEach(closedPos => {
      const raw    = (closedPos.symbol || '').toUpperCase();
      const instId = raw.startsWith('BTCUSD') ? 'BTCUSDT' : raw.startsWith('XAUUSD') ? 'XAUUSD' : raw.startsWith('GBPUSD') ? 'GBPUSD' : null;
      const dec    = instId ? aiDecisions[instId] : null;
      const session = getSessionInfo().session;
      if (dec) recordTradeResult(closedPos, dec, session);
    });
    prevPositionsRef.current = current;
  }, [openPositions, aiDecisions, recordTradeResult]);

  // ── Trade manager ──
  const manageTrades = useCallback(async () => {
    if (openPositions.length === 0) return;
    const managed = openPositions.map(pos => {
      const raw    = (pos.symbol || '').toUpperCase();
      const instId = raw.startsWith('BTCUSD') ? 'BTCUSDT' : raw.startsWith('XAUUSD') ? 'XAUUSD' : raw.startsWith('GBPUSD') ? 'GBPUSD' : null;
      const dec    = instId ? aiDecisions[instId] : null;
      return {
        id: pos.id || pos.positionId, symbol: pos.symbol,
        openPrice: pos.openPrice, currentPrice: pos.currentPrice,
        stopLoss: pos.stopLoss, volume: pos.volume,
        direction: pos.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT',
        tp1: dec?.takeProfit1 ?? null,
        tp2: dec?.takeProfit2 ?? null,
        tp3: dec?.takeProfit3 ?? null,
        breakeven: pos.openPrice,
        atr: null,
      };
    }).filter(p => p.id && p.tp1);
    if (managed.length === 0) return;
    try {
      const r = await fetch('/api/manage-trades', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions: managed }),
      });
      const d = await r.json();
      if (d.managed?.length > 0) {
        d.managed.forEach(m => {
          m.actions.forEach(a => {
            if (a.type === 'PARTIAL_CLOSE_TP1') addLog(`🎯 TP1 hit: ${m.symbol} — closed 50% @ ${a.price?.toFixed(2)}`, 'success');
            if (a.type === 'PARTIAL_CLOSE_TP2') addLog(`🎯 TP2 hit: ${m.symbol} — closed 30% @ ${a.price?.toFixed(2)}`, 'success');
            if (a.type === 'FULL_CLOSE_TP3')    addLog(`🏆 TP3 hit: ${m.symbol} — trade complete! @ ${a.price?.toFixed(2)}`, 'success');
            if (['PARTIAL_CLOSE_TP1','PARTIAL_CLOSE_TP2','FULL_CLOSE_TP3'].includes(a.type)) {
              setNotifications(prev => [...prev.slice(-4), {
                id: Date.now(), symbol: m.symbol, type: a.type,
                price: a.price, pnl: a.pnl, time: new Date().toLocaleTimeString(),
              }]);
              fetchTradeReports();
            }
          });
        });
        setTimeout(fetchLiveTrades, 1500);
        setTimeout(fetchClosedTrades, 3000);
      }
    } catch(e) {}
  }, [openPositions, aiDecisions, addLog, fetchLiveTrades, fetchClosedTrades, fetchTradeReports]);

  useEffect(() => {
    if (openPositions.length === 0) return;
    const interval = setInterval(manageTrades, 30000);
    manageTrades();
    return () => clearInterval(interval);
  }, [openPositions, manageTrades]);

  // ── V5 BRAIN: Ask Claude for trading decision ──
  const runAIBrain = useCallback(async (inst) => {
    const candles = brokerCandles[inst.id];
    if (!candles || candles.length < 50 || !prices[inst.id]) return;
    if (!accountBalance) return;

    setAiStatus(prev => ({ ...prev, [inst.id]: 'thinking' }));

    const session = getSessionInfo();

    // Format candle summary for Claude
    const summarizeCandles = (c, label) => {
      if (!c || c.length === 0) return `${label}: no data`;
      const last5 = c.slice(-5);
      const dir   = last5[last5.length-1].close > last5[0].close ? '↑' : '↓';
      const chg   = ((last5[last5.length-1].close - last5[0].close) / last5[0].close * 100).toFixed(3);
      const high  = Math.max(...last5.map(x => x.high)).toFixed(inst.id === 'BTCUSDT' ? 0 : 4);
      const low   = Math.min(...last5.map(x => x.low)).toFixed(inst.id === 'BTCUSDT' ? 0 : 4);
      return `${label}: ${dir} ${chg}% | H:${high} L:${low}`;
    };

    // Simple indicators for context
    const closes  = candles.map(c => c.close);
    const rsi14   = (() => {
      if (closes.length < 15) return 50;
      const changes = closes.slice(1).map((p, i) => p - closes[i]);
      let g = 0, l = 0;
      for (let i = 0; i < 14; i++) { if (changes[i] > 0) g += changes[i]; else l -= changes[i]; }
      g /= 14; l /= 14;
      for (let i = 14; i < changes.length; i++) {
        g = (g * 13 + Math.max(changes[i], 0)) / 14;
        l = (l * 13 + Math.max(-changes[i], 0)) / 14;
      }
      return l === 0 ? 100 : 100 - (100 / (1 + g / l));
    })();

    const ema21 = (() => {
      if (closes.length < 21) return null;
      const k = 2 / 22;
      let e = closes.slice(0, 21).reduce((a, b) => a + b, 0) / 21;
      for (let i = 21; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
      return e;
    })();

    // Equilibrium position in H4 range
    const h4 = h4Candles[inst.id] || [];
    const eq = (() => {
      if (h4.length < 10) return null;
      const r20  = h4.slice(-20);
      const high = Math.max(...r20.map(c => c.high));
      const low  = Math.min(...r20.map(c => c.low));
      const pos  = ((prices[inst.id] - low) / (high - low)) * 100;
      return { position: Math.round(pos), zone: pos > 62.5 ? 'PREMIUM' : pos < 37.5 ? 'DISCOUNT' : 'EQUILIBRIUM' };
    })();

    const todayPnl     = getTodayPnl(closedTrades);
    const lossStreak   = getConsecutiveLosses(closedTrades);
    const todayTrades  = closedTrades.filter(t => { const d = new Date(t.time || t.closeTime || ''); return d.toDateString() === new Date().toDateString(); }).length;
    const overallWR    = closedTrades.length > 0 ? ((closedTrades.filter(t => t.profit > 0).length / closedTrades.length) * 100).toFixed(1) : 0;

    const marketSnapshot = {
      symbol: inst.id, price: prices[inst.id],
      candles_m1:  summarizeCandles(candles, 'M1'),
      candles_m15: summarizeCandles(m15Candles[inst.id], 'M15'),
      candles_h4:  summarizeCandles(h4Candles[inst.id], 'H4'),
      candles_d1:  summarizeCandles(d1Candles[inst.id], 'D1'),
      rsi: rsi14?.toFixed(1),
      ema21: ema21?.toFixed(inst.id === 'BTCUSDT' ? 0 : 4),
      price_vs_ema21: ema21 ? (prices[inst.id] > ema21 ? 'ABOVE' : 'BELOW') : 'UNKNOWN',
      equilibrium_zone:     eq?.zone,
      equilibrium_position: eq?.position,
      session:         session.session,
      session_allowed: session.tradingAllowed,
      news:            news.slice(0, 3),
      calendar_events: calendarEvents.slice(0, 3),
      open_positions:  openPositions.map(p => ({ symbol: p.symbol, type: p.type, profit: p.profit })),
      account_balance: accountBalance,
      today_pnl:       todayPnl?.toFixed(2),
      today_trades:    todayTrades,
      loss_streak:     lossStreak,
      overall_win_rate: overallWR,
      win_streak: (() => {
        let streak = 0;
        for (let i = closedTrades.length - 1; i >= 0; i--) {
          if (Number(closedTrades[i]?.profit || 0) > 0) streak++;
          else break;
        }
        return streak;
      })(),
    };

    try {
      const r = await fetch('/api/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketSnapshot,
          instrument: inst.id,
          previousDecisions: previousDecisions[inst.id] || [],
        }),
      });
      const decision = await r.json();

      if (decision.decision) {
        setAiDecisions(prev => ({ ...prev, [inst.id]: decision }));
        setAiStatus(prev => ({ ...prev, [inst.id]: decision.decision }));
        addLog(`🧠 ${inst.label}: ${decision.decision} (${decision.confidence || 0}%) — ${decision.reason || 'thinking...'}`,
          decision.decision === 'WAIT' ? 'info' : 'signal');

        // ── Execute if LONG or SHORT ──
        if (decision.decision !== 'WAIT' && decision.confidence >= 55) {
          const now = Date.now();
          if (lastTradeRef.current[inst.id] && (now - lastTradeRef.current[inst.id]) < 300000) return;
          if (pendingTradeRef.current[inst.id]) return;

          // Safety checks
          const nowTs  = Date.now();
          const evTs   = eventAlert?.date ? new Date(eventAlert.date).getTime() : 0;
          if (evTs > nowTs && evTs < nowTs + 30 * 60 * 1000) { addLog(`Trade blocked: ${eventAlert.name} imminent`, "warn"); return; }
          if (isNearMarketClose() && inst.type !== "CRYPTO") { addLog("Trade blocked: near market close", "warn"); return; }
          if (!marketStatus[inst.id]?.open && inst.type !== "CRYPTO") return;

          const alreadyOpen = openPositions.some(p => {
            const raw = (p.symbol || "").toUpperCase();
            const norm = raw === "XAUUSD.S" ? "XAUUSD" : raw.startsWith("BTCUSD") ? "BTCUSD" : raw.startsWith("GBPUSD") ? "GBPUSD" : raw.startsWith("XAUUSD") ? "XAUUSD" : raw;
            const target = inst.id === "BTCUSDT" ? "BTCUSD" : inst.id;
            return norm === target;
          });
          if (alreadyOpen) { addLog(`${inst.label}: position already open`, "warn"); return; }
          if (openPositions.length >= 3) { addLog("Max 3 positions open", "warn"); return; }

          if (!decision.stopLoss || !decision.takeProfit3) { addLog(`${inst.label}: Claude gave no SL/TP — skipping`, "warn"); return; }
          if (!Number.isFinite(accountBalance) || accountBalance <= 0) return;

          // Daily loss limit
          if (todayPnl <= -(accountBalance * 0.05)) { addLog("Daily loss limit -5% hit", "error"); return; }

          const volume = decision.volume || 0.08;

          pendingTradeRef.current[inst.id] = true;
          addLog(`🚀 Executing: ${inst.label} ${decision.decision} ${volume} lots | SL:${decision.stopLoss?.toFixed(inst.id==='BTCUSDT'?0:4)} TP:${decision.takeProfit3?.toFixed(inst.id==='BTCUSDT'?0:4)}`, "signal");

          // Record decision
          setPreviousDecisions(prev => ({
            ...prev,
            [inst.id]: [...(prev[inst.id] || []).slice(-4), {
              decision: decision.decision,
              price: prices[inst.id],
              reason: decision.reason,
              time: new Date().toISOString(),
              outcome: null, pnl: null,
            }]
          }));

          fetch("/api/execute", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instrument: inst.id,
              direction:  decision.decision,
              entry:      prices[inst.id],
              stopLoss:   decision.stopLoss,
              takeProfit: decision.takeProfit3,
              volume,
            })
          })
          .then(r => r.json())
          .then(d => {
            pendingTradeRef.current[inst.id] = false;
            if (d.success) {
              lastTradeRef.current[inst.id] = Date.now();
              addLog(`✅ Trade live: ${inst.label} ${decision.decision} ${volume} lots @ ${prices[inst.id]}`, "success");
              setTimeout(fetchLiveTrades, 2000);
              setTimeout(fetchClosedTrades, 3000);
            } else {
              addLog(`❌ Execution failed: ${d.error || "unknown"}`, "error");
              lastTradeRef.current[inst.id] = Date.now();
            }
          })
          .catch(e => { pendingTradeRef.current[inst.id] = false; addLog(`Execute error: ${e.message}`, "error"); });
        }
      }
    } catch(e) {
      setAiStatus(prev => ({ ...prev, [inst.id]: 'error' }));
      addLog(`AI brain error: ${e.message}`, "error");
    }
  }, [brokerCandles, prices, m15Candles, h4Candles, d1Candles, accountBalance,
      closedTrades, openPositions, news, calendarEvents, eventAlert, marketStatus,
      previousDecisions, addLog, fetchLiveTrades, fetchClosedTrades]);

  // ── Run AI brain every 60 seconds ──
  useEffect(() => {
    const run = () => INSTRUMENTS.forEach(inst => {
      if (brokerCandles[inst.id]?.length >= 50) runAIBrain(inst);
    });
    const timer = setTimeout(run, 3000); // initial delay
    const interval = setInterval(run, 60000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [runAIBrain, brokerCandles]);

  // ── Log scroll ──
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  // ── Computed values ──
  const priceDelta  = (id) => { if (!prices[id] || !prevPrices[id]) return null; return prices[id] - prevPrices[id]; };
  const fmt         = (id, p) => p != null ? (id === "BTCUSDT" ? p.toLocaleString("en", { maximumFractionDigits: 0 }) : p.toFixed(id === "GBPUSD" ? 4 : 2)) : "—";
  const wins        = closedTrades.filter(t => t.profit > 0).length;
  const totalPnl    = closedTrades.reduce((a, t) => a + (t.profit || 0), 0);
  const winRate     = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : "0.0";
  const lossStreak  = getConsecutiveLosses(closedTrades);
  const todayPnl    = getTodayPnl(closedTrades);
  const nowTs       = Date.now();
  const eventTs     = eventAlert?.date ? new Date(eventAlert.date).getTime() : 0;
  const showBanner  = !!eventAlert && (!eventTs || (eventTs > nowTs && eventTs < nowTs + 30 * 60 * 1000));

  const selectedAI  = aiDecisions[selected] || {};
  const inst        = INSTRUMENTS.find(i => i.id === selected);

  // ── Styles ──
  const styles = {
    app:       { background: "#0a0a0f", color: "#e0e0e0", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", minHeight: "100vh", fontSize: "12px" },
    header:    { background: "linear-gradient(135deg, #0d1117 0%, #161b22 100%)", borderBottom: "1px solid #21262d", padding: "12px 20px", display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" },
    statBox:   { display: "flex", flexDirection: "column", gap: "2px" },
    statLabel: { color: "#8b949e", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px" },
    statValue: { fontWeight: "700", fontSize: "14px" },
    body:      { display: "flex", height: "calc(100vh - 60px)" },
    sidebar:   { width: "200px", background: "#0d1117", borderRight: "1px solid #21262d", padding: "12px", display: "flex", flexDirection: "column", gap: "8px", overflowY: "auto" },
    instCard:  (id) => ({ padding: "10px", borderRadius: "6px", cursor: "pointer", border: selected === id ? `1px solid ${INSTRUMENTS.find(i=>i.id===id)?.color}` : "1px solid #21262d", background: selected === id ? "rgba(255,255,255,0.05)" : "transparent", transition: "all 0.2s" }),
    main:      { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
    tabs:      { display: "flex", borderBottom: "1px solid #21262d", background: "#0d1117", overflowX: "auto" },
    tab:       (a) => ({ padding: "10px 14px", cursor: "pointer", borderBottom: a ? "2px solid #58a6ff" : "2px solid transparent", color: a ? "#58a6ff" : "#8b949e", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" }),
    content:   { flex: 1, padding: "16px", overflowY: "auto" },
    card:      { background: "#0d1117", border: "1px solid #21262d", borderRadius: "8px", padding: "16px", marginBottom: "12px" },
    logPanel:  { width: "280px", background: "#0d1117", borderLeft: "1px solid #21262d", display: "flex", flexDirection: "column" },
    logHeader: { padding: "10px 12px", borderBottom: "1px solid #21262d", color: "#8b949e", fontSize: "10px", textTransform: "uppercase" },
    logBody:   { flex: 1, overflowY: "auto", padding: "8px" },
    logEntry:  (type) => ({ padding: "3px 6px", marginBottom: "2px", borderRadius: "3px", fontSize: "10px", color: type === "signal" ? "#58a6ff" : type === "error" ? "#f85149" : type === "warn" ? "#e3b341" : type === "success" ? "#3fb950" : "#8b949e" }),
    badge:     (dir) => ({ padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", background: dir === "LONG" ? "rgba(63,185,80,0.15)" : dir === "SHORT" ? "rgba(248,81,73,0.15)" : "rgba(139,148,158,0.15)", color: dir === "LONG" ? "#3fb950" : dir === "SHORT" ? "#f85149" : "#8b949e", border: `1px solid ${dir === "LONG" ? "#3fb950" : dir === "SHORT" ? "#f85149" : "#8b949e"}40` }),
    posCard:   { background: "#161b22", border: "1px solid #30363d", borderRadius: "6px", padding: "12px", marginBottom: "8px" },
    tradeRow:  { display: "grid", gridTemplateColumns: "80px 60px 60px 80px 80px 80px", gap: "8px", padding: "8px", borderBottom: "1px solid #21262d", fontSize: "11px", alignItems: "center" },
    alertBanner: { background: "rgba(227,179,65,0.15)", border: "1px solid #e3b341", borderRadius: "6px", padding: "10px 16px", marginBottom: "12px", color: "#e3b341" },
  };

  return (
    <div style={styles.app}>

      {/* ── TP NOTIFICATIONS ── */}
      <div style={{ position:'fixed', top:'70px', right:'16px', zIndex:9999, display:'flex', flexDirection:'column', gap:'8px' }}>
        {notifications.map(n => (
          <div key={n.id} style={{ background:'#161b22',
            border:`1px solid ${n.type === 'FULL_CLOSE_TP3' ? '#3fb950' : n.type === 'PARTIAL_CLOSE_TP2' ? '#58a6ff' : '#e3b341'}`,
            borderRadius:'8px', padding:'12px 16px', minWidth:'260px', boxShadow:'0 4px 20px rgba(0,0,0,0.5)', fontSize:'11px' }}>
            <div style={{ fontWeight:'700', color:'#c9d1d9', marginBottom:'4px' }}>
              {n.type === 'PARTIAL_CLOSE_TP1' ? '🎯 TP1 Hit — 50% closed' :
               n.type === 'PARTIAL_CLOSE_TP2' ? '🎯 TP2 Hit — 30% closed' : '🏆 TP3 Hit — Trade Complete!'}
            </div>
            <div style={{ color:'#8b949e' }}>{n.symbol} @ {n.price?.toFixed(2)} | +${n.pnl?.toFixed(2)}</div>
            <div style={{ color:'#484f58', fontSize:'10px', marginTop:'2px' }}>{n.time}</div>
          </div>
        ))}
      </div>

      {/* ── HEADER ── */}
      <div style={styles.header}>
        <div style={{ color:"#58a6ff", fontWeight:"900", fontSize:"16px", letterSpacing:"2px" }}>QUANTUM BOT <span style={{ fontSize:"10px", color:"#3fb950" }}>V5</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Win Rate</span><span style={{ ...styles.statValue, color:"#3fb950" }}>{winRate}%</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Closed</span><span style={{ ...styles.statValue, color:"#58a6ff" }}>{closedTrades.length}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Net P&L</span><span style={{ ...styles.statValue, color: totalPnl >= 0 ? "#3fb950" : "#f85149" }}>${totalPnl.toFixed(2)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Balance</span><span style={{ ...styles.statValue, color:"#58a6ff" }}>{accountBalance != null ? `$${accountBalance.toFixed(0)}` : "—"}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Today P&L</span><span style={{ ...styles.statValue, color: todayPnl >= 0 ? "#3fb950" : "#f85149" }}>${todayPnl.toFixed(2)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Loss Streak</span><span style={{ ...styles.statValue, color: lossStreak >= 2 ? "#f85149" : "#3fb950" }}>{lossStreak}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Open</span><span style={{ ...styles.statValue, color:"#e3b341" }}>{openPositions.length}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>BTC</span><span style={{ ...styles.statValue, color:"#F7931A" }}>${fmt("BTCUSDT", prices.BTCUSDT)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>Gold</span><span style={{ ...styles.statValue, color:"#FFD700" }}>${fmt("XAUUSD", prices.XAUUSD)}</span></div>
        <div style={styles.statBox}><span style={styles.statLabel}>GBP</span><span style={{ ...styles.statValue, color:"#00D4AA" }}>{fmt("GBPUSD", prices.GBPUSD)}</span></div>
        <div style={{ marginLeft:"auto", color:"#e3b341", fontSize:"11px" }}>{sessionInfo.session} {showBanner && `| ⚠️ ${eventAlert.name}`}</div>
      </div>

      <div style={styles.body}>

        {/* ── SIDEBAR ── */}
        <div style={styles.sidebar}>
          {INSTRUMENTS.map(i => {
            const ai    = aiDecisions[i.id];
            const delta = priceDelta(i.id);
            const status = aiStatus[i.id];
            return (
              <div key={i.id} style={styles.instCard(i.id)} onClick={() => setSelected(i.id)}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"6px" }}>
                  <span style={{ color:i.color, fontWeight:"700", fontSize:"11px" }}>{i.icon} {i.label}</span>
                  <span style={{ fontSize:"9px", color: status === 'thinking' ? "#e3b341" : status === 'LONG' ? "#3fb950" : status === 'SHORT' ? "#f85149" : "#8b949e" }}>
                    {status === 'thinking' ? '🧠...' : status || i.type}
                  </span>
                </div>
                <div style={{ fontSize:"13px", fontWeight:"700", marginBottom:"4px" }}>
                  {fmt(i.id, prices[i.id])}
                  {delta !== null && <span style={{ fontSize:"10px", color: delta >= 0 ? "#3fb950" : "#f85149", marginLeft:"4px" }}>{delta >= 0 ? "▲" : "▼"}</span>}
                </div>
                {ai && ai.decision !== 'WAIT' && (
                  <div style={{ display:"flex", justifyContent:"space-between" }}>
                    <span style={styles.badge(ai.decision)}>{ai.decision}</span>
                    <span style={{ color:"#8b949e", fontSize:"10px" }}>{ai.confidence}%</span>
                  </div>
                )}
                {(!ai || ai.decision === 'WAIT') && <div style={{ color:"#8b949e", fontSize:"10px" }}>⏳ Waiting...</div>}
                <div style={{ marginTop:"4px", fontSize:"9px", color: marketStatus[i.id]?.open ? "#3fb950" : "#f85149" }}>
                  {marketStatus[i.id]?.open ? "OPEN" : "CLOSED"}
                </div>
              </div>
            );
          })}
          <div style={{ marginTop:"8px", padding:"8px", background:"#161b22", borderRadius:"6px", fontSize:"10px" }}>
            <div style={{ color:"#8b949e", marginBottom:"4px" }}>OPEN POSITIONS</div>
            {openPositions.length === 0
              ? <div style={{ color:"#8b949e" }}>No open trades</div>
              : openPositions.map((p, i) => (
                <div key={i} style={{ marginBottom:"4px", color: p.profit >= 0 ? "#3fb950" : "#f85149" }}>
                  {p.symbol} {p.volume} | {p.profit >= 0 ? "+" : ""}{p.profit?.toFixed(2)}
                </div>
              ))
            }
          </div>
        </div>

        {/* ── MAIN ── */}
        <div style={styles.main}>
          <div style={styles.tabs}>
            {["brain", "live trades", "news", "calendar", "learning", "reports"].map(tab => (
              <div key={tab} style={styles.tab(activeTab === tab)} onClick={() => setActiveTab(tab)}>{tab.toUpperCase()}</div>
            ))}
          </div>
          <div style={styles.content}>
            {showBanner && <div style={styles.alertBanner}>⚠️ {eventAlert.name} — Trading paused 30 min</div>}

            {/* ── BRAIN TAB ── */}
            {activeTab === "brain" && (
              <div>
                <div style={styles.card}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"16px" }}>
                    <div>
                      <div style={{ color:"#8b949e", fontSize:"10px", marginBottom:"4px" }}>CLAUDE'S DECISION — {inst?.label}</div>
                      <div style={{ fontSize:"32px", fontWeight:"900",
                        color: selectedAI.decision === "LONG" ? "#3fb950" : selectedAI.decision === "SHORT" ? "#f85149" : "#8b949e" }}>
                        {aiStatus[selected] === 'thinking' ? '🧠 THINKING...' : selectedAI.decision || 'WAITING'}
                      </div>
                      {selectedAI.marketRead && <div style={{ color:"#8b949e", fontSize:"11px", marginTop:"6px", maxWidth:"400px" }}>{selectedAI.marketRead}</div>}
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ color:"#8b949e", fontSize:"10px" }}>CONFIDENCE</div>
                      <div style={{ fontSize:"28px", fontWeight:"700", color: (selectedAI.confidence || 0) >= 75 ? "#3fb950" : "#e3b341" }}>
                        {selectedAI.confidence || 0}%
                      </div>
                      <div style={{ color:"#8b949e", fontSize:"10px", marginTop:"4px" }}>
                        RISK: <span style={{ color: selectedAI.risk === 'HIGH' ? "#f85149" : selectedAI.risk === 'LOW' ? "#3fb950" : "#e3b341" }}>
                          {selectedAI.risk || "—"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {selectedAI.reason && (
                    <div style={{ background:"#161b22", padding:"12px", borderRadius:"6px", marginBottom:"12px" }}>
                      <div style={{ color:"#8b949e", fontSize:"9px", marginBottom:"4px" }}>CLAUDE'S REASONING</div>
                      <div style={{ color:"#c9d1d9", fontSize:"12px", lineHeight:"1.6" }}>{selectedAI.reason}</div>
                    </div>
                  )}

                  {selectedAI.decision && selectedAI.decision !== 'WAIT' && (
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr", gap:"8px" }}>
                      {[
                        ["ENTRY", prices[selected], "#58a6ff"],
                        ["STOP LOSS", selectedAI.stopLoss, "#f85149"],
                        ["TP1", selectedAI.takeProfit1, "#e3b341"],
                        ["TP2", selectedAI.takeProfit2, "#58a6ff"],
                        ["TP3", selectedAI.takeProfit3, "#3fb950"],
                      ].map(([label, val, color]) => (
                        <div key={label} style={{ background:"#161b22", padding:"8px", borderRadius:"6px" }}>
                          <div style={{ color:"#8b949e", fontSize:"9px" }}>{label}</div>
                          <div style={{ fontWeight:"700", color }}>{val ? fmt(selected, val) : "—"}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Previous decisions */}
                {previousDecisions[selected]?.length > 0 && (
                  <div style={styles.card}>
                    <div style={{ color:"#8b949e", fontSize:"10px", marginBottom:"12px" }}>CLAUDE'S MEMORY — {inst?.label}</div>
                    {[...(previousDecisions[selected] || [])].reverse().map((d, i) => (
                      <div key={i} style={{ background:"#161b22", padding:"8px", borderRadius:"6px", marginBottom:"6px",
                        borderLeft:`3px solid ${d.outcome === 'WIN' ? '#3fb950' : d.outcome === 'LOSS' ? '#f85149' : '#58a6ff'}` }}>
                        <div style={{ display:"flex", justifyContent:"space-between" }}>
                          <span style={{ color: d.decision === 'LONG' ? "#3fb950" : d.decision === 'SHORT' ? "#f85149" : "#8b949e", fontWeight:"700" }}>
                            {d.decision} @ {d.price?.toFixed ? d.price.toFixed(d.price > 100 ? 2 : 4) : d.price}
                          </span>
                          <span style={{ color: d.outcome === 'WIN' ? "#3fb950" : d.outcome === 'LOSS' ? "#f85149" : "#8b949e", fontSize:"11px" }}>
                            {d.outcome ? `${d.outcome} ${d.pnl >= 0 ? '+' : ''}${d.pnl?.toFixed(2)}` : '⏳ open'}
                          </span>
                        </div>
                        <div style={{ color:"#8b949e", fontSize:"10px", marginTop:"4px" }}>{d.reason}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* All instruments overview */}
                <div style={styles.card}>
                  <div style={{ color:"#8b949e", fontSize:"10px", marginBottom:"12px" }}>ALL INSTRUMENTS — CLAUDE'S VIEW</div>
                  {INSTRUMENTS.map(i => {
                    const ai = aiDecisions[i.id];
                    return (
                      <div key={i.id} style={{ background:"#161b22", padding:"10px", borderRadius:"6px", marginBottom:"6px",
                        borderLeft:`3px solid ${ai?.decision === 'LONG' ? '#3fb950' : ai?.decision === 'SHORT' ? '#f85149' : '#21262d'}` }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                          <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
                            <span style={{ color:i.color, fontWeight:"700" }}>{i.label}</span>
                            <span style={styles.badge(ai?.decision || 'WAIT')}>{ai?.decision || 'WAIT'}</span>
                            {ai?.confidence && <span style={{ color:"#8b949e", fontSize:"10px" }}>{ai.confidence}%</span>}
                          </div>
                          <span style={{ color:"#8b949e", fontSize:"10px" }}>{fmt(i.id, prices[i.id])}</span>
                        </div>
                        {ai?.reason && <div style={{ color:"#484f58", fontSize:"10px", marginTop:"4px" }}>{ai.reason}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── LIVE TRADES TAB ── */}
            {activeTab === "live trades" && (
              <div>
                <div style={styles.card}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"12px" }}>
                    <div style={{ color:"#8b949e", fontSize:"10px" }}>OPEN POSITIONS ({openPositions.length})</div>
                    <button onClick={fetchLiveTrades} style={{ background:"#21262d", border:"1px solid #30363d", color:"#c9d1d9", padding:"4px 10px", borderRadius:"4px", cursor:"pointer", fontSize:"10px" }}>Refresh</button>
                  </div>
                  {openPositions.length === 0
                    ? <div style={{ color:"#8b949e", textAlign:"center", padding:"20px" }}>No open positions</div>
                    : openPositions.map((pos, i) => (
                      <div key={i} style={styles.posCard}>
                        <div style={{ display:"flex", justifyContent:"space-between" }}>
                          <div>
                            <span style={{ fontWeight:"700", color:"#58a6ff" }}>{pos.symbol}</span>
                            <span style={{ margin:"0 8px", color: pos.type === "POSITION_TYPE_BUY" ? "#3fb950" : "#f85149", fontWeight:"700" }}>
                              {pos.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL"}
                            </span>
                            <span style={{ color:"#8b949e" }}>{pos.volume} lots</span>
                          </div>
                          <span style={{ fontWeight:"700", color: (pos.profit||0) >= 0 ? "#3fb950" : "#f85149" }}>
                            {(pos.profit||0) >= 0 ? "+" : ""}{(pos.profit||0).toFixed(2)}
                          </span>
                        </div>
                        <div style={{ display:"flex", gap:"16px", marginTop:"6px", fontSize:"10px", color:"#8b949e" }}>
                          <span>Entry: {pos.openPrice}</span>
                          <span>Now: {pos.currentPrice}</span>
                          {pos.stopLoss   && <span style={{ color:"#f85149" }}>SL: {pos.stopLoss}</span>}
                          {pos.takeProfit && <span style={{ color:"#3fb950" }}>TP: {pos.takeProfit}</span>}
                        </div>
                      </div>
                    ))
                  }
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:"12px", marginBottom:"12px" }}>
                  {[
                    ["Win Rate", `${winRate}%`, "#3fb950"],
                    ["Trades", closedTrades.length, "#58a6ff"],
                    ["Net P&L", `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`, totalPnl >= 0 ? "#3fb950" : "#f85149"],
                    ["Today", `${todayPnl >= 0 ? "+" : ""}${todayPnl.toFixed(2)}`, todayPnl >= 0 ? "#3fb950" : "#f85149"],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{ ...styles.card, marginBottom:0, textAlign:"center" }}>
                      <div style={{ color:"#8b949e", fontSize:"10px", marginBottom:"4px" }}>{label}</div>
                      <div style={{ fontWeight:"700", fontSize:"18px", color }}>{val}</div>
                    </div>
                  ))}
                </div>

                <div style={styles.card}>
                  <div style={{ color:"#8b949e", fontSize:"10px", marginBottom:"12px" }}>HISTORY ({closedTrades.length})</div>
                  <div style={{ ...styles.tradeRow, color:"#8b949e", fontSize:"10px", borderBottom:"1px solid #30363d" }}>
                    <span>SYMBOL</span><span>TYPE</span><span>LOTS</span><span>OPEN</span><span>CLOSE</span><span>P&L</span>
                  </div>
                  {closedTrades.length === 0
                    ? <div style={{ color:"#8b949e", textAlign:"center", padding:"20px" }}>No trades yet</div>
                    : closedTrades.slice(0, 50).map((t, i) => (
                      <div key={i} style={styles.tradeRow}>
                        <span style={{ color:"#58a6ff", fontWeight:"700" }}>{t.symbol}</span>
                        <span style={{ color: t.type === "BUY" ? "#3fb950" : "#f85149" }}>{t.type}</span>
                        <span>{t.volume}</span>
                        <span style={{ color:"#8b949e" }}>{t.openPrice ?? "—"}</span>
                        <span>{t.closePrice ?? "—"}</span>
                        <span style={{ fontWeight:"700", color: (t.profit||0) >= 0 ? "#3fb950" : "#f85149" }}>
                          {(t.profit||0) >= 0 ? "+" : ""}{(t.profit||0).toFixed(2)}
                        </span>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}

            {/* ── NEWS TAB ── */}
            {activeTab === "news" && (
              <div>
                {news.length === 0
                  ? <div style={{ ...styles.card, color:"#8b949e", textAlign:"center" }}>Loading news...</div>
                  : news.map((a, i) => (
                    <div key={i} style={{ ...styles.card, marginBottom:"8px" }}>
                      <div style={{ color:"#c9d1d9", fontWeight:"600", marginBottom:"4px" }}>{a.title}</div>
                      <div style={{ color:"#8b949e", fontSize:"10px" }}>{a.source}</div>
                    </div>
                  ))
                }
              </div>
            )}

            {/* ── CALENDAR TAB ── */}
            {activeTab === "calendar" && (
              <div>
                {calendarEvents.length === 0
                  ? <div style={{ ...styles.card, color:"#8b949e", textAlign:"center" }}>Loading calendar...</div>
                  : calendarEvents.map((ev, i) => {
                    const evDate = new Date(ev.date);
                    const isToday = evDate.toDateString() === new Date().toDateString();
                    return (
                      <div key={i} style={{ ...styles.card, marginBottom:"8px", borderLeft:`3px solid ${isToday ? "#f85149" : "#21262d"}` }}>
                        <div style={{ display:"flex", justifyContent:"space-between" }}>
                          <div>
                            <div style={{ fontWeight:"700", color: isToday ? "#f85149" : "#c9d1d9", marginBottom:"4px" }}>{ev.name}</div>
                            <div style={{ color:"#8b949e", fontSize:"10px" }}>{evDate.toLocaleString()} — {ev.country}</div>
                          </div>
                          <div style={{ textAlign:"right", fontSize:"10px" }}>
                            {ev.forecast && <div style={{ color:"#e3b341" }}>Forecast: {ev.forecast}</div>}
                            {ev.previous && <div style={{ color:"#8b949e" }}>Previous: {ev.previous}</div>}
                          </div>
                        </div>
                      </div>
                    );
                  })
                }
              </div>
            )}

            {/* ── LEARNING TAB ── */}
            {activeTab === "learning" && (
              <div>
                <div style={styles.card}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"16px" }}>
                    <div>
                      <div style={{ color:"#58a6ff", fontWeight:"900", fontSize:"16px" }}>🧠 QUANTUM BRAIN MEMORY</div>
                      <div style={{ color:"#8b949e", fontSize:"10px", marginTop:"2px" }}>Every trade Claude takes gets recorded here</div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ color:"#8b949e", fontSize:"10px" }}>PATTERNS</div>
                      <div style={{ fontSize:"24px", fontWeight:"700", color:"#3fb950" }}>{Object.keys(learnedStats).length}</div>
                    </div>
                  </div>
                  {Object.keys(learnedStats).length === 0 ? (
                    <div style={{ color:"#8b949e", textAlign:"center", padding:"40px" }}>
                      <div style={{ fontSize:"40px", marginBottom:"12px" }}>🧠</div>
                      <div>No patterns yet — Claude learns after each trade</div>
                    </div>
                  ) : (
                    Object.entries(learnedStats)
                      .filter(([, d]) => d.total >= 2)
                      .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0))
                      .map(([fp, data]) => {
                        const parts = fp.split(':');
                        const wr    = data.winRate || 0;
                        const color = wr >= 70 ? "#3fb950" : wr >= 50 ? "#e3b341" : "#f85149";
                        return (
                          <div key={fp} style={{ background:"#161b22", border:`1px solid ${color}30`, borderRadius:"8px", padding:"12px", marginBottom:"8px" }}>
                            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"6px" }}>
                              <div style={{ display:"flex", gap:"6px", flexWrap:"wrap", alignItems:"center" }}>
                                <span style={{ fontWeight:"700", color: parts[0]==='GBPUSD'?"#00D4AA":parts[0]==='BTCUSDT'?"#F7931A":"#FFD700" }}>{parts[0]}</span>
                                <span style={{ color: parts[1]==='LONG'?"#3fb950":"#f85149", fontWeight:"700" }}>{parts[1]}</span>
                                <span style={{ background:"#21262d", padding:"1px 6px", borderRadius:"4px", fontSize:"10px" }}>{parts[2]} H4</span>
                                <span style={{ background:"#21262d", padding:"1px 6px", borderRadius:"4px", fontSize:"10px" }}>{parts[6]}</span>
                              </div>
                              <div style={{ textAlign:"right" }}>
                                <div style={{ fontSize:"18px", fontWeight:"900", color }}>{wr}%</div>
                              </div>
                            </div>
                            <div style={{ display:"flex", gap:"12px", fontSize:"10px", color:"#8b949e" }}>
                              <span>✅ {data.wins}</span><span>❌ {data.losses}</span><span>📊 {data.total}</span>
                              {data.avgPips && <span style={{ color: data.avgPips > 0 ? "#3fb950" : "#f85149" }}>avg {data.avgPips > 0 ? "+" : ""}{data.avgPips}</span>}
                            </div>
                            <div style={{ marginTop:"6px", background:"#21262d", borderRadius:"3px", height:"3px" }}>
                              <div style={{ height:"100%", borderRadius:"3px", width:`${wr}%`, background:color }} />
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>
              </div>
            )}

            {/* ── REPORTS TAB ── */}
            {activeTab === "reports" && (
              <div>
                <div style={styles.card}>
                  <div style={{ color:"#58a6ff", fontWeight:"900", fontSize:"16px", marginBottom:"16px" }}>📊 TRADE REPORTS</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:"12px", marginBottom:"16px" }}>
                    {[
                      ["Total", tradeReports.analytics?.totalTrades || 0, "#58a6ff"],
                      ["P&L", `$${(tradeReports.analytics?.totalPnl || 0).toFixed(2)}`, (tradeReports.analytics?.totalPnl || 0) >= 0 ? "#3fb950" : "#f85149"],
                      ["Avg", `$${(tradeReports.analytics?.avgPnl || 0).toFixed(2)}`, "#e3b341"],
                      ["SL Hits", tradeReports.analytics?.slHitCount || 0, "#f85149"],
                    ].map(([label, val, color]) => (
                      <div key={label} style={{ background:"#161b22", padding:"12px", borderRadius:"6px", textAlign:"center" }}>
                        <div style={{ color:"#8b949e", fontSize:"9px", marginBottom:"4px" }}>{label}</div>
                        <div style={{ fontWeight:"700", fontSize:"18px", color }}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"12px" }}>
                    {[
                      ["TP1 50%", tradeReports.analytics?.tp1Count || 0, tradeReports.analytics?.tp1Pct || 0, "#e3b341"],
                      ["TP2 30%", tradeReports.analytics?.tp2Count || 0, tradeReports.analytics?.tp2Pct || 0, "#58a6ff"],
                      ["TP3 20%", tradeReports.analytics?.tp3Count || 0, tradeReports.analytics?.tp3Pct || 0, "#3fb950"],
                    ].map(([label, count, pct, color]) => (
                      <div key={label} style={{ background:"#161b22", padding:"12px", borderRadius:"6px" }}>
                        <div style={{ color:"#8b949e", fontSize:"9px", marginBottom:"6px" }}>{label}</div>
                        <div style={{ fontWeight:"900", fontSize:"28px", color }}>{pct}%</div>
                        <div style={{ color:"#8b949e", fontSize:"10px" }}>{count} trades</div>
                        <div style={{ marginTop:"6px", background:"#21262d", borderRadius:"3px", height:"4px" }}>
                          <div style={{ height:"100%", borderRadius:"3px", width:`${pct}%`, background:color }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={styles.card}>
                  <div style={{ color:"#8b949e", fontSize:"10px", marginBottom:"12px" }}>TRADE DETAIL LOG</div>
                  {(!tradeReports.reports || tradeReports.reports.length === 0)
                    ? <div style={{ color:"#8b949e", textAlign:"center", padding:"30px" }}>No reports yet</div>
                    : tradeReports.reports.map((r, i) => (
                      <div key={i} style={{ background:"#161b22", borderRadius:"6px", padding:"12px", marginBottom:"8px",
                        borderLeft:`3px solid ${r.finalExit === 'FULL_CLOSE_TP3' ? '#3fb950' : r.finalExit === 'SL_HIT' ? '#f85149' : '#e3b341'}` }}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"6px" }}>
                          <div>
                            <span style={{ fontWeight:"700", color:"#c9d1d9" }}>{(r.symbol||'').replace('.s','')}</span>
                            <span style={{ margin:"0 8px", color: r.direction==="LONG"?"#3fb950":"#f85149", fontWeight:"700" }}>{r.direction}</span>
                          </div>
                          <span style={{ fontWeight:"700", color:(r.totalPnl||0)>=0?"#3fb950":"#f85149" }}>
                            {(r.totalPnl||0)>=0?"+":""}${(r.totalPnl||0).toFixed(2)}
                          </span>
                        </div>
                        <div style={{ display:"flex", gap:"6px", flexWrap:"wrap" }}>
                          {(r.events||[]).map((ev, j) => (
                            <span key={j} style={{ padding:"2px 8px", borderRadius:"10px", fontSize:"10px",
                              background: ev.type.includes('TP3')?"rgba(63,185,80,0.15)":ev.type.includes('TP2')?"rgba(88,166,255,0.15)":"rgba(227,179,65,0.15)",
                              color: ev.type.includes('TP3')?"#3fb950":ev.type.includes('TP2')?"#58a6ff":"#e3b341" }}>
                              {ev.type==='PARTIAL_CLOSE_TP1'?'🎯 TP1':ev.type==='PARTIAL_CLOSE_TP2'?'🎯 TP2':ev.type==='FULL_CLOSE_TP3'?'🏆 TP3':ev.type}
                              {ev.pnl ? ` +$${ev.pnl?.toFixed(2)}` : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── LOG PANEL ── */}
        <div style={styles.logPanel}>
          <div style={styles.logHeader}>SYSTEM LOG — V5</div>
          <div style={styles.logBody} ref={logRef}>
            {log.map((entry, i) => (
              <div key={i} style={styles.logEntry(entry.type)}>
                <span style={{ color:"#484f58", marginRight:"6px" }}>{entry.time}</span>{entry.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}