import { motion } from 'framer-motion';

// Derive today's P&L for a specialist from the ledger
function getTodayPnL(ledger, templateKey) {
  const today = new Date().toISOString().slice(0, 10);
  return (ledger || [])
    .filter(t => {
      const d = t.closedAt ? new Date(t.closedAt).toISOString().slice(0, 10) : null;
      return d === today && t.template === templateKey;
    })
    .reduce((sum, t) => sum + (t.finalPnL || t.pnl || 0), 0);
}

function getWinRate(perf, templateKey) {
  const p = perf?.[templateKey];
  if (!p) return null;
  return p.winRate ?? p.wr ?? null;
}

function getLastTrade(ledger, templateKey) {
  const trades = (ledger || []).filter(t => t.template === templateKey && t.finalPnL != null);
  if (!trades.length) return null;
  return trades.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))[0];
}

function getActivePosition(positions, templateKey) {
  return (positions || []).find(p => {
    const c = p.comment || '';
    if (templateKey === 'gold-specialist-2')  return /QB-V20-GS2/i.test(c);
    if (templateKey === 'gold-specialist')    return /QB-V20-/i.test(c) && !/QB-V20-GS2/i.test(c) && /xau|gold/i.test(p.symbol || '');
    if (templateKey === 'nas100-specialist')  return /QB-V20-/i.test(c) && /nas|us100|ustec/i.test(p.symbol || '');
    if (templateKey === 'ger40-bg-specialist')return /QB-V20-/i.test(c) && /ger|dax|de40/i.test(p.symbol || '');
    return false;
  });
}

export default function SpecialistPod({ spec, positions, ledger, perf, ftmoBlocked }) {
  const activePos  = getActivePosition(positions, spec.key);
  const isActive   = !!activePos;
  const isBlocked  = ftmoBlocked;
  const todayPnL   = getTodayPnL(ledger, spec.key);
  const wr         = getWinRate(perf, spec.key);
  const lastTrade  = getLastTrade(ledger, spec.key);

  const statusKey  = isBlocked ? 'blocked' : isActive ? 'active' : 'idle';
  const statusLabel = isBlocked ? 'BLOCKED' : isActive ? 'ACTIVE' : 'IDLE';

  const pnlColor = todayPnL > 0.5 ? 'var(--bu)' : todayPnL < -0.5 ? 'var(--be)' : 'var(--t2)';

  const lastLabel = lastTrade
    ? `${lastTrade.direction} ${lastTrade.finalPnL >= 0.5 ? '+' : ''}$${(lastTrade.finalPnL ?? 0).toFixed(0)}`
    : 'No recent trades';

  return (
    <motion.div
      className={`pod ${isActive ? 'pod-active' : ''} ${isBlocked ? 'pod-blocked' : ''}`}
      animate={{
        boxShadow: isActive
          ? `0 0 22px ${spec.color}30, 0 0 1px ${spec.color}60`
          : '0 0 0px transparent',
        borderColor: isActive ? `${spec.color}40` : 'var(--b)',
      }}
      transition={{ duration: 0.5 }}
    >
      {/* Accent strip */}
      <div className="pod-accent" style={{ background: spec.color }} />

      {/* Header */}
      <div className="pod-hdr">
        <div>
          <div className="pod-name" style={{ color: isActive ? spec.color : 'var(--t)' }}>
            {spec.label}
          </div>
          <div className="pod-tf">{spec.asset.toUpperCase()} · {spec.tf}</div>
        </div>
        <div className={`pod-badge ${statusKey}`}>
          <div className={`pod-dot${isActive ? ' live' : ''}`} />
          {statusLabel}
        </div>
      </div>

      {/* Metrics */}
      <div className="pod-metrics">
        <div className="pod-m">
          <span className="pod-ml">Today P&amp;L</span>
          <span className="pod-mv" style={{ color: pnlColor }}>
            {todayPnL === 0 ? '—' : `${todayPnL >= 0 ? '+' : ''}$${Math.abs(todayPnL).toFixed(0)}`}
          </span>
        </div>
        <div className="pod-m">
          <span className="pod-ml">Win Rate</span>
          <span className="pod-mv" style={{ color: wr != null && wr >= 55 ? 'var(--bu)' : 'var(--t)' }}>
            {wr != null ? `${wr.toFixed(1)}%` : '—'}
          </span>
        </div>
        {isActive && activePos && (
          <>
            <div className="pod-m">
              <span className="pod-ml">Float P&amp;L</span>
              <span className="pod-mv" style={{ color: (activePos.unrealizedProfit || 0) >= 0 ? 'var(--bu)' : 'var(--be)' }}>
                {activePos.unrealizedProfit != null
                  ? `${activePos.unrealizedProfit >= 0 ? '+' : ''}$${activePos.unrealizedProfit.toFixed(0)}`
                  : '—'}
              </span>
            </div>
            <div className="pod-m">
              <span className="pod-ml">Direction</span>
              <span className="pod-mv" style={{ color: activePos.type === 'POSITION_TYPE_BUY' ? 'var(--bu)' : 'var(--be)' }}>
                {activePos.type === 'POSITION_TYPE_BUY' ? 'LONG' : 'SHORT'}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="pod-footer">
        Last: <strong>{lastLabel}</strong>
      </div>
    </motion.div>
  );
}
