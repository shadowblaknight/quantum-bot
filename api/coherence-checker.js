/* eslint-disable */
// V12 — api/coherence-checker.js
//
// THE BRAIN of V12. Reads all tactic opinions for one asset, asks: do these
// opinions tell a coherent story RIGHT NOW? If yes, build a trade setup. If
// no, return null (wait).
//
// CRITICAL: NO SCORING. NO THRESHOLDS. NO GATES.
// Decisions are based on structural rules:
//   - Do directional opinions point the same way?
//   - Are they on compatible timeframes?
//   - Do entry zones overlap?
//   - Can we derive a single SL that respects all invalidations?
//   - Do we have meaningful TP targets (session levels, swing levels)?
//
// MODE is implied by which timeframes carry the opinion, not chosen.
//
// Output: { decision: 'TRADE' | 'WAIT', setup?, reasoning, opinionsUsed }
// ----------------------------------------------------------------------------

const { runForAsset } = require('./tactics-run');
const { fetchPrice } = require('./broker');
const { atr, getCurrentSession } = require('./_lib');
const { getAssetById } = require('./asset-registry');

// =================================================================
// TIMEFRAME COMPATIBILITY
// =================================================================
// Two TFs are "compatible" if they're within 2 steps of each other in this list:
const TF_ORDER = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];

function tfIndex(tf) {
  return TF_ORDER.indexOf(tf);
}

function tfsCompatible(tfA, tfB) {
  const a = tfIndex(tfA);
  const b = tfIndex(tfB);
  if (a < 0 || b < 0) return false;
  return Math.abs(a - b) <= 3;
}

// Determine trade mode from the cluster of timeframes carrying the opinions
function inferMode(timeframes) {
  if (!timeframes || timeframes.length === 0) return 'DAY';
  // Use the LARGEST timeframe present as the dominant one
  const indices = timeframes.map(tfIndex).filter((i) => i >= 0);
  if (indices.length === 0) return 'DAY';
  const max = Math.max(...indices);
  const dominantTF = TF_ORDER[max];

  if (['1m', '5m'].includes(dominantTF)) return 'SCALP';
  if (['15m', '30m', '1h'].includes(dominantTF)) return 'DAY';
  return 'SWING'; // 4h, 1d, 1w
}

// =================================================================
// DIRECTIONAL COHERENCE
// =================================================================
// Group directional opinions by direction. NEUTRAL opinions (session levels)
// are excluded from direction voting but kept for TP target derivation.

function classifyByDirection(opinions) {
  const longs = [];
  const shorts = [];
  const neutrals = [];

  for (const op of opinions) {
    if (op.direction === 'LONG') longs.push(op);
    else if (op.direction === 'SHORT') shorts.push(op);
    else neutrals.push(op);
  }

  return { longs, shorts, neutrals };
}

// Are the directional opinions coherent?
//   - All same direction (all LONG or all SHORT) → coherent
//   - Both directions present → check if they're on incompatible timeframes
//     (M1 LONG vs H4 SHORT = incoherent; H1 LONG vs M5 SHORT might be M5 noise)
function checkDirectionalCoherence(longs, shorts) {
  if (longs.length === 0 && shorts.length === 0) {
    return { coherent: false, reason: 'no directional opinions' };
  }
  if (longs.length > 0 && shorts.length === 0) {
    return { coherent: true, direction: 'LONG', primary: longs };
  }
  if (shorts.length > 0 && longs.length === 0) {
    return { coherent: true, direction: 'SHORT', primary: shorts };
  }

  // Both directions present. Coherent only if one side is on lower TF noise
  // and the other is on higher TF (HTF wins).
  const longMaxTF = Math.max(...longs.map((o) => tfIndex(o.timeframe)));
  const shortMaxTF = Math.max(...shorts.map((o) => tfIndex(o.timeframe)));

  if (longMaxTF >= shortMaxTF + 2) {
    // LONG dominates higher TFs — shorts are likely M1/M5 noise
    return { coherent: true, direction: 'LONG', primary: longs, note: 'HTF LONG dominates; ignoring lower-TF opposing opinions' };
  }
  if (shortMaxTF >= longMaxTF + 2) {
    return { coherent: true, direction: 'SHORT', primary: shorts, note: 'HTF SHORT dominates; ignoring lower-TF opposing opinions' };
  }

  return { coherent: false, reason: 'directional conflict on similar timeframes' };
}

