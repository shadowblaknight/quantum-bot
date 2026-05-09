/* eslint-disable */
// V12.3 — api/coherence-checker.js
//
// THE BRAIN of V12.3.
//
// Pure template matcher. Reads events from events-run, tries each named
// template, returns the first one that matches.
//
// NO scoring. NO gates. Just pattern recognition:
//   - Either the recent event sequence fits a known ICT setup → trade
//   - Or it doesn't → silent
//
// Templates are tried in order of specificity:
//   1. Unicorn        (highest precision — Breaker + FVG overlap)
//   2. Judas Swing    (London KZ + Asian range — very specific)
//   3. Turtle Soup    (HTF liquidity sweep failure + reversal)
//   4. Silver Bullet  (specific 1-hour windows + continuation)
//   5. OTE Continuation (least specific — any pullback in trend)
//
// First template to match wins. If none match, no trade.

const { runForAsset: runEventsForAsset } = require('./events-run');
const { fetchPrice } = require('./broker');
const { getCurrentSession, getRedis, applyCors } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { checkKillZone, killZoneDisplayName } = require('./kill-zones');

const unicornTemplate = require('./templates/unicorn');
const judasSwingTemplate = require('./templates/judas-swing');
const turtleSoupTemplate = require('./templates/turtle-soup');
const silverBulletTemplate = require('./templates/silver-bullet');
const oteContinuationTemplate = require('./templates/ote-continuation');

const TEMPLATES = [
  unicornTemplate,
  judasSwingTemplate,
  turtleSoupTemplate,
  silverBulletTemplate,
  oteContinuationTemplate,
];

// =================================================================
// MAIN: CHECK COHERENCE
// =================================================================

function checkCoherence({ events, currentPrice, atrByTF, mode }) {
  if (!events || events.length === 0) {
    return { decision: 'WAIT', reasoning: 'no events detected', narrative: [] };
  }
  if (currentPrice == null) {
    return { decision: 'WAIT', reasoning: 'no current price' };
  }

  const attempts = [];
  for (const template of TEMPLATES) {
    try {
      const setup = template.match({ events, currentPrice, atrByTF });
      if (setup) {
        return {
          decision: 'TRADE',
          setup,
          reasoning: `${setup.templateName} matched`,
          narrative: setup.narrative,
          templateName: setup.templateName,
          attemptsLog: attempts,
        };
      } else {
        attempts.push({ template: template.name, matched: false });
      }
    } catch (e) {
      attempts.push({ template: template.name, error: String(e.message || e) });
    }
  }

  return {
    decision: 'WAIT',
    reasoning: 'no ICT template matches the current event sequence',
    narrative: [],
    attemptsLog: attempts,
  };
}

// =================================================================
// HTTP HANDLER
// =================================================================

async function checkCoherenceForAsset(assetId, mode) {
  const meta = getAssetById(assetId);
  if (!meta) return { error: `unknown asset: ${assetId}` };

  const priceResult = await fetchPrice(assetId);
  const currentPrice = priceResult?.price;
  if (!currentPrice) {
    return { decision: 'WAIT', reasoning: 'price unavailable', error: priceResult?.error };
  }

  const evResult = await runEventsForAsset({ asset: assetId });
  const events = evResult.events || [];

  const result = checkCoherence({
    events,
    currentPrice,
    atrByTF: evResult.atrByTF || {},
    mode,
  });

  return {
    asset: assetId,
    currentPrice,
    session: getCurrentSession(),
    killZone: checkKillZone(),
    eventCount: events.length,
    eventsByType: countByType(events),
    ...result,
  };
}

function countByType(events) {
  const counts = {};
  for (const e of events) {
    counts[e.type] = (counts[e.type] || 0) + 1;
  }
  return counts;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const asset = req.query.asset;
    if (!asset) return res.status(400).json({ error: 'asset required' });
    const mode = req.query.mode;
    const result = await checkCoherenceForAsset(asset, mode);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.checkCoherence = checkCoherence;
module.exports.checkCoherenceForAsset = checkCoherenceForAsset;
module.exports.TEMPLATES = TEMPLATES;