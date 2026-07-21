/* eslint-disable */
// =====================================================================
// QUANTUM BOT V13 — PILOT DASHBOARD (v13.1)
// =====================================================================
// Aligned to rules-store.js v1.2 shape. Backend endpoints used:
//   /api/broker               — account, positions
//   /api/rules                — read/write all dashboard rules
//   /api/rules?action=activity — server-side activity log
//   /api/rules?action=daily-pnl — today's realized P&L
//   /api/template-performance — closed-trade stats
//   /api/recognition-memory?action=stats — KNN memory stats   [v13.1]
//   /api/watched-setups       — manual-mode active watches
//   /api/symbol-resolver      — broker symbol mapping
//
// TWO-AXIS MODE MODEL:
//   activeMode:   sleep | active | defensive | vacation  (what setups are allowed)
//   tradingMode:  auto | manual                          (does bot execute, or alert only?)
//
// v13.1 ADDITIVE FEATURES (no existing logic touched):
//   1. Collapsible activity feed (▼/▲ toggle)
//   2. UTC time + session + date in header (TimeDisplay)
//   3. Recognition memory statistics panel (RecognitionPanel)
//   4. Template × Instrument performance heatmap, WR/PF toggle (PerfHeatmapPanel)
// =====================================================================

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";

// =====================================================================
// 1 · CONSTANTS
// =====================================================================

const API = (p) => `/api/${p}`;
const PREFS_KEY = "qb_v13_prefs";
const THEME_KEY = "qb_v13_theme";

const ACTIVE_MODES = [
  { id: "sleep",     label: "Sleep",     glyph: "🌙", hint: "Only swing setups · half lot · max 1 position" },
  { id: "active",    label: "Active",    glyph: "☕", hint: "All templates · full lot · full management" },
  { id: "defensive", label: "Defensive", glyph: "🛡️", hint: "High-confidence templates · half lot · min 2R" },
  { id: "vacation",  label: "Vacation",  glyph: "🏖️", hint: "Block all new trades · existing positions managed" },
];

const TRADING_MODES = [
  { id: "auto",   label: "Auto",   glyph: "◆", hint: "Bot places orders automatically" },
  { id: "manual", label: "Manual", glyph: "✋", hint: "Bot watches & alerts · you place trades in MT5" },
];

const TEMPLATE_DISPLAY = {
  "silver-bullet":    { glyph: "🥈", label: "Silver Bullet" },
  "unicorn":          { glyph: "🦄", label: "Unicorn" },
  "turtle-soup":      { glyph: "🐢", label: "Turtle Soup" },
  "judas-swing":      { glyph: "🎭", label: "Judas Swing" },
  "ote-continuation": { glyph: "🎯", label: "OTE Continuation" },
  "am-ifvg":          { glyph: "🌅", label: "AM IFVG Reversal" },
  "orb":              { glyph: "🚀", label: "ORB Breakout" },
  "orb-pro":          { glyph: "⚡", label: "PRO ORB" },
  "reaction":         { glyph: "🎯", label: "Reaction (coil break)" },
  "reaction-fvg":     { glyph: "🌀", label: "Reaction (FVG)" },
  "reaction-ifvg":    { glyph: "🔄", label: "Reaction (IFVG)" },
  "alexg":            { glyph: "📐", label: "Alex G Set&Forget" },
};

const TEMPLATE_ORDER = [
  "silver-bullet", "unicorn", "turtle-soup", "judas-swing", "ote-continuation", "am-ifvg",
  "orb", "orb-pro", "reaction", "reaction-fvg", "reaction-ifvg", "alexg",
];

// v14: the five ICT templates are grouped under one collapsible "ICT" header in
// the UI, but stay separately measured so you can see which sub-setup actually
// works and prune the losers.
const ICT_TEMPLATES = ["silver-bullet", "unicorn", "turtle-soup", "judas-swing", "ote-continuation", "am-ifvg"];
// The three reaction confirmation paths — separately measured, grouped in the UI.
const REACTION_TEMPLATES = ["reaction", "reaction-fvg", "reaction-ifvg"];

const ASSET_CATALOG = [
  { id: "eurusd",   name: "EUR/USD",     category: "forex"     },
  { id: "gbpusd",   name: "GBP/USD",     category: "forex"     },
  { id: "usdjpy",   name: "USD/JPY",     category: "forex"     },
  { id: "usdchf",   name: "USD/CHF",     category: "forex"     },
  { id: "audusd",   name: "AUD/USD",     category: "forex"     },
  { id: "eurjpy",   name: "EUR/JPY",     category: "forex"     },
  { id: "gbpjpy",   name: "GBP/JPY",     category: "forex"     },
  { id: "gold",     name: "Gold",        category: "metal"     },
  { id: "silver",   name: "Silver",      category: "metal"     },
  { id: "btc",      name: "Bitcoin",     category: "crypto"    },
  { id: "eth",      name: "Ethereum",    category: "crypto"    },
  { id: "nas100",   name: "Nasdaq 100",  category: "index"     },
  { id: "us30",     name: "Dow Jones",   category: "index"     },
  { id: "us500",    name: "S&P 500",     category: "index"     },
  { id: "ger40",    name: "DAX 40",      category: "index"     },
  { id: "jp225",    name: "Nikkei 225",  category: "index"     },
  { id: "oil_wti",  name: "WTI Crude",   category: "commodity" },
];

const PIP_SIZE = {
  eurusd: 0.0001, gbpusd: 0.0001, audusd: 0.0001, nzdusd: 0.0001, usdjpy: 0.01,
  usdchf: 0.0001, usdcad: 0.0001, eurjpy: 0.01, gbpjpy: 0.01, eurgbp: 0.0001,
  gold: 0.1, silver: 0.01, btc: 1, eth: 0.01,
  nas100: 1, us30: 1, us500: 0.1, ger40: 0.1, jp225: 1,
  oil_wti: 0.01,
};

// =====================================================================
// 2 · THEME
// =====================================================================

const DEFAULT_THEME = {
  bgVoid:       "#06070a",
  bgPanel:      "#0c0e14",
  bgPanelHi:    "#11141c",
  border:       "rgba(255,255,255,0.06)",
  borderHi:     "rgba(255,255,255,0.12)",
  borderAccent: "rgba(0,217,255,0.35)",
  textHi:       "#e6e8ec",
  textMid:      "#9098a3",
  textLo:       "#5a606b",
  textFaint:    "#3a3e47",
  accent:       "#00d9ff",
  accentSoft:   "rgba(0,217,255,0.10)",
  warn:         "#ffb84d",
  warnSoft:     "rgba(255,184,77,0.12)",
  ok:           "#4ade80",
  okSoft:       "rgba(74,222,128,0.10)",
  bad:          "#f87171",
  badSoft:      "rgba(248,113,113,0.10)",
  fontSans:     "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontMono:     "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  fontSerif:    "'Instrument Serif', Georgia, serif",
};

const loadTheme = () => {
  try { const s = localStorage.getItem(THEME_KEY); return s ? { ...DEFAULT_THEME, ...JSON.parse(s) } : DEFAULT_THEME; }
  catch (_) { return DEFAULT_THEME; }
};
const saveTheme = (t) => { try { localStorage.setItem(THEME_KEY, JSON.stringify(t)); } catch (_) {} };
const camelToKebab = (s) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const applyThemeVars = (t) => {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === "string" || typeof v === "number") {
      root.style.setProperty("--qb-" + camelToKebab(k), String(v));
    }
  }
};

// =====================================================================
// 3 · PREFS
// =====================================================================

const DEFAULT_PREFS = {
  watchlist: ["gold", "eurusd", "gbpusd", "usdjpy", "nas100", "us500", "btc"],
};

const loadPrefs = () => {
  try { const s = localStorage.getItem(PREFS_KEY); return s ? { ...DEFAULT_PREFS, ...JSON.parse(s) } : DEFAULT_PREFS; }
  catch (_) { return DEFAULT_PREFS; }
};
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) {} };

// =====================================================================
// 4 · FORMATTERS
// =====================================================================

const fmtUSD = (v, signed = false) => {
  if (v == null || !isFinite(v)) return "—";
  const sign = signed && v >= 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
};
const fmtPct = (v, digits = 2, signed = true) => {
  if (v == null || !isFinite(v)) return "—";
  const sign = signed && v >= 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
};
const fmtPrice = (p, assetId) => {
  if (p == null || !isFinite(p)) return "—";
  const pip = PIP_SIZE[assetId] || 0.0001;
  const dec = pip >= 1 ? 2 : pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : pip >= 0.001 ? 4 : 5;
  return p.toFixed(dec);
};
const fmtTime = (ts) => {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};
const fmtAge = (ts) => {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

const getAssetById = (id) => ASSET_CATALOG.find((a) => a.id === id) || null;

// =====================================================================
// 5 · GLOBAL STYLES
// =====================================================================

const GLOBAL_STYLES = `
  * { box-sizing: border-box; }
  html, body, #root { margin:0; padding:0; min-height:100%; background: var(--qb-bg-void); color: var(--qb-text-hi); font-family: var(--qb-font-sans); -webkit-font-smoothing: antialiased; }
  
  .qb-mono { font-family: var(--qb-font-mono); font-variant-numeric: tabular-nums; }
  .qb-serif { font-family: var(--qb-font-serif); }
  .qb-panel { background: var(--qb-bg-panel); border: 1px solid var(--qb-border); border-radius: 6px; }
  .qb-cell { background: var(--qb-bg-panel-hi); border: 1px solid var(--qb-border); border-radius: 4px; }
  @keyframes qbPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .qb-pulse { animation: qbPulse 2s ease-in-out infinite; }
  .qb-clickable { cursor: pointer; transition: background 120ms, border-color 120ms; }
  .qb-clickable:hover { border-color: var(--qb-border-hi); }
  *::-webkit-scrollbar { width:5px; height:5px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius:3px; }
  *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.12); }
  input, button, select, textarea { font-family: inherit; color: inherit; }
  input:focus, button:focus, select:focus { outline: none; }
  .qb-divider { height:1px; background: var(--qb-border); margin: 8px 0; }
`;

// =====================================================================
// 6 · ROOT
// =====================================================================

// v13.2 — viewport width detection for desktop/mobile layout switch
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    () => (typeof window !== "undefined" ? window.innerWidth < breakpoint : false)
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

export default function App() {
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => { applyThemeVars(theme); saveTheme(theme); }, [theme]);

  useEffect(() => {
    const id = "qb-styles-v13";
    if (document.getElementById(id)) return;
    const s = document.createElement("style");
    s.id = id; s.textContent = GLOBAL_STYLES;
    document.head.appendChild(s);
  }, []);

  // v13.2 — ensure a mobile viewport meta exists (won't clobber an existing one)
  useEffect(() => {
    let m = document.querySelector('meta[name="viewport"]');
    if (!m) { m = document.createElement("meta"); m.name = "viewport"; document.head.appendChild(m); }
    if (!m.content || !/width=device-width/.test(m.content)) {
      m.content = "width=device-width, initial-scale=1, viewport-fit=cover";
    }
  }, []);

  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  return <PilotDashboard prefs={prefs} setPrefs={setPrefs} theme={theme} setTheme={setTheme} />;
}

// =====================================================================
// 7 · PILOT DASHBOARD
// =====================================================================

function PilotDashboard({ prefs, setPrefs, theme, setTheme }) {

  const isMobile = useIsMobile();

  // ── Broker state (existing endpoint) ───────────────────────────────
  const [account, setAccount]     = useState(null);
  const [positions, setPositions] = useState([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const a = await fetch(API("broker?action=account")).then((r) => r.json()).catch(() => null);
        if (alive && a && !a.error) setAccount(a);
        const p = await fetch(API("broker?action=positions")).then((r) => r.json()).catch(() => []);
        if (alive) setPositions(Array.isArray(p) ? p : []);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ── Rules state (NEW: /api/rules) ──────────────────────────────────
  const [rules, setRules]           = useState(null);
  const [rulesError, setRulesError] = useState(null);

  const loadRules = useCallback(async () => {
    try {
      const r = await fetch(API("rules")).then((res) => res.json());
      if (r && !r.error) { setRules(r); setRulesError(null); }
      else setRulesError(r?.error || "endpoint not deployed");
    } catch (e) { setRulesError(e.message || "fetch failed"); }
  }, []);

  useEffect(() => {
    loadRules();
    const id = setInterval(loadRules, 15000);
    return () => clearInterval(id);
  }, [loadRules]);

  // ── Generic rules action caller ────────────────────────────────────
  const callRulesAction = useCallback(async (action, body = {}) => {
    try {
      const r = await fetch(API(`rules?action=${action}`), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      }).then((res) => res.json());
      if (r?.ok && r?.rules) setRules(r.rules);
      else if (r?.error) console.warn(`[rules] ${action} failed:`, r.error);
      loadRules();
      return r;
    } catch (e) {
      console.error(`[rules] ${action} error:`, e);
      return { ok: false, error: e.message };
    }
  }, [loadRules]);

  // ── Activity log (NEW: server-side) ────────────────────────────────
  const [activity, setActivity] = useState([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("rules?action=activity&limit=50")).then((res) => res.json());
        if (alive && r?.activity) setActivity(r.activity);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ── Daily P&L (NEW) ────────────────────────────────────────────────
  const [dailyPnL, setDailyPnL] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        // v14.1: source "Today" from the broker's actual closed deals (matches MT5).
        const r = await fetch(API("manage-trades?action=today-pnl")).then((res) => res.json());
        if (alive && r?.ok && typeof r.pnl === "number") { setDailyPnL(r.pnl); return; }
        // fallback to the internal counter only if the broker fetch fails
        const r2 = await fetch(API("rules?action=daily-pnl")).then((res) => res.json());
        if (alive && r2?.pnl != null) setDailyPnL(r2.pnl);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ── Template performance ───────────────────────────────────────────
  const [perf, setPerf]           = useState(null);
  const [perfError, setPerfError] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("template-performance")).then((res) => res.json());
        if (alive) {
          if (r && !r.error) { setPerf(r); setPerfError(null); }
          else setPerfError(r?.error || "endpoint not deployed");
        }
      } catch (e) { if (alive) setPerfError(e.message); }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ── v14 · Macro regime (news + volatility + manual override) ────────
  const [regime, setRegime] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("market-regime")).then((res) => res.json());
        if (alive && r && r.regime) setRegime(r.regime);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const setRegimeOverride = useCallback(async (mode) => {
    try {
      const r = await fetch(API("market-regime?action=set-override"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      }).then((res) => res.json());
      if (r && r.regime) setRegime(r.regime);
    } catch (e) { console.error("[regime] override error:", e); }
  }, []);

  // ── Symbol resolver ────────────────────────────────────────────────
  const [resolver, setResolver] = useState(null);
  useEffect(() => {
    fetch(API("symbol-resolver?action=status"))
      .then((r) => r.json()).then(setResolver).catch(() => setResolver({ error: "unavailable" }));
  }, []);

  // ── Modal state ────────────────────────────────────────────────────
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [estopOpen, setEstopOpen]           = useState(false);
  const [settingsOpen, setSettingsOpen]     = useState(false);

  // ── Derived values ─────────────────────────────────────────────────
  const activeMode  = rules?.activeMode || "active";
  const tradingMode = rules?.tradingMode || "auto";
  const estopActive = rules?.account?.emergencyStop === true;
  const balance     = account?.balance;
  const equity      = account?.equity ?? balance;
  const floatingPnL = account?.profit ?? 0;

  // ── Action handlers ────────────────────────────────────────────────
  const setActiveModeAction  = (mode) => callRulesAction("set-active-mode",  { mode });
  const setTradingModeAction = (mode) => callRulesAction("set-trading-mode", { mode });
  const triggerEStop  = () => { callRulesAction("emergency-stop", { enable: true  }); setEstopOpen(false); };
  const clearEStop    = () => callRulesAction("emergency-stop", { enable: false });

  // ── v13.2 · MOBILE LAYOUT (desktop layout below is untouched) ───────
  if (isMobile) {
    return (
      <MobileLayout
        equity={equity} balance={balance}
        floatingPnL={floatingPnL} dailyPnL={dailyPnL}
        positions={positions}
        rules={rules} rulesError={rulesError}
        perf={perf} perfError={perfError}
        activity={activity}
        resolver={resolver}
        prefs={prefs} setPrefs={setPrefs}
        theme={theme} setTheme={setTheme}
        activeMode={activeMode} tradingMode={tradingMode}
        estopActive={estopActive}
        regime={regime} setRegimeOverride={setRegimeOverride}
        callRulesAction={callRulesAction}
      />
    );
  }

  return (
    <div style={{
      width: "100vw", minHeight: "100vh",
      background: "var(--qb-bg-void)",
      display: "grid",
      gridTemplateRows: "auto auto auto auto",
      overflow: "visible",
    }}>

      <DashboardHeader
        equity={equity} balance={balance}
        floatingPnL={floatingPnL} dailyPnL={dailyPnL}
        positions={positions}
        rulesError={rulesError}
        regime={regime}
        estopActive={estopActive}
        onOpenEstop={() => setEstopOpen(true)}
        onClearEstop={clearEStop}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <ModeBar
        activeMode={activeMode}
        tradingMode={tradingMode}
        onSetActiveMode={setActiveModeAction}
        onSetTradingMode={setTradingModeAction}
        disabled={!rules || estopActive}
      />

      <div style={{
        padding: 14,
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gridTemplateRows: "minmax(240px, auto) minmax(240px, auto) minmax(240px, auto)",
        // v14: full-width panels (Day-vs-Swing, Immediate-vs-Retest) flow into
        // implicit rows 4+. Without an auto-row size they collapse to zero height
        // (their inner content is height:100% of an undefined row). Give every
        // implicit row a real minimum so added panels actually render.
        gridAutoRows: "minmax(40px, auto)",
        gap: 10, overflow: "auto",
      }}>
        <AccountSafetyPanel
          balance={balance} equity={equity}
          floatingPnL={floatingPnL} dailyPnL={dailyPnL}
          rules={rules}
          callRulesAction={callRulesAction}
        />

        <TemplatesPanel
          rules={rules}
          perf={perf} perfError={perfError}
          callRulesAction={callRulesAction}
        />

        <OpenPositionsPanel positions={positions} />

        <RulesPanel
          rules={rules}
          rulesError={rulesError}
          callRulesAction={callRulesAction}
          watchlist={prefs.watchlist}
          onAddInstrument={() => setAssetModalOpen(true)}
          onRemoveInstrument={(id) => setPrefs((p) => ({ ...p, watchlist: p.watchlist.filter((a) => a !== id) }))}
        />

        <PivotsPanel watchlist={prefs.watchlist} />

        <WatchesPanel
          tradingMode={tradingMode}
          callRulesAction={callRulesAction}
        />

        {/* ─── v13.1 · 3rd ROW: Recognition (cols 1-2) + Heatmap (col 3) ─── */}
        <RecognitionPanel perf={perf} />

        <PerfHeatmapPanel perf={perf} watchlist={prefs.watchlist} />

        {/* ─── v14 · Macro regime risk dial (full width) ─── */}
        <RegimePanel regime={regime} onSetOverride={setRegimeOverride} />

        {/* ─── v15.3 · Regime Detector shadow validation (full width) ─── */}
        <RegimeDetectorShadowPanel />

        {/* ─── v14 · Day-vs-Swing comparison (full width) ─── */}
        <StyleComparisonPanel />

        {/* ─── v14 · Immediate-vs-Retest entry-style comparison (full width) ─── */}
        <EntryStyleComparisonPanel />

        {/* ─── v15.6 · Template × session × instrument performance ranking (full width) ─── */}
        <PerfRankingPanel />

        {/* ─── v14.1 · TP reach by template (full width) ─── */}
        <TpHitPanel />
        <ORBComparePanel />
        <TradeDataPanel />

        {/* ─── v14.4 · Alex G live-signal scanner (full width) ─── */}
        <AlexgHeartbeatPanel />
        <AlexgSignalsPanel />

        {/* ─── v15.3 · Session performance heatmap (full width) ─── */}
        <SessionHeatmapPanel />

        {/* ─── v15.7 · Order Flow Confirmation shadow panel (full width) ─── */}
        <OrderFlowPanel />
      </div>

      <ActivityFeed activity={activity} />

      {assetModalOpen && (
        <AssetPicker
          watchlist={prefs.watchlist}
          resolver={resolver}
          onAdd={(id) => {
            setPrefs((p) => ({ ...p, watchlist: p.watchlist.includes(id) ? p.watchlist : [...p.watchlist, id] }));
            setAssetModalOpen(false);
          }}
          onClose={() => setAssetModalOpen(false)}
        />
      )}
      {estopOpen && (
        <EstopModal onConfirm={triggerEStop} onCancel={() => setEstopOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsModal
          theme={theme} setTheme={setTheme}
          resolver={resolver}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* ─── v15.7 · Analyst Sidebar ─── */}
      <AnalystSidebar />
    </div>
  );
}

// =====================================================================
// 8 · HEADER
// =====================================================================

function DashboardHeader({
  equity, balance, floatingPnL, dailyPnL, positions,
  rulesError, regime, estopActive, onOpenEstop, onClearEstop, onOpenSettings,
}) {
  const openCount = positions?.length || 0;
  const floatColor = floatingPnL >= 0 ? "var(--qb-ok)" : "var(--qb-bad)";
  const dailyColor = dailyPnL >= 0 ? "var(--qb-ok)" : "var(--qb-bad)";

  return (
    <div style={{
      borderBottom: "1px solid var(--qb-border)",
      padding: "12px 18px",
      display: "flex",
      alignItems: "center",
      gap: 20,
      background: "var(--qb-bg-void)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="qb-serif" style={{ fontSize: 22, color: "var(--qb-text-hi)", letterSpacing: -0.5 }}>
          Quantum<span style={{ color: "var(--qb-accent)" }}>·</span>Bot
        </span>
        <span className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-faint)", letterSpacing: 1 }}>
          v13 PILOT
        </span>
      </div>

      {/* v14 — blinking news / regime warning dot */}
      {regime && (regime.newsActive || regime.eventImminent || regime.level === "elevated" || regime.level === "crisis") && (() => {
        const hot = regime.level === "crisis" || regime.newsActive || regime.eventImminent;
        const c = hot ? "var(--qb-bad)" : "var(--qb-warn)";
        let label;
        if (regime.eventImminent && regime.nextEvent) {
          const m = regime.nextEvent.minutesUntil;
          const tag = m > 0 ? ` ${m}m` : m === 0 ? " NOW" : ` ${-m}m`;
          label = `${regime.nextEvent.country} ${regime.nextEvent.title}`.slice(0, 22) + tag;
        } else if (regime.newsActive) {
          label = regime.level === "crisis" ? "NEWS · CRISIS" : regime.level === "elevated" ? "NEWS · ELEVATED" : "NEWS";
        } else {
          label = regime.level.toUpperCase();
        }
        const tip = (regime.reasons || []).join("  •  ")
          || (regime.headlines || []).map((h) => h.title).slice(0, 3).join("  |  ")
          || "Elevated market risk";
        return (
          <div title={tip} style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "3px 11px", borderRadius: 3,
            background: "var(--qb-bg-panel-hi)", border: `1px solid ${c}`,
          }}>
            <span className="qb-pulse" style={{
              width: 9, height: 9, borderRadius: "50%", background: c, boxShadow: `0 0 8px ${c}`,
            }} />
            <span className="qb-mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: c, textTransform: "uppercase" }}>
              {label}
            </span>
          </div>
        );
      })()}

      <div style={{ width: 1, height: 22, background: "var(--qb-border)" }} />

      <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
        <HeaderStat label="Equity"   value={fmtUSD(equity)} mono />
        <HeaderStat label="Balance"  value={fmtUSD(balance)} mono />
        <HeaderStat label="Float"    value={fmtUSD(floatingPnL, true)} mono accent={floatColor} />
        <HeaderStat label="Today"    value={fmtUSD(dailyPnL, true)} mono accent={dailyColor} />
        <HeaderStat label="Open"     value={openCount} mono />
      </div>

      <div style={{ flex: 1 }} />

      {/* v13.1 — UTC clock + session + date */}
      <TimeDisplay />

      {rulesError ? (
        <span className="qb-mono" title={rulesError} style={{
          fontSize: 10, padding: "3px 10px",
          background: "var(--qb-warn-soft)", color: "var(--qb-warn)",
          border: "1px solid var(--qb-warn)", borderRadius: 3,
          letterSpacing: 0.5, textTransform: "uppercase",
        }}>▲ rules offline</span>
      ) : (
        <span className="qb-mono" style={{
          fontSize: 10, padding: "3px 10px",
          background: "var(--qb-ok-soft)", color: "var(--qb-ok)",
          border: "1px solid var(--qb-ok)", borderRadius: 3,
          letterSpacing: 0.5, textTransform: "uppercase",
        }}>● online</span>
      )}

      {estopActive ? (
        <button onClick={onClearEstop} className="qb-mono qb-pulse" style={{
          background: "var(--qb-bad)", color: "white",
          border: "1px solid var(--qb-bad)", borderRadius: 4,
          padding: "6px 16px", fontSize: 11, fontWeight: 700,
          letterSpacing: 1.2, cursor: "pointer", textTransform: "uppercase",
        }}>⛔ E-STOP ACTIVE — clear?</button>
      ) : (
        <button onClick={onOpenEstop} className="qb-mono" style={{
          background: "transparent", color: "var(--qb-bad)",
          border: "1px solid var(--qb-bad)", borderRadius: 4,
          padding: "6px 12px", fontSize: 11, fontWeight: 600,
          letterSpacing: 1.2, cursor: "pointer", textTransform: "uppercase",
        }} title="Emergency stop">⛔ E-STOP</button>
      )}

      <button onClick={onOpenSettings} style={{
        background: "transparent", color: "var(--qb-text-mid)",
        border: "1px solid var(--qb-border)", borderRadius: 4,
        padding: "5px 10px", fontSize: 14, cursor: "pointer",
      }} title="Settings">⚙</button>
    </div>
  );
}

function HeaderStat({ label, value, mono, accent }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>{label}</span>
      <span className={mono ? "qb-mono" : ""} style={{ fontSize: 14, color: accent || "var(--qb-text-hi)", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// ── v13.1 · UTC TIME + SESSION + DATE ──────────────────────────────────
// Sessions (UTC), aligned to qb-v2.2.pine windows:
//   Asian   20:00–05:00   ·   London 07:00–10:00   ·   New York 12:00–17:00
function activeSessionUTC(d) {
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (t >= 20 * 60 || t < 5 * 60)  return { label: "ASIA",     color: "var(--qb-warn)" };
  if (t >= 7 * 60  && t < 10 * 60) return { label: "LONDON",   color: "var(--qb-accent)" };
  if (t >= 12 * 60 && t < 17 * 60) return { label: "NEW YORK", color: "#ec4899" };
  return { label: "OFF", color: "var(--qb-text-lo)" };
}

function TimeDisplay() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const mons = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const dow = days[now.getUTCDay()];
  const dd  = String(now.getUTCDate()).padStart(2, "0");
  const mon = mons[now.getUTCMonth()];
  const hh  = String(now.getUTCHours()).padStart(2, "0");
  const mm  = String(now.getUTCMinutes()).padStart(2, "0");
  const ss  = String(now.getUTCSeconds()).padStart(2, "0");
  const ses = activeSessionUTC(now);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.25 }}>
      <span className="qb-mono" style={{ fontSize: 13, color: "var(--qb-text-hi)", letterSpacing: 0.5 }}>
        {hh}:{mm}<span style={{ color: "var(--qb-text-lo)" }}>:{ss}</span>
        <span style={{ color: "var(--qb-text-faint)", fontSize: 9, marginLeft: 4 }}>UTC</span>
      </span>
      <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-mid)", letterSpacing: 0.5, display: "flex", gap: 6, alignItems: "center" }}>
        <span>{dow} {dd} {mon}</span>
        <span style={{ color: "var(--qb-text-faint)" }}>·</span>
        <span style={{ color: ses.color, display: "flex", alignItems: "center", gap: 3 }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: ses.color, display: "inline-block" }} />
          {ses.label}
        </span>
      </span>
    </div>
  );
}

// =====================================================================
// 9 · MODE BAR (two axes)
// =====================================================================