// =================================================================
// ZONAL COHERENCE
// =================================================================
// Do the entry zones / levels of the directional opinions overlap meaningfully?
// We're not requiring exact overlap, but we want the levels to be "close" relative
// to ATR.
//
// We compute a CONFLUENCE ZONE = tightest range that contains the most opinion
// levels. The price in this zone is where we enter.

function computeConfluenceZone(opinions, atrValue) {
  if (!opinions.length || !atrValue) return null;

  // Collect all entry candidates: opinion.entry, or zone center if zone exists
  const entryCandidates = opinions.map((op) => {
    if (op.entry != null && isFinite(op.entry)) return { price: op.entry, op };
    if (op.zone && op.zone.upper && op.zone.lower) {
      return { price: (op.zone.upper + op.zone.lower) / 2, op };
    }
    return { price: op.level, op };
  });

  if (entryCandidates.length === 1) {
    // Single opinion — its entry IS the zone
    const sole = entryCandidates[0];
    return {
      center: sole.price,
      upper: sole.price + atrValue * 0.2,
      lower: sole.price - atrValue * 0.2,
      contributingOps: [sole.op],
      tightness: 1.0,
    };
  }

  // Sort by price
  entryCandidates.sort((a, b) => a.price - b.price);

  // Find the TIGHTEST cluster (smallest range containing most opinions)
  // We use a simple algorithm: for each starting opinion, find the largest
  // window of opinions all within K * ATR of the center, and pick the one
  // with the most opinions.
  const MAX_CLUSTER_ATR = 1.5; // opinions within 1.5 ATR cluster together

  let bestCluster = null;
  for (let i = 0; i < entryCandidates.length; i++) {
    const cluster = [entryCandidates[i]];
    for (let j = 0; j < entryCandidates.length; j++) {
      if (i === j) continue;
      if (Math.abs(entryCandidates[j].price - entryCandidates[i].price) <= atrValue * MAX_CLUSTER_ATR) {
        cluster.push(entryCandidates[j]);
      }
    }
    if (!bestCluster || cluster.length > bestCluster.length) {
      bestCluster = cluster;
    }
  }

  if (!bestCluster) return null;

  const prices = bestCluster.map((c) => c.price);
  const upper = Math.max(...prices);
  const lower = Math.min(...prices);
  const center = (upper + lower) / 2;
  const tightness = bestCluster.length / entryCandidates.length;

  return {
    center,
    upper: upper + atrValue * 0.1,
    lower: lower - atrValue * 0.1,
    contributingOps: bestCluster.map((c) => c.op),
    tightness,
  };
}

// =================================================================
// INVALIDATION
// =================================================================
// Pick a single SL that respects all contributing opinions' invalidations.
// For LONG: use the LOWEST invalidation among contributing opinions (give them all room)
// For SHORT: use the HIGHEST invalidation.

function pickInvalidation(direction, contributingOps, atrValue) {
  const invalidations = contributingOps
    .map((op) => op.invalidation)
    .filter((v) => v != null && isFinite(v));

  if (invalidations.length === 0) return null;

  if (direction === 'LONG') {
    return Math.min(...invalidations) - atrValue * 0.1; // small extra buffer
  } else {
    return Math.max(...invalidations) + atrValue * 0.1;
  }
}

