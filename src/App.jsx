/* eslint-disable */
// JARVIS · Quantum Bot v17 — Live Dashboard
// ─────────────────────────────────────────────────────────────────────────────
// All panels pull from real API endpoints.
// JARVIS chat is live via POST /api/jarvis.
// Trade DNA computed from recognition-memory (all closed trades).
// QB Nexus analysis is real — computed client-side from trade intersections.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import "./index.css";
// ─── Constants ────────────────────────────────────────────────────────────────
const API = p => `/api/${p}`;

const TPLS = {
  'orb-pro':       { glyph: '⚡', label: 'ORB-PRO' },
  'silver-bullet': { glyph: '🥈', label: 'SILVER-BLT' },
  'alexg':         { glyph: '📐', label: 'ALEX-G' },
  'reaction-fvg':  { glyph: '🌀', label: 'REACT-FVG' },
  'reaction':      { glyph: '🎯', label: 'REACT-IMP' },
  'reaction-ifvg': { glyph: '🔄', label: 'REACT-IFVG' },
  'am-ifvg':       { glyph: '🌅', label: 'AM-IFVG' },
  'unicorn':       { glyph: '🦄', label: 'UNICORN' },
  'turtle-soup':   { glyph: '🐢', label: 'TURTLE-SOP' },
  'judas-swing':   { glyph: '🎭', label: 'JUDAS' },
  'orb':           { glyph: '🚀', label: 'ORB' },
  'ote-continuation': { glyph: '🎯', label: 'OTE-CONT' },
};

const SESSION_LABELS = {
  london: 'LONDON', london_open: 'LONDON', new_york: 'NEW YORK', ny_am: 'NY AM',
  ny_pm: 'NY PM', asian: 'ASIAN', sydney: 'SYDNEY', unknown: '—',
};

const MODE_LABELS = { active: '🟢 ACTIVE', defensive: '🛡 DEFENSIVE', sleep: '🌙 SLEEP', vacation: '🏖 VACATION' };

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmtMoney = (n, decimals = 0) =>
  typeof n === 'number' && isFinite(n)
    ? (n >= 0 ? '+' : '') + n.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : '—';

const fmtMoneyAbs = (n, decimals = 0) =>
  typeof n === 'number' && isFinite(n)
    ? '$' + Math.abs(n).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : '—';

const fmtR = n => typeof n === 'number' && isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(1) + 'R' : '—';
const pct  = (n, d=0) => typeof n === 'number' && isFinite(n) ? (n*100).toFixed(d) + '%' : '—';

const fmtTime = ts => {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
};

const fmtRelTime = ts => {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60)  return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff/60)}m ago`;
  return `${Math.round(diff/3600)}h ago`;
};

function tplLabel(id) {
  return TPLS[id]?.label || id?.toUpperCase() || '?';
}
function tplGlyph(id) {
  return TPLS[id]?.glyph || '⊕';
}
function sessLabel(s) {
  return SESSION_LABELS[s?.toLowerCase()] || s?.toUpperCase() || '—';
}

// ─── QB Nexus Real Analysis ───────────────────────────────────────────────────
function computeNexus(trades) {
  if (!trades || trades.length < 10) return null;

  const isWin  = t => t.outcome === 'WIN';
  const isLoss = t => t.outcome === 'LOSS';
  const rOf    = t => (typeof t.pnlR === 'number' && isFinite(t.pnlR)) ? t.pnlR : null;
  const avgArr = arr => arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;

  const total = trades.length;
  const overallWR  = trades.filter(isWin).length / total;
  const overallAvgR = avgArr(trades.map(rOf).filter(v => v !== null));

  // Per-template breakdown
  const byTpl = {};
  for (const t of trades) {
    const k = t.template || 'unknown';
    if (!byTpl[k]) byTpl[k] = { w:0, l:0, r:[] };
    if (isWin(t)) byTpl[k].w++;
    else if (isLoss(t)) byTpl[k].l++;
    const r = rOf(t); if (r !== null) byTpl[k].r.push(r);
  }
  const tplStats = Object.entries(byTpl)
    .map(([id, s]) => ({ id, total: s.w+s.l, wins: s.w, wr: s.w+s.l ? s.w/(s.w+s.l) : 0, avgR: avgArr(s.r) }))
    .filter(s => s.total >= 4)
    .sort((a,b) => b.wr - a.wr);

  // Per-session breakdown
  const bySess = {};
  for (const t of trades) {
    const k = t.session || 'unknown';
    if (!bySess[k]) bySess[k] = { w:0, total:0, r:[] };
    bySess[k].total++;
    if (isWin(t)) bySess[k].w++;
    const r = rOf(t); if (r !== null) bySess[k].r.push(r);
  }
  const sessStats = Object.entries(bySess)
    .map(([id, s]) => ({ id, total: s.total, wins: s.w, wr: s.total ? s.w/s.total : 0, avgR: avgArr(s.r) }))
    .filter(s => s.total >= 4)
    .sort((a,b) => b.wr - a.wr);

  const bestTpl  = tplStats[0] || null;
  const bestSess = sessStats[0] || null;

  // Nexus intersection: best template + best session + no high-impact news
  const nexus = trades.filter(t =>
    (!bestTpl  || t.template === bestTpl.id) &&
    (!bestSess || t.session  === bestSess.id) &&
    !t.highImpactWithin60min
  );

  const nWins  = nexus.filter(isWin).length;
  const nexusWR  = nexus.length ? nWins / nexus.length : 0;
  const nexusAvgR = avgArr(nexus.map(rOf).filter(v => v !== null));

  return {
    total, overallWR, overallAvgR, tplStats, sessStats,
    bestTpl, bestSess,
    nexusSample: nexus.length,
    nexusWR, nexusAvgR,
    confidence: nexus.length >= 25 ? 'HIGH' : nexus.length >= 12 ? 'MEDIUM' : 'LOW',
    nexusTrades: nexus,
  };
}

// ─── Orb Canvas ───────────────────────────────────────────────────────────────
function OrbCanvas({ state }) {
  const canvasRef = useRef(null);
  const animRef   = useRef(null);
  const t0        = useRef(Date.now());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W/2, cy = H/2;

    const color = state === 'signal' ? '#00ff9d' : state === 'warn' ? '#f59e0b' : state === 'critical' ? '#ff2d55' : '#00e5ff';
    const rgb   = state === 'signal' ? '0,255,157' : state === 'warn' ? '245,158,11' : state === 'critical' ? '255,45,85' : '0,229,255';

    const draw = () => {
      const now = (Date.now() - t0.current) / 1000;
      ctx.clearRect(0, 0, W, H);

      // outer glow
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 80);
      g.addColorStop(0, `rgba(${rgb},.1)`);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // rings
      [70, 54, 38].forEach((r, i) => {
        ctx.beginPath();
        ctx.arc(cx, cy, r + Math.sin(now * (0.5 + i * 0.2)) * 2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${0.15 + i * 0.05})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // rotating particles
      for (let i = 0; i < 8; i++) {
        const angle = (now * 0.6 + (i / 8) * Math.PI * 2);
        const rx = cx + Math.cos(angle) * 54;
        const ry = cy + Math.sin(angle) * 54;
        ctx.beginPath();
        ctx.arc(rx, ry, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${0.3 + 0.3 * Math.sin(now * 2 + i)})`;
        ctx.fill();
      }

      // inner pulse
      const pulse = 0.7 + 0.3 * Math.sin(now * 2);
      const gi = ctx.createRadialGradient(cx, cy, 0, cx, cy, 24 * pulse);
      gi.addColorStop(0, `rgba(${rgb},.7)`);
      gi.addColorStop(0.5, `rgba(${rgb},.25)`);
      gi.addColorStop(1, 'transparent');
      ctx.fillStyle = gi;
      ctx.beginPath();
      ctx.arc(cx, cy, 24 * pulse, 0, Math.PI * 2);
      ctx.fill();

      // core dot
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      animRef.current = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [state]);

  return <canvas ref={canvasRef} width={160} height={160} style={{ display:'block', position:'relative', zIndex:1 }} />;
}

