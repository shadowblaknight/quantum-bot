import { motion } from 'framer-motion';

const ASSET_LABELS = {
  gold:   'XAUUSD',
  nas100: 'NAS100',
  ger40:  'GER40',
};

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(dec);
}

function fmtPnL(n) {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function DirectiveBanner({ jarvis }) {
  if (!jarvis) return null;
  const state = jarvis.state || 'hold';
  return (
    <div className={`live-dir ${state}`}>
      <span className="live-dir-state">{state.replace('standdown','STAND DOWN').toUpperCase()}</span>
      <span className="live-dir-text" dangerouslySetInnerHTML={{ __html: (jarvis.text || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
    </div>
  );
}

function PriceCard({ sym, price, change, changeDir }) {
  return (
    <div className="px-card">
      <div className="px-sym">{sym}</div>
      <div className="px-val">{price ?? '—'}</div>
      {change != null && (
        <div className="px-chg" style={{ color: changeDir === 'up' ? 'var(--bu)' : changeDir === 'down' ? 'var(--be)' : 'var(--t3)' }}>
          {changeDir === 'up' ? '+' : ''}{fmt(change, 2)}
        </div>
      )}
    </div>
  );
}

function PositionCard({ position, onAction }) {
  if (!position) return null;

  const isLong = position.type === 'POSITION_TYPE_BUY';
  const dir    = isLong ? 'LONG' : 'SHORT';
  const pnl    = position.unrealizedProfit ?? 0;
  const pnlPos = pnl >= 0;

  return (
    <div className="p" style={{ borderTop: `2px solid ${isLong ? 'var(--bu)' : 'var(--be)'}` }}>
      <div className="pt">
        <span>{position.symbol}</span>
        <span className={`ptb ${isLong ? 'bu' : 'be'}`}>{dir}</span>
        <span className="ptb g" style={{ marginLeft: 4 }}>{position.comment?.replace('QB-V20-','') || 'V20'}</span>
      </div>

      {/* Float P&L hero */}
      <div style={{ textAlign: 'center', padding: '12px 0 8px' }}>
        <motion.div
          className="pnl-big"
          style={{ color: pnlPos ? 'var(--bu)' : 'var(--be)', textShadow: `0 0 24px ${pnlPos ? 'rgba(34,197,94,.4)' : 'rgba(239,68,68,.4)'}` }}
          animate={{ scale: [1, 1.015, 1] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          {fmtPnL(pnl)}
        </motion.div>
        <div className="pnl-sub" style={{ color: pnlPos ? 'var(--bu)' : 'var(--be)' }}>floating P&L</div>
      </div>

      {/* Position details */}
      <div className="pos-info" style={{ marginBottom: 8 }}>
        {[
          ['Entry',    fmt(position.openPrice, 4)],
          ['SL',       position.stopLoss   ? fmt(position.stopLoss, 4)   : '—'],
          ['TP',       position.takeProfit  ? fmt(position.takeProfit, 4) : '—'],
          ['Lot',      fmt(position.volume, 2)],
          ['Swap',     position.swap != null ? fmtPnL(position.swap) : '—'],
          ['Comm',     position.commission != null ? fmtPnL(position.commission) : '—'],
        ].map(([lbl, val]) => (
          <div className="pi" key={lbl}>
            <span className="pil">{lbl}</span>
            <span className="piv m">{val}</span>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      {onAction && (
        <div className="pos-btns">
          <button className="pb wa" onClick={() => onAction('be', position.id)}>Move to BE</button>
          <button className="pb in" onClick={() => onAction('partial', position.id)}>50% Close</button>
          <button className="pb be" onClick={() => onAction('close', position.id)}>Close All</button>
        </div>
      )}
    </div>
  );
}

export default function LiveTab({ positions, quotes, jarvis, onPositionAction }) {
  const openPositions = (positions || []).filter(p => /QB-V20-/i.test(p.comment || ''));

  return (
    <div className="live-layout">

      {/* JARVIS directive */}
      <DirectiveBanner jarvis={jarvis} />

      {/* Live asset prices */}
      <div className="prices-row">
        {Object.entries(quotes || {}).map(([asset, q]) => (
          <PriceCard
            key={asset}
            sym={ASSET_LABELS[asset] || asset.toUpperCase()}
            price={q.price != null ? fmt(q.price, asset === 'nas100' || asset === 'ger40' ? 1 : 2) : null}
            change={q.change}
            changeDir={q.change > 0 ? 'up' : q.change < 0 ? 'down' : null}
          />
        ))}
      </div>

      {/* Open positions or idle state */}
      {openPositions.length === 0 ? (
        <div className="no-pos">
          <span className="no-pos-lbl">No open position</span>
          <span className="no-pos-sub">Specialists are monitoring the market. A signal will appear here when conditions align.</span>
        </div>
      ) : (
        openPositions.map(pos => (
          <PositionCard
            key={pos.id}
            position={pos}
            onAction={onPositionAction}
          />
        ))
      )}
    </div>
  );
}
