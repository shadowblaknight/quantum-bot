/* eslint-disable */
// =====================================================================
// QUANTUM BOT V13 — PILOT DASHBOARD (final)
// =====================================================================
// Aligned to rules-store.js v1.2 shape. Backend endpoints used:
//   /api/broker               — account, positions
//   /api/rules                — read/write all dashboard rules
//   /api/rules?action=activity — server-side activity log
//   /api/rules?action=daily-pnl — today's realized P&L
//   /api/template-performance — closed-trade stats
//   /api/watched-setups       — manual-mode active watches
//   /api/symbol-resolver      — broker symbol mapping
//
// TWO-AXIS MODE MODEL:
//   activeMode:   sleep | active | defensive | vacation  (what setups are allowed)
//   tradingMode:  auto | manual                          (does bot execute, or alert only?)
// =====================================================================

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

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
};

const TEMPLATE_ORDER = [
  "silver-bullet", "unicorn", "turtle-soup", "judas-swing", "ote-continuation", "am-ifvg",
];

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
  html, body, #root { margin:0; padding:0; height:100%; background: var(--qb-bg-void); color: var(--qb-text-hi); font-family: var(--qb-font-sans); -webkit-font-smoothing: antialiased; }
  body { overflow: hidden; }
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

  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  return <PilotDashboard prefs={prefs} setPrefs={setPrefs} theme={theme} setTheme={setTheme} />;
}

// =====================================================================
// 7 · PILOT DASHBOARD
// =====================================================================

function PilotDashboard({ prefs, setPrefs, theme, setTheme }) {

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
        const r = await fetch(API("rules?action=daily-pnl")).then((res) => res.json());
        if (alive && r?.pnl != null) setDailyPnL(r.pnl);
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

  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: "var(--qb-bg-void)",
      display: "grid",
      gridTemplateRows: "auto auto 1fr auto",
      overflow: "hidden",
    }}>

      <DashboardHeader
        equity={equity} balance={balance}
        floatingPnL={floatingPnL} dailyPnL={dailyPnL}
        positions={positions}
        rulesError={rulesError}
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
        gridTemplateRows: "minmax(240px, auto) minmax(240px, 1fr)",
        gap: 10, overflow: "hidden",
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
    </div>
  );
}

// =====================================================================
// 8 · HEADER
// =====================================================================

function DashboardHeader({
  equity, balance, floatingPnL, dailyPnL, positions,
  rulesError, estopActive, onOpenEstop, onClearEstop, onOpenSettings,
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

      <div style={{ width: 1, height: 22, background: "var(--qb-border)" }} />

      <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
        <HeaderStat label="Equity"   value={fmtUSD(equity)} mono />
        <HeaderStat label="Balance"  value={fmtUSD(balance)} mono />
        <HeaderStat label="Float"    value={fmtUSD(floatingPnL, true)} mono accent={floatColor} />
        <HeaderStat label="Today"    value={fmtUSD(dailyPnL, true)} mono accent={dailyColor} />
        <HeaderStat label="Open"     value={openCount} mono />
      </div>

      <div style={{ flex: 1 }} />

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
        <span style={{ color: pos.type === 0 ? "var(--qb-ok)" : "var(--qb-bad)", marginLeft: 6, fontSize: 10 }}>
          {pos.type === 0 ? "BUY" : "SELL"}
        </span>
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
  const lotMode    = rule.lotMode || "risk-based";
  const slMode     = rule.slMode || "pine";
  const tpMode     = rule.tpMode || "pine-three";

  const slLabel = slMode === "pine" ? "Pine SL" : slMode === "fixed-pips" ? `${rule.fixedSLPips || "?"}p` : `$${rule.fixedSLDollars || "?"}`;
  const lotLabel = lotMode === "fixed" ? `${(rule.fixedLot || 0).toFixed(2)} fixed` : `risk-based ≤${(rule.maxLot || 0).toFixed(2)}`;

  return (
    <div className="qb-cell" style={{ opacity: enabled ? 1 : 0.5 }}>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          padding: "8px 10px",
          display: "grid",
          gridTemplateColumns: "20px 70px 1fr 70px 50px 20px",
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
        <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-lo)", textAlign: "right" }}>{tpMode}</span>
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
          {/* LOT MODE */}
          <ConfigGroup label="Lot mode">
            <SegmentControl
              options={[{id: "risk-based", label: "Risk-based"}, {id: "fixed", label: "Fixed lot"}]}
              value={lotMode}
              onChange={(v) => onChange({ lotMode: v })}
            />
          </ConfigGroup>

          {lotMode === "fixed" && (
            <SmallNumberField
              label="Fixed lot"
              value={rule.fixedLot || 0.01}
              step="0.01"
              onChange={(v) => onChange({ fixedLot: v })}
            />
          )}
          <SmallNumberField
            label="Max lot"
            value={rule.maxLot || 1}
            step="0.01"
            onChange={(v) => onChange({ maxLot: v })}
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
              onChange={(v) => onChange({ slMode: v })}
            />
          </ConfigGroup>
          {slMode === "fixed-pips" && (
            <SmallNumberField
              label="SL (pips)"
              value={rule.fixedSLPips || 15}
              step="1"
              onChange={(v) => onChange({ fixedSLPips: v })}
            />
          )}
          {slMode === "fixed-dollars" && (
            <SmallNumberField
              label="SL ($/lot)"
              value={rule.fixedSLDollars || 25}
              step="1"
              onChange={(v) => onChange({ fixedSLDollars: v })}
            />
          )}

          {/* TP MODE */}
          <ConfigGroup label="TP mode">
            <SegmentControl
              options={[
                {id: "pine-three", label: "Pine TPs"},
                {id: "trail-only", label: "Trail only"},
              ]}
              value={tpMode}
              onChange={(v) => onChange({ tpMode: v })}
            />
          </ConfigGroup>

          {/* MIN RR */}
          <SmallNumberField
            label="Min RR"
            value={rule.minRR || 1.0}
            step="0.1"
            onChange={(v) => onChange({ minRR: v })}
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
// 16 · ACTIVITY FEED
// =====================================================================

function ActivityFeed({ activity }) {
  return (
    <div style={{
      borderTop: "1px solid var(--qb-border)",
      padding: "8px 18px",
      background: "var(--qb-bg-void)",
      maxHeight: 110,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4 }}>
        Activity feed · server log
      </div>
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

function Panel({ title, subtitle, children }) {
  return (
    <div className="qb-panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <div style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--qb-border)",
        display: "flex", alignItems: "baseline", gap: 12,
      }}>
        <span className="qb-serif" style={{ fontSize: 14, color: "var(--qb-text-hi)", letterSpacing: 0.2 }}>
          {title}
        </span>
        {subtitle && (
          <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-faint)", textTransform: "uppercase", letterSpacing: 1 }}>
            {subtitle}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
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
      <div>Quantum Bot · v13 Pilot Dashboard</div>
      <div>Algorithmic SMC trading · Pine v2.1 (6 templates incl. AM IFVG)</div>
      <div style={{ marginTop: 8, color: "var(--qb-text-lo)" }}>
        Backend endpoints:<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/rules</span> — pilot rules R/W<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/template-performance</span> — closed-trade stats<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/watched-setups</span> — manual-mode watches<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/broker</span> — account + positions<br/>
        · <span style={{ color: "var(--qb-text-mid)" }}>/api/pivots</span> — H1 pivots (optional)
      </div>
    </div>
  );
}