function ModeBar({ activeMode, tradingMode, onSetActiveMode, onSetTradingMode, disabled }) {
  const currentActive  = ACTIVE_MODES.find((m) => m.id === activeMode);
  const currentTrading = TRADING_MODES.find((m) => m.id === tradingMode);

  return (
    <div style={{
      padding: "10px 18px",
      borderBottom: "1px solid var(--qb-border)",
      background: "var(--qb-bg-panel)",
      display: "flex",
      alignItems: "center",
      gap: 16,
    }}>
      {/* ACTIVE MODE */}
      <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>
        Mode
      </span>
      {ACTIVE_MODES.map((m) => {
        const isActive = m.id === activeMode;
        return (
          <button
            key={m.id}
            onClick={() => !disabled && onSetActiveMode(m.id)}
            disabled={disabled}
            title={m.hint}
            className="qb-mono"
            style={{
              background: isActive ? "var(--qb-accent-soft)" : "transparent",
              color: isActive ? "var(--qb-accent)" : "var(--qb-text-mid)",
              border: `1px solid ${isActive ? "var(--qb-accent)" : "var(--qb-border)"}`,
              borderRadius: 4,
              padding: "6px 12px",
              fontSize: 11, fontWeight: 600,
              letterSpacing: 0.5,
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.4 : 1,
              display: "flex", alignItems: "center", gap: 6,
              textTransform: "uppercase",
            }}
          >
            <span style={{ fontSize: 13 }}>{m.glyph}</span>
            {m.label}
          </button>
        );
      })}

      <div style={{ width: 1, height: 22, background: "var(--qb-border)", marginLeft: 6 }} />

      {/* TRADING MODE */}
      <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>
        Execution
      </span>
      {TRADING_MODES.map((m) => {
        const isActive = m.id === tradingMode;
        return (
          <button
            key={m.id}
            onClick={() => !disabled && onSetTradingMode(m.id)}
            disabled={disabled}
            title={m.hint}
            className="qb-mono"
            style={{
              background: isActive ? (m.id === "auto" ? "var(--qb-ok-soft)" : "var(--qb-warn-soft)") : "transparent",
              color: isActive ? (m.id === "auto" ? "var(--qb-ok)" : "var(--qb-warn)") : "var(--qb-text-mid)",
              border: `1px solid ${isActive ? (m.id === "auto" ? "var(--qb-ok)" : "var(--qb-warn)") : "var(--qb-border)"}`,
              borderRadius: 4,
              padding: "6px 12px",
              fontSize: 11, fontWeight: 600,
              letterSpacing: 0.5,
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.4 : 1,
              display: "flex", alignItems: "center", gap: 6,
              textTransform: "uppercase",
            }}
          >
            <span style={{ fontSize: 13 }}>{m.glyph}</span>
            {m.label}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <span style={{ fontSize: 10, color: "var(--qb-text-lo)", fontStyle: "italic" }}>
        {currentActive?.hint} · {currentTrading?.hint}
      </span>
    </div>
  );
}

// =====================================================================
// 10 · ACCOUNT SAFETY PANEL
// =====================================================================

function AccountSafetyPanel({ balance, equity, floatingPnL, dailyPnL, rules, callRulesAction }) {
  const safety = rules?.account || {};
  const maxDailyLossPct  = safety.maxDailyLossPct  ?? 5.0;
  const maxRiskPerTradePct = safety.maxRiskPerTradePct ?? 2.0;
  const maxConcurrent    = safety.maxConcurrentPositions ?? 5;

  // Daily loss percent (negative dailyPnL / balance × 100)
  const currentLossPct = balance > 0 ? Math.max(0, -dailyPnL / balance * 100) : 0;
  const lossMeterPct = Math.min(1, currentLossPct / maxDailyLossPct);

  const updateSafety = (patch) => callRulesAction("update-account-safety", { patch });

  return (
    <Panel title="Account Safety" subtitle="limits · drawdown">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12, height: "100%" }}>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>
            Today (realized)
          </span>
          <span className="qb-mono" style={{
            fontSize: 22, fontWeight: 300,
            color: dailyPnL >= 0 ? "var(--qb-ok)" : "var(--qb-bad)",
          }}>
            {fmtUSD(dailyPnL, true)}
            <span style={{ fontSize: 11, marginLeft: 8, color: "var(--qb-text-lo)" }}>
              ({balance > 0 ? fmtPct(dailyPnL / balance * 100, 2) : "—"})
            </span>
          </span>
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--qb-text-lo)", marginBottom: 4 }}>
            <span>Daily loss limit</span>
            <span className="qb-mono">{currentLossPct.toFixed(2)}% / {maxDailyLossPct.toFixed(1)}%</span>
          </div>
          <Meter value={lossMeterPct} color="var(--qb-bad)" />
        </div>

        <div className="qb-divider" />

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ThresholdRow
            label="Max daily loss"
            value={maxDailyLossPct}
            suffix="%"
            step="0.5"
            onChange={(v) => updateSafety({ maxDailyLossPct: v })}
          />
          <ThresholdRow
            label="Max risk per trade"
            value={maxRiskPerTradePct}
            suffix="%"
            step="0.1"
            onChange={(v) => updateSafety({ maxRiskPerTradePct: v })}
          />
          <ThresholdRow
            label="Max concurrent positions"
            value={maxConcurrent}
            suffix=""
            step="1"
            onChange={(v) => updateSafety({ maxConcurrentPositions: Math.round(v) })}
          />
        </div>
      </div>
    </Panel>
  );
}

function Meter({ value, color }) {
  return (
    <div style={{
      height: 6, background: "var(--qb-bg-panel-hi)",
      border: "1px solid var(--qb-border)", borderRadius: 3, overflow: "hidden",
    }}>
      <div style={{
        height: "100%",
        width: `${Math.min(100, Math.max(0, value * 100))}%`,
        background: color,
        transition: "width 400ms ease-out",
      }} />
    </div>
  );
}

function ThresholdRow({ label, value, prefix, suffix, step = "1", onChange }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = parseFloat(draft);
    if (isFinite(n) && n >= 0) onChange(n);
  };
  return (
    <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
      <span style={{ color: "var(--qb-text-mid)" }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
        {prefix && <span style={{ color: "var(--qb-text-lo)", fontFamily: "var(--qb-font-mono)" }}>{prefix}</span>}
        <input
          type="number"
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { commit(); e.target.blur(); }}}
          style={{
            width: 70, textAlign: "right",
            background: "var(--qb-bg-panel-hi)",
            border: "1px solid var(--qb-border)",
            borderRadius: 3, padding: "3px 6px",
            color: "var(--qb-text-hi)",
            fontFamily: "var(--qb-font-mono)",
            fontSize: 11,
          }}
        />
        {suffix && <span style={{ color: "var(--qb-text-lo)", fontSize: 10 }}>{suffix}</span>}
      </span>
    </label>
  );
}

// =====================================================================
// 11 · TEMPLATES PANEL
// =====================================================================

function TemplatesPanel({ rules, perf, perfError, callRulesAction }) {
  const overrides = rules?.templateOverrides || {};
  const byTemplate = perf?.byTemplate || {};

  const toggleTemplate = (tplId, enabled) => {
    callRulesAction("update-template", { template: tplId, patch: { enabled } });
  };

  return (
    <Panel title="Templates & Performance" subtitle={perf?.totalTrades != null ? `${perf.totalTrades} closed trades` : "live"}>
      <div style={{ padding: 10, height: "100%", overflow: "auto" }}>
        {perfError && <PlaceholderError msg={`Performance: ${perfError}`} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {TEMPLATE_ORDER.map((t) => (
            <TemplateRow
              key={t}
              templateId={t}
              meta={TEMPLATE_DISPLAY[t]}
              override={overrides[t]}
              stats={byTemplate[t]}
              onToggle={(enabled) => toggleTemplate(t, enabled)}
            />
          ))}
        </div>
      </div>
    </Panel>
  );
}

function TemplateRow({ templateId, meta, override, stats, onToggle }) {
  const enabled = override?.enabled !== false;
  const hasData = stats && stats.sample > 0;

  let verdict = "no-data";
  let verdictColor = "var(--qb-text-lo)";
  let verdictGlyph = "·";
  let verdictLabel = "NEW";

  if (hasData) {
    if (stats.sample < 5) {
      verdict = "too-few"; verdictLabel = "n=" + stats.sample; verdictColor = "var(--qb-text-lo)";
    } else if (stats.profitFactor >= 1.5) {
      verdict = "profitable"; verdictGlyph = "●"; verdictLabel = "PROFIT"; verdictColor = "var(--qb-ok)";
    } else if (stats.profitFactor >= 1.0) {
      verdict = "marginal"; verdictGlyph = "◐"; verdictLabel = "MARGINAL"; verdictColor = "var(--qb-warn)";
    } else {
      verdict = "under"; verdictGlyph = "○"; verdictLabel = "UNDERPERF"; verdictColor = "var(--qb-bad)";
    }
  }

  return (
    <div className="qb-cell" style={{
      padding: "8px 10px",
      display: "grid",
      gridTemplateColumns: "20px 1fr 50px 50px 70px 36px",
      gap: 6, alignItems: "center",
      opacity: enabled ? 1 : 0.5,
    }}>
      <span style={{ fontSize: 13 }}>{meta?.glyph || "·"}</span>
      <span style={{ fontSize: 11, color: "var(--qb-text-hi)" }}>{meta?.label || templateId}</span>
      <span className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-mid)", textAlign: "right" }}>
        {hasData ? `${Math.round(stats.winRate * 100)}%` : "—"}
      </span>
      <span className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-mid)", textAlign: "right" }}>
        {hasData ? stats.profitFactor.toFixed(2) : "—"}
      </span>
      <span className="qb-mono" style={{ fontSize: 9, color: verdictColor, textAlign: "right", letterSpacing: 0.6 }}>
        {verdictGlyph} {verdictLabel}
      </span>
      <ToggleSwitch checked={enabled} onChange={onToggle} small />
    </div>
  );
}

function ToggleSwitch({ checked, onChange, small }) {
  const w = small ? 28 : 36;
  const h = small ? 14 : 18;
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: w, height: h,
        background: checked ? "var(--qb-accent)" : "var(--qb-bg-panel-hi)",
        border: `1px solid ${checked ? "var(--qb-accent)" : "var(--qb-border)"}`,
        borderRadius: h / 2,
        position: "relative",
        cursor: "pointer",
        padding: 0,
        transition: "background 200ms",
      }}
    >
      <span style={{
        position: "absolute",
        top: 1, left: checked ? (w - h + 1) : 1,
        width: h - 4, height: h - 4,
        background: "white",
        borderRadius: "50%",
        transition: "left 200ms",
      }} />
    </button>
  );
}

// =====================================================================
// 12 · OPEN POSITIONS
// =====================================================================

