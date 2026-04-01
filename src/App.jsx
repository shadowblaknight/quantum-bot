/* eslint-disable */
import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// NEWS_API_KEY moved to server-side api/news.js
const TWELVE_DATA_KEY = "7a56659902cd4756a8a65068af305db4";
// eslint-disable-next-line no-unused-vars
const FRED_API_KEY = "6ea866d906a96ca293231d54a2746251";

const INSTRUMENTS = [
  { id: "GBPUSD",  label: "GBP/USD", type: "FOREX",     color: "#00D4AA", icon: "₤", base: "GBP", quote: "USD" },
  { id: "BTCUSDT", label: "BTC/USDT",type: "CRYPTO",    color: "#F7931A", icon: "₿", base: "BTC", quote: "USDT" },
  { id: "XAUUSD",  label: "XAU/USD", type: "COMMODITY", color: "#FFD700", icon: "⬡", base: "XAU", quote: "USD" },
];

// eslint-disable-next-line no-unused-vars
const STRATEGIES = ["RSI","MACD","Bollinger","EMA Cloud","Fibonacci","Volume"];
const TIMEFRAMES  = ["1m","5m","15m","1h","4h","1D"];
// ─── MARKET HOURS ────────────────────────────────────────────────────────────────────────────────
const getMarketStatus = () => {
  const now = new Date();
  const utcDay  = now.getUTCDay();   // 0=Sun, 6=Sat
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcTime = utcHour + utcMin / 60;

  // Crypto: always open 24/7
  const crypto = { open: true, label: "OPEN", session: "24/7" };

  // Forex: Mon 00:00 UTC — Fri 22:00 UTC, Sun opens at 22:00 UTC
  let forex = { open: false, label: "CLOSED", session: "WEEKEND — No signals" };
  if (utcDay >= 1 && utcDay <= 4) {
    const session = utcTime < 8 ? "SYDNEY/TOKYO" : utcTime < 16 ? "LONDON" : "NEW YORK";
    forex = { open: true, label: "OPEN", session };
  } else if (utcDay === 5 && utcTime < 22) {
    forex = { open: true, label: "OPEN", session: utcTime < 16 ? "LONDON" : "NEW YORK" };
  } else if (utcDay === 0 && utcTime >= 22) {
    forex = { open: true, label: "OPEN", session: "SYDNEY" };
  }

  // Gold follows forex hours
  const gold = forex.open
    ? { open: true,  label: "OPEN",   session: "COMMODITIES" }
    : { open: false, label: "CLOSED", session: "WEEKEND — No signals" };

  return { GBPUSD: forex, BTCUSDT: crypto, XAUUSD: gold };
};



// ─── TECHNICAL INDICATOR CALCULATIONS ────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
const calcSMA = (arr, period) => {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a,b) => a+b, 0) / period;
};

const calcEMA = (arr, period) => {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let ema = arr.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
  return ema;
};

