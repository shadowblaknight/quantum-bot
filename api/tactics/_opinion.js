/* eslint-disable */
// V12 — api/tactics/_opinion.js
//
// The universal shape that every tactic detector emits. Coherence checker
// (session 4) reads these opinions and decides whether they tell a story.
//
// IMPORTANT: an opinion is just an observation. It does NOT decide trades.
// Multiple opinions across timeframes get combined by the coherence checker.
// ----------------------------------------------------------------------------

// Build a properly-shaped opinion. All detectors should use this constructor.
// Returns null if required fields are missing — caller filters out nulls.
function makeOpinion({
  tactic,         // required: 'orderBlock', 'fvg', 'bos', 'trendStructure', 'liquiditySweep', 'sessionLevel', 'unfilledImbalance', 'fakeout'
  timeframe,      // required: '5m', '15m', '1h', '4h', '1d'
  direction,      // required: 'LONG', 'SHORT', 'NEUTRAL'
  level,          // required: primary price level
  formedAt,       // required: timestamp when pattern appeared
  zone = null,    // optional: { upper, lower } for area-based tactics
  entry = null,
  invalidation = null,
  targets = null,
  strength = 0.5,
  freshness = null,
  evidence = {},
  description = '',
}) {
  if (!tactic || !timeframe || !direction || level == null || !formedAt) {
    return null;
  }
  if (!isFinite(level) || level <= 0) return null;
  
  // Auto-compute freshness if not provided (decays from 1 → 0 over 48 hours)
  let f = freshness;
  if (f == null) {
    const ageHours = (Date.now() - formedAt) / 3600000;
    f = ageHours <= 0 ? 1.0
      : ageHours >= 48 ? 0.0
      : 1.0 - (ageHours / 48);
  }

  return {
    tactic,
    timeframe,
    direction,
    level,
    zone,
    entry,
    invalidation,
    targets,
    strength: clamp(strength, 0, 1),
    freshness: clamp(f, 0, 1),
    formedAt,
    evidence,
    description: description || autoDescription(tactic, timeframe, direction, level, formedAt),
  };
}

function clamp(n, min, max) {
  if (typeof n !== 'number' || !isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function autoDescription(tactic, tf, dir, level, formedAt) {
  const ageHours = (Date.now() - formedAt) / 3600000;
  const age = ageHours < 1 ? `${Math.round(ageHours * 60)}m`
            : ageHours < 24 ? `${ageHours.toFixed(1)}h`
            : `${(ageHours / 24).toFixed(1)}d`;
  const dirLabel = dir === 'NEUTRAL' ? '' : ` ${dir.toLowerCase()}`;
  return `${tf} ${tactic}${dirLabel} @ ${level.toFixed(level > 100 ? 2 : 5)} (${age} ago)`;
}

// Filter out null/invalid opinions (detectors return raw arrays that may include nulls)
function clean(opinions) {
  return (opinions || []).filter((o) => o && typeof o === 'object' && o.tactic && o.level != null);
}

module.exports = { makeOpinion, clean, clamp };