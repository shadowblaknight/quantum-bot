/* eslint-disable */
import { useState, useEffect, useCallback } from 'react';
import './index.css';

import TerminalLayout from './components/TerminalLayout';

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
  // ── API data ──────────────────────────────────────────────────────────────────
  const [quotes,      setQuotes]      = useState({});
  const [positions,   setPositions]   = useState([]);
  const [capital,     setCapital]     = useState(null);
  const [jarvis,      setJarvis]      = useState(null);
  const [ledger,      setLedger]      = useState([]);
  const [perf,        setPerf]        = useState({});
  const [ftmoStatus,  setFtmoStatus]  = useState(null);
  const [gatingRules, setGatingRules] = useState({});
  const [accounts,    setAccounts]    = useState([]);
  const [accountStatus, setAccountStatus] = useState('loading'); // 'loading' | 'none' | 'standby' | 'live'

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

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await fetch('/api/dashboard-feed?action=accounts').then(r => r.ok ? r.json() : null).catch(() => null);
      if (!data) { setAccountStatus('none'); return; }
      if (!data.configured) { setAccountStatus('none'); setAccounts([]); return; }
      const list = data.accounts || [];
      setAccounts(list);
      const live = list.some(a => a.connected && a.balance != null);
      const configured = list.length > 0;
      setAccountStatus(live ? 'live' : configured ? 'standby' : 'none');
    } catch { setAccountStatus('none'); }
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
      fetchAccounts(),
    ]);

    const timers = [
      setInterval(fetchPositionsAndCapital, 20_000),
      setInterval(fetchFTMO,               30_000),
      setInterval(fetchQuotes,             60_000),
      setInterval(fetchLedger,            300_000),
      setInterval(fetchPerf,              300_000),
      setInterval(fetchAccounts,           60_000),
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

  return (
    <TerminalLayout
      positions={positions}
      quotes={quotes}
      capital={capital}
      jarvis={jarvis}
      ledger={ledger}
      perf={perf}
      ftmoStatus={ftmoStatus}
      gatingRules={gatingRules}
      accounts={accounts}
      accountStatus={accountStatus}
      onPositionAction={handlePositionAction}
    />
  );
}