// =================================================================
// TP TARGETS
// =================================================================
// Derive TP levels from:
//   1. NEUTRAL opinions (session levels, PDH/PDL, weekly open) — these are
//      magnets in the trade direction
//   2. Reasonable R-multiples from entry/SL (1R, 2R, 3R, 4R) as fallback
//   3. Swing levels in the trade direction
//
// Returns array of { price, source, rMultiple } sorted by distance from entry

function deriveTargets(direction, entry, sl, neutrals, currentPrice) {
  if (entry == null || sl == null) return [];
  const slDistance = Math.abs(entry - sl);
  if (slDistance <= 0) return [];

  const targets = [];

  // Pull TP candidates from NEUTRAL opinions (session levels) that are in
  // the trade direction
  for (const op of neutrals) {
    const levelPrice = op.level;
    const inDirection = direction === 'LONG' ? levelPrice > entry : levelPrice < entry;
    if (!inDirection) continue;

    const distance = Math.abs(levelPrice - entry);
    const rMultiple = distance / slDistance;

    // Only meaningful if R >= 0.8 (don't trade for tiny TPs) and <= 8 (insane targets)
    if (rMultiple >= 0.8 && rMultiple <= 8) {
      targets.push({
        price: levelPrice,
        source: op.evidence?.type || op.tactic,
        rMultiple,
        sourceOpinion: op,
      });
    }
  }

  // Sort by distance from entry, take up to 4 TPs
  targets.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

  // If we have fewer than 4 from real levels, pad with R-multiple-based fallbacks
  const baseRs = [1.0, 2.0, 3.0, 4.0];
  for (const r of baseRs) {
    if (targets.length >= 4) break;
    const targetPrice = direction === 'LONG'
      ? entry + slDistance * r
      : entry - slDistance * r;
    // Skip if we already have a target near this R
    const tooClose = targets.some((t) => Math.abs(t.rMultiple - r) < 0.3);
    if (!tooClose) {
      targets.push({
        price: targetPrice,
        source: `${r}R fallback`,
        rMultiple: r,
        sourceOpinion: null,
      });
    }
  }

  // Final sort and trim
  targets.sort((a, b) => a.rMultiple - b.rMultiple);
  return targets.slice(0, 4);
}

// =================================================================
// MAIN: CHECK COHERENCE
// =================================================================
// The big function. Takes opinions, current price, ATR. Returns decision.