function OpenPositionsPanel({ positions }) {
  return (
    <Panel title="Open Positions" subtitle={`${positions.length} active`}>
      <div style={{ padding: 10, overflow: "auto", height: "100%" }}>
        {positions.length === 0 ? (
          <Placeholder msg="No open positions." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {positions.map((p) => (
              <PositionRow key={p.id || p.ticket || `${p.assetId}-${p.openTime}`} pos={p} />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function PositionRow({ pos }) {
  const profit = pos.profit ?? 0;
  const color = profit >= 0 ? "var(--qb-ok)" : "var(--qb-bad)";
  return (
    <div className="qb-cell" style={{
      padding: "8px 10px",
      display: "grid",
      gridTemplateColumns: "1fr 60px 80px 80px",
      gap: 8, alignItems: "center",
      fontFamily: "var(--qb-font-mono)",
      fontSize: 11,
    }}>
      <div>
        <span style={{ color: "var(--qb-text-hi)", fontWeight: 600 }}>{(pos.assetId || pos.symbol || "?").toUpperCase()}</span>
        {(() => {
          // MetaAPI sends type as the string 'POSITION_TYPE_BUY' / '..._SELL'
          // (not the number 0/1). Handle both forms + a direction fallback.
          const isBuy = pos.type === 0 || pos.type === "POSITION_TYPE_BUY" ||
                        String(pos.type).toUpperCase().includes("BUY") || pos.direction === "LONG";
          return (
            <span style={{ color: isBuy ? "var(--qb-ok)" : "var(--qb-bad)", marginLeft: 6, fontSize: 10 }}>
              {isBuy ? "BUY" : "SELL"}
            </span>
          );
        })()}
      </div>
      <span style={{ color: "var(--qb-text-mid)", textAlign: "right" }}>{(pos.volume || 0).toFixed(2)}</span>
      <span style={{ color: "var(--qb-text-mid)", textAlign: "right" }}>@ {fmtPrice(pos.openPrice, pos.assetId)}</span>
      <span style={{ color, textAlign: "right", fontWeight: 600 }}>{fmtUSD(profit, true)}</span>
    </div>
  );
}

// =====================================================================
// 13 · PER-INSTRUMENT RULES
// =====================================================================

function RulesPanel({ rules, rulesError, callRulesAction, watchlist, onAddInstrument, onRemoveInstrument }) {
  const instruments = rules?.instruments || {};

  const updateInst = (assetId, patch) => callRulesAction("update-instrument", { assetId, patch });

  return (
    <Panel title="Per-Instrument Rules" subtitle={`${watchlist.length} watched`}>
      <div style={{ padding: 10, overflow: "auto", height: "100%" }}>
        {rulesError && <PlaceholderError msg={`Rules: ${rulesError}`} />}

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {watchlist.map((id) => (
            <InstrumentRuleRow
              key={id}
              assetId={id}
              rule={instruments[id]}
              onChange={(patch) => updateInst(id, patch)}
              onRemove={() => onRemoveInstrument(id)}
              canRemove={watchlist.length > 1}
            />
          ))}
        </div>

        <button
          onClick={onAddInstrument}
          style={{
            marginTop: 10, width: "100%",
            background: "transparent",
            border: "1px dashed var(--qb-border-hi)",
            borderRadius: 4,
            padding: "8px 10px",
            color: "var(--qb-text-mid)",
            fontSize: 11, cursor: "pointer",
            fontFamily: "var(--qb-font-mono)",
            letterSpacing: 0.5, textTransform: "uppercase",
          }}
        >
          + add instrument
        </button>
      </div>
    </Panel>
  );
}

function InstrumentRuleRow({ assetId, rule, onChange, onRemove, canRemove }) {
  const [expanded, setExpanded] = useState(false);
  // Hooks must run unconditionally on every render — keep this ABOVE the
  // `!rule` early return below. rule?.style is null-safe for the stub case.
  const liveStyle  = rule?.style === "swing" ? "swing" : "day";
  const [editStyle, setEditStyle] = useState(liveStyle);

  if (!rule) {
    // Asset in watchlist but no rules record yet — show a "needs configuration" stub
    return (
      <div className="qb-cell" style={{
        padding: "8px 10px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontFamily: "var(--qb-font-mono)", fontSize: 12, fontWeight: 600 }}>{assetId.toUpperCase()}</span>
        <span style={{ fontSize: 10, color: "var(--qb-text-faint)", fontStyle: "italic" }}>not configured in rules-store</span>
        {canRemove && (
          <button onClick={onRemove} style={{
            background: "transparent", border: "none", color: "var(--qb-text-faint)",
            fontSize: 14, cursor: "pointer", padding: "0 4px",
          }}>×</button>
        )}
      </div>
    );
  }

  const enabled    = rule.enabled !== false;

  // Read a field from a style's profile, falling back to the legacy flat field
  // (migration-safe), then a default.
  const readField = (style, field, dflt) => {
    const prof = rule[style + "Profile"];
    if (prof && prof[field] != null) return prof[field];
    if (rule[field] != null) return rule[field];
    return dflt;
  };
  // Patch a field inside the profile currently being EDITED. Deep-merged server-side.
  const setField = (field, v) => onChange({ [editStyle + "Profile"]: { [field]: v } });

  // Collapsed-row summary reflects the LIVE profile (what actually trades).
  const lvLotMode = readField(liveStyle, "lotMode", "risk-based");
  const lvSlMode  = readField(liveStyle, "slMode", "pine");
  const lvTpMode  = readField(liveStyle, "tpMode", "pine-three");
  const slLabel  = lvSlMode === "pine" ? "Pine SL" : lvSlMode === "fixed-pips" ? `${readField(liveStyle,"fixedSLPips","?")}p` : `$${readField(liveStyle,"fixedSLDollars","?")}`;
  const lotLabel = lvLotMode === "fixed" ? `${Number(readField(liveStyle,"fixedLot",0)).toFixed(2)} fixed` : `risk ≤${Number(readField(liveStyle,"maxLot",0)).toFixed(2)}`;

  // Fields for the profile being EDITED.
  const lotMode = readField(editStyle, "lotMode", "risk-based");
  const slMode  = readField(editStyle, "slMode", "pine");
  const tpMode  = readField(editStyle, "tpMode", "pine-three");

  return (
    <div className="qb-cell" style={{ opacity: enabled ? 1 : 0.5 }}>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          padding: "8px 10px",
          display: "grid",
          gridTemplateColumns: "20px 60px 1fr 62px 44px 30px 16px",
          gap: 6, alignItems: "center",
          cursor: "pointer",
        }}
      >
        <ToggleSwitch checked={enabled} onChange={(v) => onChange({ enabled: v })} small />
        <span style={{ fontFamily: "var(--qb-font-mono)", fontSize: 12, color: "var(--qb-text-hi)", fontWeight: 600 }}>
          {assetId.toUpperCase()}
        </span>
        <span className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-mid)" }}>{lotLabel}</span>
        <span className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-mid)", textAlign: "right" }}>SL: {slLabel}</span>
        <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-lo)", textAlign: "right" }}>{lvTpMode === "rr" ? `RR ${readField(liveStyle, "numTPs", 3)}×` : lvTpMode === "pine-three" ? "pine" : lvTpMode}</span>
        <span className="qb-mono" style={{
          fontSize: 8, fontWeight: 700, textAlign: "center", padding: "1px 0", borderRadius: 3,
          color: liveStyle === "swing" ? "#08080a" : "var(--qb-accent)",
          background: liveStyle === "swing" ? "var(--qb-accent)" : "transparent",
          border: "1px solid var(--qb-accent)",
        }}>{liveStyle === "swing" ? "SW" : "DAY"}</span>
        <span style={{ fontSize: 10, color: "var(--qb-text-faint)", textAlign: "right" }}>
          {expanded ? "▾" : "▸"}
        </span>
      </div>

      {expanded && (
        <div style={{
          padding: "10px 12px",
          borderTop: "1px solid var(--qb-border)",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          {/* LIVE PROFILE — which profile actually trades this instrument */}
          <ConfigGroup label="Live profile (what trades)">
            <SegmentControl
              options={[{id: "day", label: "Day"}, {id: "swing", label: "Swing"}]}
              value={liveStyle}
              onChange={(v) => { onChange({ style: v }); setEditStyle(v); }}
            />
          </ConfigGroup>

          {/* EDIT TABS — configure either profile without changing the live one */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--qb-border)" }}>
            {["day", "swing"].map((s) => (
              <button key={s} onClick={() => setEditStyle(s)} style={{
                flex: 1, background: "transparent", border: "none", cursor: "pointer",
                padding: "6px 4px", fontFamily: "var(--qb-font-mono)", fontSize: 10,
                letterSpacing: 0.5, textTransform: "uppercase",
                color: editStyle === s ? "var(--qb-accent)" : "var(--qb-text-faint)",
                borderBottom: editStyle === s ? "2px solid var(--qb-accent)" : "2px solid transparent",
                fontWeight: editStyle === s ? 700 : 400,
              }}>
                {s === "day" ? "Day" : "Swing"} profile{s === liveStyle ? " ●" : ""}
              </button>
            ))}
          </div>

          {/* LOT MODE */}
          <ConfigGroup label="Lot mode">
            <SegmentControl
              options={[{id: "risk-based", label: "Risk-based"}, {id: "fixed", label: "Fixed lot"}]}
              value={lotMode}
              onChange={(v) => setField("lotMode", v)}
            />
          </ConfigGroup>

          {lotMode === "fixed" && (
            <SmallNumberField
              label="Fixed lot"
              value={readField(editStyle, "fixedLot", 0.01)}
              step="0.01"
              onChange={(v) => setField("fixedLot", v)}
            />
          )}
          <SmallNumberField
            label="Max lot"
            value={readField(editStyle, "maxLot", 1)}
            step="0.01"
            onChange={(v) => setField("maxLot", v)}
          />

          {/* SL MODE */}
          <ConfigGroup label="SL mode">
            <SegmentControl
              options={[
                {id: "pine", label: "Pine"},
                {id: "fixed-pips", label: "Pips"},
                {id: "fixed-dollars", label: "Dollars"},
              ]}
              value={slMode}
              onChange={(v) => setField("slMode", v)}
            />
          </ConfigGroup>
          {slMode === "fixed-pips" && (
            <SmallNumberField
              label="SL (pips)"
              value={readField(editStyle, "fixedSLPips", 15)}
              step="1"
              onChange={(v) => setField("fixedSLPips", v)}
            />
          )}
          {slMode === "fixed-dollars" && (
            <SmallNumberField
              label="SL ($/lot)"
              value={readField(editStyle, "fixedSLDollars", 25)}
              step="1"
              onChange={(v) => setField("fixedSLDollars", v)}
            />
          )}

          {/* TP MODE */}
          <ConfigGroup label="TP mode">
            <SegmentControl
              options={[
                {id: "rr", label: "By RR"},
                {id: "pine-three", label: "Pine TPs"},
                {id: "trail-only", label: "Trail only"},
              ]}
              value={tpMode}
              onChange={(v) => setField("tpMode", v)}
            />
          </ConfigGroup>

          {tpMode === "rr" && (
            <>
              <ConfigGroup label="Number of TPs">
                <SegmentControl
                  options={[{id: "1", label: "1"}, {id: "2", label: "2"}, {id: "3", label: "3"}]}
                  value={String(readField(editStyle, "numTPs", 3))}
                  onChange={(v) => setField("numTPs", Number(v))}
                />
              </ConfigGroup>
              <SmallNumberField
                label="TP1 (×R)"
                value={readField(editStyle, "tp1RR", 1.5)}
                step="0.1"
                onChange={(v) => setField("tp1RR", v)}
              />
              {Number(readField(editStyle, "numTPs", 3)) >= 2 && (
                <SmallNumberField
                  label="TP2 (×R)"
                  value={readField(editStyle, "tp2RR", 3)}
                  step="0.1"
                  onChange={(v) => setField("tp2RR", v)}
                />
              )}
              {Number(readField(editStyle, "numTPs", 3)) >= 3 && (
                <SmallNumberField
                  label="TP3 (×R)"
                  value={readField(editStyle, "tp3RR", 5)}
                  step="0.1"
                  onChange={(v) => setField("tp3RR", v)}
                />
              )}
              <div style={{
                fontSize: 11,
                color: "var(--qb-text-faint)",
                lineHeight: 1.5,
                marginTop: 2,
                padding: "6px 8px",
                background: "rgba(255,255,255,0.03)",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.07)",
              }}>
                Full position rides to the last TP. SL ratchets up to each TP as price touches it — no partial closes.
              </div>
            </>
          )}

          {/* MIN RR */}
          <SmallNumberField
            label="Min RR"
            value={readField(editStyle, "minRR", 1.0)}
            step="0.1"
            onChange={(v) => setField("minRR", v)}
          />

          {canRemove && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              style={{
                marginTop: 4,
                background: "transparent",
                color: "var(--qb-bad)",
                border: "1px solid var(--qb-bad)",
                borderRadius: 3,
                padding: "5px 8px",
                fontSize: 10, cursor: "pointer",
                letterSpacing: 0.5, textTransform: "uppercase",
                fontFamily: "var(--qb-font-mono)",
              }}
            >
              Remove from watchlist
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigGroup({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 9, color: "var(--qb-text-lo)", textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function SegmentControl({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          className="qb-mono"
          style={{
            flex: 1,
            background: value === opt.id ? "var(--qb-accent-soft)" : "transparent",
            color: value === opt.id ? "var(--qb-accent)" : "var(--qb-text-mid)",
            border: `1px solid ${value === opt.id ? "var(--qb-accent)" : "var(--qb-border)"}`,
            borderRadius: 3,
            padding: "4px 6px",
            fontSize: 9, cursor: "pointer",
            letterSpacing: 0.5, textTransform: "uppercase",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SmallNumberField({ label, value, step = "1", onChange }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = parseFloat(draft);
    if (isFinite(n) && n >= 0) onChange(n);
  };
  return (
    <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
      <span style={{ color: "var(--qb-text-mid)" }}>{label}</span>
      <input
        type="number"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { commit(); e.target.blur(); }}}
        style={{
          width: 80, textAlign: "right",
          background: "var(--qb-bg-panel-hi)",
          border: "1px solid var(--qb-border)",
          borderRadius: 3, padding: "3px 6px",
          color: "var(--qb-text-hi)",
          fontFamily: "var(--qb-font-mono)",
          fontSize: 11,
        }}
      />
    </label>
  );
}

// =====================================================================
// 14 · PIVOTS PANEL
// =====================================================================

function PivotsPanel({ watchlist }) {
  const [pivots, setPivots] = useState(null);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("pivots")).then((res) => res.json());
        if (alive) {
          if (r && !r.error) { setPivots(r); setError(null); }
          else setError(r?.error || "endpoint not deployed");
        }
      } catch (e) { if (alive) setError(e.message); }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <Panel title="Pivots" subtitle="H1 ATR levels">
      <div style={{ padding: 10, overflow: "auto", height: "100%" }}>
        {error && <PlaceholderError msg={`Pivots: ${error}`} />}
        {!error && !pivots && <Placeholder msg="Loading..." />}
        {pivots?.byAsset && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {watchlist.map((id) => {
              const p = pivots.byAsset[id];
              if (!p) return null;
              return (
                <div key={id} className="qb-cell" style={{
                  padding: "6px 10px",
                  display: "grid",
                  gridTemplateColumns: "60px 1fr 1fr 1fr",
                  gap: 6, alignItems: "center",
                  fontSize: 10, fontFamily: "var(--qb-font-mono)",
                }}>
                  <span style={{ color: "var(--qb-text-hi)" }}>{id.toUpperCase()}</span>
                  <span style={{ color: "var(--qb-ok)" }}>R: {fmtPrice(p.r1, id)}</span>
                  <span style={{ color: "var(--qb-text-mid)" }}>P: {fmtPrice(p.pivot, id)}</span>
                  <span style={{ color: "var(--qb-bad)" }}>S: {fmtPrice(p.s1, id)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

// =====================================================================
// 15 · ACTIVE WATCHES (manual mode)
// =====================================================================

function WatchesPanel({ tradingMode, callRulesAction }) {
  const [data, setData]   = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("watched-setups")).then((res) => res.json());
        if (alive) {
          if (r && !r.error) { setData(r); setError(null); }
          else setError(r?.error || "endpoint not deployed");
        }
      } catch (e) { if (alive) setError(e.message); }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const cancelWatch = async (id) => {
    try {
      await fetch(API(`watched-setups?action=cancel&id=${encodeURIComponent(id)}`));
    } catch (_) {}
  };

  const isManual = tradingMode === "manual";

  return (
    <Panel
      title="Active Watches"
      subtitle={isManual ? `${data?.watching || 0} watching · ${data?.alerted || 0} alerted` : "manual mode only"}
    >
      <div style={{ padding: 10, overflow: "auto", height: "100%" }}>
        {!isManual && <Placeholder msg="Switch execution to MANUAL to receive zone-approach alerts." />}
        {isManual && error && <PlaceholderError msg={`Watches: ${error}`} />}
        {isManual && !error && (!data?.list || data.list.length === 0) && (
          <Placeholder msg="No active watches. Waiting for setups." />
        )}
        {isManual && data?.list?.map((w) => (
          <WatchRow key={w.id} watch={w} onCancel={() => cancelWatch(w.id)} />
        ))}
      </div>
    </Panel>
  );
}

function WatchRow({ watch, onCancel }) {
  const meta = TEMPLATE_DISPLAY[watch.template] || { glyph: "·", label: watch.template };
  const isAlerted = watch.status === "alerted";

  return (
    <div className="qb-cell" style={{
      padding: "8px 10px", marginBottom: 4,
      display: "flex", flexDirection: "column", gap: 4,
      borderColor: isAlerted ? "var(--qb-accent)" : "var(--qb-border)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 13 }}>{meta.glyph}</span>
        <span style={{ fontSize: 11, color: "var(--qb-text-hi)", flex: 1 }}>{meta.label}</span>
        <span className="qb-mono" style={{ fontSize: 10, color: watch.direction === "LONG" ? "var(--qb-ok)" : "var(--qb-bad)" }}>
          {watch.direction}
        </span>
        <span style={{ fontSize: 10, color: "var(--qb-text-lo)" }}>{(watch.asset || "").toUpperCase()}</span>
        {isAlerted && (
          <span className="qb-mono qb-pulse" style={{
            fontSize: 9, color: "var(--qb-accent)",
            background: "var(--qb-accent-soft)",
            padding: "1px 6px", borderRadius: 2,
            letterSpacing: 0.5,
          }}>⚡ ALERTED</span>
        )}
      </div>
      <div className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-mid)", display: "flex", gap: 10 }}>
        <span>Zone: {fmtPrice(watch.zoneLower, watch.asset)}–{fmtPrice(watch.zoneUpper, watch.asset)}</span>
        <span>SL: {fmtPrice(watch.sl, watch.asset)}</span>
        <span>Lot: {(watch.finalLot || 0).toFixed(2)}</span>
        <span style={{ color: "var(--qb-text-lo)" }}>{fmtAge(watch.createdAt)} ago</span>
      </div>
      <button
        onClick={onCancel}
        style={{
          background: "transparent", color: "var(--qb-text-lo)",
          border: "1px solid var(--qb-border)", borderRadius: 3,
          padding: "2px 6px", fontSize: 9, cursor: "pointer",
          alignSelf: "flex-start", letterSpacing: 0.5,
          fontFamily: "var(--qb-font-mono)", textTransform: "uppercase",
        }}
      >
        Cancel watch
      </button>
    </div>
  );
}

// =====================================================================
// 15a · DAY vs SWING COMPARISON PANEL  [v14]
// =====================================================================
// Reads /api/recognition-memory?action=recent — each closed trade now carries
// `style` (day|swing) and `template`. Groups them so you can see which risk
// profile is actually working. Two views: Overall (Day vs Swing) and a
// per-template breakdown. This is the measurement tool behind the dual-profile
// config — and the reason the ICT templates stay separately tracked.

function aggTrades(trades) {
  let wins = 0, losses = 0, be = 0, net = 0, grossWin = 0, grossLoss = 0, rSum = 0, rN = 0;
  for (const t of trades) {
    const pnl = Number(t.pnl) || 0;
    net += pnl;
    if (t.outcome === "WIN" || pnl > 0.5) { wins++; grossWin += pnl; }
    else if (t.outcome === "LOSS" || pnl < -0.5) { losses++; grossLoss += Math.abs(pnl); }
    else be++;
    if (t.pnlR != null && isFinite(t.pnlR)) { rSum += t.pnlR; rN++; }
  }
  const decided = wins + losses;
  return {
    count: trades.length, wins, losses, be,
    winRate: decided > 0 ? wins / decided : null,
    net,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    avgR: rN > 0 ? rSum / rN : null,
  };
}

function wrColorOf(wr) {
  if (wr == null) return "var(--qb-text-lo)";
  return wr >= 0.55 ? "var(--qb-ok)" : wr >= 0.45 ? "var(--qb-warn)" : "var(--qb-bad)";
}
function netColorOf(net) {
  if (!net) return "var(--qb-text-lo)";
  return net > 0 ? "var(--qb-ok)" : net < 0 ? "var(--qb-bad)" : "var(--qb-text-lo)";
}
function fmtWR(wr) { return wr == null ? "·" : `${Math.round(wr * 100)}%`; }
function fmtNet(net, count) { return count ? `${net >= 0 ? "+" : ""}${net.toFixed(0)}` : "·"; }

function Stat({ label, value, color, big }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: 8, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
      <span className="qb-mono" style={{ fontSize: big ? 24 : 13, fontWeight: big ? 300 : 500, color, lineHeight: 1.2 }}>{value}</span>
    </div>
  );
}

function StyleStatCard({ title, agg }) {
  return (
    <div className="qb-cell" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontFamily: "var(--qb-font-mono)", fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "var(--qb-accent)" }}>{title}</span>
        <span style={{ fontSize: 10, color: "var(--qb-text-faint)" }}>{agg.count} trade{agg.count === 1 ? "" : "s"}</span>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Stat label="Win rate" value={fmtWR(agg.winRate)} color={wrColorOf(agg.winRate)} big />
        <Stat label="Net $" value={agg.count ? `${agg.net >= 0 ? "+" : ""}${agg.net.toFixed(0)}` : "·"} color={netColorOf(agg.net)} big />
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Stat label="Profit factor" value={agg.profitFactor == null ? "·" : agg.profitFactor === Infinity ? "∞" : agg.profitFactor.toFixed(2)} color="var(--qb-text-mid)" />
        <Stat label="Avg R" value={agg.avgR == null ? "·" : `${agg.avgR >= 0 ? "+" : ""}${agg.avgR.toFixed(2)}R`} color={netColorOf(agg.avgR)} />
        <Stat label="W / L" value={`${agg.wins} / ${agg.losses}`} color="var(--qb-text-mid)" />
      </div>
    </div>
  );
}

// ─── v14 · Macro Regime panel (status + manual override) ────────────────
function RegimePanel({ regime, onSetOverride, gridColumn = "1 / 4", compact = false }) {
  const r = regime || { level: "normal", sizeMult: 1, slWiden: 1, reasons: [], headlines: [], manualOverride: "auto", newsActive: false, volRatio: null, upcomingEvents: [], nextEvent: null, eventImminent: false };
  const level = r.level || "normal";
  const COLORS = { normal: "var(--qb-ok)", elevated: "var(--qb-warn)", crisis: "var(--qb-bad)" };
  const col = COLORS[level] || "var(--qb-text-mid)";
  const pct = (m) => `${Math.round((m != null ? m : 1) * 100)}%`;
  const modes = ["auto", "normal", "elevated", "crisis"];
  const cur = r.manualOverride || "auto";
  const evWhen = (m) => (m > 0 ? `in ${m}m` : m === 0 ? "now" : `${-m}m ago`);

  return (
    <Panel title="Macro Regime" subtitle="risk dial — news + volatility + calendar" style={{ gridColumn }}>
      <div style={{ padding: 12, height: "100%", overflow: "auto", display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 1fr", gap: 16 }}>
        {/* left — current state */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span className={level !== "normal" ? "qb-pulse" : ""} style={{ width: 13, height: 13, borderRadius: "50%", background: col, boxShadow: `0 0 8px ${col}` }} />
            <span className="qb-serif" style={{ fontSize: 22, color: col, letterSpacing: 0.5 }}>{level.toUpperCase()}</span>
            {cur !== "auto" && (
              <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-faint)", border: "1px solid var(--qb-border)", borderRadius: 3, padding: "1px 6px", letterSpacing: 0.5 }}>MANUAL</span>
            )}
          </div>
          <div className="qb-mono" style={{ fontSize: 11, color: "var(--qb-text-mid)", lineHeight: 2 }}>
            <div>Position size&nbsp;→&nbsp;<span style={{ color: r.sizeMult < 1 ? "var(--qb-warn)" : "var(--qb-text-hi)" }}>{pct(r.sizeMult)}</span> <span style={{ color: "var(--qb-text-faint)" }}>of your input</span></div>
            <div>Stop width&nbsp;→&nbsp;<span style={{ color: r.slWiden > 1 ? "var(--qb-warn)" : "var(--qb-text-hi)" }}>{pct(r.slWiden)}</span> <span style={{ color: "var(--qb-text-faint)" }}>of your input</span></div>
            {r.volRatio != null && <div>Volatility&nbsp;→&nbsp;<span style={{ color: "var(--qb-text-hi)" }}>{r.volRatio}×</span> <span style={{ color: "var(--qb-text-faint)" }}>baseline</span></div>}
          </div>
          {(r.reasons || []).length > 0 && (
            <div style={{ marginTop: 10, fontSize: 10, color: "var(--qb-text-faint)", lineHeight: 1.6 }}>
              {r.reasons.map((x, i) => <div key={i}>• {x}</div>)}
            </div>
          )}
        </div>

        {/* right — manual override + live news + scheduled events */}
        <div>
          <div className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 7 }}>Manual override</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {modes.map((m) => (
              <button key={m} onClick={() => onSetOverride && onSetOverride(m)} className="qb-mono" style={{
                fontSize: 10, padding: "5px 11px", borderRadius: 3, cursor: "pointer",
                textTransform: "uppercase", letterSpacing: 0.5,
                background: cur === m ? (COLORS[m] || "var(--qb-accent)") : "transparent",
                color: cur === m ? "var(--qb-bg-void)" : "var(--qb-text-mid)",
                border: `1px solid ${cur === m ? (COLORS[m] || "var(--qb-accent)") : "var(--qb-border)"}`,
                fontWeight: cur === m ? 700 : 400,
              }}>{m}</button>
            ))}
          </div>

          {r.newsActive && (r.headlines || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="qb-mono qb-pulse" style={{ fontSize: 9, color: "var(--qb-bad)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>● Live high-impact news</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {r.headlines.slice(0, 3).map((h, i) => (
                  <div key={i} style={{ fontSize: 10, color: "var(--qb-text-mid)", lineHeight: 1.35 }}>
                    <span style={{ color: "var(--qb-text-faint)" }}>{h.source ? h.source + " — " : ""}</span>{h.title}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>Scheduled events · Forex Factory</div>
          {(r.upcomingEvents || []).length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {r.upcomingEvents.slice(0, 5).map((e, i) => {
                const imm = e.minutesUntil <= 30 && e.minutesUntil >= -15;
                return (
                  <div key={i} style={{ fontSize: 10, color: imm ? "var(--qb-bad)" : "var(--qb-text-mid)", lineHeight: 1.35, display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span><span style={{ color: "var(--qb-text-faint)" }}>{e.country} </span>{e.title}</span>
                    <span className="qb-mono" style={{ color: imm ? "var(--qb-bad)" : "var(--qb-text-faint)", whiteSpace: "nowrap" }}>{evWhen(e.minutesUntil)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 10, color: "var(--qb-text-faint)", fontStyle: "italic" }}>No high-impact events queued this week (or calendar still loading).</div>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ─── v14 · Immediate vs Retest entry-style comparison (full width) ──────
// Mirrors the Day-vs-Swing panel. Aggregates closed trades tagged with an
// entryType: "immediate" (market fill) vs "retest" (resting limit). Only
// trades placed after the v14 entry-routing update carry the label, so the
// table fills with fresh, clean data going forward. Each cell shows win-rate,
// trade count, and net P&L via the shared aggTrades() helper.
// ─── v14.1 · Per-template TP reach (how deep each template runs) ─────────
function tpAgg(trades) {
  const n = trades.length;
  if (!n) return { n: 0, tp1: 0, tp2: 0, tp3: 0, avg: 0 };
  let tp1 = 0, tp2 = 0, tp3 = 0, sum = 0;
  for (const t of trades) {
    const m = t.maxTP || 0;
    if (m >= 1) tp1++;
    if (m >= 2) tp2++;
    if (m >= 3) tp3++;
    sum += m;
  }
  return { n, tp1, tp2, tp3, avg: sum / n };
}
function pctOf(c, n) { return n ? Math.round((c / n) * 100) : 0; }

function TpHitPanel({ gridColumn = "1 / 4" }) {
  const [trades, setTrades] = useState(null);
  const [error, setError]   = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("recognition-memory?action=recent&limit=500")).then((res) => res.json());
        if (alive) {
          if (r && Array.isArray(r.trades)) { setTrades(r.trades); setError(null); }
          else setError(r?.error || "no trade data");
        }
      } catch (e) { if (alive) setError(e.message); }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const labeled  = (trades || []).filter((t) => t.maxTP != null);
  const overall  = tpAgg(labeled);
  const untagged = (trades || []).length - labeled.length;

  const byTemplate = {};
  for (const t of labeled) {
    const tmpl = t.template || (t.contributingTactics || [])[0] || "—";
    (byTemplate[tmpl] = byTemplate[tmpl] || []).push(t);
  }
  const rows = Object.keys(byTemplate)
    .map((tmpl) => ({ tmpl, agg: tpAgg(byTemplate[tmpl]) }))
    .sort((a, b) => b.agg.avg - a.agg.avg);

  const cell    = (c, n) => (n ? `${c} (${pctOf(c, n)}%)` : "·");
  const tpColor = (pct) => (pct >= 50 ? "var(--qb-ok)" : pct >= 25 ? "var(--qb-warn)" : "var(--qb-text-mid)");

  return (
    <Panel title="TP Reach by Template" subtitle="how deep each template runs" style={{ gridColumn }}>
      <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
        {error && <PlaceholderError msg={`TP reach: ${error}`} />}
        {!error && labeled.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
            No TP-reach data yet. Each trade's reached rungs are recorded as it closes — stats appear here for trades closing after the v14.1 ratchet update.
          </div>
        )}
        {labeled.length > 0 && (
          <>
            <div style={{ display: "flex", gap: 18, marginBottom: 12, flexWrap: "wrap", fontFamily: "var(--qb-font-mono)", fontSize: 11 }}>
              <span style={{ color: "var(--qb-text-faint)" }}>{overall.n} trades</span>
              <span>TP1 <b style={{ color: tpColor(pctOf(overall.tp1, overall.n)) }}>{pctOf(overall.tp1, overall.n)}%</b></span>
              <span>TP2 <b style={{ color: tpColor(pctOf(overall.tp2, overall.n)) }}>{pctOf(overall.tp2, overall.n)}%</b></span>
              <span>TP3 <b style={{ color: tpColor(pctOf(overall.tp3, overall.n)) }}>{pctOf(overall.tp3, overall.n)}%</b></span>
              <span style={{ color: "var(--qb-text-faint)" }}>avg {overall.avg.toFixed(2)} rungs/trade</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--qb-font-mono)", fontSize: 10 }}>
              <thead>
                <tr style={{ color: "var(--qb-text-faint)", textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "4px 6px" }}>Template</th>
                  <th style={{ padding: "4px 6px" }}>n</th>
                  <th style={{ padding: "4px 6px" }}>TP1</th>
                  <th style={{ padding: "4px 6px" }}>TP2</th>
                  <th style={{ padding: "4px 6px" }}>TP3</th>
                  <th style={{ padding: "4px 6px" }}>avg</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ tmpl, agg }) => {
                  const meta = TEMPLATE_DISPLAY[tmpl];
                  return (
                    <tr key={tmpl} style={{ borderTop: "1px solid var(--qb-border)", textAlign: "right" }}>
                      <td style={{ textAlign: "left", padding: "4px 6px", color: "var(--qb-text-hi)" }}>{meta ? `${meta.glyph} ${meta.label}` : tmpl}</td>
                      <td style={{ padding: "4px 6px", color: "var(--qb-text-mid)" }}>{agg.n}</td>
                      <td style={{ padding: "4px 6px", color: tpColor(pctOf(agg.tp1, agg.n)) }}>{cell(agg.tp1, agg.n)}</td>
                      <td style={{ padding: "4px 6px", color: tpColor(pctOf(agg.tp2, agg.n)) }}>{cell(agg.tp2, agg.n)}</td>
                      <td style={{ padding: "4px 6px", color: tpColor(pctOf(agg.tp3, agg.n)) }}>{cell(agg.tp3, agg.n)}</td>
                      <td style={{ padding: "4px 6px", color: "var(--qb-text-hi)" }}>{agg.avg.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {untagged > 0 && (
              <div style={{ marginTop: 10, fontSize: 9, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
                {untagged} older trade{untagged === 1 ? "" : "s"} predate TP-reach tracking and aren't counted here.
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

// ─── v14.4 · Alex G live-signal scanner ─────────────────────────────────
// Read-only funnel across all instruments straight from /api/alexg-trade
// (no key — the endpoint only analyses, never places). Lets you eyeball the
// bot's top-down reads against Alex's chart reads during validation: which
// pair is filtered as chop, which is at an AOI awaiting a shift, which has a
// gradeable setup, and which is actually tradeable. Refreshes gently (the
// scan does a full multi-TF analysis per instrument).
const ALEXG_ORDER = ["eurusd", "gbpusd", "usdjpy", "usdchf", "audusd", "nzdusd", "usdcad", "eurjpy", "gbpjpy", "gold", "nas100", "us500", "btc"];
// Funnel stage metadata — rank drives "focus" ordering (deepest first).
const ALEXG_STAGE_META = {
  ready: { rank: 6, label: "● READY", color: "var(--qb-ok)" },
  gates: { rank: 5, label: "◕ entry · gating", color: "var(--qb-warn)" },
  entry: { rank: 4, label: "◑ at AOI · confirming", color: "var(--qb-accent)" },
  aoi:   { rank: 3, label: "◔ bias · seeking AOI", color: "var(--qb-text-mid)" },
  bias:  { rank: 2, label: "○ forming bias", color: "var(--qb-text-faint)" },
  error: { rank: 1, label: "⚠ error", color: "var(--qb-bad)" },
  data:  { rank: 0, label: "· no data", color: "var(--qb-text-faint)" },
};
function alexgStage(p) {
  if (!p) return { label: "—", color: "var(--qb-text-faint)", rank: -1 };
  if (p.tradeable) return ALEXG_STAGE_META.ready;
  const st = p.funnel && p.funnel.stage;
  if (st && ALEXG_STAGE_META[st]) return ALEXG_STAGE_META[st];
  // fallback when funnel is absent (older cached response)
  const r = (p.reason || "").toLowerCase();
  if (p.entry != null) return { label: `setup · graded ${p.grade ? p.grade.letter : "?"}`, color: "var(--qb-warn)", rank: 5 };
  if (p.zone) return { label: "at AOI · awaiting shift", color: "var(--qb-accent)", rank: 4 };
  if (p.direction) return { label: `bias ${p.direction === "long" ? "↑" : "↓"} · no AOI`, color: "var(--qb-text-mid)", rank: 3 };
  if (r.includes("ineligib") || r.includes("consolidat") || r.includes("chop")) return { label: "filtered · chop", color: "var(--qb-text-faint)", rank: 1 };
  return { label: "no setup", color: "var(--qb-text-faint)", rank: 0 };
}
const alexgTrend = (t) => (t === "up" ? "↑" : t === "down" ? "↓" : "·");
const alexgTrendColor = (t) => (t === "up" ? "var(--qb-ok)" : t === "down" ? "var(--qb-bad)" : "var(--qb-text-faint)");
// ─── v14.5 · Alex G cron heartbeat — makes a silent cron failure visible ──
// Reads /api/alexg-heartbeat (the alexg-run cron stamps every execution). Green
// = ran recently; amber = overdue (possible silent death); red = last run threw.
function AlexgHeartbeatPanel({ gridColumn = "1 / 4" }) {
  const [h, setH]       = useState(null);
  const [error, setErr] = useState(null);
  useEffect(() => {
    const alive = { v: true };
    const tick = async () => {
      try {
        const r = await fetch(API("alexg-heartbeat")).then((res) => res.json());
        if (!alive.v) return;
        if (r && r.health) { setH(r.health); setErr(null); } else setErr(r?.error || "no heartbeat");
      } catch (e) { if (alive.v) setErr(e.message); }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { alive.v = false; clearInterval(id); };
  }, []);

  const status = error ? "error" : (h ? h.status : "loading");
  const MAP = {
    ok:      { dot: "var(--qb-ok)",         label: "running" },
    stale:   { dot: "var(--qb-warn)",       label: "stale · no recent run" },
    failed:  { dot: "var(--qb-bad)",        label: "last run failed" },
    unknown: { dot: "var(--qb-text-faint)", label: "no runs recorded yet" },
    error:   { dot: "var(--qb-bad)",        label: "heartbeat unreachable" },
    loading: { dot: "var(--qb-text-faint)", label: "checking…" },
  };
  const m = MAP[status] || MAP.unknown;
  const l = h && h.latest;
  const ageMin = h && h.ageMs != null ? Math.round(h.ageMs / 60000) : null;
  const staleMin = h && h.staleMs ? Math.round(h.staleMs / 60000) : 35;

  return (
    <Panel title="📐 Alex G · Cron Health" subtitle="alexg-run heartbeat" style={{ gridColumn }}>
      <div style={{ padding: 12, fontFamily: "var(--qb-font-mono)", fontSize: 11 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: m.dot, display: "inline-block", flexShrink: 0 }} />
          <span style={{ color: "var(--qb-text-hi)", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>{m.label}</span>
          {ageMin != null && (
            <span style={{ color: "var(--qb-text-faint)", marginLeft: "auto" }}>
              {ageMin <= 0 ? "just now" : `${ageMin} min ago`}
            </span>
          )}
        </div>
        {error && <PlaceholderError msg={`Cron health: ${error}`} />}
        {l && (
          <div style={{ color: "var(--qb-text-mid)", lineHeight: 1.7 }}>
            <div>last run {new Date(l.ts).toUTCString().slice(5, 25)} UTC{l.dryRun ? " · dry-run" : ""}</div>
            <div>
              evaluated <b style={{ color: "var(--qb-text-hi)" }}>{l.evaluated}</b>
              {" · "}placed <b style={{ color: l.placed > 0 ? "var(--qb-ok)" : "var(--qb-text-hi)" }}>{l.placed}</b>
              {" · "}skipped {l.skipped}
              {l.durationMs != null ? ` · ${(l.durationMs / 1000).toFixed(1)}s` : ""}
            </div>
            {l.error   && <div style={{ color: "var(--qb-bad)" }}>error: {l.error}</div>}
            {l.blocked && <div style={{ color: "var(--qb-warn)" }}>blocked: {l.blocked}</div>}
          </div>
        )}
        {!l && !error && (
          <div style={{ color: "var(--qb-text-faint)", fontStyle: "italic" }}>
            No alexg-run executions recorded yet — the heartbeat appears after the cron's first run.
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 9, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
          Green = ran within {staleMin} min. Amber = overdue (possible silent cron failure). Red = last run threw.
        </div>
      </div>
    </Panel>
  );
}

function AlexgSignalsPanel({ gridColumn = "1 / 4" }) {
  const [results, setResults] = useState({});
  const [error, setError]     = useState(null);
  const [busy, setBusy]       = useState(false);
  const [progress, setProgress] = useState(null);
  const [scannedAt, setScannedAt] = useState(null);
  // Fetch one instrument at a time (?asset=X is light) instead of one big
  // all-7 scan that can exceed the function timeout. Renders progressively.
  const scan = async (alive = { v: true }) => {
    setBusy(true); setError(null);
    const acc = {};
    try {
      for (let i = 0; i < ALEXG_ORDER.length; i++) {
        if (!alive.v) return;
        const a = ALEXG_ORDER[i];
        setProgress(`${i + 1}/${ALEXG_ORDER.length} · ${a.toUpperCase()}`);
        try {
          const r = await fetch(API("alexg-trade?asset=" + a)).then((res) => res.json());
          if (!alive.v) return;
          if (r && r.trade) acc[a] = r.trade;
          else acc[a] = { asset: a, tradeable: false, reason: (r && r.error) || "no data" };
        } catch (e) {
          if (!alive.v) return;
          acc[a] = { asset: a, tradeable: false, reason: "fetch failed" };
        }
        setResults({ ...acc }); // progressive — row appears as each returns
      }
      if (alive.v) setScannedAt(Date.now());
    } finally {
      if (alive.v) { setBusy(false); setProgress(null); }
    }
  };
  useEffect(() => {
    const alive = { v: true };
    scan(alive);
    const id = setInterval(() => scan(alive), 180000); // 180s; per-instrument calls are light
    return () => { alive.v = false; clearInterval(id); };
  }, []);

  const rows = ALEXG_ORDER
    .filter((a) => results && results[a])
    .map((a) => ({ a, p: results[a], st: alexgStage(results[a]) }))
    .sort((x, y) => (y.st.rank - x.st.rank) || x.a.localeCompare(y.a));
  const fireN  = rows.filter((r) => r.p.tradeable).length;
  const entryN = rows.filter((r) => !r.p.tradeable && r.st.rank === 4).length;
  const aoiN   = rows.filter((r) => r.st.rank === 3).length;
  const biasN  = rows.filter((r) => r.st.rank === 2).length;
  const gradeColor = (pct) => (pct >= 70 ? "var(--qb-ok)" : pct >= 50 ? "var(--qb-warn)" : "var(--qb-text-faint)");
  const fmt = (x) => (x == null ? "·" : String(x));

  return (
    <Panel title="📐 Alex G · Live Signals" subtitle="read-only funnel · ranked by how close each pair is to firing" style={{ gridColumn }}>
      <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap", fontFamily: "var(--qb-font-mono)", fontSize: 11 }}>
          <span style={{ color: "var(--qb-ok)" }}>{fireN} ready</span>
          <span style={{ color: "var(--qb-accent)" }}>{entryN} confirming</span>
          <span style={{ color: "var(--qb-text-mid)" }}>{aoiN} seeking AOI</span>
          <span style={{ color: "var(--qb-text-faint)" }}>{biasN} bias</span>
          <span style={{ color: "var(--qb-text-faint)" }}>
            {busy ? `scanning ${progress || ""}` : scannedAt ? `scanned ${new Date(scannedAt).toUTCString().slice(17, 25)} UTC` : "—"}
          </span>
          <button
            onClick={() => scan()}
            disabled={busy}
            style={{ marginLeft: "auto", fontFamily: "var(--qb-font-mono)", fontSize: 10, padding: "3px 10px", color: "var(--qb-text-hi)", background: "var(--qb-bg-panel-hi)", border: "1px solid var(--qb-border)", borderRadius: 4, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
          >
            {busy ? "scanning…" : "↻ rescan"}
          </button>
        </div>
        {error && <PlaceholderError msg={`Alex G scan: ${error}`} />}
        {!error && rows.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
            {busy ? `Analysing instruments… ${progress || ""}` : "No scan data yet."}
          </div>
        )}
        {rows.map(({ a, p, st }) => {
          const f = p.funnel || {};
          const tr = f.bias && f.bias.trends;
          const dirColor = p.direction === "long" ? "var(--qb-ok)" : p.direction === "short" ? "var(--qb-bad)" : "var(--qb-text-faint)";
          const graded = p.entry != null;
          return (
            <div key={a} style={{ borderTop: "1px solid var(--qb-border)", padding: "7px 2px", fontFamily: "var(--qb-font-mono)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, flexWrap: "wrap" }}>
                <span style={{ color: "var(--qb-text-hi)", fontWeight: 600, minWidth: 60 }}>{a.toUpperCase()}</span>
                <span style={{ color: st.color }}>{st.label}</span>
                {p.direction && <span style={{ color: dirColor }}>{p.direction === "long" ? "↑ long" : "↓ short"}</span>}
                {tr && (
                  <span style={{ marginLeft: "auto", fontSize: 10, letterSpacing: 0.5 }}>
                    <span style={{ color: "var(--qb-text-faint)" }}>W</span><span style={{ color: alexgTrendColor(tr.w) }}>{alexgTrend(tr.w)}</span>{" "}
                    <span style={{ color: "var(--qb-text-faint)" }}>D</span><span style={{ color: alexgTrendColor(tr.d) }}>{alexgTrend(tr.d)}</span>{" "}
                    <span style={{ color: "var(--qb-text-faint)" }}>4h</span><span style={{ color: alexgTrendColor(tr.h4) }}>{alexgTrend(tr.h4)}</span>
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: "var(--qb-text-mid)", marginTop: 3, lineHeight: 1.4 }}>
                {f.waitingFor || p.reason || "—"}
              </div>
              {graded && (
                <div style={{ fontSize: 10, color: "var(--qb-text-faint)", marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span>entry <span style={{ color: "var(--qb-text-mid)" }}>{fmt(p.entry)}</span></span>
                  <span>SL <span style={{ color: "var(--qb-text-mid)" }}>{fmt(p.sl)}</span></span>
                  <span>TP <span style={{ color: "var(--qb-text-mid)" }}>{fmt(p.tp)}</span></span>
                  <span style={{ color: p.rr != null && p.rr >= 2 ? "var(--qb-ok)" : "var(--qb-text-mid)" }}>{p.rr != null ? p.rr + "R" : "·"}</span>
                  {p.grade && <span style={{ color: gradeColor(p.grade.pct) }}>{p.grade.letter} {p.grade.pct}%</span>}
                  {p.triggerTF && <span>TF {p.triggerTF}</span>}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ marginTop: 10, fontSize: 9, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
          Read-only — analyses but never places. Rows are ranked by how far each pair has advanced through the funnel (bias → AOI → shift → engulfing → gates). The order only fires from the alexg-run cron when a setup reaches grade ≥ 70% inside session hours.
        </div>
      </div>
    </Panel>
  );
}

// ─── ORB vs PRO ORB comparison panel ─────────────────────────────────────
// Side-by-side performance cards for 'orb' and 'orb-pro', pulled live from
// /api/ledger?action=list. Includes per-instrument breakdown and per-metric
// winner indicators. When orb-pro has < MIN_TRADES trades it shows a
// "collecting data" notice so thin samples don't look bad.

const MIN_ORB_PRO_TRADES = 10;

function _aggLedger(trades) {
  if (!trades || !trades.length) return { count: 0, wins: 0, losses: 0, winRate: null, netPnl: 0, avgR: null, profitFactor: null, avgSlippage: null };
  const wins   = trades.filter((t) => t.outcome === "WIN");
  const losses = trades.filter((t) => t.outcome === "LOSS");
  const winPnl  = wins.reduce((s, t) => s + (t.netPnl || 0), 0);
  const lossPnl = losses.reduce((s, t) => s + Math.abs(t.netPnl || 0), 0);
  const rs    = trades.filter((t) => t.pnlR != null).map((t) => t.pnlR);
  const slips = trades.filter((t) => t.slippagePips != null).map((t) => t.slippagePips);
  return {
    count:        trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      trades.length ? wins.length / trades.length : null,
    netPnl:       trades.reduce((s, t) => s + (t.netPnl || 0), 0),
    avgR:         rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null,
    profitFactor: lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? null : null),
    avgSlippage:  slips.length ? slips.reduce((s, v) => s + v, 0) / slips.length : null,
  };
}

function _winnerOf(a, b, higherIsBetter = true) {
  if (a == null || b == null || !isFinite(a) || !isFinite(b)) return null;
  if (a === b) return null;
  return higherIsBetter ? (a > b ? "orb" : "orb-pro") : (a < b ? "orb" : "orb-pro");
}

function ORBStatCard({ title, agg, winners, isChallenger, thin }) {
  const s = { padding: "10px 12px", borderRadius: 6, border: "1px solid var(--qb-border)", background: "var(--qb-surface2)", minWidth: 180, flex: "1 1 180px" };
  const header = { fontFamily: "var(--qb-font-mono)", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: isChallenger ? "var(--qb-accent)" : "var(--qb-text-hi)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 };
  const row = { display: "flex", justifyContent: "space-between", padding: "3px 0", fontFamily: "var(--qb-font-mono)", fontSize: 10, borderBottom: "1px solid var(--qb-border)" };
  const badge = (metric) => {
    const w = winners[metric];
    if (!w) return null;
    const isWin = (w === "orb" && !isChallenger) || (w === "orb-pro" && isChallenger);
    return <span style={{ marginLeft: 4, fontSize: 9, color: isWin ? "var(--qb-ok)" : "var(--qb-text-faint)" }}>{isWin ? "▲" : "▼"}</span>;
  };
  const fmtWR  = (v) => v != null ? `${(v * 100).toFixed(0)}%` : "—";
  const fmtPnl = (v) => v != null ? `${v >= 0 ? "+" : ""}$${v.toFixed(2)}` : "—";
  const fmtR   = (v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}R` : "—";
  const fmtPF  = (v) => v != null ? v.toFixed(2) : "—";
  const fmtSlip= (v) => v != null ? `${v.toFixed(1)} pip` : "—";
  const wrCol  = agg.winRate != null ? (agg.winRate >= 0.5 ? "var(--qb-ok)" : agg.winRate >= 0.35 ? "var(--qb-warn)" : "var(--qb-bad)") : "var(--qb-text-mid)";
  const pnlCol = agg.netPnl >= 0 ? "var(--qb-ok)" : "var(--qb-bad)";

  return (
    <div style={s}>
      <div style={header}>
        {isChallenger ? "⚡" : "🚀"} {title}
        {thin && <span style={{ fontSize: 9, color: "var(--qb-warn)", fontWeight: 400, marginLeft: 4 }}>collecting data</span>}
      </div>
      <div style={row}><span style={{ color: "var(--qb-text-faint)" }}>Trades</span><span>{agg.count}{badge("count")}</span></div>
      <div style={row}><span style={{ color: "var(--qb-text-faint)" }}>Win rate</span><span style={{ color: wrCol }}>{fmtWR(agg.winRate)}{badge("winRate")}</span></div>
      <div style={row}><span style={{ color: "var(--qb-text-faint)" }}>Net P&L</span><span style={{ color: pnlCol }}>{fmtPnl(agg.netPnl)}{badge("netPnl")}</span></div>
      <div style={row}><span style={{ color: "var(--qb-text-faint)" }}>Avg R</span><span>{fmtR(agg.avgR)}{badge("avgR")}</span></div>
      <div style={row}><span style={{ color: "var(--qb-text-faint)" }}>Prof. factor</span><span>{fmtPF(agg.profitFactor)}{badge("profitFactor")}</span></div>
      <div style={{ ...row, border: "none" }}><span style={{ color: "var(--qb-text-faint)" }}>Avg slip</span><span>{fmtSlip(agg.avgSlippage)}{badge("avgSlippage")}</span></div>
    </div>
  );
}

function ORBComparePanel({ gridColumn = "1 / 4" }) {
  const [trades, setTrades] = useState(null);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("ledger?action=list&limit=500")).then((res) => res.json());
        if (alive) {
          if (r && Array.isArray(r.trades)) { setTrades(r.trades); setError(null); }
          else setError(r?.error || "ledger unavailable");
        }
      } catch (e) { if (alive) setError(e.message); }
    };
    tick();
    const id = setInterval(tick, 90000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const all    = trades || [];
  const orbT   = all.filter((t) => t.template === "orb");
  const proT   = all.filter((t) => t.template === "orb-pro");
  const orbAgg = _aggLedger(orbT);
  const proAgg = _aggLedger(proT);
  const thin   = proT.length < MIN_ORB_PRO_TRADES;

  // Per-metric winner map
  const winners = {
    winRate:      _winnerOf(orbAgg.winRate,      proAgg.winRate,      true),
    netPnl:       _winnerOf(orbAgg.netPnl,       proAgg.netPnl,       true),
    avgR:         _winnerOf(orbAgg.avgR,          proAgg.avgR,         true),
    profitFactor: _winnerOf(orbAgg.profitFactor,  proAgg.profitFactor, true),
    avgSlippage:  _winnerOf(orbAgg.avgSlippage,   proAgg.avgSlippage,  false),
  };

  // Per-instrument breakdown (both templates)
  const assets = Array.from(new Set([...orbT, ...proT].map((t) => t.asset).filter(Boolean))).sort();
  const instrRows = assets.map((asset) => ({
    asset,
    orb:    _aggLedger(orbT.filter((t) => t.asset === asset)),
    orbPro: _aggLedger(proT.filter((t) => t.asset === asset)),
  }));

  const fmtWR  = (v) => v != null ? `${(v * 100).toFixed(0)}%` : "—";
  const fmtPnl = (v, n) => n === 0 ? "—" : `${v >= 0 ? "+" : ""}$${v.toFixed(0)}`;
  const wrCol  = (v) => v != null ? (v >= 0.5 ? "var(--qb-ok)" : v >= 0.35 ? "var(--qb-warn)" : "var(--qb-bad)") : "var(--qb-text-faint)";

  return (
    <Panel title="ORB vs PRO ORB" subtitle="live challenger comparison — same account" style={{ gridColumn }}>
      <div style={{ padding: 12, overflow: "auto" }}>
        {error && <PlaceholderError msg={`ORB compare: ${error}`} />}
        {!error && orbT.length === 0 && proT.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
            No ledger trades for orb or orb-pro yet. Stats appear here as trades close.
          </div>
        )}

        {(orbT.length > 0 || proT.length > 0) && (
          <>
            {/* ── side-by-side summary cards ── */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <ORBStatCard title="ORB (live)"  agg={orbAgg} winners={winners} isChallenger={false} thin={false} />
              <ORBStatCard title="PRO ORB"     agg={proAgg} winners={winners} isChallenger={true}  thin={thin}  />
            </div>

            {thin && proT.length > 0 && (
              <div style={{ marginBottom: 12, fontSize: 10, color: "var(--qb-warn)", fontFamily: "var(--qb-font-mono)" }}>
                ⚠ PRO ORB has {proT.length} trade{proT.length === 1 ? "" : "s"} — need {MIN_ORB_PRO_TRADES}+ for reliable stats. ▲/▼ indicators hidden until then.
              </div>
            )}

            {/* ── per-instrument table ── */}
            {instrRows.length > 0 && (
              <div style={{ overflow: "auto" }}>
                <div style={{ fontSize: 10, color: "var(--qb-text-faint)", marginBottom: 6, fontFamily: "var(--qb-font-mono)", letterSpacing: 0.4 }}>
                  PER-INSTRUMENT BREAKDOWN
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--qb-font-mono)", fontSize: 10 }}>
                  <thead>
                    <tr style={{ color: "var(--qb-text-faint)", textAlign: "right" }}>
                      <th style={{ textAlign: "left",  padding: "3px 6px" }}>Instrument</th>
                      <th style={{ padding: "3px 6px" }}>ORB n</th>
                      <th style={{ padding: "3px 6px" }}>ORB WR</th>
                      <th style={{ padding: "3px 6px" }}>ORB net</th>
                      <th style={{ padding: "3px 4px", color: "var(--qb-accent)" }}>PRO n</th>
                      <th style={{ padding: "3px 4px", color: "var(--qb-accent)" }}>PRO WR</th>
                      <th style={{ padding: "3px 4px", color: "var(--qb-accent)" }}>PRO net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instrRows.map(({ asset, orb, orbPro }) => {
                      const assetMeta = ASSET_CATALOG.find((a) => a.id === asset);
                      const label = assetMeta ? assetMeta.name : asset;
                      const orbWRc = wrCol(orb.winRate);
                      const proWRc = wrCol(orbPro.winRate);
                      const pnlWin = orb.count && orbPro.count ? (orbPro.netPnl > orb.netPnl ? "pro" : orbPro.netPnl < orb.netPnl ? "orb" : null) : null;
                      return (
                        <tr key={asset} style={{ borderTop: "1px solid var(--qb-border)", textAlign: "right" }}>
                          <td style={{ textAlign: "left", padding: "3px 6px", color: "var(--qb-text-hi)" }}>{label}</td>
                          <td style={{ padding: "3px 6px", color: "var(--qb-text-mid)" }}>{orb.count || "·"}</td>
                          <td style={{ padding: "3px 6px", color: orbWRc }}>{fmtWR(orb.winRate)}</td>
                          <td style={{ padding: "3px 6px", color: orb.netPnl >= 0 ? "var(--qb-ok)" : "var(--qb-bad)" }}>{fmtPnl(orb.netPnl, orb.count)}</td>
                          <td style={{ padding: "3px 4px", color: "var(--qb-text-mid)" }}>{orbPro.count || "·"}</td>
                          <td style={{ padding: "3px 4px", color: proWRc }}>{fmtWR(orbPro.winRate)}</td>
                          <td style={{ padding: "3px 4px", color: orbPro.netPnl >= 0 ? "var(--qb-ok)" : "var(--qb-bad)" }}>
                            {fmtPnl(orbPro.netPnl, orbPro.count)}
                            {pnlWin === "pro" && <span style={{ marginLeft: 3, color: "var(--qb-accent)", fontSize: 9 }}>▲</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

// ─── v14.3 · Trade Data manager — view & purge recognition records ──────
// Remove software-artifact trades (e.g. a position force-closed by a bug) so
// they don't poison recognition memory / template stats. Delete is key-guarded
// server-side; the admin key is entered once and kept on this device only.
function TradeDataPanel({ gridColumn = "1 / 4" }) {
  const [trades, setTrades] = useState(null);
  const [error, setError]   = useState(null);
  const [assetFilter, setAssetFilter] = useState("all");
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [suspectsOnly, setSuspectsOnly] = useState(false);
  const [suspectCount, setSuspectCount] = useState(0);

  const load = async () => {
    try {
      const r = await fetch(API("recognition-memory?action=find&limit=500")).then((res) => res.json());
      if (r && Array.isArray(r.trades)) { setTrades(r.trades); setSuspectCount(r.suspectCount || 0); setError(null); }
      else setError(r?.error || "no trade data");
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const getKey = () => {
    let k = "";
    try { k = window.localStorage.getItem("qb_admin_key") || ""; } catch (_) {}
    if (!k) {
      k = window.prompt("Enter admin key (WEBHOOK_API_KEY) to enable delete:") || "";
      if (k) { try { window.localStorage.setItem("qb_admin_key", k); } catch (_) {} }
    }
    return k;
  };

  const del = async (t) => {
    const money = t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${Number(t.pnl).toFixed(2)}` : "";
    const label = `${t.asset} \u00b7 ${t.template || "\u2014"} \u00b7 ${t.direction || ""} \u00b7 ${money}`;
    if (!window.confirm(`Delete this trade from recognition memory?\n\n${label}\n\nRemoves it from the KNN advisor and all template stats. Your broker balance/P&L is unaffected. Cannot be undone.`)) return;
    const key = getKey();
    if (!key) return;
    setBusyId(t.id); setNotice(null);
    try {
      const r = await fetch(API(`recognition-memory?action=delete&id=${encodeURIComponent(t.id)}&key=${encodeURIComponent(key)}`)).then((res) => res.json());
      if (r && r.ok) {
        setTrades((prev) => (prev || []).filter((x) => x.id !== t.id));
        setNotice({ kind: "ok", msg: `Removed ${t.asset} ${t.template || ""}` });
      } else if (r && r.error === "unauthorized") {
        try { window.localStorage.removeItem("qb_admin_key"); } catch (_) {}
        setNotice({ kind: "err", msg: "Wrong admin key \u2014 cleared. Try the delete again." });
      } else {
        setNotice({ kind: "err", msg: r?.error || "delete failed" });
      }
    } catch (e) { setNotice({ kind: "err", msg: e.message }); }
    finally { setBusyId(null); }
  };

  const all = trades || [];
  const assets = Array.from(new Set(all.map((t) => t.asset).filter(Boolean))).sort();
  const rows = all
    .filter((t) => (assetFilter === "all" || t.asset === assetFilter) && (!suspectsOnly || t.suspect))
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));

  const oc = (o) => (o === "WIN" ? "var(--qb-ok)" : o === "LOSS" ? "var(--qb-bad)" : "var(--qb-warn)");
  const fmtDate = (iso) => {
    if (!iso) return "\u2014";
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const ctrlStyle = { background: "var(--qb-bg-panel-hi)", color: "var(--qb-text-hi)", border: "1px solid var(--qb-border)", borderRadius: 4, padding: "3px 6px", fontFamily: "var(--qb-font-mono)", fontSize: 11 };

  return (
    <Panel title="Trade Data" subtitle="view & purge recognition records" style={{ gridColumn }} collapsible panelId="trade-data" defaultCollapsed={true}>
      <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
        {error && <PlaceholderError msg={`trade data: ${error}`} />}
        {!error && (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap", fontFamily: "var(--qb-font-mono)", fontSize: 11 }}>
              <span style={{ color: "var(--qb-text-faint)" }}>{rows.length} of {all.length}</span>
              <select value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)} style={ctrlStyle}>
                <option value="all">all instruments</option>
                {assets.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <button onClick={load} style={{ ...ctrlStyle, cursor: "pointer", color: "var(--qb-text-mid)", background: "transparent" }}>{"\u21bb refresh"}</button>
              <button onClick={() => setSuspectsOnly((v) => !v)} title="Show only force-close artifacts (TP2+ reached in <=3 min)"
                style={{ ...ctrlStyle, cursor: "pointer", color: suspectsOnly ? "var(--qb-bad)" : "var(--qb-text-mid)", background: suspectsOnly ? "var(--qb-bad-soft)" : "transparent", borderColor: suspectsOnly ? "var(--qb-bad)" : "var(--qb-border)" }}>
                {`\u26a0 suspects${suspectCount ? ` (${suspectCount})` : ""}`}
              </button>
              {notice && <span style={{ color: notice.kind === "ok" ? "var(--qb-ok)" : "var(--qb-bad)" }}>{notice.msg}</span>}
            </div>
            {!trades && <div style={{ fontSize: 11, color: "var(--qb-text-faint)", fontStyle: "italic" }}>loading\u2026</div>}
            {trades && rows.length === 0 && <div style={{ fontSize: 11, color: "var(--qb-text-faint)", fontStyle: "italic" }}>No trades.</div>}
            {rows.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--qb-font-mono)", fontSize: 10 }}>
                <thead>
                  <tr style={{ color: "var(--qb-text-faint)", textAlign: "right" }}>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>When</th>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>Asset</th>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>Template</th>
                    <th style={{ padding: "4px 6px" }}>Dir</th>
                    <th style={{ padding: "4px 6px" }}>Out</th>
                    <th style={{ padding: "4px 6px" }}>P&amp;L</th>
                    <th style={{ padding: "4px 6px" }}>TPs</th>
                    <th style={{ padding: "4px 6px" }}>min</th>
                    <th style={{ padding: "4px 6px" }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const meta = TEMPLATE_DISPLAY[t.template];
                    return (
                      <tr key={t.id} style={{ borderTop: "1px solid var(--qb-border)", textAlign: "right", background: t.suspect ? "var(--qb-bad-soft)" : "transparent" }}>
                        <td style={{ textAlign: "left", padding: "4px 6px", color: "var(--qb-text-mid)" }}>{t.suspect ? "\u26a0 " : ""}{fmtDate(t.closedAtISO)}</td>
                        <td style={{ textAlign: "left", padding: "4px 6px", color: "var(--qb-text-hi)" }}>{t.asset}</td>
                        <td style={{ textAlign: "left", padding: "4px 6px", color: "var(--qb-text-mid)" }}>{meta ? `${meta.glyph} ${meta.label}` : (t.template || "\u2014")}</td>
                        <td style={{ padding: "4px 6px", color: t.direction === "LONG" ? "var(--qb-ok)" : "var(--qb-bad)" }}>{t.direction === "LONG" ? "L" : "S"}</td>
                        <td style={{ padding: "4px 6px", color: oc(t.outcome) }}>{t.outcome ? t.outcome[0] : "\u00b7"}</td>
                        <td style={{ padding: "4px 6px", color: (t.pnl || 0) >= 0 ? "var(--qb-ok)" : "var(--qb-bad)" }}>{t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}${Number(t.pnl).toFixed(2)}` : "\u00b7"}</td>
                        <td style={{ padding: "4px 6px", color: "var(--qb-text-mid)" }}>{Array.isArray(t.tpsHit) && t.tpsHit.length ? t.tpsHit.length : "\u00b7"}</td>
                        <td style={{ padding: "4px 6px", color: "var(--qb-text-faint)" }}>{t.durationMin != null ? t.durationMin : "\u00b7"}</td>
                        <td style={{ padding: "4px 6px" }}>
                          <button onClick={() => del(t)} disabled={busyId === t.id} title="Delete from recognition memory"
                            style={{ background: "transparent", color: busyId === t.id ? "var(--qb-text-faint)" : "var(--qb-bad)", border: "1px solid var(--qb-border)", borderRadius: 4, padding: "2px 7px", cursor: busyId === t.id ? "default" : "pointer", fontFamily: "var(--qb-font-mono)", fontSize: 10 }}>
                            {busyId === t.id ? "\u2026" : "\u2715"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div style={{ marginTop: 10, fontSize: 9, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
              Deleting removes a trade from the KNN advisor and template stats only \u2014 broker balance and realized P&amp;L are unaffected. Use it to purge software-artifact trades (e.g. a bug-forced close). Admin key required, stored on this device.
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

// ─── v15.6 · Immediate vs Retest shadow EV comparison (full width) ─────────
// Reads /api/entrystyle-summary. Shadow records log what WOULD have happened
// under both entry styles for reaction/orb/ICT templates that branch.
// Winner = higher EV-per-signal; no-fills count as 0R in denominator.

const ES_MIN_N  = 8;     // min nResolved before showing a decisive winner badge
const ES_EV_GAP = 0.05;  // min |immEV − retestEV| in R for a decisive call

const ES_SESS_SHORT = {
  ASIAN: "Asia", LONDON: "London", NY_AM: "NY AM", NY_PM: "NY PM",
  WEEKEND: "Wknd", OFF: "Off-hrs",
};

function EntryStyleComparisonPanel({ gridColumn = "1 / 4" }) {
  const [data, setData]           = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [ready, setReady]         = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(API("entrystyle-summary")).then((res) => res.json());
        if (!alive) return;
        // Only set data when ok:true — never expose the not-ready shape downstream
        if (r?.ok === true) { setData(r); setFetchError(null); }
        else { setData(null); setFetchError(r?.error || "not ready"); }
      } catch (e) {
        if (alive) { setData(null); setFetchError(e.message); }
      }
      if (alive) { setLastFetch(new Date()); setReady(true); }
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ── GUARD: never access data.templates / .sessions / .byTemplateSession
  //           before confirming data.ok. Only reach the grid render when ok===true.
  const dataOk = data?.ok === true;

  const panelProps = {
    title: "Immediate vs Retest",
    subtitle: "shadow EV · reaction + orb + ICT templates · not live gating",
    style: { gridColumn },
    collapsible: true, panelId: 'entry-style', defaultCollapsed: false,
  };

  // ── NOT READY state — renders a clearly visible collecting badge ──────────
  if (!ready || !dataOk) {
    const isNetworkError = ready && fetchError && fetchError !== "not ready";
    return (
      <Panel {...panelProps}>
        <div style={{ padding: "14px 16px", minHeight: 120 }}>
          {!ready && <Placeholder msg="Loading entry-style shadow data…" />}
          {ready && !isNetworkError && (
            <div style={{
              padding: "10px 14px",
              background: "var(--qb-bg-void)",
              border: "1px solid var(--qb-border)",
              borderRadius: 4,
              fontSize: 10,
              color: "var(--qb-text-mid)",
              lineHeight: 1.7,
            }}>
              <div style={{ fontWeight: 600, color: "var(--qb-text-hi)", marginBottom: 4 }}>
                Collecting entry-style data
              </div>
              Needs resolved reaction / orb trades to populate. Shadow records write on every
              signal and evaluate after 4 h. No data yet (0 resolved).
              {lastFetch && (
                <div style={{ marginTop: 6, fontSize: 8, color: "var(--qb-text-faint)" }}>
                  Last checked: {lastFetch.toLocaleTimeString()}
                </div>
              )}
            </div>
          )}
          {isNetworkError && (
            <PlaceholderError msg={`Cannot reach /api/entrystyle-summary: ${fetchError}`} />
          )}
        </div>
      </Panel>
    );
  }

  // ── DATA READY — data.ok === true; safe to access all fields ─────────────
  // data.templates, data.sessions, data.byTemplateSession are all present.
  const templates = data.templates;
  const sessions  = data.sessions;
  const getCell   = (tmpl, sess) => data.byTemplateSession[`${tmpl}|${sess}`] ?? null;

  return (
    <Panel {...panelProps}>
      <div style={{ padding: 12, overflow: "auto" }}>
        <EntryStyleSummaryBar totals={data.totals} />

        {templates.length > 0 && sessions.length > 0 ? (
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={{
              borderCollapse: "collapse",
              fontFamily: "var(--qb-font-mono)",
              fontSize: 9,
              tableLayout: "auto",
              whiteSpace: "nowrap",
            }}>
              <thead>
                <tr>
                  <th style={{
                    textAlign: "left", padding: "3px 10px 6px 2px",
                    color: "var(--qb-text-faint)", fontWeight: 400, minWidth: 138,
                  }}>
                    Template
                  </th>
                  {sessions.map((s) => (
                    <th key={s} style={{
                      textAlign: "center", padding: "3px 4px 6px",
                      color: "var(--qb-text-faint)", fontWeight: 400, minWidth: 112,
                    }}>
                      {ES_SESS_SHORT[s] || s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {templates.map((tmpl) => {
                  const meta = TEMPLATE_DISPLAY[tmpl];
                  return (
                    <tr key={tmpl} style={{ borderTop: "1px solid var(--qb-border)" }}>
                      <td style={{
                        padding: "6px 10px 6px 2px", verticalAlign: "top",
                        color: "var(--qb-text-hi)", fontSize: 10, lineHeight: 1.4,
                      }}>
                        {meta ? `${meta.glyph} ${meta.label}` : tmpl}
                      </td>
                      {sessions.map((sess) => (
                        <td key={sess} style={{ padding: "3px", verticalAlign: "top" }}>
                          <EntryStyleCell c={getCell(tmpl, sess)} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 10, color: "var(--qb-text-faint)", fontStyle: "italic", padding: "6px 4px" }}>
            No resolved signals yet — accumulates after reaction/orb trades close out.
          </div>
        )}

        <div style={{ marginTop: 8, fontSize: 8, color: "var(--qb-text-faint)", lineHeight: 1.6 }}>
          EV = avg R-per-signal · RET EV discounts no-fills (no-fill → 0R in denominator) ·
          badge requires n≥{ES_MIN_N} resolved and gap&gt;{ES_EV_GAP}R
          {lastFetch && ` · refreshed ${lastFetch.toLocaleTimeString()}`}
        </div>
      </div>
    </Panel>
  );
}

function EntryStyleCell({ c }) {
  if (!c || (c.nResolved ?? 0) === 0) {
    return (
      <div style={{
        padding: "5px 7px", textAlign: "center",
        color: "var(--qb-text-faint)", fontSize: 9, minWidth: 108,
      }}>·</div>
    );
  }

  const { nResolved, immediate: imm, retest: ret, immEV, retestEV, winner } = c;

  // Client-side gate: badge only when nResolved≥8 and |EV gap|≥0.05R
  const hasEnough  = (nResolved || 0) >= ES_MIN_N;
  const gap        = Math.abs((immEV ?? 0) - (retestEV ?? 0));
  const decisive   = hasEnough && gap >= ES_EV_GAP && winner !== "tie";

  let badgeText, badgeColor;
  if (!hasEnough) {
    badgeText = `collecting (${nResolved}/${ES_MIN_N})`;
    badgeColor = "var(--qb-text-faint)";
  } else if (!decisive) {
    badgeText = "≈ tied";
    badgeColor = "var(--qb-text-faint)";
  } else if (winner === "immediate") {
    badgeText = `▶ IMMEDIATE  +${gap.toFixed(2)}R`;
    badgeColor = "var(--qb-ok)";
  } else {
    badgeText = `▶ RETEST  +${gap.toFixed(2)}R`;
    badgeColor = "#4a9eff";
  }

  const borderColor = decisive ? badgeColor : "var(--qb-border)";

  const fmtR      = (v) => v == null ? "·" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
  const noFillPct = ret?.fillRate != null ? Math.round((1 - ret.fillRate) * 100) : null;

  return (
    <div style={{
      background: "var(--qb-bg-panel-hi)", borderRadius: 3,
      padding: "5px 7px", minWidth: 108,
      border: `1px solid ${borderColor}`,
    }}>
      {/* IMM: WR%  avgR  n=X  EV */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
        <span style={{ color: "var(--qb-text-faint)", minWidth: 24 }}>IMM</span>
        <span style={{ color: wrColorOf(imm?.winRate) }}>{fmtWR(imm?.winRate)}</span>
        <span style={{ color: netColorOf(imm?.avgR) }}>{fmtR(imm?.avgR)}</span>
        <span style={{ color: "var(--qb-text-lo)", marginLeft: "auto" }}>n={imm?.n ?? "·"}</span>
      </div>
      {/* RET: WR%  avgRPerSignal  (fills)  EV */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
        <span style={{ color: "var(--qb-text-faint)", minWidth: 24 }}>RET</span>
        <span style={{ color: wrColorOf(ret?.winRate) }}>{fmtWR(ret?.winRate)}</span>
        <span style={{ color: netColorOf(ret?.avgRPerSignal) }}>{fmtR(ret?.avgRPerSignal)}</span>
        <span style={{ color: "var(--qb-text-lo)", marginLeft: "auto" }}>({ret?.nFilled ?? "·"} fills)</span>
      </div>
      {/* EV comparison line */}
      <div style={{ display: "flex", gap: 6, marginBottom: 2, fontSize: 8 }}>
        <span style={{ color: "var(--qb-text-faint)" }}>EV</span>
        <span style={{ color: netColorOf(immEV) }}>{fmtR(immEV)}</span>
        <span style={{ color: "var(--qb-text-faint)" }}>vs</span>
        <span style={{ color: netColorOf(retestEV) }}>{fmtR(retestEV)}</span>
        {noFillPct != null && (
          <span style={{
            marginLeft: "auto",
            color: noFillPct > 40 ? "var(--qb-bad)" : "var(--qb-text-faint)",
          }}>
            {noFillPct}% no-fill
          </span>
        )}
      </div>
      {/* Winner badge */}
      <div style={{
        fontSize: 8, fontWeight: decisive ? 700 : 400,
        color: badgeColor, letterSpacing: 0.3, lineHeight: 1.4,
      }}>
        {badgeText}
      </div>
    </div>
  );
}

function EntryStyleSummaryBar({ totals }) {
  if (!totals || !(totals.n || totals.nResolved)) return null;
  const { n, nResolved, retest: ret, immEV, retestEV } = totals;
  const hasEnough = (nResolved || 0) >= ES_MIN_N;
  const gap       = Math.abs((immEV ?? 0) - (retestEV ?? 0));
  const decisive  = hasEnough && gap >= ES_EV_GAP;
  const winner    = decisive ? (immEV > retestEV ? "immediate" : "retest") : null;
  const col       = winner === "immediate" ? "var(--qb-ok)" : winner === "retest" ? "#4a9eff" : "var(--qb-text-faint)";
  const fmtR      = (v) => v == null ? "·" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

  return (
    <div style={{
      display: "flex", alignItems: "center", flexWrap: "wrap", gap: 16,
      padding: "7px 4px", borderBottom: "1px solid var(--qb-border)", marginBottom: 10,
      fontFamily: "var(--qb-font-mono)", fontSize: 9,
    }}>
      <span style={{ color: "var(--qb-text-faint)" }}>
        {nResolved ?? 0}/{n ?? 0} resolved
      </span>
      <span style={{ color: "var(--qb-text-mid)" }}>
        IMM EV <span style={{ color: netColorOf(immEV) }}>{fmtR(immEV)}</span>
      </span>
      <span style={{ color: "var(--qb-text-mid)" }}>
        RET EV <span style={{ color: netColorOf(retestEV) }}>{fmtR(retestEV)}</span>
        {ret?.fillRate != null && (
          <span style={{ color: "var(--qb-text-faint)", marginLeft: 4 }}>
            ({Math.round(ret.fillRate * 100)}% fill)
          </span>
        )}
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, color: col, marginLeft: "auto" }}>
        {!hasEnough
          ? `collecting (${nResolved ?? 0}/${ES_MIN_N})`
          : !decisive
          ? "≈ tied overall"
          : winner === "immediate"
          ? "▲ IMMEDIATE leads overall"
          : "▲ RETEST leads overall"}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PERFORMANCE RANKING — deduped recognition-memory ∪ ledger
// Join key: trade.id = "trade_{asset}_{positionId}" (deterministic).
// RANKED = n≥8 buckets, sorted by chosen metric.
// COLLECTING = n<8, greyed, sorted by n, no rank.
// ═══════════════════════════════════════════════════════════════════════════

const PR_MIN_N   = 8;
const PR_VIEWS   = [
  { id: "template", label: "By Template" },
  { id: "ts",       label: "Template × Session" },
  { id: "tsi",      label: "Template × Session × Instrument" },
];
const PR_SORTS   = [
  { id: "netPnl",       label: "Net P&L" },
  { id: "winRate",      label: "Win Rate" },
  { id: "avgR",         label: "Avg R" },
  { id: "profitFactor", label: "Profit Factor" },
];
const PR_SESSIONS = ["ASIAN", "LONDON", "NY_AM", "NY_PM", "WEEKEND", "OFF"];

function prComputeBucket(trades) {
  const n      = trades.length;
  const wins   = trades.filter(t => t.outcome === "WIN");
  const losses = trades.filter(t => t.outcome === "LOSS");
  const netPnl = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
  const winPnl = wins.reduce((s, t) => s + (t.netPnl || 0), 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + (t.netPnl || 0), 0));
  const rList  = trades.filter(t => t.pnlR != null).map(t => t.pnlR);
  const slList = trades.filter(t => t.slippagePips != null).map(t => t.slippagePips);
  const winRate = n > 0 ? wins.length / n : null;
  const avgR    = rList.length  > 0 ? rList.reduce((s, v) => s + v, 0)  / rList.length  : null;
  const profitFactor = lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? 99 : null);
  const avgSlip = slList.length > 0 ? slList.reduce((s, v) => s + v, 0) / slList.length : null;
  const avgWin  = wins.length   > 0 ? winPnl  / wins.length   : null;
  const avgLoss = losses.length > 0 ? lossPnl / losses.length : null;
  const breakEvenWR = avgWin != null && avgLoss != null && avgWin + avgLoss > 0
    ? avgLoss / (avgWin + avgLoss) : null;
  return { n, wins: wins.length, losses: losses.length, winRate, netPnl, avgR, profitFactor, avgSlip, breakEvenWR };
}

function PerfRankingPanel({ gridColumn = "1 / 4" }) {
  const [data,       setData]       = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [ready,      setReady]      = useState(false);
  const [view,       setView]       = useState("template");
  const [sortBy,     setSortBy]     = useState("netPnl");
  const [filterTemplate, setFilterTemplate] = useState("");
  const [filterSession,  setFilterSession]  = useState("");
  const [filterAsset,    setFilterAsset]    = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(API("perf-ranking")).then(res => res.json());
        if (!alive) return;
        if (r?.ok === true) { setData(r); setFetchError(null); }
        else { setData(null); setFetchError(r?.error || "no data"); }
      } catch (e) {
        if (alive) { setData(null); setFetchError(e.message); }
      }
      if (alive) setReady(true);
    };
    load();
    const tid = setInterval(load, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(tid); };
  }, []);

  const availTemplates = useMemo(() =>
    [...new Set((data?.trades || []).map(t => t.template).filter(Boolean))].sort(), [data]);
  const availAssets = useMemo(() =>
    [...new Set((data?.trades || []).map(t => t.asset).filter(Boolean))].sort(), [data]);

  const buckets = useMemo(() => {
    if (!data?.trades) return [];
    let filtered = data.trades;
    if (filterTemplate) filtered = filtered.filter(t => t.template === filterTemplate);
    if (filterSession)  filtered = filtered.filter(t => t.session  === filterSession);
    if (filterAsset)    filtered = filtered.filter(t => t.asset    === filterAsset);
    const getKey = (t) =>
      view === "ts"  ? `${t.template || "unknown"}|${t.session}` :
      view === "tsi" ? `${t.template || "unknown"}|${t.session}|${t.asset || "unknown"}` :
                       (t.template || "unknown");
    const groups = {};
    for (const t of filtered) {
      const k = getKey(t);
      (groups[k] = groups[k] || []).push(t);
    }
    return Object.entries(groups).map(([key, ts]) => {
      const parts = key.split("|");
      return { key, template: parts[0], session: parts[1] || null, asset: parts[2] || null, ...prComputeBucket(ts) };
    });
  }, [data, view, filterTemplate, filterSession, filterAsset]);

  const ranked = useMemo(() => {
    return buckets
      .filter(b => b.n >= PR_MIN_N)
      .sort((a, b) =>
        sortBy === "winRate"      ? (b.winRate       ?? -99) - (a.winRate       ?? -99) :
        sortBy === "avgR"         ? (b.avgR           ?? -99) - (a.avgR           ?? -99) :
        sortBy === "profitFactor" ? (b.profitFactor   ??   0) - (a.profitFactor   ??   0) :
                                    b.netPnl - a.netPnl
      );
  }, [buckets, sortBy]);

  const collecting = useMemo(() =>
    buckets.filter(b => b.n < PR_MIN_N).sort((a, b) => b.n - a.n), [buckets]);

  const panelProps = {
    title:    "Performance Ranking",
    subtitle: "deduped · recognition-memory ∪ ledger · real P&L",
    style: { gridColumn },
    collapsible: true, panelId: 'perf-ranking', defaultCollapsed: false,
  };

  if (!ready) return (
    <Panel {...panelProps}>
      <div style={{ padding: 14 }}><Placeholder msg="Loading performance ranking…" /></div>
    </Panel>
  );
  if (!data) return (
    <Panel {...panelProps}>
      <div style={{ padding: 14 }}>
        <PlaceholderError msg={fetchError ? `Cannot reach /api/perf-ranking: ${fetchError}` : "No data"} />
      </div>
    </Panel>
  );

  const rec = data.reconciliation;

  const btnBase = { padding: "2px 7px", fontSize: 9, cursor: "pointer", borderRadius: 3, fontFamily: "inherit" };
  const showSession  = view === "ts"  || view === "tsi";
  const showAsset    = view === "tsi";

  const thStyle = (align = "right") => ({
    padding: "3px 8px 5px", color: "var(--qb-text-faint)", fontWeight: 400,
    textAlign: align, whiteSpace: "nowrap", fontSize: 9, background: "transparent",
  });
  const tdR = (content, color) => (
    <td style={{ padding: "4px 8px", textAlign: "right", color: color || "var(--qb-text-hi)", fontSize: 10, fontFamily: "var(--qb-font-mono)", whiteSpace: "nowrap" }}>
      {content}
    </td>
  );
  const tdL = (content, maxW = 130) => (
    <td style={{ padding: "4px 6px 4px 2px", textAlign: "left", color: "var(--qb-text-hi)", fontSize: 10, whiteSpace: "nowrap", maxWidth: maxW, overflow: "hidden", textOverflow: "ellipsis" }}>
      {content}
    </td>
  );

  const tableHead = (
    <thead>
      <tr>
        <th style={{ ...thStyle("right"), width: 22 }}> </th>
        <th style={thStyle("left")}>Template</th>
        {showSession && <th style={thStyle("left")}>Session</th>}
        {showAsset   && <th style={thStyle("left")}>Instrument</th>}
        <th style={thStyle()}>n</th>
        <th style={thStyle()}>WR%</th>
        <th style={thStyle()}>Net P&L</th>
        <th style={thStyle()}>Avg R</th>
        <th style={thStyle()}>PF</th>
        <th style={thStyle()}>Avg Slip</th>
      </tr>
    </thead>
  );

  const renderRow = (b, rank, greyed) => {
    const beGap    = b.winRate != null && b.breakEvenWR != null ? b.winRate - b.breakEvenWR : null;
    const beColor  = beGap == null ? null : beGap >= 0 ? "var(--qb-ok)" : "var(--qb-bad)";
    const bePp     = beGap != null ? `${beGap >= 0 ? "▲" : "▼"}${Math.abs(Math.round(beGap * 100))}pp` : "";
    const tmplMeta = TEMPLATE_DISPLAY[b.template];
    const tmplLbl  = tmplMeta ? `${tmplMeta.glyph} ${tmplMeta.label}` : (b.template || "unknown");
    const wrColor  = b.winRate == null ? "var(--qb-text-faint)"
      : b.winRate >= 0.55 ? "var(--qb-ok)" : b.winRate <= 0.40 ? "var(--qb-bad)" : "var(--qb-text-hi)";
    return (
      <tr key={b.key} style={{
        borderTop: "1px solid var(--qb-border)",
        opacity: greyed ? 0.5 : 1,
        background: !greyed && rank % 2 === 0 ? "var(--qb-bg-void)" : "transparent",
      }}>
        <td style={{ padding: "4px 6px", textAlign: "right", color: "var(--qb-text-faint)", fontSize: 9, width: 22 }}>
          {greyed ? "" : rank}
        </td>
        {tdL(tmplLbl)}
        {showSession && tdL(b.session || "—", 80)}
        {showAsset   && tdL(b.asset   || "—", 80)}
        {tdR(b.n, "var(--qb-text-mid)")}
        <td style={{ padding: "4px 8px", textAlign: "right", fontSize: 10, fontFamily: "var(--qb-font-mono)", whiteSpace: "nowrap" }}>
          <span style={{ color: wrColor }}>
            {b.winRate != null ? `${Math.round(b.winRate * 100)}%` : "—"}
          </span>
          {bePp && <span style={{ marginLeft: 3, fontSize: 8, color: beColor }}>{bePp}</span>}
        </td>
        {tdR(
          b.netPnl != null ? `${b.netPnl >= 0 ? "+" : ""}$${Math.abs(b.netPnl).toFixed(0)}` : "—",
          b.netPnl >= 0 ? "var(--qb-ok)" : "var(--qb-bad)"
        )}
        {tdR(
          b.avgR != null ? `${b.avgR >= 0 ? "+" : ""}${b.avgR.toFixed(2)}R` : "—",
          b.avgR == null ? "var(--qb-text-faint)" : b.avgR >= 0 ? "var(--qb-ok)" : "var(--qb-bad)"
        )}
        {tdR(
          b.profitFactor == null ? "—" : b.profitFactor >= 99 ? "∞" : b.profitFactor.toFixed(2),
          b.profitFactor == null ? "var(--qb-text-faint)" : b.profitFactor >= 1 ? "var(--qb-ok)" : "var(--qb-bad)"
        )}
        {tdR(
          b.avgSlip != null ? `${b.avgSlip >= 0 ? "+" : ""}${b.avgSlip.toFixed(1)}p` : "—",
          b.avgSlip != null && b.avgSlip < -0.5 ? "var(--qb-bad)" : "var(--qb-text-faint)"
        )}
      </tr>
    );
  };

  return (
    <Panel {...panelProps}>
      <div style={{ padding: "10px 12px" }}>
        {/* Reconciliation info bar — total reconciled + rankable subset */}
        {rec && (
          <div style={{ fontSize: 8, color: "var(--qb-text-faint)", marginBottom: 10, lineHeight: 1.9 }}>
            <span style={{ color: "var(--qb-text-hi)", fontWeight: 600 }}>{rec.rankable ?? rec.total}</span>
            {" ranked trades"}
            {rec.filteredOut > 0 && (
              <span style={{ color: "var(--qb-text-faint)" }}>
                {" · "}{rec.filteredOut} excluded (unknown/legacy template)
              </span>
            )}
            <span style={{ color: "var(--qb-text-faint)" }}>
              {" · "}{rec.total} total reconciled ({rec.matched} matched · {rec.ledgerOnly} ledger-only · {rec.recogOnly} recog-only)
            </span>
          </div>
        )}

        {/* Controls — view selector + sort toggle */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 2 }}>
            {PR_VIEWS.map(v => (
              <button key={v.id} onClick={() => setView(v.id)} style={{
                ...btnBase,
                border: view === v.id ? "1px solid rgba(74,158,255,0.55)" : "1px solid var(--qb-border)",
                background: view === v.id ? "rgba(74,158,255,0.12)" : "var(--qb-bg-void)",
                color: view === v.id ? "#4a9eff" : "var(--qb-text-mid)",
                fontWeight: view === v.id ? 600 : 400,
              }}>
                {v.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 2, marginLeft: "auto", alignItems: "center" }}>
            <span style={{ fontSize: 8, color: "var(--qb-text-faint)", marginRight: 2 }}>sort</span>
            {PR_SORTS.map(s => (
              <button key={s.id} onClick={() => setSortBy(s.id)} style={{
                ...btnBase,
                border: "1px solid var(--qb-border)",
                background: sortBy === s.id ? "rgba(255,255,255,0.07)" : "transparent",
                color: sortBy === s.id ? "var(--qb-text-hi)" : "var(--qb-text-faint)",
                fontWeight: sortBy === s.id ? 600 : 400,
              }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 8, color: "var(--qb-text-faint)" }}>filter</span>
          {[
            { val: filterTemplate, set: setFilterTemplate, opts: availTemplates, placeholder: "All templates" },
            { val: filterSession,  set: setFilterSession,  opts: PR_SESSIONS,    placeholder: "All sessions"  },
            { val: filterAsset,    set: setFilterAsset,    opts: availAssets,    placeholder: "All instruments" },
          ].map(({ val, set, opts, placeholder }, fi) => (
            <select key={fi} value={val} onChange={e => set(e.target.value)} style={{
              fontSize: 9, padding: "2px 4px",
              background: "var(--qb-bg-void)", color: "var(--qb-text-mid)",
              border: val ? "1px solid rgba(74,158,255,0.55)" : "1px solid var(--qb-border)",
              borderRadius: 3, cursor: "pointer",
            }}>
              <option value="">{placeholder}</option>
              {opts.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ))}
          {(filterTemplate || filterSession || filterAsset) && (
            <button onClick={() => { setFilterTemplate(""); setFilterSession(""); setFilterAsset(""); }} style={{
              ...btnBase, border: "1px solid var(--qb-border)",
              background: "transparent", color: "var(--qb-amber)",
            }}>
              clear
            </button>
          )}
        </div>

        {/* RANKED table */}
        {ranked.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
              {tableHead}
              <tbody>{ranked.map((b, i) => renderRow(b, i + 1, false))}</tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: "10px 4px", fontSize: 10, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
            No buckets with n≥{PR_MIN_N} yet — keep accumulating trades.
          </div>
        )}

        {/* COLLECTING section */}
        {collecting.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{
              fontSize: 8, color: "var(--qb-text-faint)", fontWeight: 600,
              letterSpacing: 0.4, marginBottom: 4, paddingBottom: 4,
              borderBottom: "1px dashed var(--qb-border)",
            }}>
              COLLECTING (n&lt;{PR_MIN_N}) — not ranked · sorted by trade count
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                {tableHead}
                <tbody>{collecting.map(b => renderRow(b, 0, true))}</tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ marginTop: 8, fontSize: 8, color: "var(--qb-text-faint)", lineHeight: 1.6 }}>
          WR% flag: ▲/▼ pp vs break-even WR · PF = profit factor · Avg Slip in pips · ranked section n≥{PR_MIN_N} only
        </div>
      </div>
    </Panel>
  );
}

function StyleComparisonPanel({ gridColumn = "1 / 4" }) {
  const [trades, setTrades] = useState(null);
  const [error, setError]   = useState(null);
  const [view, setView]     = useState("overall");   // "overall" | "template"

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("recognition-memory?action=recent&limit=500")).then((res) => res.json());
        if (alive) {
          if (r && Array.isArray(r.trades)) { setTrades(r.trades); setError(null); }
          else setError(r?.error || "no trade data");
        }
      } catch (e) { if (alive) setError(e.message); }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const all      = trades || [];
  const dayAgg   = aggTrades(all.filter((t) => (t.style || "day") === "day"));
  const swingAgg = aggTrades(all.filter((t) => t.style === "swing"));
  const unclassified = all.filter((t) => t.style !== "day" && t.style !== "swing").length;

  const byTemplate = {};
  for (const t of all) {
    const tmpl = t.template || (t.contributingTactics || [])[0] || "—";
    if (!byTemplate[tmpl]) byTemplate[tmpl] = { day: [], swing: [] };
    byTemplate[tmpl][t.style === "swing" ? "swing" : "day"].push(t);
  }
  const templateRows = Object.keys(byTemplate).sort();

  return (
    <Panel title="Day vs Swing" subtitle="which profile is working" style={{ gridColumn }}>
      <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
        {error && <PlaceholderError msg={`Comparison: ${error}`} />}
        {!error && all.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
            No closed trades yet. Day vs Swing stats appear here once trades close and get tagged with their profile.
          </div>
        )}

        {all.length > 0 && (
          <>
            <div style={{ display: "flex", marginBottom: 12, borderBottom: "1px solid var(--qb-border)" }}>
              {[["overall", "Overall"], ["template", "By template"]].map(([id, label]) => (
                <button key={id} onClick={() => setView(id)} style={{
                  padding: "5px 14px", background: "transparent", border: "none", cursor: "pointer",
                  fontFamily: "var(--qb-font-mono)", fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase",
                  color: view === id ? "var(--qb-accent)" : "var(--qb-text-faint)",
                  borderBottom: view === id ? "2px solid var(--qb-accent)" : "2px solid transparent",
                  fontWeight: view === id ? 700 : 400,
                }}>{label}</button>
              ))}
            </div>

            {view === "overall" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <StyleStatCard title="DAY" agg={dayAgg} />
                <StyleStatCard title="SWING" agg={swingAgg} />
              </div>
            )}

            {view === "template" && (
              <div style={{ overflow: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--qb-font-mono)", fontSize: 10 }}>
                  <thead>
                    <tr style={{ color: "var(--qb-text-faint)", textAlign: "right" }}>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>Template</th>
                      <th style={{ padding: "4px 6px" }}>Day n</th>
                      <th style={{ padding: "4px 6px" }}>Day WR</th>
                      <th style={{ padding: "4px 6px" }}>Day net</th>
                      <th style={{ padding: "4px 6px" }}>Sw n</th>
                      <th style={{ padding: "4px 6px" }}>Sw WR</th>
                      <th style={{ padding: "4px 6px" }}>Sw net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templateRows.map((tmpl) => {
                      const d = aggTrades(byTemplate[tmpl].day);
                      const s = aggTrades(byTemplate[tmpl].swing);
                      const meta = TEMPLATE_DISPLAY[tmpl];
                      return (
                        <tr key={tmpl} style={{ borderTop: "1px solid var(--qb-border)", textAlign: "right" }}>
                          <td style={{ textAlign: "left", padding: "4px 6px", color: "var(--qb-text-hi)" }}>
                            {meta ? `${meta.glyph} ${meta.label}` : tmpl}
                          </td>
                          <td style={{ padding: "4px 6px", color: "var(--qb-text-mid)" }}>{d.count || "·"}</td>
                          <td style={{ padding: "4px 6px", color: wrColorOf(d.winRate) }}>{fmtWR(d.winRate)}</td>
                          <td style={{ padding: "4px 6px", color: netColorOf(d.net) }}>{fmtNet(d.net, d.count)}</td>
                          <td style={{ padding: "4px 6px", color: "var(--qb-text-mid)" }}>{s.count || "·"}</td>
                          <td style={{ padding: "4px 6px", color: wrColorOf(s.winRate) }}>{fmtWR(s.winRate)}</td>
                          <td style={{ padding: "4px 6px", color: netColorOf(s.net) }}>{fmtNet(s.net, s.count)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {unclassified > 0 && (
              <div style={{ marginTop: 10, fontSize: 9, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
                {unclassified} older trade{unclassified === 1 ? "" : "s"} predate profile tagging and aren't counted by style.
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

// =====================================================================
// 15b · RECOGNITION MEMORY PANEL  [v13.1]
// =====================================================================
// Statistics view only (3A). Reads /api/recognition-memory?action=stats
// — the confirmed-working endpoint that returns:
//   { totalTrades, wins, losses, winRate, synthetic, real }
// This panel is purely informational: it shows what the KNN advisor has
// learned. Recognition is in OBSERVATION mode — it stores outcomes and can
// advise, but does not yet auto-size live trades.

function RecognitionPanel({ perf, gridColumn = "1 / 3" }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("recognition-memory?action=stats")).then((res) => res.json());
        if (alive) {
          if (r && !r.error) { setStats(r); setError(null); }
          else setError(r?.error || "endpoint not deployed");
        }
      } catch (e) { if (alive) setError(e.message); }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const total   = stats?.totalTrades ?? 0;
  const wins    = stats?.wins ?? 0;
  const losses  = stats?.losses ?? 0;
  const real    = stats?.real ?? 0;
  const synth   = stats?.synthetic ?? 0;
  const wr      = stats?.winRate != null ? stats.winRate : (total > 0 ? wins / total : null);
  const wrColor = wr == null ? "var(--qb-text-lo)" : wr >= 0.55 ? "var(--qb-ok)" : wr >= 0.45 ? "var(--qb-warn)" : "var(--qb-bad)";

  // Memory maturity: how close to a statistically meaningful sample.
  const MATURE_AT = 200;
  const maturity = Math.min(1, total / MATURE_AT);

  return (
    <Panel title="Recognition Memory" subtitle="KNN advisor · observation mode" style={{ gridColumn }}>
      <div style={{ padding: 12, height: "100%", overflow: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>

        {/* LEFT — the numbers */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {error && <PlaceholderError msg={`Recognition: ${error}`} />}

          <div style={{ display: "flex", gap: 18, alignItems: "flex-end" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>
                Memory win rate
              </span>
              <span className="qb-mono" style={{ fontSize: 30, fontWeight: 300, color: wrColor, lineHeight: 1.1 }}>
                {wr == null ? "—" : `${Math.round(wr * 100)}%`}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", paddingBottom: 4 }}>
              <span className="qb-mono" style={{ fontSize: 12, color: "var(--qb-ok)" }}>{wins} W</span>
              <span className="qb-mono" style={{ fontSize: 12, color: "var(--qb-bad)" }}>{losses} L</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <MiniStat label="Stored trades" value={total} />
            <MiniStat label="Real / Synthetic" value={`${real} / ${synth}`} />
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--qb-text-lo)", marginBottom: 4 }}>
              <span>Sample maturity</span>
              <span className="qb-mono">{total} / {MATURE_AT}</span>
            </div>
            <Meter value={maturity} color={maturity >= 1 ? "var(--qb-ok)" : "var(--qb-accent)"} />
            <span style={{ fontSize: 9, color: "var(--qb-text-faint)", fontStyle: "italic", marginTop: 4, display: "block" }}>
              {maturity >= 1
                ? "Sample is statistically meaningful — advisor signals are reliable."
                : `Need ~${Math.max(0, MATURE_AT - total)} more closed trades before the advisor's edge estimates stabilize.`}
            </span>
          </div>
        </div>

        {/* RIGHT — how it's used */}
        <div className="qb-cell" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>
            How the bot uses this
          </span>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "var(--qb-text-mid)", lineHeight: 1.7 }}>
            <li>Every closed trade is stored as a <strong style={{ color: "var(--qb-text-hi)" }}>feature vector</strong> (template, session, structure context, outcome).</li>
            <li>When a new setup forms, the advisor finds the <strong style={{ color: "var(--qb-text-hi)" }}>K nearest</strong> historical situations and reports their win/loss record.</li>
            <li>Current status: <span style={{ color: "var(--qb-warn)" }}>observation only</span> — it advises but does not yet auto-adjust live lot size.</li>
            <li>Auto-sizing from recognition unlocks once the sample is mature (≈{MATURE_AT} trades) to avoid amplifying early, biased data.</li>
          </ul>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 9, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
            Memory is never deleted on losses — it learns from both wins and losses equally.
          </span>
        </div>
      </div>
    </Panel>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="qb-cell" style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
      <span className="qb-mono" style={{ fontSize: 16, color: "var(--qb-text-hi)" }}>{value}</span>
    </div>
  );
}

// =====================================================================
// 15c · TEMPLATE × INSTRUMENT PERFORMANCE HEATMAP  [v13.1]
// =====================================================================
// Full matrix: templates (rows) × watchlist instruments (columns).
// WR / PF toggle. Data source resolution order (first that yields cells):
//   1. perf.byTemplate[t].byAsset[asset]  (if template-performance exposes it)
//   2. perf.matrix / perf.byTemplateAsset (alternate shapes)
//   3. fetched closed trades from /api/recognition-memory?action=recent
// Degrades to a clean placeholder if no per-(template,asset) data exists.

function cellFromStats(s) {
  if (!s) return null;
  const n  = s.sample ?? s.n ?? s.total ?? s.count ?? 0;
  let wr   = s.winRate != null ? s.winRate : (s.wins != null && n ? s.wins / n : null);
  if (wr != null && wr > 1) wr = wr / 100; // tolerate percent-form
  const pf = s.profitFactor != null ? s.profitFactor : (s.pf != null ? s.pf : null);
  return { n, wr, pf };
}

function matrixFromPerf(perf) {
  const bt = perf?.byTemplate;
  // Shape 1: nested byAsset under each template
  if (bt && typeof bt === "object") {
    const cells = {};
    let any = false;
    for (const t of TEMPLATE_ORDER) {
      const node = bt[t];
      const byAsset = node?.byAsset || node?.assets;
      if (byAsset && typeof byAsset === "object") {
        cells[t] = {};
        for (const [asset, s] of Object.entries(byAsset)) {
          const c = cellFromStats(s);
          if (c) { cells[t][String(asset).toLowerCase()] = c; if (c.n > 0) any = true; }
        }
      }
    }
    if (any) return cells;
  }
  // Shape 2: explicit matrix object  perf.matrix[template][asset]
  const m = perf?.matrix || perf?.byTemplateAsset;
  if (m && typeof m === "object") {
    const cells = {};
    let any = false;
    for (const [t, assets] of Object.entries(m)) {
      if (!assets || typeof assets !== "object") continue;
      cells[t] = {};
      for (const [asset, s] of Object.entries(assets)) {
        const c = cellFromStats(s);
        if (c) { cells[t][String(asset).toLowerCase()] = c; if (c.n > 0) any = true; }
      }
    }
    if (any) return cells;
  }
  return null;
}

function matrixFromTrades(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const acc = {};
  for (const tr of trades) {
    const template =
      tr.template || tr.templateName ||
      (Array.isArray(tr.contributingTactics) ? tr.contributingTactics[0] : null);
    const assetRaw = tr.assetId || tr.asset || tr.symbol;
    if (!template || !assetRaw) continue;
    const asset = String(assetRaw).toLowerCase();

    let pnl = tr.pnl;
    if (pnl == null) pnl = tr.profit;
    let r = tr.pnlR;
    if (r == null) r = tr.rMultiple;
    if (r == null) r = tr.rr;

    let isWin = tr.win;
    if (isWin == null && tr.outcome != null) isWin = tr.outcome === "win" || tr.outcome === "tp";
    if (isWin == null && pnl != null) isWin = pnl > 0;
    if (isWin == null && r != null) isWin = r > 0;

    const metricVal = pnl != null ? pnl : (r != null ? r : null);

    if (!acc[template]) acc[template] = {};
    if (!acc[template][asset]) acc[template][asset] = { n: 0, wins: 0, gw: 0, gl: 0 };
    const c = acc[template][asset];
    c.n += 1;
    if (isWin) c.wins += 1;
    if (metricVal != null) {
      if (metricVal >= 0) c.gw += metricVal;
      else c.gl += Math.abs(metricVal);
    }
  }
  const out = {};
  let any = false;
  for (const [t, assets] of Object.entries(acc)) {
    out[t] = {};
    for (const [a, c] of Object.entries(assets)) {
      out[t][a] = {
        n: c.n,
        wr: c.n ? c.wins / c.n : null,
        pf: c.gl > 0 ? c.gw / c.gl : (c.gw > 0 ? Infinity : null),
      };
      if (c.n > 0) any = true;
    }
  }
  return any ? out : null;
}

function heatColor(metric, cell) {
  if (!cell || !cell.n) return "var(--qb-text-faint)";
  if (metric === "wr") {
    if (cell.wr == null) return "var(--qb-text-lo)";
    if (cell.wr >= 0.55) return "var(--qb-ok)";
    if (cell.wr >= 0.40) return "var(--qb-warn)";
    return "var(--qb-bad)";
  }
  if (cell.pf == null) return "var(--qb-text-lo)";
  if (cell.pf >= 1.5) return "var(--qb-ok)";
  if (cell.pf >= 1.0) return "var(--qb-warn)";
  return "var(--qb-bad)";
}

function heatText(metric, cell) {
  if (!cell || !cell.n) return "·";
  if (metric === "wr") {
    return cell.wr == null ? "·" : `${Math.round(cell.wr * 100)}`;
  }
  if (cell.pf == null) return "·";
  if (!isFinite(cell.pf)) return "∞";
  return cell.pf.toFixed(1);
}

function PerfHeatmapPanel({ perf, watchlist, gridColumn = "3 / 4" }) {
  const [metric, setMetric] = useState("wr"); // "wr" | "pf"
  const [trades, setTrades] = useState(null);
  const [error, setError]   = useState(null);

  const perfMatrix = useMemo(() => matrixFromPerf(perf), [perf]);
  const needFetch  = !perfMatrix;

  // Fallback fetch (one-shot, quiet) only if template-performance has no matrix
  useEffect(() => {
    if (!needFetch) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(API("recognition-memory?action=recent&limit=500")).then((res) => res.json());
        if (!alive) return;
        const list = Array.isArray(r) ? r : (r?.trades || r?.recent || r?.list || r?.items || null);
        if (list) { setTrades(list); setError(null); }
        else setError(r?.error || "no per-instrument data");
      } catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; };
  }, [needFetch]);

  const matrix = perfMatrix || matrixFromTrades(trades);
  const cols   = watchlist;

  return (
    <Panel title="Template × Instrument" subtitle={metric === "wr" ? "win rate %" : "profit factor"} style={{ gridColumn }}>
      <div style={{ padding: 10, height: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 8 }}>

        {/* WR / PF toggle */}
        <div style={{ display: "flex", gap: 4 }}>
          {[{ id: "wr", label: "Win %" }, { id: "pf", label: "Profit factor" }].map((opt) => (
            <button
              key={opt.id}
              onClick={() => setMetric(opt.id)}
              className="qb-mono"
              style={{
                flex: 1,
                background: metric === opt.id ? "var(--qb-accent-soft)" : "transparent",
                color: metric === opt.id ? "var(--qb-accent)" : "var(--qb-text-mid)",
                border: `1px solid ${metric === opt.id ? "var(--qb-accent)" : "var(--qb-border)"}`,
                borderRadius: 3, padding: "4px 6px", fontSize: 9, cursor: "pointer",
                letterSpacing: 0.5, textTransform: "uppercase",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {!matrix && error && <PlaceholderError msg={`Heatmap: ${error}`} />}
        {!matrix && !error && <Placeholder msg="Aggregating closed trades..." />}

        {matrix && (
          <div style={{ overflow: "auto" }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: `64px repeat(${cols.length}, minmax(30px, 1fr))`,
              gap: 2, minWidth: 64 + cols.length * 32,
            }}>
              {/* header row */}
              <div />
              {cols.map((c) => (
                <div key={`h-${c}`} className="qb-mono" style={{
                  fontSize: 8, color: "var(--qb-text-faint)", textAlign: "center",
                  letterSpacing: 0.3, padding: "2px 0", overflow: "hidden", textOverflow: "ellipsis",
                }} title={c.toUpperCase()}>
                  {c.toUpperCase()}
                </div>
              ))}

              {/* template rows */}
              {TEMPLATE_ORDER.map((t) => {
                const meta = TEMPLATE_DISPLAY[t];
                const row = matrix[t] || {};
                return (
                  <Fragment key={t}>
                    <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: "var(--qb-text-mid)" }} title={meta?.label || t}>
                      <span style={{ fontSize: 11 }}>{meta?.glyph || "·"}</span>
                    </div>
                    {cols.map((c) => {
                      const cell = row[c] || null;
                      const col = heatColor(metric, cell);
                      return (
                        <div
                          key={`${t}-${c}`}
                          className="qb-mono"
                          title={cell && cell.n ? `${meta?.label || t} · ${c.toUpperCase()} · n=${cell.n}` : `${meta?.label || t} · ${c.toUpperCase()} · no trades`}
                          style={{
                            background: "var(--qb-bg-panel-hi)",
                            border: `1px solid ${cell && cell.n ? col : "var(--qb-border)"}`,
                            borderRadius: 3,
                            padding: "5px 0",
                            textAlign: "center",
                            fontSize: 10,
                            color: col,
                            opacity: cell && cell.n && cell.n < 3 ? 0.55 : 1,
                          }}
                        >
                          {heatText(metric, cell)}
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
            </div>

            {/* legend */}
            <div style={{ display: "flex", gap: 10, marginTop: 8, fontSize: 8, color: "var(--qb-text-faint)", flexWrap: "wrap" }}>
              {metric === "wr" ? (
                <>
                  <LegendDot color="var(--qb-ok)"   label="≥55%" />
                  <LegendDot color="var(--qb-warn)" label="40–55%" />
                  <LegendDot color="var(--qb-bad)"  label="<40%" />
                </>
              ) : (
                <>
                  <LegendDot color="var(--qb-ok)"   label="PF ≥1.5" />
                  <LegendDot color="var(--qb-warn)" label="1.0–1.5" />
                  <LegendDot color="var(--qb-bad)"  label="<1.0" />
                </>
              )}
              <span style={{ color: "var(--qb-text-faint)" }}>· faint = n&lt;3 · "·" = no data</span>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

// =====================================================================
// 15a · REGIME DETECTOR SHADOW PANEL  (v15.3)
// =====================================================================
// Shows the shadow-mode regime detector validation data.
// Always renders — zero shadow records is the expected initial state.

const REGIME_COLORS_MAP = {
  'NEWS-BLOCKED': 'var(--qb-bad)',
  'ERRATIC':      'var(--qb-bad)',
  'CHOPPY':       'var(--qb-warn)',
  'TRENDING':     'var(--qb-ok)',
  'NORMAL':       'var(--qb-text-hi)',
};

function RegimeDetectorShadowPanel({ gridColumn = "1 / 4" }) {
  const [summary, setSummary]       = useState(null);
  const [vixData, setVixData]       = useState(null);
  const [thresholds, setThresholds] = useState(null);
  const [error, setError]           = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [sumR, vixR, thrR] = await Promise.all([
          fetch(API('regime-detector?action=shadow-summary')).then((r) => r.json()),
          fetch(API('regime-detector?action=vix')).then((r) => r.json()),
          fetch(API('regime-detector?action=thresholds')).then((r) => r.json()),
        ]);
        if (!alive) return;
        if (sumR && sumR.error && !sumR.ok) setError(sumR.error);
        else { setSummary(sumR || {}); setError(null); }
        if (vixR?.ok)  setVixData(vixR.vixData);
        if (thrR?.ok)  setThresholds(thrR.THRESHOLDS);
      } catch (e) { if (alive) setError(e.message); }
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const total     = summary?.totalShadowed ?? 0;
  const byRegime  = summary?.byRegime || [];
  const vix       = vixData?.vix;
  const vixDate   = vixData?.date;
  const vixCalm   = thresholds?.vix?.calm ?? 15;
  const vixStress = thresholds?.vix?.stressed ?? 20;
  const vixColor  = vix == null ? 'var(--qb-text-faint)'
    : vix > vixStress ? 'var(--qb-bad)'
    : vix < vixCalm   ? 'var(--qb-ok)'
    : 'var(--qb-warn)';

  return (
    <Panel title="Regime Detector" subtitle="shadow mode · validation only · not gating trades yet" style={{ gridColumn }}>
      <div style={{ padding: 12, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Status bar — always visible */}
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap', paddingBottom: 8, borderBottom: '1px solid var(--qb-border)' }}>
          <div className="qb-mono" style={{ fontSize: 11 }}>
            VIX&nbsp;
            {vix != null ? (
              <>
                <span style={{ color: vixColor, fontSize: 14, fontWeight: 600 }}>{vix.toFixed(1)}</span>
                <span style={{ color: 'var(--qb-text-faint)', fontSize: 9 }}> as of {vixDate}</span>
                <span style={{ color: 'var(--qb-text-faint)', fontSize: 9 }}> · calm &lt;{vixCalm} · stressed &gt;{vixStress}</span>
              </>
            ) : (
              <span style={{ color: 'var(--qb-text-faint)' }}>loading…</span>
            )}
          </div>
          <div className="qb-mono" style={{ fontSize: 10, color: 'var(--qb-text-faint)' }}>
            Shadow log:&nbsp;
            <span style={{ color: total > 0 ? 'var(--qb-text-hi)' : 'var(--qb-text-faint)' }}>
              {total} signal{total !== 1 ? 's' : ''} logged
            </span>
            {summary?.matchedToLedger != null && total > 0 && (
              <span>&nbsp;· {summary.matchedToLedger} matched to ledger</span>
            )}
          </div>
          {error && (
            <span className="qb-mono" style={{ fontSize: 9, color: 'var(--qb-bad)' }}>⚠ {error}</span>
          )}
        </div>

        {/* Empty state — expected right after deploy */}
        {byRegime.length === 0 ? (
          <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 11, color: 'var(--qb-text-faint)', fontStyle: 'italic' }}>
            {summary == null && !error
              ? 'Loading…'
              : `Collecting shadow data — ${total} signal${total !== 1 ? 's' : ''} logged so far. Records accumulate as live signals arrive.`}
          </div>
        ) : (
          /* By-regime breakdown table */
          <div style={{ overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
              <thead>
                <tr style={{ color: 'var(--qb-text-faint)' }}>
                  {['Regime', 'Signals', 'Matched', 'Gated P&L', 'Est. saved', 'Actions'].map((h, i) => (
                    <th key={h} className="qb-mono" style={{ padding: '4px 8px', borderBottom: '1px solid var(--qb-border)', fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byRegime.map((g) => {
                  const col = REGIME_COLORS_MAP[g.regime] || 'var(--qb-text-mid)';
                  const actions = Object.values(g.byAction || {}).map((a) => `${a.wouldAction}×${a.signals}`).join(' / ');
                  const saved = g.detectorWouldHaveSaved;
                  return (
                    <tr key={g.regime} style={{ borderBottom: '1px solid var(--qb-border)' }}>
                      <td className="qb-mono" style={{ padding: '6px 8px', color: col, fontWeight: 700 }}>{g.regime}</td>
                      <td className="qb-mono" style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--qb-text-hi)' }}>{g.signals}</td>
                      <td className="qb-mono" style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--qb-text-mid)' }}>{g.matchedToLedger}</td>
                      <td className="qb-mono" style={{ padding: '6px 8px', textAlign: 'right', color: g.gatedNetPnl < 0 ? 'var(--qb-bad)' : 'var(--qb-ok)' }}>
                        {g.gatedNetPnl != null ? `$${g.gatedNetPnl.toFixed(2)}` : '—'}
                      </td>
                      <td className="qb-mono" style={{ padding: '6px 8px', textAlign: 'right', color: saved > 0 ? 'var(--qb-ok)' : saved < 0 ? 'var(--qb-bad)' : 'var(--qb-text-faint)' }}>
                        {saved != null ? `${saved >= 0 ? '+' : ''}$${saved.toFixed(2)}` : '—'}
                      </td>
                      <td className="qb-mono" style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--qb-text-faint)', fontSize: 9 }}>{actions}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {summary?.unmatchedNote && (
              <div style={{ fontSize: 9, color: 'var(--qb-text-faint)', marginTop: 6, fontStyle: 'italic' }}>ℹ {summary.unmatchedNote}</div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

// =====================================================================
// 15b · SESSION PERFORMANCE HEATMAP  (v15.3)
// =====================================================================
// Template rows × session columns. Color by net P&L or win rate.
// Data from recognition-memory?action=session-heatmap (server-side).

const SESSION_LABELS = { ASIAN: 'Asia', LONDON: 'London', NY_AM: 'NY AM', NY_PM: 'NY PM', WEEKEND: 'Wknd', OFF: 'Off' };
const SESSION_ORDER  = ['ASIAN', 'LONDON', 'NY_AM', 'NY_PM', 'WEEKEND', 'OFF'];

function sessHeatColor(metric, cell) {
  if (!cell || cell.n === 0) return 'var(--qb-border)';
  if (metric === 'wr') {
    if (cell.wr >= 0.6) return 'var(--qb-ok)';
    if (cell.wr >= 0.45) return 'var(--qb-warn)';
    return 'var(--qb-bad)';
  }
  // net P&L
  if (cell.pnl > 0) return 'var(--qb-ok)';
  if (cell.pnl < 0) return 'var(--qb-bad)';
  return 'var(--qb-text-faint)';
}

function sessHeatText(metric, cell) {
  if (!cell || cell.n === 0) return '·';
  if (metric === 'wr') return `${Math.round(cell.wr * 100)}%`;
  const sign = cell.pnl >= 0 ? '+' : '';
  return `${sign}$${Math.round(cell.pnl)}`;
}

function SessionHeatmapPanel({ gridColumn = "1 / 4" }) {
  const [data, setData]     = useState(null);
  const [error, setError]   = useState(null);
  const [metric, setMetric] = useState('pnl'); // 'pnl' | 'wr'

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(API('recognition-memory?action=session-heatmap')).then((res) => res.json());
        if (!alive) return;
        if (r?.ok) { setData(r); setError(null); }
        else setError(r?.error || 'endpoint error');
      } catch (e) { if (alive) setError(e.message); }
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const sessions = data?.sessions?.filter((s) => SESSION_ORDER.includes(s))
    .sort((a, b) => SESSION_ORDER.indexOf(a) - SESSION_ORDER.indexOf(b)) || SESSION_ORDER;

  const rows = data
    ? TEMPLATE_ORDER.filter((t) => data.templates.includes(t))
        .concat(data.templates.filter((t) => !TEMPLATE_ORDER.includes(t)).sort())
    : TEMPLATE_ORDER;

  return (
    <Panel title="Template × Session" subtitle={metric === 'pnl' ? 'net P&L · color = direction' : 'win rate · color = strength'} style={{ gridColumn }} collapsible panelId="session-heatmap" defaultCollapsed={false}>
      <div style={{ padding: 10, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>

        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {[{ id: 'pnl', label: 'Net P&L' }, { id: 'wr', label: 'Win %' }].map((opt) => (
            <button key={opt.id} onClick={() => setMetric(opt.id)} className="qb-mono" style={{
              background: metric === opt.id ? 'var(--qb-accent-soft)' : 'transparent',
              color: metric === opt.id ? 'var(--qb-accent)' : 'var(--qb-text-mid)',
              border: `1px solid ${metric === opt.id ? 'var(--qb-accent)' : 'var(--qb-border)'}`,
              borderRadius: 3, padding: '4px 8px', fontSize: 9, cursor: 'pointer',
              letterSpacing: 0.5, textTransform: 'uppercase',
            }}>{opt.label}</button>
          ))}
          {data && (
            <span className="qb-mono" style={{ fontSize: 8, color: 'var(--qb-text-faint)', marginLeft: 6 }}>
              {data.total} trades · {data.sessions?.length || 0} sessions
            </span>
          )}
        </div>

        {error && <PlaceholderError msg={`Session heatmap: ${error}`} />}
        {!error && !data && <Placeholder msg="Loading session data…" />}

        {data && (
          <div style={{ overflow: 'auto' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `80px repeat(${sessions.length}, minmax(56px, 1fr))`,
              gap: 2,
            }}>
              {/* header */}
              <div />
              {sessions.map((s) => (
                <div key={`h-${s}`} className="qb-mono" style={{
                  fontSize: 8, color: 'var(--qb-text-faint)', textAlign: 'center',
                  letterSpacing: 0.4, padding: '2px 0',
                }}>{SESSION_LABELS[s] || s}</div>
              ))}

              {/* template rows */}
              {rows.map((t) => {
                const meta = TEMPLATE_DISPLAY[t];
                const row  = data.matrix?.[t] || {};
                return (
                  <Fragment key={t}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      fontSize: 9, color: 'var(--qb-text-mid)', overflow: 'hidden',
                    }} title={meta?.label || t}>
                      <span style={{ fontSize: 11 }}>{meta?.glyph || '·'}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {meta?.label || t}
                      </span>
                    </div>
                    {sessions.map((s) => {
                      const cell = row[s] || null;
                      const col  = sessHeatColor(metric, cell);
                      const dimmed = cell && cell.n > 0 && cell.n < 8;
                      return (
                        <div key={`${t}-${s}`} className="qb-mono"
                          title={cell ? `${meta?.label || t} · ${SESSION_LABELS[s] || s} · n=${cell.n} · WR=${Math.round(cell.wr * 100)}% · net=$${Math.round(cell.pnl)} · avgR=${cell.avgR ?? '—'}` : `${meta?.label || t} · ${SESSION_LABELS[s] || s} · no trades`}
                          style={{
                            background: 'var(--qb-bg-panel-hi)',
                            border: `1px solid ${cell && cell.n ? col : 'var(--qb-border)'}`,
                            borderRadius: 3, padding: '4px 2px',
                            textAlign: 'center', fontSize: 9, color: col,
                            opacity: dimmed ? 0.6 : 1,
                            lineHeight: 1.3,
                          }}
                        >
                          {cell && cell.n > 0 ? (
                            <>
                              <div style={{ fontSize: 7, color: 'var(--qb-text-faint)' }}>n={cell.n}</div>
                              <div>{sessHeatText(metric, cell)}</div>
                            </>
                          ) : '·'}
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 8, color: 'var(--qb-text-faint)', flexWrap: 'wrap' }}>
              {metric === 'wr' ? (
                <><LegendDot color="var(--qb-ok)" label="≥60%" /><LegendDot color="var(--qb-warn)" label="45–60%" /><LegendDot color="var(--qb-bad)" label="<45%" /></>
              ) : (
                <><LegendDot color="var(--qb-ok)" label="+P&L" /><LegendDot color="var(--qb-bad)" label="-P&L" /></>
              )}
              <span>· faint = n&lt;8 (insufficient sample) · hover for details</span>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}
// =====================================================================
// 15c . ORDER FLOW CONFIRMATION PANEL  (v15.7)
// =====================================================================
// Reads /api/orderflow-summary -- Phase 3 CVD shadow data.
// Shows whether CVD-confirmed trades outperform unconfirmed ones.
// NOT gating execution yet -- shadow measurement only.

const OF_MIN_N = 8; // n<8 cells show "collecting" instead of stats

function ofVerdict(conf, unconf, delta) {
  if (!conf || !unconf || conf.n < OF_MIN_N || unconf.n < OF_MIN_N) {
    return { text: 'collecting', color: 'var(--qb-text-faint)' };
  }
  const dWR = delta?.winRateDelta ?? 0;
  const dR  = conf.avgR != null && unconf.avgR != null ? conf.avgR - unconf.avgR : null;
  if (dWR > 0.05 || (dR != null && dR > 0.1))  return { text: 'CVD adds edge', color: 'var(--qb-ok)' };
  if (dWR < -0.05 || (dR != null && dR < -0.1)) return { text: 'CVD penalises', color: 'var(--qb-bad)' };
  return { text: 'no edge yet', color: 'var(--qb-warn)' };
}

function OFMiniStat({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 7, color: 'var(--qb-text-faint)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span className="qb-mono" style={{ fontSize: 12, color: color || 'var(--qb-text-hi)', fontWeight: 500 }}>{value ?? '--'}</span>
    </div>
  );
}

function OFStatBox({ label, accent, s, minN = OF_MIN_N }) {
  const collecting = !s || s.n < minN;
  const wr   = s?.winRate ?? null;
  const net  = s?.netPnl  ?? null;
  const avgR = s?.avgR    ?? null;
  return (
    <div style={{
      flex: 1, minWidth: 160, padding: '10px 14px',
      background: 'var(--qb-bg-panel-hi)',
      border: `1px solid ${collecting ? 'var(--qb-border)' : accent}`,
      borderRadius: 4, opacity: collecting ? 0.65 : 1,
    }}>
      <div className="qb-mono" style={{ fontSize: 8, color: accent || 'var(--qb-text-faint)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 5 }}>
        {label}
      </div>
      {collecting ? (
        <div style={{ fontSize: 9, color: 'var(--qb-text-faint)', fontStyle: 'italic' }}>
          {s?.n != null ? `n=${s.n} -- collecting (need ${minN})` : 'collecting'}
        </div>
      ) : (
        <div className="qb-mono" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <OFMiniStat label="n"    value={s.n} />
          <OFMiniStat label="WR"   value={wr  != null ? `${Math.round(wr * 100)}%` : '--'}
            color={wr >= 0.55 ? 'var(--qb-ok)' : wr >= 0.45 ? 'var(--qb-warn)' : 'var(--qb-bad)'} />
          <OFMiniStat label="net"  value={net  != null ? fmtUSD(net, true) : '--'}
            color={net >= 0 ? 'var(--qb-ok)' : 'var(--qb-bad)'} />
          <OFMiniStat label="avgR" value={avgR != null ? `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R` : '--'}
            color={avgR != null ? (avgR >= 0 ? 'var(--qb-ok)' : 'var(--qb-bad)') : null} />
        </div>
      )}
    </div>
  );
}

function OFTplCell({ s, minN = OF_MIN_N }) {
  const collecting = !s || s.n < minN;
  return (
    <td style={{ padding: '5px 8px', textAlign: 'center', opacity: collecting ? 0.45 : 1 }}>
      {collecting ? (
        <span className="qb-mono" style={{ fontSize: 8, color: 'var(--qb-text-faint)' }}>
          {s?.n != null ? `n=${s.n}` : '--'}
        </span>
      ) : (
        <span className="qb-mono" style={{ fontSize: 9 }}>
          <span style={{ color: 'var(--qb-text-mid)' }}>n={s.n} </span>
          <span style={{ color: s.winRate >= 0.55 ? 'var(--qb-ok)' : s.winRate >= 0.45 ? 'var(--qb-warn)' : 'var(--qb-bad)' }}>
            {Math.round(s.winRate * 100)}%
          </span>
          {' '}
          <span style={{ color: s.netPnl >= 0 ? 'var(--qb-ok)' : 'var(--qb-bad)' }}>{fmtUSD(s.netPnl, true)}</span>
          {s.avgR != null && (
            <span style={{ color: s.avgR >= 0 ? 'var(--qb-ok)' : 'var(--qb-bad)' }}>
              {' '}{s.avgR >= 0 ? '+' : ''}{s.avgR.toFixed(2)}R
            </span>
          )}
        </span>
      )}
    </td>
  );
}

function OFSectionLabel({ children }) {
  return (
    <div className="qb-mono" style={{
      fontSize: 8, color: 'var(--qb-text-faint)',
      textTransform: 'uppercase', letterSpacing: 1.1,
      padding: '10px 0 5px', marginTop: 4,
      borderTop: '1px solid var(--qb-border)',
    }}>{children}</div>
  );
}

function OrderFlowPanel({ gridColumn = "1 / 4", style }) {
  const [data, setData]           = useState(null);
  const [fetchError, setError]    = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [ready, setReady]         = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(API('orderflow-summary')).then((res) => res.json());
        if (!alive) return;
        if (r?.ok) { setData(r); setError(null); }
        else { setData(null); setError(r?.error || 'endpoint error'); }
      } catch (e) {
        if (alive) { setData(null); setError(e.message); }
      }
      if (alive) { setLastFetch(new Date()); setReady(true); }
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const panelProps = {
    title: 'Order Flow Confirmation',
    subtitle: 'cvd shadow -- not gating yet -- measuring',
    style: { gridColumn, ...(style || {}) },
    collapsible: true, panelId: 'order-flow', defaultCollapsed: false,
  };

  if (!ready) return (
    <Panel {...panelProps}>
      <div style={{ padding: '18px 14px' }}><Placeholder msg="Loading order-flow data..." /></div>
    </Panel>
  );

  if (fetchError && !data) return (
    <Panel {...panelProps}>
      <div style={{ padding: '14px 16px' }}>
        <PlaceholderError msg={`/api/orderflow-summary: ${fetchError}`} />
      </div>
    </Panel>
  );

  if (!data) return (
    <Panel {...panelProps}>
      <div style={{ padding: '14px 16px', minHeight: 100 }}>
        <div style={{
          padding: '10px 14px', background: 'var(--qb-bg-void)',
          border: '1px solid var(--qb-border)', borderRadius: 4,
          fontSize: 10, color: 'var(--qb-text-mid)', lineHeight: 1.7,
        }}>
          <div style={{ fontWeight: 600, color: 'var(--qb-text-hi)', marginBottom: 4 }}>
            Collecting order-flow confirmation data
          </div>
          Needs resolved trades with CVD/footprint tags. Shadow records write on every
          signal and are evaluated after trades close.
          {lastFetch && (
            <div style={{ marginTop: 6, fontSize: 8, color: 'var(--qb-text-faint)' }}>
              Last checked: {lastFetch.toLocaleTimeString()}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );

  // -- data is ready ---------------------------------------------------
  const conf    = data.byConfirms.confirmed;
  const unconf  = data.byConfirms.unconfirmed;
  const delta   = data.byConfirms.delta;
  const divB    = data.byDivergence.bearish;
  const divBull = data.byDivergence.bullish;
  const divNone = data.byDivergence.none;
  const ftrust  = data.fullTrustVsLow.fullTrust;
  const ltrust  = data.fullTrustVsLow.lowTrust;
  const cov     = data.coverage;

  // combine bearish + bullish divergence
  const divN    = (divB?.n ?? 0) + (divBull?.n ?? 0);
  const divWins = (divB?.wins ?? 0) + (divBull?.wins ?? 0);
  const divNet  = (divB?.netPnl ?? 0) + (divBull?.netPnl ?? 0);
  const divWR   = divN > 0 ? divWins / divN : null;
  const divAvgR = divN > 0
    ? (((divB?.avgR ?? 0) * (divB?.n ?? 0) + (divBull?.avgR ?? 0) * (divBull?.n ?? 0)) / divN)
    : null;
  const divCombined = { n: divN, wins: divWins, netPnl: divNet, winRate: divWR, avgR: divAvgR };

  const verdict  = ofVerdict(conf, unconf, delta);
  const dAvgR    = conf.avgR != null && unconf.avgR != null ? conf.avgR - unconf.avgR : null;
  const tplRows  = TEMPLATE_ORDER.filter((t) => data.byTemplate[t]);

  return (
    <Panel {...panelProps}>
      <div style={{ padding: 12, overflow: 'auto' }}>

        {/* coverage + freshness */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingBottom: 8, borderBottom: '1px solid var(--qb-border)', flexWrap: 'wrap' }}>
          <span className="qb-mono" style={{ fontSize: 9, color: 'var(--qb-text-faint)' }}>
            {cov.totalClosed} closed trades
            <span style={{ color: 'var(--qb-text-mid)' }}> ({cov.withCvdShadow} with CVD shadow, {cov.coveragePct}%)</span>
          </span>
          {cov.coveragePct < 50 && (
            <span className="qb-mono" style={{ fontSize: 8, color: 'var(--qb-warn)' }}>low coverage -- data still accumulating</span>
          )}
          <span style={{ flex: 1 }} />
          <span className="qb-mono" style={{ fontSize: 8, color: 'var(--qb-text-faint)', fontStyle: 'italic' }}>shadow data -- not gating execution</span>
          {lastFetch && <span className="qb-mono" style={{ fontSize: 8, color: 'var(--qb-text-faint)', marginLeft: 8 }}>{lastFetch.toLocaleTimeString()}</span>}
        </div>

        {/* ---- 1. SUMMARY BAR ------------------------------------------- */}
        <OFSectionLabel>1 -- CVD Confirmation Overview</OFSectionLabel>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <OFStatBox label="CVD Confirmed (slope = direction)" accent="var(--qb-ok)" s={conf} />
          <OFStatBox label="CVD Unconfirmed (slope opposes)" accent="var(--qb-bad)" s={unconf} />

          {/* edge verdict card */}
          <div style={{
            flex: 1, minWidth: 180, padding: '10px 14px',
            background: 'var(--qb-bg-panel-hi)',
            border: `1px solid ${verdict.color}`,
            borderRadius: 4,
          }}>
            <div className="qb-mono" style={{ fontSize: 8, color: 'var(--qb-text-faint)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 5 }}>
              Edge (confirmed - unconfirmed)
            </div>
            <div className="qb-mono" style={{ fontSize: 15, fontWeight: 700, color: verdict.color, marginBottom: 6, letterSpacing: 0.4 }}>
              {verdict.text.toUpperCase()}
            </div>
            {delta && conf.n >= OF_MIN_N && unconf.n >= OF_MIN_N ? (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <OFMiniStat label="delta WR"
                  value={`${delta.winRateDelta >= 0 ? '+' : ''}${(delta.winRateDelta * 100).toFixed(1)}%`}
                  color={delta.winRateDelta > 0 ? 'var(--qb-ok)' : 'var(--qb-bad)'} />
                {dAvgR != null && (
                  <OFMiniStat label="delta avgR"
                    value={`${dAvgR >= 0 ? '+' : ''}${dAvgR.toFixed(2)}R`}
                    color={dAvgR > 0 ? 'var(--qb-ok)' : 'var(--qb-bad)'} />
                )}
                <OFMiniStat label="delta net"
                  value={fmtUSD(delta.netPnlDelta, true)}
                  color={delta.netPnlDelta > 0 ? 'var(--qb-ok)' : 'var(--qb-bad)'} />
              </div>
            ) : (
              <div style={{ fontSize: 9, color: 'var(--qb-text-faint)' }}>
                Need n&ge;{OF_MIN_N} per side. Confirmed: {conf.n} | Unconfirmed: {unconf.n}
              </div>
            )}
          </div>
        </div>

        {/* ---- 2. PER-TEMPLATE TABLE ------------------------------------- */}
        <OFSectionLabel>2 -- By Template -- which setups benefit from CVD?</OFSectionLabel>
        {tplRows.length === 0 ? (
          <Placeholder msg="No per-template data yet." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--qb-font-mono)', fontSize: 9, whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={{ color: 'var(--qb-text-faint)' }}>
                  {['Template', 'Confirmed  n / WR / net / avgR', 'Unconfirmed  n / WR / net / avgR', 'Delta WR'].map((h, i) => (
                    <th key={h} className="qb-mono" style={{
                      padding: '3px 8px 6px', borderBottom: '1px solid var(--qb-border)',
                      fontWeight: 400, fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.4,
                      textAlign: i === 0 ? 'left' : 'center',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tplRows.map((t) => {
                  const row  = data.byTemplate[t];
                  const meta = TEMPLATE_DISPLAY[t];
                  const c    = row.confirmed;
                  const u    = row.unconfirmed;
                  const hasC = c.n >= OF_MIN_N;
                  const hasU = u.n >= OF_MIN_N;
                  const dWR  = hasC && hasU ? c.winRate - u.winRate : null;
                  return (
                    <tr key={t} style={{ borderBottom: '1px solid var(--qb-border)' }}>
                      <td style={{ padding: '5px 8px', color: 'var(--qb-text-hi)', whiteSpace: 'nowrap' }}>
                        <span style={{ marginRight: 5, fontSize: 11 }}>{meta?.glyph || '.'}</span>
                        <span style={{ fontSize: 9 }}>{meta?.label || t}</span>
                      </td>
                      <OFTplCell s={c} />
                      <OFTplCell s={u} />
                      <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                        {dWR != null ? (
                          <span className="qb-mono" style={{
                            fontSize: 10, fontWeight: 600,
                            color: dWR > 0.04 ? 'var(--qb-ok)' : dWR < -0.04 ? 'var(--qb-bad)' : 'var(--qb-text-mid)',
                          }}>
                            {dWR >= 0 ? '+' : ''}{(dWR * 100).toFixed(1)}%
                          </span>
                        ) : <span style={{ color: 'var(--qb-text-faint)' }}>--</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ---- 3. CVD DIVERGENCE SECTION --------------------------------- */}
        <OFSectionLabel>3 -- CVD Divergence -- hollow-move trades vs clean entries</OFSectionLabel>
        <div style={{ fontSize: 9, color: 'var(--qb-text-mid)', marginBottom: 8, lineHeight: 1.5 }}>
          Bearish div: price made new high but CVD did not (hollow LONG). Bullish div: price made new low but CVD did not (hollow SHORT).
          Theory: divergent-tagged entries should underperform clean entries -- negative delta WR confirms the filter is worth using.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <OFStatBox label="Any divergence (bearish + bullish combined)" accent="var(--qb-warn)" s={divCombined} />
          <OFStatBox label="No divergence (clean)" accent="var(--qb-accent)" s={divNone} />
          {divCombined.n >= OF_MIN_N && (divNone?.n ?? 0) >= OF_MIN_N && (() => {
            const dWRDiv = divCombined.winRate - divNone.winRate;
            const dRDiv  = divCombined.avgR != null && divNone.avgR != null ? divCombined.avgR - divNone.avgR : null;
            return (
              <div style={{
                flex: 1, minWidth: 140, padding: '10px 14px',
                background: 'var(--qb-bg-panel-hi)', border: '1px solid var(--qb-border)', borderRadius: 4,
              }}>
                <div className="qb-mono" style={{ fontSize: 8, color: 'var(--qb-text-faint)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
                  Divergent vs clean delta
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <OFMiniStat label="delta WR"
                    value={`${(dWRDiv * 100) >= 0 ? '+' : ''}${(dWRDiv * 100).toFixed(1)}%`}
                    color={dWRDiv < 0 ? 'var(--qb-ok)' : 'var(--qb-bad)'} />
                  {dRDiv != null && (
                    <OFMiniStat label="delta avgR"
                      value={`${dRDiv >= 0 ? '+' : ''}${dRDiv.toFixed(2)}R`}
                      color={dRDiv < 0 ? 'var(--qb-ok)' : 'var(--qb-bad)'} />
                  )}
                </div>
                <div style={{ fontSize: 8, color: 'var(--qb-text-faint)', marginTop: 5 }}>
                  negative = divergent trades underperform clean (theory confirmed)
                </div>
              </div>
            );
          })()}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {[{ label: 'Bearish divergence', s: divB }, { label: 'Bullish divergence', s: divBull }].map(({ label, s }) => {
            const ok = s && s.n >= 3;
            return (
              <div key={label} style={{
                flex: 1, minWidth: 120, padding: '6px 10px',
                background: 'var(--qb-bg-panel-hi)', border: '1px solid var(--qb-border)', borderRadius: 3,
                opacity: ok ? 1 : 0.5,
              }}>
                <div className="qb-mono" style={{ fontSize: 7, color: 'var(--qb-text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 }}>{label}</div>
                <div className="qb-mono" style={{ fontSize: 9, color: 'var(--qb-text-mid)' }}>
                  {!ok
                    ? `n=${s?.n ?? 0}`
                    : `n=${s.n}  ${Math.round(s.winRate * 100)}% WR  ${fmtUSD(s.netPnl, true)}` +
                      (s.avgR != null ? `  ${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R` : '')
                  }
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- 4. FULL-TRUST INSTRUMENTS (footprint-capable) -------------- */}
        <OFSectionLabel>4 -- Premium instruments (BTC / indices / Gold) -- CVD full-trust only</OFSectionLabel>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <OFStatBox label="Full-trust -- CVD confirmed" accent="var(--qb-ok)" s={ftrust?.confirmed} />
          <OFStatBox label="Full-trust -- CVD unconfirmed" accent="var(--qb-bad)" s={ftrust?.unconfirmed} />
          <OFStatBox label="Full-trust -- all trades" accent="var(--qb-text-mid)" s={ftrust?.all} />
          <OFStatBox label="Low-trust FX -- all combined" accent="var(--qb-text-faint)" s={ltrust} />
        </div>
        <div style={{ marginTop: 4, fontSize: 8, color: 'var(--qb-text-faint)', fontStyle: 'italic' }}>
          Footprint absorption / exhaustion data (Path 2) not yet implemented -- showing CVD split by instrument trust level.
        </div>

        {/* ---- 5. INSTRUMENT TRUST NOTE ----------------------------------- */}
        <div className="qb-mono" style={{
          marginTop: 8, padding: '6px 10px',
          background: 'var(--qb-bg-void)', border: '1px solid var(--qb-border)', borderRadius: 3,
          fontSize: 8, color: 'var(--qb-text-faint)', lineHeight: 1.7,
        }}>
          Order-flow data is{' '}
          <span style={{ color: 'var(--qb-text-mid)' }}>full-trust</span>{' '}
          on BTC, ETH, XAUUSD, NAS, US100, US500, SP500 (tick-accurate volume).
          {' '}FX pairs are{' '}
          <span style={{ color: 'var(--qb-warn)' }}>low-trust / excluded</span>
          {' '}-- broker volume is not real tick data and does not reflect bid/ask delta. Do not interpret FX order-flow stats as meaningful.
        </div>

      </div>
    </Panel>
  );
}


// =====================================================================
// 16 · ACTIVITY FEED  (v13.1 — collapsible)
// =====================================================================

function ActivityFeed({ activity }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{
      borderTop: "1px solid var(--qb-border)",
      padding: collapsed ? "6px 18px" : "8px 18px",
      background: "var(--qb-bg-void)",
      maxHeight: collapsed ? 30 : 110,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      transition: "max-height 160ms ease, padding 160ms ease",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        marginBottom: collapsed ? 0 : 4,
      }}>
        <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>
          Activity feed · server log
        </span>
        {activity.length > 0 && (
          <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-faint)" }}>
            ({activity.length})
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Show activity feed" : "Hide activity feed"}
          className="qb-mono"
          style={{
            background: "transparent",
            border: "1px solid var(--qb-border)",
            borderRadius: 3,
            color: "var(--qb-text-mid)",
            cursor: "pointer",
            fontSize: 10,
            lineHeight: 1,
            padding: "3px 8px",
          }}
        >
          {collapsed ? "▲" : "▼"}
        </button>
      </div>
      {!collapsed && (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {activity.length === 0 ? (
            <span style={{ fontSize: 10, color: "var(--qb-text-faint)", fontStyle: "italic" }}>
              No recent activity. Rule changes and trade events will appear here.
            </span>
          ) : (
            activity.slice(0, 12).map((a, i) => (
              <ActivityRow key={i} entry={a} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ entry }) {
  // Determine color by type
  const typeColors = {
    "trade-placed":     "var(--qb-ok)",
    "manual-watching":  "var(--qb-accent)",
    "skip":             "var(--qb-warn)",
    "placement-failed": "var(--qb-bad)",
  };
  const color = typeColors[entry.type] || "var(--qb-text-mid)";

  // Build summary line
  let detail = "";
  if (entry.asset) detail += entry.asset.toUpperCase() + " ";
  if (entry.template) detail += entry.template + " ";
  if (entry.direction) detail += entry.direction + " ";
  if (entry.reason) detail += "· " + entry.reason;
  if (entry.entry) detail += " @ " + entry.entry;

  return (
    <div className="qb-mono" style={{
      fontSize: 10, color: "var(--qb-text-mid)",
      display: "flex", gap: 10, padding: "1px 0",
    }}>
      <span style={{ color: "var(--qb-text-lo)", minWidth: 44 }}>{fmtTime(entry.ts)}</span>
      <span style={{ color, minWidth: 110, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {entry.type || "event"}
      </span>
      <span style={{ color: "var(--qb-text-hi)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {detail.trim()}
      </span>
    </div>
  );
}

// =====================================================================
// 17 · PANEL FRAME + PLACEHOLDERS
// =====================================================================

function Panel({ title, subtitle, children, style, collapsible, panelId, defaultCollapsed }) {
  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible || !panelId) return false;
    try { const s = localStorage.getItem('qb_panel_' + panelId); if (s !== null) return s === 'true'; } catch (_) {}
    return defaultCollapsed === true;
  });
  const toggle = collapsible ? () => setCollapsed(c => {
    const next = !c; try { localStorage.setItem('qb_panel_' + panelId, String(next)); } catch (_) {} return next;
  }) : undefined;
  return (
    <div className="qb-panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, ...(style || {}) }}>
      <div
        style={{
          padding: "10px 14px",
          borderBottom: collapsed ? "none" : "1px solid var(--qb-border)",
          display: "flex", alignItems: "center", gap: 12,
          cursor: collapsible ? "pointer" : undefined,
          userSelect: collapsible ? "none" : undefined,
        }}
        onClick={toggle}
      >
        {collapsible && <span style={{ fontSize: 9, color: "var(--qb-text-faint)", lineHeight: 1, flexShrink: 0, marginRight: 2 }}>{collapsed ? "▸" : "▾"}</span>}
        <span className="qb-serif" style={{ fontSize: 14, color: "var(--qb-text-hi)", letterSpacing: 0.2 }}>
          {title}
        </span>
        {subtitle && (
          <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1 }}>
            {subtitle}
          </span>
        )}
      </div>
      {!collapsed && <div style={{ flex: 1, minHeight: 0 }}>{children}</div>}
    </div>
  );
}

function Placeholder({ msg }) {
  return (
    <div style={{
      padding: "16px 8px", textAlign: "center",
      fontSize: 10, color: "var(--qb-text-lo)",
      fontStyle: "italic",
    }}>{msg}</div>
  );
}

function PlaceholderError({ msg }) {
  return (
    <div style={{
      padding: "8px 10px", marginBottom: 8,
      background: "var(--qb-warn-soft)",
      border: "1px solid var(--qb-warn)",
      borderRadius: 3,
      fontSize: 10, color: "var(--qb-warn)",
      fontFamily: "var(--qb-font-mono)",
      letterSpacing: 0.3,
    }}>▲ {msg}</div>
  );
}

// =====================================================================
// 18 · MODALS
// =====================================================================

function ModalShell({ title, onClose, children, width = 420 }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="qb-panel"
        style={{
          width: `min(90vw, ${width}px)`, maxHeight: "85vh",
          background: "var(--qb-bg-panel)",
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--qb-border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span className="qb-serif" style={{ fontSize: 16, color: "var(--qb-text-hi)" }}>{title}</span>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "none", color: "var(--qb-text-mid)",
              fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 0,
            }}
          >×</button>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>{children}</div>
      </div>
    </div>
  );
}

function AssetPicker({ watchlist, resolver, onAdd, onClose }) {
  const [search, setSearch] = useState("");
  const mapped = resolver?.mapped || [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return ASSET_CATALOG;
    return ASSET_CATALOG.filter((a) =>
      a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
    );
  }, [search]);

  return (
    <ModalShell title="Add instrument" onClose={onClose} width={520}>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {resolver && !resolver.error && mapped.length === 0 && (
          <PlaceholderError msg="No broker symbols detected. Run /api/symbol-resolver?action=sync" />
        )}
        <input
          autoFocus type="text" placeholder="Search..."
          value={search} onChange={(e) => setSearch(e.target.value)}
          style={{
            background: "var(--qb-bg-panel-hi)",
            border: "1px solid var(--qb-border)",
            borderRadius: 4, padding: "8px 12px",
            color: "var(--qb-text-hi)", fontSize: 12,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 380, overflow: "auto" }}>
          {filtered.map((a) => {
            const isInWl = watchlist.includes(a.id);
            const isMapped = mapped.length === 0 || mapped.includes(a.id);
            return (
              <button
                key={a.id}
                disabled={isInWl || !isMapped}
                onClick={() => isMapped && !isInWl && onAdd(a.id)}
                style={{
                  background: isInWl ? "var(--qb-accent-soft)" : "var(--qb-bg-panel-hi)",
                  border: `1px solid ${isInWl ? "var(--qb-accent)" : "var(--qb-border)"}`,
                  borderRadius: 4, padding: "8px 12px",
                  color: !isMapped ? "var(--qb-text-faint)" : "var(--qb-text-hi)",
                  cursor: (isInWl || !isMapped) ? "default" : "pointer",
                  textAlign: "left", fontFamily: "var(--qb-font-mono)",
                  fontSize: 11,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  opacity: !isMapped ? 0.5 : 1,
                }}
              >
                <span>
                  <span style={{ fontWeight: 600 }}>{a.id.toUpperCase()}</span>
                  <span style={{ color: "var(--qb-text-mid)", marginLeft: 8 }}>{a.name}</span>
                </span>
                <span style={{ fontSize: 9, color: isInWl ? "var(--qb-accent)" : "var(--qb-text-lo)" }}>
                  {isInWl ? "✓ added" : !isMapped ? "not mapped" : "+ add"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </ModalShell>
  );
}

function EstopModal({ onConfirm, onCancel }) {
  return (
    <ModalShell title="Emergency Stop" onClose={onCancel} width={440}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 13, color: "var(--qb-text-hi)", lineHeight: 1.5 }}>
          E-STOP will <strong style={{ color: "var(--qb-bad)" }}>immediately halt all new trade entries</strong>.
        </div>
        <div className="qb-cell" style={{ padding: 10, fontSize: 11, color: "var(--qb-text-mid)", lineHeight: 1.5 }}>
          • New Pine alerts will be ignored<br/>
          • Watcher still manages open positions (TP/SL/breakeven)<br/>
          • You must manually clear E-STOP to resume<br/>
          • Per-instrument rules are preserved
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onConfirm} style={{
            flex: 1, padding: "10px 0",
            background: "var(--qb-bad)", color: "white",
            border: "none", borderRadius: 4,
            fontSize: 12, fontWeight: 700, letterSpacing: 1,
            cursor: "pointer", textTransform: "uppercase",
            fontFamily: "var(--qb-font-mono)",
          }}>⛔ Activate E-STOP</button>
          <button onClick={onCancel} style={{
            flex: 1, padding: "10px 0",
            background: "transparent", color: "var(--qb-text-mid)",
            border: "1px solid var(--qb-border)", borderRadius: 4,
            fontSize: 12, cursor: "pointer",
            fontFamily: "var(--qb-font-mono)",
            textTransform: "uppercase", letterSpacing: 1,
          }}>Cancel</button>
        </div>
      </div>
    </ModalShell>
  );
}

function SettingsModal({ theme, setTheme, resolver, onClose }) {
  const [tab, setTab] = useState("symbols");
  return (
    <ModalShell title="Settings" onClose={onClose} width={560}>
      <div style={{ display: "flex", borderBottom: "1px solid var(--qb-border)" }}>
        {[
          { id: "symbols", label: "Symbol mapping" },
          { id: "theme",   label: "Theme" },
          { id: "about",   label: "About" },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: "10px 0",
            background: tab === t.id ? "var(--qb-accent-soft)" : "transparent",
            color: tab === t.id ? "var(--qb-accent)" : "var(--qb-text-mid)",
            border: "none",
            borderBottom: `2px solid ${tab === t.id ? "var(--qb-accent)" : "transparent"}`,
            fontSize: 11, cursor: "pointer",
            fontFamily: "var(--qb-font-mono)",
            letterSpacing: 0.5, textTransform: "uppercase",
          }}>{t.label}</button>
        ))}
      </div>
      <div style={{ padding: 16, minHeight: 200 }}>
        {tab === "symbols" && <SymbolMappingTab resolver={resolver} />}
        {tab === "theme"   && <ThemeTab theme={theme} setTheme={setTheme} />}
        {tab === "about"   && <AboutTab />}
      </div>
    </ModalShell>
  );
}

function SymbolMappingTab({ resolver }) {
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      const r = await fetch(API("symbol-resolver?action=sync")).then((res) => res.json());
      if (!r.ok) alert("Sync failed: " + (r.error || "unknown"));
      else window.location.reload();
    } catch (e) { alert("Error: " + e.message); }
    setSyncing(false);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <button onClick={sync} disabled={syncing} style={{
        background: "var(--qb-accent-soft)", color: "var(--qb-accent)",
        border: "1px solid var(--qb-accent)", borderRadius: 4,
        padding: "8px 14px", fontSize: 11,
        cursor: syncing ? "wait" : "pointer",
        fontFamily: "var(--qb-font-mono)",
        textTransform: "uppercase", letterSpacing: 0.5,
      }}>{syncing ? "Syncing..." : "Sync from broker"}</button>
      {resolver?.currentMap && (
        <div className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-mid)", maxHeight: 280, overflow: "auto" }}>
          {Object.entries(resolver.currentMap).map(([a, s]) => (
            <div key={a} style={{ padding: "2px 0" }}>{a.padEnd(12)} → {s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeTab({ theme, setTheme }) {
  const colorKeys = [
    ["bgVoid",   "Void background"],
    ["bgPanel",  "Panel background"],
    ["accent",   "Accent (cyan)"],
    ["ok",       "OK / profit"],
    ["bad",      "Bad / loss"],
    ["warn",     "Warning"],
    ["textHi",   "Text primary"],
    ["textMid",  "Text secondary"],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {colorKeys.map(([k, label]) => (
        <div key={k} className="qb-cell" style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1, fontSize: 12 }}>{label}</span>
          <input
            type="color"
            value={theme[k]?.startsWith("#") ? theme[k] : "#000000"}
            onChange={(e) => setTheme({ ...theme, [k]: e.target.value })}
            style={{ width: 32, height: 24, border: "none", background: "transparent", cursor: "pointer" }}
          />
          <span className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-mid)", minWidth: 70, textAlign: "right" }}>
            {theme[k]}
          </span>
        </div>
      ))}
      <button onClick={() => setTheme(DEFAULT_THEME)} style={{
        marginTop: 8, background: "transparent", color: "var(--qb-text-mid)",
        border: "1px solid var(--qb-border)", borderRadius: 3,
        padding: "6px 12px", fontSize: 11, cursor: "pointer",
        fontFamily: "var(--qb-font-mono)",
      }}>Reset to defaults</button>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="qb-mono" style={{ fontSize: 11, color: "var(--qb-text-mid)", lineHeight: 1.6 }}>
      <div>Quantum Bot · v13.1 Pilot Dashboard</div>
      <div>Algorithmic SMC trading · Pine v2.2 (6 templates incl. AM IFVG)</div>
      <div style={{ marginTop: 8, color: "var(--qb-text-lo)" }}>
        Backend endpoints:<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/rules</span> — pilot rules R/W<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/template-performance</span> — closed-trade stats<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/recognition-memory</span> — KNN memory<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/watched-setups</span> — manual-mode watches<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/broker</span> — account + positions<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/pivots</span> — H1 pivots (optional)
      </div>
    </div>
  );
}

// =====================================================================
// 19 · MOBILE LAYOUT  [v13.2]
// =====================================================================
// A phone-native layout that reuses every existing panel component.
// Activated by useIsMobile() (<768px). The desktop layout is untouched.
// Structure: sticky top bar (stats + always-reachable E-STOP) · tab strip
// · scrollable content with one or two full-width panel cards per tab.
// Panels are wrapped in single-cell CSS grids so they stretch exactly the
// way they do inside the desktop grid — no panel internals are modified.

function MobileLayout({
  equity, balance, floatingPnL, dailyPnL, positions,
  rules, rulesError, perf, perfError, activity, resolver,
  prefs, setPrefs, theme, setTheme,
  activeMode, tradingMode, estopActive, regime, setRegimeOverride, callRulesAction,
}) {
  const [tab, setTab]                   = useState("home");
  const [estopOpen, setEstopOpen]       = useState(false);
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const setActiveModeAction  = (mode) => callRulesAction("set-active-mode",  { mode });
  const setTradingModeAction = (mode) => callRulesAction("set-trading-mode", { mode });
  const triggerEStop = () => { callRulesAction("emergency-stop", { enable: true }); setEstopOpen(false); };
  const clearEStop   = () => callRulesAction("emergency-stop", { enable: false });

  const TABS = [
    { id: "home",   label: "Home",   glyph: "⌂" },
    { id: "trades", label: "Trades", glyph: "≡" },
    { id: "stats",  label: "Stats",  glyph: "▦" },
    { id: "rules",  label: "Rules",  glyph: "⚙" },
    { id: "feed",   label: "Feed",   glyph: "☰" },
  ];

  // Wrap a desktop panel so it stretches to a fixed-height card (same
  // stretch mechanic as a desktop grid cell).
  const card = (height, node) => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", height, flexShrink: 0 }}>{node}</div>
  );

  return (
    <div style={{
      width: "100vw", height: "100vh",
      display: "flex", flexDirection: "column",
      background: "var(--qb-bg-void)", overflow: "hidden",
    }}>

      <MobileTopBar
        equity={equity} balance={balance}
        floatingPnL={floatingPnL} dailyPnL={dailyPnL}
        positions={positions}
        rulesError={rulesError}
        regime={regime}
        estopActive={estopActive}
        onOpenEstop={() => setEstopOpen(true)}
        onClearEstop={clearEStop}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* TAB STRIP */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--qb-border)", background: "var(--qb-bg-panel)", flexShrink: 0 }}>
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className="qb-mono" style={{
              flex: 1,
              background: on ? "var(--qb-accent-soft)" : "transparent",
              color: on ? "var(--qb-accent)" : "var(--qb-text-mid)",
              border: "none",
              borderBottom: `2px solid ${on ? "var(--qb-accent)" : "transparent"}`,
              padding: "9px 0", fontSize: 9, cursor: "pointer",
              letterSpacing: 0.5, textTransform: "uppercase",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            }}>
              <span style={{ fontSize: 15 }}>{t.glyph}</span>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* CONTENT */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        padding: 10, display: "flex", flexDirection: "column", gap: 10,
      }}>

        {tab === "home" && (
          <>
            <MobileModes
              activeMode={activeMode} tradingMode={tradingMode}
              onSetActiveMode={setActiveModeAction} onSetTradingMode={setTradingModeAction}
              disabled={!rules || estopActive}
            />
            {card("min(60vh, 420px)",
              <AccountSafetyPanel
                balance={balance} equity={equity}
                floatingPnL={floatingPnL} dailyPnL={dailyPnL}
                rules={rules} callRulesAction={callRulesAction}
              />
            )}
            {card("min(64vh, 480px)",
              <RegimePanel regime={regime} onSetOverride={setRegimeOverride} gridColumn="auto" compact />
            )}
          </>
        )}

        {tab === "trades" && (
          <>
            {card("min(52vh, 400px)", <OpenPositionsPanel positions={positions} />)}
            {card("min(48vh, 360px)", <WatchesPanel tradingMode={tradingMode} callRulesAction={callRulesAction} />)}
          </>
        )}

        {tab === "stats" && (
          <>
            {card("min(50vh, 380px)",
              <TemplatesPanel rules={rules} perf={perf} perfError={perfError} callRulesAction={callRulesAction} />
            )}
            {card("min(54vh, 420px)",
              <PerfHeatmapPanel perf={perf} watchlist={prefs.watchlist} gridColumn="auto" />
            )}
            {card("min(60vh, 480px)",
              <RecognitionPanel perf={perf} gridColumn="auto" />
            )}
            {card("min(56vh, 440px)",
              <TpHitPanel gridColumn="auto" />
            )}
            {card("min(52vh, 400px)",
              <ORBComparePanel gridColumn="auto" />
            )}
            {card("auto",
              <TradeDataPanel gridColumn="auto" />
            )}
            {card("auto",
              <PerfRankingPanel gridColumn="auto" />
            )}
            {card("min(40vh, 300px)",
              <AlexgHeartbeatPanel gridColumn="auto" />
            )}
            {card("min(60vh, 480px)",
              <AlexgSignalsPanel gridColumn="auto" />
            )}
            {card("auto",
              <EntryStyleComparisonPanel gridColumn="auto" />
            )}
            {card("auto",
              <OrderFlowPanel gridColumn="auto" />
            )}
          </>
        )}

        {tab === "rules" && (
          <>
            {card("min(64vh, 540px)",
              <RulesPanel
                rules={rules} rulesError={rulesError} callRulesAction={callRulesAction}
                watchlist={prefs.watchlist}
                onAddInstrument={() => setAssetModalOpen(true)}
                onRemoveInstrument={(id) => setPrefs((p) => ({ ...p, watchlist: p.watchlist.filter((a) => a !== id) }))}
              />
            )}
            {card("min(48vh, 360px)", <PivotsPanel watchlist={prefs.watchlist} />)}
          </>
        )}

        {tab === "feed" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", minHeight: "72vh", flexShrink: 0 }}>
            <MobileActivity activity={activity} />
          </div>
        )}
      </div>

      {/* MODALS (reuse desktop modal components) */}
      {assetModalOpen && (
        <AssetPicker
          watchlist={prefs.watchlist} resolver={resolver}
          onAdd={(id) => {
            setPrefs((p) => ({ ...p, watchlist: p.watchlist.includes(id) ? p.watchlist : [...p.watchlist, id] }));
            setAssetModalOpen(false);
          }}
          onClose={() => setAssetModalOpen(false)}
        />
      )}
      {estopOpen && <EstopModal onConfirm={triggerEStop} onCancel={() => setEstopOpen(false)} />}
      {settingsOpen && (
        <SettingsModal theme={theme} setTheme={setTheme} resolver={resolver} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

function MobileTopBar({
  equity, balance, floatingPnL, dailyPnL, positions,
  rulesError, regime, estopActive, onOpenEstop, onClearEstop, onOpenSettings,
}) {
  const openCount  = positions?.length || 0;
  const floatColor = floatingPnL >= 0 ? "var(--qb-ok)" : "var(--qb-bad)";
  const dailyColor = dailyPnL   >= 0 ? "var(--qb-ok)" : "var(--qb-bad)";

  return (
    <div style={{
      borderBottom: "1px solid var(--qb-border)",
      background: "var(--qb-bg-void)",
      padding: "10px 12px",
      display: "flex", flexDirection: "column", gap: 8, flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="qb-serif" style={{ fontSize: 17, color: "var(--qb-text-hi)", letterSpacing: -0.5 }}>
          Quantum<span style={{ color: "var(--qb-accent)" }}>·</span>Bot
        </span>
        {rulesError ? (
          <span className="qb-mono" title={rulesError} style={{
            fontSize: 8, padding: "2px 6px",
            background: "var(--qb-warn-soft)", color: "var(--qb-warn)",
            border: "1px solid var(--qb-warn)", borderRadius: 3, textTransform: "uppercase",
          }}>▲ off</span>
        ) : (
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--qb-ok)", display: "inline-block" }} title="online" />
        )}
        {regime && (regime.newsActive || regime.eventImminent || regime.level === "elevated" || regime.level === "crisis") && (() => {
          const hot = regime.level === "crisis" || regime.newsActive || regime.eventImminent;
          const c = hot ? "var(--qb-bad)" : "var(--qb-warn)";
          let label;
          if (regime.eventImminent && regime.nextEvent) {
            const m = regime.nextEvent.minutesUntil;
            label = `${regime.nextEvent.country} ${m > 0 ? m + "m" : m === 0 ? "NOW" : -m + "m"}`;
          } else if (regime.newsActive) { label = "NEWS"; }
          else { label = regime.level.toUpperCase(); }
          const tip = (regime.reasons || []).join("  •  ") || "Elevated market risk";
          return (
            <span title={tip} className="qb-mono" style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              fontSize: 8, fontWeight: 700, letterSpacing: 0.5, color: c,
              padding: "2px 7px", borderRadius: 3, border: `1px solid ${c}`, textTransform: "uppercase",
            }}>
              <span className="qb-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: c, boxShadow: `0 0 6px ${c}` }} />
              {label}
            </span>
          );
        })()}
        <div style={{ flex: 1 }} />
        <TimeDisplay />
        <button onClick={onOpenSettings} style={{
          background: "transparent", color: "var(--qb-text-mid)",
          border: "1px solid var(--qb-border)", borderRadius: 4,
          padding: "4px 8px", fontSize: 13, cursor: "pointer",
        }} title="Settings">⚙</button>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <MobileStat label="Equity" value={fmtUSD(equity)} />
        <MobileStat label="Float"  value={fmtUSD(floatingPnL, true)} color={floatColor} />
        <MobileStat label="Today"  value={fmtUSD(dailyPnL, true)} color={dailyColor} />
        <MobileStat label="Open"   value={openCount} />
      </div>

      {estopActive ? (
        <button onClick={onClearEstop} className="qb-mono qb-pulse" style={{
          width: "100%", background: "var(--qb-bad)", color: "white",
          border: "1px solid var(--qb-bad)", borderRadius: 6,
          padding: "12px 0", fontSize: 13, fontWeight: 700, letterSpacing: 1,
          cursor: "pointer", textTransform: "uppercase",
        }}>⛔ E-STOP ACTIVE — TAP TO CLEAR</button>
      ) : (
        <button onClick={onOpenEstop} className="qb-mono" style={{
          width: "100%", background: "var(--qb-bad-soft)", color: "var(--qb-bad)",
          border: "1px solid var(--qb-bad)", borderRadius: 6,
          padding: "11px 0", fontSize: 13, fontWeight: 700, letterSpacing: 1,
          cursor: "pointer", textTransform: "uppercase",
        }}>⛔ EMERGENCY STOP</button>
      )}
    </div>
  );
}

function MobileStat({ label, value, color }) {
  return (
    <div className="qb-cell" style={{ flex: 1, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span style={{ fontSize: 8, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
      <span className="qb-mono" style={{ fontSize: 13, color: color || "var(--qb-text-hi)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</span>
    </div>
  );
}

function MobileModes({ activeMode, tradingMode, onSetActiveMode, onSetTradingMode, disabled }) {
  const pill = (active, c) => ({
    flex: "1 1 40%", minWidth: 0,
    background: active ? c.soft : "transparent",
    color: active ? c.fg : "var(--qb-text-mid)",
    border: `1px solid ${active ? c.fg : "var(--qb-border)"}`,
    borderRadius: 6, padding: "11px 8px",
    fontSize: 11, fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
    textTransform: "uppercase", letterSpacing: 0.4,
  });
  const cur = ACTIVE_MODES.find((m) => m.id === activeMode);

  return (
    <div className="qb-panel" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
      <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>Setup mode</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {ACTIVE_MODES.map((m) => (
          <button key={m.id} disabled={disabled} title={m.hint}
            onClick={() => !disabled && onSetActiveMode(m.id)} className="qb-mono"
            style={pill(m.id === activeMode, { soft: "var(--qb-accent-soft)", fg: "var(--qb-accent)" })}>
            <span style={{ fontSize: 14 }}>{m.glyph}</span>{m.label}
          </button>
        ))}
      </div>

      <span style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5 }}>Execution</span>
      <div style={{ display: "flex", gap: 6 }}>
        {TRADING_MODES.map((m) => {
          const on = m.id === tradingMode;
          const c = m.id === "auto"
            ? { soft: "var(--qb-ok-soft)", fg: "var(--qb-ok)" }
            : { soft: "var(--qb-warn-soft)", fg: "var(--qb-warn)" };
          return (
            <button key={m.id} disabled={disabled} title={m.hint}
              onClick={() => !disabled && onSetTradingMode(m.id)} className="qb-mono" style={pill(on, c)}>
              <span style={{ fontSize: 14 }}>{m.glyph}</span>{m.label}
            </button>
          );
        })}
      </div>

      {cur && (
        <span style={{ fontSize: 10, color: "var(--qb-text-lo)", fontStyle: "italic" }}>{cur.hint}</span>
      )}
    </div>
  );
}

function MobileActivity({ activity }) {
  return (
    <Panel title="Activity" subtitle="server log">
      <div style={{ padding: 10, height: "100%", overflowY: "auto" }}>
        {(!activity || activity.length === 0) ? (
          <Placeholder msg="No recent activity yet. Rule changes and trade events appear here." />
        ) : (
          activity.map((a, i) => <ActivityRow key={i} entry={a} />)
        )}
      </div>
    </Panel>
  );
}

// =====================================================================
// ANALYST SIDEBAR  v15.7
// =====================================================================
// Fixed right panel — backdrop-filter blur, 380px desktop / full-width mobile.
// Toggle button always visible bottom-right. Slide transition.
// GET /api/analyst serves the cached brief. Refresh button forces ?refresh=1.
// Entirely read-only — no write paths, no rule mutations.

const ANALYST_SECTIONS = ["health", "anomalies", "keepers", "bleeders", "collecting", "recommendations"];

const HEALTH_COLORS = {
  "healthy":     { fg: "var(--qb-ok)",   bg: "var(--qb-ok-soft)",   label: "HEALTHY" },
  "broken-write":{ fg: "var(--qb-bad)",  bg: "var(--qb-bad-soft)",  label: "BROKEN" },
  "broken-join": { fg: "var(--qb-warn)", bg: "var(--qb-warn-soft)", label: "JOIN BROKEN" },
  "no-evaluator":{ fg: "var(--qb-bad)",  bg: "var(--qb-bad-soft)",  label: "NO EVALUATOR" },
  "stale":       { fg: "var(--qb-warn)", bg: "var(--qb-warn-soft)", label: "STALE" },
};

const SEVERITY_COLORS = {
  warn: { fg: "var(--qb-warn)", bg: "var(--qb-warn-soft)" },
  info: { fg: "var(--qb-text-mid)", bg: "var(--qb-bg-panel-hi)" },
};

function AnalystSidebar() {
  const [open, setOpen]     = useState(false);
  const [brief, setBrief]   = useState(null);
  const [loading, setLoad]  = useState(false);
  const [err, setErr]       = useState(null);
  const [section, setSection] = useState("health");

  const load = useCallback(async (force = false) => {
    setLoad(true);
    setErr(null);
    try {
      const url = force ? "/api/analyst?refresh=1" : "/api/analyst";
      const res = await fetch(url).then(r => r.json());
      if (res.ok) setBrief(res);
      else setErr(res.error || "endpoint error");
    } catch (e) {
      setErr(e.message || "fetch failed");
    } finally {
      setLoad(false);
    }
  }, []);

  // Load on first open; don't auto-refresh on subsequent opens (use cache)
  const hasLoaded = useRef(false);
  useEffect(() => {
    if (open && !hasLoaded.current) {
      hasLoaded.current = true;
      load(false);
    }
  }, [open, load]);

  const unhealthyCount = brief
    ? Object.values(brief.shadowHealth || {}).filter(h => h.statusCode !== "healthy").length
    : 0;
  const anomalyCount = brief?.anomalies?.length || 0;

  return (
    <>
      {/* Toggle button — always visible */}
      <button
        onClick={() => setOpen(v => !v)}
        title="Analyst Sidebar"
        style={{
          position: "fixed", bottom: 22, right: open ? 396 : 16,
          zIndex: 1001, width: 42, height: 42,
          borderRadius: "50%",
          background: open ? "var(--qb-accent)" : "var(--qb-bg-panel)",
          border: `1px solid ${open ? "var(--qb-accent)" : "var(--qb-border-hi)"}`,
          color: open ? "#06070a" : "var(--qb-text-mid)",
          fontSize: 18, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          transition: "right 280ms cubic-bezier(.4,0,.2,1), background 180ms, border-color 180ms",
        }}
      >
        {open ? "×" : "⚡"}
        {/* Badge for broken health or anomalies */}
        {!open && (unhealthyCount + anomalyCount) > 0 && (
          <span style={{
            position: "absolute", top: -4, right: -4,
            width: 16, height: 16, borderRadius: "50%",
            background: "var(--qb-bad)", border: "2px solid var(--qb-bg-void)",
            fontSize: 9, color: "white", fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {Math.min(9, unhealthyCount + anomalyCount)}
          </span>
        )}
      </button>

      {/* Sidebar panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: 380,
        zIndex: 1000,
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: "transform 280ms cubic-bezier(.4,0,.2,1)",
        display: "flex", flexDirection: "column",
        background: "rgba(6,7,10,0.94)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderLeft: "1px solid var(--qb-border-hi)",
        boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
      }}>
        {/* Header */}
        <div style={{
          padding: "14px 16px 10px",
          borderBottom: "1px solid var(--qb-border)",
          flexShrink: 0,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span className="qb-serif" style={{ fontSize: 15, color: "var(--qb-text-hi)" }}>
            Analyst
          </span>
          <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-faint)", letterSpacing: 1, textTransform: "uppercase" }}>
            read-only
          </span>
          {brief?._fromCache && (
            <span className="qb-mono" style={{ fontSize: 8, color: "var(--qb-text-lo)", marginLeft: "auto" }}>
              cached · {brief.generatedAt ? Math.round((Date.now() - brief.generatedAt) / 60000) + "m ago" : ""}
            </span>
          )}
        </div>

        {/* Section tabs */}
        <div style={{
          display: "flex", gap: 0,
          borderBottom: "1px solid var(--qb-border)",
          overflowX: "auto", flexShrink: 0,
        }}>
          {ANALYST_SECTIONS.map(s => {
            const badge =
              s === "health"          ? (unhealthyCount > 0 ? unhealthyCount : null) :
              s === "anomalies"       ? (anomalyCount > 0 ? anomalyCount : null) :
              s === "keepers"         ? (brief?.perf?.keepers?.length || null) :
              s === "bleeders"        ? (brief?.perf?.bleeders?.length || null) :
              s === "recommendations" ? (brief?.recommendations?.length || null) :
              null;
            return (
              <button key={s} onClick={() => setSection(s)} className="qb-mono" style={{
                flex: "1 1 0", minWidth: 50,
                padding: "7px 6px", fontSize: 9, letterSpacing: 0.5,
                textTransform: "uppercase",
                background: "transparent",
                border: "none",
                borderBottom: section === s ? "2px solid var(--qb-accent)" : "2px solid transparent",
                color: section === s ? "var(--qb-accent)" : "var(--qb-text-faint)",
                cursor: "pointer",
                position: "relative",
              }}>
                {s}
                {badge != null && (
                  <span style={{
                    position: "absolute", top: 3, right: 3,
                    width: 12, height: 12, borderRadius: "50%",
                    background: s === "bleeders" || s === "anomalies" ? "var(--qb-bad)" : "var(--qb-accent)",
                    fontSize: 7, color: "#06070a", fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          {loading && <AnalystLoading />}
          {!loading && err && <AnalystError msg={err} onRetry={() => load(false)} />}
          {!loading && !err && !brief && (
            <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "var(--qb-text-lo)" }}>
              No data yet.
            </div>
          )}
          {!loading && !err && brief && (
            <>
              {section === "health"          && <AnalystHealthSection  health={brief.shadowHealth} sources={brief.sources} />}
              {section === "anomalies"       && <AnalystAnomaliesSection anomalies={brief.anomalies} />}
              {section === "keepers"         && <AnalystKeepersBleeder items={brief.perf?.keepers || []} kind="keeper" />}
              {section === "bleeders"        && <AnalystKeepersBleeder items={brief.perf?.bleeders || []} kind="bleeder" />}
              {section === "collecting"      && <AnalystCollecting items={brief.perf?.collecting || []} />}
              {section === "recommendations" && <AnalystRecommendations recs={brief.recommendations || []} />}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          flexShrink: 0,
          padding: "8px 12px",
          borderTop: "1px solid var(--qb-border)",
          display: "flex", alignItems: "center", gap: 10,
          background: "rgba(6,7,10,0.6)",
        }}>
          <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-lo)", flex: 1 }}>
            {brief?.generatedAt
              ? `Generated ${new Date(brief.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} UTC`
              : "—"}
          </span>
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="qb-mono"
            style={{
              background: "transparent",
              border: "1px solid var(--qb-border)",
              borderRadius: 3,
              color: loading ? "var(--qb-text-lo)" : "var(--qb-text-mid)",
              fontSize: 10, padding: "4px 10px",
              cursor: loading ? "not-allowed" : "pointer",
              letterSpacing: 0.5, textTransform: "uppercase",
            }}
          >
            {loading ? "loading…" : "↺ refresh"}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Analyst sub-sections ──────────────────────────────────────────────────────

function AnalystLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
      {[1, 2, 3].map(i => (
        <div key={i} className="qb-pulse" style={{
          height: 52, borderRadius: 4,
          background: "var(--qb-bg-panel-hi)",
          border: "1px solid var(--qb-border)",
        }} />
      ))}
    </div>
  );
}

function AnalystError({ msg, onRetry }) {
  return (
    <div style={{
      padding: "12px 14px", borderRadius: 4,
      background: "var(--qb-bad-soft)", border: "1px solid var(--qb-bad)",
      fontSize: 11, color: "var(--qb-bad)",
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <span className="qb-mono">▲ {msg}</span>
      <button onClick={onRetry} className="qb-mono" style={{
        alignSelf: "flex-start", background: "transparent",
        border: "1px solid var(--qb-bad)", color: "var(--qb-bad)",
        borderRadius: 3, padding: "4px 10px", fontSize: 10,
        cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5,
      }}>retry</button>
    </div>
  );
}

function AnalystHealthSection({ health, sources }) {
  const entries = Object.entries(health || {});
  if (!entries.length) return <Placeholder msg="No health data." />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <AnalystLabel>SHADOW SYSTEMS</AnalystLabel>
      {entries.map(([sysName, h]) => {
        const cfg = HEALTH_COLORS[h.statusCode] || HEALTH_COLORS["healthy"];
        return (
          <div key={sysName} className="qb-cell" style={{ padding: "9px 11px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{
                fontSize: 8, fontWeight: 700, letterSpacing: 0.8, padding: "1px 5px",
                borderRadius: 2, background: cfg.bg, color: cfg.fg, fontFamily: "var(--qb-font-mono)",
                textTransform: "uppercase", flexShrink: 0,
              }}>{cfg.label}</span>
              <span style={{ fontSize: 11, color: "var(--qb-text-hi)", fontWeight: 500, flex: 1, minWidth: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.label}
              </span>
            </div>
            <div className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-lo)", lineHeight: 1.6 }}>
              written {h.written} · joined {h.joined} · resolved {h.resolved}
              {h.ageHours != null && ` · last signal ${h.ageHours}h ago`}
            </div>
            {h.statusCode !== "healthy" && (
              <div className="qb-mono" style={{ fontSize: 9, color: cfg.fg, marginTop: 3, lineHeight: 1.4 }}>
                {h.status}
              </div>
            )}
            {h.neededForVerdict != null && h.neededForVerdict > 0 && (
              <div className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-faint)", marginTop: 2 }}>
                {h.neededForVerdict} more resolved records to first n=8 verdict (largest bucket: {h.maxBucketN})
              </div>
            )}
            {h.neededForVerdict === 0 && (
              <div className="qb-mono" style={{ fontSize: 9, color: "var(--qb-ok)", marginTop: 2 }}>
                ● n≥8 reached — verdicts available
              </div>
            )}
          </div>
        );
      })}

      <AnalystLabel style={{ marginTop: 6 }}>DATA SOURCES</AnalystLabel>
      {Object.entries(sources || {}).map(([src, s]) => (
        <div key={src} className="qb-mono" style={{
          fontSize: 9, display: "flex", justifyContent: "space-between",
          padding: "3px 0", borderBottom: "1px solid var(--qb-border)",
          color: s.available ? "var(--qb-text-mid)" : "var(--qb-warn)",
        }}>
          <span>{src}</span>
          <span>{s.available ? "ok" : `unavailable: ${s.error || "?"}`}</span>
        </div>
      ))}
    </div>
  );
}

function AnalystAnomaliesSection({ anomalies }) {
  if (!anomalies?.length) {
    return (
      <div style={{ padding: "18px 0", textAlign: "center" }}>
        <span style={{ fontSize: 22 }}>✓</span>
        <div style={{ fontSize: 11, color: "var(--qb-ok)", marginTop: 6 }}>No anomalies detected.</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <AnalystLabel>{anomalies.length} ANOMAL{anomalies.length === 1 ? "Y" : "IES"}</AnalystLabel>
      {anomalies.map((a, i) => {
        const cfg = SEVERITY_COLORS[a.severity] || SEVERITY_COLORS.info;
        return (
          <div key={i} style={{
            padding: "8px 10px", borderRadius: 4,
            background: cfg.bg, border: `1px solid ${cfg.fg}22`,
          }}>
            <div className="qb-mono" style={{
              fontSize: 9, fontWeight: 700, color: cfg.fg,
              textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3,
            }}>
              [{a.severity?.toUpperCase() || "INFO"}] {a.code}
            </div>
            <div style={{ fontSize: 10, color: "var(--qb-text-hi)", lineHeight: 1.5 }}>
              {a.message}
            </div>
            {a.tradeIds?.length > 0 && (
              <div className="qb-mono" style={{ fontSize: 8, color: "var(--qb-text-lo)", marginTop: 4 }}>
                {a.tradeIds.join(", ")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AnalystKeepersBleeder({ items, kind }) {
  if (!items?.length) {
    return <Placeholder msg={`No ${kind}s above n=8 threshold.`} />;
  }
  const isKeeper  = kind === "keeper";
  const accentFg  = isKeeper ? "var(--qb-ok)"  : "var(--qb-bad)";
  const accentBg  = isKeeper ? "var(--qb-ok-soft)" : "var(--qb-bad-soft)";
  const label     = isKeeper ? "KEEPERS" : "BLEEDERS";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <AnalystLabel>{label} (n≥{8})</AnalystLabel>
      {items.map((item, i) => {
        const belowBE = item.wrVsBE != null && item.wrVsBE < 0;
        return (
          <div key={i} className="qb-cell" style={{ padding: "9px 11px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: "var(--qb-text-hi)", fontWeight: 600 }}>
                {item.template}
              </span>
              {item.tier && (
                <span className="qb-mono" style={{ fontSize: 8, color: "var(--qb-text-faint)" }}>
                  tier {item.tier}
                </span>
              )}
              {item.session && (
                <span className="qb-mono" style={{ fontSize: 8, color: "var(--qb-text-faint)" }}>
                  {item.session}
                </span>
              )}
              <span className="qb-mono" style={{ fontSize: 9, marginLeft: "auto", color: "var(--qb-text-lo)" }}>
                n={item.n}
              </span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <AnalystStat label="WR" value={fmtPct((item.winRate || 0) * 100, 1, false)} color={accentFg} />
              {item.breakEvenWR != null && (
                <AnalystStat label="BE" value={fmtPct(item.breakEvenWR * 100, 1, false)} color="var(--qb-text-lo)" />
              )}
              <AnalystStat label="net" value={fmtUSD(item.netPnl, true)} color={item.netPnl >= 0 ? "var(--qb-ok)" : "var(--qb-bad)"} />
              {item.avgR != null && (
                <AnalystStat label="avgR" value={(item.avgR >= 0 ? "+" : "") + item.avgR.toFixed(2)} color={item.avgR >= 0 ? "var(--qb-ok)" : "var(--qb-bad)"} />
              )}
            </div>
            {belowBE && !isKeeper && (
              <div className="qb-mono" style={{ fontSize: 8, color: "var(--qb-bad)", marginTop: 4 }}>
                WR below break-even by {fmtPct(Math.abs(item.wrVsBE) * 100, 1, false)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AnalystCollecting({ items }) {
  if (!items?.length) return <Placeholder msg="No collecting buckets." />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <AnalystLabel>COLLECTING (n&lt;8 — not ranked)</AnalystLabel>
      <div className="qb-mono" style={{
        fontSize: 9, color: "var(--qb-text-lo)", marginBottom: 4, lineHeight: 1.4,
      }}>
        Data accumulating. Figures shown for reference only — not actionable until n≥8.
      </div>
      {items.map((item, i) => (
        <div key={i} className="qb-cell" style={{ padding: "8px 10px", opacity: 0.6 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 3 }}>
            <span style={{ fontSize: 10, color: "var(--qb-text-mid)" }}>
              {item.template}
              {item.tier ? ` ×${item.tier}` : ""}
              {item.session ? ` ×${item.session}` : ""}
            </span>
            <span className="qb-mono" style={{ fontSize: 8, color: "var(--qb-text-faint)", marginLeft: "auto" }}>
              n={item.n} — need {Math.max(0, 8 - item.n)} more
            </span>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <AnalystStat label="WR" value={fmtPct((item.winRate || 0) * 100, 1, false)} color="var(--qb-text-lo)" />
            <AnalystStat label="net" value={fmtUSD(item.netPnl, true)} color="var(--qb-text-lo)" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AnalystRecommendations({ recs }) {
  if (!recs?.length) return <Placeholder msg="No recommendations." />;
  const typeColor = {
    bleeder:       "var(--qb-bad)",
    keeper:        "var(--qb-ok)",
    "shadow-health": "var(--qb-warn)",
    "dead-template": "var(--qb-warn)",
    "fires-no-trades": "var(--qb-warn)",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <AnalystLabel>{recs.length} RECOMMENDATION{recs.length !== 1 ? "S" : ""}</AnalystLabel>
      {recs.map((rec, i) => {
        const c = typeColor[rec.type] || "var(--qb-text-mid)";
        return (
          <div key={i} style={{
            padding: "9px 11px", borderRadius: 4,
            background: "var(--qb-bg-panel-hi)",
            border: "1px solid var(--qb-border)",
            borderLeft: `3px solid ${c}`,
          }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 5 }}>
              <span className="qb-mono" style={{
                fontSize: 8, fontWeight: 700, letterSpacing: 0.8, padding: "1px 5px",
                borderRadius: 2, color: "#06070a",
                background: rec.tag === "CONFIRMED" ? c : "var(--qb-text-lo)",
                textTransform: "uppercase", flexShrink: 0,
              }}>{rec.tag}</span>
              <span className="qb-mono" style={{
                fontSize: 8, color: c, textTransform: "uppercase", letterSpacing: 0.6,
              }}>{rec.type}</span>
            </div>
            <div style={{ fontSize: 10, color: "var(--qb-text-hi)", lineHeight: 1.55 }}>
              {rec.message}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Micro helpers ─────────────────────────────────────────────────────────────

function AnalystLabel({ children, style }) {
  return (
    <div className="qb-mono" style={{
      fontSize: 8, letterSpacing: 1.2, textTransform: "uppercase",
      color: "var(--qb-text-faint)", paddingBottom: 3,
      borderBottom: "1px solid var(--qb-border)",
      ...(style || {}),
    }}>
      {children}
    </div>
  );
}

function AnalystStat({ label, value, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <span style={{ fontSize: 7, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: "var(--qb-font-mono)" }}>
        {label}
      </span>
      <span className="qb-mono" style={{ fontSize: 11, color: color || "var(--qb-text-mid)", fontWeight: 500 }}>
        {value}
      </span>
    </div>
  );
}