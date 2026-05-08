/* eslint-disable */
// V12 — api/tactics-run.js
//
// Orchestrator: runs all enabled detectors across multiple timeframes for a
// given asset. Returns the combined list of opinions.
//
// USED BY:
//   - Coherence checker (session 4) — to gather all opinions before deciding
//   - Cockpit side bar — to show "active tactics on XAUUSD"
//   - Manual debugging — visit /api/tactics-run?asset=gold to see what's firing
//
// PARAMS:
//   ?asset=gold        — asset id (REQUIRED unless symbol given)
//   ?symbol=XAUUSD.s   — broker symbol (alternative)
//   ?tactics=all       — comma list, or 'all'. e.g. 'orderBlock,fvg,bos'
//   ?timeframes=1h,4h  — comma list. default: 5m,15m,1h,4h,1d
//
// RESPONSE:
//   { asset, symbol, opinions: [...], errors: [...], meta }
// ----------------------------------------------------------------------------

const { fetchCandles, fetchPrice } = require('./broker');
const { applyCors } = require('./_lib');
const { clean } = require('./tactics/_opinion');

const orderBlock      = require('./tactics/order-block');
const fvg             = require('./tactics/fvg');
const bos             = require('./tactics/bos');
const trendStructure  = require('./tactics/trend-structure');
const liquiditySweep  = require('./tactics/liquidity-sweep');
const sessionLevels   = require('./tactics/session-levels');
const unfilledImbalance = require('./tactics/unfilled-imbalance');
const fakeoutSignature  = require('./tactics/fakeout-signature');
const roundNumbers      = require('./tactics/round-numbers');

// Tactic registry: ID → { detector, defaultTimeframes }
const TACTICS = {
  orderBlock:        { run: orderBlock.detect,        defaultTFs: ['15m', '1h', '4h'] },
  fvg:               { run: fvg.detect,               defaultTFs: ['5m', '15m', '1h', '4h'] },
  bos:               { run: bos.detect,               defaultTFs: ['15m', '1h', '4h'] },
  trendStructure:    { run: trendStructure.detect,    defaultTFs: ['1h', '4h', '1d'] },
  liquiditySweep:    { run: liquiditySweep.detect,    defaultTFs: ['5m', '15m', '1h'] },
  sessionLevels:     { run: sessionLevels.detect,     defaultTFs: ['1h'] },
  unfilledImbalance: { run: unfilledImbalance.detect, defaultTFs: ['1h', '4h', '1d'] },
  fakeout:           { run: fakeoutSignature.detect,  defaultTFs: ['15m', '1h', '4h'] },
  roundNumber:       { run: roundNumbers.detect,      defaultTFs: ['4h', '1d'] },
};

const ALL_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

// Run all enabled detectors for one asset. Returns flat array of opinions.
async function runForAsset({ asset, symbol, enabledTactics, timeframes }) {
  const candleCache = {};

  // Fetch candles for each requested timeframe (parallel)
  const tfs = timeframes || ['5m', '15m', '1h', '4h', '1d'];
  const fetchTargets = asset || symbol;
  const candleResults = await Promise.all(
    tfs.map(async (tf) => {
      try {
        const r = await fetchCandles(fetchTargets, tf, 200);
        return [tf, r];
      } catch (e) {
        return [tf, { candles: [], error: e.message }];
      }
    })
  );
  for (const [tf, r] of candleResults) {
    candleCache[tf] = r.candles || [];
  }

  // Get current price (used for context)
  let currentPrice = null;
  try {
    const pr = await fetchPrice(fetchTargets);
    currentPrice = pr.price;
  } catch (_) {}

  const allOpinions = [];
  const errors = [];

  // Run each enabled tactic on each of its applicable timeframes
  for (const tacticId of (enabledTactics || Object.keys(TACTICS))) {
    const tactic = TACTICS[tacticId];
    if (!tactic) {
      errors.push({ tactic: tacticId, error: 'unknown tactic' });
      continue;
    }
    const applicableTFs = tactic.defaultTFs.filter((tf) => tfs.includes(tf));

    for (const tf of applicableTFs) {
      const candles = candleCache[tf];
      if (!candles || candles.length === 0) continue;
      try {
        const opinions = tactic.run(candles, { timeframe: tf, asset, currentPrice });
        const cleaned = clean(opinions);
        for (const op of cleaned) allOpinions.push(op);
      } catch (e) {
        errors.push({ tactic: tacticId, timeframe: tf, error: e.message });
      }
    }
  }

  return {
    asset: asset || null,
    symbol: symbol || null,
    currentPrice,
    timeframes: tfs,
    opinionCount: allOpinions.length,
    opinions: allOpinions,
    errors: errors.length > 0 ? errors : undefined,
    ts: Date.now(),
  };
}

// HTTP handler
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  try {
    const asset = req.query.asset || null;
    const symbol = req.query.symbol || null;
    if (!asset && !symbol) {
      return res.status(400).json({ error: 'asset or symbol required' });
    }

    let enabledTactics = null;
    if (req.query.tactics && req.query.tactics !== 'all') {
      enabledTactics = String(req.query.tactics).split(',').map((s) => s.trim()).filter(Boolean);
    }

    let timeframes = null;
    if (req.query.timeframes) {
      timeframes = String(req.query.timeframes).split(',').map((s) => s.trim()).filter((tf) => ALL_TFS.includes(tf));
      if (timeframes.length === 0) timeframes = null;
    }

    const result = await runForAsset({ asset, symbol, enabledTactics, timeframes });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'unknown error' });
  }
};

module.exports.runForAsset = runForAsset;
module.exports.TACTICS = TACTICS;