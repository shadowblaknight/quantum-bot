import { useState } from 'react';

const API = (process.env.REACT_APP_API_URL || '').replace(/\/$/, '');

function FTMOSection({ ftmoStatus }) {
  const [bal, setBal]     = useState('100000');
  const [msg, setMsg]     = useState('');
  const [busy, setBusy]   = useState(false);

  const setInitial = async () => {
    const n = parseFloat(bal);
    if (!n || n <= 0) { setMsg('Enter a valid balance'); return; }
    setBusy(true);
    try {
      const res  = await fetch(`${API}/api/ftmo-guard?action=set-initial&balance=${n}`);
      const data = await res.json();
      setMsg(data.ok ? `Initial balance set to $${n.toLocaleString()}` : 'Error — check console');
    } catch (e) {
      setMsg('Network error');
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const resetDay = async () => {
    setBusy(true);
    try {
      const res  = await fetch(`${API}/api/ftmo-guard?action=reset-day`);
      const data = await res.json();
      setMsg(data.ok ? 'Day-start balance cleared' : 'Error');
    } catch {
      setMsg('Network error');
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const daily  = ftmoStatus?.dailyLossPct;
  const total  = ftmoStatus?.totalDDPct;
  const equity = ftmoStatus?.debug?.equity;

  return (
    <div className="ctrl-card">
      <span className="ctrl-title">FTMO Guard</span>

      {/* Status summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        {[
          ['Daily DD',  daily  != null ? `${daily.toFixed(2)}%`  : '—', daily  >= 3 ? (daily  >= 4   ? 'var(--be)' : 'var(--wa)') : 'var(--bu)'],
          ['Total DD',  total  != null ? `${total.toFixed(2)}%`  : '—', total  >= 7 ? (total  >= 8.5 ? 'var(--be)' : 'var(--wa)') : 'var(--bu)'],
          ['Equity',    equity != null ? `$${Math.round(equity).toLocaleString()}` : '—', 'var(--t)'],
        ].map(([lbl, val, color]) => (
          <div key={lbl} style={{ background: 'var(--s2)', border: '1px solid var(--b)', padding: '8px 10px' }}>
            <div style={{ font: '600 7px/1 system-ui', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 4 }}>{lbl}</div>
            <div style={{ fontFamily: 'var(--mo)', fontSize: 14, fontWeight: 800, color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Set initial balance */}
      <div>
        <div style={{ font: '600 8px/1 system-ui', color: 'var(--t3)', marginBottom: 6 }}>Set challenge starting balance (call once when account is funded)</div>
        <div className="ctrl-row">
          <input
            className="ctrl-inp"
            type="number"
            value={bal}
            onChange={e => setBal(e.target.value)}
            placeholder="100000"
          />
          <button className="ctrl-btn" onClick={setInitial} disabled={busy}>Set Initial</button>
        </div>
      </div>

      <div className="ctrl-row" style={{ justifyContent: 'space-between' }}>
        <span className="ctrl-hint">Reset day-start if balance was manually adjusted by FTMO</span>
        <button className="ctrl-btn danger" onClick={resetDay} disabled={busy}>Reset Day</button>
      </div>

      {msg && <div style={{ font: '600 9px/1.4 system-ui', color: 'var(--bu)', padding: '4px 0' }}>{msg}</div>}
    </div>
  );
}

function GatingSection({ gatingRules, onUpdate }) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const toggle = async (template, instrument) => {
    const key     = `${template}::${instrument}`;
    const current = gatingRules?.[key] !== false;
    const next    = !current;
    setBusy(true);
    try {
      await fetch(`${API}/api/gating-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, instrument, enabled: next }),
      });
      onUpdate({ ...gatingRules, [key]: next });
      setToast(`${template} / ${instrument} ${next ? 'ON' : 'OFF'}`);
    } catch {
      setToast('Error saving');
    } finally {
      setBusy(false);
      setTimeout(() => setToast(''), 2500);
    }
  };

  const specialists = [
    { key: 'gold-specialist',     label: 'Gold S1',  instruments: ['gold'] },
    { key: 'gold-specialist-2',   label: 'Gold S2',  instruments: ['gold'] },
    { key: 'nas100-specialist',   label: 'NAS100',   instruments: ['nas100'] },
    { key: 'ger40-bg-specialist', label: 'GER40',    instruments: ['ger40'] },
  ];

  return (
    <div className="ctrl-card">
      <span className="ctrl-title">Specialist Gating</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {specialists.map(spec => (
          <div key={spec.key} className="gate-row">
            <div style={{ flex: 1 }}>
              <div className="gate-tpl">{spec.label}</div>
              <div className="gate-tpl-sub">{spec.key}</div>
            </div>
            <div className="gate-insts">
              {spec.instruments.map(inst => {
                const key     = `${spec.key}::${inst}`;
                const enabled = gatingRules?.[key] !== false;
                return (
                  <button
                    key={inst}
                    className={`gtog ${enabled ? 'on' : 'off'}`}
                    disabled={busy}
                    onClick={() => toggle(spec.key, inst)}
                  >
                    {inst.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {toast && (
        <div className={`gate-toast ok`}>{toast}</div>
      )}
    </div>
  );
}

export default function ControlsTab({ gatingRules, onGatingUpdate, ftmoStatus }) {
  return (
    <div className="ctrl-layout">
      <FTMOSection ftmoStatus={ftmoStatus} />
      <GatingSection gatingRules={gatingRules} onUpdate={onGatingUpdate} />
    </div>
  );
}
