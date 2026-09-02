/* eslint-disable */
import { useState, useEffect, useCallback, useMemo } from 'react';
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


export default function App() {
  // ── API data ──────────────────────────────────────────────────────────────────
  const [quotes,      setQuotes]      = useState({});
  const [positions,   setPositions]   = useState([]);
  const [capital,     setCapital]     = useState(null);
  const [jarvis,      setJarvis]      = useState(null);
  const [ledger,      setLedger]      = useState([]);
  // perf is derived from ledger — no separate API call needed
  const [ftmoStatus,  setFtmoStatus]  = useState(null);
  const [gatingRules, setGatingRules] = useState({});
  const [accounts,    setAccounts]    = useState([]);
  const [accountStatus, setAccountStatus] = useState('loading'); // 'loading' | 'none' | 'standby' | 'live'
  const [upcomingNews, setUpcomingNews] = useState([]);

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

  // Compute live per-specialist WR/PF + combined totals from ledger
  const { perf, totalPerf } = useMemo(() => {
    const map = {};
    ledger.forEach(t => {
      if (!t.template || t.finalPnL == null) return;
      if (!map[t.template]) map[t.template] = { wins: 0, total: 0, grossWin: 0, grossLoss: 0 };
      map[t.template].total++;
      if (t.finalPnL > 0) { map[t.template].wins++; map[t.template].grossWin += t.finalPnL; }
      else { map[t.template].grossLoss += Math.abs(t.finalPnL); }
    });
    const perf = {};
    let totWins=0, totTotal=0, totGW=0, totGL=0;
    Object.entries(map).forEach(([k, v]) => {
      perf[k] = {
        winRate: v.total > 0 ? (v.wins / v.total) * 100 : null,
        profitFactor: v.grossLoss > 0 ? v.grossWin / v.grossLoss : null,
        trades: v.total,
      };
      totWins+=v.wins; totTotal+=v.total; totGW+=v.grossWin; totGL+=v.grossLoss;
    });
    const totalPerf = {
      winRate: totTotal > 0 ? (totWins/totTotal)*100 : null,
      profitFactor: totGL > 0 ? totGW/totGL : null,
      trades: totTotal,
    };
    return { perf, totalPerf };
  }, [ledger]);

  // News status: CLEAR / WARN / BLOCK based on high-impact events near window
  const newsStatus = useMemo(() => {
    const high = upcomingNews.filter(n => n.impact === 'high' && ['USD','EUR'].includes(n.currency));
    if (high.some(n => Math.abs(n.minutesAway) <= 60)) return 'block';
    if (high.some(n => n.minutesAway > 0 && n.minutesAway <= 120)) return 'warn';
    return 'clear';
  }, [upcomingNews]);

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

  const fetchNews = useCallback(async () => {
    try {
      const data = await fetch('/api/news-context?all=1').then(r => r.ok ? r.json() : null);
      if (data?.upcoming) setUpcomingNews(data.upcoming);
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
      fetchGating(),
      fetchAccounts(),
      fetchNews(),
    ]);

    const timers = [
      setInterval(fetchPositionsAndCapital, 20_000),
      setInterval(fetchFTMO,               30_000),
      setInterval(fetchQuotes,             60_000),
      setInterval(fetchLedger,            300_000),
      setInterval(fetchAccounts,           60_000),
      setInterval(fetchNews,             300_000),
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
      totalPerf={totalPerf}
      ftmoStatus={ftmoStatus}
      gatingRules={gatingRules}
      accounts={accounts}
      accountStatus={accountStatus}
      upcomingNews={upcomingNews}
      newsStatus={newsStatus}
      onPositionAction={handlePositionAction}
    />
  );
}
