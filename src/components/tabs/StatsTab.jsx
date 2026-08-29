import EquityChart from '../EquityChart';

function KPITile({ label, value, sub, color }) {
  return (
    <div className="kpi-tile" style={{ borderTopColor: color || 'var(--b2)' }}>
      <span className="kpi-lbl">{label}</span>
      <span className="kpi-val" style={{ color: color || 'var(--t)' }}>{value ?? '—'}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

function buildKPIs(ledger, perf) {
  const closed = (ledger || []).filter(t => t.finalPnL != null);
  if (!closed.length) return null;

  const wins   = closed.filter(t => t.finalPnL > 0.5).length;
  const losses = closed.filter(t => t.finalPnL < -0.5).length;
  const total  = wins + losses;
  const wr     = total > 0 ? (wins / total) * 100 : 0;

  const grossProfit = closed.filter(t => t.finalPnL > 0).reduce((s, t) => s + t.finalPnL, 0);
  const grossLoss   = Math.abs(closed.filter(t => t.finalPnL < 0).reduce((s, t) => s + t.finalPnL, 0));
  const pf          = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const totalPnL = closed.reduce((s, t) => s + t.finalPnL, 0);

  const avgWin  = wins   > 0 ? grossProfit / wins   : 0;
  const avgLoss = losses > 0 ? grossLoss   / losses : 0;
  const avgR    = avgLoss > 0 ? avgWin / avgLoss : 0;

  return { wr, pf, totalPnL, avgR, count: closed.length, wins, losses };
}

function buildWeekData(ledger) {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const map  = {};
  const now  = new Date();
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - now.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);

  (ledger || []).forEach(t => {
    if (!t.closedAt || t.finalPnL == null) return;
    const d = new Date(t.closedAt);
    if (d < weekStart) return;
    const dow = d.getUTCDay();
    map[dow] = (map[dow] || 0) + t.finalPnL;
  });

  return days.map((lbl, i) => ({ lbl, pnl: map[i] || 0 }));
}

function WeekBars({ ledger }) {
  const data   = buildWeekData(ledger);
  const maxAbs = Math.max(...data.map(d => Math.abs(d.pnl)), 1);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 60, padding: '0 2px' }}>
      {data.map(d => {
        const h   = Math.max(3, (Math.abs(d.pnl) / maxAbs) * 56);
        const pos = d.pnl >= 0;
        return (
          <div key={d.lbl} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <div style={{ width: '100%', height: h, background: pos ? 'var(--bu)' : 'var(--be)', opacity: d.pnl === 0 ? 0.15 : 0.8, minHeight: 3, borderRadius: 1 }} />
            <span style={{ font: '600 7px/1 system-ui', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{d.lbl}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function StatsTab({ ledger, capital }) {
  const kpis = buildKPIs(ledger);

  return (
    <div className="stats-layout">

      {/* KPI row */}
      <div className="perf-kpis">
        <KPITile
          label="Win Rate"
          value={kpis ? `${kpis.wr.toFixed(1)}%` : '—'}
          sub={kpis ? `${kpis.wins}W / ${kpis.losses}L` : null}
          color={kpis && kpis.wr >= 55 ? 'var(--bu)' : kpis ? 'var(--wa)' : undefined}
        />
        <KPITile
          label="Profit Factor"
          value={kpis ? (kpis.pf === Infinity ? '∞' : kpis.pf.toFixed(2)) : '—'}
          sub={kpis ? `${kpis.count} closed trades` : null}
          color={kpis && kpis.pf >= 1.5 ? 'var(--bu)' : kpis && kpis.pf >= 1 ? 'var(--wa)' : kpis ? 'var(--be)' : undefined}
        />
        <KPITile
          label="Avg RR"
          value={kpis ? `${kpis.avgR.toFixed(2)}R` : '—'}
          color="var(--ml)"
        />
        <KPITile
          label="Total P&L"
          value={kpis ? `${kpis.totalPnL >= 0 ? '+' : ''}$${kpis.totalPnL.toFixed(0)}` : '—'}
          color={kpis && kpis.totalPnL >= 0 ? 'var(--bu)' : 'var(--be)'}
        />
      </div>

      {/* Equity curve */}
      <div>
        <div className="v20-sec">
          <span className="v20-sec-title">Equity Curve</span>
          <div className="v20-sec-line" />
        </div>
        <EquityChart ledger={ledger} capital={capital} />
      </div>

      {/* Week bars */}
      <div className="p">
        <div className="pt">This Week</div>
        <WeekBars ledger={ledger} />
      </div>

    </div>
  );
}
