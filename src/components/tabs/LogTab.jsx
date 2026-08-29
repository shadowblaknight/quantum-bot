import { useState } from 'react';

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d  = new Date(ts);
  const today = new Date().toDateString();
  if (d.toDateString() === today) return `Today ${fmtTime(ts)}`;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${fmtTime(ts)}`;
}

function tagClass(pnl) {
  if (pnl >  0.5) return 'win';
  if (pnl < -0.5) return 'loss';
  return 'be';
}

function tagLabel(pnl) {
  if (pnl >  0.5) return 'WIN';
  if (pnl < -0.5) return 'LOSS';
  return 'BE';
}

function ActivityFeed({ ledger }) {
  const items = [...(ledger || [])]
    .filter(t => t.finalPnL != null)
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, 30);

  if (!items.length) {
    return <div style={{ padding: '24px', textAlign: 'center', color: 'var(--t3)', font: '400 11px/1.5 system-ui' }}>No recent trade activity.</div>;
  }

  return (
    <div className="feed-list">
      {items.map((t, i) => {
        const pnl  = t.finalPnL ?? 0;
        const sign = pnl >= 0 ? '+' : '';
        const tmpl = t.template?.replace(/-specialist$/, '')?.replace(/-/g, ' ').toUpperCase() || '—';
        const zone = t.zoneType ? ` · ${t.zoneType.toUpperCase()}` : '';
        return (
          <div className="feed-item" key={t.id || i}>
            <span className="feed-time">{fmtDate(t.closedAt)}</span>
            <span className="feed-body">
              <strong>{tmpl}{zone}</strong> {t.direction} — {sign}${Math.abs(pnl).toFixed(2)}
            </span>
            <span className={`feed-tag ${tagClass(pnl)}`}>{tagLabel(pnl)}</span>
          </div>
        );
      })}
    </div>
  );
}

function JournalTable({ ledger, onDelete }) {
  const [filter, setFilter] = useState('all');

  const filtered = (ledger || []).filter(t => {
    if (filter === 'scalp') return t.type === 'scalp';
    if (filter === 'day')   return t.type === 'day';
    return true;
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
        {['all', 'scalp', 'day'].map(f => (
          <button
            key={f}
            className={`jftab${filter === f ? ' a' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f.toUpperCase()}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', font: '600 8px/1 system-ui', color: 'var(--t3)', alignSelf: 'center' }}>
          {filtered.length} trades
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="jtbl">
          <thead>
            <tr>
              <th>Time</th>
              <th>Template</th>
              <th>Dir</th>
              <th>Entry</th>
              <th>SL</th>
              <th>TP</th>
              <th>RR</th>
              <th>P&amp;L</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 50).map((t, i) => {
              const pnl = t.finalPnL ?? t.pnl ?? null;
              const pnlPos = pnl != null && pnl >= 0;
              return (
                <tr key={t.id || i}>
                  <td className="m" style={{ color: 'var(--t3)', fontSize: 10 }}>{fmtDate(t.closedAt || t.openedAt)}</td>
                  <td style={{ color: 'var(--t2)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {(t.template || '—').replace(/-specialist$/, '').replace(/-/g, ' ')}
                  </td>
                  <td style={{ color: t.direction === 'LONG' ? 'var(--bu)' : 'var(--be)', fontWeight: 700 }}>{t.direction || '—'}</td>
                  <td className="m">{t.entry ? Number(t.entry).toFixed(2) : '—'}</td>
                  <td className="m" style={{ color: 'var(--be)' }}>{t.sl ? Number(t.sl).toFixed(2) : '—'}</td>
                  <td className="m" style={{ color: 'var(--bu)' }}>{t.tp1 ? Number(t.tp1).toFixed(2) : '—'}</td>
                  <td className="m">{t.rr ? `${Number(t.rr).toFixed(1)}R` : '—'}</td>
                  <td className="m" style={{ color: pnl == null ? 'var(--t3)' : pnlPos ? 'var(--bu)' : 'var(--be)', fontWeight: 700 }}>
                    {pnl != null ? `${pnlPos ? '+' : ''}$${Math.abs(pnl).toFixed(2)}` : '—'}
                  </td>
                  <td>
                    {pnl != null ? (
                      <span className={`ttag ${pnl > 0.5 ? 'sc' : pnl < -0.5 ? 'no' : 'dy'}`}>
                        {pnl > 0.5 ? 'WIN' : pnl < -0.5 ? 'LOSS' : 'BE'}
                      </span>
                    ) : (
                      <span className="ttag no">OPEN</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function LogTab({ ledger, onDelete }) {
  return (
    <div className="log-layout">

      <div>
        <div className="v20-sec">
          <span className="v20-sec-title">Recent Activity</span>
          <div className="v20-sec-line" />
        </div>
        <ActivityFeed ledger={ledger} />
      </div>

      <div className="p">
        <div className="pt">Trade Journal</div>
        <JournalTable ledger={ledger} onDelete={onDelete} />
      </div>

    </div>
  );
}