function checkCoherence(opinions, currentPrice, atrValue) {
  if (!opinions || opinions.length === 0) {
    return { decision: 'WAIT', reasoning: 'no opinions detected' };
  }
  if (currentPrice == null || !atrValue) {
    return { decision: 'WAIT', reasoning: 'missing price or ATR' };
  }

  // 1. Classify by direction
  const { longs, shorts, neutrals } = classifyByDirection(opinions);

  // 2. Check directional coherence
  const dirCheck = checkDirectionalCoherence(longs, shorts);
  if (!dirCheck.coherent) {
    return {
      decision: 'WAIT',
      reasoning: dirCheck.reason,
      opinionCounts: { long: longs.length, short: shorts.length, neutral: neutrals.length },
    };
  }

  const direction = dirCheck.direction;
  const primaryOps = dirCheck.primary;

  // 3. Check zonal coherence (do entry zones overlap?)
  const zone = computeConfluenceZone(primaryOps, atrValue);
  if (!zone) {
    return {
      decision: 'WAIT',
      reasoning: 'no entry confluence zone could be computed',
    };
  }

  // 4. Is current price NEAR the entry zone? We don't enter if price has
  //    already moved well past the setup.
  // Key rule: for LONG, current price should be at or BELOW the entry zone
  //           (we want to BUY into the zone, not chase it after price ran up)
  //           Actually we want price to retest the zone, so it should be
  //           coming back DOWN to the zone for LONG.
  //           Practically: current price should be within ~1.5 ATR of the zone center.
  const zoneDistance = Math.abs(currentPrice - zone.center);
  if (zoneDistance > atrValue * 2) {
    return {
      decision: 'WAIT',
      reasoning: `price too far from confluence zone (${(zoneDistance / atrValue).toFixed(1)} ATR away)`,
      zoneCenter: zone.center,
      currentPrice,
    };
  }

  // 5. Pick invalidation
  const invalidation = pickInvalidation(direction, zone.contributingOps, atrValue);
  if (invalidation == null) {
    return { decision: 'WAIT', reasoning: 'no invalidation level could be determined' };
  }

  // 6. Validate SL distance is reasonable (not too tight, not too wide)
  const entryPrice = zone.center;
  const slDistance = Math.abs(entryPrice - invalidation);
  if (slDistance < atrValue * 0.5) {
    return { decision: 'WAIT', reasoning: 'SL too tight (< 0.5 ATR)' };
  }
  if (slDistance > atrValue * 6) {
    return { decision: 'WAIT', reasoning: 'SL too wide (> 6 ATR) — setup likely stale' };
  }

  // 7. Derive TP targets
  const targets = deriveTargets(direction, entryPrice, invalidation, neutrals, currentPrice);
  if (targets.length === 0) {
    return { decision: 'WAIT', reasoning: 'no meaningful TP targets could be derived' };
  }

  // 8. Determine mode from timeframe cluster
  const tfsInPlay = [...new Set(primaryOps.map((o) => o.timeframe))];
  const mode = inferMode(tfsInPlay);

  // 9. Build the setup. This is the output the rest of the system consumes.
  return {
    decision: 'TRADE',
    setup: {
      direction,
      mode,
      entry: entryPrice,
      entryZone: { upper: zone.upper, lower: zone.lower },
      sl: invalidation,
      slDistance,
      slDistanceATR: slDistance / atrValue,
      targets,
      timeframesInPlay: tfsInPlay,
      contributingTactics: [...new Set(primaryOps.map((o) => o.tactic))],
      formedAt: Date.now(),
    },
    reasoning: dirCheck.note || `${direction} setup: ${primaryOps.length} aligned opinions across ${tfsInPlay.length} TFs`,
    opinionsUsed: primaryOps,
    neutralsUsed: neutrals,
    confluenceZone: zone,
  };
}

// =================================================================
// HTTP HANDLER (also called by cron)
// =================================================================

async function checkCoherenceForAsset(assetId) {
  const meta = getAssetById(assetId);
  if (!meta) return { error: `unknown asset: ${assetId}` };

  // Get current price
  const priceResult = await fetchPrice(assetId);
  const currentPrice = priceResult?.price;
  if (!currentPrice) {
    return { decision: 'WAIT', reasoning: 'price unavailable', error: priceResult?.error };
  }

  // Run all detectors
  const tacticsResult = await runForAsset({ asset: assetId });
  if (!tacticsResult || !tacticsResult.opinions) {
    return { decision: 'WAIT', reasoning: 'no opinions returned' };
  }

  // Compute ATR from H1 candles (already fetched by tactics-run via cache).
  // We need it here for coherence math. Re-fetch via broker.
  const { fetchCandles } = require('./broker');
  const c = await fetchCandles(assetId, '1h', 50);
  const atrValue = atr(c.candles || [], 14);
  if (!atrValue) {
    return { decision: 'WAIT', reasoning: 'ATR unavailable' };
  }

  const result = checkCoherence(tacticsResult.opinions, currentPrice, atrValue);
  return {
    asset: assetId,
    currentPrice,
    atr: atrValue,
    session: getCurrentSession(),
    opinionCount: tacticsResult.opinions.length,
    ...result,
  };
}

module.exports = async (req, res) => {
  try {
    const asset = req.query.asset;
    if (!asset) return res.status(400).json({ error: 'asset required' });
    const result = await checkCoherenceForAsset(asset);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.checkCoherence = checkCoherence;
module.exports.checkCoherenceForAsset = checkCoherenceForAsset;
module.exports.inferMode = inferMode;
module.exports.tfsCompatible = tfsCompatible;