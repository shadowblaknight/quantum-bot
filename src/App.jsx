/* eslint-disable */
// =====================================================================
// QUANTUM BOT V12 — FRONTEND
// =====================================================================
// Crystal black cockpit. Asset-aware throughout. No Claude in the runtime.
//
// Single-file React app following the same convention as V11.
//
// PAGES:
//   /          — Cockpit (chart-first trading workstation)
//   /portfolio — Equity curve + per-instrument overview
//   /reports   — Performance + Recognition + Activity log
//   /settings  — Theme + Tools & Display + Account + Instruments
//
// The backend V12 endpoints come online progressively across sessions 1-4.
// In session 2 (this file), some panels will show "no data yet" — that's
// expected. The visual shell is complete; the data plumbing fills in.
// =====================================================================

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createChart, CrosshairMode, ColorType } from "lightweight-charts";

// =====================================================================
// SECTION 1: CONSTANTS, ENDPOINTS, STORAGE KEYS
// =====================================================================

const API = (path) => `/api/${path}`;
const PREFS_KEY = "qb_v12_prefs";
const THEME_KEY = "qb_v12_theme";

// Trading sessions — used for context labeling
const SESSION_LABELS = ["ASIAN", "LONDON", "OVERLAP", "NEW_YORK"];

// =====================================================================
// SECTION 2: THEME SYSTEM
// =====================================================================
// Crystal black + cyan accent default. User can override every color in
// Settings → Theme. Stored in localStorage + synced to Redis (later).
// =====================================================================

const DEFAULT_THEME = {
  // Backgrounds (crystal black with subtle blue-violet undertone)
  bgBase:       "#0a0b0f",
  bgLayer:      "#0e1014",
  bgGlass:      "rgba(15,17,22,0.5)",  // for transparent overlays

  // Borders
  border:       "rgba(255,255,255,0.06)",
  borderActive: "rgba(0,217,255,0.4)",

  // Text
  textPrimary:  "#e8e8ed",
  textMuted:    "#7a7a85",
  textDim:      "#4a4a55",

  // Accent (the "alive" color)
  accent:       "#00d9ff",     // cyan glow
  accentSoft:   "rgba(0,217,255,0.15)",

  // Direction colors (TradingView-style)
  upStrong:     "#00e676",     // bright green for candles, P&L positive
  downStrong:   "#ff3b5c",     // bright red for candles, P&L negative
  upSoft:       "rgba(0,230,118,0.15)",
  downSoft:     "rgba(255,59,92,0.15)",

  // News indicator
  newsScheduled: "#ffd166",    // yellow — news today
  newsImminent:  "#ff9a3c",    // amber — within 30 min
  newsLive:      "#ff2050",    // red — happening now (pulses)

  // Tactic overlay colors
  obBullish:    "rgba(0,230,118,0.10)",
  obBearish:    "rgba(255,59,92,0.10)",
  fvgBullish:   "rgba(0,230,118,0.08)",
  fvgBearish:   "rgba(255,59,92,0.08)",
  asianLevel:   "#a78bfa",     // violet
  londonLevel:  "#22d3ee",     // cyan
  nyLevel:      "#f59e0b",     // amber
  pdhPdl:       "#fb923c",     // orange
  swingLevel:   "#94a3b8",     // slate
  weeklyOpen:   "#f59e0b",     // amber
  roundLevel:   "#64748b",     // muted

  // Position lines
  posEntry:     "#fbbf24",     // gold yellow
  posSL:        "#dc2626",     // red
  posTPpending: "#22c55e",     // green dashed (pending TP)
  posTPhit:     "#10b981",     // green solid (hit TP)

  // Chart grid
  gridIntensity: 0.05,         // 5% white

  // Fonts
  fontMono:     "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  fontSans:     "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_THEME, ...parsed };
    }
  } catch (_) {}
  return DEFAULT_THEME;
}

function saveTheme(theme) {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)); } catch (_) {}
}

// Apply theme as CSS variables on root (so anywhere can use them)
function applyThemeToRoot(theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme)) {
    if (typeof v === "string" || typeof v === "number") {
      root.style.setProperty("--qb-" + camelToKebab(k), String(v));
    }
  }
}

function camelToKebab(s) {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

// =====================================================================
// SECTION 3: PREFERENCES / SETTINGS PERSISTENCE
// =====================================================================

const DEFAULT_PREFS = {
  selectedAsset:    "gold",
  selectedTF:       "1h",
  watchlist:        ["gold", "btc", "eurusd"],   // asset IDs
  perInstrumentLot: { gold: 0.05, btc: 0.01, eurusd: 0.05 },
  pauseOnAsset:     {},                          // { gold: false, btc: false, ... }
  pauseSettings: {
    suggestStopAfterDailyLoss: 200,    // dollars
    suggestStopAfterDailyGain: 500,
    suggestStopAfterLossStreak: 3,
  },
  toolsConfig: {
    // tactic: [showOnChart, useInAnalysis] — keys MATCH backend op.tactic exactly
    orderBlock:        [true, true],
    fvg:               [true, true],
    bos:               [true, true],
    trendStructure:    [true, true],
    liquiditySweep:    [true, true],
    sessionLevel:      [true, true],     // singular — matches backend
    unfilledImbalance: [true, true],
    fakeout:           [true, true],
    roundNumber:       [false, true],    // singular — matches backend; off by default on chart
    fibonacci:         [false, false],
    ema21:             [false, false],
    ema50:             [false, false],
    ema200:            [false, false],
    vwap:              [false, false],
    bollinger:         [false, false],
    rsi:               [false, false],
  },
  sideBarOpen:      false,
  bottomBarOpen:    true,
  tutorialMode:     true,    // verbose tooltips for new users
};

function loadPrefs() {
  try {
    const saved = localStorage.getItem(PREFS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        ...DEFAULT_PREFS,
        ...parsed,
        perInstrumentLot: { ...DEFAULT_PREFS.perInstrumentLot, ...(parsed.perInstrumentLot || {}) },
        pauseSettings: { ...DEFAULT_PREFS.pauseSettings, ...(parsed.pauseSettings || {}) },
        toolsConfig: { ...DEFAULT_PREFS.toolsConfig, ...(parsed.toolsConfig || {}) },
      };
    }
  } catch (_) {}
  return DEFAULT_PREFS;
}

function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}

// =====================================================================
// SECTION 4: FORMATTERS / HELPERS
// =====================================================================

