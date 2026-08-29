import SpecialistPod from '../SpecialistPod';

export const SPECIALISTS = [
  { key: 'gold-specialist',      label: 'Gold S1',  asset: 'gold',   tf: '15m',  color: '#D4A017' },
  { key: 'gold-specialist-2',    label: 'Gold S2',  asset: 'gold',   tf: 'H1',   color: '#F0C040' },
  { key: 'nas100-specialist',    label: 'NAS100',   asset: 'nas100', tf: '15m',  color: '#0EA5E9' },
  { key: 'ger40-bg-specialist',  label: 'GER40',    asset: 'ger40',  tf: '15m',  color: '#8B5CF6' },
];

export default function SpecialistsTab({ positions, ledger, perf, ftmoStatus }) {
  const ftmoBlocked = ftmoStatus && !ftmoStatus.canTrade;

  return (
    <div>
      <div className="pods-grid">
        {SPECIALISTS.map(spec => (
          <SpecialistPod
            key={spec.key}
            spec={spec}
            positions={positions}
            ledger={ledger}
            perf={perf}
            ftmoBlocked={ftmoBlocked}
          />
        ))}
      </div>
    </div>
  );
}