// ─── Gate Row ─────────────────────────────────────────────────────────────────
function GateRow({ icon, name, desc, value, status }) {
  return (
    <div className={`gRow ${status}`}>
      <span className="gIco">{icon}</span>
      <div style={{flex:1}}>
        <div className="gName">{name}</div>
        {desc && <div className="gDesc">{desc}</div>}
      </div>
      <span className={`gVal ${status}`}>{value}</span>
    </div>
  );
}

// ─── Gates Panel ─────────────────────────────────────────────────────────────
function GatesPanel({ jarvisState, rules }) {
  const kz   = jarvisState?.killZone;
  const cb   = jarvisState?.circuitBreakers || {};
  const mode = rules?.activeMode || 'active';

  const gatingRules = jarvisState?.gatingRules || {};
  const blockedTpls = Object.entries(gatingRules)
    .filter(([k, v]) => v === false || v?.enabled === false)
    .map(([k]) => k);

  const gates = [
    {
      icon: '⏱', name: 'Kill Zone', desc: kz?.label || '—',
      value: kz?.inKillZone ? kz.label : (kz?.minutesUntilNext ? `in ${kz.minutesUntilNext}m` : 'INACTIVE'),
      status: kz?.inKillZone ? 'pass' : 'warn',
    },
    {
      icon: '🎯', name: 'Active Mode', desc: 'Bot behavioral posture',
      value: mode.toUpperCase(),
      status: mode === 'active' ? 'pass' : mode === 'defensive' ? 'warn' : 'off',
    },
    {
      icon: '🔄', name: 'Trading Mode', desc: rules?.tradingMode === 'auto' ? 'Auto-execute signals' : 'Alert only',
      value: (rules?.tradingMode || 'auto').toUpperCase(),
      status: rules?.tradingMode === 'auto' ? 'pass' : 'warn',
    },
    {
      icon: '📏', name: 'Lot Multiplier', desc: `Tier A × ${rules?.tierALotMultiplier?.toFixed(2) || '1.00'} · Tier B × ${rules?.tierBLotMultiplier?.toFixed(2) || '1.00'}`,
      value: `×${(rules?.tierBLotMultiplier || 1).toFixed(2)}`,
      status: (rules?.tierBLotMultiplier || 1) >= 1 ? 'pass' : 'warn',
    },
    {
      icon: '🚫', name: 'OTE-Continuation', desc: 'Permanently disabled',
      value: 'BLOCKED', status: 'off',
    },
    {
      icon: '⚡', name: 'SB Immediate', desc: 'Silver Bullet immediate-only',
      value: 'ENFORCED', status: 'pass',
    },
    {
      icon: '📋', name: 'Blocked Templates', desc: blockedTpls.length ? blockedTpls.join(', ') : 'none',
      value: blockedTpls.length ? `${blockedTpls.length} blocked` : 'ALL CLEAR',
      status: blockedTpls.length ? 'warn' : 'pass',
    },
  ];

  const passCount = gates.filter(g => g.status === 'pass').length;

  return (
    <div className="pnl" style={{flexShrink:0}}>
      <div className="pH">
        <span className="pHL">Signal Gates</span>
        <span className="tag ai">{passCount}/{gates.length}</span>
      </div>
      <div style={{padding:'4px 0'}}>
        {gates.map((g,i) => <GateRow key={i} {...g} />)}
      </div>
    </div>
  );
}

