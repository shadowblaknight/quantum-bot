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

const TEMPLATE_META = {
  'silver-bullet':    { glyph: '🥈', label: 'Silver Bullet' },
  'unicorn':          { glyph: '🦄', label: 'Unicorn' },
  'turtle-soup':      { glyph: '🐢', label: 'Turtle Soup' },
  'judas-swing':      { glyph: '🎭', label: 'Judas Swing' },
  'ote-continuation': { glyph: '🎯', label: 'OTE Continuation' },
  'am-ifvg':          { glyph: '🌅', label: 'AM IFVG Reversal' },
  'orb':              { glyph: '🚀', label: 'ORB Breakout' },
  'reaction':         { glyph: '🎯', label: 'Reaction (coil break)' },
  'reaction-fvg':     { glyph: '🌀', label: 'Reaction (FVG)' },
  'reaction-ifvg':    { glyph: '🔄', label: 'Reaction (IFVG)' },
};

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

// Display order (heatmaps, cards).
const TEMPLATE_ORDER = [
  'silver-bullet', 'unicorn', 'turtle-soup', 'judas-swing', 'ote-continuation', 'am-ifvg',
  'orb', 'reaction', 'reaction-fvg', 'reaction-ifvg',
];

// UI groupings — separately MEASURED, grouped only for a tidy screen.
const ICT_TEMPLATES      = ['silver-bullet', 'unicorn', 'turtle-soup', 'judas-swing', 'ote-continuation', 'am-ifvg'];
const REACTION_TEMPLATES = ['reaction', 'reaction-fvg', 'reaction-ifvg'];

// Accepted templates by active mode. Active = everything; defensive = the
// higher-conviction subset (drops the two most aggressive ICT setups).
const ACCEPTED_ACTIVE = [
  'silver-bullet', 'unicorn', 'turtle-soup', 'judas-swing', 'ote-continuation', 'am-ifvg',
  'orb', 'reaction', 'reaction-fvg', 'reaction-ifvg',
];
const ACCEPTED_DEFENSIVE = [
  'silver-bullet', 'unicorn', 'ote-continuation', 'am-ifvg',
  'orb', 'reaction', 'reaction-fvg', 'reaction-ifvg',
];

module.exports = {
  TEMPLATE_META,
  templateLabel,
  templateLabelMap,
  TEMPLATE_ORDER,
  ICT_TEMPLATES,
  REACTION_TEMPLATES,
  ACCEPTED_ACTIVE,
  ACCEPTED_DEFENSIVE,
};