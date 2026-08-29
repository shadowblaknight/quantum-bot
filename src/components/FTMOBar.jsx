import { motion } from 'framer-motion';

export default function FTMOBar({ status }) {
  const daily   = status?.dailyLossPct ?? 0;
  const total   = status?.totalDDPct   ?? 0;
  const blocked = status && !status.canTrade;
  const loading = !status;

  const barClass = blocked ? 'blocked' : daily >= 3 || total >= 7 ? 'warn' : 'ok';

  const dailyColor  = daily  >= 4   ? 'var(--be)' : daily  >= 3   ? 'var(--wa)' : 'var(--bu)';
  const totalColor  = total  >= 8.5 ? 'var(--be)' : total  >= 7   ? 'var(--wa)' : 'var(--bu)';
  const pillLabel   = blocked ? 'BLOCKED' : daily >= 3 || total >= 7 ? 'WARNING' : 'TRADING OK';

  const equity  = status?.debug?.equity   ?? null;
  const balance = status?.debug?.balance  ?? null;
  const display = equity ?? balance;

  return (
    <div className={`ftmo-bar ${barClass}`}>
      <span className="ftmo-brand">FTMO</span>

      {/* Daily DD gauge */}
      <div className="ftmo-gauge">
        <span className="ftmo-gauge-lbl">Daily DD</span>
        <div className="ftmo-gauge-row">
          <div className="ftmo-bar-track">
            <motion.div
              className="ftmo-bar-fill"
              animate={{ width: `${Math.min(100, (daily / 5) * 100)}%`, background: dailyColor }}
              transition={{ duration: 0.6 }}
            />
          </div>
          <span className="ftmo-gauge-val" style={{ color: dailyColor }}>
            {loading ? '—' : `${daily.toFixed(2)}%`}
          </span>
        </div>
      </div>

      {/* Total DD gauge */}
      <div className="ftmo-gauge" style={{ marginLeft: 8 }}>
        <span className="ftmo-gauge-lbl">Total DD</span>
        <div className="ftmo-gauge-row">
          <div className="ftmo-bar-track">
            <motion.div
              className="ftmo-bar-fill"
              animate={{ width: `${Math.min(100, (total / 10) * 100)}%`, background: totalColor }}
              transition={{ duration: 0.6 }}
            />
          </div>
          <span className="ftmo-gauge-val" style={{ color: totalColor }}>
            {loading ? '—' : `${total.toFixed(2)}%`}
          </span>
        </div>
      </div>

      {/* Equity */}
      {display != null && (
        <div className="ftmo-equity">
          <span className="ftmo-eq-lbl">Equity</span>
          <span className="ftmo-eq-val">
            ${Math.round(display).toLocaleString()}
          </span>
        </div>
      )}

      {/* Status pill */}
      <span className={`ftmo-pill ${barClass}`}>{pillLabel}</span>
    </div>
  );
}
