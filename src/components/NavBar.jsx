const TABS = [
  { key: 'live',        label: 'Live',    icon: '◉' },
  { key: 'specialists', label: 'Bots',    icon: '◈' },
  { key: 'stats',       label: 'Stats',   icon: '▲' },
  { key: 'log',         label: 'Log',     icon: '≡' },
  { key: 'controls',    label: 'Config',  icon: '⚙' },
];

export default function NavBar({ active, onChange }) {
  return (
    <>
      {/* Desktop sidebar */}
      <nav className="nav-side">
        {TABS.map((tab, i) => (
          <button
            key={tab.key}
            className={`nav-item${active === tab.key ? ' active' : ''}`}
            onClick={() => onChange(tab.key)}
          >
            <span className="nav-icon">{tab.icon}</span>
            <span className="nav-lbl">{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Mobile bottom nav */}
      <div className="nav-bot">
        <div className="nav-bot-inner">
          {TABS.map(tab => (
            <button
              key={tab.key}
              className={`nav-bot-item${active === tab.key ? ' active' : ''}`}
              onClick={() => onChange(tab.key)}
            >
              <span className="nav-bot-icon">{tab.icon}</span>
              <span className="nav-bot-lbl">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
