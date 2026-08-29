/* eslint-disable */
import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import './index.css';

import FTMOBar        from './components/FTMOBar';
import NavBar         from './components/NavBar';
import LiveTab        from './components/tabs/LiveTab';
import SpecialistsTab from './components/tabs/SpecialistsTab';
import StatsTab       from './components/tabs/StatsTab';
import LogTab         from './components/tabs/LogTab';
import ControlsTab    from './components/tabs/ControlsTab';

// Normalise a ledger entry to consistent field names across API versions
function normTrade(t) {
  return {
    ...t,
    finalPnL:  t.netPnl   ?? t.finalPnL  ?? t.pnl    ?? null,
    closedAt:  t.closedAt  ? (typeof t.closedAt === 'number' ? t.closedAt : new Date(t.closedAt).getTime()) : null,
    entry:     t.actualEntry ?? t.entry   ?? null,
    sl:        t.slPrice   ?? t.sl        ?? null,
    tp1:       t.exitPrice ?? t.tp1       ?? null,
  };
}

// Normalise template-performance by-template map: winRate comes as 0-1 from API
function normPerf(byTemplate) {
  if (!byTemplate) return {};
  const out = {};
  Object.entries(byTemplate).forEach(([k, v]) => {
    out[k] = {
      ...v,
      winRate: v.winRate != null ? v.winRate * 100
             : v.wr     != null ? v.wr
             : null,
    };
  });
  return out;
}

export default function App() {
  // ── Tab routing ───────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('live');

  // ── API data ──────────────────────────────────────────────────────────────────
  const [quotes,      setQuotes]      = useState({});
  const [positions,   setPositions]   = useState([]);
  const [capital,     setCapital]     = useState(null);
  const [jarvis,      setJarvis]      = useState(null);
  const [ledger,      setLedger]      = useState([]);
  const [perf,        setPerf]        = useState({});
  const [ftmoStatus,  setFtmoStatus]  = useState(null);
  const [gatingRules, setGatingRules] = useState({});

  // ── Aurora background refs ────────────────────────────────────────────────────
  const bgRef  = useRef(null);
  const bgtRef = useRef(0);

  // ── Aurora animation (preserved from V17) ────────────────────────────────────
  useEffect(() => {
    const c = bgRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
    resize(); window.addEventListener('resize', resize);
    let raf;
    const draw = () => {
      const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
      const t = bgtRef.current * .0022;
      [
        [W*.2  + Math.sin(t)     * W*.07, H*.35 + Math.cos(t*.7) * H*.06, [212,160,23]],
        [W*.82 + Math.cos(t*.6)  * W*.06, H*.6  + Math.sin(t*.8) * H*.05, [139,92,246]],
        [W*.5  + Math.sin(t*.5)  * W*.05, H*.12 + Math.cos(t)    * H*.04, [14,165,233]],
      ].forEach(([x, y, rgb]) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, W*.26);
        g.addColorStop(0, `rgba(${rgb},.04)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      });
      bgtRef.current++;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(raf); };
  }, []);

  // ── Data fetchers ─────────────────────────────────────────────────────────────
  const fetchQuotes = useCallback(async () => {
    const assets = ['gold', 'nas100', 'ger40'];
    const results = await Promise.allSettled(
      assets.map(a => fetch(`/api/quotes?asset=${a}&limit=60`).then(r => r.ok ? r.json() : null).catch(() => null))
    );
    const next = {};
    assets.forEach((a, i) => {
      const v = results[i].value;
      if (v) next[a] = v;
    });
    setQuotes(next);
  }, []);

  const fetchPositionsAndCapital = useCallback(async () => {
    try {
      const [posData, sumData] = await Promise.all([
        fetch('/api/dashboard-feed?action=positions').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/dashboard-feed?action=summary').then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (posData) {
        setPositions(Array.isArray(posData) ? posData : posData.positions || []);
      }
      if (sumData?.account?.balance != null) setCapital(sumData.account.balance);
      if (sumData?.jarvis || sumData?.directive) {
        setJarvis(sumData.jarvis || sumData.directive || null);
      }
    } catch {}
  }, []);

  const fetchLedger = useCallback(async () => {
    try {
      const data = await fetch('/api/ledger?action=list&limit=200').then(r => r.ok ? r.json() : null);
      if (!data) return;
      const rows = Array.isArray(data) ? data : data.trades || data.items || [];
      setLedger(rows.map(normTrade));
    } catch {}
  }, []);

  const fetchPerf = useCallback(async () => {
    try {
      const data = await fetch('/api/template-performance').then(r => r.ok ? r.json() : null);
      if (data) setPerf(normPerf(data.byTemplate || data));
    } catch {}
  }, []);

  const fetchFTMO = useCallback(async () => {
    try {
      const data = await fetch('/api/ftmo-guard').then(r => r.ok ? r.json() : null);
      if (data) setFtmoStatus(data);
    } catch {}
  }, []);

  const fetchGating = useCallback(async () => {
    try {
      const data = await fetch('/api/gating-rules').then(r => r.ok ? r.json() : null);
      if (data) setGatingRules(data);
    } catch {}
  }, []);

  // ── Polling schedule ──────────────────────────────────────────────────────────
  useEffect(() => {
    // Initial load (parallel)
    Promise.all([
      fetchPositionsAndCapital(),
      fetchFTMO(),
      fetchQuotes(),
      fetchLedger(),
      fetchPerf(),
      fetchGating(),
    ]);

    const timers = [
      setInterval(fetchPositionsAndCapital, 20_000),
      setInterval(fetchFTMO,               30_000),
      setInterval(fetchQuotes,             60_000),
      setInterval(fetchLedger,            300_000),
      setInterval(fetchPerf,              300_000),
    ];
    return () => timers.forEach(clearInterval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Position actions (BE / partial / close) ───────────────────────────────────
  const handlePositionAction = useCallback(async (action, positionId) => {
    try {
      await fetch(`/api/manage?action=${action}&positionId=${encodeURIComponent(positionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      // Re-fetch positions after 2 s to reflect the change
      setTimeout(fetchPositionsAndCapital, 2000);
    } catch {}
  }, [fetchPositionsAndCapital]);

  // ── Tab pages ─────────────────────────────────────────────────────────────────
  const PAGES = {
    live:        <LiveTab        positions={positions} quotes={quotes} jarvis={jarvis} onPositionAction={handlePositionAction} />,
    specialists: <SpecialistsTab positions={positions} ledger={ledger} perf={perf} ftmoStatus={ftmoStatus} />,
    stats:       <StatsTab       ledger={ledger} capital={capital} />,
    log:         <LogTab         ledger={ledger} />,
    controls:    <ControlsTab    gatingRules={gatingRules} onGatingUpdate={setGatingRules} ftmoStatus={ftmoStatus} />,
  };

  return (
    <div className="v20-shell">
      {/* Ambient aurora background (full-screen fixed canvas) */}
      <canvas ref={bgRef} id="bgC" />

      {/* FTMO guard bar — always visible, drives colour theme of the session */}
      <FTMOBar status={ftmoStatus} />

      {/* Main body: sidebar nav (desktop) + scrollable tab viewport */}
      <div className="v20-body pg">
        <NavBar active={activeTab} onChange={setActiveTab} />

        <div className="v20-viewport">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0  }}
              exit={{    opacity: 0, y: -6 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              style={{ minHeight: '100%' }}
            >
              {PAGES[activeTab]}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