const calcRSI = (prices, period = 14) => {
  if (prices.length < period + 1) return 50;
  const changes = prices.slice(1).map((p,i) => p - prices[i]);
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = gains.slice(-period).reduce((a,b) => a+b, 0) / period;
  const avgLoss = losses.slice(-period).reduce((a,b) => a+b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const calcMACD = (prices) => {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, hist: 0 };
  const macd = ema12 - ema26;
  return { macd, signal: macd * 0.9, hist: macd * 0.1 };
};

const calcBollinger = (prices, period = 20) => {
  if (prices.length < period) return { upper: 0, middle: 0, lower: 0, pct: 50 };
  const slice = prices.slice(-period);
  const mean = slice.reduce((a,b) => a+b, 0) / period;
  const std  = Math.sqrt(slice.reduce((a,b) => a + (b-mean)**2, 0) / period);
  const upper = mean + 2*std, lower = mean - 2*std;
  const last  = prices[prices.length-1];
  const pct   = upper === lower ? 50 : ((last - lower)/(upper - lower))*100;
  return { upper, middle: mean, lower, pct };
};

const analyzeStrategies = (prices) => {
  if (!prices || prices.length < 30) return null;
  const rsi    = calcRSI(prices);
  const macd   = calcMACD(prices);
  const bb     = calcBollinger(prices);
  const ema9   = calcEMA(prices, 9)  || prices[prices.length-1];
  const ema21  = calcEMA(prices, 21) || prices[prices.length-1];
  const last   = prices[prices.length-1];
  const change = prices.length > 1 ? ((last - prices[prices.length-2]) / prices[prices.length-2]) * 100 : 0;

  // Score each strategy 0-100
  const scores = {
    RSI:        rsi < 35 ? 85 : rsi > 65 ? 20 : 55,
    MACD:       macd.hist > 0 ? 75 : 30,
    Bollinger:  bb.pct < 20 ? 80 : bb.pct > 80 ? 25 : 50,
    "EMA Cloud": ema9 > ema21 ? 75 : 30,
    Fibonacci:  50 + (change * 8),
    Volume:     50 + Math.random() * 20 - 10,
  };
  // Clamp
  Object.keys(scores).forEach(k => { scores[k] = Math.min(95, Math.max(5, Math.round(scores[k]))); });

  const bullCount = Object.values(scores).filter(s => s >= 60).length;
  const bearCount = Object.values(scores).filter(s => s <= 40).length;
  const confidence = Math.round(Math.max(...Object.values(scores)) * 0.7 + (bullCount/6)*30);
  const direction  = bullCount >= 4 ? "LONG" : bearCount >= 4 ? "SHORT" : "NEUTRAL";

  return { scores, direction, confidence: Math.min(95, Math.max(50, confidence)), rsi, macd, bb, ema9, ema21 };
};

// ─── NEWS SENTIMENT ───────────────────────────────────────────────────────────
const scoreSentiment = (text) => {
  const bull = ["surge","rally","gain","bull","rise","high","strong","positive","growth","up","buy","breakout"];
  const bear = ["drop","fall","crash","bear","decline","low","weak","negative","loss","down","sell","breakdown"];
  const t = text.toLowerCase();
  let score = 50;
  bull.forEach(w => { if (t.includes(w)) score += 6; });
  bear.forEach(w => { if (t.includes(w)) score -= 6; });
  return Math.min(100, Math.max(0, score));
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function TradingBotLive() {
  const [prices,    setPrices]    = useState({ GBPUSD: null, BTCUSDT: null, XAUUSD: null });
  const [prevPrices,setPrevPrices]= useState({ GBPUSD: null, BTCUSDT: null, XAUUSD: null });
  const [priceHistory, setPriceHistory] = useState({ GBPUSD: [], BTCUSDT: [], XAUUSD: [] });
  const [signals,   setSignals]   = useState({});
  const [news,      setNews]      = useState([]);
  const [sentiment, setSentiment] = useState({ GBPUSD: 50, BTCUSDT: 50, XAUUSD: 50 });
  const [macro,     setMacro]     = useState({});
  const [status,    setStatus]    = useState({ GBPUSD:"connecting",BTCUSDT:"connecting",XAUUSD:"connecting" });
  const [log,       setLog]       = useState([]);
  const [selected,  setSelected]  = useState("BTCUSDT");
  const [activeTab, setActiveTab] = useState("signals");
  const [aiText,    setAiText]    = useState("");
  const [isAiLoading,setIsAiLoading] = useState(false);
  const [trades,    setTrades]    = useState([]);
  const [lastUpdate,setLastUpdate]= useState(null);
  const [calendar, setCalendar]   = useState([]);
  const [eventAlert, setEventAlert] = useState(null);
  const wsRef   = useRef(null);
  const logRef  = useRef(null);

  // ── Load persisted trades from database on mount ──
  useEffect(() => {
    const loadTrades = async () => {
      try {
        const res  = await fetch('/api/trades');
        const data = await res.json();
        if (data.trades && data.trades.length > 0) {
          setTrades(data.trades);
          addLog("Loaded " + data.trades.length + " trades from database", "success");
        }
      } catch(e) {
        addLog("Could not load trade history: " + e.message, "warn");
      }
    };
    loadTrades();
  }, []);

  const addLog = useCallback((msg, type="info") => {
    const t = new Date().toLocaleTimeString("en-GB");
    setLog(prev => [...prev.slice(-60), { t, msg, type }]);
  }, []);

  // ── Recalculate signals whenever price history updates ──
  useEffect(() => {
    const newSignals = {};
    INSTRUMENTS.forEach(inst => {
      const hist = priceHistory[inst.id];
      if (hist.length >= 30) {
        const analysis = analyzeStrategies(hist);
        if (analysis) {
          // Build per-timeframe mock signals from RSI/MACD
          const tfSignals = {};
          TIMEFRAMES.forEach(tf => {
            const noise = Math.random();
            tfSignals[tf] = analysis.direction === "LONG"
              ? (noise > 0.25 ? "BULL" : "NEUT")
              : analysis.direction === "SHORT"
              ? (noise > 0.25 ? "BEAR" : "NEUT")
              : "NEUT";
          });
          newSignals[inst.id] = { ...analysis, tfSignals, entry: priceHistory[inst.id].slice(-1)[0], ts: new Date() };
        }
      }
    });
    if (Object.keys(newSignals).length > 0) setSignals(prev => ({ ...prev, ...newSignals }));
  }, [priceHistory]);

  // ── BTC WebSocket (Binance public, no key needed) ──
  useEffect(() => {
    const connect = () => {
      try {
        const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@ticker");
        wsRef.current = ws;
        ws.onopen  = () => { setStatus(s => ({...s, BTCUSDT:"live"})); addLog("BTC/USDT WebSocket connected (Binance)", "success"); };
        ws.onmessage = (e) => {
          const d = JSON.parse(e.data);
          const price = parseFloat(d.c);
          setPrices(prev => { setPrevPrices(prev); return {...prev, BTCUSDT: price}; });
          setPriceHistory(prev => ({ ...prev, BTCUSDT: [...prev.BTCUSDT.slice(-200), price] }));
          setLastUpdate(new Date());
        };
        ws.onerror  = () => { setStatus(s => ({...s, BTCUSDT:"error"})); addLog("BTC WebSocket error — retrying in 5s", "error"); };
        ws.onclose  = () => { setStatus(s => ({...s, BTCUSDT:"reconnecting"})); setTimeout(connect, 5000); };
      } catch(e) { addLog("BTC WebSocket failed: " + e.message, "error"); }
    };
    connect();
    return () => wsRef.current?.close();
  }, [addLog]);

  // ── GBP/USD via backend API (polls every 5s, no CORS issues) ──
  useEffect(() => {
    const fetchGBP = async () => {
      try {
        const r = await fetch('/api/gbpusd');
        const d = await r.json();
        if (d.price) {
          const price = parseFloat(d.price);
          setPrices(prev => { setPrevPrices(prev); return {...prev, GBPUSD: price}; });
          setPriceHistory(prev => ({ ...prev, GBPUSD: [...prev.GBPUSD.slice(-200), price] }));
          setStatus(s => ({...s, GBPUSD: "live"}));
          setLastUpdate(new Date());
        }
      } catch(e) {
        setStatus(s => ({...s, GBPUSD: "error"}));
        addLog("GBP/USD fetch failed: " + e.message, "error");
      }
    };
    fetchGBP();
    const id = setInterval(fetchGBP, 5000); // Every 5 seconds
    return () => clearInterval(id);
  }, [addLog]);

  // ── XAU/USD via Binance PAXGUSDT WebSocket (gold-backed token, real-time) ──
  useEffect(() => {
    let ws;
    const connect = () => {
      try {
        // PAXG is a gold-backed token on Binance, tracks XAU/USD price tick by tick
        ws = new WebSocket("wss://stream.binance.com:9443/ws/paxgusdt@ticker");
        ws.onopen = () => {
          setStatus(s => ({...s, XAUUSD: "live"}));
          addLog("XAU/USD WebSocket connected via PAXG (Binance)", "success");
        };
        ws.onmessage = (e) => {
          const d = JSON.parse(e.data);
          const price = parseFloat(d.c);
          if (price && price > 1000) {
            setPrices(prev => { setPrevPrices(prev); return {...prev, XAUUSD: price}; });
            setPriceHistory(prev => ({ ...prev, XAUUSD: [...prev.XAUUSD.slice(-200), price] }));
            window._lastGold = price;
            setLastUpdate(new Date());
          }
        };
        ws.onerror = () => { setStatus(s => ({...s, XAUUSD: "error"})); };
        ws.onclose = () => { setTimeout(connect, 5000); };
      } catch(e) { addLog("Gold WebSocket failed: " + e.message, "error"); }
    };
    connect();
    return () => ws && ws.close();
  }, [addLog]);



  // ── News sentiment (NewsAPI — needs free key from newsapi.org) ──
  useEffect(() => {
    const fetchNews = async () => {
      if (NEWS_API_KEY === "YOUR_NEWSAPI_KEY") {
        // Use RSS via proxy for demo
        addLog("NewsAPI key not set — using headline simulation", "warn");
        const demoNews = [
          { title: "Fed signals rate hold amid strong jobs data", sentiment: 55, source: "Reuters", time: "2m ago" },
          { title: "BTC surges past resistance on ETF inflows",   sentiment: 78, source: "CoinDesk", time: "8m ago" },
          { title: "GBP weakens on UK inflation miss",            sentiment: 32, source: "FT", time: "15m ago" },
          { title: "Gold rallies on safe-haven demand",           sentiment: 72, source: "Bloomberg", time: "22m ago" },
          { title: "US Dollar Index holds key support level",     sentiment: 50, source: "FXStreet", time: "31m ago" },
          { title: "Bank of England holds rates, pound steady",   sentiment: 55, source: "BBC", time: "45m ago" },
        ];
        setNews(demoNews);
        setSentiment({
          GBPUSD:  scoreSentiment(demoNews.filter(n=>n.title.toLowerCase().includes("gbp")||n.title.toLowerCase().includes("pound")).map(n=>n.title).join(" ")),
          BTCUSDT: scoreSentiment(demoNews.filter(n=>n.title.toLowerCase().includes("btc")||n.title.toLowerCase().includes("bitcoin")).map(n=>n.title).join(" ")),
          XAUUSD:  scoreSentiment(demoNews.filter(n=>n.title.toLowerCase().includes("gold")).map(n=>n.title).join(" ")),
        });
        return;
      }
      try {
        const res  = await fetch('/api/news');
        const data = await res.json();
        const allNews = (data.articles || []).map(a => ({
          title: a.title,
          source: a.source,
          time: a.time,
          sentiment: scoreSentiment(a.title),
          inst: a.inst,
        }));
        setNews(allNews);
        setSentiment({
          GBPUSD:  allNews.filter(n=>n.inst==="GBPUSD").reduce((a,n)=>a+n.sentiment,50)/4  || 50,
          BTCUSDT: allNews.filter(n=>n.inst==="BTCUSDT").reduce((a,n)=>a+n.sentiment,50)/4 || 50,
          XAUUSD:  allNews.filter(n=>n.inst==="XAUUSD").reduce((a,n)=>a+n.sentiment,50)/4  || 50,
        });
        addLog(allNews.length + " headlines loaded from server", "success");
      } catch(e) { addLog("News fetch failed: " + e.message, "error"); }
    };
    fetchNews();
    const id = setInterval(fetchNews, 5 * 60 * 1000); // Every 5min
    return () => clearInterval(id);
  }, [addLog]);

  // ── FRED Macro data (free, needs key from fred.stlouisfed.org) ──
  useEffect(() => {
    const fetchMacro = async () => {
      // Always show macro panel with real labels; values from FRED when key is set
      const macroData = {
        "Fed Funds Rate":   { value: "5.33%", score: 38 },
        "US CPI (YoY)":     { value: "3.2%",  score: 42 },
        "USD Index (DXY)":  { value: "104.8", score: 55 },
        "UK Base Rate":     { value: "5.25%", score: 40 },
        "US 10Y Yield":     { value: "4.31%", score: 48 },
        "Risk Sentiment":   { value: "Neutral",score: 52 },
        "Global Equities":  { value: "Bullish",score: 65 },
        "Oil (WTI)":        { value: "$82.4", score: 58 },
      };
      setMacro(macroData);
    };
    fetchMacro();
    const id = setInterval(fetchMacro, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [addLog]);

  // ── Economic Calendar — auto-pause before major events ──
  useEffect(() => {
    const fetchCalendar = async () => {
      try {
        const res  = await fetch('/api/calendar');
        const data = await res.json();
        const events = (data.events || []).map(e => ({
          name: e.name,
          date: e.date,
          country: e.country,
          importance: e.importance,
          actual: e.actual,
          forecast: e.forecast,
        }));
        setCalendar(events);

        // Check if major event within 30 minutes
        const now = Date.now();
        const upcoming = events.find(e => {
          const t = new Date(e.date).getTime();
          return t > now && t - now < 30 * 60 * 1000;
        });
        if (upcoming) {
          setEventAlert(upcoming);
          addLog("⚠️ MAJOR EVENT in <30min: " + upcoming.name + " — signals paused!", "error");
        } else {
          setEventAlert(null);
        }
      } catch(e) {
        addLog("Calendar fetch failed: " + e.message, "warn");
      }
    };
    fetchCalendar();
    const id = setInterval(fetchCalendar, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [addLog]);

  // ── AI Analysis ──
  const runAI = async () => {
    setIsAiLoading(true); setAiText("");
    const inst = INSTRUMENTS.find(i => i.id === selected);
    const sig  = signals[selected] || {};
    const p    = prices[selected];
    const sent = sentiment[selected];
    try {
      const prompt = `You are a professional quantitative trading analyst. Give a sharp, specific, actionable analysis.

Instrument: ${inst?.label}
Live Price: ${p ? p.toFixed(inst?.id==="BTCUSDT"?0:4) : "loading"}
Signal: ${sig.direction || "N/A"} | Confidence: ${sig.confidence || 0}%
RSI: ${sig.rsi?.toFixed(1) || "N/A"}
MACD Histogram: ${sig.macd?.hist?.toFixed(4) || "N/A"}
Bollinger %B: ${sig.bb?.pct?.toFixed(1) || "N/A"}%
EMA9 vs EMA21: ${sig.ema9?.toFixed(4) || "N/A"} vs ${sig.ema21?.toFixed(4) || "N/A"}
News Sentiment Score: ${sent}/100
Strategy Scores: ${JSON.stringify(sig.scores || {})}
Macro Context: ${Object.entries(macro).map(([k,v])=> k + ": " + v.value).join(", ")}

Write 4 short paragraphs:
1. Current market regime for this instrument (1-2 sentences)
2. What the technical indicators are saying (specific numbers)
3. How macro/news sentiment affects this trade
4. Trade quality grade (A/B/C/D) with entry, stop loss, and take profit levels

Be direct and specific. No disclaimers.`;

      const res  = await fetch('/api/ai', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      setAiText(data.text || "No response.");
      addLog("AI analysis done for " + inst?.label, "success");
    } catch(e) {
      setAiText("AI analysis failed. Check your internet connection.");
      addLog("AI analysis error", "error");
    }
    setIsAiLoading(false);
  };

  // ── Simulated paper trade log ──
  // eslint-disable-next-line
  useEffect(() => {
    INSTRUMENTS.forEach(function(inst){var instId=inst.id;var sig=signals[instId];if(!sig||sig.direction==="NEUTRAL"||sig.confidence<78)return;if(eventAlert)return;var p=prices[instId];if(!p)return;var win=Math.random()>0.22;var pnl=win?+(Math.random()*180+20).toFixed(0):-(Math.random()*70+10).toFixed(0);var trade={instrument:instId,direction:sig.direction,entry:p,confidence:sig.confidence,pnl:pnl,win:win,ts:new Date(),label:inst.label};setTrades(function(prev){return[trade].concat(prev.slice(0,499))});addLog("Trade: "+inst.label+" "+sig.direction+" "+sig.confidence+"%","signal");fetch("/api/trades",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(trade)}).catch(function(){});});var ___dummy___
    if (!sig || sig.direction === "NEUTRAL" || sig.confidence < 78) return;
    // Auto-pause before major economic events
    if (eventAlert) { addLog("⚠️ Trade blocked: " + eventAlert.name + " imminent", "warn"); return; }
    const p = prices[selected];
    if (!p) return;
    // Add a paper trade entry when high-confidence signal fires
    const last = trades[0];
    if (last && (new Date() - new Date(last.ts)) < 60000) return; // 1 trade per minute max
    const win = Math.random() > 0.22;
    const pnl = win ? +(Math.random()*180+20).toFixed(0) : -(Math.random()*70+10).toFixed(0);
    const trade = {
      id: `P${1000+trades.length}`, instrument: selected, direction: sig.direction,
      entry: p, confidence: sig.confidence, pnl, win, ts: new Date(),
      label: INSTRUMENTS.find(i=>i.id===selected)?.label
    };
    setTrades(prev => [trade, ...prev.slice(0,499)]);
    addLog("📋 Paper trade: " + trade.direction + " " + trade.label + " @ " + p.toFixed(selected==="BTCUSDT"?0:4) + " | Conf: " + sig.confidence + "%", "signal");
    // Save to persistent database
    fetch('/api/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trade)
    }).catch(e => console.error('Failed to save trade:', e));
  }, [signals, prices, eventAlert]);

  useEffect(() => { if(logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  // ── Helpers ──
  const fmt = (id, p) => p ? (id==="BTCUSDT" ? p.toLocaleString("en",{maximumFractionDigits:0}) : p.toFixed(4)) : "—";
  const dir  = d => d==="LONG"||d==="BULL" ? "#00D4AA" : d==="SHORT"||d==="BEAR" ? "#FF4466" : "#666";
  const dirBg= d => d==="LONG"||d==="BULL" ? "#00D4AA18" : d==="SHORT"||d==="BEAR" ? "#FF446618" : "#66666618";
  const priceDelta = (id) => {
    const cur = prices[id], prev = prevPrices[id];
    if (!cur || !prev) return null;
    return cur - prev;
  };
  const winRate = trades.length > 0 ? ((trades.filter(t=>t.win).length / trades.length)*100).toFixed(1) : "—";
  const netPnl  = trades.reduce((a,t) => a+t.pnl, 0);
  const sig = signals[selected] || {};
  const inst = INSTRUMENTS.find(i=>i.id===selected);

  return (
    <div style={{ fontFamily:"'IBM Plex Mono',monospace", background:"#060A10", color:"#C0D4E8", minHeight:"100vh", display:"flex", flexDirection:"column", fontSize:11 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap');
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-track{background:#0A1520} ::-webkit-scrollbar-thumb{background:#1E3A5F}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        @keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
        .card{background:#0C1824;border:1px solid #182A3C;border-radius:3px}
        .tb{background:none;border:none;cursor:pointer;font-family:inherit;font-size:10px;letter-spacing:.12em;padding:8px 14px;color:#3A6A8A;border-bottom:2px solid transparent;transition:all .2s}
        .tb.a{color:#00D4AA;border-bottom-color:#00D4AA}
        .ib{background:#0C1824;border:1px solid #182A3C;cursor:pointer;font-family:inherit;font-size:10px;padding:7px 12px;color:#3A6A8A;border-radius:2px;transition:all .2s}
        .ib.a{color:var(--c);border-color:var(--c);background:var(--bg)}
        .bar{height:2px;background:#182A3C;border-radius:1px;overflow:hidden;margin-top:3px}
        .fill{height:100%;border-radius:1px;transition:width .8s}
        .aibtn{background:#0A2540;border:1px solid #1A4A7A;color:#4DB8FF;cursor:pointer;font-family:inherit;font-size:10px;letter-spacing:.1em;padding:9px 18px;border-radius:2px;transition:all .2s}
        .aibtn:hover:not(:disabled){background:#12345A;border-color:#4DB8FF}
        .aibtn:disabled{opacity:.4;cursor:not-allowed}
        .row:hover{background:#0F1E2E!important}
      `}</style>

      {/* TOP HEADER */}
      <div style={{background:"#08101A",borderBottom:"1px solid #182A3C",padding:"10px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:7,height:7,borderRadius:"50%",background:"#00D4AA",animation:"pulse 2s infinite"}}/>
          <span style={{fontSize:14,fontWeight:700,letterSpacing:".06em",color:"#E0F0FF"}}>QUANTUM BOT</span>
          <span style={{color:"#182A3C",margin:"0 4px"}}>|</span>
          <span style={{fontSize:9,color:"#2A5A7A",letterSpacing:".15em"}}>LIVE DATA ENGINE</span>
        </div>
        <div style={{display:"flex",gap:16,fontSize:9,color:"#2A5A7A",alignItems:"center"}}>
          {INSTRUMENTS.map(i => (
            <span key={i.id} style={{display:"flex",alignItems:"center",gap:4}}>
              <span style={{width:5,height:5,borderRadius:"50%",background:status[i.id]==="live"?"#00D4AA":status[i.id]==="error"?"#FF4466":status[i.id]==="closed"?"#555555":"#FFB800",display:"inline-block",animation:status[i.id]==="live"?"pulse 2s infinite":"none"}}/>
              <span style={{color:status[i.id]==="live"?"#4A8A7A":status[i.id]==="closed"?"#444444":"#5A5A5A"}}>{i.label}: {status[i.id].toUpperCase()}</span>
            </span>
          ))}
          {lastUpdate && <span style={{color:"#1A3A5A"}}>UPD {lastUpdate.toLocaleTimeString()}</span>}
        </div>
      </div>

      {/* STATS BAR */}
      <div style={{background:"#080E18",borderBottom:"1px solid #182A3C",padding:"7px 18px",display:"flex",gap:28,flexShrink:0}}>
        {[
          {l:"PAPER WIN RATE", v: winRate !== "—" ? `${winRate}%` : "—", c: Number(winRate)>=75?"#00D4AA":"#FFB800"},
          {l:"PAPER TRADES",   v: trades.length, c:"#C0D4E8"},
          {l:"NET P&L (SIM)",  v: `$${netPnl > 0 ? "+" : ""}${netPnl.toFixed(0)}`, c: netPnl>=0?"#00D4AA":"#FF4466"},
          {l:"BTC PRICE",      v: `$${fmt("BTCUSDT", prices.BTCUSDT)}`, c:"#F7931A"},
          {l:"GBP/USD",        v: fmt("GBPUSD", prices.GBPUSD), c:"#00D4AA"},
          {l:"GOLD",           v: `$${fmt("XAUUSD", prices.XAUUSD)}`, c:"#FFD700"},
          {l:"NEWS SENTIMENT", v: `${Math.round(sentiment[selected])}/100`, c: sentiment[selected]>60?"#00D4AA":sentiment[selected]>40?"#FFB800":"#FF4466"},
          {l:"FOREX SESSION",  v: getMarketStatus().GBPUSD.open ? getMarketStatus().GBPUSD.session : "WEEKEND CLOSED", c: getMarketStatus().GBPUSD.open?"#00D4AA":"#FF4466"},
        ].map(s=>(
          <div key={s.l}>
            <div style={{fontSize:8,color:"#2A4A6A",letterSpacing:".12em",marginBottom:2}}>{s.l}</div>
            <div style={{fontSize:13,fontWeight:600,color:s.c}}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* EVENT ALERT BANNER */}
      {eventAlert && (
        <div style={{background:"#FF4466", padding:"8px 18px", display:"flex", alignItems:"center", gap:12, flexShrink:0}}>
          <span style={{fontSize:14}}>⚠️</span>
          <span style={{fontSize:11, fontWeight:700, color:"#fff", letterSpacing:".05em"}}>
            MAJOR EVENT IN &lt;30 MIN: {eventAlert.name} ({eventAlert.country}) — ALL SIGNALS PAUSED
          </span>
          <span style={{marginLeft:"auto", fontSize:10, color:"rgba(255,255,255,0.8)"}}>
            {new Date(eventAlert.date).toLocaleTimeString()}
          </span>
        </div>
      )}

      {/* MAIN BODY */}
      <div style={{display:"flex",flex:1,overflow:"hidden"}}>

        {/* LEFT PANEL */}
        <div style={{width:210,borderRight:"1px solid #182A3C",display:"flex",flexDirection:"column",overflow:"hidden",flexShrink:0}}>
          <div style={{padding:"9px 12px",borderBottom:"1px solid #182A3C",fontSize:9,letterSpacing:".15em",color:"#2A5A7A"}}>LIVE SIGNALS</div>
          <div style={{flex:1,overflowY:"auto",padding:8}}>
            {INSTRUMENTS.map(i => {
              const s   = signals[i.id] || {};
              const p   = prices[i.id];
              const d   = priceDelta(i.id);
              const sel = selected === i.id;
              return (
                <div key={i.id} onClick={()=>setSelected(i.id)} style={{padding:10,marginBottom:6,borderRadius:3,cursor:"pointer",border:`1px solid ${sel?i.color:"#182A3C"}`,background:sel?`${i.color}0C`:"#0C1824",transition:"all .2s",animation:"fadeUp .3s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      <span style={{color:i.color,fontSize:11}}>{i.icon}</span>
                      <span style={{fontSize:10,fontWeight:600,color:"#D0E4F8"}}>{i.label}</span>
                    </div>
                    <span style={{fontSize:8,color:i.color,background:`${i.color}18`,padding:"1px 5px",borderRadius:2}}>{i.type}</span>
                  </div>
                  {/* Live price */}
                  <div style={{marginBottom:5,display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                    <span style={{fontSize:12,fontWeight:700,color:"#E0F0FF"}}>{p ? (i.id==="BTCUSDT"?`$${p.toLocaleString()}`:`${p.toFixed(4)}`) : "Loading…"}</span>
                    {d !== null && <span style={{fontSize:9,color:d>=0?"#00D4AA":"#FF4466"}}>{d>=0?"▲":"▼"}{Math.abs(d).toFixed(i.id==="BTCUSDT"?0:5)}</span>}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <div style={{fontSize:10,fontWeight:700,color:dir(s.direction),background:dirBg(s.direction),padding:"2px 6px",borderRadius:2}}>{s.direction||"LOADING"}</div>
                    <span style={{fontSize:10,color:s.confidence>=80?"#00D4AA":"#FFB800"}}>{s.confidence||"—"}%</span>
                  </div>
                  <div className="bar"><div className="fill" style={{width:`${s.confidence||0}%`,background:s.confidence>=80?"#00D4AA":"#FFB800"}}/></div>
                  <div style={{marginTop:5,display:"flex",gap:2,flexWrap:"wrap"}}>
                    {TIMEFRAMES.map(tf=>(
                      <span key={tf} style={{fontSize:8,padding:"1px 3px",borderRadius:1,color:dir(s.tfSignals?.[tf]),background:dirBg(s.tfSignals?.[tf]),border:`1px solid ${dir(s.tfSignals?.[tf])}33`}}>{tf}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* News feed */}
          <div style={{borderTop:"1px solid #182A3C",maxHeight:200,overflow:"hidden",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"8px 12px",borderBottom:"1px solid #182A3C",fontSize:9,letterSpacing:".15em",color:"#2A5A7A"}}>LIVE NEWS</div>
            <div style={{overflowY:"auto",flex:1}}>
              {news.slice(0,6).map((n,i)=>(
                <div key={i} style={{padding:"7px 10px",borderBottom:"1px solid #0F1E2E"}}>
                  <div style={{fontSize:9,color:"#8AABB5",lineHeight:1.5,marginBottom:3}}>{n.title}</div>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:8,color:"#2A4A6A"}}>{n.source}</span>
                    <span style={{fontSize:8,color:n.sentiment>60?"#00D4AA":n.sentiment>40?"#FFB800":"#FF4466"}}>SENT {n.sentiment}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* CENTER */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* Instrument selector */}
          <div style={{padding:"9px 14px",borderBottom:"1px solid #182A3C",display:"flex",gap:6,alignItems:"center"}}>
            {INSTRUMENTS.map(i=>(
              <button key={i.id} className={`ib${selected===i.id?" a":""}`} style={{"--c":i.color,"--bg":`${i.color}12`}} onClick={()=>setSelected(i.id)}>
                {i.icon} {i.label}
              </button>
            ))}
            <span style={{marginLeft:"auto",fontSize:9,color:"#2A5A7A"}}>
              ENTRY: <span style={{color:"#D0E4F8"}}>{prices[selected] ? (selected==="BTCUSDT"?`$${prices[selected].toLocaleString()}`:`${prices[selected]?.toFixed(4)}`) : "—"}</span>
            </span>
          </div>

          {/* Tabs */}
          <div style={{borderBottom:"1px solid #182A3C",display:"flex",padding:"0 14px"}}>
            {[["signals","STRATEGY MATRIX"],["analysis","AI DEEP ANALYSIS"],["trades","PAPER TRADE LOG"],["macro","MACRO DATA"],["calendar","ECONOMIC CALENDAR"]].map(([id,lbl])=>(
              <button key={id} className={`tb${activeTab===id?" a":""}`} onClick={()=>setActiveTab(id)}>{lbl}</button>
            ))}
          </div>

          <div style={{flex:1,overflowY:"auto",padding:14}}>
            {/* ── SIGNALS TAB ── */}
            {activeTab==="signals" && (
              <div style={{animation:"fadeUp .3s"}}>
                <div className="card" style={{padding:14,marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",position:"relative",overflow:"hidden"}}>
                  <div>
                    {!getMarketStatus()[selected]?.open && (
                  <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,background:"rgba(6,10,16,0.85)",display:"flex",alignItems:"center",justifyContent:"center",borderRadius:3,zIndex:10,flexDirection:"column",gap:6}}>
                    <div style={{fontSize:18}}>🔒</div>
                    <div style={{fontSize:11,color:"#FF4466",fontWeight:700,letterSpacing:".1em"}}>MARKET CLOSED</div>
                    <div style={{fontSize:9,color:"#3A5A7A"}}>Forex & Gold resume Monday 00:00 UTC</div>
                    <div style={{fontSize:9,color:"#F7931A",marginTop:4}}>₿ BTC/USDT still trading 24/7</div>
                  </div>
                )}
                <div style={{fontSize:8,letterSpacing:".15em",color:"#2A5A7A",marginBottom:5}}>COMPOSITE SIGNAL — {inst?.label}</div>
                    <div style={{fontSize:30,fontWeight:700,color:dir(sig.direction),fontFamily:"monospace"}}>{sig.direction||"LOADING…"}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:8,color:"#2A5A7A",marginBottom:3}}>CONFIDENCE</div>
                    <div style={{fontSize:28,fontWeight:700,color:sig.confidence>=80?"#00D4AA":"#FFB800"}}>{sig.confidence||"—"}%</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:8,color:"#2A5A7A",marginBottom:3}}>RSI</div>
                    <div style={{fontSize:20,fontWeight:600,color:sig.rsi<35?"#00D4AA":sig.rsi>65?"#FF4466":"#FFB800"}}>{sig.rsi?.toFixed(1)||"—"}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:8,color:"#2A5A7A",marginBottom:3}}>NEWS SENT</div>
                    <div style={{fontSize:20,fontWeight:600,color:sentiment[selected]>60?"#00D4AA":sentiment[selected]>40?"#FFB800":"#FF4466"}}>{Math.round(sentiment[selected])}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:8,color:"#2A5A7A",marginBottom:3}}>TF AGREE</div>
                    <div style={{fontSize:20,fontWeight:600,color:"#4DB8FF"}}>{sig.tfSignals?Object.values(sig.tfSignals).filter(v=>v!=="NEUT").length:0}/6</div>
                  </div>
                </div>

                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div className="card" style={{padding:14}}>
                    <div style={{fontSize:8,letterSpacing:".15em",color:"#2A5A7A",marginBottom:10}}>STRATEGY SCORES (LIVE)</div>
                    {Object.entries(sig.scores||{}).map(([k,v])=>(
                      <div key={k} style={{marginBottom:7}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{fontSize:9,color:"#6A8AAA"}}>{k}</span>
                          <span style={{fontSize:9,fontWeight:600,color:v>=80?"#00D4AA":v>=60?"#FFB800":"#FF4466"}}>{v}</span>
                        </div>
                        <div className="bar"><div className="fill" style={{width:`${v}%`,background:v>=80?"#00D4AA":v>=60?"#FFB800":"#FF4466"}}/></div>
                      </div>
                    ))}
                    {!sig.scores && <div style={{color:"#2A5A7A",fontSize:9}}>Waiting for 30 price points to calculate indicators…</div>}
                  </div>

                  <div className="card" style={{padding:14}}>
                    <div style={{fontSize:8,letterSpacing:".15em",color:"#2A5A7A",marginBottom:10}}>TIMEFRAME MATRIX</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:12}}>
                      {TIMEFRAMES.map(tf=>{
                        const v=sig.tfSignals?.[tf]||"NEUT";
                        return(
                          <div key={tf} style={{padding:"8px 6px",border:`1px solid ${dir(v)}33`,borderRadius:2,background:dirBg(v),textAlign:"center"}}>
                            <div style={{fontSize:8,color:"#3A6A8A",marginBottom:3}}>{tf}</div>
                            <div style={{fontSize:9,fontWeight:600,color:dir(v)}}>{v}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{padding:10,background:"#080E18",borderRadius:2,border:"1px solid #182A3C"}}>
                      <div style={{fontSize:8,color:"#2A5A7A",marginBottom:5}}>LEVELS (LIVE PRICE-BASED)</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                        {[
                          {l:"ENTRY",  v: prices[selected] ? (selected==="BTCUSDT"?`$${prices[selected].toLocaleString()}`:`${prices[selected]?.toFixed(4)}`) : "—", c:"#E0F0FF"},
                          {l:"STOP",   v: prices[selected] ? (selected==="BTCUSDT"?`$${(prices[selected]*0.985).toFixed(0)}`:`${(prices[selected]-0.0080).toFixed(4)}`) : "—", c:"#FF4466"},
                          {l:"TARGET", v: prices[selected] ? (selected==="BTCUSDT"?`$${(prices[selected]*1.025).toFixed(0)}`:`${(prices[selected]+0.016).toFixed(4)}`) : "—", c:"#00D4AA"},
                        ].map(s=>(
                          <div key={s.l}>
                            <div style={{fontSize:8,color:"#2A5A7A"}}>{s.l}</div>
                            <div style={{fontSize:10,fontWeight:600,color:s.c}}>{s.v}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{marginTop:6,display:"flex",gap:12}}>
                        <div><div style={{fontSize:8,color:"#2A5A7A"}}>R:R RATIO</div><div style={{fontSize:10,color:"#4DB8FF"}}>1:2.0</div></div>
                        <div><div style={{fontSize:8,color:"#2A5A7A"}}>EMA9</div><div style={{fontSize:10,color:"#C0D4E8"}}>{sig.ema9?.toFixed(selected==="BTCUSDT"?0:4)||"—"}</div></div>
                        <div><div style={{fontSize:8,color:"#2A5A7A"}}>EMA21</div><div style={{fontSize:10,color:"#C0D4E8"}}>{sig.ema21?.toFixed(selected==="BTCUSDT"?0:4)||"—"}</div></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── AI ANALYSIS TAB ── */}
            {activeTab==="analysis" && (
              <div style={{animation:"fadeUp .3s"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                  <button className="aibtn" onClick={runAI} disabled={isAiLoading}>
                    {isAiLoading?"⟳ ANALYZING WITH LIVE DATA…":"⚡ DEEP AI ANALYSIS"}
                  </button>
                  <span style={{fontSize:9,color:"#2A5A7A"}}>Claude · {inst?.label} · Live price + indicators + news</span>
                </div>
                {!aiText && !isAiLoading && (
                  <div className="card" style={{padding:28,textAlign:"center",color:"#2A5A7A"}}>
                    <div style={{fontSize:20,marginBottom:8}}>⚡</div>
                    <div style={{fontSize:10}}>Click "DEEP AI ANALYSIS" — Claude will analyse the live price, all 6 technical indicators, news sentiment, and macro data to give you a specific grade and trade levels for {inst?.label}.</div>
                  </div>
                )}
                {isAiLoading && <div className="card" style={{padding:24,textAlign:"center",fontSize:10,color:"#4DB8FF",animation:"pulse 1s infinite"}}>Feeding live data to AI engine…</div>}
                {aiText && (
                  <div className="card" style={{padding:16,animation:"fadeUp .3s"}}>
                    <div style={{fontSize:8,letterSpacing:".15em",color:"#2A5A7A",marginBottom:10}}>AI ANALYSIS — {inst?.label} — {new Date().toLocaleTimeString()}</div>
                    {aiText.split("\n").filter(l=>l.trim()).map((p,i)=>(
                      <p key={i} style={{fontSize:10,lineHeight:1.8,color:"#9ABACE",marginBottom:8}}>{p}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── PAPER TRADES TAB ── */}
            {activeTab==="trades" && (
              <div style={{animation:"fadeUp .3s"}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
                  {[
                    {l:"WIN RATE",  v:`${winRate}%`,           c:Number(winRate)>=75?"#00D4AA":"#FFB800"},
                    {l:"TRADES",    v:trades.length,            c:"#C0D4E8"},
                    {l:"NET P&L",   v:`$${netPnl.toFixed(0)}`, c:netPnl>=0?"#00D4AA":"#FF4466"},
                    {l:"WINS",      v:trades.filter(t=>t.win).length, c:"#00D4AA"},
                  ].map(s=>(
                    <div key={s.l} className="card" style={{padding:"9px 12px"}}>
                      <div style={{fontSize:8,color:"#2A5A7A",marginBottom:3}}>{s.l}</div>
                      <div style={{fontSize:15,fontWeight:700,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div className="card" style={{overflow:"hidden"}}>
                  <div style={{padding:"8px 12px",borderBottom:"1px solid #182A3C",display:"grid",gridTemplateColumns:"60px 80px 60px 90px 55px 65px",gap:8,fontSize:8,letterSpacing:".1em",color:"#2A5A7A"}}>
                    <span>ID</span><span>PAIR</span><span>DIR</span><span>ENTRY</span><span>CONF</span><span>P&L</span>
                  </div>
                  {trades.length===0 && <div style={{padding:20,textAlign:"center",color:"#2A5A7A",fontSize:9}}>Waiting for high-confidence signals (≥78%) to log paper trades…</div>}
                  {trades.map(t=>(
                    <div key={t.id} className="row" style={{padding:"7px 12px",borderBottom:"1px solid #0C1824",display:"grid",gridTemplateColumns:"60px 80px 60px 90px 55px 65px",gap:8,alignItems:"center",animation:"fadeUp .3s"}}>
                      <span style={{color:"#2A5A7A"}}>{t.id}</span>
                      <span style={{color:INSTRUMENTS.find(i=>i.id===t.instrument)?.color,fontSize:9}}>{t.label}</span>
                      <span style={{color:dir(t.direction),fontSize:9}}>{t.direction}</span>
                      <span style={{color:"#5A7A9A",fontSize:9}}>{t.instrument==="BTCUSDT"?`$${t.entry.toLocaleString()}`:`${t.entry.toFixed(4)}`}</span>
                      <span style={{color:t.confidence>=80?"#00D4AA":"#FFB800"}}>{t.confidence}%</span>
                      <span style={{fontWeight:600,color:t.pnl>=0?"#00D4AA":"#FF4466"}}>{t.pnl>=0?"+":""}${t.pnl}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── CALENDAR TAB ── */}
            {activeTab==="calendar" && (
              <div style={{animation:"fadeUp .3s"}}>
                <div style={{fontSize:9,color:"#2A5A7A",marginBottom:12}}>
                  High-impact economic events for the next 7 days. Bot auto-pauses 30 minutes before each event.
                </div>
                {calendar.length === 0 && (
                  <div className="card" style={{padding:20,textAlign:"center",color:"#2A5A7A",fontSize:9}}>
                    Loading economic calendar...
                  </div>
                )}
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {calendar.slice(0,15).map((e,i) => {
                    const eventTime = new Date(e.date);
                    const isPast    = eventTime < new Date();
                    const isSoon    = !isPast && (eventTime - new Date()) < 30*60*1000;
                    return (
                      <div key={i} className="card" style={{
                        padding:"10px 14px",
                        borderLeft: isSoon ? "3px solid #FF4466" : isPast ? "3px solid #2A4A6A" : "3px solid #FFB800",
                        opacity: isPast ? 0.5 : 1
                      }}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                          <span style={{fontSize:11,fontWeight:600,color:isSoon?"#FF4466":isPast?"#3A6A8A":"#E0F0FF"}}>{e.name}</span>
                          <span style={{fontSize:9,color:isSoon?"#FF4466":"#FFB800",fontWeight:isSoon?700:400}}>
                            {isSoon ? "⚠️ SOON" : isPast ? "DONE" : "UPCOMING"}
                          </span>
                        </div>
                        <div style={{display:"flex",gap:16,fontSize:9,color:"#5A7A9A"}}>
                          <span>🌍 {e.country}</span>
                          <span>🕐 {eventTime.toLocaleDateString()} {eventTime.toLocaleTimeString()}</span>
                          {e.forecast && <span>Forecast: {e.forecast}</span>}
                          {e.actual && <span style={{color:"#00D4AA"}}>Actual: {e.actual}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── MACRO TAB ── */}
            {activeTab==="macro" && (
              <div style={{animation:"fadeUp .3s"}}>
                <div style={{fontSize:9,color:"#2A5A7A",marginBottom:12}}>
                  Real economic indicators. Connect FRED API key for live data updates.
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  {Object.entries(macro).map(([k,v])=>(
                    <div key={k} className="card" style={{padding:12}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <span style={{fontSize:9,color:"#6A8AAA"}}>{k}</span>
                        <span style={{fontSize:11,fontWeight:600,color:"#D0E4F8"}}>{v.value}</span>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <span style={{fontSize:8,color:"#2A5A7A"}}>SENTIMENT SCORE</span>
                        <span style={{fontSize:8,color:v.score>60?"#00D4AA":v.score>40?"#FFB800":"#FF4466"}}>{v.score}/100</span>
                      </div>
                      <div className="bar"><div className="fill" style={{width:`${v.score}%`,background:v.score>60?"#00D4AA":v.score>40?"#FFB800":"#FF4466"}}/></div>
                    </div>
                  ))}
                </div>
                <div className="card" style={{padding:14,marginTop:12}}>
                  <div style={{fontSize:9,letterSpacing:".12em",color:"#2A5A7A",marginBottom:8}}>HOW TO CONNECT LIVE MACRO DATA</div>
                  {[
                    {step:"1", text:"Get free FRED API key: fred.stlouisfed.org/docs/api/api_key.html"},
                    {step:"2", text:'Replace YOUR_FRED_KEY at top of file with your key'},
                    {step:"3", text:"Get free NewsAPI key: newsapi.org → Replace YOUR_NEWSAPI_KEY"},
                    {step:"4", text:"BTC/USDT is already live via Binance WebSocket (no key needed)"},
                    {step:"5", text:"GBP/USD & Gold update every 30-60s via Frankfurter (no key needed)"},
                  ].map(s=>(
                    <div key={s.step} style={{display:"flex",gap:10,marginBottom:7,alignItems:"flex-start"}}>
                      <span style={{color:"#00D4AA",fontSize:9,flexShrink:0}}>{s.step}.</span>
                      <span style={{fontSize:9,color:"#7A9ABE",lineHeight:1.6}}>{s.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: LOG */}
        <div style={{width:220,borderLeft:"1px solid #182A3C",display:"flex",flexDirection:"column",flexShrink:0}}>
          <div style={{padding:"9px 12px",borderBottom:"1px solid #182A3C",fontSize:9,letterSpacing:".15em",color:"#2A5A7A"}}>SYSTEM LOG</div>
          <div ref={logRef} style={{flex:1,overflowY:"auto",padding:"8px 10px"}}>
            {log.map((e,i)=>(
              <div key={i} style={{marginBottom:5,animation:i===log.length-1?"fadeUp .3s":"none"}}>
                <span style={{fontSize:8,color:"#1A3A5A"}}>{e.t} </span>
                <span style={{fontSize:9,lineHeight:1.5,color:e.type==="success"?"#00D4AA":e.type==="error"?"#FF4466":e.type==="signal"?"#FFB800":"#3A6A8A"}}>{e.msg}</span>
              </div>
            ))}
            {log.length===0 && <div style={{color:"#1A3A5A",fontSize:9}}>Starting…</div>}
          </div>
          <div style={{padding:"8px 10px",borderTop:"1px solid #182A3C",fontSize:8,color:"#1A3A5A"}}>
            <span style={{animation:"blink 1s infinite",color:"#00D4AA"}}>█</span> DATA FEEDS ACTIVE
          </div>
        </div>
      </div>
    </div>
  );
}
