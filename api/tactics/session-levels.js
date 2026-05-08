/* eslint-disable */
// V12 — api/tactics/session-levels.js
//
// Session level detector. Tracks key reference levels:
//   - Asian session high/low (00:00-07:00 UTC)
//   - London session high/low (07:00-13:00 UTC)
//   - NY session high/low (13:00-21:00 UTC)
//   - Prior day high/low (PDH/PDL)
//   - Weekly open
//
// These are pure REFERENCE LEVELS — they don't have inherent direction. They're
// used by other detectors (liquidity sweep) and by coherence checker for TP
// targets. Direction emitted is NEUTRAL by default.
//
// We emit one opinion per relevant level, marked NEUTRAL but with the level
// information so coherence checker can incorporate it.
// ----------------------------------------------------------------------------

const { makeOpinion } = require('./_opinion');
const { sessionForHour } = require('../_lib');

function detect(candles, context = {}) {
  const tf = context.timeframe;
  if (!tf || !Array.isArray(candles) || candles.length < 24) return [];

  // We only run session-levels detection on H1 timeframe
  // (it's about session-scale levels — would be noise on M1/M5)
  if (tf !== '1h' && tf !== '4h') return [];

  const now = Date.now();
  const opinions = [];

  // === TODAY'S SESSION HIGHS/LOWS ===
  const today = new Date();
  const ranges = sessionRangesForDate(today);
  const currentSession = sessionForHour(today.getUTCHours());

  // Asian session levels (relevant if currently in London/NY)
  if (currentSession === 'LONDON' || currentSession === 'NEW_YORK' || currentSession === 'OVERLAP') {
    const asianLevels = computeSessionLevels(candles, ranges.asian[0], ranges.asian[1], 'ASIAN', tf, now);
    opinions.push(...asianLevels);
  }

  // London session levels (relevant if currently in NY)
  if (currentSession === 'NEW_YORK' || currentSession === 'OVERLAP') {
    const londonLevels = computeSessionLevels(candles, ranges.london[0], ranges.london[1], 'LONDON', tf, now);
    opinions.push(...londonLevels);
  }

  // === PRIOR DAY HIGH/LOW ===
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const yRanges = sessionRangesForDate(yesterday);
  // PDH/PDL = highest high and lowest low across all of yesterday's candles
  const yesterdayCandles = candles.filter((c) => {
    const t = new Date(c.time).getTime();
    return t >= yRanges.asian[0] && t < yRanges.asian[0] + 24 * 60 * 60 * 1000;
  });
  if (yesterdayCandles.length >= 6) {
    const pdh = Math.max(...yesterdayCandles.map((c) => c.high));
    const pdl = Math.min(...yesterdayCandles.map((c) => c.low));
    const formedAt = yesterdayCandles[yesterdayCandles.length - 1].time;
    const formedAtMs = new Date(formedAt).getTime();

    const pdhOp = makeOpinion({
      tactic: 'sessionLevel',
      timeframe: tf,
      direction: 'NEUTRAL',
      level: pdh,
      formedAt: formedAtMs,
      strength: 0.7,
      evidence: { type: 'PDH', barsInDay: yesterdayCandles.length },
      description: `Prior day high @ ${pdh.toFixed(pdh > 100 ? 2 : 5)}`,
    });
    const pdlOp = makeOpinion({
      tactic: 'sessionLevel',
      timeframe: tf,
      direction: 'NEUTRAL',
      level: pdl,
      formedAt: formedAtMs,
      strength: 0.7,
      evidence: { type: 'PDL', barsInDay: yesterdayCandles.length },
      description: `Prior day low @ ${pdl.toFixed(pdl > 100 ? 2 : 5)}`,
    });
    if (pdhOp) opinions.push(pdhOp);
    if (pdlOp) opinions.push(pdlOp);
  }

  // === WEEKLY OPEN ===
  const dayOfWeek = today.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const mondayMidnight = Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysSinceMonday, 0, 0
  );
  const weekOpenBar = candles.find((c) => new Date(c.time).getTime() >= mondayMidnight);
  if (weekOpenBar) {
    const wOp = makeOpinion({
      tactic: 'sessionLevel',
      timeframe: tf,
      direction: 'NEUTRAL',
      level: weekOpenBar.open,
      formedAt: mondayMidnight,
      strength: 0.6,
      evidence: { type: 'weeklyOpen' },
      description: `Weekly open @ ${weekOpenBar.open.toFixed(weekOpenBar.open > 100 ? 2 : 5)}`,
    });
    if (wOp) opinions.push(wOp);
  }

  return opinions;
}

function sessionRangesForDate(date) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate();
  return {
    asian:  [Date.UTC(y, m, d, 0, 0),  Date.UTC(y, m, d, 7, 0)],
    london: [Date.UTC(y, m, d, 7, 0),  Date.UTC(y, m, d, 13, 0)],
    ny:     [Date.UTC(y, m, d, 13, 0), Date.UTC(y, m, d, 21, 0)],
  };
}

function computeSessionLevels(candles, startMs, endMs, sessionName, tf, now) {
  const inRange = candles.filter((c) => {
    const t = new Date(c.time).getTime();
    return t >= startMs && t < endMs;
  });
  if (inRange.length < 3) return [];

  const high = Math.max(...inRange.map((c) => c.high));
  const low = Math.min(...inRange.map((c) => c.low));
  const formedAt = endMs; // session end = when level becomes "fixed"

  const highOp = makeOpinion({
    tactic: 'sessionLevel',
    timeframe: tf,
    direction: 'NEUTRAL',
    level: high,
    formedAt,
    strength: sessionStrength(sessionName, 'high'),
    evidence: { type: `${sessionName}_HIGH`, sessionBars: inRange.length },
    description: `${sessionName} high @ ${high.toFixed(high > 100 ? 2 : 5)}`,
  });
  const lowOp = makeOpinion({
    tactic: 'sessionLevel',
    timeframe: tf,
    direction: 'NEUTRAL',
    level: low,
    formedAt,
    strength: sessionStrength(sessionName, 'low'),
    evidence: { type: `${sessionName}_LOW`, sessionBars: inRange.length },
    description: `${sessionName} low @ ${low.toFixed(low > 100 ? 2 : 5)}`,
  });

  return [highOp, lowOp].filter((x) => x);
}

function sessionStrength(name, type) {
  // London/NY levels are "stronger" magnets than Asian
  if (name === 'LONDON' || name === 'NEW_YORK') return 0.75;
  return 0.6; // Asian
}

module.exports = { detect };