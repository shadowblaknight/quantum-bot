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
// V12.4: lightweight-charts removed — cockpit is no longer chart-based.

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
      {page === "grid" && (
        <GridPage
          prefs={prefs}
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
  const [logoMenuOpen, setLogoMenuOpen] = useState(false);
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [pausePopoverOpen, setPausePopoverOpen] = useState(false);

  const selectedAsset = prefs.selectedAsset || "gold";
  const selectedAssetMeta = getAssetById(selectedAsset);
  const isPaused = prefs.pauseOnAsset?.[selectedAsset] || false;

  // V12.4: chart removed. We still poll candles as a fallback price source
  // (assetState.currentPrice is the primary source via the watcher tick).
  const [chartData, setChartData] = useState(null);
  // V12.4: live quotes for the cockpit price tape (sparkline)
  const [quotes, setQuotes] = useState(null);

  // Position on the selected asset (if any)
  const myPosition = positions.find((p) => p.assetId === selectedAsset) || null;

  // Fetch fallback price from broker candles
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(
          API(`broker?action=candles&asset=${selectedAsset}&tf=${prefs.selectedTF}&n=20`)
        ).then((r) => r.json());
        if (alive) setChartData(r);
      } catch (_) {}
    })();
    const id = setInterval(async () => {
      try {
        const r = await fetch(
          API(`broker?action=candles&asset=${selectedAsset}&tf=${prefs.selectedTF}&n=20`)
        ).then((r) => r.json());
        if (alive) setChartData(r);
      } catch (_) {}
    }, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [selectedAsset, prefs.selectedTF]);

  // V12.4: poll live quotes (M1 closes for sparkline) every 10s
  useEffect(() => {
    let alive = true;
    setQuotes(null); // clear when asset changes
    const tick = async () => {
      try {
        const r = await fetch(API(`quotes?asset=${selectedAsset}&limit=30`))
          .then((r) => r.json());
        if (alive && r && !r.error) setQuotes(r);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(id); };
  }, [selectedAsset]);

  // Persist sidebar state to prefs
  useEffect(() => {
    setPrefs((p) => ({ ...p, sideBarOpen }));
  }, [sideBarOpen]);

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

      {/* INSTRUMENT PANEL (V12.4: replaces chart) */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: sideBarOpen ? 280 : 18,
          right: 8,
          bottom: 16,
          transition: "left 250ms",
        }}
      >
        <CockpitInstrumentPanel
          theme={theme}
          prefs={prefs}
          assetId={selectedAsset}
          assetState={assetState}
          myPosition={myPosition}
          chartData={chartData}
          quotes={quotes}
        />
      </div>

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
    { id: "grid",      label: "Grid",      icon: "⊞" },
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
      {/* Edge strip — wider (16px) so it's actually clickable; glows on hover */}
      <div
        onClick={onToggle}
        style={{
          position: "absolute",
          top: 44,
          left: 0,
          width: 16,
          bottom: 76,
          background: open ? "var(--qb-accent-soft)" : "var(--qb-border)",
          cursor: "pointer",
          zIndex: 5,
          borderRight: open ? "1px solid var(--qb-accent)" : "none",
          transition: "border-color 200ms, background 200ms",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--qb-accent-soft)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = open ? "var(--qb-accent-soft)" : "var(--qb-border)")}
        title={open ? "Collapse sidebar" : "Open sidebar"}
      >
        {/* Visual indicator chevron */}
        <div
          style={{
            color: "var(--qb-accent)",
            fontSize: 10,
            opacity: 0.7,
            userSelect: "none",
            pointerEvents: "none",
          }}
        >
          {open ? "◂" : "▸"}
        </div>
      </div>

      {/* Side bar content */}
      {open && (
        <div
          className="qb-glass"
          style={{
            position: "absolute",
            top: 44,
            left: 16,
            width: 264,
            bottom: 76,
            zIndex: 6,
            padding: 10,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {/* Header with explicit close button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "var(--qb-text-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
              Watchlist
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
              {/* CLOSE BUTTON — explicit, large, easy to hit */}
              <button
                onClick={onToggle}
                style={{
                  background: "transparent",
                  border: "1px solid var(--qb-border)",
                  borderRadius: 3,
                  color: "var(--qb-text-muted)",
                  fontSize: 14,
                  padding: "1px 8px",
                  cursor: "pointer",
                  lineHeight: 1,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--qb-text-primary)";
                  e.currentTarget.style.borderColor = "var(--qb-accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--qb-text-muted)";
                  e.currentTarget.style.borderColor = "var(--qb-border)";
                }}
                title="Close sidebar"
              >
                ×
              </button>
            </div>
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
// SECTION 9.8b: COCKPIT — INSTRUMENT PANEL (V12.4)
// =====================================================================
// Replaces the chart. A professional flight-deck instrument panel showing:
//  - Current price + direction badge
//  - Quick status (intent, bias, coherence)
//  - Active setup (template, entry/SL/TPs, narrative)
//  - Detected tools (event timeline)
//  - Commentary feed
// User views actual price charts in MT5; this surfaces what only QB can see.

function CockpitInstrumentPanel({ theme, prefs, assetId, assetState, myPosition, chartData, quotes }) {
  const meta = getAssetById(assetId);
  const state = assetState?.state;
  const pending = (assetState?.pending || []).filter(
    (p) => p.status === "pending" || p.status === "placed"
  );
  const commentary = assetState?.commentary || [];
  const events = state?.events || [];
  const intent = state?.intent || (assetState ? "AWAITING" : "—");
  const coherence = state?.coherence;

  // Current price preference: quotes (freshest) > state.currentPrice > chartData last close
  const currentPrice =
    quotes?.price ??
    state?.currentPrice ??
    (chartData?.candles?.length
      ? chartData.candles[chartData.candles.length - 1].close
      : null);

  // Direction inferred from active pending setup OR coherence intent
  const activeSetup = pending[0] || null;
  const bias = activeSetup?.direction || coherence?.bias || "NEUTRAL";
  const biasColor =
    bias === "LONG"
      ? "var(--qb-up-strong)"
      : bias === "SHORT"
      ? "var(--qb-down-strong)"
      : "var(--qb-text-muted)";

  // Sparkline direction follows actual price movement, not bias intent
  const sparkColor =
    quotes && quotes.change != null
      ? quotes.change >= 0
        ? "var(--qb-up-strong)"
        : "var(--qb-down-strong)"
      : "var(--qb-text-muted)";

  // Determine status badge
  const status = myPosition
    ? "IN TRADE"
    : activeSetup
    ? activeSetup.status === "placed"
      ? "ORDER LIVE"
      : "SETUP PENDING"
    : intent === "WATCH"
    ? "WATCHING"
    : intent === "AWAITING"
    ? "AWAITING"
    : intent;

  // Format a price for the asset's pipSize precision
  const fmt = (n) => {
    if (n == null || !isFinite(n)) return "—";
    if (!meta) return n.toFixed(2);
    const decimals =
      meta.pipSize >= 1 ? 2 : meta.pipSize >= 0.01 ? 2 : meta.pipSize >= 0.0001 ? 5 : 4;
    return n.toFixed(decimals);
  };

  // Recent interesting events for the timeline
  const interestingEvents = events
    .filter((e) => ["sweep", "mss", "bos", "fvg-created", "ob-created", "breaker-created", "displacement", "ote-zone-entered"].includes(e.type))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 14);

  return (
    <div
      className="qb-glass"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* ── HEADER: ASSET + PRICE + SPARKLINE + DIRECTION ─────────────────── */}
      <div
        style={{
          padding: "14px 20px 12px",
          borderBottom: "1px solid var(--qb-border)",
          display: "flex",
          alignItems: "flex-end",
          gap: 20,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--qb-text-muted)", letterSpacing: 1, textTransform: "uppercase" }}>
              {meta?.id || assetId}
            </span>
            <span style={{ fontSize: 10, color: "var(--qb-text-faint)" }}>
              {meta?.displayName}
            </span>
          </div>
          <div
            className="qb-mono"
            style={{
              fontSize: 36,
              fontWeight: 200,
              lineHeight: 1,
              color: "var(--qb-text-primary)",
              letterSpacing: -0.5,
            }}
          >
            {fmt(currentPrice)}
          </div>
          {quotes && quotes.change != null && (
            <div
              className="qb-mono"
              style={{
                fontSize: 11,
                color: sparkColor,
                marginTop: 2,
              }}
            >
              {quotes.change >= 0 ? "▲" : "▼"} {Math.abs(quotes.change).toFixed(2)}%
              <span style={{ color: "var(--qb-text-faint)", marginLeft: 6 }}>
                · last {quotes.candleCount || 0}m
              </span>
            </div>
          )}
        </div>

        {/* SPARKLINE */}
        <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center" }}>
          <PriceSparkline
            history={quotes?.history || []}
            color={sparkColor}
            width={240}
            height={56}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <span
            style={{
              fontSize: 11,
              color: biasColor,
              fontFamily: "var(--qb-font-mono)",
              letterSpacing: 1,
              padding: "3px 10px",
              border: `1px solid ${biasColor}`,
              borderRadius: 3,
            }}
          >
            {bias}
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--qb-text-muted)",
              letterSpacing: 0.8,
              textTransform: "uppercase",
            }}
          >
            {status}
          </span>
        </div>
      </div>

      {/* ── QUICK STATUS: 3-COLUMN INSTRUMENT READOUT ─────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 0,
          borderBottom: "1px solid var(--qb-border)",
        }}
      >
        <ReadoutCell
          label="Bias TF"
          value={state?.atrByTF?.["1h"] ? "H1 trend" : "—"}
          sub={
            events.find((e) => e.type === "trend" && e.timeframe === "1h")?.direction ||
            "neutral"
          }
        />
        <ReadoutCell
          label="Coherence"
          value={coherence?.intent || (activeSetup ? "MATCH" : "NO MATCH")}
          sub={coherence?.advice?.slice(0, 28) || `${events.length} events`}
        />
        <ReadoutCell
          label="Killzone"
          value={state?.session?.killZone || assetState?.session?.killZone || "—"}
          sub={state?.session?.window?.toLowerCase() || ""}
        />
      </div>

      {/* ── ACTIVE SETUP PANEL ─────────────────────────────────────────────── */}
      {activeSetup && (
        <div
          style={{
            padding: "12px 20px",
            borderBottom: "1px solid var(--qb-border)",
            background: "var(--qb-bg-glass)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span
              style={{
                fontSize: 11,
                color: "var(--qb-accent)",
                letterSpacing: 1,
                textTransform: "uppercase",
                fontFamily: "var(--qb-font-mono)",
              }}
            >
              ⚡ {activeSetup.setup?.templateName || activeSetup.templateName || "setup"}
            </span>
            <span style={{ fontSize: 10, color: biasColor }}>
              {activeSetup.setup?.direction || activeSetup.direction}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 9,
                color: "var(--qb-text-muted)",
                fontFamily: "var(--qb-font-mono)",
                letterSpacing: 0.5,
              }}
            >
              {activeSetup.status?.toUpperCase()}
            </span>
          </div>

          <SetupPrices setup={activeSetup.setup || activeSetup} fmt={fmt} />

          {(activeSetup.setup?.narrative || activeSetup.narrative)?.length > 0 && (
            <div
              style={{
                marginTop: 8,
                padding: "8px 10px",
                background: "var(--qb-bg-base)",
                border: "1px solid var(--qb-border)",
                borderRadius: 3,
                fontSize: 11,
                color: "var(--qb-text-muted)",
                fontFamily: "var(--qb-font-mono)",
                lineHeight: 1.5,
              }}
            >
              {(activeSetup.setup?.narrative || activeSetup.narrative).map((line, i) => (
                <div key={i}>· {line}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── DETECTED TOOLS TIMELINE ────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div
          style={{
            padding: "10px 20px 6px",
            fontSize: 10,
            color: "var(--qb-text-faint)",
            letterSpacing: 1,
            textTransform: "uppercase",
            fontFamily: "var(--qb-font-mono)",
          }}
        >
          Detected tools · {interestingEvents.length}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 12px" }}>
          {interestingEvents.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--qb-text-faint)", textAlign: "center" }}>
              No structural tools detected yet — waiting for events.
            </div>
          )}
          {interestingEvents.map((e, i) => (
            <EventRow key={i} event={e} fmt={fmt} />
          ))}
        </div>
      </div>

      {/* ── COMMENTARY FEED (replaces BottomBar) ───────────────────────────── */}
      {commentary.length > 0 && (
        <div
          style={{
            borderTop: "1px solid var(--qb-border)",
            padding: "8px 20px 10px",
            maxHeight: 110,
            overflowY: "auto",
            background: "var(--qb-bg-base)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--qb-text-faint)",
              letterSpacing: 1,
              textTransform: "uppercase",
              fontFamily: "var(--qb-font-mono)",
              marginBottom: 4,
            }}
          >
            Commentary
          </div>
          {commentary.slice(0, 8).map((c, i) => (
            <div
              key={i}
              style={{
                fontSize: 10,
                color: "var(--qb-text-muted)",
                fontFamily: "var(--qb-font-mono)",
                lineHeight: 1.6,
                display: "flex",
                gap: 8,
              }}
            >
              <span style={{ color: "var(--qb-text-faint)" }}>
                {c.ts ? new Date(c.ts).toLocaleTimeString().slice(0, 5) : "--:--"}
              </span>
              <span>{c.msg || c.message || c.text || JSON.stringify(c).slice(0, 60)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Small reusable cell for the 3-column status row
function ReadoutCell({ label, value, sub }) {
  return (
    <div
      style={{
        padding: "10px 16px",
        borderRight: "1px solid var(--qb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: "var(--qb-text-faint)",
          letterSpacing: 1,
          textTransform: "uppercase",
          fontFamily: "var(--qb-font-mono)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--qb-text-primary)",
          fontFamily: "var(--qb-font-mono)",
        }}
      >
        {value || "—"}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 10,
            color: "var(--qb-text-muted)",
            fontFamily: "var(--qb-font-mono)",
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// Setup price row (entry/SL/TPs) formatted in a clean horizontal grid
function SetupPrices({ setup, fmt }) {
  if (!setup) return null;
  const tps = setup.tps || [];
  const slDist = Math.abs((setup.entry || 0) - (setup.sl || 0));
  const tp1 = tps[0];
  const rr = tp1 && slDist > 0 ? Math.abs(tp1.price - setup.entry) / slDist : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 8,
        fontFamily: "var(--qb-font-mono)",
        fontSize: 11,
      }}
    >
      <PriceCell label="Entry" value={fmt(setup.entry)} color="var(--qb-text-primary)" />
      <PriceCell label="SL" value={fmt(setup.sl)} color="var(--qb-down-strong)" />
      <PriceCell label="TP1" value={tp1 ? fmt(tp1.price) : "—"} color="var(--qb-up-strong)" />
      <PriceCell label="R:R" value={rr ? rr.toFixed(2) : "—"} color="var(--qb-accent)" />
    </div>
  );
}

function PriceCell({ label, value, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: "var(--qb-text-faint)", letterSpacing: 0.6, textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ fontSize: 13, color, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// Pure-SVG price tape. Last value gets a glowing dot. Subtle area fill below.
// No charting library — small enough to be a single function.
function PriceSparkline({ history, color, width = 200, height = 40 }) {
  if (!history || history.length < 2) {
    return (
      <div
        style={{
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--qb-text-faint)",
          fontSize: 10,
          fontFamily: "var(--qb-font-mono)",
          letterSpacing: 1,
        }}
      >
        ─ no tape ─
      </div>
    );
  }

  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;
  const padY = 4;

  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1)) * width;
    const y = height - padY - ((v - min) / range) * (height - 2 * padY);
    return [x, y];
  });

  const linePath = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(" ");
  // Area fill: extend down to bottom and close back to start
  const areaPath =
    linePath +
    ` L ${pts[pts.length - 1][0]} ${height} L ${pts[0][0]} ${height} Z`;

  const last = pts[pts.length - 1];

  const gradId = `qb-spark-grad-${Math.floor(Math.random() * 1e6)}`;

  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} opacity={0.95} strokeLinejoin="round" strokeLinecap="round" />
      {/* Last value pulse dot */}
      <circle cx={last[0]} cy={last[1]} r={3} fill={color} opacity={0.3} />
      <circle cx={last[0]} cy={last[1]} r={1.8} fill={color} />
    </svg>
  );
}

// One row in the detected-tools timeline
function EventRow({ event, fmt }) {
  const colors = {
    sweep: "#ffb74d",
    mss: "#4fc3f7",
    bos: "#42a5f5",
    "fvg-created": event.direction === "LONG" ? "#66bb6a" : "#ef5350",
    "ob-created": "#ba68c8",
    "breaker-created": "#ff9800",
    displacement: "#ffee58",
    "ote-zone-entered": "#26c6da",
  };
  const labels = {
    sweep: "SWEEP",
    mss: "MSS",
    bos: "BOS",
    "fvg-created": "FVG",
    "ob-created": "OB",
    "breaker-created": "BREAKER",
    displacement: "DISP",
    "ote-zone-entered": "OTE",
  };
  const color = colors[event.type] || "#9e9e9e";
  const label = labels[event.type] || event.type;

  // Extract a useful "level" from evidence/zone
  const level =
    event.zone?.upper != null && event.zone?.lower != null
      ? `${fmt(event.zone.lower)}-${fmt(event.zone.upper)}`
      : event.evidence?.wickHigh != null
      ? `H ${fmt(event.evidence.wickHigh)}`
      : event.evidence?.wickLow != null
      ? `L ${fmt(event.evidence.wickLow)}`
      : event.evidence?.brokenLevel != null
      ? fmt(event.evidence.brokenLevel)
      : event.price != null
      ? fmt(event.price)
      : "—";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "56px 36px 70px 56px 1fr",
        gap: 8,
        padding: "5px 0",
        fontSize: 10,
        fontFamily: "var(--qb-font-mono)",
        borderBottom: "1px solid rgba(255,255,255,0.03)",
        alignItems: "center",
      }}
    >
      <span style={{ color: "var(--qb-text-faint)" }}>
        {event.ts ? new Date(event.ts).toLocaleTimeString().slice(0, 5) : "—"}
      </span>
      <span style={{ color: "var(--qb-text-muted)", letterSpacing: 0.5 }}>
        {event.timeframe || "—"}
      </span>
      <span
        style={{
          color,
          letterSpacing: 0.8,
          fontWeight: 500,
          padding: "1px 4px",
          background: `${color}15`,
          borderRadius: 2,
          textAlign: "center",
        }}
      >
        {label}
      </span>
      <span title={`${event.direction || ""} ${label}`}>
        <EventMockup event={event} color={color} width={52} height={24} />
      </span>
      <span style={{ color: "var(--qb-text-primary)" }}>{level}</span>
    </div>
  );
}

// =====================================================================
// EVENT MOCKUP — tiny inline SVGs showing how each tool is drawn on a chart.
// One per ICT event type, with direction encoded visually so no separate arrow
// is needed. Each glyph is canonical to how ICT practitioners would mark it.
// =====================================================================
function EventMockup({ event, color, width = 50, height = 24 }) {
  const isLong = event.direction === "LONG";
  const isShort = event.direction === "SHORT";
  const svgProps = { width, height, style: { display: "block" } };

  switch (event.type) {
    case "sweep": {
      // Swept extreme: a wick pokes past a dashed level, body closes back inside.
      // SHORT sweep = high taken (wick up). LONG sweep = low taken (wick down).
      const levelY = isShort ? height * 0.18 : height * 0.82;
      const wickX = width * 0.62;
      const wickTop = isShort ? 2 : height * 0.45;
      const wickBot = isShort ? height * 0.55 : height - 2;
      const bodyY = isShort ? height * 0.45 : height * 0.35;
      return (
        <svg {...svgProps}>
          <line x1="2" y1={levelY} x2={width - 2} y2={levelY}
                stroke={color} strokeWidth="1" strokeDasharray="2,2" opacity="0.55" />
          <line x1={wickX} y1={wickTop} x2={wickX} y2={wickBot}
                stroke={color} strokeWidth="1.2" />
          <rect x={wickX - 3} y={bodyY} width="6" height={height * 0.22}
                fill={color} opacity="0.85" />
          {/* Small "x" mark where the wick crosses the level */}
          <circle cx={wickX} cy={levelY} r="1.6" fill="none" stroke={color} strokeWidth="1" />
        </svg>
      );
    }

    case "mss":
    case "bos": {
      // Break of structure: small candles tracking one way, then a big body
      // crossing a dashed structural level the other way.
      const levelY = isShort ? height * 0.5 : height * 0.5;
      const arrowTipY = isShort ? height * 0.92 : height * 0.08;
      const arrowBaseY = isShort ? height * 0.65 : height * 0.35;
      return (
        <svg {...svgProps}>
          <line x1="2" y1={levelY} x2={width - 2} y2={levelY}
                stroke={color} strokeWidth="1" strokeDasharray="2,2" opacity="0.55" />
          <rect x="4"  y={isShort ? height * 0.42 : height * 0.4}  width="3" height={height * 0.15} fill={color} opacity="0.35" />
          <rect x="11" y={isShort ? height * 0.35 : height * 0.45} width="3" height={height * 0.18} fill={color} opacity="0.45" />
          <rect x="19" y={isShort ? height * 0.28 : height * 0.2}  width="5" height={height * 0.55} fill={color} opacity="0.95" />
          {/* Arrow showing break direction */}
          <path d={isShort
            ? `M ${width - 14} ${arrowBaseY} L ${width - 6} ${arrowBaseY} L ${width - 10} ${arrowTipY} Z`
            : `M ${width - 14} ${arrowBaseY} L ${width - 6} ${arrowBaseY} L ${width - 10} ${arrowTipY} Z`}
                fill={color} />
        </svg>
      );
    }

    case "fvg-created": {
      // 3-candle ICT FVG: gap between candle1 wick and candle3 wick, candle2 is
      // the displacement that opened the gap. Shaded zone shows the imbalance.
      const c1x = width * 0.22;
      const c2x = width * 0.5;
      const c3x = width * 0.78;
      const cw = 4;
      if (isLong) {
        const c1Top = height * 0.55, c1Bot = height * 0.85;
        const c2Top = height * 0.15, c2Bot = height * 0.85;
        const c3Top = height * 0.15, c3Bot = height * 0.45;
        return (
          <svg {...svgProps}>
            <rect x={c1x} y={c1Top} width={c3x - c1x + cw} height={c3Bot - c1Top}
                  fill={color} opacity="0.18" />
            <rect x={c1x - cw / 2} y={c1Top} width={cw} height={c1Bot - c1Top} fill={color} opacity="0.6" />
            <rect x={c2x - cw / 2} y={c2Top} width={cw} height={c2Bot - c2Top} fill={color} opacity="0.95" />
            <rect x={c3x - cw / 2} y={c3Top} width={cw} height={c3Bot - c3Top} fill={color} opacity="0.6" />
          </svg>
        );
      }
      const c1Top = height * 0.15, c1Bot = height * 0.45;
      const c2Top = height * 0.15, c2Bot = height * 0.85;
      const c3Top = height * 0.55, c3Bot = height * 0.85;
      return (
        <svg {...svgProps}>
          <rect x={c1x} y={c1Bot} width={c3x - c1x + cw} height={c3Top - c1Bot}
                fill={color} opacity="0.18" />
          <rect x={c1x - cw / 2} y={c1Top} width={cw} height={c1Bot - c1Top} fill={color} opacity="0.6" />
          <rect x={c2x - cw / 2} y={c2Top} width={cw} height={c2Bot - c2Top} fill={color} opacity="0.95" />
          <rect x={c3x - cw / 2} y={c3Top} width={cw} height={c3Bot - c3Top} fill={color} opacity="0.6" />
        </svg>
      );
    }

    case "ob-created": {
      // ICT Order Block: last opposite-direction candle before impulse, boxed.
      const oppFill = isLong ? "#ef5350" : "#66bb6a";
      return (
        <svg {...svgProps}>
          <rect x="4" y={height * 0.3} width="6" height={height * 0.4}
                fill={oppFill} opacity="0.7" stroke={color} strokeWidth="1" strokeDasharray="2,1" />
          <rect x="15" y={isLong ? height * 0.22 : height * 0.3}  width="4" height={height * 0.48} fill={color} opacity="0.55" />
          <rect x="22" y={isLong ? height * 0.14 : height * 0.38} width="4" height={height * 0.55} fill={color} opacity="0.75" />
          <rect x="29" y={isLong ? height * 0.08 : height * 0.45} width="4" height={height * 0.6}  fill={color} opacity="0.95" />
        </svg>
      );
    }

    case "breaker-created": {
      // Breaker: an old OB that got broken & retested, now flipped role.
      const lvlY = isLong ? height * 0.55 : height * 0.45;
      return (
        <svg {...svgProps}>
          {/* Old broken OB (greyed) */}
          <rect x="4" y={height * 0.3} width="6" height={height * 0.4}
                fill="#888" opacity="0.35" stroke="#888" strokeWidth="0.8" strokeDasharray="2,1" />
          <line x1="4"  y1={height * 0.3} x2="10" y2={height * 0.7} stroke="#888" strokeWidth="0.8" opacity="0.7" />
          <line x1="10" y1={height * 0.3} x2="4"  y2={height * 0.7} stroke="#888" strokeWidth="0.8" opacity="0.7" />
          {/* Break candle in new direction */}
          <rect x="16" y={isLong ? height * 0.15 : height * 0.4} width="5" height={height * 0.55} fill={color} opacity="0.95" />
          {/* New role level (price now respects it from the other side) */}
          <line x1={width * 0.5} y1={lvlY} x2={width - 2} y2={lvlY}
                stroke={color} strokeWidth="1.5" />
          <circle cx={width - 5} cy={lvlY} r="1.5" fill={color} />
        </svg>
      );
    }

    case "displacement": {
      // A single long-body candle with an arrow showing aggressive direction
      return (
        <svg {...svgProps}>
          <rect x={width * 0.12} y={height * 0.4} width="3" height={height * 0.2} fill={color} opacity="0.3" />
          <rect x={width * 0.26} y={height * 0.4} width="3" height={height * 0.2} fill={color} opacity="0.4" />
          {/* Aggressive candle */}
          <rect x={width * 0.42} y={height * 0.1} width="6" height={height * 0.8}
                fill={color} opacity="0.95" />
          {/* Arrow */}
          {isLong ? (
            <path d={`M ${width * 0.72} ${height * 0.5}
                      L ${width * 0.92} ${height * 0.25}
                      L ${width * 0.92} ${height * 0.42}
                      L ${width * 0.82} ${height * 0.42}
                      L ${width * 0.82} ${height * 0.58}
                      L ${width * 0.92} ${height * 0.58}
                      L ${width * 0.92} ${height * 0.75} Z`}
                  fill={color} opacity="0.85" />
          ) : (
            <path d={`M ${width * 0.72} ${height * 0.5}
                      L ${width * 0.92} ${height * 0.75}
                      L ${width * 0.92} ${height * 0.58}
                      L ${width * 0.82} ${height * 0.58}
                      L ${width * 0.82} ${height * 0.42}
                      L ${width * 0.92} ${height * 0.42}
                      L ${width * 0.92} ${height * 0.25} Z`}
                  fill={color} opacity="0.85" />
          )}
        </svg>
      );
    }

    case "ote-zone-entered": {
      // Impulse leg + retracement into 62-79% fib zone
      if (isLong) {
        return (
          <svg {...svgProps}>
            <line x1="3" y1={height - 3} x2={width * 0.45} y2={3}
                  stroke={color} strokeWidth="1.5" opacity="0.9" />
            <rect x={width * 0.42} y={height * 0.55} width={width * 0.55} height={height * 0.25}
                  fill={color} opacity="0.22" />
            <line x1={width * 0.42} y1={height * 0.6}  x2={width - 2} y2={height * 0.6}
                  stroke={color} strokeWidth="0.5" strokeDasharray="1,2" opacity="0.7" />
            <line x1={width * 0.42} y1={height * 0.78} x2={width - 2} y2={height * 0.78}
                  stroke={color} strokeWidth="0.5" strokeDasharray="1,2" opacity="0.7" />
            <line x1={width * 0.45} y1={3} x2={width * 0.88} y2={height * 0.7}
                  stroke={color} strokeWidth="1" opacity="0.55" strokeDasharray="2,1" />
            <circle cx={width * 0.88} cy={height * 0.7} r="1.8" fill={color} />
          </svg>
        );
      }
      return (
        <svg {...svgProps}>
          <line x1="3" y1={3} x2={width * 0.45} y2={height - 3}
                stroke={color} strokeWidth="1.5" opacity="0.9" />
          <rect x={width * 0.42} y={height * 0.2} width={width * 0.55} height={height * 0.25}
                fill={color} opacity="0.22" />
          <line x1={width * 0.42} y1={height * 0.22} x2={width - 2} y2={height * 0.22}
                stroke={color} strokeWidth="0.5" strokeDasharray="1,2" opacity="0.7" />
          <line x1={width * 0.42} y1={height * 0.4}  x2={width - 2} y2={height * 0.4}
                stroke={color} strokeWidth="0.5" strokeDasharray="1,2" opacity="0.7" />
          <line x1={width * 0.45} y1={height - 3} x2={width * 0.88} y2={height * 0.3}
                stroke={color} strokeWidth="1" opacity="0.55" strokeDasharray="2,1" />
          <circle cx={width * 0.88} cy={height * 0.3} r="1.8" fill={color} />
        </svg>
      );
    }

    default:
      return <div style={{ width, height }} />;
  }
}

// =====================================================================
// SECTION 9.9: COCKPIT — BOTTOM BAR (V12.4: kept for backward compat, no longer rendered)
// =====================================================================

function CockpitBottomBar({ theme, open, onToggle, commentary, assetId, assetState }) {
  // V12.3: state has events (typed) instead of opinions (tactic-keyed)
  const events = assetState?.state?.events || [];
  // Show recent meaningful events: sweep/displacement/mss/bos/fvg/ob/breaker/asian-range/ote/trend
  const interestingEvents = events
    .filter((e) => e.type !== 'session-level' && e.type !== 'trend')
    .slice(-12)
    .reverse();
  const recent = (commentary || []).slice(-6); // last 6 commentary lines

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
          height: 12,
          background: open ? "var(--qb-accent-soft)" : "var(--qb-border)",
          cursor: "pointer",
          zIndex: 5,
          transition: "background 200ms",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--qb-accent-soft)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = open ? "var(--qb-accent-soft)" : "var(--qb-border)")}
        title={open ? "Collapse activity feed" : "Expand activity feed"}
      >
        <div style={{ color: "var(--qb-accent)", fontSize: 10, opacity: 0.7, userSelect: "none", pointerEvents: "none" }}>
          {open ? "▾" : "▴"}
        </div>
      </div>

      {/* Content */}
      {open && (
        <div
          className="qb-glass"
          style={{
            position: "absolute",
            bottom: 12,
            left: 8,
            right: 8,
            height: 86,
            zIndex: 6,
            padding: "8px 14px",
            display: "flex",
            gap: 14,
            overflow: "hidden",
            borderTop: "1px solid var(--qb-border)",
          }}
        >
          {/* LEFT: Commentary feed */}
          <div style={{
            flex: "1 1 0%",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            overflow: "hidden",
          }}>
            <div style={{
              fontSize: 9,
              color: "var(--qb-text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.8,
              marginBottom: 2,
            }}>
              Activity
            </div>
            {recent.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--qb-text-dim)", fontStyle: "italic" }}>
                Watching {assetId.toUpperCase()}. Activity will appear when bot detects setups, fills, TP/SL hits.
              </div>
            ) : (
              <div style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                overflowY: "auto",
              }}>
                {recent.slice().reverse().map((c, i) => (
                  <div
                    key={`${c.ts}-${i}`}
                    style={{
                      fontSize: 11,
                      color: "var(--qb-text-primary)",
                      display: "flex",
                      gap: 10,
                      opacity: 1 - i * 0.12,
                    }}
                  >
                    <span className="qb-mono" style={{ color: "var(--qb-text-muted)", minWidth: 48, fontSize: 10 }}>
                      {fmtTimeS(c.ts)}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.text}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* DIVIDER */}
          <div style={{ width: 1, background: "var(--qb-border)" }} />

          {/* RIGHT: Recent events */}
          <div style={{
            flex: "0 0 280px",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            overflow: "hidden",
          }}>
            <div style={{
              fontSize: 9,
              color: "var(--qb-text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.8,
              marginBottom: 2,
            }}>
              Recent events on {assetId.toUpperCase()}
            </div>
            {interestingEvents.length > 0 ? (
              <div style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 3,
                overflow: "hidden",
              }}>
                {interestingEvents.slice(0, 10).map((ev, i) => {
                  const dirColor = ev.direction === "LONG" ? "var(--qb-up-strong)"
                    : ev.direction === "SHORT" ? "var(--qb-down-strong)"
                    : "var(--qb-text-muted)";
                  const dirChar = ev.direction === "LONG" ? "↑" : ev.direction === "SHORT" ? "↓" : "·";
                  // Pretty event labels
                  const eventLabel = {
                    'sweep': 'Sweep',
                    'displacement': 'Displ',
                    'mss': 'MSS',
                    'bos': 'BOS',
                    'fvg-created': 'FVG',
                    'ob-created': 'OB',
                    'breaker-created': 'Breaker',
                    'asian-range-formed': 'Asian',
                    'ote-zone-entered': 'OTE',
                  }[ev.type] || ev.type;
                  return (
                    <div
                      key={ev.id || i}
                      style={{
                        display: "flex",
                        gap: 4,
                        alignItems: "center",
                        padding: "2px 6px",
                        fontSize: 9,
                        background: "rgba(255,255,255,0.03)",
                        borderRadius: 3,
                        borderLeft: `2px solid ${dirColor}`,
                      }}
                      title={`${ev.type} on ${ev.timeframe} @ ${ev.price?.toFixed?.(5) || '?'}`}
                    >
                      <span style={{ color: dirColor, fontWeight: 700, fontSize: 10 }}>{dirChar}</span>
                      <span className="qb-mono" style={{ fontSize: 9, color: "var(--qb-text-primary)" }}>
                        {ev.timeframe}
                      </span>
                      <span style={{ fontSize: 9, color: "var(--qb-text-muted)" }}>
                        {eventLabel}
                      </span>
                    </div>
                  );
                })}
                {interestingEvents.length > 10 && (
                  <div style={{ fontSize: 9, color: "var(--qb-text-dim)", padding: "2px 4px" }}>
                    +{interestingEvents.length - 10}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--qb-text-dim)", fontStyle: "italic" }}>
                {assetState ? "No events detected now" : "Loading..."}
              </div>
            )}
          </div>
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
// SECTION 11.5: GRID PAGE — multi-instrument plain cockpit
// =====================================================================
// Reads /api/cockpit-grid (Redis-only, no broker/TwelveData calls), polls
// every 5s. Each row shows one watchlist asset's full state: status, price,
// ATR, last setup, P&L. Built for testing-phase visibility across instruments.

function GridPage({ prefs, theme, account, positions, onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draftAssets, setDraftAssets] = useState("");

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(API("cockpit-grid")).then((x) => x.json());
        if (alive) {
          if (r.error) setError(r.error);
          else { setData(r); setError(null); }
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const saveWatchlist = async () => {
    const assets = draftAssets.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (assets.length === 0) return alert("Empty watchlist");
    try {
      const r = await fetch(API("watchlist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assets }),
      }).then((x) => x.json());
      if (r.error) alert(r.error);
      else setEditing(false);
    } catch (e) {
      alert(e.message);
    }
  };

  const c = {
    bg: "#0a0a0a",
    panel: "#141414",
    border: "#262626",
    text: "#e8e8e8",
    muted: "#888",
    accent: "#4fc3f7",
    green: "#26a69a",
    red: "#ef5350",
    yellow: "#ffb74d",
  };

  return (
    <div style={{ width: "100%", height: "100%", background: c.bg, color: c.text, display: "flex", flexDirection: "column", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      <PageHeader
        title="Grid"
        subtitle={data ? `${data.summary.total} instruments · ${data.killZoneDisplay}` : "loading…"}
        onBack={() => onNavigate("cockpit")}
        theme={theme}
      />

      <div style={{ padding: "12px 20px", borderBottom: `1px solid ${c.border}`, display: "flex", gap: 16, alignItems: "center", fontSize: 12 }}>
        <div>Balance: <strong>${account?.balance?.toFixed(2) || "—"}</strong></div>
        <div>Equity: <strong>${account?.equity?.toFixed(2) || "—"}</strong></div>
        <div>Open: <strong>{positions.length}</strong></div>
        <div style={{ marginLeft: "auto" }}>
          {!editing ? (
            <button
              onClick={() => { setDraftAssets((data?.watchlist || []).join(", ")); setEditing(true); }}
              style={{ background: c.panel, color: c.text, border: `1px solid ${c.border}`, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}
            >Edit watchlist</button>
          ) : (
            <span style={{ display: "flex", gap: 6 }}>
              <input
                value={draftAssets}
                onChange={(e) => setDraftAssets(e.target.value)}
                placeholder="gold, eurusd, gbpusd, usdjpy, btc, nas100"
                style={{ background: c.bg, color: c.text, border: `1px solid ${c.accent}`, padding: "4px 8px", width: 380, fontSize: 11, fontFamily: "inherit" }}
              />
              <button onClick={saveWatchlist} style={{ background: c.green, color: "#000", border: "none", padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>Save</button>
              <button onClick={() => setEditing(false)} style={{ background: c.panel, color: c.text, border: `1px solid ${c.border}`, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>Cancel</button>
            </span>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, background: "#3a0000", color: c.red, fontSize: 12 }}>Error: {error}</div>
      )}

      <div style={{ flex: 1, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead style={{ position: "sticky", top: 0, background: c.panel, zIndex: 2 }}>
            <tr style={{ borderBottom: `1px solid ${c.border}` }}>
              {["Asset", "Status", "Price", "ATR(H1)", "Last template", "Dir", "Entry", "SL", "TP1", "P&L", "Recog", "Updated"].map((h) => (
                <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: c.muted, fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.assets || []).map((a) => (
              <GridRow key={a.id} a={a} c={c} />
            ))}
          </tbody>
        </table>
        {data && data.assets.length === 0 && (
          <div style={{ padding: 30, textAlign: "center", color: c.muted, fontSize: 12 }}>
            Watchlist empty. Click "Edit watchlist" to add instruments.
          </div>
        )}
      </div>

      <div style={{ padding: "8px 20px", borderTop: `1px solid ${c.border}`, fontSize: 10, color: c.muted, display: "flex", justifyContent: "space-between" }}>
        <span>Live · polls every 5s · zero TwelveData usage</span>
        <span>{data ? new Date(data.ts).toLocaleTimeString() : "—"}</span>
      </div>
    </div>
  );
}

function GridRow({ a, c }) {
  const dirColor = a.lastSetup?.direction === "LONG" ? c.green : a.lastSetup?.direction === "SHORT" ? c.red : c.muted;

  const statusBadge = (s) => {
    const map = {
      "in-trade":      { bg: "#1a3a1a", fg: c.green,  label: "● IN TRADE" },
      "awaiting-fill": { bg: "#3a2e1a", fg: c.yellow, label: "○ AWAITING" },
      "pending":       { bg: "#1a2a3a", fg: c.accent, label: "○ PENDING" },
      "watching":      { bg: c.panel,    fg: c.muted,  label: "· watching" },
      "paused":        { bg: "#3a1a1a", fg: c.red,    label: "‖ paused" },
    };
    const m = map[s] || map["watching"];
    return (
      <span style={{ background: m.bg, color: m.fg, padding: "2px 8px", borderRadius: 3, fontSize: 10, letterSpacing: 0.5 }}>{m.label}</span>
    );
  };

  const fmtPrice = (p) => {
    if (p == null) return "—";
    if (a.category === "forex") return p.toFixed(5);
    if (a.category === "crypto" && p > 1000) return p.toFixed(2);
    return p.toFixed(2);
  };
  const fmtPnL = (p) => {
    if (p == null) return "—";
    const color = p >= 0 ? c.green : c.red;
    return <span style={{ color }}>{p >= 0 ? "+" : ""}{p.toFixed(2)}</span>;
  };
  const fmtTime = (ts) => {
    if (!ts) return "—";
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec/60)}m ago`;
    return `${Math.round(sec/3600)}h ago`;
  };

  return (
    <tr style={{ borderBottom: `1px solid ${c.border}` }}>
      <td style={{ padding: "8px 12px", fontWeight: 500 }}>
        {a.name}<span style={{ color: c.muted, fontSize: 10, marginLeft: 6 }}>{a.id}</span>
      </td>
      <td style={{ padding: "8px 12px" }}>{statusBadge(a.status)}</td>
      <td style={{ padding: "8px 12px" }}>{fmtPrice(a.currentPrice)}</td>
      <td style={{ padding: "8px 12px", color: c.muted }}>{a.atrH1 ? a.atrH1.toFixed(a.category === "forex" ? 5 : 2) : "—"}</td>
      <td style={{ padding: "8px 12px", color: a.lastSetup ? c.text : c.muted }}>
        {a.lastSetup?.template || "—"}
      </td>
      <td style={{ padding: "8px 12px", color: dirColor, fontWeight: 500 }}>{a.lastSetup?.direction || "—"}</td>
      <td style={{ padding: "8px 12px" }}>{fmtPrice(a.lastSetup?.entry)}</td>
      <td style={{ padding: "8px 12px", color: c.muted }}>{fmtPrice(a.lastSetup?.sl)}</td>
      <td style={{ padding: "8px 12px", color: c.muted }}>{fmtPrice(a.lastSetup?.tp1)}</td>
      <td style={{ padding: "8px 12px" }}>{fmtPnL(a.lastSetup?.pnl)}</td>
      <td style={{ padding: "8px 12px", color: c.muted, fontSize: 11 }}>
        {a.recognition ? `${(a.recognition.winRate * 100).toFixed(0)}% (${a.recognition.matchCount})` : "—"}
      </td>
      <td style={{ padding: "8px 12px", color: c.muted, fontSize: 11 }}>{fmtTime(a.lastTickAt)}</td>
    </tr>
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