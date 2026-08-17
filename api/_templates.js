/* eslint-disable */
// V14 — api/_templates.js
//
// SINGLE SOURCE OF TRUTH for template identity: id → { glyph, label }, plus the
// canonical ordering, the UI groupings, and the accepted-template lists.
//
// Why this exists: the template→label map used to be copy-pasted in five files
// (telegram, watched-setups-checker, webhook, rules-store, App.jsx). Adding a
// template meant editing five places, and three of them drifted (orb/reaction
// were missing). Backend files now import from here. App.jsx keeps its own
// mirror only because it lives on the other side of the bundler boundary.
//
// Adding a template = add ONE entry here (+ the App.jsx mirror).
// ----------------------------------------------------------------------------

// ── V20 Specialist signals (active) ──────────────────────────────────────────
// Each instrument gets one specialist entry. The zoneType field in the payload
// carries the sub-signal name (FVG / Judas / SB / ORB / PSYCH / FRB).
const SPECIALIST_META_MAP = {
  'gold-specialist':   { glyph: '🥇', label: 'Gold Specialist' },
  'nas100-specialist': { glyph: '📈', label: 'NAS100 Specialist' },
};

// ── Legacy templates (history — disabled in V20 mode) ─────────────────────────
const LEGACY_TEMPLATE_META = {
  'silver-bullet':    { glyph: '🥈', label: 'Silver Bullet' },
  'unicorn':          { glyph: '🦄', label: 'Unicorn' },
  'turtle-soup':      { glyph: '🐢', label: 'Turtle Soup' },
  'judas-swing':      { glyph: '🎭', label: 'Judas Swing' },
  'ote-continuation': { glyph: '🎯', label: 'OTE Continuation' },
  'am-ifvg':          { glyph: '🌅', label: 'AM IFVG Reversal' },
  'orb':              { glyph: '🚀', label: 'ORB Breakout' },
  'orb-pro':          { glyph: '⚡', label: 'PRO ORB' },
  'reaction':         { glyph: '🎯', label: 'Reaction (coil break)' },
  'reaction-fvg':     { glyph: '🌀', label: 'Reaction (FVG)' },
  'reaction-ifvg':    { glyph: '🔄', label: 'Reaction (IFVG)' },
  'reaction-impulse': { glyph: '⚡', label: 'Reaction (impulse tap)' },
  'reaction-ext':     { glyph: '🔮', label: 'Psych Ext (outside KZ)' },
  'alexg':            { glyph: '📐', label: 'Alex G Set&Forget' },
  'gold-fvg':         { glyph: '🥇', label: 'Gold FVG' },
  'gold-sb':          { glyph: '🥇', label: 'Gold Silver Bullet' },
  'frankfurt-orb':    { glyph: '🏛️', label: 'Frankfurt ORB' },
  'ny-orb':           { glyph: '🗽', label: 'NY ORB' },
};

const TEMPLATE_META = { ...SPECIALIST_META_MAP, ...LEGACY_TEMPLATE_META };

// "🥈 Silver Bullet" for one id (falls back to the raw id if unknown).
function templateLabel(id) {
  const m = TEMPLATE_META[id];
  return m ? `${m.glyph} ${m.label}` : id;
}

// { id: "🥈 Silver Bullet", ... } — the combined-string map the backend
// notifiers consume (telegram, watched-setups-checker, webhook).
function templateLabelMap() {
  const out = {};
  for (const id of Object.keys(TEMPLATE_META)) out[id] = templateLabel(id);
  return out;
}

// V20 specialist signals — the only accepted signals when V20_SPECIALIST_MODE is on
const SPECIALIST_SIGNALS = Object.keys(SPECIALIST_META_MAP);

// Legacy template ids — disabled in V20 mode, kept for historical query/display
const LEGACY_TEMPLATES = Object.keys(LEGACY_TEMPLATE_META);

// Display order (heatmaps, cards) — specialists first, legacy after
const TEMPLATE_ORDER = [
  'gold-specialist', 'nas100-specialist',
  'silver-bullet', 'unicorn', 'turtle-soup', 'judas-swing', 'ote-continuation', 'am-ifvg',
  'orb', 'orb-pro', 'reaction', 'reaction-fvg', 'reaction-ifvg', 'reaction-impulse', 'reaction-ext', 'alexg',
  'gold-fvg', 'gold-sb', 'frankfurt-orb', 'ny-orb',
];

// UI groupings (legacy, kept for history views)
const ICT_TEMPLATES      = ['silver-bullet', 'unicorn', 'turtle-soup', 'judas-swing', 'ote-continuation', 'am-ifvg', 'gold-sb'];
const REACTION_TEMPLATES = ['reaction', 'reaction-fvg', 'reaction-ifvg', 'reaction-impulse', 'reaction-ext', 'gold-fvg'];

// Accepted — V20: specialists only. Pre-V20 retained for reference.
const ACCEPTED_ACTIVE = [
  'gold-specialist', 'nas100-specialist',
  'silver-bullet', 'unicorn', 'turtle-soup', 'judas-swing', 'ote-continuation', 'am-ifvg',
  'orb', 'orb-pro', 'reaction', 'reaction-fvg', 'reaction-ifvg', 'reaction-impulse', 'reaction-ext', 'alexg',
  'gold-fvg', 'gold-sb', 'frankfurt-orb', 'ny-orb',
];
const ACCEPTED_DEFENSIVE = [
  'gold-specialist', 'nas100-specialist',
  'silver-bullet', 'unicorn', 'ote-continuation', 'am-ifvg',
  'orb', 'orb-pro', 'reaction', 'reaction-fvg', 'reaction-ifvg', 'reaction-impulse', 'reaction-ext', 'alexg',
  'gold-fvg', 'gold-sb',
];

module.exports = {
  TEMPLATE_META,
  SPECIALIST_META_MAP,
  LEGACY_TEMPLATE_META,
  templateLabel,
  templateLabelMap,
  TEMPLATE_ORDER,
  ICT_TEMPLATES,
  REACTION_TEMPLATES,
  SPECIALIST_SIGNALS,
  LEGACY_TEMPLATES,
  ACCEPTED_ACTIVE,
  ACCEPTED_DEFENSIVE,
};