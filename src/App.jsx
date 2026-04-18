/* eslint-disable */
// App.jsx -- V8.2.0 Quantum Bot
// Architecture: SetupScreen -> TradingApp (broker-first, dynamic instruments)
// NOTE: isAdmin is UI-state only. Real security must be enforced by the backend.

import { useState, useEffect, useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API = (path) => `/api/${path}`;
// Admin check is UI-only -- backend must independently enforce permissions
const ADMIN_PW = process.env.REACT_APP_ADMIN_PASSWORD || "qbadmin";
const SESSION_COLORS = {
  LONDON: "#3b82f6",
  OVERLAP: "#f59e0b",
  "NEW YORK": "#10b981",
  ASIAN: "#8b5cf6",
};

// ---------------------------------------------------------------------------
// Pure helpers (no side effects)
// ---------------------------------------------------------------------------
const pnlColor = (v) => (v > 0 ? "#10b981" : v < 0 ? "#ef4444" : "#6b7280");
const pnlStr = (v) => `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
const fmtTime = (d) =>
  new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });

// Derive canonical instrument ID from raw broker symbol string.
// This is the ONLY place symbol normalization happens.
// It is intentionally kept simple and configurable.
const normalizeSymbol = (raw) => {
  if (!raw) return null;
  const u = raw.toUpperCase().replace(".S", "").replace(".PRO", "").trim();
  return u; // return cleaned symbol as-is -- no hardcoded mapping
};

// Detect instrument category for session rules.
// Returns: "GOLD" | "CRYPTO" | "FOREX" | "OTHER"
const instrumentCategory = (sym) => {
  if (!sym) return "OTHER";
  const u = sym.toUpperCase();
  if (u.includes("XAU") || u.includes("GOLD")) return "GOLD";
  if (u.includes("BTC") || u.includes("ETH") || u.includes("CRYPTO")) return "CRYPTO";
  // Assume everything else is forex or CFD -- session logic applies
  return "FOREX";
};

const getSessionInfo = () => {
  const now = new Date();
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  const day = now.getUTCDay();
  const isWeekend = day === 0 || day === 6;
  const isLondon = h >= 8 && h < 16;
  const isNY = h >= 13 && h < 21;
  const isOverlap = h >= 13 && h < 16;
  let session = "ASIAN";
  if (isOverlap) session = "OVERLAP";
  else if (isNY) session = "NEW YORK";
  else if (isLondon) session = "LONDON";
  return { session, isLondon, isNY, isOverlap, isWeekend, utcH: h };
};

// Frontend session guard -- advisory only. Backend /api/ai is authoritative.
const isInstrumentTradeable = (sym, utcH, isWeekend) => {
  if (!sym) return false;
  const cat = instrumentCategory(sym);
  if (cat === "CRYPTO") {
    // BTC/ETH: no weekends, active 07-23 UTC
    if (isWeekend) return false;
    return utcH >= 7 && utcH < 23;
  }
  // Gold and forex: weekdays 08-21 UTC
  if (isWeekend) return false;
  return utcH >= 8 && utcH < 21;
};

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------
const CSS = `
  :root {
    --bg: #0f1117; --card: #1a1f2e; --card2: #232838; --border: #2a3044;
    --text: #e2e8f0; --text2: #94a3b8; --text3: #64748b;
    --blue: #3b82f6; --green: #10b981; --red: #ef4444;
    --gold: #f59e0b; --purple: #8b5cf6;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh;
  }
  .app { display: flex; min-height: 100vh; }
  .sidebar {
    width: 220px; background: var(--card);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 16px 0; flex-shrink: 0;
  }
  .sidebar-logo { padding: 0 16px 20px; font-size: 16px; font-weight: 700; color: var(--blue); }
  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; cursor: pointer; font-size: 13px;
    color: var(--text2); transition: all 0.15s;
  }
  .nav-item:hover { background: var(--card2); color: var(--text); }
  .nav-item.active {
    background: rgba(59,130,246,0.1); color: var(--blue);
    border-right: 3px solid var(--blue);
  }
  .main { flex: 1; overflow: auto; padding: 20px; }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat-pill {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 14px;
    display: flex; flex-direction: column; gap: 2px;
  }
  .stat-label { font-size: 10px; color: var(--text3); font-weight: 600; letter-spacing: 0.05em; }
  .stat-val { font-size: 18px; font-weight: 700; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .card-title {
    font-size: 11px; font-weight: 700; color: var(--text3);
    letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 12px;
  }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .badge {
    display: inline-flex; align-items: center;
    padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700;
  }
  .badge-long { background: rgba(16,185,129,0.1); color: #10b981; }
  .badge-short { background: rgba(239,68,68,0.1); color: #ef4444; }
  .badge-wait { background: rgba(107,114,128,0.1); color: #6b7280; }
  .btn {
    padding: 8px 16px; border-radius: 7px; border: none;
    cursor: pointer; font-size: 13px; font-weight: 600;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--blue); color: white; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn-sm { padding: 5px 10px; font-size: 11px; }
  .btn-ghost { background: var(--card2); color: var(--text2); }
  .btn-ghost:hover:not(:disabled) { color: var(--text); }
  .input {
    background: var(--card2); border: 1px solid var(--border);
    color: var(--text); padding: 8px 12px; border-radius: 7px;
    font-size: 13px; outline: none; width: 100%;
  }
  .input:focus { border-color: var(--blue); }
  .log-box { height: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
  .log-line { font-size: 11px; padding: 3px 0; font-family: monospace; }
  .log-info { color: var(--text2); }
  .log-success { color: var(--green); }
  .log-warn { color: var(--gold); }
  .log-error { color: var(--red); }
  .log-signal { color: var(--purple); }
  .pbar-bg { background: var(--card2); border-radius: 2px; height: 4px; }
  .pbar { height: 100%; border-radius: 2px; transition: width 0.5s; }
  .divider { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
  @media (max-width: 768px) {
    .sidebar { display: none; }
    .grid-4 { grid-template-columns: 1fr 1fr; }
  }
`;

// ---------------------------------------------------------------------------
// Admin credential storage helpers (localStorage)
// Saves account ID, token, last-used instruments, sessions, riskMode for admin.
// ---------------------------------------------------------------------------
const ADMIN_STORAGE_KEY = "qb_admin_profile";

const loadAdminProfile = () => {
  try {
    const raw = localStorage.getItem(ADMIN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};

const saveAdminProfile = (profile) => {
  try {
    localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(profile));
  } catch (e) {}
};

// ---------------------------------------------------------------------------
// SetupScreen
// ---------------------------------------------------------------------------
function SetupScreen({ onConnected }) {
  const [step, setStep] = useState(1); // 1=auth, 2=broker, 3=config
  const [adminPw, setAdminPw] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [autoConnecting, setAutoConnecting] = useState(false);
  // brokerSymbols: raw symbols returned by the broker -- NOT hardcoded
  const [brokerSymbols, setBrokerSymbols] = useState([]);
  const [selected, setSelected] = useState([]);
  const [sessions, setSessions] = useState(["LONDON", "NEW YORK"]);
  const [riskMode, setRiskMode] = useState("TEST");
  const [error, setError] = useState("");

  const connectBrokerWith = async (aid, tok) => {
    const r = await fetch(API("account"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: aid.trim(), token: tok.trim() }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Connection failed. Check credentials.");
    const symbols = Array.isArray(d.symbols) ? d.symbols : [];
    if (symbols.length === 0) throw new Error("Broker connected but returned no tradeable symbols.");
    return symbols;
  };

  const tryAdmin = async () => {
    if (adminPw !== ADMIN_PW) {
      setError("Incorrect password");
      return;
    }
    setIsAdmin(true);
    setError("");

    // Check for saved admin profile -- if found, skip broker step entirely
    const saved = loadAdminProfile();
    if (saved && saved.accountId && saved.token) {
      setAutoConnecting(true);
      try {
        const symbols = await connectBrokerWith(saved.accountId, saved.token);
        setAccountId(saved.accountId);
        setToken(saved.token);
        setBrokerSymbols(symbols);
        // Restore last-used preferences
        if (Array.isArray(saved.instruments) && saved.instruments.length > 0) {
          // Only restore instruments that still exist on the broker
          const valid = saved.instruments.filter((s) => symbols.includes(s));
          setSelected(valid.length > 0 ? valid : []);
        }
        if (Array.isArray(saved.sessions) && saved.sessions.length > 0) setSessions(saved.sessions);
        if (saved.riskMode) setRiskMode(saved.riskMode);
        setStep(3);
      } catch (e) {
        // Saved credentials no longer work -- fall through to broker step
        setError("Saved credentials failed (" + e.message + "). Please re-enter.");
        setStep(2);
      } finally {
        setAutoConnecting(false);
      }
    } else {
      // No saved profile -- go to broker step as normal
      setStep(2);
    }
  };

  const continueAsUser = () => {
    setIsAdmin(false);
    setStep(2);
  };

  const connectBroker = async () => {
    if (!accountId.trim() || !token.trim()) {
      setError("Account ID and token are required");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      const symbols = await connectBrokerWith(accountId, token);
      setBrokerSymbols(symbols);
      // Save credentials for admin so next login is instant
      if (isAdmin) {
        saveAdminProfile({
          accountId: accountId.trim(),
          token: token.trim(),
          instruments: selected,
          sessions,
          riskMode,
        });
      }
      setStep(3);
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setConnecting(false);
    }
  };

  const toggleSymbol = (sym) => {
    setSelected((prev) =>
      prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym]
    );
  };

  const startBot = () => {
    if (selected.length === 0) {
      setError("Select at least one instrument to trade.");
      return;
    }
    // Update saved profile with latest instrument/session/risk choices
    if (isAdmin) {
      saveAdminProfile({ accountId, token, instruments: selected, sessions, riskMode });
    }
    onConnected({
      // isAdmin is UI state only -- backend enforces real permissions via token
      isAdmin,
      accountId: accountId.trim(),
      token: token.trim(),
      instruments: selected,
      sessions,
      riskMode,
    });
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          width: 440,
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 32,
        }}
      >
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--blue)" }}>
            QuantumBot
          </div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>
            V8.2.0 -- Professional Trading System
          </div>
        </div>

        {/* Step 1: Auth */}
        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Show whether a saved admin profile exists */}
            {loadAdminProfile() && (
              <div
                style={{
                  background: "rgba(59,130,246,0.08)",
                  border: "1px solid rgba(59,130,246,0.25)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontSize: 12,
                  color: "var(--blue)",
                  textAlign: "center",
                }}
              >
                Saved profile found -- enter admin password to connect instantly.
              </div>
            )}
            <div style={{ fontSize: 13, color: "var(--text2)", textAlign: "center" }}>
              Admin password unlocks Strategy Lab and full risk modes.
              <br />
              Leave blank to continue as a regular user.
            </div>
            <input
              className="input"
              type="password"
              placeholder="Admin password (optional)"
              value={adminPw}
              onChange={(e) => setAdminPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tryAdmin()}
              disabled={autoConnecting}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={tryAdmin}
                disabled={autoConnecting}
              >
                {autoConnecting ? "Connecting..." : "Login as Admin"}
              </button>
              <button
                className="btn btn-ghost"
                style={{ flex: 1 }}
                onClick={continueAsUser}
                disabled={autoConnecting}
              >
                Continue as User
              </button>
            </div>
            {error && (
              <div style={{ color: "var(--red)", fontSize: 12, textAlign: "center" }}>
                {error}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Broker */}
        {step === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: isAdmin ? "var(--gold)" : "var(--text3)",
                marginBottom: 4,
              }}
            >
              {isAdmin ? "ADMIN MODE -- Full Access" : "USER MODE -- Restricted"}
            </div>
            <div>
              <div className="card-title">MT4 / MT5 Connection</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input
                  className="input"
                  placeholder="MetaAPI Account ID"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                />
                <input
                  className="input"
                  type="password"
                  placeholder="MetaAPI Token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
            </div>
            <button
              className="btn btn-primary"
              disabled={connecting || !accountId.trim() || !token.trim()}
              onClick={connectBroker}
            >
              {connecting ? "Connecting..." : "Connect Broker"}
            </button>
            {error && (
              <div style={{ color: "var(--red)", fontSize: 12 }}>{error}</div>
            )}
          </div>
        )}

        {/* Step 3: Configure */}
        {step === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/* Instruments -- dynamic from broker */}
            <div>
              <div className="card-title">
                SELECT INSTRUMENTS ({brokerSymbols.length} available)
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  maxHeight: 180,
                  overflowY: "auto",
                }}
              >
                {brokerSymbols.map((sym) => (
                  <button
                    key={sym}
                    className="btn btn-sm"
                    style={{
                      background: selected.includes(sym)
                        ? "var(--blue)"
                        : "var(--card2)",
                      color: selected.includes(sym) ? "white" : "var(--text2)",
                    }}
                    onClick={() => toggleSymbol(sym)}
                  >
                    {sym}
                  </button>
                ))}
              </div>
              {selected.length > 0 && (
                <div
                  style={{ fontSize: 11, color: "var(--text3)", marginTop: 6 }}
                >
                  {selected.length} selected: {selected.join(", ")}
                </div>
              )}
            </div>

            {/* Sessions */}
            <div>
              <div className="card-title">TRADING SESSIONS</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {["LONDON", "OVERLAP", "NEW YORK"].map((s) => (
                  <button
                    key={s}
                    className="btn btn-sm"
                    style={{
                      background: sessions.includes(s)
                        ? "var(--blue)"
                        : "var(--card2)",
                      color: sessions.includes(s) ? "white" : "var(--text2)",
                    }}
                    onClick={() =>
                      setSessions((prev) =>
                        prev.includes(s)
                          ? prev.filter((x) => x !== s)
                          : [...prev, s]
                      )
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Risk mode */}
            <div>
              <div className="card-title">RISK MODE</div>
              <div style={{ display: "flex", gap: 8 }}>
                {["TEST", "REGULAR", "AGGRESSIVE"].map((m) => {
                  // Non-admins are locked to TEST only
                  // Note: backend must also enforce this -- this is UI only
                  const locked = !isAdmin && m !== "TEST";
                  return (
                    <button
                      key={m}
                      className="btn btn-sm"
                      disabled={locked}
                      style={{
                        flex: 1,
                        background: riskMode === m ? "var(--blue)" : "var(--card2)",
                        color: riskMode === m ? "white" : locked ? "var(--text3)" : "var(--text2)",
                      }}
                      onClick={() => !locked && setRiskMode(m)}
                    >
                      {m}
                      {locked ? " (locked)" : ""}
                    </button>
                  );
                })}
              </div>
              {!isAdmin && (
                <div
                  style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}
                >
                  REGULAR and AGGRESSIVE unlock after proven performance
                </div>
              )}
            </div>

            {error && (
              <div style={{ color: "var(--red)", fontSize: 12 }}>{error}</div>
            )}

            <button
              className="btn btn-primary"
              disabled={selected.length === 0}
              onClick={startBot}
            >
              Start Quantum Bot
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TradingApp -- only renders after broker connection succeeds
// ---------------------------------------------------------------------------
function TradingApp({ config }) {
  const { isAdmin, accountId, token, instruments, sessions, riskMode } = config;

  const [page, setPage] = useState("live");
  // prices keyed by exact broker symbol the user selected
  const [prices, setPrices] = useState({});
  const [openPositions, setOpenPositions] = useState([]);
  const [closedTrades, setClosedTrades] = useState([]);
  const [accountBalance, setAccountBalance] = useState(null);
  // aiDecisions keyed by instrument symbol
  const [aiDecisions, setAiDecisions] = useState({});
  const [aiStatus, setAiStatus] = useState({});
  // Strategy lab data -- comes from backend /api/trades
  const [learnedStats, setLearnedStats] = useState({});
  const [crownLocks, setCrownLocks] = useState({});
  const [blacklist, setBlacklist] = useState([]);
  const [log, setLog] = useState([]);
  const [sessionInfo, setSessionInfo] = useState(getSessionInfo());

  const lastAIRef = useRef({});
  const lastTradeRef = useRef({});
  const pendingRef = useRef({});
  const prevPosRef = useRef([]);
  const logRef = useRef(null);

  // ---- logging ----
  const addLog = useCallback((msg, type = "info") => {
    const entry = {
      msg,
      type,
      time: new Date().toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    };
    setLog((prev) => [...prev.slice(-200), entry]);
  }, []);

  // ---- data fetching ----
  const fetchAccount = useCallback(async () => {
    try {
      const r = await fetch(API("account"));
      if (r.ok) {
        const d = await r.json();
        if (d.balance != null) setAccountBalance(d.balance);
      }
    } catch (_) {}
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      const r = await fetch(API("positions"));
      if (r.ok) {
        const d = await r.json();
        setOpenPositions(d.positions || []);
      }
    } catch (_) {}
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch(API("history"));
      if (r.ok) {
        const d = await r.json();
        setClosedTrades(d.deals || []);
      }
    } catch (_) {}
  }, []);

  const fetchPrice = useCallback(
    async (sym) => {
      try {
        const r = await fetch(API(`broker-price?symbol=${encodeURIComponent(sym)}`));
        if (r.ok) {
          const d = await r.json();
          if (d.price != null)
            setPrices((prev) => ({ ...prev, [sym]: d.price }));
        }
      } catch (_) {}
    },
    []
  );

  const fetchLab = useCallback(async () => {
    try {
      const r = await fetch(API("trades"));
      if (r.ok) {
        const d = await r.json();
        setLearnedStats(d.lab || {});
        setCrownLocks(d.crownLocks || {});
        setBlacklist(d.blacklist || []);
      }
    } catch (_) {}
  }, []);

  // ---- strategy recording ----
  // Strategy name comes from broker comment (QB:...) or from last known AI decision.
  // The comment field is the persistent source -- React state is secondary.
  // When trade closes, we read strategy from position.comment first.
  const recordResult = useCallback(
    async (pos, fallbackDec, session) => {
      // Try comment field on the position first (persistent across reloads)
      const comment = pos.comment || pos.tradeComment || "";
      const commentStrategy = comment.startsWith("QB:")
        ? comment.slice(3).trim()
        : null;
      const strategy =
        commentStrategy ||
        fallbackDec?.strategy ||
        null;

      if (!strategy || strategy === "EXPLORING" || strategy === "UNKNOWN") {
        addLog(
          `Strategy not recorded for ${pos.symbol} -- no strategy label found`,
          "warn"
        );
        return;
      }

      const raw = (pos.symbol || "").toUpperCase();
      const inst = normalizeSymbol(raw);
      const pnl = pos.profit || 0;
      const won = pnl > 0;

      try {
        await fetch(API("trades"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instrument: inst,
            direction:
              pos.type === "POSITION_TYPE_BUY" ? "LONG" : "SHORT",
            won,
            pnl,
            strategy,
            session,
            confidence: fallbackDec?.confidence || 0,
            closeTime: new Date().toISOString(),
          }),
        });
        fetchLab();
        addLog(
          `Recorded: [${strategy}] on ${inst} ${won ? "WIN" : "LOSS"} ${pnlStr(pnl)}`,
          won ? "success" : "warn"
        );
      } catch (e) {
        addLog(`Failed to record result: ${e.message}`, "error");
      }
    },
    [addLog, fetchLab]
  );

  // ---- detect position closes ----
  useEffect(() => {
    const prev = prevPosRef.current;
    const cur = openPositions;
    prev
      .filter(
        (p) =>
          !cur.find(
            (c) =>
              (c.id || c.positionId) === (p.id || p.positionId)
          )
      )
      .forEach((closed) => {
        const sym = normalizeSymbol(closed.symbol);
        const dec = aiDecisions[sym] || null;
        recordResult(closed, dec, sessionInfo.session);
      });
    prevPosRef.current = cur;
  }, [openPositions, aiDecisions, sessionInfo.session, recordResult]);

  // ---- AI brain ----
  const runAIBrain = useCallback(
    async (sym) => {
      if (pendingRef.current[sym]) return;
      const now = Date.now();
      if (now - (lastAIRef.current[sym] || 0) < 290000) return; // 5-min cooldown
      lastAIRef.current[sym] = now;

      setAiStatus((p) => ({ ...p, [sym]: "thinking" }));
      addLog(`Brain: ${sym} -- reading market...`, "info");

      try {
        // Fetch candles for market snapshot
        const timeframes = ["M1", "M5", "M15", "H1", "H4", "D1", "W1"];
        const limits = [60, 24, 24, 24, 20, 14, 8];
        const candleResults = await Promise.all(
          timeframes.map((tf, i) =>
            fetch(
              API(
                `broker-candles?symbol=${encodeURIComponent(sym)}&timeframe=${tf}&limit=${limits[i]}`
              )
            )
              .then((r) => r.json())
              .catch(() => ({ candles: [] }))
          )
        );
        const [m1d, m5d, m15d, h1d, h4d, d1d, wkd] = candleResults.map(
          (r) => r.candles || []
        );

        const sumC = (arr, n = 5) => {
          if (!arr || arr.length === 0) return "no data";
          const sl = arr.slice(-n);
          const c = sl[sl.length - 1];
          const o = sl[0];
          const dir = c.close > o.close ? "up" : "down";
          const chg = (((c.close - o.close) / o.close) * 100).toFixed(3);
          const hi = Math.max(...sl.map((x) => x.high));
          const lo = Math.min(...sl.map((x) => x.low));
          const dp = hi > 1000 ? 0 : 5;
          return `${dir}${chg}% H:${hi.toFixed(dp)} L:${lo.toFixed(dp)}`;
        };

        const atr = (() => {
          if (m1d.length < 15) return 0;
          const trs = m1d.slice(-14).map((c, i, a) => {
            const prev = a[Math.max(0, i - 1)];
            return Math.max(
              c.high - c.low,
              Math.abs(c.high - prev.close),
              Math.abs(c.low - prev.close)
            );
          });
          return trs.reduce((a, b) => a + b, 0) / trs.length;
        })();

        const todayPnl = closedTrades
          .filter((t) => {
            const d = new Date(t.time || t.closeTime || "");
            return d.toDateString() === new Date().toDateString();
          })
          .reduce((s, t) => s + (t.profit || 0), 0);

        const s = sessionInfo;
        const snap = {
          price: prices[sym] || null,
          session: s.session,
          balance: accountBalance || 0,
          todayPnl: todayPnl.toFixed(2),
          lossStreak: 0,
          winStreak: 0,
          atr14: parseFloat(atr.toFixed(4)),
          weekly: sumC(wkd, 4),
          d1: sumC(d1d, 5),
          h4: sumC(h4d, 5),
          h1: sumC(h1d, 5),
          m15: sumC(m15d, 6),
          m5: sumC(m5d, 6),
          m1: sumC(m1d, 8),
          openCount: openPositions.filter((p) =>
            normalizeSymbol(p.symbol) === sym
          ).length,
          inKillZone:
            (s.utcH >= 7 && s.utcH < 10) || (s.utcH >= 13 && s.utcH < 16),
          killZone:
            s.utcH >= 7 && s.utcH < 10
              ? "London 07-10"
              : s.utcH >= 13 && s.utcH < 16
              ? "NY 13-16"
              : "",
          // These are null/defaults -- real indicators should come from backend
          rsi: null,
          ema21: null,
          ema50: null,
          ema200: null,
          emaStack: "unknown",
          macd: "unknown",
          bb: "unknown",
          asianHigh: null,
          asianLow: null,
          pdh: null,
          pdl: null,
          sweep: "none",
          sweepDir: "NONE",
          roundLevels: "unknown",
          bos: "none",
          fvg: "none",
          ob: "none",
          fibNearest: "unknown",
          weeklyBias: "unknown",
          atrGuide: atr > 0 ? `min SL ${(atr * 0.8).toFixed(4)}` : "unknown",
          news: [],
        };

        const prevDec = aiDecisions[sym] ? [aiDecisions[sym]] : [];

        // NOTE: backend /api/ai enforces session gates -- this is advisory
        const r = await fetch(API("ai"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            snap,
            instrument: sym,
            riskMode,
            prevDecisions: prevDec,
            lab: learnedStats,
            crownLocks,
            blacklist,
          }),
        });

        if (!r.ok) {
          addLog(`AI error ${sym}: HTTP ${r.status}`, "error");
          setAiStatus((p) => ({ ...p, [sym]: "error" }));
          return;
        }

        const dec = await r.json();
        setAiDecisions((p) => ({
          ...p,
          [sym]: { ...dec, symbol: sym, price: prices[sym], time: new Date().toISOString() },
        }));
        setAiStatus((p) => ({
          ...p,
          [sym]: (dec.decision || "wait").toLowerCase(),
        }));
        addLog(
          `${sym}: ${dec.decision || "WAIT"} ${dec.confidence || 0}% -- ${dec.strategy || "?"}`,
          dec.decision === "WAIT" ? "warn" : "signal"
        );

        // Execute if signal given
        if (
          dec.decision !== "WAIT" &&
          dec.volume &&
          dec.stopLoss &&
          dec.takeProfit1
        ) {
          const cooldown = 600000; // 10 min between trades per instrument
          if (Date.now() - (lastTradeRef.current[sym] || 0) < cooldown) {
            addLog(`${sym}: cooldown active -- skipping`, "warn");
            return;
          }
          const alreadyOpen = openPositions.some(
            (p) => normalizeSymbol(p.symbol) === sym
          );
          if (alreadyOpen) {
            addLog(`${sym}: position already open -- skipping`, "warn");
            return;
          }

          pendingRef.current[sym] = true;
          addLog(
            `Executing ${sym} ${dec.decision} ${dec.volume}L [${dec.strategy}]`,
            "signal"
          );

          try {
            const strategy = dec.strategy || "V820";
            const ex = await fetch(API("execute"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                instrument: sym,
                direction: dec.decision,
                entry: prices[sym],
                stopLoss: dec.stopLoss,
                takeProfit: dec.takeProfit3 || dec.takeProfit2 || dec.takeProfit1,
                volume: dec.volume,
                // Strategy stored in MT5 comment for persistence across reloads
                comment: `QB:${strategy.slice(0, 18)}`,
              }),
            });
            const ed = await ex.json();
            if (ed.success) {
              lastTradeRef.current[sym] = Date.now();
              addLog(`Opened: ${sym} ${dec.decision} ${dec.volume}L`, "success");

              // Post-fill TP correction (3s after execution)
              // Recalculate TP levels from the actual fill price
              setTimeout(async () => {
                try {
                  const pr = await fetch(API("positions")).then((r) => r.json());
                  const filled = (pr.positions || []).find(
                    (p) => normalizeSymbol(p.symbol) === sym
                  );
                  if (!filled || !filled.openPrice) return;

                  const fill = filled.openPrice;
                  const dir = dec.decision;
                  const sign = dir === "LONG" ? 1 : -1;
                  const cat = instrumentCategory(sym);

                  // TP pip distances by category
                  // These are defaults -- admin may override via strategy lab
                  let pips;
                  if (cat === "GOLD") {
                    pips = [5, 10, 15, 20]; // Gold special mode
                  } else if (cat === "CRYPTO") {
                    const atrP = Math.max(atr * 0.5, 50);
                    pips = [atrP, atrP * 2, atrP * 3, atrP * 4];
                  } else {
                    // Forex -- use ATR-based pips converted to price
                    const atrP = Math.max(atr * 0.5, 0.0005);
                    pips = [atrP, atrP * 2, atrP * 3, atrP * 4];
                  }

                  const dp = fill > 100 ? 2 : 5;
                  const corr = {
                    positionId: filled.id || filled.positionId,
                    instrument: sym,
                    direction: dir,
                    fillPrice: fill,
                    tp1: parseFloat((fill + sign * pips[0]).toFixed(dp)),
                    tp2: parseFloat((fill + sign * pips[1]).toFixed(dp)),
                    tp3: parseFloat((fill + sign * pips[2]).toFixed(dp)),
                    tp4: parseFloat((fill + sign * pips[3]).toFixed(dp)),
                    sl: parseFloat((fill - sign * Math.max(atr * 0.8, pips[0])).toFixed(dp)),
                  };

                  await fetch(API("manage-trades"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ correctTPs: corr }),
                  }).catch(() => {});

                  addLog(`TPs corrected from fill @ ${fill}`, "info");
                } catch (_) {}
              }, 3000);

              setTimeout(fetchPositions, 2000);
              setTimeout(fetchHistory, 5000);
            } else {
              addLog(`Execute failed ${sym}: ${ed.error || "unknown"}`, "error");
            }
          } finally {
            pendingRef.current[sym] = false;
          }
        }
      } catch (e) {
        setAiStatus((p) => ({ ...p, [sym]: "error" }));
        addLog(`Brain error ${sym}: ${e.message}`, "error");
      }
    },
    [
      prices, openPositions, closedTrades, accountBalance, sessionInfo,
      riskMode, aiDecisions, learnedStats, crownLocks, blacklist,
      addLog, fetchPositions, fetchHistory,
    ]
  );

  // ---- trade management ----
  const manageTrades = useCallback(async () => {
    if (openPositions.length === 0) return;
    const positions = openPositions
      .map((pos) => {
        const sym = normalizeSymbol(pos.symbol);
        const dec = aiDecisions[sym];
        if (!dec || !dec.takeProfit1) return null;
        return {
          id: pos.id || pos.positionId,
          symbol: pos.symbol,
          openPrice: pos.openPrice,
          currentPrice: pos.currentPrice,
          stopLoss: pos.stopLoss,
          volume: pos.volume,
          direction: pos.type === "POSITION_TYPE_BUY" ? "LONG" : "SHORT",
          tp1: dec.takeProfit1,
          tp2: dec.takeProfit2 || null,
          tp3: dec.takeProfit3 || null,
          tp4: dec.takeProfit4 || null,
        };
      })
      .filter(Boolean);

    if (positions.length === 0) return;

    try {
      const r = await fetch(API("manage-trades"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions }),
      });
      const d = await r.json();
      (d.managed || []).forEach((m) => {
        (m.actions || []).forEach((a) => {
          if (a.type === "TP1")
            addLog(`TP1 ${m.symbol} +$${(a.pnl || 0).toFixed(2)}`, "success");
          if (a.type === "TP2")
            addLog(`TP2 ${m.symbol} +$${(a.pnl || 0).toFixed(2)}`, "success");
          if (a.type === "TP3")
            addLog(`TP3 ${m.symbol} +$${(a.pnl || 0).toFixed(2)}`, "success");
          if (a.type === "TP4" || a.type === "TP4_FINAL")
            addLog(`TP4 COMPLETE ${m.symbol} +$${(a.pnl || 0).toFixed(2)}`, "success");
          if (a.type === "RETRACE_CLOSE")
            addLog(`Retrace close ${m.symbol} $${(a.pnl || 0).toFixed(2)}`, "warn");
        });
      });
    } catch (_) {}
  }, [openPositions, aiDecisions, addLog]);

  // ---- intervals ----
  useEffect(() => {
    fetchAccount();
    fetchPositions();
    fetchHistory();
    fetchLab();
    instruments.forEach((sym) => fetchPrice(sym));

    const intervals = [
      setInterval(fetchAccount, 30000),
      setInterval(fetchPositions, 5000),
      setInterval(fetchHistory, 30000),
      setInterval(fetchLab, 300000),
      setInterval(() => setSessionInfo(getSessionInfo()), 60000),
    ];
    // Price ticks per instrument
    instruments.forEach((sym) => {
      intervals.push(setInterval(() => fetchPrice(sym), 5000));
    });

    return () => intervals.forEach(clearInterval);
  }, [
    fetchAccount,
    fetchPositions,
    fetchHistory,
    fetchLab,
    fetchPrice,
    instruments,
  ]);

  useEffect(() => {
    if (openPositions.length > 0) {
      manageTrades();
      const i = setInterval(manageTrades, 30000);
      return () => clearInterval(i);
    }
  }, [openPositions, manageTrades]);

  // AI brain cycle -- frontend skips if outside hours (backend also rejects)
  useEffect(() => {
    const run = () => {
      const s = getSessionInfo();
      instruments.forEach((sym) => {
        // Advisory frontend session check -- backend is authoritative
        if (!isInstrumentTradeable(sym, s.utcH, s.isWeekend)) return;
        if (prices[sym] == null) return;
        runAIBrain(sym);
      });
    };
    const t = setTimeout(run, 3000);
    const i = setInterval(run, 300000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [instruments, prices, runAIBrain]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // ---- computed ----
  const todayTrades = closedTrades.filter((t) => {
    const d = new Date(t.time || t.closeTime || "");
    return d.toDateString() === new Date().toDateString();
  });
  const todayPnl = todayTrades.reduce((s, t) => s + (t.profit || 0), 0);
  const totalWins = closedTrades.filter((t) => (t.profit || 0) > 0).length;
  const winRate =
    closedTrades.length > 0
      ? ((totalWins / closedTrades.length) * 100).toFixed(1)
      : "0.0";

  // ---- nav ----
  const NAV = [
    { id: "live", icon: "[L]", label: "Live Trade" },
    { id: "reports", icon: "[R]", label: "Reports" },
    { id: "brain", icon: "[B]", label: "Brain" },
    ...(isAdmin ? [{ id: "lab", icon: "[S]", label: "Strategy Lab" }] : []),
    { id: "settings", icon: "[*]", label: "Settings" },
  ];

  // ---- session labels for getSession util ----
  const getSessionLabel = (timeStr) => {
    const h = new Date(timeStr || "").getUTCHours();
    if (h >= 13 && h < 16) return "OVERLAP";
    if (h >= 13 && h < 21) return "NEW YORK";
    if (h >= 8 && h < 16) return "LONDON";
    return "ASIAN";
  };

  // ===========================================================================
  // Render
  // ===========================================================================
  return (
    <div className="app">
      <style>{CSS}</style>

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-logo">QuantumBot</div>
        {NAV.map((n) => (
          <div
            key={n.id}
            className={`nav-item${page === n.id ? " active" : ""}`}
            onClick={() => setPage(n.id)}
          >
            <span>{n.icon}</span>
            <span>{n.label}</span>
          </div>
        ))}

        {/* Instrument price list -- only selected instruments shown */}
        <div style={{ marginTop: "auto", padding: "16px" }}>
          {instruments.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text3)" }}>
              No instruments selected
            </div>
          ) : (
            instruments.map((sym) => {
              const dec = aiDecisions[sym];
              const decision = dec?.decision || null;
              return (
                <div key={sym} style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 2,
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text2)" }}>
                      {sym}
                    </span>
                    {decision && (
                      <span
                        className={`badge badge-${decision.toLowerCase()}`}
                        style={{ fontSize: 9 }}
                      >
                        {decision}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: prices[sym] != null ? "var(--text)" : "var(--text3)",
                    }}
                  >
                    {prices[sym] != null
                      ? prices[sym] > 1000
                        ? prices[sym].toLocaleString("en", { maximumFractionDigits: 2 })
                        : prices[sym].toFixed(prices[sym] > 10 ? 2 : 5)
                      : "--"}
                  </div>
                </div>
              );
            })
          )}
          <hr className="divider" />
          <div style={{ fontSize: 10, color: "var(--text3)" }}>
            <div
              style={{
                color: SESSION_COLORS[sessionInfo.session] || "var(--text3)",
                fontWeight: 600,
                marginBottom: 2,
              }}
            >
              {sessionInfo.session}
            </div>
            <div>
              {new Date().toUTCString().slice(17, 25)} UTC
            </div>
            {isAdmin && (
              <div style={{ color: "var(--gold)", marginTop: 4, fontWeight: 700 }}>
                ADMIN
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="main">

        {/* Header stats */}
        <div className="header">
          <div className="stat-pill">
            <span className="stat-label">BALANCE</span>
            <span className="stat-val">
              {accountBalance != null
                ? `$${accountBalance.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "--"}
            </span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">OPEN</span>
            <span className="stat-val">{openPositions.length}</span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">TODAY P&L</span>
            <span className="stat-val" style={{ color: pnlColor(todayPnl) }}>
              {pnlStr(todayPnl)}
            </span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">WIN RATE</span>
            <span
              className="stat-val"
              style={{
                color:
                  parseFloat(winRate) >= 55
                    ? "var(--green)"
                    : parseFloat(winRate) >= 45
                    ? "var(--gold)"
                    : "var(--red)",
              }}
            >
              {winRate}%
            </span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">SESSION</span>
            <span
              className="stat-val"
              style={{
                color: SESSION_COLORS[sessionInfo.session] || "var(--text2)",
                fontSize: 13,
              }}
            >
              {sessionInfo.session}
            </span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">RISK</span>
            <span
              className="stat-val"
              style={{
                fontSize: 13,
                color:
                  riskMode === "AGGRESSIVE"
                    ? "var(--red)"
                    : riskMode === "REGULAR"
                    ? "var(--gold)"
                    : "var(--text2)",
              }}
            >
              {riskMode}
            </span>
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* LIVE TRADE PAGE */}
        {/* ------------------------------------------------------------------ */}
        {page === "live" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Per-instrument AI cards -- one per selected instrument */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${Math.min(instruments.length, 4)}, 1fr)`,
                gap: 12,
              }}
            >
              {instruments.map((sym) => {
                const dec = aiDecisions[sym];
                const status = aiStatus[sym] || "idle";
                const statusColor =
                  status === "long"
                    ? "var(--green)"
                    : status === "short"
                    ? "var(--red)"
                    : status === "thinking"
                    ? "var(--gold)"
                    : "var(--text3)";
                return (
                  <div
                    key={sym}
                    className="card"
                    style={{ borderTop: `2px solid ${statusColor}` }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 8,
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{sym}</span>
                      <span
                        className={`badge badge-${status === "thinking" ? "wait" : status}`}
                        style={{ fontSize: 9, textTransform: "uppercase" }}
                      >
                        {status === "thinking"
                          ? "analyzing"
                          : status === "long"
                          ? "LONG"
                          : status === "short"
                          ? "SHORT"
                          : status === "error"
                          ? "ERROR"
                          : "WAIT"}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 700,
                        color: "var(--text)",
                        marginBottom: 4,
                      }}
                    >
                      {prices[sym] != null
                        ? prices[sym] > 1000
                          ? prices[sym].toLocaleString("en", { maximumFractionDigits: 2 })
                          : prices[sym].toFixed(prices[sym] > 10 ? 2 : 5)
                        : "--"}
                    </div>
                    {dec && dec.decision !== "WAIT" && (
                      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>
                        <div>
                          Conf:{" "}
                          <b style={{ color: "var(--text)" }}>{dec.confidence}%</b>
                          {" "}Vol:{" "}
                          <b>{dec.volume}L</b>
                        </div>
                        <div
                          style={{
                            marginTop: 3,
                            color: "var(--blue)",
                            fontWeight: 600,
                            fontSize: 9,
                            wordBreak: "break-word",
                          }}
                        >
                          {dec.strategy || "--"}
                        </div>
                      </div>
                    )}
                    {dec && dec.decision === "WAIT" && dec.reason && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--text3)",
                          marginTop: 4,
                          lineHeight: 1.4,
                        }}
                      >
                        {dec.reason.slice(0, 80)}
                        {dec.reason.length > 80 ? "..." : ""}
                      </div>
                    )}
                    {crownLocks[sym] && (
                      <div style={{ fontSize: 9, color: "var(--gold)", marginTop: 4 }}>
                        Crown: {crownLocks[sym]}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Open positions */}
            <div className="card">
              <div className="card-title">OPEN POSITIONS ({openPositions.length})</div>
              {openPositions.length === 0 ? (
                <div
                  style={{
                    color: "var(--text3)",
                    textAlign: "center",
                    padding: "20px 0",
                    fontSize: 12,
                  }}
                >
                  No open positions
                </div>
              ) : (
                openPositions.map((pos, i) => {
                  const pnl = pos.profit || 0;
                  const dir =
                    pos.type === "POSITION_TYPE_BUY" ? "LONG" : "SHORT";
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <span
                        style={{ fontWeight: 700, width: 90, color: "var(--gold)", fontSize: 12 }}
                      >
                        {(pos.symbol || "").replace(".s", "").replace(".S", "")}
                      </span>
                      <span className={`badge badge-${dir.toLowerCase()}`}>{dir}</span>
                      <span style={{ fontSize: 12, color: "var(--text2)" }}>
                        {pos.volume}L
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text3)" }}>
                        @ {(pos.openPrice || 0).toFixed(pos.openPrice > 100 ? 2 : 5)}
                      </span>
                      <span
                        style={{ fontWeight: 700, color: pnlColor(pnl), marginLeft: "auto" }}
                      >
                        {pnlStr(pnl)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            {/* Log */}
            <div className="card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <div className="card-title" style={{ marginBottom: 0 }}>
                  SYSTEM LOG
                </div>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => setLog([])}
                >
                  Clear
                </button>
              </div>
              <div ref={logRef} className="log-box">
                {log
                  .slice()
                  .reverse()
                  .map((l, i) => (
                    <div key={i} className={`log-line log-${l.type}`}>
                      <span style={{ color: "var(--text3)", marginRight: 8 }}>
                        {l.time}
                      </span>
                      {l.msg}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* REPORTS PAGE -- sourced from MT5 history, not Redis */}
        {/* ------------------------------------------------------------------ */}
        {page === "reports" && (() => {
          const trades = [...closedTrades].sort(
            (a, b) =>
              new Date(b.time || b.closeTime || 0) -
              new Date(a.time || a.closeTime || 0)
          );
          const netPnl = trades.reduce((s, t) => s + (t.profit || 0), 0);
          const w = trades.filter((t) => t.profit > 0).length;
          const wr =
            trades.length > 0
              ? ((w / trades.length) * 100).toFixed(1)
              : "0.0";
          const avgPnl = trades.length > 0 ? netPnl / trades.length : 0;

          // Group by normalized symbol
          const instMap = {};
          trades.forEach((t) => {
            const k = normalizeSymbol(t.symbol) || t.symbol || "UNKNOWN";
            if (!instMap[k]) instMap[k] = { t: 0, w: 0, pnl: 0 };
            instMap[k].t++;
            instMap[k].pnl += t.profit || 0;
            if (t.profit > 0) instMap[k].w++;
          });

          // Group by session
          const sessMap = {};
          trades.forEach((t) => {
            const s = getSessionLabel(t.time || t.closeTime);
            if (!sessMap[s]) sessMap[s] = { t: 0, w: 0, pnl: 0 };
            sessMap[s].t++;
            sessMap[s].pnl += t.profit || 0;
            if (t.profit > 0) sessMap[s].w++;
          });

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="grid-4">
                {[
                  ["Total Trades", trades.length, "var(--blue)"],
                  ["Net P&L", pnlStr(netPnl), pnlColor(netPnl)],
                  [
                    "Win Rate",
                    `${wr}%`,
                    parseFloat(wr) >= 55
                      ? "var(--green)"
                      : parseFloat(wr) >= 45
                      ? "var(--gold)"
                      : "var(--red)",
                  ],
                  ["Avg / Trade", pnlStr(avgPnl), pnlColor(avgPnl)],
                ].map(([l, v, c]) => (
                  <div key={l} className="card">
                    <div className="card-title">{l}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: c }}>{v}</div>
                  </div>
                ))}
              </div>

              <div className="grid-2">
                <div className="card">
                  <div className="card-title">BY INSTRUMENT</div>
                  {Object.entries(instMap).map(([sym, s]) => (
                    <div
                      key={sym}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <span style={{ fontWeight: 700, width: 80, fontSize: 12 }}>{sym}</span>
                      <span style={{ fontSize: 11, color: "var(--text2)" }}>{s.t}t</span>
                      <span style={{ fontSize: 11, color: "var(--green)" }}>
                        {s.w}W/{s.t - s.w}L
                      </span>
                      <span
                        style={{
                          fontWeight: 700,
                          color: pnlColor(s.pnl),
                          marginLeft: "auto",
                        }}
                      >
                        {pnlStr(s.pnl)}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="card">
                  <div className="card-title">BY SESSION</div>
                  {Object.entries(sessMap)
                    .sort((a, b) => b[1].t - a[1].t)
                    .map(([sess, s]) => (
                      <div
                        key={sess}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 0",
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 700,
                            width: 80,
                            color:
                              SESSION_COLORS[sess] || "var(--text2)",
                            fontSize: 12,
                          }}
                        >
                          {sess}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text2)" }}>{s.t}t</span>
                        <span style={{ fontSize: 11, color: "var(--green)" }}>
                          {s.w}W/{s.t - s.w}L
                        </span>
                        <span
                          style={{
                            fontWeight: 700,
                            color: pnlColor(s.pnl),
                            marginLeft: "auto",
                          }}
                        >
                          {pnlStr(s.pnl)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              {/* Full trade log */}
              <div className="card">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                  }}
                >
                  <div className="card-title" style={{ marginBottom: 0 }}>
                    ALL TRADES ({trades.length})
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text3)" }}>
                    Source: MT5 live history
                  </div>
                </div>
                {trades.length === 0 ? (
                  <div
                    style={{
                      color: "var(--text3)",
                      textAlign: "center",
                      padding: 20,
                    }}
                  >
                    No trades yet
                  </div>
                ) : (
                  trades.map((t, i) => {
                    const pnl = t.profit || 0;
                    const dir =
                      t.type === "DEAL_TYPE_BUY" ||
                      t.type === "POSITION_TYPE_BUY"
                        ? "LONG"
                        : "SHORT";
                    const dt = new Date(t.time || t.closeTime || "");
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "7px 0",
                          borderBottom: "1px solid var(--border)",
                          borderLeft: `3px solid ${pnl > 0 ? "var(--green)" : "var(--red)"}`,
                          paddingLeft: 8,
                        }}
                      >
                        <span style={{ fontWeight: 700, width: 80, fontSize: 12 }}>
                          {normalizeSymbol(t.symbol) || t.symbol || "--"}
                        </span>
                        <span className={`badge badge-${dir.toLowerCase()}`}>{dir}</span>
                        <span style={{ fontWeight: 700, color: pnlColor(pnl) }}>
                          {pnlStr(pnl)}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text3)" }}>
                          {!isNaN(dt) ? `${fmtDate(dt)} ${fmtTime(dt)}` : "--"}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            color:
                              SESSION_COLORS[getSessionLabel(t.time || t.closeTime)] ||
                              "var(--text3)",
                            marginLeft: "auto",
                          }}
                        >
                          {getSessionLabel(t.time || t.closeTime)}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: pnl > 0 ? "var(--green)" : "var(--red)",
                          }}
                        >
                          {pnl > 0 ? "TP" : "SL"}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })()}

        {/* ------------------------------------------------------------------ */}
        {/* BRAIN PAGE */}
        {/* ------------------------------------------------------------------ */}
        {page === "brain" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {instruments.length === 0 ? (
              <div
                className="card"
                style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}
              >
                No instruments selected
              </div>
            ) : (
              instruments.map((sym) => {
                const dec = aiDecisions[sym];
                if (!dec) {
                  return (
                    <div key={sym} className="card">
                      <div className="card-title">{sym}</div>
                      <div style={{ color: "var(--text3)", fontSize: 12 }}>
                        Waiting for first analysis...
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={sym} className="card">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 8,
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{sym}</span>
                      <span
                        className={`badge badge-${(dec.decision || "wait").toLowerCase()}`}
                      >
                        {dec.decision || "WAIT"}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6 }}>
                      {dec.time ? fmtTime(dec.time) : "--"}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.6,
                        color: "var(--text2)",
                        marginBottom: 8,
                      }}
                    >
                      {dec.reason || "--"}
                    </div>
                    {dec.strategy && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--blue)",
                          fontWeight: 600,
                          marginBottom: 6,
                          wordBreak: "break-word",
                        }}
                      >
                        {dec.strategy}
                      </div>
                    )}
                    {dec.decision !== "WAIT" && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--text3)",
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: 4,
                        }}
                      >
                        <span>
                          Confidence:{" "}
                          <b style={{ color: "var(--text)" }}>{dec.confidence}%</b>
                        </span>
                        <span>
                          Volume: <b style={{ color: "var(--text)" }}>{dec.volume}L</b>
                        </span>
                        <span>
                          SL:{" "}
                          <b style={{ color: "var(--red)" }}>
                            {dec.stopLoss != null
                              ? dec.stopLoss.toFixed(
                                  dec.stopLoss > 100 ? 2 : 5
                                )
                              : "--"}
                          </b>
                        </span>
                        <span>
                          TP1:{" "}
                          <b style={{ color: "var(--green)" }}>
                            {dec.takeProfit1 != null
                              ? dec.takeProfit1.toFixed(
                                  dec.takeProfit1 > 100 ? 2 : 5
                                )
                              : "--"}
                          </b>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* STRATEGY LAB -- admin only */}
        {/* ------------------------------------------------------------------ */}
        {page === "lab" && isAdmin && (() => {
          const labEntries = Object.entries(learnedStats || {});
          const sorted = [...labEntries].sort(
            (a, b) => (b[1].total || 0) - (a[1].total || 0)
          );

          // Instruments that appear in the lab data (dynamic, not hardcoded)
          const labInstruments = Array.from(
            new Set(
              labEntries.flatMap(([, data]) =>
                Object.keys(data.instruments || {})
              )
            )
          ).sort();

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="grid-4">
                {[
                  ["Combinations", labEntries.length, "var(--blue)"],
                  [
                    "Crowned",
                    labEntries.filter(([, d]) => (d.crowns || 0) > 0).length,
                    "var(--gold)",
                  ],
                  [
                    "Blacklisted",
                    (blacklist || []).length,
                    "var(--red)",
                  ],
                  [
                    "Total Trades",
                    labEntries.reduce((s, [, d]) => s + (d.total || 0), 0),
                    "var(--text)",
                  ],
                ].map(([l, v, c]) => (
                  <div key={l} className="card">
                    <div className="card-title">{l}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: c }}>{v}</div>
                  </div>
                ))}
              </div>

              {sorted.length === 0 ? (
                <div
                  className="card"
                  style={{ textAlign: "center", padding: 40 }}
                >
                  <div style={{ fontSize: 32, marginBottom: 12 }}>[S]</div>
                  <div style={{ color: "var(--text2)", marginBottom: 6 }}>
                    Strategy Lab is empty
                  </div>
                  <div style={{ color: "var(--text3)", fontSize: 12 }}>
                    Trades will populate this automatically as the bot runs
                  </div>
                </div>
              ) : (
                sorted.map(([strat, data]) => {
                  const bl = (blacklist || []).includes(strat);
                  const cr = data.crowns || 0;
                  const wr = data.overallWinRate;
                  return (
                    <div
                      key={strat}
                      className="card"
                      style={{
                        opacity: bl ? 0.5 : 1,
                        borderLeft: `3px solid ${
                          bl
                            ? "var(--purple)"
                            : cr >= 3
                            ? "var(--gold)"
                            : cr >= 2
                            ? "var(--blue)"
                            : cr >= 1
                            ? "var(--green)"
                            : "var(--border)"
                        }`,
                      }}
                    >
                      {/* Strategy header */}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                          marginBottom: 10,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              gap: 6,
                              alignItems: "center",
                              marginBottom: 4,
                              flexWrap: "wrap",
                            }}
                          >
                            {cr > 0 && (
                              <span>
                                {"[C]".repeat(Math.min(cr, 3))}
                              </span>
                            )}
                            <span style={{ fontSize: 12, fontWeight: 700 }}>
                              {strat}
                            </span>
                            {bl && (
                              <span
                                style={{
                                  fontSize: 9,
                                  background: "rgba(124,58,237,0.1)",
                                  color: "var(--purple)",
                                  padding: "1px 6px",
                                  borderRadius: 3,
                                  fontWeight: 700,
                                }}
                              >
                                BLACKLISTED
                              </span>
                            )}
                            {data.isLocked && (
                              <span
                                style={{
                                  fontSize: 9,
                                  background: "rgba(245,158,11,0.1)",
                                  color: "var(--gold)",
                                  padding: "1px 6px",
                                  borderRadius: 3,
                                  fontWeight: 700,
                                }}
                              >
                                LOCKED
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text3)",
                              display: "flex",
                              gap: 10,
                            }}
                          >
                            <span>{data.total || 0} trades</span>
                            <span style={{ color: "var(--green)" }}>
                              {data.totalWins || 0}W
                            </span>
                            <span style={{ color: "var(--red)" }}>
                              {data.totalLosses || 0}L
                            </span>
                            {wr != null && (
                              <span
                                style={{
                                  fontWeight: 700,
                                  color:
                                    wr >= 65
                                      ? "var(--green)"
                                      : wr >= 50
                                      ? "var(--gold)"
                                      : "var(--red)",
                                }}
                              >
                                {wr}% WR
                              </span>
                            )}
                          </div>
                        </div>
                        {wr != null && (
                          <div
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: "50%",
                              border: `2.5px solid ${
                                wr >= 65
                                  ? "var(--green)"
                                  : wr >= 50
                                  ? "var(--gold)"
                                  : "var(--red)"
                              }`,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 800,
                                color:
                                  wr >= 65
                                    ? "var(--green)"
                                    : wr >= 50
                                    ? "var(--gold)"
                                    : "var(--red)",
                              }}
                            >
                              {wr}%
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Per-instrument breakdown -- dynamic from lab data */}
                      {labInstruments.length > 0 && (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: `repeat(${Math.min(labInstruments.length, 4)}, 1fr)`,
                            gap: 8,
                          }}
                        >
                          {labInstruments.map((inst) => {
                            const d = (data.instruments || {})[inst];
                            return (
                              <div
                                key={inst}
                                style={{
                                  background: "var(--card2)",
                                  borderRadius: 6,
                                  padding: "8px 10px",
                                  border: `1px solid ${
                                    d && d.crown
                                      ? "var(--green)"
                                      : d && d.banned
                                      ? "var(--red)"
                                      : "var(--border)"
                                  }`,
                                  opacity: d ? 1 : 0.4,
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    marginBottom: 4,
                                  }}
                                >
                                  <span
                                    style={{
                                      fontSize: 10,
                                      fontWeight: 700,
                                      color: "var(--text2)",
                                    }}
                                  >
                                    {inst}
                                  </span>
                                  {d && d.crown && <span>[C]</span>}
                                  {d && d.banned && (
                                    <span
                                      style={{
                                        fontSize: 9,
                                        color: "var(--red)",
                                        fontWeight: 700,
                                      }}
                                    >
                                      BAN
                                    </span>
                                  )}
                                </div>
                                {d ? (
                                  <>
                                    <div
                                      style={{
                                        fontSize: 11,
                                        display: "flex",
                                        gap: 6,
                                      }}
                                    >
                                      <span style={{ color: "var(--green)" }}>
                                        {d.wins}W
                                      </span>
                                      <span style={{ color: "var(--red)" }}>
                                        {d.losses}L
                                      </span>
                                    </div>
                                    {d.winRate != null && (
                                      <div style={{ marginTop: 4 }}>
                                        <div className="pbar-bg">
                                          <div
                                            className="pbar"
                                            style={{
                                              width: `${d.winRate}%`,
                                              background:
                                                d.winRate >= 65
                                                  ? "var(--green)"
                                                  : d.winRate >= 50
                                                  ? "var(--gold)"
                                                  : "var(--red)",
                                            }}
                                          />
                                        </div>
                                        <div
                                          style={{
                                            fontSize: 9,
                                            color: "var(--text3)",
                                            marginTop: 2,
                                          }}
                                        >
                                          {d.winRate}%
                                          {d.avgPnl != null
                                            ? ` | avg ${d.avgPnl >= 0 ? "+" : ""}$${d.avgPnl}`
                                            : ""}
                                        </div>
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <div style={{ fontSize: 10, color: "var(--text3)" }}>
                                    Not tested
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          );
        })()}

        {/* ------------------------------------------------------------------ */}
        {/* SETTINGS PAGE */}
        {/* ------------------------------------------------------------------ */}
        {page === "settings" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
              maxWidth: 500,
            }}
          >
            <div className="card">
              <div className="card-title">CURRENT CONFIG</div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}
              >
                {[
                  ["Role", isAdmin ? "Admin (UI only)" : "User"],
                  ["Risk Mode", riskMode],
                  ["Instruments", instruments.join(", ") || "none"],
                  ["Sessions", sessions.join(", ") || "none"],
                  ["Account", accountId ? accountId.slice(0, 12) + "..." : "--"],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "6px 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span style={{ color: "var(--text3)" }}>{k}</span>
                    <span style={{ fontWeight: 600 }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {isAdmin && Object.keys(crownLocks).length > 0 && (
              <div className="card">
                <div className="card-title">CROWN LOCKS</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {Object.entries(crownLocks).map(([inst, strat]) => (
                    <div
                      key={inst}
                      style={{
                        background: "var(--card2)",
                        borderRadius: 6,
                        padding: "6px 10px",
                        fontSize: 11,
                        border: "1px solid rgba(245,158,11,0.2)",
                      }}
                    >
                      <span style={{ color: "var(--gold)", marginRight: 4 }}>Crown</span>
                      <span style={{ color: "var(--text2)" }}>{inst}:</span>
                      <span style={{ color: "var(--text)", marginLeft: 4 }}>{strat}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isAdmin && (
              <div className="card">
                <div className="card-title">SAVED PROFILE</div>
                <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 10 }}>
                  Your account ID, token, instruments, sessions and risk mode are saved locally.
                  Next admin login will connect automatically without asking for credentials.
                </div>
                <button
                  className="btn btn-sm"
                  style={{ background: "rgba(239,68,68,0.1)", color: "var(--red)" }}
                  onClick={() => {
                    try { localStorage.removeItem(ADMIN_STORAGE_KEY); } catch (e) {}
                    alert("Saved profile cleared. Next login will ask for credentials again.");
                  }}
                >
                  Forget saved credentials
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function App() {
  const [config, setConfig] = useState(null);

  return (
    <>
      <style>{CSS}</style>
      {config == null ? (
        <SetupScreen onConnected={setConfig} />
      ) : (
        <TradingApp config={config} />
      )}
    </>
  );
}