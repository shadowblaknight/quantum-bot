/* eslint-disable */
import { useState, useEffect, useCallback, useRef } from "react";

const API = (path) => `/api/${path}`;
const PREFS_KEY = "qb_v9_prefs";

const SESSION_COLORS = { LONDON: "#1e3a8a", OVERLAP: "#b45309", "NEW YORK": "#15803d", ASIAN: "#6b21a8" };

const pnlColor = (v) => (v > 0 ? "#15803d" : v < 0 ? "#b91c1c" : "#64748b");
const pnlStr   = (v) => `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
const fmtTime  = (d) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const fmtDate  = (d) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });

const normSym = (raw) => { if (!raw) return null; return raw.toUpperCase().replace(".S", "").replace(".PRO", "").trim(); };

const instCategory = (sym) => {
  if (!sym) return "OTHER";
  const u = sym.toUpperCase();
  if (u.includes("XAU") || u.includes("GOLD")) return "GOLD";
  if (u.includes("BTC") || u.includes("ETH") || u.includes("CRYPTO") || u.includes("COIN")) return "CRYPTO";
  return "FOREX";
};

const getSessionInfo = () => {
  const now = new Date();
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  const day = now.getUTCDay();
  const isWeekend = day === 0 || day === 6;
  const isLondon  = h >= 8  && h < 16;
  const isNY      = h >= 13 && h < 21;
  const isOverlap = h >= 13 && h < 16;
  let session = "ASIAN";
  if (isOverlap) session = "OVERLAP";
  else if (isNY) session = "NEW YORK";
  else if (isLondon) session = "LONDON";
  return { session, isLondon, isNY, isOverlap, isWeekend, utcH: h };
};

const sessionKeyFromInfo = (info) => info.session;
const isSelectedSessionActive = (selected, info) => {
  const k = sessionKeyFromInfo(info);
  if (k === "ASIAN") return false;
  return selected.includes(k);
};

const isTradeable = (sym, utcH, isWeekend) => {
  if (!sym) return false;
  const cat = instCategory(sym);
  if (isWeekend) return false;
  if (cat === "CRYPTO") return utcH >= 7 && utcH < 23;
  return utcH >= 8 && utcH < 21;
};

const getSessionLabel = (timeStr) => {
  const h = new Date(timeStr || "").getUTCHours();
  if (h >= 13 && h < 16) return "OVERLAP";
  if (h >= 13 && h < 21) return "NEW YORK";
  if (h >= 8  && h < 16) return "LONDON";
  return "ASIAN";
};

const loadPrefs = () => { try { const r = localStorage.getItem(PREFS_KEY); return r ? JSON.parse(r) : {}; } catch (e) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {} };

const QUICK_SYMBOLS = ["XAUUSD", "BTCUSDT", "GBPUSD", "EURUSD", "US30", "NAS100"];

const CSS = `
  :root {
    --navy:    #0a2540;
    --navy2:   #0f3260;
    --navy3:   #1a3a6e;
    --navy-l:  #1e4480;
    --bg:      #f5f7fa;
    --surface: #ffffff;
    --border:  #e1e7ef;
    --border2: #cbd5e1;
    --text:    #0f172a;
    --text2:   #475569;
    --text3:   #94a3b8;
    --blue:    #1e3a8a;
    --blue2:   #2563eb;
    --green:   #15803d;
    --red:     #b91c1c;
    --gold:    #b45309;
    --purple:  #7c3aed;
    --r:       8px;
    --r2:      6px;
    --r3:      4px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { height: 100%; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh;
    font-size: 13px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .app { display: flex; min-height: 100vh; }

  /* ============ SIDEBAR (navy) ============ */
  .sidebar {
    width: 240px; background: var(--navy); flex-shrink: 0;
    display: flex; flex-direction: column;
    position: sticky; top: 0; height: 100vh; overflow: hidden;
    color: #cbd5e1;
  }
  .sb-head { padding: 22px 20px 18px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
  .sb-brand { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 700; color: #fff; letter-spacing: -0.2px; }
  .sb-logo {
    width: 32px; height: 32px; border-radius: 8px;
    background: linear-gradient(135deg, #2563eb 0%, #1e3a8a 100%);
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 800; color: #fff; flex-shrink: 0;
    box-shadow: 0 2px 6px rgba(37,99,235,0.4);
  }
  .sb-sub { font-size: 10px; color: #64748b; margin-top: 3px; letter-spacing: 0.04em; }

  .sb-nav { flex-shrink: 0; padding: 8px 0 4px; }
  .sb-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 20px; cursor: pointer; font-size: 13px;
    color: #94a3b8; transition: all 0.12s;
    border-left: 3px solid transparent; user-select: none;
  }
  .sb-item:hover { color: #fff; background: rgba(255,255,255,0.04); }
  .sb-item.on { color: #fff; background: rgba(37,99,235,0.18); border-left-color: var(--blue2); font-weight: 600; }
  .sb-icon { width: 16px; text-align: center; font-size: 12px; opacity: 0.75; }
  .sb-item.on .sb-icon { opacity: 1; }

  .sb-div { height: 1px; background: rgba(255,255,255,0.06); flex-shrink: 0; }

  .sb-wl { flex: 1; overflow-y: auto; min-height: 0; }
  .sb-wl::-webkit-scrollbar { width: 4px; }
  .sb-wl::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
  .sb-wl-hd { padding: 12px 20px 6px; font-size: 9.5px; font-weight: 700; color: #64748b; letter-spacing: 0.12em; text-transform: uppercase; }
  .sb-wl-empty { padding: 12px 20px; font-size: 11.5px; color: #64748b; }
  .sb-row { padding: 7px 20px; display: flex; align-items: center; justify-content: space-between; gap: 8px; transition: background 0.1s; }
  .sb-row:hover { background: rgba(255,255,255,0.03); }
  .sb-sym { font-size: 12px; font-weight: 600; color: #e2e8f0; }
  .sb-px  { font-size: 12.5px; font-weight: 700; color: #cbd5e1; font-variant-numeric: tabular-nums; }

  .sb-foot { flex-shrink: 0; padding: 12px 20px 16px; border-top: 1px solid rgba(255,255,255,0.06); }
  .sf-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; }
  .sf-lbl { font-size: 10px; color: #64748b; font-weight: 500; }
  .sf-val { font-size: 11px; font-weight: 700; color: #e2e8f0; font-variant-numeric: tabular-nums; }

  /* ============ MAIN ============ */
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: auto; }

  /* Topbar (navy) */
  .topbar {
    background: var(--navy2); color: #fff;
    padding: 12px 24px; display: flex; align-items: center; gap: 8px;
    flex-wrap: wrap; flex-shrink: 0; position: sticky; top: 0; z-index: 10;
    border-bottom: 1px solid var(--navy-l);
  }
  .tc {
    padding: 6px 14px 7px; border-radius: var(--r2);
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
    display: flex; flex-direction: column; gap: 2px; min-width: 90px;
  }
  .tc-lbl { font-size: 9px; font-weight: 700; color: #94a3b8; letter-spacing: 0.09em; text-transform: uppercase; }
  .tc-val { font-size: 16px; font-weight: 700; color: #fff; letter-spacing: -0.4px; line-height: 1.25; }
  .tb-sep { flex: 1; }
  .tb-time { font-size: 11.5px; color: #cbd5e1; font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* Content (white) */
  .content { padding: 22px 24px 32px; flex: 1; }

  .panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--r); padding: 18px 20px;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04);
  }
  .pt {
    font-size: 10px; font-weight: 700; color: var(--text2);
    letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 14px;
  }
  .pt0 { margin-bottom: 0; }

  .bdg {
    display: inline-flex; align-items: center; padding: 2.5px 8px;
    border-radius: var(--r3); font-size: 9.5px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap;
  }
  .bdg-long   { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
  .bdg-short  { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
  .bdg-wait   { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }
  .bdg-gold   { background: #fef3c7; color: #b45309; border: 1px solid #fde68a; }
  .bdg-purple { background: #ede9fe; color: #7c3aed; border: 1px solid #ddd6fe; }
  .bdg-red    { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
  .bdg-blue   { background: #dbeafe; color: #1e3a8a; border: 1px solid #bfdbfe; }

  .btn { padding: 8px 16px; border-radius: var(--r2); border: none; cursor: pointer; font-size: 12.5px; font-weight: 600; transition: all 0.12s; font-family: inherit; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-p { background: var(--navy); color: #fff; }
  .btn-p:hover:not(:disabled) { background: var(--navy2); }
  .btn-sm { padding: 5px 11px; font-size: 11px; }
  .btn-g { background: #fff; border: 1px solid var(--border2); color: var(--text2); }
  .btn-g:hover:not(:disabled) { background: var(--bg); color: var(--text); }
  .btn-d { background: #fff; border: 1px solid #fecaca; color: var(--red); }
  .btn-d:hover:not(:disabled) { background: #fef2f2; }

  .inp {
    background: #fff; border: 1px solid var(--border2); color: var(--text);
    padding: 9px 12px; border-radius: var(--r2); font-size: 13px; outline: none; width: 100%;
    transition: border-color 0.15s; font-family: inherit;
  }
  .inp::placeholder { color: var(--text3); }
  .inp:focus { border-color: var(--navy); }

  /* Instrument cards */
  .inst-grid { display: grid; gap: 14px; }
  .inst-card { background: #fff; border: 1px solid var(--border); border-radius: var(--r); padding: 16px 18px; position: relative; overflow: hidden; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  .inst-bar { position: absolute; top: 0; left: 0; right: 0; height: 3px; }
  .inst-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
  .inst-sym { font-size: 13px; font-weight: 700; color: var(--text); letter-spacing: 0.02em; }
  .inst-px { font-size: 26px; font-weight: 700; color: var(--text); letter-spacing: -1.2px; line-height: 1; font-variant-numeric: tabular-nums; margin-bottom: 10px; }
  .inst-px-empty { color: var(--text3); }
  .inst-strat { font-size: 10px; font-weight: 600; color: var(--blue2); word-break: break-word; line-height: 1.3; margin-top: 4px; }
  .inst-tp { display: flex; gap: 8px; margin-top: 5px; font-size: 10px; }
  .inst-why { font-size: 10.5px; color: var(--text2); line-height: 1.45; margin-top: 5px; }
  .inst-crown { font-size: 9.5px; color: var(--gold); font-weight: 600; margin-top: 5px; }
  .inst-off { font-size: 9.5px; color: var(--text3); margin-top: 4px; }

  .cring { width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; }

  /* Tables */
  .ptbl { width: 100%; border-collapse: collapse; }
  .ptbl th { font-size: 9.5px; font-weight: 700; color: var(--text2); text-transform: uppercase; letter-spacing: 0.08em; padding: 0 10px 10px 0; text-align: left; white-space: nowrap; }
  .ptbl td { padding: 10px 10px 10px 0; border-top: 1px solid var(--border); font-size: 12.5px; vertical-align: middle; }
  .ptbl tr:first-child td { border-top: none; }

  /* Log */
  .log-wrap { height: 220px; overflow-y: auto; background: #f8fafc; border-radius: var(--r2); padding: 8px 12px; }
  .log-wrap::-webkit-scrollbar { width: 4px; }
  .log-wrap::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 4px; }
  .log-ln { display: flex; gap: 10px; padding: 3px 0; font-family: "SF Mono", ui-monospace, monospace; font-size: 11px; line-height: 1.55; }
  .log-ts { color: var(--text3); flex-shrink: 0; }
  .log-info    .log-m { color: var(--text2); }
  .log-success .log-m { color: var(--green); }
  .log-warn    .log-m { color: var(--gold); }
  .log-error   .log-m { color: var(--red); }
  .log-signal  .log-m { color: var(--purple); }

  .srow { display: flex; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border); gap: 10px; }
  .srow:last-child { border-bottom: none; }

  /* Strategy Lab */
  .lc { background: #fff; border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; border-left-width: 4px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  .lc-head { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .lc-body { padding: 14px 20px; }
  .lc-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px dashed var(--border); }
  .lc-stat { }
  .lc-stat-lbl { font-size: 9px; color: var(--text2); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }
  .lc-stat-val { font-size: 16px; font-weight: 700; }
  .lic { background: #f8fafc; border: 1px solid var(--border); border-radius: var(--r2); padding: 11px 13px; transition: border-color 0.15s; }
  .wrb { background: #e2e8f0; border-radius: 2px; height: 4px; margin-top: 6px; }
  .wrf { height: 4px; border-radius: 2px; transition: width 0.5s; }
  .fail-note { font-size: 11px; color: var(--red); font-style: italic; padding: 8px 12px; background: #fef2f2; border-radius: var(--r2); border-left: 3px solid var(--red); margin-top: 10px; }
  .tpd-row { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--text2); margin-top: 4px; }
  .tpd-bar { flex: 1; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; display: flex; }
  .tpd-seg { height: 6px; transition: width 0.3s; }

  /* Settings */
  .set-col { max-width: 620px; display: flex; flex-direction: column; gap: 14px; }
  .stags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .stag { display: flex; align-items: center; gap: 6px; background: #f1f5f9; border: 1px solid var(--border2); border-radius: 6px; padding: 5px 8px 5px 11px; font-size: 12px; font-weight: 600; }
  .stag-n { color: var(--gold); }
  .stag-p { color: var(--text2); font-size: 10.5px; font-variant-numeric: tabular-nums; }
  .stag-rm { background: none; border: none; color: var(--text3); cursor: pointer; padding: 0; font-size: 15px; line-height: 1; display: flex; align-items: center; transition: color 0.1s; }
  .stag-rm:hover { color: var(--red); }
  .qrow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .qbtn { padding: 5px 11px; border-radius: var(--r3); font-size: 11.5px; font-weight: 600; background: #f1f5f9; border: 1px solid var(--border2); color: var(--text2); cursor: pointer; transition: all 0.1s; font-family: inherit; }
  .qbtn:hover { border-color: var(--navy); color: var(--navy); background: #fff; }
  .qbtn.on { background: var(--navy); border-color: var(--navy); color: #fff; }
  .segs { display: flex; gap: 7px; }
  .seg { flex: 1; padding: 8px 4px; border-radius: var(--r2); border: 1px solid var(--border2); background: #fff; color: var(--text2); cursor: pointer; font-size: 12px; font-weight: 600; transition: all 0.1s; text-align: center; font-family: inherit; }
  .seg:hover { color: var(--text); background: var(--bg); }
  .seg.on { background: var(--navy); border-color: var(--navy); color: #fff; }
  .seg.agg.on { background: var(--red); border-color: var(--red); color: #fff; }
  .kv { display: flex; justify-content: space-between; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid var(--border); gap: 12px; }
  .kv:last-child { border-bottom: none; }
  .kv-k { font-size: 11px; color: var(--text2); font-weight: 600; }
  .kv-v { font-size: 11.5px; font-weight: 600; color: var(--text); text-align: right; max-width: 320px; word-break: break-word; }

  /* Utility */
  .r { display: flex; align-items: center; }
  .g4 { gap: 4px; } .g6 { gap: 6px; } .g8 { gap: 8px; } .g10 { gap: 10px; } .g12 { gap: 12px; } .g16 { gap: 16px; }
  .ml { margin-left: auto; }
  .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .g4c { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .g3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
  .mt4 { margin-top: 4px; } .mt6 { margin-top: 6px; } .mt8 { margin-top: 8px; }
  .mt10 { margin-top: 10px; } .mt12 { margin-top: 12px; } .mt14 { margin-top: 14px; }
  .mb8 { margin-bottom: 8px; } .mb12 { margin-bottom: 12px; } .mb14 { margin-bottom: 14px; }
  .col { display: flex; flex-direction: column; }
  .s10 { display: flex; flex-direction: column; gap: 10px; }
  .s12 { display: flex; flex-direction: column; gap: 12px; }
  .s14 { display: flex; flex-direction: column; gap: 14px; }
  .xs { font-size: 10.5px; } .sm { font-size: 11.5px; }
  .mut { color: var(--text3); } .sub { color: var(--text2); }
  .w6 { font-weight: 600; } .w7 { font-weight: 700; } .w8 { font-weight: 800; }
  .tn { font-variant-numeric: tabular-nums; }
  .empty { text-align: center; padding: 56px 24px; color: var(--text3); }
  .empty-ico { font-size: 26px; margin-bottom: 12px; opacity: 0.4; }
  .empty-title { font-size: 15px; font-weight: 600; color: var(--text2); margin-bottom: 6px; }

  @media (max-width: 900px) {
    .sidebar { display: none; }
    .g4c { grid-template-columns: 1fr 1fr; }
    .inst-grid { grid-template-columns: 1fr 1fr !important; }
    .lc-stats { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 600px) {
    .g2, .g3, .g4c { grid-template-columns: 1fr; }
    .content { padding: 14px 14px 24px; }
    .topbar  { padding: 10px 14px; }
  }
`;

const NAV = [
  { id: "live",     icon: "\u25CF", label: "Live Trade"   },
  { id: "reports",  icon: "\u2630", label: "Reports"      },
  { id: "lab",      icon: "\u25C6", label: "Strategy Lab" },
  { id: "settings", icon: "\u2699", label: "Settings"     },
];

export default function App() {
  const prefs = loadPrefs();

  const [instruments, setInstruments] = useState(Array.isArray(prefs.instruments) ? prefs.instruments : []);
  const [sessions,    setSessions]    = useState(Array.isArray(prefs.sessions)    ? prefs.sessions    : ["LONDON", "NEW YORK"]);
  const [riskMode,    setRiskMode]    = useState(prefs.riskMode || "TEST");

  const [page,           setPage]           = useState("live");
  const [prices,         setPrices]         = useState({});
  const [openPositions,  setOpenPositions]  = useState([]);
  const [closedTrades,   setClosedTrades]   = useState([]);
  const [accountBalance, setAccountBalance] = useState(null);
  const [aiDecisions,    setAiDecisions]    = useState({});
  const [aiStatus,       setAiStatus]       = useState({});
  const [learnedStats,   setLearnedStats]   = useState({});
  const [crownLocks,     setCrownLocks]     = useState({});
  const [blacklist,      setBlacklist]      = useState([]);
  const [log,            setLog]            = useState([]);
  const [sessionInfo,    setSessionInfo]    = useState(getSessionInfo());
  const [newSymInput,    setNewSymInput]    = useState("");
  const [nowStr,         setNowStr]         = useState("");

  const lastAIRef    = useRef({});
  const lastTradeRef = useRef({});
  const pendingRef   = useRef({});
  const prevPosRef   = useRef([]);
  const logRef       = useRef(null);

  useEffect(() => { savePrefs({ instruments, sessions, riskMode }); }, [instruments, sessions, riskMode]);

  useEffect(() => {
    const tick = () => setNowStr(new Date().toUTCString().slice(17, 25));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, []);

  const addLog = useCallback((msg, type = "info") => {
    setLog((prev) => [...prev.slice(-200), { msg, type, time: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }]);
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const fetchAccount = useCallback(async () => {
    try { const r = await fetch(API("account")); if (r.ok) { const d = await r.json(); if (d.balance != null) setAccountBalance(d.balance); } } catch (_) {}
  }, []);
  const fetchPositions = useCallback(async () => {
    try { const r = await fetch(API("positions")); if (r.ok) { const d = await r.json(); setOpenPositions(Array.isArray(d.positions) ? d.positions : []); } } catch (_) {}
  }, []);
  const fetchHistory = useCallback(async () => {
    try { const r = await fetch(API("history")); if (r.ok) { const d = await r.json(); setClosedTrades(Array.isArray(d.deals) ? d.deals : []); } } catch (_) {}
  }, []);
  const fetchPrice = useCallback(async (sym) => {
    try { const r = await fetch(API(`broker-price?symbol=${encodeURIComponent(sym)}`)); if (r.ok) { const d = await r.json(); if (d.price != null) setPrices((p) => ({ ...p, [sym]: d.price })); } } catch (_) {}
  }, []);
  const fetchLab = useCallback(async () => {
    try { const r = await fetch(API("trades")); if (r.ok) { const d = await r.json(); setLearnedStats(d.lab || {}); setCrownLocks(d.crownLocks || {}); setBlacklist(d.blacklist || []); } } catch (_) {}
  }, []);

  const recordResult = useCallback(async (pos, fallbackDec, session) => {
    const comment  = pos.comment || pos.tradeComment || "";
    const strategy = (comment.startsWith("QB:") ? comment.slice(3).trim() : null) || fallbackDec?.strategy || null;
    if (!strategy || strategy === "EXPLORING" || strategy === "UNKNOWN" || strategy.length < 3) { addLog(`Not recorded: ${pos.symbol} -- no strategy label`, "warn"); return; }
    const inst = normSym(pos.symbol);
    const pnl  = pos.profit || 0;
    try {
      await fetch(API("trades"), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument: inst, direction: pos.type === "POSITION_TYPE_BUY" ? "LONG" : "SHORT", won: pnl > 0, pnl, strategy, session, confidence: fallbackDec?.confidence || 0, closeTime: new Date().toISOString(), openPrice: pos.openPrice || null, closePrice: pos.currentPrice || null, volume: pos.volume || 0.01 }) });
      fetchLab();
      addLog(`Recorded [${strategy}] ${inst} ${pnl > 0 ? "WIN" : "LOSS"} ${pnlStr(pnl)}`, pnl > 0 ? "success" : "warn");
    } catch (e) { addLog(`Record failed: ${e.message}`, "error"); }
  }, [addLog, fetchLab]);

  useEffect(() => {
    const prev = prevPosRef.current;
    const cur  = openPositions;
    prev.filter((p) => !cur.find((c) => (c.id || c.positionId) === (p.id || p.positionId))).forEach((closed) => { const sym = normSym(closed.symbol); recordResult(closed, aiDecisions[sym] || null, sessionInfo.session); });
    prevPosRef.current = cur;
  }, [openPositions, aiDecisions, sessionInfo.session, recordResult]);

  const runAIBrain = useCallback(async (sym) => {
    if (pendingRef.current[sym]) return;
    const now = Date.now();
    if (now - (lastAIRef.current[sym] || 0) < 290000) return;
    lastAIRef.current[sym] = now;
    setAiStatus((p) => ({ ...p, [sym]: "thinking" }));
    addLog(`Brain: ${sym} -- reading market...`, "info");
    try {
      const tfs = ["M1","M5","M15","H1","H4","D1","W1"]; const limits = [60,24,24,24,20,14,8];
      const results = await Promise.all(tfs.map((tf, i) => fetch(API(`broker-candles?symbol=${encodeURIComponent(sym)}&timeframe=${tf}&limit=${limits[i]}`)).then((r) => r.json()).catch(() => ({ candles: [] }))));
      const [m1d, m5d, m15d, h1d, h4d, d1d, wkd] = results.map((r) => r.candles || []);
      const sumC = (arr, n = 5) => {
        if (!arr || !arr.length) return "no data";
        const sl = arr.slice(-n); const c = sl[sl.length-1]; const o = sl[0];
        const dir = c.close > o.close ? "up" : "down";
        const chg = (((c.close - o.close) / o.close) * 100).toFixed(3);
        const hi = Math.max(...sl.map((x) => x.high)); const lo = Math.min(...sl.map((x) => x.low));
        const dp = hi > 1000 ? 0 : 5;
        return `${dir}${chg}% H:${hi.toFixed(dp)} L:${lo.toFixed(dp)}`;
      };
      const atr = (() => {
        if (m1d.length < 15) return 0;
        const trs = m1d.slice(-14).map((c, i, a) => { const prev = a[Math.max(0,i-1)]; return Math.max(c.high-c.low, Math.abs(c.high-prev.close), Math.abs(c.low-prev.close)); });
        return trs.reduce((a,b) => a+b, 0) / trs.length;
      })();
      const todayPnl = closedTrades.filter((t) => new Date(t.time||t.closeTime||"").toDateString() === new Date().toDateString()).reduce((s,t) => s+(t.profit||0), 0);
      const s = sessionInfo;
      const snap = {
        price: prices[sym]||null, session: s.session, balance: accountBalance||0, todayPnl: todayPnl.toFixed(2), lossStreak: 0, winStreak: 0,
        atr14: parseFloat(atr.toFixed(4)), weekly: sumC(wkd,4), d1: sumC(d1d,5), h4: sumC(h4d,5), h1: sumC(h1d,5), m15: sumC(m15d,6), m5: sumC(m5d,6), m1: sumC(m1d,8),
        openCount: openPositions.filter((p) => normSym(p.symbol) === sym).length,
        inKillZone: (s.utcH>=7&&s.utcH<10)||(s.utcH>=13&&s.utcH<16),
        killZone: s.utcH>=7&&s.utcH<10 ? "London 07-10" : s.utcH>=13&&s.utcH<16 ? "NY 13-16" : "",
        atrGuide: atr>0 ? `min SL ${(atr*0.8).toFixed(4)}` : "unknown",
      };
      const prevDec = aiDecisions[sym] ? [aiDecisions[sym]] : [];
      const r = await fetch(API("ai"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snap, instrument: sym, riskMode, prevDecisions: prevDec, lab: learnedStats, crownLocks, blacklist }) });
      if (!r.ok) { addLog(`AI error ${sym}: HTTP ${r.status}`, "error"); setAiStatus((p) => ({ ...p, [sym]: "error" })); return; }
      const dec = await r.json();
      setAiDecisions((p) => ({ ...p, [sym]: { ...dec, symbol: sym, price: prices[sym], time: new Date().toISOString() } }));
      setAiStatus((p) => ({ ...p, [sym]: (dec.decision||"wait").toLowerCase() }));
      if (dec.newsBlocked) addLog(`${sym}: blocked by news -- ${dec.reason}`, "warn");
      else addLog(`${sym}: ${dec.decision||"WAIT"} ${dec.confidence||0}% [${dec.strategy||"?"}]`, dec.decision==="WAIT" ? "warn" : "signal");

      if (dec.decision !== "WAIT" && dec.volume && dec.stopLoss && dec.takeProfit1) {
        if (Date.now() - (lastTradeRef.current[sym]||0) < 600000) { addLog(`${sym}: cooldown -- skipping`, "warn"); return; }
        if (openPositions.some((p) => normSym(p.symbol) === sym)) { addLog(`${sym}: position already open -- skipping`, "warn"); return; }
        pendingRef.current[sym] = true;
        addLog(`Executing ${sym} ${dec.decision} ${dec.volume}L [${dec.strategy}]`, "signal");
        try {
          const strategy = dec.strategy || "V9";
          const ex = await fetch(API("execute"), { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instrument: sym, direction: dec.decision, entry: prices[sym], stopLoss: dec.stopLoss, takeProfit: dec.takeProfit4||dec.takeProfit3||dec.takeProfit2||dec.takeProfit1, volume: dec.volume, comment: `QB:${strategy.slice(0,18)}` }) });
          const ed = await ex.json();
          if (ed.success) {
            lastTradeRef.current[sym] = Date.now();
            addLog(`Opened: ${ed.instrument||sym} ${dec.decision} ${dec.volume}L`, "success");
            setTimeout(async () => {
              try {
                const pr = await fetch(API("positions")).then((r) => r.json());
                const filled = (pr.positions||[]).find((p) => normSym(p.symbol) === sym);
                if (!filled || !filled.openPrice) return;
                const fill = filled.openPrice; const sign = dec.decision==="LONG" ? 1 : -1; const cat = instCategory(sym);
                let pips;
                if (cat==="GOLD") pips=[5,10,15,20];
                else if (cat==="CRYPTO") { const aP=Math.max(atr*0.5,50); pips=[aP,aP*2,aP*3,aP*4]; }
                else { const aP=Math.max(atr*0.5,0.0005); pips=[aP,aP*2,aP*3,aP*4]; }
                const fdp=fill>100?2:5; const slDist=cat==="GOLD"?10:Math.max(atr*0.8,pips[0]);
                const corr = { positionId: filled.id||filled.positionId, instrument: sym, direction: dec.decision, fillPrice: fill,
                  tp1: parseFloat((fill+sign*pips[0]).toFixed(fdp)), tp2: parseFloat((fill+sign*pips[1]).toFixed(fdp)),
                  tp3: parseFloat((fill+sign*pips[2]).toFixed(fdp)), tp4: parseFloat((fill+sign*pips[3]).toFixed(fdp)),
                  sl: parseFloat((fill-sign*slDist).toFixed(fdp)) };
                await fetch(API("manage-trades"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ correctTPs: corr }) }).catch(() => {});
                addLog(`TPs corrected from fill @ ${fill}`, "info");
              } catch (_) {}
            }, 3000);
            setTimeout(fetchPositions, 2000); setTimeout(fetchHistory, 5000);
          } else { addLog(`Execute failed ${sym}: ${ed.error||"unknown"}`, "error"); }
        } finally { pendingRef.current[sym] = false; }
      }
    } catch (e) { setAiStatus((p) => ({ ...p, [sym]: "error" })); addLog(`Brain error ${sym}: ${e.message}`, "error"); }
  }, [prices, openPositions, closedTrades, accountBalance, sessionInfo, riskMode, aiDecisions, learnedStats, crownLocks, blacklist, addLog, fetchPositions, fetchHistory]);

  const manageTrades = useCallback(async () => {
    if (!openPositions.length) return;
    const positions = openPositions.map((pos) => {
      const sym = normSym(pos.symbol); const dec = aiDecisions[sym];
      if (!dec || !dec.takeProfit1) return null;
      return { id: pos.id||pos.positionId, symbol: pos.symbol, openPrice: pos.openPrice, currentPrice: pos.currentPrice, stopLoss: pos.stopLoss, volume: pos.volume, direction: pos.type==="POSITION_TYPE_BUY"?"LONG":"SHORT", tp1: dec.takeProfit1, tp2: dec.takeProfit2||null, tp3: dec.takeProfit3||null, tp4: dec.takeProfit4||null };
    }).filter(Boolean);
    if (!positions.length) return;
    try {
      const r = await fetch(API("manage-trades"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positions }) });
      const d = await r.json();
      (d.managed||[]).forEach((m) => {
        (m.actions||[]).forEach((a) => {
          if (a.type==="TP1") addLog(`TP1 ${m.symbol} +$${(a.pnl||0).toFixed(2)}`, "success");
          if (a.type==="TP2") addLog(`TP2 ${m.symbol} +$${(a.pnl||0).toFixed(2)}`, "success");
          if (a.type==="TP3") addLog(`TP3 ${m.symbol} +$${(a.pnl||0).toFixed(2)}`, "success");
          if (a.type==="TP4_FINAL") addLog(`TP4 complete ${m.symbol} +$${(a.pnl||0).toFixed(2)}`, "success");
          if (a.type==="RETRACE_CLOSE") addLog(`Retrace close ${m.symbol} $${(a.pnl||0).toFixed(2)}`, "warn");
          if (a.type==="TP1_RETRACE_PROTECT") addLog(`TP1 retrace protect ${m.symbol} $${(a.pnl||0).toFixed(2)}`, "warn");
        });
      });
    } catch (_) {}
  }, [openPositions, aiDecisions, addLog]);

  useEffect(() => {
    fetchAccount(); fetchPositions(); fetchHistory(); fetchLab();
    instruments.forEach((sym) => fetchPrice(sym));
    const ii = [
      setInterval(fetchAccount, 30000), setInterval(fetchPositions, 5000),
      setInterval(fetchHistory, 30000), setInterval(fetchLab, 300000),
      setInterval(() => setSessionInfo(getSessionInfo()), 60000),
    ];
    instruments.forEach((sym) => { ii.push(setInterval(() => fetchPrice(sym), 5000)); });
    return () => ii.forEach(clearInterval);
  }, [fetchAccount, fetchPositions, fetchHistory, fetchLab, fetchPrice, instruments]);

  useEffect(() => {
    if (!openPositions.length) return;
    manageTrades();
    const i = setInterval(manageTrades, 30000);
    return () => clearInterval(i);
  }, [openPositions, manageTrades]);

  useEffect(() => {
    const run = () => {
      if (!instruments.length) return;
      const s = getSessionInfo();
      if (!isSelectedSessionActive(sessions, s)) return;
      instruments.forEach((sym) => {
        if (!isTradeable(sym, s.utcH, s.isWeekend)) return;
        if (prices[sym] == null) return;
        runAIBrain(sym);
      });
    };
    const t = setTimeout(run, 3000);
    const i = setInterval(run, 300000);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [instruments, sessions, prices, runAIBrain]);

  const todayTrades   = closedTrades.filter((t) => new Date(t.time||t.closeTime||"").toDateString() === new Date().toDateString());
  const todayPnl      = todayTrades.reduce((s, t) => s + (t.profit||0), 0);
  const totalWins     = closedTrades.filter((t) => (t.profit||0) > 0).length;
  const winRate       = closedTrades.length ? ((totalWins / closedTrades.length) * 100).toFixed(1) : "0.0";
  const sessionActive = isSelectedSessionActive(sessions, sessionInfo);

  const addInstrument = (rawSym) => {
    const sym = (rawSym || newSymInput).trim().toUpperCase();
    if (!sym || instruments.includes(sym)) { setNewSymInput(""); return; }
    setInstruments((prev) => [...prev, sym]); setNewSymInput(""); addLog(`Added: ${sym}`, "info");
  };
  const removeInstrument = (sym) => {
    setInstruments((prev) => prev.filter((s) => s !== sym));
    setAiDecisions((prev) => { const n={...prev}; delete n[sym]; return n; });
    setAiStatus((prev)    => { const n={...prev}; delete n[sym]; return n; });
    setPrices((prev)      => { const n={...prev}; delete n[sym]; return n; });
    addLog(`Removed: ${sym}`, "warn");
  };
  const px = (sym) => { const p = prices[sym]; if (p==null) return "--"; return p>1000 ? p.toLocaleString("en",{maximumFractionDigits:2}) : p.toFixed(p>10?2:5); };
  const fl = (v) => { if (v==null) return "--"; return v>1000 ? v.toFixed(2) : v>10 ? v.toFixed(2) : v.toFixed(5); };

  return (
    <div className="app">
      <style>{CSS}</style>

      <aside className="sidebar">
        <div className="sb-head">
          <div className="sb-brand">
            <div className="sb-logo">Q</div>
            <div>
              <div>Quantum Bot</div>
              <div className="sb-sub">V9</div>
            </div>
          </div>
        </div>

        <nav className="sb-nav">
          {NAV.map((n) => (
            <div key={n.id} className={`sb-item${page===n.id?" on":""}`} onClick={() => setPage(n.id)}>
              <span className="sb-icon">{n.icon}</span>
              {n.label}
            </div>
          ))}
        </nav>

        <div className="sb-div" />

        <div className="sb-wl">
          {instruments.length === 0 ? (
            <div className="sb-wl-empty">No instruments &mdash; add in Settings</div>
          ) : (
            <>
              <div className="sb-wl-hd">Watchlist</div>
              {instruments.map((sym) => {
                const dec = aiDecisions[sym]; const d = dec?.decision;
                return (
                  <div key={sym} className="sb-row">
                    <div className="col" style={{ gap: 3 }}>
                      <span className="sb-sym">{sym}</span>
                      {d && d !== "WAIT" && <span className={`bdg bdg-${d==="LONG"?"long":"short"}`} style={{ fontSize: 8.5, padding: "1px 5px" }}>{d}</span>}
                    </div>
                    <span className="sb-px" style={{ color: prices[sym]!=null?"#fff":"#64748b" }}>{px(sym)}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div className="sb-foot">
          <div className="sf-row">
            <span className="sf-lbl">Session</span>
            <span className="sf-val" style={{ color: SESSION_COLORS[sessionInfo.session] && sessionInfo.session !== "ASIAN" ? "#a5b4fc" : "#94a3b8" }}>{sessionInfo.session}</span>
          </div>
          <div className="sf-row">
            <span className="sf-lbl">AI Gate</span>
            <span className="sf-val" style={{ color: sessionActive?"#86efac":"#94a3b8" }}>{sessionActive?"Active":"Inactive"}</span>
          </div>
          <div className="sf-row">
            <span className="sf-lbl">Risk</span>
            <span className="sf-val" style={{ color: riskMode==="AGGRESSIVE"?"#fca5a5":riskMode==="REGULAR"?"#fcd34d":"#cbd5e1" }}>{riskMode}</span>
          </div>
          <div className="sf-row">
            <span className="sf-lbl">UTC</span>
            <span className="sf-val tn">{nowStr}</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          {[
            ["Balance",   accountBalance!=null ? `$${accountBalance.toLocaleString("en",{minimumFractionDigits:2,maximumFractionDigits:2})}` : "--", null],
            ["Open",      openPositions.length, null],
            ["Today P&L", pnlStr(todayPnl), todayPnl>0?"#86efac":todayPnl<0?"#fca5a5":"#fff"],
            ["Win Rate",  `${winRate}%`, parseFloat(winRate)>=55?"#86efac":parseFloat(winRate)>=45?"#fcd34d":"#fca5a5"],
          ].map(([lbl,val,clr]) => (
            <div key={lbl} className="tc">
              <span className="tc-lbl">{lbl}</span>
              <span className="tc-val" style={clr?{color:clr}:{}}>{val}</span>
            </div>
          ))}
          <div className="tb-sep" />
          <span className="tb-time">{nowStr} UTC &mdash; <span style={{ color: "#fff", fontWeight: 600 }}>{sessionInfo.session}</span></span>
        </div>

        <div className="content">

          {/* ========== LIVE ========== */}
          {page === "live" && (
            <div className="s14">
              {instruments.length === 0 ? (
                <div className="panel empty">
                  <div className="empty-ico">&bull;</div>
                  <div className="empty-title">No instruments selected</div>
                  <p className="xs mut mt6" style={{ marginBottom: 18 }}>Add instruments in Settings to begin trading.</p>
                  <button className="btn btn-p" onClick={() => setPage("settings")}>Open Settings</button>
                </div>
              ) : (
                <>
                  <div className="inst-grid" style={{ gridTemplateColumns: `repeat(${Math.min(instruments.length,4)}, 1fr)` }}>
                    {instruments.map((sym) => {
                      const dec = aiDecisions[sym]; const status = aiStatus[sym]||"idle";
                      const bar = status==="long"?"#15803d":status==="short"?"#b91c1c":status==="thinking"?"#b45309":"#cbd5e1";
                      const tradeable = isTradeable(sym, sessionInfo.utcH, sessionInfo.isWeekend);
                      const cc = (dec?.confidence||0)>=65?"#15803d":(dec?.confidence||0)>=50?"#b45309":"#b91c1c";
                      return (
                        <div key={sym} className="inst-card">
                          <div className="inst-bar" style={{ background: bar }} />
                          <div className="inst-head">
                            <span className="inst-sym">{sym}</span>
                            <span className={`bdg bdg-${status==="long"?"long":status==="short"?"short":"wait"}`}>
                              {status==="thinking"?"Scanning":status==="error"?"Error":(status||"Idle").toUpperCase()}
                            </span>
                          </div>
                          <div className={`inst-px${prices[sym]==null?" inst-px-empty":""}`}>{px(sym)}</div>
                          {dec && dec.decision !== "WAIT" && (
                            <div className="s10">
                              <div className="r g8">
                                <div className="cring" style={{ border: `2px solid ${cc}`, color: cc }}>{dec.confidence||0}%</div>
                                <div className="col" style={{ gap: 3 }}>
                                  <span className="xs sub">Vol <span className="w7" style={{ color:"var(--text)" }}>{dec.volume}L</span></span>
                                  {dec.risk && <span className="xs" style={{ color: dec.risk==="HIGH"?"#b91c1c":dec.risk==="MEDIUM"?"#b45309":"#15803d" }}>{dec.risk} risk</span>}
                                </div>
                              </div>
                              {dec.strategy && <div className="inst-strat">{dec.strategy}</div>}
                              {dec.stopLoss && dec.takeProfit1 && (
                                <div className="inst-tp">
                                  <span style={{ color:"#b91c1c" }}>SL {fl(dec.stopLoss)}</span>
                                  <span className="mut">/</span>
                                  <span style={{ color:"#15803d" }}>TP1 {fl(dec.takeProfit1)}</span>
                                </div>
                              )}
                            </div>
                          )}
                          {dec && dec.decision === "WAIT" && dec.reason && (
                            <div className="inst-why">{dec.reason.slice(0,90)}{dec.reason.length>90?"...":""}</div>
                          )}
                          {crownLocks[sym] && <div className="inst-crown">&#9733; Crown: {crownLocks[sym]}</div>}
                          {!tradeable && <div className="inst-off">Outside trading hours</div>}
                          {tradeable && !sessionActive && <div className="inst-off">Session not selected</div>}
                        </div>
                      );
                    })}
                  </div>

                  <div className="panel">
                    <div className="r g8 mb14" style={{ justifyContent:"space-between" }}>
                      <div className="pt pt0">Open Positions</div>
                      <span className="bdg bdg-blue">{openPositions.length}</span>
                    </div>
                    {openPositions.length === 0 ? (
                      <div style={{ padding:"16px 0", textAlign:"center", color:"var(--text3)", fontSize:12 }}>No open positions</div>
                    ) : (
                      <table className="ptbl">
                        <thead><tr>{["Instrument","Dir","Vol","Open","Current","P&L"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {openPositions.map((pos, i) => {
                            const pnl = pos.profit||0; const dir = pos.type==="POSITION_TYPE_BUY"?"LONG":"SHORT"; const pdp = (pos.openPrice||0)>100?2:5;
                            return (
                              <tr key={i}>
                                <td style={{ fontWeight:700, color:"var(--gold)", fontSize:13 }}>{normSym(pos.symbol)}</td>
                                <td><span className={`bdg bdg-${dir.toLowerCase()}`}>{dir}</span></td>
                                <td className="sub xs">{pos.volume}L</td>
                                <td className="mut xs tn">{(pos.openPrice||0).toFixed(pdp)}</td>
                                <td className="sub xs tn">{(pos.currentPrice||0).toFixed(pdp)}</td>
                                <td style={{ fontWeight:700, color:pnlColor(pnl), fontSize:13 }} className="tn">{pnlStr(pnl)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div className="panel">
                    <div className="r g8 mb14" style={{ justifyContent:"space-between" }}>
                      <div className="pt pt0">System Log</div>
                      <button className="btn btn-g btn-sm" onClick={() => setLog([])}>Clear</button>
                    </div>
                    <div ref={logRef} className="log-wrap">
                      {log.length === 0
                        ? <div className="xs mut" style={{ padding:"12px 0" }}>Waiting for activity...</div>
                        : log.slice().reverse().map((l, i) => (
                          <div key={i} className={`log-ln log-${l.type}`}>
                            <span className="log-ts">{l.time}</span>
                            <span className="log-m">{l.msg}</span>
                          </div>
                        ))
                      }
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ========== REPORTS ========== */}
          {page === "reports" && (() => {
            const trades = [...closedTrades].sort((a,b) => new Date(b.time||b.closeTime||0)-new Date(a.time||a.closeTime||0));
            const netPnl = trades.reduce((s,t) => s+(t.profit||0), 0);
            const w = trades.filter((t) => (t.profit||0)>0).length;
            const wr = trades.length ? ((w/trades.length)*100).toFixed(1) : "0.0";
            const avgPnl = trades.length ? netPnl/trades.length : 0;
            const instMap = {}; trades.forEach((t) => { const k=normSym(t.symbol)||"UNKNOWN"; if (!instMap[k]) instMap[k]={t:0,w:0,pnl:0}; instMap[k].t++; instMap[k].pnl+=t.profit||0; if ((t.profit||0)>0) instMap[k].w++; });
            const sessMap = {}; trades.forEach((t) => { const s=getSessionLabel(t.time||t.closeTime); if (!sessMap[s]) sessMap[s]={t:0,w:0,pnl:0}; sessMap[s].t++; sessMap[s].pnl+=t.profit||0; if ((t.profit||0)>0) sessMap[s].w++; });
            return (
              <div className="s14">
                <div className="g4c">
                  {[
                    ["Total Trades", trades.length, "var(--blue)"],
                    ["Net P&L", pnlStr(netPnl), pnlColor(netPnl)],
                    ["Win Rate", `${wr}%`, parseFloat(wr)>=55?"var(--green)":parseFloat(wr)>=45?"var(--gold)":"var(--red)"],
                    ["Avg / Trade", pnlStr(avgPnl), pnlColor(avgPnl)],
                  ].map(([lbl,val,clr]) => (
                    <div key={lbl} className="panel"><div className="pt">{lbl}</div><div style={{ fontSize:24,fontWeight:700,color:clr,letterSpacing:"-0.5px" }}>{val}</div></div>
                  ))}
                </div>
                <div className="g2">
                  <div className="panel">
                    <div className="pt">By Instrument</div>
                    {Object.keys(instMap).length===0 && <div className="xs mut">No data yet</div>}
                    {Object.entries(instMap).map(([sym,s]) => (
                      <div key={sym} className="srow">
                        <span className="w7" style={{ width:80,fontSize:12.5,color:"var(--gold)" }}>{sym}</span>
                        <span className="xs sub">{s.t}t</span>
                        <span className="xs" style={{ color:"var(--green)" }}>{s.w}W</span>
                        <span className="xs mut">{s.t-s.w}L</span>
                        <span className="ml w7 tn" style={{ fontSize:12.5,color:pnlColor(s.pnl) }}>{pnlStr(s.pnl)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="panel">
                    <div className="pt">By Session</div>
                    {Object.keys(sessMap).length===0 && <div className="xs mut">No data yet</div>}
                    {Object.entries(sessMap).sort((a,b) => b[1].t-a[1].t).map(([sess,s]) => (
                      <div key={sess} className="srow">
                        <span className="w7" style={{ width:80,fontSize:12.5,color:SESSION_COLORS[sess]||"var(--text2)" }}>{sess}</span>
                        <span className="xs sub">{s.t}t</span>
                        <span className="xs" style={{ color:"var(--green)" }}>{s.w}W</span>
                        <span className="xs mut">{s.t-s.w}L</span>
                        <span className="ml w7 tn" style={{ fontSize:12.5,color:pnlColor(s.pnl) }}>{pnlStr(s.pnl)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="panel">
                  <div className="pt">Trade History ({trades.length})</div>
                  {trades.length===0
                    ? <div style={{ padding:"20px 0",textAlign:"center",color:"var(--text3)",fontSize:12 }}>No closed trades yet</div>
                    : (
                      <div style={{ maxHeight:480,overflowY:"auto" }}>
                        <table className="ptbl" style={{ width:"100%" }}>
                          <thead><tr>{["Date","Time","Symbol","Dir","Vol","Price","P&L"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                          <tbody>
                            {trades.slice(0,200).map((t, i) => {
                              const pnl=t.profit||0; const dir=t.type==="DEAL_TYPE_BUY"?"BUY":t.type==="DEAL_TYPE_SELL"?"SELL":(t.type||""); const pdp=(t.price||0)>100?2:5;
                              return (
                                <tr key={i}>
                                  <td className="mut xs">{fmtDate(t.time||t.closeTime)}</td>
                                  <td className="mut xs tn">{fmtTime(t.time||t.closeTime)}</td>
                                  <td style={{ fontWeight:700,color:"var(--gold)",fontSize:12 }}>{normSym(t.symbol)}</td>
                                  <td style={{ fontSize:11,color:dir==="BUY"?"var(--green)":"var(--red)",fontWeight:600 }}>{dir}</td>
                                  <td className="sub xs">{(t.volume||0).toFixed(2)}L</td>
                                  <td className="mut xs tn">{(t.price||0).toFixed(pdp)}</td>
                                  <td style={{ fontWeight:700,color:pnlColor(pnl),fontSize:12 }} className="tn">{pnlStr(pnl)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )
                  }
                </div>
              </div>
            );
          })()}

          {/* ========== STRATEGY LAB ========== */}
          {page === "lab" && (() => {
            const labData = learnedStats||{};
            const sorted  = Object.entries(labData).sort((a,b) => (b[1].total||0)-(a[1].total||0));
            const labInst = [...new Set(sorted.flatMap(([,d]) => Object.keys(d.instruments||{})))].sort();
            const totals  = sorted.reduce((acc,[,d]) => { acc.t+=d.total||0; acc.w+=d.totalWins||0; acc.l+=d.totalLosses||0; acc.pnl+=d.totalPnl||0; return acc; }, {t:0,w:0,l:0,pnl:0});
            return (
              <div className="s14">
                <div className="g4c">
                  {[
                    ["Strategies",   sorted.length, "var(--blue)"],
                    ["Total Trades", totals.t, "var(--text)"],
                    ["Win Rate",     totals.t ? `${Math.round(totals.w/totals.t*100)}%` : "--", totals.t&&totals.w/totals.t>=0.55?"var(--green)":totals.t&&totals.w/totals.t>=0.45?"var(--gold)":"var(--red)"],
                    ["Net P&L",      pnlStr(totals.pnl), pnlColor(totals.pnl)],
                  ].map(([lbl,val,clr]) => (
                    <div key={lbl} className="panel"><div className="pt">{lbl}</div><div style={{ fontSize:24,fontWeight:700,color:clr,letterSpacing:"-0.5px" }}>{val}</div></div>
                  ))}
                </div>
                {sorted.length === 0 ? (
                  <div className="panel empty">
                    <div className="empty-ico">&#9651;</div>
                    <div className="empty-title">Strategy Lab is Empty</div>
                    <p className="xs mut mt6">Trade results will populate this automatically. Data persists forever (no TTL).</p>
                  </div>
                ) : (
                  sorted.map(([strat, data]) => {
                    const bl = (blacklist||[]).includes(strat); const cr = data.crowns||0; const wr = data.overallWinRate;
                    const leftColor = bl?"var(--purple)":cr>=3?"var(--gold)":cr>=2?"var(--blue)":cr>=1?"var(--green)":"var(--border2)";
                    const wc = wr!=null ? (wr>=65?"var(--green)":wr>=50?"var(--gold)":"var(--red)") : "var(--text3)";
                    const tpd = data.aggTpDistribution || {};
                    const totalTp = (tpd.tp1Only||0)+(tpd.tp2Reached||0)+(tpd.tp3Reached||0)+(tpd.tp4Reached||0)+(tpd.slHit||0);
                    return (
                      <div key={strat} className="lc" style={{ borderLeftColor:leftColor, opacity:bl?0.7:1 }}>
                        <div className="lc-head">
                          <div style={{ flex:1,minWidth:0 }}>
                            <div className="r g8 mb8" style={{ flexWrap:"wrap" }}>
                              {cr>=1 && <span style={{ color:"var(--gold)",fontSize:13,fontWeight:700 }}>{"\u2605".repeat(Math.min(cr,3))}</span>}
                              <span className="w7" style={{ fontSize:13.5,wordBreak:"break-word" }}>{strat}</span>
                              {bl           && <span className="bdg bdg-purple">Blacklisted</span>}
                              {data.isLocked && <span className="bdg bdg-gold">Locked</span>}
                              {(data.bannedOn||[]).length>0 && <span className="bdg bdg-red">Ban: {(data.bannedOn||[]).join(", ")}</span>}
                            </div>
                            <div className="r g10 sm sub">
                              <span>{data.total||0} trades</span>
                              <span style={{ color:"var(--green)" }}>{data.totalWins||0}W</span>
                              <span style={{ color:"var(--red)" }}>{data.totalLosses||0}L</span>
                              {wr!=null && <span className="w7" style={{ color:wc }}>{wr}% WR</span>}
                              {data.totalPnl!=null && <span className="w7 tn" style={{ color:pnlColor(data.totalPnl) }}>{pnlStr(data.totalPnl)}</span>}
                            </div>
                          </div>
                          {wr!=null && (
                            <div style={{ width:50,height:50,borderRadius:"50%",flexShrink:0,border:`3px solid ${wc}`,display:"flex",alignItems:"center",justifyContent:"center" }}>
                              <span style={{ fontSize:12,fontWeight:800,color:wc }}>{wr}%</span>
                            </div>
                          )}
                        </div>

                        <div className="lc-body">
                          {/* TP distribution bar */}
                          {totalTp > 0 && (
                            <div style={{ marginBottom:12 }}>
                              <div className="lc-stat-lbl mb8">TP Distribution</div>
                              <div className="tpd-bar">
                                {[
                                  ["tp4Reached", "#15803d", "TP4"],
                                  ["tp3Reached", "#22c55e", "TP3"],
                                  ["tp2Reached", "#84cc16", "TP2"],
                                  ["tp1Only",    "#b45309", "TP1 only"],
                                  ["slHit",      "#b91c1c", "SL"],
                                ].map(([k, c, l]) => {
                                  const v = tpd[k] || 0;
                                  if (v === 0) return null;
                                  const pct = (v / totalTp) * 100;
                                  return <div key={k} className="tpd-seg" style={{ width: `${pct}%`, background: c }} title={`${l}: ${v} (${pct.toFixed(0)}%)`} />;
                                })}
                              </div>
                              <div className="r g10 mt6 xs sub" style={{ flexWrap: "wrap" }}>
                                {tpd.tp4Reached > 0 && <span><span style={{color:"#15803d"}}>&#9632;</span> TP4 {tpd.tp4Reached}</span>}
                                {tpd.tp3Reached > 0 && <span><span style={{color:"#22c55e"}}>&#9632;</span> TP3 {tpd.tp3Reached}</span>}
                                {tpd.tp2Reached > 0 && <span><span style={{color:"#84cc16"}}>&#9632;</span> TP2 {tpd.tp2Reached}</span>}
                                {tpd.tp1Only    > 0 && <span><span style={{color:"#b45309"}}>&#9632;</span> TP1 only {tpd.tp1Only}</span>}
                                {tpd.slHit      > 0 && <span><span style={{color:"#b91c1c"}}>&#9632;</span> SL {tpd.slHit}</span>}
                              </div>
                            </div>
                          )}

                          {data.failureNote && (
                            <div className="fail-note">Why it fails: {data.failureNote}</div>
                          )}

                          {labInst.length > 0 && (
                            <div className="mt12">
                              <div className="lc-stat-lbl mb8">Per-Instrument Breakdown</div>
                              <div style={{ display:"grid", gridTemplateColumns:`repeat(${Math.min(labInst.length,5)}, 1fr)`, gap:8 }}>
                                {labInst.map((inst) => {
                                  const d = (data.instruments||{})[inst];
                                  const ic = d&&d.crown?"var(--green)":d&&d.banned?"var(--red)":"var(--border2)";
                                  return (
                                    <div key={inst} className="lic" style={{ borderColor:ic, opacity:d?1:0.4 }}>
                                      <div className="r g6 mb6" style={{ justifyContent:"space-between" }}>
                                        <span className="xs w7 sub">{inst}</span>
                                        {d&&d.crown  && <span className="bdg bdg-gold" style={{ fontSize:8 }}>Crown</span>}
                                        {d&&d.banned && <span className="bdg bdg-red"  style={{ fontSize:8 }}>Ban</span>}
                                      </div>
                                      {d ? (
                                        <>
                                          <div className="r g6 xs">
                                            <span style={{ color:"var(--green)" }}>{d.wins}W</span>
                                            <span style={{ color:"var(--red)" }}>{d.losses}L</span>
                                          </div>
                                          {d.winRate!=null && (
                                            <>
                                              <div className="wrb mt6"><div className="wrf" style={{ width:`${d.winRate}%`,background:d.winRate>=65?"var(--green)":d.winRate>=50?"var(--gold)":"var(--red)" }} /></div>
                                              <div className="mt4 xs mut">{d.winRate}% &middot; {d.avgPnl!=null ? `${d.avgPnl>=0?"+":""}$${d.avgPnl}` : ""}</div>
                                            </>
                                          )}
                                        </>
                                      ) : (
                                        <div className="xs mut">Not tested</div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })()}

          {/* ========== SETTINGS ========== */}
          {page === "settings" && (
            <div className="set-col">
              <div className="panel">
                <div className="pt">Instruments to Trade</div>
                <div className="r g8">
                  <input className="inp" placeholder="Exact broker symbol, e.g. XAUUSD.s or EURUSD.s" value={newSymInput} onChange={(e) => setNewSymInput(e.target.value.toUpperCase())} onKeyDown={(e) => e.key==="Enter" && addInstrument()} style={{ flex:1 }} />
                  <button className="btn btn-p btn-sm" onClick={() => addInstrument()}>Add</button>
                </div>
                <div className="qrow">
                  {QUICK_SYMBOLS.map((s) => (
                    <button key={s} className={`qbtn${instruments.includes(s)?" on":""}`} onClick={() => instruments.includes(s) ? removeInstrument(s) : addInstrument(s)}>{s}</button>
                  ))}
                </div>
                {instruments.length === 0
                  ? <div className="mt10 xs mut">No instruments selected. Type a symbol or click a suggestion.</div>
                  : (
                    <div className="stags">
                      {instruments.map((sym) => (
                        <div key={sym} className="stag">
                          <span className="stag-n">{sym}</span>
                          {prices[sym]!=null && <span className="stag-p">{px(sym)}</span>}
                          <button className="stag-rm" onClick={() => removeInstrument(sym)} title="Remove">&times;</button>
                        </div>
                      ))}
                    </div>
                  )
                }
                <div className="mt12 xs mut">
                  Tip: PU Prime uses .s suffix on most symbols (e.g. EURUSD.s, XAUUSD.s). The system auto-tries common suffixes if the bare symbol fails, but typing the exact broker symbol is fastest.
                </div>
              </div>

              <div className="panel">
                <div className="pt">Active Sessions</div>
                <div className="segs">
                  {["LONDON","OVERLAP","NEW YORK"].map((s) => (
                    <button key={s} className={`seg${sessions.includes(s)?" on":""}`} onClick={() => setSessions((prev) => prev.includes(s) ? prev.filter((x) => x!==s) : [...prev,s])}>{s}</button>
                  ))}
                </div>
                <div className="mt8 xs mut">AI runs only during selected sessions. Gold/Forex: 08:00&ndash;21:00 UTC. Crypto: 07:00&ndash;23:00 UTC. No weekends. No trades during high-impact news (ForexFactory).</div>
                <div className="mt8" style={{ display:"flex", gap:6, alignItems:"center", fontSize:11 }}>
                  <span style={{ width:8,height:8,borderRadius:"50%",background:sessionActive?"var(--green)":"var(--text3)",display:"inline-block",flexShrink:0 }} />
                  <span style={{ color:sessionActive?"var(--green)":"var(--text3)", fontWeight:600 }}>{sessionActive?"Session active":"Session inactive"}</span>
                  <span className="mut">({sessionInfo.session})</span>
                </div>
              </div>

              <div className="panel">
                <div className="pt">Risk Mode</div>
                <div className="segs">
                  {["TEST","REGULAR","AGGRESSIVE"].map((m) => (
                    <button key={m} className={`seg${riskMode===m?" on":""}${m==="AGGRESSIVE"?" agg":""}`} onClick={() => setRiskMode(m)}>{m}</button>
                  ))}
                </div>
                <div className="mt8 xs mut">
                  {riskMode==="TEST" ? "0.5% risk per trade, max 0.05L" : riskMode==="REGULAR" ? "1% risk per trade, max 0.20L" : "2% risk per trade, max 0.50L \u2014 use with caution"}
                </div>
              </div>

              {Object.keys(crownLocks).length > 0 && (
                <div className="panel">
                  <div className="pt">Crown Locks</div>
                  <div className="stags">
                    {Object.entries(crownLocks).map(([inst,strat]) => (
                      <div key={inst} style={{ background:"#fef3c7", border:"1px solid #fde68a", borderRadius:6, padding:"6px 12px", fontSize:11.5, display:"flex", alignItems:"center", gap:6 }}>
                        <span style={{ color:"var(--gold)",fontWeight:700 }}>&#9733;</span>
                        <span className="w6">{inst}:</span>
                        <span style={{ color:"var(--text2)",fontSize:11 }}>{strat}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="panel">
                <div className="pt">Configuration</div>
                {[
                  ["Instruments",    instruments.join(", ")||"none"],
                  ["Sessions",       sessions.join(", ")||"none"],
                  ["Risk Mode",      riskMode],
                  ["Data Namespace", "v9:* (persistent, no TTL)"],
                  ["News Source",    "ForexFactory (high-impact, +/-15 min block)"],
                ].map(([k,v]) => (
                  <div key={k} className="kv">
                    <span className="kv-k">{k}</span>
                    <span className="kv-v">{v}</span>
                  </div>
                ))}
              </div>

              <div className="panel">
                <div className="pt">Reset Preferences</div>
                <p className="xs mut" style={{ marginBottom:14 }}>Removes saved instruments, sessions, and risk mode from this browser. Strategy Lab data on the server is not affected.</p>
                <button className="btn btn-d btn-sm" onClick={() => { localStorage.removeItem(PREFS_KEY); setInstruments([]); setSessions(["LONDON","NEW YORK"]); setRiskMode("TEST"); setAiDecisions({}); setAiStatus({}); setPrices({}); addLog("Preferences cleared.", "warn"); }}>
                  Clear Preferences
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}