// ─── News Panel ───────────────────────────────────────────────────────────────
function NewsPanel({ news }) {
  const events = useMemo(() => {
    const list = news?.upcoming || news?.events || [];
    return list.filter(e => e.ts > Date.now()).slice(0, 6);
  }, [news]);

  return (
    <div className="pnl" style={{flexShrink:0}}>
      <div className="pH">
        <span className="pHL">News Feed</span>
        <span className="tag ai">LIVE</span>
      </div>
      {events.length === 0 && (
        <div style={{padding:'8px 9px',color:'var(--dim)',fontSize:9}}>No high-impact events in next 12h</div>
      )}
      {events.map((e,i) => {
        const impClass = e.impact === 'high' ? 'nHigh' : e.impact === 'medium' ? 'nMed' : 'nLow';
        const minsAway = Math.round((e.ts - Date.now()) / 60000);
        return (
          <div className="nItem" key={i}>
            <div className="nHead">
              <span className={`nTag ${impClass}`}>{e.impact}</span>
              <span className="nCurr">{e.currency}</span>
              <span className="nTime">{minsAway < 60 ? `${minsAway}m` : `${Math.round(minsAway/60)}h`}</span>
            </div>
            <div className="nTitle">{e.title}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Signal Panel ─────────────────────────────────────────────────────────────
function SignalPanel({ jarvisState }) {
  const watchers = jarvisState?.watchers || {};
  const activeAssets = Object.entries(watchers).filter(([,w]) => w?.currentSetup || w?.direction);
  const best = activeAssets[0];
  const w    = best?.[1];
  const asset = best?.[0];

  if (!w) {
    return (
      <div className="pnl" style={{flexShrink:0}}>
        <div className="pH"><span className="pHL">Live Signal</span></div>
        <div className="sigBig">
          <div className="sigDir none">SCANNING<span className="sigSym">—</span></div>
          <div className="sigSub">No active setups across all instruments</div>
        </div>
      </div>
    );
  }

  const dir = (w.direction || 'long').toLowerCase();
  const template = w.currentSetup?.template || w.template || '—';
  const knnWR = w.knnWR || jarvisState?.sigQual?.knnWinRate;

  return (
    <div className="pnl" style={{flexShrink:0}}>
      <div className="pH">
        <span className="pHL">Live Signal</span>
        <span className="tag live">ACTIVE</span>
      </div>
      <div className="sigBig">
        <div className={`sigDir ${dir}`}>
          {dir === 'long' ? 'LONG' : 'SHORT'}
          <span className="sigSym">{asset?.toUpperCase()}</span>
        </div>
        <div className="sigSub">{tplLabel(template)} · {sessLabel(jarvisState?.killZone?.label)}</div>
      </div>
      <div className="sigGrid">
        <div className="sMeta"><div className="sMetaV">{tplLabel(template)}</div><div className="sMetaL">Template</div></div>
        <div className="sMeta"><div className="sMetaV">{knnWR ? pct(knnWR,0) : '—'}</div><div className="sMetaL">KNN Match</div></div>
        <div className="sMeta"><div className="sMetaV">{w.pendingCount || '—'}</div><div className="sMetaL">Pending</div></div>
        <div className="sMeta"><div className="sMetaV">{jarvisState?.sigQual?.knnAvgR ? fmtR(jarvisState.sigQual.knnAvgR) : '—'}</div><div className="sMetaL">Avg R</div></div>
      </div>
    </div>
  );
}

// ─── Template Strip ───────────────────────────────────────────────────────────
function TemplateStrip({ rules, trades, onSelectTpl }) {
  const tplIds = Object.keys(rules?.templateOverrides || TPLS);

  const dnaMap = useMemo(() => {
    const m = {};
    for (const t of (trades || [])) {
      const id = t.template || 'unknown';
      if (!m[id]) m[id] = [];
      m[id].push(t.outcome);
    }
    return m;
  }, [trades]);

  const wrMap = useMemo(() => {
    const m = {};
    for (const id of tplIds) {
      const arr = dnaMap[id] || [];
      if (!arr.length) { m[id] = null; continue; }
      const wins = arr.filter(o => o === 'WIN').length;
      m[id] = wins / arr.length;
    }
    return m;
  }, [dnaMap, tplIds]);

  return (
    <div id="tplStrip">
      <div className="pH">
        <span className="pHL">Templates · {trades?.length || 0} trades</span>
        <button onClick={() => onSelectTpl('log')} className="tbBtnB tbBtn" style={{fontSize:7.5}}>Trade Log</button>
      </div>
      <div id="tplRow">
        {tplIds.map(id => {
          const meta   = TPLS[id] || { glyph:'⊕', label: id.toUpperCase() };
          const ov     = rules?.templateOverrides?.[id] || {};
          const enabled = ov.enabled !== false;
          const wr     = wrMap[id];
          const dna    = (dnaMap[id] || []).slice(-12);

          return (
            <div key={id} className={`tChip ${!enabled ? 'dis' : ''}`} onClick={() => onSelectTpl(id)}>
              <div className="tCG">{meta.glyph}</div>
              <div className="tCN">{meta.label}</div>
              <div className={`tCS ${wr !== null ? (wr >= 0.5 ? 'g' : 'a') : ''}`}>
                {wr !== null ? pct(wr,0) : (dnaMap[id]?.length ? pct(0,0) : '—')}
              </div>
              <div className="tcDNA">
                {dna.map((o,i) => (
                  <div key={i} className={`dNb ${o === 'WIN' ? 'w' : o === 'LOSS' ? 'l' : 'b'}`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Positions Panel ──────────────────────────────────────────────────────────
function PositionsPanel({ positions }) {
  if (!positions?.length) return (
    <div className="pnl">
      <div className="pH"><span className="pHL">Open Positions</span></div>
      <div style={{padding:'8px 9px',color:'var(--dim)',fontSize:9}}>No open positions</div>
    </div>
  );

  return (
    <div className="pnl">
      <div className="pH">
        <span className="pHL">Open Positions</span>
        <span className="tag live">{positions.length}</span>
      </div>
      {positions.map((p,i) => {
        const isLong = (p.type === 'POSITION_TYPE_BUY' || p.type === 'BUY' || p.type === 0);
        const pnl = p.profit ?? p.unrealizedProfit ?? 0;
        const sym = (p.symbol || p.id || '').replace(/^.*\//, '').toUpperCase();
        return (
          <div className="posRow" key={i}>
            <span className="pSym">{sym.slice(0, 8)}</span>
            <span className={`pDir ${isLong ? 'long' : 'short'}`}>{isLong ? 'BUY' : 'SELL'}</span>
            <div className="pInfo">
              <div className="pEntry">{p.volume ? `${p.volume} lot` : ''} · {p.openPrice?.toFixed(p.openPrice > 100 ? 2 : 5) || ''}</div>
            </div>
            <span className={`pPnl ${pnl >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(pnl,2)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Equity Panel ─────────────────────────────────────────────────────────────
function EquityPanel({ account, dailyPnL, goals }) {
  const equity = account?.equity ?? account?.balance ?? 0;
  const balance = account?.balance ?? equity;
  const float   = account?.profit ?? 0;
  const dailyGoal = goals?.daily?.target || 0;
  const dailyAchieved = goals?.daily?.achieved ?? Math.max(0, dailyPnL);
  const goalPct = dailyGoal > 0 ? Math.min(100, (dailyAchieved / dailyGoal) * 100) : 0;

  return (
    <div className="pnl">
      <div className="pH">
        <span className="pHL">Account</span>
        {dailyGoal > 0 && <span className="tag ai">{goalPct.toFixed(0)}% goal</span>}
      </div>
      <div className="eqBig">{equity ? `$${equity.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</div>
      <div className="eqSub" style={{color: dailyPnL >= 0 ? 'var(--pulse)' : 'var(--thr)'}}>
        Today {fmtMoney(dailyPnL,2)} · Float {fmtMoney(float,2)}
      </div>
      {dailyGoal > 0 && (
        <>
          <div className="goalBar"><div className="goalFill" style={{width:`${goalPct}%`}} /></div>
          <div style={{padding:'0 9px 5px',fontSize:7.5,color:'var(--dim)',fontFamily:'var(--mono)'}}>
            Goal {fmtMoneyAbs(dailyAchieved)} / {fmtMoneyAbs(dailyGoal)} daily
          </div>
        </>
      )}
      <div style={{display:'flex',gap:7,padding:'3px 9px 6px',flexWrap:'wrap'}}>
        <span style={{fontSize:8,color:'var(--dim)',fontFamily:'var(--mono)'}}>
          BAL <span style={{color:'var(--txt)'}}>{balance ? `$${balance.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</span>
        </span>
        {goals?.monthly?.target > 0 && (
          <span style={{fontSize:8,color:'var(--dim)',fontFamily:'var(--mono)'}}>
            MTH <span style={{color:'var(--pulse)'}}>
              {pct((goals.monthly.achieved||0)/goals.monthly.target,0)}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Activity Panel ───────────────────────────────────────────────────────────
function ActivityPanel({ activity }) {
  const items = useMemo(() => (activity || []).slice(0,20), [activity]);

  const dotColor = type => {
    if (!type) return 'b';
    const t = type.toLowerCase();
    if (t.includes('win') || t.includes('tp') || t.includes('profit')) return 'g';
    if (t.includes('loss') || t.includes('sl') || t.includes('error')) return 'r';
    if (t.includes('warn') || t.includes('skip') || t.includes('block')) return 'a';
    return 'b';
  };

  return (
    <div className="pnl" style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column'}}>
      <div className="pH"><span className="pHL">Activity Log</span></div>
      <div style={{flex:1,overflowY:'auto',padding:'3px 0'}}>
        {items.length === 0 && <div style={{padding:'8px 9px',color:'var(--dim)',fontSize:9}}>No activity yet</div>}
        {items.map((a,i) => (
          <div className="aRow" key={i}>
            <div className={`aDot ${dotColor(a.type)}`} />
            <div>
              <div className="aT" dangerouslySetInnerHTML={{__html: (a.message || a.msg || '').replace(/\b(WIN|LOSS|BE|BLOCKED|SKIP)\b/g, '<b>$1</b>')}} />
              <div className="aTm">{fmtRelTime(a.ts)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── JARVIS Chat ──────────────────────────────────────────────────────────────
function JarvisChat({ messages, thinking, focusDock, onDismissFocus }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, thinking]);

  return (
    <div id="jConv">
      <div id="jConvH">
        <div style={{width:6,height:6,borderRadius:'50%',background:'var(--pur)',animation:'dp 1.5s ease-in-out infinite'}} />
        <span style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--pur)',letterSpacing:1.5,fontWeight:700}}>JARVIS · AI CO-PILOT</span>
        <span className="tag ai" style={{marginLeft:'auto'}}>LIVE</span>
      </div>
      {focusDock && (
        <div id="jFocus" className="show">
          <div className="fdCard">
            <div className="fdTitle">
              <span>{focusDock.title || 'JARVIS FOCUS'}</span>
              <button className="dismissBtn" onClick={onDismissFocus}>dismiss</button>
            </div>
            {(focusDock.rows || []).map((row,i) => (
              <div className="fdRow" key={i}>
                <span className="fdK">{row.k}</span>
                <span className="fdV" style={{color: row.color || 'var(--txt)'}}>{row.v}</span>
              </div>
            ))}
            {focusDock.bar != null && (
              <div className="goalBar" style={{marginTop:5}}>
                <div className="goalFill" style={{width:`${Math.min(100,focusDock.bar*100)}%`}} />
              </div>
            )}
          </div>
        </div>
      )}
      <div id="jMsgs">
        {messages.map((m,i) => (
          <div key={i} className={`jM ${m.role === 'jarvis' ? 'j' : 'u'}`}>
            <div className={`jMB ${m.urgency === 'critical' ? 'jUrgent' : m.urgency === 'elevated' ? 'jElevated' : ''}`}>
              {m.role === 'jarvis' && <div className="px">JARVIS · {fmtTime(m.ts)}</div>}
              {m.text}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="jM j">
            <div className="jMB">
              <div className="px">JARVIS · processing…</div>
              <div className="jThink"><span/><span/><span/></div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ─── Trade Log Modal ──────────────────────────────────────────────────────────
function TradeLogModal({ trades, onClose }) {
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let arr = trades || [];
    if (filter !== 'ALL') arr = arr.filter(t => t.outcome === filter);
    if (search) {
      const q = search.toLowerCase();
      arr = arr.filter(t => (t.asset||'').includes(q) || (t.template||'').includes(q) || (t.session||'').includes(q));
    }
    return arr.slice().sort((a,b) => (b.closedAt||0) - (a.closedAt||0));
  }, [trades, filter, search]);

  const wins   = filtered.filter(t => t.outcome === 'WIN').length;
  const losses = filtered.filter(t => t.outcome === 'LOSS').length;
  const wrLive = filtered.length ? pct(wins/filtered.length,0) : '—';
  const rVals  = filtered.map(t => t.pnlR).filter(v => typeof v === 'number' && isFinite(v));
  const avgR   = rVals.length ? (rVals.reduce((a,b)=>a+b,0)/rVals.length).toFixed(2) : '—';

  return (
    <div className="overlay" onClick={e => e.target.className.includes('overlay') && onClose()}>
      <div className="modCard logCard">
        <div className="modH">
          <span className="modHN">📊 Trade Log · {trades?.length || 0} total</span>
          <span style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)'}}>WR {wrLive} · Avg R {avgR}R · {wins}W / {losses}L</span>
          <button className="modClose" onClick={onClose}>✕</button>
        </div>
        <div className="modBody">
          <div style={{display:'flex',gap:8,marginBottom:10,flexWrap:'wrap',alignItems:'center'}}>
            <div className="tblFilter">
              {['ALL','WIN','LOSS','BREAKEVEN'].map(f => (
                <button key={f} className={`fBtn ${filter===f?'on':''}`} onClick={() => setFilter(f)}>{f}</button>
              ))}
            </div>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Filter by asset, template…"
              style={{background:'rgba(0,20,48,.5)',border:'1px solid var(--b)',borderRadius:4,color:'var(--txt)',
                fontFamily:'var(--mono)',fontSize:9,padding:'3px 8px',outline:'none',flex:1,minWidth:140}}
            />
            <span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)'}}>{filtered.length} rows</span>
          </div>
          <div className="tblWrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th><th>Asset</th><th>Dir</th><th>Template</th>
                  <th>Session</th><th>Outcome</th><th>PnL</th><th>R</th><th>Hold</th><th>KNN</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0,300).map((t,i) => {
                  const oc = t.outcome === 'WIN' ? 'tblWin' : t.outcome === 'LOSS' ? 'tblLoss' : 'tblBE';
                  return (
                    <tr key={i}>
                      <td style={{color:'var(--dim)',whiteSpace:'nowrap'}}>{fmtTime(t.closedAt)}</td>
                      <td style={{color:'var(--ion)',fontWeight:700}}>{(t.asset||'?').toUpperCase()}</td>
                      <td>
                        <span style={{fontSize:7,padding:'1px 4px',borderRadius:3,
                          background: t.direction==='long'?'rgba(0,255,157,.1)':'rgba(255,45,85,.1)',
                          color: t.direction==='long'?'var(--pulse)':'var(--thr)'}}>
                          {(t.direction||'?').toUpperCase()}
                        </span>
                      </td>
                      <td style={{color:'var(--txt)'}}>{tplLabel(t.template)}</td>
                      <td style={{color:'var(--dim)'}}>{sessLabel(t.session)}</td>
                      <td className={oc}>{t.outcome}</td>
                      <td className={oc}>{fmtMoney(t.pnl,2)}</td>
                      <td className={oc}>{fmtR(t.pnlR)}</td>
                      <td style={{color:'var(--dim)'}}>{t.holdTimeMinutes != null ? `${t.holdTimeMinutes}m` : '—'}</td>
                      <td style={{color:'var(--dim)'}}>{t.qualityTier || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── QB Nexus Modal ───────────────────────────────────────────────────────────
function NexusModal({ trades, onClose }) {
  const nexus = useMemo(() => computeNexus(trades), [trades]);

  if (!nexus) return (
    <div className="overlay" onClick={e => e.target.className.includes('overlay') && onClose()}>
      <div className="modCard nexCard" style={{padding:24,textAlign:'center'}}>
        <div style={{color:'var(--pur)',fontFamily:'var(--mono)',fontSize:14,fontWeight:800,marginBottom:8}}>⬡ QB-NEXUS</div>
        <div style={{color:'var(--dim)',fontSize:10}}>Insufficient trade data (need ≥ 10 closed trades)</div>
        <button className="nexClose" style={{marginTop:16}} onClick={onClose}>Close</button>
      </div>
    </div>
  );

  const realWR  = pct(nexus.nexusWR,1);
  const baseWR  = pct(nexus.overallWR,1);
  const lift    = ((nexus.nexusWR - nexus.overallWR)*100).toFixed(1);

  return (
    <div className="overlay" onClick={e => e.target.className.includes('overlay') && onClose()}>
      <div className="modCard nexCard">
        <div className="modH">
          <span className="modHN pur">⬡ QB-NEXUS · Real Analysis</span>
          <span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)'}}>{nexus.total} trades analysed</span>
          <button className="modClose" onClick={onClose}>✕</button>
        </div>
        <div className="modBody">
          <div className="nexGrid">
            <div className="nexCard">
              <div className="nexCT">Nexus WR</div>
              <div className="nexCV" style={{color:'var(--pulse)'}}>{realWR}</div>
              <div className="nexCL">vs {baseWR} overall ({lift >= 0 ? '+':''}{lift}pp lift)</div>
            </div>
            <div className="nexCard">
              <div className="nexCT">Nexus Avg R</div>
              <div className="nexCV" style={{color:'var(--ion)'}}>{fmtR(nexus.nexusAvgR)}</div>
              <div className="nexCL">vs {fmtR(nexus.overallAvgR)} overall</div>
            </div>
            <div className="nexCard">
              <div className="nexCT">Confidence</div>
              <div className="nexCV" style={{color:'var(--pur)'}}>{nexus.confidence}</div>
              <div className="nexCL">{nexus.nexusSample} qualifying trades</div>
            </div>
          </div>

          <div className="nexRec">
            <b>⬡ QB-NEXUS</b> optimal conditions identified from real data:<br/>
            {nexus.bestTpl && <><b>Best template:</b> {tplLabel(nexus.bestTpl.id)} ({pct(nexus.bestTpl.wr,1)} WR on {nexus.bestTpl.total} trades) <br/></>}
            {nexus.bestSess && <><b>Best session:</b> {sessLabel(nexus.bestSess.id)} ({pct(nexus.bestSess.wr,1)} WR on {nexus.bestSess.total} trades)<br/></>}
            <b>No-news filter:</b> exclude trades within 60m of high-impact events<br/>
            <b>Intersection sample:</b> {nexus.nexusSample} trades · {realWR} WR · {fmtR(nexus.nexusAvgR)} avg R
            {nexus.confidence === 'LOW' && <><br/><span style={{color:'var(--amb)'}}>⚠ Sample size low — use as directional guidance only</span></>}
          </div>

          <div style={{fontSize:9,color:'var(--dim)',marginBottom:6,fontFamily:'var(--mono)',textTransform:'uppercase',letterSpacing:.5}}>Template Breakdown (all {nexus.total} trades)</div>
          <div className="tplStatGrid">
            {nexus.tplStats.map((s,i) => (
              <div className="tplStat" key={i}>
                <div className="tplStatV" style={{color: s.wr>=0.6?'var(--pulse)':s.wr>=0.45?'var(--ion)':'var(--thr)'}}>
                  {pct(s.wr,1)}
                </div>
                <div style={{fontFamily:'var(--mono)',fontSize:7,color:'var(--ion)',marginBottom:3}}>{tplLabel(s.id)}</div>
                <div className="tplStatL">{s.total} trades · {fmtR(s.avgR)}</div>
              </div>
            ))}
          </div>

          <div style={{fontSize:9,color:'var(--dim)',marginBottom:6,marginTop:10,fontFamily:'var(--mono)',textTransform:'uppercase',letterSpacing:.5}}>Session Breakdown</div>
          <div className="tplStatGrid">
            {nexus.sessStats.map((s,i) => (
              <div className="tplStat" key={i}>
                <div className="tplStatV" style={{color: s.wr>=0.6?'var(--pulse)':s.wr>=0.45?'var(--ion)':'var(--thr)'}}>
                  {pct(s.wr,1)}
                </div>
                <div style={{fontFamily:'var(--mono)',fontSize:7,color:'var(--ion)',marginBottom:3}}>{sessLabel(s.id)}</div>
                <div className="tplStatL">{s.total} trades · {fmtR(s.avgR)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Template Detail Modal ────────────────────────────────────────────────────
function TemplateModal({ tplId, trades, rules, onClose }) {
  const meta  = TPLS[tplId] || { glyph:'⊕', label: tplId };
  const tTrades = useMemo(() => (trades||[]).filter(t => t.template === tplId), [trades, tplId]);
  const wins  = tTrades.filter(t => t.outcome === 'WIN').length;
  const losses= tTrades.filter(t => t.outcome === 'LOSS').length;
  const wr    = tTrades.length ? wins/tTrades.length : 0;
  const rVals = tTrades.map(t=>t.pnlR).filter(v=>typeof v==='number'&&isFinite(v));
  const avgR  = rVals.length ? rVals.reduce((a,b)=>a+b,0)/rVals.length : 0;
  const recent= tTrades.slice().sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)).slice(0,50);
  const ov    = rules?.templateOverrides?.[tplId] || {};

  return (
    <div className="overlay" onClick={e => e.target.className.includes('overlay') && onClose()}>
      <div className="modCard logCard">
        <div className="modH">
          <span style={{fontSize:20}}>{meta.glyph}</span>
          <span className="modHN">{meta.label}</span>
          <button className="modClose" onClick={onClose}>✕</button>
        </div>
        <div className="modBody">
          <div className="tplStatGrid" style={{gridTemplateColumns:'repeat(4,1fr)'}}>
            <div className="tplStat"><div className="tplStatV" style={{color:'var(--pulse)'}}>{pct(wr,1)}</div><div className="tplStatL">Win Rate</div></div>
            <div className="tplStat"><div className="tplStatV" style={{color:'var(--ion)'}}>{fmtR(avgR)}</div><div className="tplStatL">Avg R</div></div>
            <div className="tplStat"><div className="tplStatV">{tTrades.length}</div><div className="tplStatL">Total Trades</div></div>
            <div className="tplStat"><div className="tplStatV" style={{color: ov.enabled!==false?'var(--pulse)':'var(--thr)'}}>{ov.enabled!==false?'ON':'OFF'}</div><div className="tplStatL">Status</div></div>
          </div>
          <div style={{display:'flex',gap:1.5,margin:'10px 0',overflow:'hidden',height:24,borderRadius:4}}>
            {tTrades.slice(-60).map((t,i) => (
              <div key={i} style={{flex:1,minWidth:4,background:t.outcome==='WIN'?'rgba(0,255,157,.7)':t.outcome==='LOSS'?'rgba(255,45,85,.7)':'rgba(0,229,255,.25)',borderRadius:1}} />
            ))}
            {tTrades.length === 0 && <div style={{color:'var(--dim)',fontSize:9,padding:'4px 0'}}>No trade data</div>}
          </div>
          <div style={{fontSize:8,color:'var(--dim)',marginBottom:8,fontFamily:'var(--mono)'}}>Recent trades (trade DNA · last 60)</div>
          <div className="tblWrap">
            <table className="tbl">
              <thead><tr><th>Time</th><th>Asset</th><th>Dir</th><th>Session</th><th>Outcome</th><th>PnL</th><th>R</th></tr></thead>
              <tbody>
                {recent.map((t,i) => {
                  const oc = t.outcome==='WIN'?'tblWin':t.outcome==='LOSS'?'tblLoss':'tblBE';
                  return (
                    <tr key={i}>
                      <td style={{color:'var(--dim)'}}>{fmtTime(t.closedAt)}</td>
                      <td style={{color:'var(--ion)',fontWeight:700}}>{(t.asset||'?').toUpperCase()}</td>
                      <td><span style={{fontSize:7,padding:'1px 4px',borderRadius:3,background:t.direction==='long'?'rgba(0,255,157,.1)':'rgba(255,45,85,.1)',color:t.direction==='long'?'var(--pulse)':'var(--thr)'}}>{(t.direction||'?').toUpperCase()}</span></td>
                      <td style={{color:'var(--dim)'}}>{sessLabel(t.session)}</td>
                      <td className={oc}>{t.outcome}</td>
                      <td className={oc}>{fmtMoney(t.pnl,2)}</td>
                      <td className={oc}>{fmtR(t.pnlR)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [account,     setAccount]     = useState(null);
  const [positions,   setPositions]   = useState([]);
  const [rules,       setRules]       = useState(null);
  const [activity,    setActivity]    = useState([]);
  const [dailyPnL,    setDailyPnL]    = useState(0);
  const [trades,      setTrades]      = useState([]);
  const [jarvisState, setJarvisState] = useState(null);
  const [goals,       setGoals]       = useState(null);
  const [news,        setNews]        = useState(null);
  const [messages,    setMessages]    = useState([]);
  const [thinking,    setThinking]    = useState(false);
  const [modal,       setModal]       = useState(null); // null | {type:'log'|'nexus'|'tpl'|'estop', id?}
  const [focusDock,   setFocusDock]   = useState(null);
  const [clock,       setClock]       = useState('');
  const [input,       setInput]       = useState('');
  const [ambClass,    setAmbClass]    = useState('monitor');
  const inputRef = useRef(null);

  // ── Clock ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const ny = new Date(d.toLocaleString('en-US',{timeZone:'America/New_York'}));
      setClock(ny.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) + ' NY');
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Data polling ───────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const fast = async () => {
      try {
        const [a, p] = await Promise.all([
          fetch(API('broker?action=account')).then(r=>r.json()).catch(()=>null),
          fetch(API('broker?action=positions')).then(r=>r.json()).catch(()=>[]),
        ]);
        if (!alive) return;
        if (a && !a.error) setAccount(a);
        setPositions(Array.isArray(p) ? p : []);
      } catch (_) {}
    };
    fast();
    const id = setInterval(fast, 5000);
    return () => { alive=false; clearInterval(id); };
  }, []);

  useEffect(() => {
    let alive = true;
    const slow = async () => {
      try {
        const [r, act, pnl, js, g, n] = await Promise.all([
          fetch(API('rules')).then(r=>r.json()).catch(()=>null),
          fetch(API('rules?action=activity&limit=60')).then(r=>r.json()).catch(()=>null),
          fetch(API('manage-trades?action=today-pnl')).then(r=>r.json()).catch(()=>null),
          fetch(API('jarvis-state')).then(r=>r.json()).catch(()=>null),
          fetch(API('jarvis-goal')).then(r=>r.json()).catch(()=>null),
          Promise.all([
            fetch(API('news-context?asset=gold')).then(r=>r.json()).catch(()=>null),
            fetch(API('news-context?asset=eurusd')).then(r=>r.json()).catch(()=>null),
          ]).then(([a, b]) => {
            // merge live+imminent+today from both assets, dedupe by title+ts
            const merge = (x) => [
              ...(x?.events?.live    || []),
              ...(x?.events?.imminent|| []),
              ...(x?.events?.today   || []),
            ];
            const all = [...merge(a), ...merge(b)];
            const seen = new Set();
            const deduped = all.filter(e => {
              const k = `${e.title}|${e.ts}`;
              if (seen.has(k)) return false;
              seen.add(k); return true;
            });
            deduped.sort((x,y) => x.ts - y.ts);
            return { upcoming: deduped, state: a?.state || b?.state || 'none' };
          }),
        ]);
        if (!alive) return;
        if (r && !r.error)            setRules(r);
        if (act?.activity)            setActivity(act.activity);
        if (pnl?.pnl != null)         setDailyPnL(pnl.pnl);
        else if (pnl?.ok === false) {
          // fallback
          fetch(API('rules?action=daily-pnl')).then(r=>r.json()).then(r2 => { if(alive && r2?.pnl!=null) setDailyPnL(r2.pnl); }).catch(()=>{});
        }
        if (js && !js.error)          setJarvisState(js);
        if (g && !g.error)            setGoals(g);
        if (n && !n.error)            setNews(n);
      } catch (_) {}
    };
    slow();
    const id = setInterval(slow, 20000);
    return () => { alive=false; clearInterval(id); };
  }, []);

  // Load all trades once, then refresh every 5 minutes
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(API('recognition-memory?action=list&limit=600')).then(r=>r.json());
        if (alive && Array.isArray(r)) setTrades(r);
        else if (alive && Array.isArray(r?.trades)) setTrades(r.trades);
      } catch (_) {}
    };
    load();
    const id = setInterval(load, 300000);
    return () => { alive=false; clearInterval(id); };
  }, []);

  // ── Ambient glow from jarvis urgency ──────────────────────────────────────
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'jarvis') return;
    if (last.urgency === 'critical')      setAmbClass('critical');
    else if (last.urgency === 'elevated') setAmbClass('warn');
    else                                  setAmbClass('monitor');
  }, [messages]);

  // ── JARVIS send ────────────────────────────────────────────────────────────
  const sendToJarvis = useCallback(async (text) => {
    if (!text.trim() || thinking) return;
    const userMsg = { role:'user', text: text.trim(), ts: Date.now() };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setThinking(true);
    try {
      const res = await fetch(API('jarvis'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.trim(), base: window.location.origin }),
      });
      const data = await res.json();
      const reply = {
        role: 'jarvis',
        text: data.speech || 'No response.',
        urgency: data.urgency,
        focusPanel: data.focusPanel,
        action: data.action,
        ts: Date.now(),
      };
      setMessages(m => [...m, reply]);

      // Build focus dock from JARVIS response
      if (data.focusPanel === 'goal' && goals) {
        const achieved = goals.daily.achieved ?? dailyPnL;
        const target   = goals.daily.target;
        setFocusDock({
          title: 'GOAL PROGRESS',
          rows: [
            { k: 'Today banked', v: fmtMoneyAbs(achieved,2), color: 'var(--pulse)' },
            { k: 'Daily target', v: fmtMoneyAbs(target,2) },
            { k: 'Remaining',   v: fmtMoneyAbs(Math.max(0,target-achieved),2), color: 'var(--amb)' },
          ],
          bar: target > 0 ? Math.min(1, achieved / target) : null,
        });
      } else if (data.focusPanel && data.action) {
        setFocusDock(null);
      }

      if (data.urgency === 'critical' || (data.urgency === 'elevated' && data.action?.type === 'pending_trade')) {
        setAmbClass('signal');
      }
    } catch (e) {
      setMessages(m => [...m, { role:'jarvis', text:`Error: ${e.message}`, urgency:'elevated', ts: Date.now() }]);
    } finally {
      setThinking(false);
    }
  }, [thinking, goals, dailyPnL]);

  // ── E-Stop ─────────────────────────────────────────────────────────────────
  const fireEStop = useCallback(async () => {
    try {
      await fetch(API('rules?action=emergency-stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: true }),
      });
      setModal(null);
      setAmbClass('critical');
      setMessages(m => [...m, { role:'jarvis', text:'Emergency stop activated. All new trade execution halted. Existing positions are still managed.', urgency:'critical', ts: Date.now() }]);
    } catch (e) {
      setMessages(m => [...m, { role:'jarvis', text:`E-Stop failed: ${e.message}`, urgency:'critical', ts: Date.now() }]);
    }
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const mode  = rules?.activeMode || 'active';
  const orbState = positions.length > 0 && positions.some(p => (p.profit??0) < -50) ? 'warn'
                 : positions.length > 0 ? 'signal' : 'monitor';

  // Greeting on first load
  useEffect(() => {
    const eq = account?.equity;
    const msg = eq
      ? `Good ${new Date().getHours()<12?'morning':new Date().getHours()<18?'afternoon':'evening'}, Sir. Quantum Bot v17 online. Equity $${eq.toLocaleString('en-US',{maximumFractionDigits:2})} · ${trades.length} trades in memory · Mode: ${(rules?.activeMode||'active').toUpperCase()}. How can I assist?`
      : `JARVIS online. Type any command or question, Sir.`;
    if (messages.length === 0 && (account || trades.length > 0)) {
      setMessages([{ role:'jarvis', text: msg, urgency:'normal', ts: Date.now() }]);
    }
  }, [account, trades.length, rules?.activeMode]);

  const quickBtns = [
    { label:'⚡ Signal',      q:'What is the current signal?' },
    { label:'🔒 Gates',       q:'Show me all gates status' },
    { label:'📊 Performance', q:'What is my performance today?' },
    { label:'🌍 Briefing',    q:'Market briefing and news' },
    { label:'📡 Pine',        q:'Show pine vision across all timeframes' },
    { label:'🎯 Calibrate',   q:'Calibrate sizing for my goal' },
    { label:'🧠 Advise',      q:'What should I do right now?' },
    { label:'⬡ QB-NEXUS',    q:null, action:()=>setModal({type:'nexus'}), cls:'p' },
    { label:'📋 Trade Log',  q:null, action:()=>setModal({type:'log'}), cls:'g' },
    { label:'⛔ E-STOP',     q:null, action:()=>setModal({type:'estop'}), cls:'r' },
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="hud">
        <div id="amb" className={ambClass} />

        {/* TOP BAR */}
        <div id="top">
          <div className="tLogo">
            <div className="tDot" />
            JARVIS · QB v17
          </div>
          <div className="tSep" />
          <div className="tSt">
            <span className={`tV ${dailyPnL >= 0 ? 'g' : 'r'}`}>{fmtMoney(dailyPnL, 2)}</span>
            <span className="tL">Today P&L</span>
          </div>
          <div className="tSep" />
          <div className="tSt">
            <span className="tV" style={{color:'var(--ion)'}}>
              {account?.equity ? `$${Math.round(account.equity).toLocaleString()}` : '—'}
            </span>
            <span className="tL">Equity</span>
          </div>
          <div className="tSep" />
          <div className="tSt">
            <span className="tV" style={{color: positions.length?'var(--pulse)':'var(--dim)'}}>
              {positions.length}
            </span>
            <span className="tL">Positions</span>
          </div>
          <div className="tSep" />
          <div className="tSt">
            <span className="tV" style={{color:'var(--txt)'}}>{trades.length}</span>
            <span className="tL">Trades</span>
          </div>
          <div className="tR">
            <span style={{fontFamily:'var(--mono)',fontSize:9.5,color:'var(--ion)',letterSpacing:.5}}>{clock}</span>
            <span className={`mBadge ${mode}`} onClick={() => sendToJarvis(`Set mode to ${mode==='active'?'defensive':'active'}`)}>
              {MODE_LABELS[mode] || mode.toUpperCase()}
            </span>
            <button className="tbBtn tbBtnP" onClick={() => setModal({type:'nexus'})}>⬡ NEXUS</button>
            <button className="tbBtn tbBtnB" onClick={() => setModal({type:'log'})}>📋 LOG</button>
            <button className="tbBtn tbBtnR" onClick={() => setModal({type:'estop'})}>⛔ E-STOP</button>
          </div>
        </div>

        {/* WORKSPACE */}
        <div id="ws">
          {/* LEFT */}
          <div id="lCol">
            <SignalPanel jarvisState={jarvisState} />
            <GatesPanel jarvisState={jarvisState} rules={rules} />
            <NewsPanel news={news} />
          </div>

          {/* CENTER */}
          <div id="cCol">
            <div id="orbWrap" style={{height:175}}>
              <OrbCanvas state={orbState} />
              <div className="orbStatus">
                <div className="orbDot" />
                {jarvisState?.killZone?.inKillZone ? jarvisState.killZone.label : 'SCANNING'} ·{' '}
                {rules?.tradingMode === 'auto' ? 'AUTO' : 'MANUAL'}
              </div>
            </div>
            <JarvisChat
              messages={messages}
              thinking={thinking}
              focusDock={focusDock}
              onDismissFocus={() => setFocusDock(null)}
            />
            <TemplateStrip
              rules={rules}
              trades={trades}
              onSelectTpl={id => id === 'log' ? setModal({type:'log'}) : setModal({type:'tpl', id})}
            />
          </div>

          {/* RIGHT */}
          <div id="rCol">
            <EquityPanel account={account} dailyPnL={dailyPnL} goals={goals} />
            <PositionsPanel positions={positions} />
            <ActivityPanel activity={activity} />
          </div>
        </div>

        {/* COMMAND BAR */}
        <div id="cmd">
          <div className="cmdR1">
            <button className="vBtn" title="Voice (coming soon)">🎙</button>
            <input
              id="cmdIn"
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendToJarvis(input)}
              placeholder="Ask JARVIS anything…  e.g. 'I want $1000 today' · 'Close gold' · 'Show performance'"
              disabled={thinking}
            />
            <button className="vBtn" onClick={() => sendToJarvis(input)} title="Send" style={{background:'rgba(0,229,255,.12)'}}>⚡</button>
          </div>
          <div className="qBtns">
            {quickBtns.map((b,i) => (
              <button
                key={i}
                className={`qB ${b.cls||''}`}
                onClick={() => b.action ? b.action() : sendToJarvis(b.q)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* MODALS */}
      {modal?.type === 'log' && (
        <TradeLogModal trades={trades} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'nexus' && (
        <NexusModal trades={trades} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'tpl' && (
        <TemplateModal tplId={modal.id} trades={trades} rules={rules} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'estop' && (
        <div className="overlay">
          <div className="eSBox">
            <div className="eST">⛔ EMERGENCY STOP</div>
            <div className="eSM">All new trade execution will be immediately halted. Open positions continue to be managed. This is a config change — it does not close any position.</div>
            <div className="eSBtns">
              <button className="eSGo" onClick={fireEStop}>CONFIRM STOP</button>
              <button className="eSCancel" onClick={() => setModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
