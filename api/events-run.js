/* eslint-disable */
// V12.3 — api/events-run.js
//
// Runs all event detectors across all configured timeframes for an asset.
// Returns a unified, time-sorted event list that templates consume.
//
// V12.3 detector mapping by timeframe:
//   M5   → sweep, displacement, mss, fvg, ob, breaker, ote-zone, trend
//   M15  → sweep, displacement, mss, bos, fvg, ob, breaker, ote-zone, trend, asian-range
//   H1   → sweep, displacement, mss, bos, fvg, ob, ote-zone, trend, session-levels
//   H4   → mss, bos, fvg, ob, trend
//   D    → trend
//
// Each detector is called independently with its own candle data. Failures
// are isolated — one bad detector doesn't kill the others.

const { fetchCandles } = require('./broker');
const { atr } = require('./_lib');
const { sortByTs } = require('./events/_event');

const sweepDetector = require('./events/sweep');
const displacementDetector = require('./events/displacement');
const mssDetector = require('./events/mss');
const bosDetector = require('./events/bos');
const fvgDetector = require('./events/fvg');
const obDetector = require('./events/ob');
const breakerDetector = require('./events/breaker');
const trendDetector = require('./events/trend');
const oteZoneDetector = require('./events/ote-zone');
const asianRangeDetector = require('./events/asian-range');
const sessionLevelsDetector = require('./events/session-levels');

// Detector × timeframe matrix
// V12.4: ICT day-trading stack is H1 → M15 → M5 (research-backed via TFlab/ChartSnipe).
// 1d/H4 dropped from setup logic — too many TFs creates "hard gates from
// non-alignment" (road2fundedtrading). 1d still fetched separately by the
// structural builder for display context only (not for matching).
const DETECTOR_MATRIX = {
  '5m':  ['sweep', 'displacement', 'mss', 'fvg', 'ob', 'breaker', 'ote', 'trend'],
  '15m': ['sweep', 'displacement', 'mss', 'bos', 'fvg', 'ob', 'breaker', 'ote', 'trend', 'asian-range'],
  '1h':  ['sweep', 'displacement', 'mss', 'bos', 'fvg', 'ob', 'ote', 'trend', 'session-levels'],
};

// Number of candles to fetch per timeframe
const CANDLES_NEEDED = {
  '5m': 200,
  '15m': 200,
  '1h': 200,
};

const DETECTOR_FNS = {
  'sweep':           sweepDetector.detect,
  'displacement':    displacementDetector.detect,
  'mss':             mssDetector.detect,
  'bos':             bosDetector.detect,
  'fvg':             fvgDetector.detect,
  'ob':              obDetector.detect,
  'breaker':         breakerDetector.detect,
  'trend':           trendDetector.detect,
  'ote':             oteZoneDetector.detect,
  'asian-range':     asianRangeDetector.detect,
  'session-levels':  sessionLevelsDetector.detect,
};

async function runForAsset({ asset }) {
  if (!asset) return { asset: null, events: [], error: 'no asset' };

  const timeframes = Object.keys(DETECTOR_MATRIX);
  const errors = [];

  // Fetch candles for each TF in parallel
  const candlesByTF = {};
  await Promise.all(timeframes.map(async (tf) => {
    try {
      const result = await fetchCandles(asset, tf, CANDLES_NEEDED[tf]);
      candlesByTF[tf] = result.candles || [];
    } catch (e) {
      candlesByTF[tf] = [];
      errors.push({ tf, fetch: String(e.message || e) });
    }
  }));

  // TIMESTAMP SAFETY NET:
  // Some data sources (TwelveData with ambiguous datetime strings, etc.) return
  // candles whose timestamps are off by hours. Templates rely on `event.ts` being
  // close to wall-clock time for filters like "sweep in last 8 hours."
  //
  // We re-anchor each TF's candle timestamps so the MOST RECENT candle aligns
  // to wall-clock now, and preceding bars step backward by tfMs. This preserves
  // the bot's internal timeline regardless of source quirks.
  const TF_MS = { '5m': 300000, '15m': 900000, '1h': 3600000 };
  const wallNow = Date.now();
  for (const tf of timeframes) {
    const candles = candlesByTF[tf];
    if (!candles || candles.length === 0) continue;
    const tfMs = TF_MS[tf];
    if (!tfMs) continue;

    // Check the most recent candle's timestamp delta from wall-clock.
    // If it's more than 2 bars off in either direction, re-anchor the whole series.
    const last = candles[candles.length - 1];
    const lastTs = new Date(last.time).getTime();
    const skewMs = Math.abs(wallNow - lastTs);
    if (skewMs > 2 * tfMs) {
      // Re-anchor: walk backward from now, one bar per slot
      const reAnchored = candles.map((c, i) => {
        const slotsFromEnd = (candles.length - 1) - i;
        const anchoredMs = wallNow - slotsFromEnd * tfMs;
        return { ...c, time: new Date(anchoredMs).toISOString() };
      });
      candlesByTF[tf] = reAnchored;
    }
  }

  const allEvents = [];

  // Run detectors for each TF
  for (const tf of timeframes) {
    const candles = candlesByTF[tf];
    if (!candles || candles.length < 30) continue;

    const tfATR = atr(candles, 14);
    if (!tfATR) continue;

    const detectorIds = DETECTOR_MATRIX[tf];
    for (const dId of detectorIds) {
      const fn = DETECTOR_FNS[dId];
      if (!fn) continue;
      try {
        const events = fn({ candles, atr: tfATR, timeframe: tf });
        for (const e of events) allEvents.push(e);
      } catch (e) {
        errors.push({ tf, detector: dId, error: String(e.message || e) });
      }
    }
  }

  return {
    asset,
    events: sortByTs(allEvents),
    candlesByTF,
    atrByTF: Object.fromEntries(
      timeframes.map((tf) => [tf, candlesByTF[tf]?.length >= 14 ? atr(candlesByTF[tf], 14) : null])
    ),
    errors,
  };
}

module.exports = {
  runForAsset,
  DETECTOR_MATRIX,
};