function fmtMoney(v) {
  if (v == null || !isFinite(v)) return "--";
  const sign = v >= 0 ? "+" : "-";
  const abs = Math.abs(v);
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtMoneyPlain(v) {
  if (v == null || !isFinite(v)) return "--";
  return `$${v.toFixed(2)}`;
}

function fmtPrice(p) {
  if (p == null || !isFinite(p)) return "--";
  const abs = Math.abs(p);
  if (abs >= 10000) return p.toFixed(2);
  if (abs >= 100) return p.toFixed(2);
  if (abs >= 10) return p.toFixed(3);
  if (abs >= 1) return p.toFixed(4);
  return p.toFixed(5);
}

function fmtPercent(p, digits = 2) {
  if (p == null || !isFinite(p)) return "--";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${(p * 100).toFixed(digits)}%`;
}

function fmtTime(d) {
  return new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function fmtTimeS(d) {
  return new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtRelTime(ts) {
  const diffMs = Date.now() - ts;
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  return d + "d";
}

// =====================================================================
// SECTION 5: GLOBAL STYLES (injected once, uses theme variables)
// =====================================================================

const GLOBAL_STYLES = `
  * { box-sizing: border-box; }
  html, body, #root { margin: 0; padding: 0; height: 100%; background: var(--qb-bg-base); color: var(--qb-text-primary); font-family: var(--qb-font-sans); -webkit-font-smoothing: antialiased; }
  body { overflow: hidden; }

  /* Glass surface — used everywhere for overlays */
  .qb-glass {
    background: var(--qb-bg-glass);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
    border: 1px solid var(--qb-border);
  }

  /* Mono numbers */
  .qb-mono { font-family: var(--qb-font-mono); font-variant-numeric: tabular-nums; }

  /* Pulse animation for live indicators */
  @keyframes qbPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .qb-pulse { animation: qbPulse 2s ease-in-out infinite; }

  /* Smooth glow */
  @keyframes qbGlow {
    0%, 100% { box-shadow: 0 0 8px var(--qb-accent-soft), 0 0 16px var(--qb-accent-soft); }
    50% { box-shadow: 0 0 12px var(--qb-accent-soft), 0 0 24px var(--qb-accent-soft); }
  }
  .qb-glow { animation: qbGlow 3s ease-in-out infinite; }

  /* Hover lift */
  .qb-hover:hover { transform: translateY(-1px); transition: transform 200ms; }

  /* Custom scrollbar */
  *::-webkit-scrollbar { width: 6px; height: 6px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
  *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

  /* Inputs */
  input, button, select { font-family: inherit; color: inherit; }
  input:focus, button:focus, select:focus { outline: none; }

  /* Chart container — let lightweight-charts fill its parent */
  .qb-chart-container { position: relative; width: 100%; height: 100%; }
`;

// =====================================================================
// SECTION 6: ASSET REGISTRY (mirrored frontend-side for the modal)
// =====================================================================
// This duplicates a subset of the backend asset-registry. The backend is
// authoritative; this is just for the Add Instrument modal UI when the
// backend hasn't loaded yet.
// =====================================================================

const ASSET_CATALOG = [
  // Forex majors
  { id: "eurusd", name: "EUR/USD", category: "forex", description: "Euro vs US Dollar" },
  { id: "gbpusd", name: "GBP/USD", category: "forex", description: "British Pound vs US Dollar" },
  { id: "usdjpy", name: "USD/JPY", category: "forex", description: "US Dollar vs Japanese Yen" },
  { id: "usdchf", name: "USD/CHF", category: "forex", description: "US Dollar vs Swiss Franc" },
  { id: "audusd", name: "AUD/USD", category: "forex", description: "Australian Dollar vs US Dollar" },
  { id: "nzdusd", name: "NZD/USD", category: "forex", description: "New Zealand Dollar vs US Dollar" },
  { id: "usdcad", name: "USD/CAD", category: "forex", description: "US Dollar vs Canadian Dollar" },
  // Crosses
  { id: "eurjpy", name: "EUR/JPY", category: "forex", description: "Euro vs Japanese Yen" },
  { id: "gbpjpy", name: "GBP/JPY", category: "forex", description: "British Pound vs Japanese Yen — high vol" },
  { id: "eurgbp", name: "EUR/GBP", category: "forex", description: "Euro vs British Pound" },
  { id: "audjpy", name: "AUD/JPY", category: "forex", description: "Australian Dollar vs Japanese Yen" },
  // Metals
  { id: "gold",     name: "Gold",     category: "metal", description: "Spot Gold (XAU/USD)" },
  { id: "silver",   name: "Silver",   category: "metal", description: "Spot Silver (XAG/USD)" },
  { id: "platinum", name: "Platinum", category: "metal", description: "Spot Platinum (XPT/USD)" },
  // Crypto
  { id: "btc", name: "Bitcoin",  category: "crypto", description: "Bitcoin vs USD — 24/7" },
  { id: "eth", name: "Ethereum", category: "crypto", description: "Ethereum vs USD — 24/7" },
  { id: "sol", name: "Solana",   category: "crypto", description: "Solana vs USD" },
  { id: "xrp", name: "Ripple",   category: "crypto", description: "Ripple vs USD" },
  // Indices
  { id: "nas100", name: "Nasdaq 100", category: "index", description: "US tech-heavy index" },
  { id: "us30",   name: "Dow Jones",  category: "index", description: "Dow Jones Industrial Average" },
  { id: "us500",  name: "S&P 500",    category: "index", description: "S&P 500 futures" },
  { id: "ger40",  name: "DAX 40",     category: "index", description: "German DAX 40" },
  { id: "uk100",  name: "FTSE 100",   category: "index", description: "UK FTSE 100" },
  { id: "jp225",  name: "Nikkei 225", category: "index", description: "Japan Nikkei 225" },
  // Commodities
  { id: "oil_wti",   name: "WTI Crude Oil",   category: "commodity", description: "West Texas Intermediate" },
  { id: "oil_brent", name: "Brent Crude Oil", category: "commodity", description: "Brent crude oil" },
  { id: "natgas",    name: "Natural Gas",     category: "commodity", description: "Natural gas futures" },
];

const CATEGORY_LABELS = {
  forex:     "Forex",
  metal:     "Metals",
  crypto:    "Crypto",
  index:     "Indices",
  commodity: "Commodities",
};

function getAssetById(id) {
  return ASSET_CATALOG.find((a) => a.id === id) || null;
}

// =====================================================================
// SECTION 7: TACTIC LABELS (UI display)
// =====================================================================

const TACTIC_LABELS = {
  orderBlock:        "Order Blocks",
  fvg:               "Fair Value Gaps",
  bos:               "Break of Structure",
  trendStructure:    "Trend Structure (HH/HL)",
  liquiditySweep:    "Liquidity Sweeps",
  sessionLevel:      "Session H/L + PDH/PDL",
  unfilledImbalance: "Unfilled Imbalances",
  fakeout:           "Fakeout Signatures",
  roundNumber:       "Round Numbers",
  fibonacci:         "Fibonacci Retracement",
  ema21:             "EMA 21",
  ema50:             "EMA 50",
  ema200:            "EMA 200",
  vwap:              "VWAP",
  bollinger:         "Bollinger Bands",
  rsi:               "RSI",
};

const TACTIC_DESCRIPTIONS = {
  orderBlock:        "Last opposite candle before strong directional move. Often acts as support/resistance on retest.",
  fvg:               "Fair Value Gap: 3-candle imbalance where price moved too fast. Market often returns to fill.",
  bos:               "Break of Structure: clean close beyond a previous swing high/low. Confirms trend continuation.",
  trendStructure:    "Higher Highs/Higher Lows (uptrend) or Lower Highs/Lower Lows (downtrend) on the chart.",
  liquiditySweep:    "Price spikes past a level to grab stops, then reverses. Real reversal vs fakeout.",
  sessionLevel:      "Asian/London/NY session highs and lows + Prior Day H/L + Weekly Open. Magnets and reversal zones.",
  unfilledImbalance: "Larger gaps in price action (weekend gaps, news gaps). Markets often fill the gap.",
  fakeout:           "Failed breakout: price breaks a level then reverses, trapping breakout traders.",
  roundNumber:       "Psychologically significant prices (1.10, 4500, 80000). Magnetic levels.",
  fibonacci:         "Retracement levels (0.382, 0.5, 0.618, 0.786) from last impulse.",
  ema21:             "21-period Exponential Moving Average. Short-term trend.",
  ema50:             "50-period EMA. Medium-term trend.",
  ema200:            "200-period EMA. Long-term trend.",
  vwap:              "Volume-Weighted Average Price. Institutional benchmark.",
  bollinger:         "Volatility bands. Price extremes.",
  rsi:               "Relative Strength Index. Overbought/oversold.",
};

// =====================================================================
// SECTION 8: ROOT APP
// =====================================================================

export default function App() {
  // Theme — applied as CSS variables on root
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => { applyThemeToRoot(theme); saveTheme(theme); }, [theme]);

  // Inject global styles once
  useEffect(() => {
    const id = "qb-global-styles";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = GLOBAL_STYLES;
    document.head.appendChild(style);
  }, []);

  // Preferences (selected asset, watchlist, lots, tools, etc.)
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  // Routing — simple state-based, no router library
  const [page, setPage] = useState("cockpit");

  // Live data shared across pages
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);

  // Poll account + positions every 5 seconds
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

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", position: "relative" }}>
      {page === "cockpit" && (
        <CockpitPage
          prefs={prefs}
          setPrefs={setPrefs}
          theme={theme}
          account={account}
          positions={positions}
          onNavigate={setPage}
        />
      )}
      {page === "portfolio" && (
        <PortfolioPage
          prefs={prefs}
          theme={theme}
          account={account}
          positions={positions}
          onNavigate={setPage}
        />
      )}
      {page === "reports" && (
        <ReportsPage prefs={prefs} theme={theme} onNavigate={setPage} />
      )}
      {page === "settings" && (
        <SettingsPage
          prefs={prefs}
          setPrefs={setPrefs}
          theme={theme}
          setTheme={setTheme}
          onNavigate={setPage}
        />
      )}
    </div>
  );
}

// =====================================================================
// SECTION 9: COCKPIT PAGE
// =====================================================================

function CockpitPage({ prefs, setPrefs, theme, account, positions, onNavigate }) {
  const [sideBarOpen, setSideBarOpen] = useState(prefs.sideBarOpen);
  const [bottomBarOpen, setBottomBarOpen] = useState(prefs.bottomBarOpen);
  const [logoMenuOpen, setLogoMenuOpen] = useState(false);
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [pausePopoverOpen, setPausePopoverOpen] = useState(false);
  const [toolsPopoverOpen, setToolsPopoverOpen] = useState(false);

  const selectedAsset = prefs.selectedAsset || "gold";
  const selectedAssetMeta = getAssetById(selectedAsset);
  const isPaused = prefs.pauseOnAsset?.[selectedAsset] || false;

  // Live price / candles for the selected asset + TF
  const [chartData, setChartData] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);

  // Position on the selected asset (if any)
  const myPosition = positions.find((p) => p.assetId === selectedAsset) || null;

  // Fetch chart data for the selected asset/TF
  useEffect(() => {
    let alive = true;
    setChartLoading(true);
    (async () => {
      try {
        const r = await fetch(
          API(`broker?action=candles&asset=${selectedAsset}&tf=${prefs.selectedTF}&n=200`)
        ).then((r) => r.json());
        if (alive) {
          setChartData(r);
          setChartLoading(false);
        }
      } catch (e) {
        if (alive) setChartLoading(false);
      }
    })();
    const id = setInterval(async () => {
      try {
        const r = await fetch(
          API(`broker?action=candles&asset=${selectedAsset}&tf=${prefs.selectedTF}&n=200`)
        ).then((r) => r.json());
        if (alive) setChartData(r);
      } catch (_) {}
    }, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [selectedAsset, prefs.selectedTF]);

  // Persist sidebar/bottom-bar state to prefs
  useEffect(() => {
    setPrefs((p) => ({ ...p, sideBarOpen, bottomBarOpen }));
  }, [sideBarOpen, bottomBarOpen]);

  // Live state from V12 backend (watcher's mental model) — polled
  const [assetState, setAssetState] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API(`state?asset=${selectedAsset}`)).then((r) => r.json());
        if (alive && r && !r.error) setAssetState(r);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 15000);  // poll every 15s
    return () => { alive = false; clearInterval(id); };
  }, [selectedAsset]);

  // Handle pause toggle
  const togglePause = useCallback(() => {
    setPrefs((p) => ({
      ...p,
      pauseOnAsset: { ...(p.pauseOnAsset || {}), [selectedAsset]: !isPaused },
    }));
  }, [selectedAsset, isPaused, setPrefs]);

  // Handle asset switch from sidebar
  const switchAsset = useCallback((assetId) => {
    setPrefs((p) => ({ ...p, selectedAsset: assetId }));
  }, [setPrefs]);

  // Handle add instrument from modal
  const addInstrument = useCallback((assetId) => {
    setPrefs((p) => ({
      ...p,
      watchlist: p.watchlist.includes(assetId) ? p.watchlist : [...p.watchlist, assetId],
      perInstrumentLot: { ...(p.perInstrumentLot || {}), [assetId]: p.perInstrumentLot?.[assetId] || 0.01 },
      selectedAsset: assetId,
    }));
    setAssetModalOpen(false);
  }, [setPrefs]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "var(--qb-bg-base)" }}>
      {/* TOP BAR */}
      <CockpitTopBar
        theme={theme}
        prefs={prefs}
        setPrefs={setPrefs}
        selectedAssetMeta={selectedAssetMeta}
        chartData={chartData}
        account={account}
        isPaused={isPaused}
        onTogglePause={togglePause}
        onLogoClick={() => setLogoMenuOpen((v) => !v)}
        logoMenuOpen={logoMenuOpen}
        onCloseLogoMenu={() => setLogoMenuOpen(false)}
        onNavigate={onNavigate}
        onPauseSettings={() => setPausePopoverOpen(true)}
        onAddInstrument={() => setAssetModalOpen(true)}
        myPosition={myPosition}
        assetState={assetState}
      />

      {/* SIDE BAR */}
      <CockpitSideBar
        theme={theme}
        open={sideBarOpen}
        onToggle={() => setSideBarOpen((v) => !v)}
        prefs={prefs}
        setPrefs={setPrefs}
        positions={positions}
        onSwitchAsset={switchAsset}
        onAddInstrument={() => setAssetModalOpen(true)}
        onSettings={() => onNavigate("settings")}
        assetState={assetState}
      />

      {/* CHART */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: sideBarOpen ? 280 : 8,
          right: 8,
          bottom: bottomBarOpen ? 76 : 16,
          transition: "left 250ms, bottom 250ms",
        }}
      >
        <CockpitChart
          theme={theme}
          prefs={prefs}
          setPrefs={setPrefs}
          assetId={selectedAsset}
          chartData={chartData}
          chartLoading={chartLoading}
          myPosition={myPosition}
          assetState={assetState}
          onToolsClick={() => setToolsPopoverOpen((v) => !v)}
          toolsPopoverOpen={toolsPopoverOpen}
          onCloseToolsPopover={() => setToolsPopoverOpen(false)}
        />
      </div>

      {/* BOTTOM BAR */}
      <CockpitBottomBar
        theme={theme}
        open={bottomBarOpen}
        onToggle={() => setBottomBarOpen((v) => !v)}
        commentary={assetState?.commentary || []}
        assetId={selectedAsset}
      />

      {/* MODALS / POPOVERS */}
      {assetModalOpen && (
        <AssetSelectionModal
          theme={theme}
          watchlist={prefs.watchlist}
          onAdd={addInstrument}
          onClose={() => setAssetModalOpen(false)}
        />
      )}

      {pausePopoverOpen && (
        <PauseSettingsPopover
          theme={theme}
          prefs={prefs}
          setPrefs={setPrefs}
          onClose={() => setPausePopoverOpen(false)}
        />
      )}
    </div>
  );
}

// =====================================================================
// SECTION 9.1: COCKPIT — TOP BAR
// =====================================================================

function CockpitTopBar({
  theme, prefs, setPrefs, selectedAssetMeta, chartData, account, isPaused,
  onTogglePause, onLogoClick, logoMenuOpen, onCloseLogoMenu, onNavigate,
  onPauseSettings, onAddInstrument, myPosition, assetState,
}) {
  const selectedAsset = prefs.selectedAsset || "gold";
  const lot = prefs.perInstrumentLot?.[selectedAsset] || 0.01;

  // Last close from chart data = current price approximation
  const lastCandle = chartData?.candles?.[chartData.candles.length - 1];
  const currentPrice = lastCandle?.close;
  const prevPrice = chartData?.candles?.[chartData.candles.length - 2]?.close;
  const priceChange = currentPrice && prevPrice ? ((currentPrice - prevPrice) / prevPrice) : 0;
  const priceColor = priceChange >= 0 ? "var(--qb-up-strong)" : "var(--qb-down-strong)";

  const balance = account?.balance ?? null;

  // Suggested lot from V12 backend (watcher includes sizing in pending setups)
  const suggestedLot = assetState?.pending?.[0]?.sizing?.recommendedLot || null;

  return (
    <div
      className="qb-glass"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 40,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 12px",
        zIndex: 10,
        borderBottom: "1px solid var(--qb-border)",
      }}
    >
      {/* Logo */}
      <div style={{ position: "relative" }}>
        <button
          onClick={onLogoClick}
          style={{
            width: 28, height: 28, borderRadius: "50%",
            background: "linear-gradient(135deg, var(--qb-accent), #0066cc)",
            border: "none", cursor: "pointer", padding: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 12px var(--qb-accent-soft)",
          }}
          className="qb-glow"
          title="Menu"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="16" y1="16" x2="20" y2="20" />
          </svg>
        </button>
        {logoMenuOpen && (
          <LogoMenu
            theme={theme}
            onNavigate={(p) => { onNavigate(p); onCloseLogoMenu(); }}
            onClose={onCloseLogoMenu}
          />
        )}
      </div>

      {/* Asset symbol switcher */}
      <button
        onClick={onAddInstrument}
        style={{
          background: "transparent",
          border: "1px solid var(--qb-border)",
          borderRadius: 4,
          padding: "4px 10px",
          color: "var(--qb-text-primary)",
          fontFamily: "var(--qb-font-mono)",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        title="Switch instrument or add new"
      >
        {selectedAssetMeta?.id?.toUpperCase() || selectedAsset.toUpperCase()}
        <span style={{ color: "var(--qb-text-muted)", fontSize: 10 }}>▾</span>
      </button>

      {/* Current price */}
      {currentPrice && (
        <div
          className="qb-mono"
          style={{ fontSize: 14, color: priceColor, fontWeight: 600, minWidth: 80 }}
        >
          {fmtPrice(currentPrice)}
          {priceChange !== 0 && (
            <span style={{ marginLeft: 6, fontSize: 11 }}>
              {priceChange > 0 ? "▲" : "▼"} {fmtPercent(priceChange)}
            </span>
          )}
        </div>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Balance */}
      {balance != null && (
        <div className="qb-mono" style={{ fontSize: 13, color: "var(--qb-text-muted)" }}>
          ${balance.toFixed(2)}
        </div>
      )}

      {/* Lot input */}
      <LotInput
        lot={lot}
        onChange={(newLot) => {
          setPrefs((p) => ({
            ...p,
            perInstrumentLot: { ...(p.perInstrumentLot || {}), [selectedAsset]: newLot },
          }));
        }}
        suggested={suggestedLot}
      />

      {/* Pause toggle */}
      <button
        onClick={onTogglePause}
        onContextMenu={(e) => { e.preventDefault(); onPauseSettings(); }}
        style={{
          background: isPaused ? "var(--qb-news-imminent)" : "transparent",
          color: isPaused ? "#0a0b0f" : "var(--qb-text-primary)",
          border: `1px solid ${isPaused ? "var(--qb-news-imminent)" : "var(--qb-border)"}`,
          borderRadius: 4,
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
        title={isPaused ? "Trading paused — click to resume. Right-click for thresholds." : "Trading active — click to pause new entries. Right-click for thresholds."}
      >
        {isPaused ? "⏸ Paused" : "● Active"}
      </button>

      {/* News indicator (real data from V12 backend) */}
      <NewsIndicator theme={theme} assetId={selectedAsset} news={assetState?.news} />

      {/* Recognition indicator (real data from V12 backend) */}
      <RecognitionIndicator theme={theme} assetId={selectedAsset} pending={assetState?.pending} />
    </div>
  );
}

// =====================================================================
// SECTION 9.2: COCKPIT — LOGO MENU
// =====================================================================

function LogoMenu({ theme, onNavigate, onClose }) {
  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest(".qb-logo-menu") && !e.target.closest("button")) onClose();
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const items = [
    { id: "cockpit",   label: "Cockpit",   icon: "▣" },
    { id: "portfolio", label: "Portfolio", icon: "▤" },
    { id: "reports",   label: "Reports",   icon: "▦" },
    { id: "settings",  label: "Settings",  icon: "⚙" },
  ];

  return (
    <div
      className="qb-glass qb-logo-menu"
      style={{
        position: "absolute",
        top: 36,
        left: 0,
        minWidth: 180,
        borderRadius: 6,
        padding: 4,
        zIndex: 100,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onNavigate(it.id)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            background: "transparent",
            border: "none",
            borderRadius: 4,
            color: "var(--qb-text-primary)",
            cursor: "pointer",
            fontSize: 13,
            textAlign: "left",
            transition: "background 150ms",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--qb-accent-soft)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <span style={{ width: 16, color: "var(--qb-accent)" }}>{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

// =====================================================================
// SECTION 9.3: COCKPIT — LOT INPUT
// =====================================================================

function LotInput({ lot, onChange, suggested }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(lot));
  const inputRef = useRef(null);

  useEffect(() => { setDraft(String(lot)); }, [lot]);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.select();
  }, [editing]);

  const commit = () => {
    const n = parseFloat(draft);
    if (isFinite(n) && n > 0) onChange(n);
    setEditing(false);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>Lot:</span>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(String(lot)); setEditing(false); } }}
          style={{
            width: 60,
            background: "var(--qb-bg-layer)",
            border: "1px solid var(--qb-accent)",
            borderRadius: 4,
            padding: "4px 8px",
            color: "var(--qb-text-primary)",
            fontFamily: "var(--qb-font-mono)",
            fontSize: 13,
            textAlign: "right",
          }}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="qb-mono"
          style={{
            background: "transparent",
            border: "1px solid var(--qb-border)",
            borderRadius: 4,
            padding: "4px 10px",
            color: "var(--qb-text-primary)",
            fontSize: 13,
            cursor: "pointer",
            minWidth: 60,
            textAlign: "right",
          }}
          title="Click to edit lot size"
        >
          {lot.toFixed(2)}
        </button>
      )}
      {suggested != null && Math.abs(suggested - lot) > 0.001 && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }} title={`Bot suggests ${suggested.toFixed(2)} based on current setup`}>
          <span className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-muted)" }}>
            sugg. {suggested.toFixed(2)}
          </span>
          <button
            onClick={() => onChange(suggested)}
            style={{
              background: "var(--qb-accent-soft)",
              border: "1px solid var(--qb-accent)",
              borderRadius: 3,
              padding: "2px 6px",
              color: "var(--qb-accent)",
              fontSize: 9,
              fontWeight: 700,
              cursor: "pointer",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            use
          </button>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// SECTION 9.4: COCKPIT — NEWS INDICATOR
// =====================================================================
// Three intensities: scheduled today (yellow dot), within 30 min (amber pill),
// live (red pulsing pill). Wired up properly in session 4.
// =====================================================================

function NewsIndicator({ theme, assetId, news }) {
  // news is a NewsContext object: { state, currencies, events: { live, imminent, today }, summary }
  if (!news || news.state === 'none') return null;

  if (news.state === 'live') {
    const event = news.events?.live?.[0];
    return (
      <div
        className="qb-pulse"
        style={{
          background: "var(--qb-news-live)",
          color: "white",
          padding: "3px 10px",
          borderRadius: 12,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
        }}
        title={news.summary}
      >
        ● {event?.currency || ''} LIVE
      </div>
    );
  }

  if (news.state === 'imminent') {
    const event = news.events?.imminent?.[0];
    return (
      <div
        style={{
          background: "var(--qb-news-imminent)",
          color: "#0a0b0f",
          padding: "3px 10px",
          borderRadius: 12,
          fontSize: 11,
          fontWeight: 600,
        }}
        title={news.summary}
      >
        {event?.currency} {Math.round(event?.minsUntil || 0)}m
      </div>
    );
  }

  return (
    <div
      style={{
        width: 8, height: 8, borderRadius: "50%",
        background: "var(--qb-news-scheduled)",
      }}
      title={news.summary || "News scheduled"}
    />
  );
}

// =====================================================================
// SECTION 9.5: COCKPIT — RECOGNITION INDICATOR
// =====================================================================
// Visible when bot has identified a coherent setup. Shows match % and count.
// Wires up in session 4.
// =====================================================================

function RecognitionIndicator({ theme, assetId, pending }) {
  // Show only when there's an active pending setup with recognition data
  const activePending = pending?.find?.((p) => p.status === 'pending' || p.status === 'placed');
  const recognition = activePending?.recognition;

  if (!recognition || recognition.matchCount === 0) return null;

  const winRatePercent = recognition.winRate != null
    ? Math.round(recognition.winRate * 100)
    : null;

  if (winRatePercent == null) return null;

  return (
    <div
      style={{
        background: "var(--qb-accent-soft)",
        color: "var(--qb-accent)",
        padding: "3px 10px",
        borderRadius: 12,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--qb-font-mono)",
        border: "1px solid var(--qb-accent)",
      }}
      title={`Configuration matches ${recognition.matchCount} past setups: ${recognition.wins} wins, ${recognition.losses} losses (${recognition.confidence})`}
    >
      ◉ {winRatePercent}%
    </div>
  );
}

// =====================================================================
// SECTION 9.6: COCKPIT — SIDE BAR
// =====================================================================

function CockpitSideBar({
  theme, open, onToggle, prefs, setPrefs, positions,
  onSwitchAsset, onAddInstrument, onSettings, assetState,
}) {
  const watchlist = prefs.watchlist || [];
  const selectedAsset = prefs.selectedAsset || "gold";

  const removeInstrument = (assetId) => {
    if (watchlist.length <= 1) return;
    setPrefs((p) => ({
      ...p,
      watchlist: p.watchlist.filter((a) => a !== assetId),
      selectedAsset: p.selectedAsset === assetId ? p.watchlist[0] : p.selectedAsset,
    }));
  };

  return (
    <>
      {/* Edge strip (always visible, click to toggle) */}
      <div
        onClick={onToggle}
        style={{
          position: "absolute",
          top: 44,
          left: 0,
          width: 6,
          bottom: 76,
          background: "var(--qb-border)",
          cursor: "pointer",
          zIndex: 5,
          borderRight: open ? "1px solid var(--qb-accent)" : "none",
          transition: "border-color 200ms, background 200ms",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--qb-accent-soft)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "var(--qb-border)")}
        title={open ? "Collapse sidebar" : "Open sidebar"}
      />

      {/* Side bar content */}
      {open && (
        <div
          className="qb-glass"
          style={{
            position: "absolute",
            top: 44,
            left: 6,
            width: 274,
            bottom: 76,
            zIndex: 6,
            padding: 10,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "var(--qb-text-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
              Watchlist
            </div>
            <button
              onClick={onAddInstrument}
              style={{
                background: "var(--qb-accent-soft)",
                border: "none",
                borderRadius: 3,
                color: "var(--qb-accent)",
                fontSize: 11,
                padding: "3px 8px",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              + Add
            </button>
          </div>

          {/* Instrument list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {watchlist.map((assetId) => {
              const meta = getAssetById(assetId);
              const pos = positions.find((p) => p.assetId === assetId);
              const selected = assetId === selectedAsset;
              return (
                <div
                  key={assetId}
                  onClick={() => onSwitchAsset(assetId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 10px",
                    background: selected ? "var(--qb-accent-soft)" : "transparent",
                    border: `1px solid ${selected ? "var(--qb-accent)" : "var(--qb-border)"}`,
                    borderRadius: 4,
                    cursor: "pointer",
                    transition: "all 150ms",
                  }}
                  onMouseEnter={(e) => {
                    if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                  }}
                  onMouseLeave={(e) => {
                    if (!selected) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <div>
                    <div className="qb-mono" style={{ fontSize: 13, fontWeight: 600 }}>
                      {assetId.toUpperCase()}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--qb-text-muted)" }}>
                      {meta?.name || ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {pos && (
                      <div
                        style={{
                          width: 6, height: 6, borderRadius: "50%",
                          background: pos.profit > 0 ? "var(--qb-up-strong)" : pos.profit < 0 ? "var(--qb-down-strong)" : "var(--qb-text-muted)",
                        }}
                        title={`Open position: ${fmtMoney(pos.profit)}`}
                      />
                    )}
                    {watchlist.length > 1 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); removeInstrument(assetId); }}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--qb-text-muted)",
                          cursor: "pointer",
                          fontSize: 14,
                          padding: 0,
                          opacity: 0.5,
                          transition: "opacity 150ms",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = 1)}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = 0.5)}
                        title="Remove from watchlist"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Active tactics for selected instrument */}
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, color: "var(--qb-text-muted)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
              Active tactics on {selectedAsset.toUpperCase()}
            </div>
            {assetState?.state?.opinions?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {assetState.state.opinions.slice(0, 12).map((op, i) => {
                  const dirColor = op.direction === "LONG" ? "var(--qb-up-strong)"
                    : op.direction === "SHORT" ? "var(--qb-down-strong)"
                    : "var(--qb-text-muted)";
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "4px 8px",
                        fontSize: 10,
                        background: "rgba(255,255,255,0.02)",
                        borderRadius: 3,
                        borderLeft: `2px solid ${dirColor}`,
                      }}
                      title={op.description}
                    >
                      <span className="qb-mono" style={{ fontSize: 10, color: "var(--qb-text-primary)" }}>
                        {op.timeframe} {TACTIC_LABELS[op.tactic] || op.tactic}
                      </span>
                      <span style={{ color: dirColor, fontSize: 9, fontWeight: 600 }}>
                        {op.direction !== "NEUTRAL" ? op.direction : "lvl"}
                      </span>
                    </div>
                  );
                })}
                {assetState.state.opinions.length > 12 && (
                  <div style={{ fontSize: 9, color: "var(--qb-text-dim)", textAlign: "center", marginTop: 4 }}>
                    + {assetState.state.opinions.length - 12} more
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 10, color: "var(--qb-text-dim)", padding: "8px 0", fontStyle: "italic" }}>
                {assetState ? "No opinions detected right now" : "Loading..."}
              </div>
            )}
          </div>

          {/* Settings shortcut */}
          <div style={{ marginTop: "auto" }}>
            <button
              onClick={onSettings}
              style={{
                width: "100%",
                background: "transparent",
                border: "1px solid var(--qb-border)",
                borderRadius: 4,
                padding: "8px 10px",
                color: "var(--qb-text-muted)",
                fontSize: 12,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--qb-text-primary)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--qb-text-muted)")}
            >
              <span>⚙</span> Settings
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// =====================================================================
// SECTION 9.7: COCKPIT — CHART
// =====================================================================

function CockpitChart({
  theme, prefs, setPrefs, assetId, chartData, chartLoading, myPosition, assetState,
  onToolsClick, toolsPopoverOpen, onCloseToolsPopover,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const priceLinesRef = useRef([]);

  // Build chart on mount, destroy on unmount
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#7a7a85",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "rgba(255,255,255,0.08)",
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(0,217,255,0.3)", width: 1, style: 3, labelBackgroundColor: "#00d9ff" },
        horzLine: { color: "rgba(0,217,255,0.3)", width: 1, style: 3, labelBackgroundColor: "#00d9ff" },
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#00e676",
      downColor: "#ff3b5c",
      borderVisible: false,
      wickUpColor: "#00e676",
      wickDownColor: "#ff3b5c",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Resize handler
    const ro = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      try { chart.remove(); } catch (_) {}
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // Update candles when chartData changes
  useEffect(() => {
    if (!seriesRef.current || !chartData?.candles) return;

    const candlesRaw = chartData.candles
      .map((c) => ({
        time: Math.floor(new Date(c.time).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
      .filter((c) => c.time && isFinite(c.open) && isFinite(c.close));

    if (candlesRaw.length === 0) return;
    candlesRaw.sort((a, b) => a.time - b.time);
    const dedup = [];
    let lastT = -1;
    for (const c of candlesRaw) {
      if (c.time !== lastT) { dedup.push(c); lastT = c.time; }
    }

    seriesRef.current.setData(dedup);

    // Clear existing price lines
    for (const pl of priceLinesRef.current) {
      try { seriesRef.current.removePriceLine(pl); } catch (_) {}
    }
    priceLinesRef.current = [];

    // Add position lines if we have an open position OR a pending setup
    if (seriesRef.current) {
      const pending = assetState?.pending;
      if (myPosition || (pending && pending.length > 0)) {
        addPositionLines(seriesRef.current, myPosition, priceLinesRef.current, pending, assetState);
      }
    }
  }, [chartData, myPosition, assetState]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "var(--qb-bg-base)",
        border: "1px solid var(--qb-border)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {/* Chart canvas */}
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0 }}
      />

      {/* Tactic annotations overlay — only renders when bot is acting on a setup */}
      <TacticAnnotationOverlay
        chartRef={chartRef}
        seriesRef={seriesRef}
        containerRef={containerRef}
        chartData={chartData}
        assetState={assetState}
        myPosition={myPosition}
        prefs={prefs}
      />

      {/* Top-left controls: TF selector + tools toggle */}
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          display: "flex",
          gap: 4,
          alignItems: "center",
          zIndex: 5,
        }}
      >
        <TFSelector selectedTF={prefs.selectedTF} onChange={(tf) => setPrefs((p) => ({ ...p, selectedTF: tf }))} />
        <ToolsButton onClick={onToolsClick} active={toolsPopoverOpen} />
      </div>

      {/* Tools popover */}
      {toolsPopoverOpen && (
        <ToolsPopover
          theme={theme}
          prefs={prefs}
          setPrefs={setPrefs}
          onClose={onCloseToolsPopover}
        />
      )}

      {/* Loading state */}
      {chartLoading && !chartData && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--qb-text-muted)",
            fontSize: 12,
            background: "rgba(10,11,15,0.8)",
          }}
        >
          Loading chart...
        </div>
      )}

      {/* Empty / error state */}
      {!chartLoading && (!chartData?.candles || chartData.candles.length === 0) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "var(--qb-text-muted)",
            fontSize: 12,
            background: "rgba(10,11,15,0.8)",
          }}
        >
          <div style={{ fontSize: 14, color: "var(--qb-text-primary)" }}>
            {assetId.toUpperCase()} not available
          </div>
          <div style={{ maxWidth: 320, textAlign: "center" }}>
            {chartData?.error || "Run /api/symbol-resolver?action=sync to map this asset to your broker"}
          </div>
        </div>
      )}
    </div>
  );
}

function addPositionLines(series, position, container, pending, assetState) {
  if (!series) return;
  const isLong = position
    ? (position.type === "POSITION_TYPE_BUY") || (position.direction === "LONG")
    : pending?.[0]?.setup?.direction === "LONG";

  // Find the live pending setup if any
  const activePending = pending?.find?.((p) => p.status === "pending" || p.status === "placed" || p.status === "filled");

  const entry = position?.openPrice || position?.entry || activePending?.actualEntry || activePending?.plannedEntry;
  const sl = position?.stopLoss || activePending?.slPrice;
  const tpLevels = activePending?.tpLevels || [];
  const lot = position?.volume || activePending?.sizing?.recommendedLot || 0.01;
  const asset = activePending?.asset || assetState?.asset;

  // Get the asset metadata for $/pip math
  const assetMeta = ASSET_CATALOG.find((a) => a.id === asset);
  const dollarPerPip = assetMeta ? getPipDollar(asset) : 1;
  const pipSize = assetMeta ? getPipSize(asset) : 0.0001;

  function dollarFor(price) {
    if (!entry || !price || !pipSize || !dollarPerPip || !lot) return null;
    const pips = Math.abs(price - entry) / pipSize;
    return pips * dollarPerPip * lot;
  }

  if (entry) {
    const line = series.createPriceLine({
      price: entry,
      color: "#fbbf24",
      lineWidth: 2,
      lineStyle: 0,
      axisLabelVisible: true,
      title: `ENTRY ${isLong ? "LONG" : "SHORT"} ${lot}`,
    });
    container.push(line);
  }
  if (sl) {
    const slDollars = dollarFor(sl);
    const slLabel = slDollars != null ? `SL -$${slDollars.toFixed(0)}` : `SL`;
    const line = series.createPriceLine({
      price: sl,
      color: "#dc2626",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: slLabel,
    });
    container.push(line);
  }

  // Draw all TPs from pending if available
  if (tpLevels.length > 0) {
    for (let i = 0; i < tpLevels.length && i < 4; i++) {
      const tp = tpLevels[i];
      const tpDollars = dollarFor(tp.price);
      const tpLabel = tpDollars != null
        ? `TP${i + 1} +$${tpDollars.toFixed(0)} (${tp.rMultiple.toFixed(1)}R)`
        : `TP${i + 1} ${tp.rMultiple.toFixed(1)}R`;
      const line = series.createPriceLine({
        price: tp.price,
        color: "#22c55e",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: tpLabel,
      });
      container.push(line);
    }
  } else if (position?.takeProfit) {
    // Fallback: just the broker's single TP
    const tpDollars = dollarFor(position.takeProfit);
    const line = series.createPriceLine({
      price: position.takeProfit,
      color: "#22c55e",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: tpDollars != null ? `TP +$${tpDollars.toFixed(0)}` : `TP`,
    });
    container.push(line);
  }
}

// Pip dollar value per lot (mirrors backend asset-registry)
function getPipDollar(assetId) {
  const map = {
    eurusd: 10, gbpusd: 10, audusd: 10, nzdusd: 10,
    usdjpy: 6.7, usdchf: 11, usdcad: 7.5,
    eurjpy: 6.7, gbpjpy: 6.7, eurgbp: 13, audjpy: 6.7,
    gold: 1, silver: 5, platinum: 1,
    btc: 1, eth: 0.01, sol: 0.01, xrp: 0.0001,
    nas100: 1, us30: 1, us500: 0.1, ger40: 0.1, uk100: 0.1, jp225: 1,
    oil_wti: 1, oil_brent: 1, natgas: 1,
  };
  return map[assetId] || 10;
}

function getPipSize(assetId) {
  const map = {
    eurusd: 0.0001, gbpusd: 0.0001, audusd: 0.0001, nzdusd: 0.0001,
    usdjpy: 0.01, usdchf: 0.0001, usdcad: 0.0001,
    eurjpy: 0.01, gbpjpy: 0.01, eurgbp: 0.0001, audjpy: 0.01,
    gold: 0.01, silver: 0.01, platinum: 0.01,
    btc: 1, eth: 0.01, sol: 0.01, xrp: 0.0001,
    nas100: 1, us30: 1, us500: 0.1, ger40: 0.1, uk100: 0.1, jp225: 1,
    oil_wti: 0.01, oil_brent: 0.01, natgas: 0.001,
  };
  return map[assetId] || 0.0001;
}

// =====================================================================
// TACTIC ANNOTATION OVERLAY
// =====================================================================
// Renders bot's contributing tactics on the chart ONLY when bot is acting.
// Uses HTML overlay aligned to chart's coordinate system via lightweight-charts'
// timeToCoordinate / priceToCoordinate.
//
// Visibility rule: only renders when there's a pending setup, filled position,
// or current TRADE decision. During quiet times, chart stays clean.
//
// Tactics rendered:
//   - Order Block: shaded rectangle from OB candle to current bar
//   - FVG: shaded rectangle in the gap zone, opacity reflects fill %
//   - BOS: horizontal line at broken level + label
//   - Liquidity Sweep: small starburst marker + reversal arrow
//   - Session Levels: dotted horizontal lines (asian violet, london cyan, ny amber)
//   - Trend Structure: HH/HL/LH/LL labels at swing points
//   - Unfilled Imbalance: wider shaded gap zone
//   - Fakeout: failed-breakout marker
//   - Round Numbers: thin horizontal lines
// =====================================================================

function TacticAnnotationOverlay({ chartRef, seriesRef, containerRef, chartData, assetState, myPosition, prefs }) {
  const overlayRef = useRef(null);
  const [tick, setTick] = useState(0);
  const [hoveredAnnotation, setHoveredAnnotation] = useState(null);

  // Subscribe to chart's coordinate changes (zoom, pan, resize) to redraw
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;

    const handler = () => setTick((t) => t + 1);

    // lightweight-charts API: subscribe to visible time range changes
    try {
      chart.timeScale().subscribeVisibleTimeRangeChange(handler);
      chart.timeScale().subscribeVisibleLogicalRangeChange?.(handler);
    } catch (_) {}

    // Resize observer on container
    let ro = null;
    if (containerRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(handler);
      ro.observe(containerRef.current);
    }

    return () => {
      try { chart.timeScale().unsubscribeVisibleTimeRangeChange(handler); } catch (_) {}
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange?.(handler); } catch (_) {}
      if (ro) ro.disconnect();
    };
  }, [chartRef.current, containerRef.current]);

  // Determine if bot is currently acting (the visibility rule)
  const isActing = useMemo(() => {
    if (myPosition) return true;
    const pending = assetState?.pending || [];
    if (pending.some((p) => p.status === "pending" || p.status === "placed" || p.status === "filled")) return true;
    if (assetState?.state?.coherence?.decision === "TRADE") return true;
    return false;
  }, [assetState, myPosition]);

  // Get the contributing opinions to draw
  // Source priority:
  //   1. Active pending setup's opinions (most accurate — frozen at setup time)
  //   2. Current state's coherence.opinionsUsed (live)
  const contributingOpinions = useMemo(() => {
    if (!isActing) return [];
    const pending = assetState?.pending?.find?.(
      (p) => p.status === "pending" || p.status === "placed" || p.status === "filled"
    );
    if (pending?.setup?.contributingTactics && assetState?.state?.opinions) {
      // Filter live opinions to those matching contributing tactics
      const contributingSet = new Set(pending.setup.contributingTactics);
      return assetState.state.opinions.filter((op) =>
        contributingSet.has(op.tactic) && op.direction === pending.setup.direction
      );
    }
    return assetState?.state?.coherence?.opinionsUsed || [];
  }, [assetState, isActing]);

  // Also pull NEUTRAL session-level opinions to show (they're TP target context)
  const neutralOpinions = useMemo(() => {
    if (!isActing) return [];
    return (assetState?.state?.coherence?.neutralsUsed || []).slice(0, 6);
  }, [assetState, isActing]);

  // Build renderable annotations
  const annotations = useMemo(() => {
    if (!isActing || !chartData?.candles?.length) return [];
    if (!seriesRef.current || !chartRef.current) return [];

    const showFlags = prefs?.toolsConfig || {};
    const isShownOnChart = (tacticId) => {
      const cfg = showFlags[tacticId];
      // Default: show if not explicitly disabled
      return !cfg || cfg[0] !== false;
    };

    const out = [];

    // Render each contributing opinion
    for (const op of contributingOpinions) {
      if (!isShownOnChart(op.tactic)) continue;

      const a = renderOpinion(op, chartData.candles, chartRef.current, seriesRef.current);
      if (a) out.push(a);
    }

    // Render neutrals (session levels, round numbers) — only if shown
    for (const op of neutralOpinions) {
      if (!isShownOnChart(op.tactic)) continue;
      const a = renderOpinion(op, chartData.candles, chartRef.current, seriesRef.current);
      if (a) out.push(a);
    }

    return out;
  }, [contributingOpinions, neutralOpinions, chartData, tick, prefs, isActing]);

  if (!isActing) return null;

  return (
    <div
      ref={overlayRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none", // chart still reacts to mouse
        zIndex: 3,
        overflow: "hidden",
      }}
    >
      {annotations.map((a, i) => (
        <AnnotationShape
          key={a.key || i}
          annotation={a}
          onHover={setHoveredAnnotation}
        />
      ))}
      {hoveredAnnotation && (
        <AnnotationTooltip annotation={hoveredAnnotation} />
      )}
    </div>
  );
}

// Render a single opinion to overlay coordinates.
// Returns annotation object or null if can't be rendered (e.g. zone outside visible range).
function renderOpinion(op, candles, chart, series) {
  try {
    const lastCandle = candles[candles.length - 1];
    const lastTime = Math.floor(new Date(lastCandle.time).getTime() / 1000);
    const formedTime = Math.floor(op.formedAt / 1000);

    const dirColor = op.direction === "LONG" ? "rgba(0,230,118," : op.direction === "SHORT" ? "rgba(255,59,92," : "rgba(167,139,250,";

    // Order Block & Unfilled Imbalance: rectangles spanning from formation to current
    if ((op.tactic === "orderBlock" || op.tactic === "unfilledImbalance") && op.zone) {
      const xStart = chart.timeScale().timeToCoordinate(formedTime);
      const xEnd = chart.timeScale().timeToCoordinate(lastTime);
      const yUpper = series.priceToCoordinate(op.zone.upper);
      const yLower = series.priceToCoordinate(op.zone.lower);
      if (xStart == null || xEnd == null || yUpper == null || yLower == null) return null;

      return {
        type: "rect",
        key: `${op.tactic}-${formedTime}`,
        opinion: op,
        rect: {
          left: Math.min(xStart, xEnd),
          top: Math.min(yUpper, yLower),
          width: Math.abs(xEnd - xStart),
          height: Math.abs(yUpper - yLower),
        },
        fill: dirColor + "0.10)",
        border: dirColor + "0.35)",
        label: tacticLabel(op),
      };
    }

    // FVG: rectangle, fill opacity reflects fill %
    if (op.tactic === "fvg" && op.zone) {
      const xStart = chart.timeScale().timeToCoordinate(formedTime);
      const xEnd = chart.timeScale().timeToCoordinate(lastTime);
      const yUpper = series.priceToCoordinate(op.zone.upper);
      const yLower = series.priceToCoordinate(op.zone.lower);
      if (xStart == null || xEnd == null || yUpper == null || yLower == null) return null;

      const fillPercent = parseFloat(op.evidence?.fillPercent || "0");
      const opacity = (1 - fillPercent) * 0.18 + 0.04;

      return {
        type: "rect",
        key: `fvg-${formedTime}`,
        opinion: op,
        rect: {
          left: Math.min(xStart, xEnd),
          top: Math.min(yUpper, yLower),
          width: Math.abs(xEnd - xStart),
          height: Math.abs(yUpper - yLower),
        },
        fill: dirColor + opacity.toFixed(2) + ")",
        border: dirColor + "0.30)",
        label: tacticLabel(op) + " " + Math.round(fillPercent * 100) + "% filled",
      };
    }

    // BOS: horizontal line at broken level
    if (op.tactic === "bos") {
      const xStart = chart.timeScale().timeToCoordinate(formedTime);
      const xEnd = chart.timeScale().timeToCoordinate(lastTime);
      const y = series.priceToCoordinate(op.level);
      if (xStart == null || xEnd == null || y == null) return null;

      return {
        type: "line",
        key: `bos-${formedTime}`,
        opinion: op,
        line: {
          x1: Math.min(xStart, xEnd),
          x2: Math.max(xStart, xEnd),
          y1: y,
          y2: y,
        },
        color: dirColor + "0.7)",
        dashed: false,
        thickness: 2,
        label: "BOS " + (op.direction === "LONG" ? "↑" : "↓"),
      };
    }

    // Liquidity Sweep: marker at the sweep candle (small starburst)
    if (op.tactic === "liquiditySweep") {
      const x = chart.timeScale().timeToCoordinate(formedTime);
      const y = series.priceToCoordinate(op.level);
      if (x == null || y == null) return null;

      return {
        type: "marker",
        key: `sweep-${formedTime}`,
        opinion: op,
        x, y,
        symbol: "✦",
        color: dirColor + "0.9)",
        size: 14,
        label: "Sweep " + (op.direction === "LONG" ? "↑" : "↓"),
      };
    }

    // Session Levels & Round Numbers: dotted horizontal line
    if (op.tactic === "sessionLevel" || op.tactic === "roundNumber") {
      const lastIdx = candles.length - 1;
      const startTime = Math.floor(new Date(candles[Math.max(0, lastIdx - 100)].time).getTime() / 1000);
      const xStart = chart.timeScale().timeToCoordinate(startTime);
      const xEnd = chart.timeScale().timeToCoordinate(lastTime);
      const y = series.priceToCoordinate(op.level);
      if (xStart == null || xEnd == null || y == null) return null;

      const sessionType = op.evidence?.type || "";
      let color = "rgba(148,163,184,0.5)"; // default slate
      if (sessionType.startsWith("ASIAN")) color = "rgba(167,139,250,0.6)";
      else if (sessionType.startsWith("LONDON")) color = "rgba(34,211,238,0.6)";
      else if (sessionType.includes("PDH") || sessionType.includes("PDL")) color = "rgba(251,146,60,0.6)";
      else if (sessionType === "weeklyOpen") color = "rgba(245,158,11,0.6)";
      else if (op.tactic === "roundNumber") color = "rgba(100,116,139,0.4)";

      return {
        type: "line",
        key: `level-${op.tactic}-${op.level}`,
        opinion: op,
        line: {
          x1: Math.min(xStart, xEnd),
          x2: Math.max(xStart, xEnd),
          y1: y,
          y2: y,
        },
        color,
        dashed: true,
        thickness: 1,
        label: levelShortLabel(op),
      };
    }

    // Trend Structure: marker at last swing
    if (op.tactic === "trendStructure") {
      // Don't render — it's chart-wide context, not a specific point
      return null;
    }

    // Fakeout: marker at the failed breakout candle
    if (op.tactic === "fakeout") {
      const x = chart.timeScale().timeToCoordinate(formedTime);
      const y = series.priceToCoordinate(op.level);
      if (x == null || y == null) return null;

      return {
        type: "marker",
        key: `fakeout-${formedTime}`,
        opinion: op,
        x, y,
        symbol: op.direction === "LONG" ? "↗↘" : "↘↗",
        color: dirColor + "0.9)",
        size: 12,
        label: "Fakeout",
      };
    }

    return null;
  } catch (_) {
    return null;
  }
}

function tacticLabel(op) {
  const tfPart = op.timeframe.toUpperCase();
  switch (op.tactic) {
    case "orderBlock":        return `${tfPart} OB ${op.direction === "LONG" ? "↑" : "↓"}`;
    case "fvg":               return `${tfPart} FVG ${op.direction === "LONG" ? "↑" : "↓"}`;
    case "bos":               return `${tfPart} BOS ${op.direction === "LONG" ? "↑" : "↓"}`;
    case "liquiditySweep":    return `${tfPart} Sweep`;
    case "unfilledImbalance": return `${tfPart} Gap ${op.direction === "LONG" ? "↑" : "↓"}`;
    case "fakeout":           return `${tfPart} Fakeout`;
    default:                  return tfPart + " " + op.tactic;
  }
}

function levelShortLabel(op) {
  const t = op.evidence?.type || "";
  if (t === "ASIAN_HIGH") return "Asia H";
  if (t === "ASIAN_LOW") return "Asia L";
  if (t === "LONDON_HIGH") return "London H";
  if (t === "LONDON_LOW") return "London L";
  if (t === "PDH") return "PDH";
  if (t === "PDL") return "PDL";
  if (t === "weeklyOpen") return "Wk Open";
  if (op.tactic === "roundNumber") return op.level.toFixed(op.level > 100 ? 0 : 2);
  return t;
}

function AnnotationShape({ annotation, onHover }) {
  if (annotation.type === "rect") {
    return (
      <div
        style={{
          position: "absolute",
          left: annotation.rect.left,
          top: annotation.rect.top,
          width: annotation.rect.width,
          height: annotation.rect.height,
          background: annotation.fill,
          border: `1px dashed ${annotation.border}`,
          borderRadius: 2,
          pointerEvents: "auto",
          cursor: "help",
          transition: "opacity 200ms",
        }}
        onMouseEnter={() => onHover(annotation)}
        onMouseLeave={() => onHover(null)}
      >
        <div
          style={{
            position: "absolute",
            top: 2,
            left: 4,
            fontSize: 9,
            fontFamily: "var(--qb-font-mono)",
            color: annotation.border,
            fontWeight: 600,
            pointerEvents: "none",
            textShadow: "0 1px 2px rgba(0,0,0,0.8)",
          }}
        >
          {annotation.label}
        </div>
      </div>
    );
  }

  if (annotation.type === "line") {
    const { x1, x2, y } = annotation.line;
    const yPos = annotation.line.y1;
    return (
      <>
        <div
          style={{
            position: "absolute",
            left: x1,
            top: yPos - 1,
            width: x2 - x1,
            height: 2,
            background: annotation.dashed
              ? `repeating-linear-gradient(to right, ${annotation.color} 0 4px, transparent 4px 8px)`
              : annotation.color,
            pointerEvents: "auto",
            cursor: "help",
          }}
          onMouseEnter={() => onHover(annotation)}
          onMouseLeave={() => onHover(null)}
        />
        <div
          style={{
            position: "absolute",
            left: x2 + 4,
            top: yPos - 7,
            fontSize: 9,
            fontFamily: "var(--qb-font-mono)",
            color: annotation.color,
            fontWeight: 600,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            textShadow: "0 1px 2px rgba(0,0,0,0.8)",
          }}
        >
          {annotation.label}
        </div>
      </>
    );
  }

  if (annotation.type === "marker") {
    return (
      <div
        style={{
          position: "absolute",
          left: annotation.x - annotation.size / 2,
          top: annotation.y - annotation.size / 2,
          width: annotation.size,
          height: annotation.size,
          color: annotation.color,
          fontSize: annotation.size,
          textAlign: "center",
          lineHeight: 1,
          pointerEvents: "auto",
          cursor: "help",
          textShadow: "0 1px 3px rgba(0,0,0,0.9)",
        }}
        onMouseEnter={() => onHover(annotation)}
        onMouseLeave={() => onHover(null)}
      >
        {annotation.symbol}
      </div>
    );
  }

  return null;
}

function AnnotationTooltip({ annotation }) {
  const op = annotation.opinion;
  if (!op) return null;

  const explanation = TACTIC_DESCRIPTIONS[op.tactic] || "Detected pattern";
  const reasoning = buildReasoning(op);

  // Position tooltip near top-right of annotation, with bounds checking
  let left = 0, top = 0;
  if (annotation.type === "rect") {
    left = annotation.rect.left + annotation.rect.width + 8;
    top = annotation.rect.top;
  } else if (annotation.type === "line") {
    left = annotation.line.x2 + 8;
    top = annotation.line.y1 - 30;
  } else if (annotation.type === "marker") {
    left = annotation.x + annotation.size + 4;
    top = annotation.y - 30;
  }

  // Estimate viewport width (we're inside the chart container, so use parent's width if known)
  // Conservative: clamp to 1200 max horizontal, with 320px tooltip buffer
  const maxLeft = typeof window !== "undefined" ? window.innerWidth - 320 : 1200;
  if (left > maxLeft) {
    // Flip to left side of annotation
    if (annotation.type === "rect") left = annotation.rect.left - 308;
    else if (annotation.type === "line") left = annotation.line.x1 - 308;
    else if (annotation.type === "marker") left = annotation.x - 308;
  }
  left = Math.max(8, left);
  top = Math.max(8, top);

  return (
    <div
      className="qb-glass"
      style={{
        position: "absolute",
        left,
        top,
        maxWidth: 300,
        padding: "8px 10px",
        borderRadius: 4,
        fontSize: 11,
        color: "var(--qb-text-primary)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        pointerEvents: "none",
        zIndex: 10,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 3, fontSize: 12 }}>
        {tacticLabel(op)}
      </div>
      <div style={{ color: "var(--qb-text-muted)", marginBottom: 6, lineHeight: 1.4 }}>
        {explanation}
      </div>
      {reasoning && (
        <div style={{
          fontSize: 10,
          color: "var(--qb-accent)",
          paddingTop: 6,
          borderTop: "1px solid var(--qb-border)",
          fontFamily: "var(--qb-font-mono)",
          lineHeight: 1.5,
        }}>
          {reasoning}
        </div>
      )}
    </div>
  );
}

// Build the bot's specific reasoning for THIS opinion (the educational part)
function buildReasoning(op) {
  const ev = op.evidence || {};
  const lines = [];

  if (op.tactic === "orderBlock") {
    if (ev.impulseATR) lines.push(`Impulse: ${ev.impulseATR} ATR after the OB candle`);
    if (ev.bodyRatio) lines.push(`Body ratio: ${ev.bodyRatio}`);
    if (ev.bosConfirmed) lines.push(`Confirmed by BOS`);
    if (ev.barsAgo != null) lines.push(`Untested for ${ev.barsAgo} bars`);
  } else if (op.tactic === "fvg") {
    if (ev.gapSizeATR) lines.push(`Gap size: ${ev.gapSizeATR} ATR`);
    if (ev.fillPercent) lines.push(`${Math.round(parseFloat(ev.fillPercent) * 100)}% filled`);
  } else if (op.tactic === "bos") {
    if (ev.brokenLevel) lines.push(`Broke ${ev.brokenLevel.toFixed(ev.brokenLevel > 100 ? 2 : 5)}`);
    if (ev.displacementATR) lines.push(`Displacement: ${ev.displacementATR} ATR`);
  } else if (op.tactic === "liquiditySweep") {
    if (ev.rejectionRatio) lines.push(`Rejection: ${ev.rejectionRatio}`);
    if (ev.reversalATR) lines.push(`Reversal: ${ev.reversalATR} ATR`);
    if (ev.sweptLevelType) lines.push(`Swept: ${ev.sweptLevelType}`);
  } else if (op.tactic === "unfilledImbalance") {
    if (ev.gapSizeATR) lines.push(`Gap: ${ev.gapSizeATR} ATR`);
    if (ev.isWeekendGap) lines.push(`Weekend gap`);
  } else if (op.tactic === "fakeout") {
    if (ev.confirmations) lines.push(`${ev.confirmations} confirming bars`);
  } else if (op.tactic === "sessionLevel") {
    if (ev.type) lines.push(ev.type);
  } else if (op.tactic === "roundNumber") {
    if (ev.distanceATR) lines.push(`${ev.distanceATR} ATR ${ev.type === "roundAbove" ? "above" : "below"}`);
  }

  return lines.join(" · ");
}

function TFSelector({ selectedTF, onChange }) {
  const tfs = [
    { id: "1m", label: "1m" },
    { id: "5m", label: "5m" },
    { id: "15m", label: "15m" },
    { id: "1h", label: "1h" },
    { id: "4h", label: "4h" },
    { id: "1d", label: "1d" },
    { id: "1w", label: "1w" },
  ];
  return (
    <div className="qb-glass" style={{ display: "flex", borderRadius: 4, padding: 2, gap: 1 }}>
      {tfs.map((tf) => (
        <button
          key={tf.id}
          onClick={() => onChange(tf.id)}
          style={{
            background: selectedTF === tf.id ? "var(--qb-accent-soft)" : "transparent",
            border: "none",
            color: selectedTF === tf.id ? "var(--qb-accent)" : "var(--qb-text-muted)",
            padding: "4px 8px",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            borderRadius: 3,
            fontFamily: "var(--qb-font-mono)",
          }}
        >
          {tf.label}
        </button>
      ))}
    </div>
  );
}

function ToolsButton({ onClick, active }) {
  return (
    <button
      onClick={onClick}
      className="qb-glass"
      style={{
        background: active ? "var(--qb-accent-soft)" : undefined,
        color: active ? "var(--qb-accent)" : "var(--qb-text-muted)",
        border: "none",
        padding: "5px 8px",
        borderRadius: 4,
        fontSize: 11,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
      title="Tools — show/hide chart annotations"
    >
      🛠
    </button>
  );
}

// =====================================================================
// SECTION 9.8: COCKPIT — TOOLS POPOVER
// =====================================================================

function ToolsPopover({ theme, prefs, setPrefs, onClose }) {
  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest(".qb-tools-popover")) onClose();
    };
    setTimeout(() => document.addEventListener("click", handler), 0);
    return () => document.removeEventListener("click", handler);
  }, []);

  const updateToolConfig = (toolId, idx, value) => {
    setPrefs((p) => {
      const cur = (p.toolsConfig?.[toolId]) || [false, false];
      const next = [...cur];
      next[idx] = value;
      return { ...p, toolsConfig: { ...(p.toolsConfig || {}), [toolId]: next } };
    });
  };

  // Group: Show/Use checkboxes
  return (
    <div
      className="qb-glass qb-tools-popover"
      style={{
        position: "absolute",
        top: 36,
        left: 116,
        width: 280,
        borderRadius: 6,
        padding: 12,
        zIndex: 50,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        fontSize: 11, color: "var(--qb-text-muted)", textTransform: "uppercase",
        letterSpacing: 0.8, marginBottom: 8,
      }}>
        <span>Tools</span>
        <span style={{ display: "flex", gap: 16, fontSize: 9 }}>
          <span title="Drawn on chart">SHOW</span>
          <span title="Bot considers">USE</span>
        </span>
      </div>

      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        {Object.keys(TACTIC_LABELS).map((toolId) => {
          const cfg = prefs.toolsConfig?.[toolId] || [false, false];
          return (
            <div
              key={toolId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "5px 4px",
                fontSize: 12,
              }}
              title={TACTIC_DESCRIPTIONS[toolId]}
            >
              <span style={{ flex: 1, color: "var(--qb-text-primary)" }}>
                {TACTIC_LABELS[toolId]}
              </span>
              <div style={{ display: "flex", gap: 16 }}>
                <input
                  type="checkbox"
                  checked={cfg[0]}
                  onChange={(e) => updateToolConfig(toolId, 0, e.target.checked)}
                  style={{ accentColor: "var(--qb-accent)", cursor: "pointer" }}
                />
                <input
                  type="checkbox"
                  checked={cfg[1]}
                  onChange={(e) => updateToolConfig(toolId, 1, e.target.checked)}
                  style={{ accentColor: "var(--qb-accent)", cursor: "pointer" }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =====================================================================
// SECTION 9.9: COCKPIT — BOTTOM BAR
// =====================================================================

function CockpitBottomBar({ theme, open, onToggle, commentary, assetId }) {
  return (
    <>
      {/* Edge strip */}
      <div
        onClick={onToggle}
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 8,
          background: "var(--qb-border)",
          cursor: "pointer",
          zIndex: 5,
          transition: "background 200ms",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--qb-accent-soft)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "var(--qb-border)")}
        title={open ? "Collapse" : "Expand"}
      />

      {/* Content */}
      {open && (
        <div
          className="qb-glass"
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            right: 8,
            height: 60,
            zIndex: 6,
            padding: "8px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            justifyContent: "center",
            overflow: "hidden",
            borderTop: "1px solid var(--qb-border)",
          }}
        >
          {commentary.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--qb-text-dim)", fontStyle: "italic" }}>
              Bot is watching {assetId.toUpperCase()}... commentary will appear here once the engine is live (session 3-4).
            </div>
          ) : (
            commentary.slice(-3).map((c, i) => (
              <div
                key={i}
                style={{
                  fontSize: 12,
                  color: "var(--qb-text-primary)",
                  display: "flex",
                  gap: 12,
                  opacity: 1 - (commentary.slice(-3).length - 1 - i) * 0.25,
                }}
              >
                <span className="qb-mono" style={{ color: "var(--qb-text-muted)", minWidth: 50 }}>
                  {fmtTimeS(c.ts)}
                </span>
                <span>{c.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}

// =====================================================================
// SECTION 10: ASSET SELECTION MODAL
// =====================================================================

function AssetSelectionModal({ theme, watchlist, onAdd, onClose }) {
  const [search, setSearch] = useState("");
  const [resolverStatus, setResolverStatus] = useState(null);

  // Fetch the user's asset map from backend so we can show what's available
  useEffect(() => {
    fetch(API("symbol-resolver?action=status"))
      .then((r) => r.json())
      .then((data) => setResolverStatus(data))
      .catch(() => setResolverStatus({ error: "Backend not available" }));
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return ASSET_CATALOG;
    return ASSET_CATALOG.filter((a) =>
      a.id.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q)
    );
  }, [search]);

  const grouped = useMemo(() => {
    const out = {};
    for (const a of filtered) {
      if (!out[a.category]) out[a.category] = [];
      out[a.category].push(a);
    }
    return out;
  }, [filtered]);

  const mapped = resolverStatus?.mapped || [];
  const isMapped = (assetId) => mapped.includes(assetId);
  const isInWatchlist = (assetId) => watchlist.includes(assetId);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="qb-glass"
        style={{
          width: "min(90vw, 560px)",
          maxHeight: "85vh",
          borderRadius: 8,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Add instrument</div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "none",
              color: "var(--qb-text-muted)", cursor: "pointer",
              fontSize: 20, padding: 0, lineHeight: 1,
            }}
          >×</button>
        </div>

        {/* Resolver status */}
        {resolverStatus && (
          <div
            style={{
              fontSize: 11,
              padding: "6px 10px",
              borderRadius: 4,
              background: mapped.length > 0 ? "var(--qb-accent-soft)" : "var(--qb-down-soft)",
              color: mapped.length > 0 ? "var(--qb-accent)" : "var(--qb-down-strong)",
              border: `1px solid ${mapped.length > 0 ? "var(--qb-accent)" : "var(--qb-down-strong)"}`,
            }}
          >
            {resolverStatus.error
              ? `⚠ ${resolverStatus.error}`
              : mapped.length === 0
              ? "⚠ No broker symbols detected. Run /api/symbol-resolver?action=sync"
              : `✓ ${mapped.length} assets mapped to your broker`}
          </div>
        )}

        {/* Search */}
        <input
          type="text"
          placeholder="Search instruments..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          style={{
            background: "var(--qb-bg-layer)",
            border: "1px solid var(--qb-border)",
            borderRadius: 4,
            padding: "8px 12px",
            color: "var(--qb-text-primary)",
            fontSize: 13,
          }}
        />

        {/* List */}
        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {Object.entries(grouped).map(([cat, items]) => (
            <div key={cat}>
              <div style={{
                fontSize: 11, color: "var(--qb-text-muted)",
                textTransform: "uppercase", letterSpacing: 0.8,
                marginBottom: 6,
              }}>
                {CATEGORY_LABELS[cat] || cat}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {items.map((a) => {
                  const inWL = isInWatchlist(a.id);
                  const mapped_ = isMapped(a.id);
                  return (
                    <button
                      key={a.id}
                      onClick={() => !inWL && mapped_ && onAdd(a.id)}
                      disabled={inWL || !mapped_}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 12px",
                        background: inWL ? "var(--qb-accent-soft)" : !mapped_ ? "transparent" : "var(--qb-bg-layer)",
                        border: `1px solid ${inWL ? "var(--qb-accent)" : "var(--qb-border)"}`,
                        borderRadius: 4,
                        color: !mapped_ ? "var(--qb-text-dim)" : "var(--qb-text-primary)",
                        cursor: inWL || !mapped_ ? "default" : "pointer",
                        textAlign: "left",
                        opacity: !mapped_ ? 0.5 : 1,
                      }}
                    >
                      <div>
                        <div className="qb-mono" style={{ fontSize: 13, fontWeight: 600 }}>
                          {a.name}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--qb-text-muted)" }}>
                          {a.description}
                        </div>
                      </div>
                      <div style={{ fontSize: 10 }}>
                        {inWL ? <span style={{ color: "var(--qb-accent)" }}>✓ Added</span> :
                         !mapped_ ? <span style={{ color: "var(--qb-text-dim)" }}>not mapped</span> :
                         <span style={{ color: "var(--qb-accent)" }}>+ Add</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {Object.keys(grouped).length === 0 && (
            <div style={{ textAlign: "center", color: "var(--qb-text-muted)", padding: 20, fontSize: 12 }}>
              No matches.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// SECTION 11: PAUSE SETTINGS POPOVER
// =====================================================================

function PauseSettingsPopover({ theme, prefs, setPrefs, onClose }) {
  const ps = prefs.pauseSettings || {};

  const update = (k, v) => {
    setPrefs((p) => ({
      ...p,
      pauseSettings: { ...(p.pauseSettings || {}), [k]: v },
    }));
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999,
      }}
      onClick={onClose}
    >
      <div
        className="qb-glass"
        style={{
          width: "min(90vw, 360px)",
          borderRadius: 8,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Pause suggestion thresholds</div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "none",
              color: "var(--qb-text-muted)", cursor: "pointer",
              fontSize: 20, lineHeight: 1, padding: 0,
            }}
          >×</button>
        </div>

        <div style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>
          Bot suggests stopping when these limits are reached. Suggestions only — never enforced.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <NumberRow
            label="Daily loss"
            value={ps.suggestStopAfterDailyLoss}
            prefix="$"
            onChange={(v) => update("suggestStopAfterDailyLoss", v)}
          />
          <NumberRow
            label="Daily gain"
            value={ps.suggestStopAfterDailyGain}
            prefix="$"
            onChange={(v) => update("suggestStopAfterDailyGain", v)}
          />
          <NumberRow
            label="Losing streak"
            value={ps.suggestStopAfterLossStreak}
            suffix=" trades"
            onChange={(v) => update("suggestStopAfterLossStreak", v)}
          />
        </div>
      </div>
    </div>
  );
}

function NumberRow({ label, value, prefix, suffix, onChange }) {
  return (
    <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
      <span>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {prefix && <span style={{ color: "var(--qb-text-muted)", fontFamily: "var(--qb-font-mono)" }}>{prefix}</span>}
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          style={{
            width: 80,
            background: "var(--qb-bg-layer)",
            border: "1px solid var(--qb-border)",
            borderRadius: 4,
            padding: "5px 8px",
            color: "var(--qb-text-primary)",
            fontFamily: "var(--qb-font-mono)",
            fontSize: 12,
            textAlign: "right",
          }}
        />
        {suffix && <span style={{ color: "var(--qb-text-muted)", fontSize: 11 }}>{suffix}</span>}
      </div>
    </label>
  );
}

// =====================================================================
// SECTION 12: PORTFOLIO PAGE (skeleton — full design in later session)
// =====================================================================

function PortfolioPage({ prefs, theme, account, positions, onNavigate }) {
  const [tab, setTab] = useState("equity");

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <PageHeader
        title="Portfolio"
        onBack={() => onNavigate("cockpit")}
        tabs={[{ id: "equity", label: "Equity" }, { id: "instruments", label: "Instruments" }]}
        activeTab={tab}
        onTabChange={setTab}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        {tab === "equity" && <PortfolioEquityTab account={account} />}
        {tab === "instruments" && <PortfolioInstrumentsTab prefs={prefs} positions={positions} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}

function PortfolioEquityTab({ account }) {
  const balance = account?.balance ?? 10000;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Hero balance */}
      <div style={{ textAlign: "center", padding: "24px 0" }}>
        <div className="qb-mono" style={{ fontSize: 56, fontWeight: 700, color: "var(--qb-text-primary)", letterSpacing: -1 }}>
          ${balance.toFixed(2)}
        </div>
        <div style={{ fontSize: 13, color: "var(--qb-text-muted)", marginTop: 4 }}>
          Account balance
        </div>
      </div>

      {/* Equity curve placeholder */}
      <div className="qb-glass" style={{ padding: 20, borderRadius: 8, minHeight: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--qb-text-muted)" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 14, marginBottom: 4 }}>Equity curve</div>
          <div style={{ fontSize: 11, color: "var(--qb-text-dim)" }}>
            Will populate once V12 trades start closing (session 4)
          </div>
        </div>
      </div>

      {/* Period stats placeholder */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {["Today", "This week", "This month", "All-time"].map((label) => (
          <div key={label} className="qb-glass" style={{ padding: 16, borderRadius: 6, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "var(--qb-text-muted)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
              {label}
            </div>
            <div className="qb-mono" style={{ fontSize: 18, fontWeight: 600, color: "var(--qb-text-dim)" }}>
              --
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PortfolioInstrumentsTab({ prefs, positions, onNavigate }) {
  const watchlist = prefs.watchlist || [];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
      {watchlist.map((assetId) => {
        const meta = getAssetById(assetId);
        const pos = positions.find((p) => p.assetId === assetId);
        return (
          <div
            key={assetId}
            className="qb-glass qb-hover"
            onClick={() => { /* switch in cockpit */ onNavigate("cockpit"); }}
            style={{
              padding: 16,
              borderRadius: 6,
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div className="qb-mono" style={{ fontSize: 16, fontWeight: 700 }}>
                {assetId.toUpperCase()}
              </div>
              <div style={{ fontSize: 11, color: "var(--qb-text-muted)", marginTop: 2 }}>
                {meta?.name || ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              {pos ? (
                <>
                  <div className="qb-mono" style={{ color: pos.profit > 0 ? "var(--qb-up-strong)" : "var(--qb-down-strong)", fontSize: 14, fontWeight: 600 }}>
                    {fmtMoney(pos.profit)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>
                    {pos.volume} lot @ {fmtPrice(pos.openPrice)}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: "var(--qb-text-muted)" }}>No position</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =====================================================================
// SECTION 13: REPORTS PAGE (skeleton — full design in later session)
// =====================================================================

function ReportsPage({ prefs, theme, onNavigate }) {
  const [tab, setTab] = useState("performance");

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <PageHeader
        title="Reports"
        onBack={() => onNavigate("cockpit")}
        tabs={[
          { id: "performance", label: "Performance" },
          { id: "recognition", label: "Recognition" },
          { id: "activity", label: "Activity log" },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        <div className="qb-glass" style={{ padding: 40, borderRadius: 8, textAlign: "center", color: "var(--qb-text-muted)" }}>
          Reports populate once V12 trades and recognition data accumulate (session 4-5).
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// SECTION 14: SETTINGS PAGE
// =====================================================================

function SettingsPage({ prefs, setPrefs, theme, setTheme, onNavigate }) {
  const [tab, setTab] = useState("theme");

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <PageHeader
        title="Settings"
        onBack={() => onNavigate("cockpit")}
        tabs={[
          { id: "theme",   label: "Theme" },
          { id: "tools",   label: "Tools & Display" },
          { id: "account", label: "Account" },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        {tab === "theme" && <SettingsThemeTab theme={theme} setTheme={setTheme} />}
        {tab === "tools" && <SettingsToolsTab prefs={prefs} setPrefs={setPrefs} />}
        {tab === "account" && <SettingsAccountTab />}
      </div>
    </div>
  );
}

function SettingsThemeTab({ theme, setTheme }) {
  const colorEntries = [
    ["bgBase",       "Background base"],
    ["bgLayer",      "Background layer"],
    ["accent",       "Accent (glow color)"],
    ["upStrong",     "Up candle"],
    ["downStrong",   "Down candle"],
    ["textPrimary",  "Text primary"],
    ["textMuted",    "Text muted"],
  ];

  const reset = () => setTheme(DEFAULT_THEME);

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Color theme</div>
          <div style={{ fontSize: 11, color: "var(--qb-text-muted)", marginTop: 2 }}>
            Defaults: Crystal Black + Cyan + TradingView green/red
          </div>
        </div>
        <button
          onClick={reset}
          style={{
            background: "transparent",
            border: "1px solid var(--qb-border)",
            borderRadius: 4,
            padding: "6px 12px",
            color: "var(--qb-text-muted)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Reset to defaults
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {colorEntries.map(([key, label]) => (
          <ColorPickerRow
            key={key}
            label={label}
            value={theme[key]}
            onChange={(v) => setTheme({ ...theme, [key]: v })}
          />
        ))}
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Preview</div>
        <ThemePreview theme={theme} />
      </div>
    </div>
  );
}

function ColorPickerRow({ label, value, onChange }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="qb-glass" style={{ padding: 12, borderRadius: 6, display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ flex: 1, fontSize: 12 }}>{label}</div>
      <input
        type="color"
        value={value.startsWith("#") ? value : "#000000"}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 36, height: 28, border: "none", cursor: "pointer", background: "transparent" }}
      />
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange(draft)}
        onKeyDown={(e) => e.key === "Enter" && onChange(draft)}
        style={{
          width: 110,
          background: "var(--qb-bg-layer)",
          border: "1px solid var(--qb-border)",
          borderRadius: 4,
          padding: "5px 8px",
          fontFamily: "var(--qb-font-mono)",
          fontSize: 11,
          color: "var(--qb-text-primary)",
        }}
      />
    </div>
  );
}

function ThemePreview({ theme }) {
  return (
    <div style={{
      padding: 16,
      borderRadius: 6,
      background: theme.bgBase,
      border: "1px solid " + theme.border,
      display: "flex",
      gap: 12,
    }}>
      <div style={{
        background: theme.upStrong, color: "white",
        padding: "8px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600,
      }}>Up</div>
      <div style={{
        background: theme.downStrong, color: "white",
        padding: "8px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600,
      }}>Down</div>
      <div style={{
        background: "transparent", color: theme.accent,
        border: "1px solid " + theme.accent,
        padding: "8px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600,
        boxShadow: "0 0 12px " + theme.accentSoft,
      }}>Accent</div>
      <div style={{
        color: theme.textPrimary, padding: "8px 0", fontSize: 12,
      }}>Sample text</div>
      <div style={{
        color: theme.textMuted, padding: "8px 0", fontSize: 12,
      }}>Muted text</div>
    </div>
  );
}

function SettingsToolsTab({ prefs, setPrefs }) {
  const updateTool = (toolId, idx, value) => {
    setPrefs((p) => {
      const cur = (p.toolsConfig?.[toolId]) || [false, false];
      const next = [...cur];
      next[idx] = value;
      return { ...p, toolsConfig: { ...(p.toolsConfig || {}), [toolId]: next } };
    });
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Tools & Display</div>
        <div style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>
          Two checkboxes per tool: <strong>Show</strong> on chart, <strong>Use</strong> in bot's analysis. Independent.
        </div>
      </div>

      <div className="qb-glass" style={{ padding: 14, borderRadius: 6 }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontSize: 10, color: "var(--qb-text-muted)", textTransform: "uppercase",
          letterSpacing: 0.8, marginBottom: 10, paddingBottom: 8,
          borderBottom: "1px solid var(--qb-border)",
        }}>
          <span>Tool</span>
          <span style={{ display: "flex", gap: 32 }}>
            <span>SHOW</span>
            <span>USE</span>
          </span>
        </div>
        {Object.keys(TACTIC_LABELS).map((toolId) => {
          const cfg = prefs.toolsConfig?.[toolId] || [false, false];
          return (
            <div
              key={toolId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 0",
                fontSize: 13,
                borderBottom: "1px solid var(--qb-border)",
              }}
              title={TACTIC_DESCRIPTIONS[toolId]}
            >
              <div style={{ flex: 1 }}>
                <div>{TACTIC_LABELS[toolId]}</div>
                <div style={{ fontSize: 10, color: "var(--qb-text-muted)", marginTop: 2 }}>
                  {TACTIC_DESCRIPTIONS[toolId]}
                </div>
              </div>
              <div style={{ display: "flex", gap: 32 }}>
                <input
                  type="checkbox"
                  checked={cfg[0]}
                  onChange={(e) => updateTool(toolId, 0, e.target.checked)}
                  style={{ accentColor: "var(--qb-accent)", cursor: "pointer", width: 16, height: 16 }}
                />
                <input
                  type="checkbox"
                  checked={cfg[1]}
                  onChange={(e) => updateTool(toolId, 1, e.target.checked)}
                  style={{ accentColor: "var(--qb-accent)", cursor: "pointer", width: 16, height: 16 }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsAccountTab() {
  const [resolverStatus, setResolverStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const fetchStatus = useCallback(() => {
    fetch(API("symbol-resolver?action=status"))
      .then((r) => r.json())
      .then((data) => setResolverStatus(data))
      .catch((e) => setResolverStatus({ error: e.message }));
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await fetch(API("symbol-resolver?action=sync"));
      const data = await r.json();
      if (data.ok) {
        await fetchStatus();
      } else {
        alert("Sync failed: " + (data.error || "unknown error"));
      }
    } catch (e) {
      alert("Sync error: " + e.message);
    }
    setSyncing(false);
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Broker connection</div>
        <div style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>
          Quantum Bot uses MetaAPI to connect to your broker. Configure credentials via Vercel environment variables.
        </div>
      </div>

      <div className="qb-glass" style={{ padding: 16, borderRadius: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Symbol mapping</div>
          <button
            onClick={sync}
            disabled={syncing}
            style={{
              background: "var(--qb-accent-soft)",
              color: "var(--qb-accent)",
              border: "1px solid var(--qb-accent)",
              borderRadius: 4,
              padding: "6px 12px",
              fontSize: 11,
              cursor: syncing ? "wait" : "pointer",
              fontWeight: 600,
              opacity: syncing ? 0.6 : 1,
            }}
          >
            {syncing ? "Syncing..." : "Sync from broker"}
          </button>
        </div>

        {resolverStatus ? (
          <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {resolverStatus.error ? (
              <div style={{ color: "var(--qb-down-strong)" }}>
                {resolverStatus.error}
              </div>
            ) : (
              <>
                <div>
                  Mapped: <strong className="qb-mono">{resolverStatus.mappedCount || 0}</strong> assets
                  {resolverStatus.meta?.unmappedCount > 0 && (
                    <> · Unmapped broker symbols: <strong className="qb-mono">{resolverStatus.meta.unmappedCount}</strong></>
                  )}
                </div>
                {resolverStatus.meta?.syncedAt && (
                  <div style={{ color: "var(--qb-text-muted)" }}>
                    Last sync: {fmtRelTime(resolverStatus.meta.syncedAt)} ago
                  </div>
                )}
                {resolverStatus.currentMap && Object.keys(resolverStatus.currentMap).length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: "pointer", color: "var(--qb-text-muted)", fontSize: 11 }}>
                      View map ({Object.keys(resolverStatus.currentMap).length} entries)
                    </summary>
                    <div style={{ marginTop: 6, padding: 8, background: "var(--qb-bg-layer)", borderRadius: 4 }}>
                      {Object.entries(resolverStatus.currentMap).map(([asset, sym]) => (
                        <div key={asset} className="qb-mono" style={{ fontSize: 11, padding: "2px 0" }}>
                          {asset.padEnd(12)} → {sym}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>Loading...</div>
        )}
      </div>

      <div className="qb-glass" style={{ padding: 16, borderRadius: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Bot version</div>
        <div className="qb-mono" style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>
          Quantum Bot V12 (Session 2 — Cockpit shell)
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// SECTION 15: PAGE HEADER (shared by Portfolio, Reports, Settings)
// =====================================================================

function PageHeader({ title, onBack, tabs, activeTab, onTabChange }) {
  return (
    <div
      className="qb-glass"
      style={{
        height: 48,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 16px",
        borderBottom: "1px solid var(--qb-border)",
      }}
    >
      <button
        onClick={onBack}
        style={{
          background: "transparent",
          border: "1px solid var(--qb-border)",
          borderRadius: 4,
          padding: "5px 10px",
          color: "var(--qb-text-muted)",
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        ← Cockpit
      </button>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {tabs && (
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              style={{
                background: activeTab === t.id ? "var(--qb-accent-soft)" : "transparent",
                border: `1px solid ${activeTab === t.id ? "var(--qb-accent)" : "var(--qb-border)"}`,
                borderRadius: 4,
                padding: "5px 14px",
                color: activeTab === t.id ? "var(--qb-accent)" : "var(--qb-text-muted)",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}