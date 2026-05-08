/* eslint-disable */
// V12 — api/sizing-engine.js
//
// Pure function: given a setup and user context, compute the SUGGESTED lot
// size. The user is free to ignore this — they set their own lot in the cockpit.
//
// FORMULA:
//   riskCapacity = capital * riskPercent  (e.g., $10000 * 0.01 = $100)
//   pipValue     = asset.dollarPerPipPerLot
//   pipsAtRisk   = slDistance / asset.pipSize
//   lot          = riskCapacity / (pipsAtRisk * pipValue)
//
// Then we round to broker's lot increment (typically 0.01) and respect min lot.
//
// We do NOT enforce maximum lot. User said: "brokers don't give a fuck how
// much you risk, why should we." We respect user agency.
// ----------------------------------------------------------------------------

const { getAssetById } = require('./asset-registry');

const DEFAULT_RISK_PERCENT = 0.01;     // 1% per trade default
const DEFAULT_LOT_INCREMENT = 0.01;
const DEFAULT_MIN_LOT = 0.01;

// Main: suggest lot size for a given setup.
// Returns { suggestedLot, riskDollars, pipsAtRisk, pipValue, math }
function suggestLot({
  assetId,
  slDistance,        // price units (e.g., 4 for gold = $4)
  capital = 10000,
  riskPercent = DEFAULT_RISK_PERCENT,
  lotIncrement = DEFAULT_LOT_INCREMENT,
  minLot = DEFAULT_MIN_LOT,
}) {
  const asset = getAssetById(assetId);
  if (!asset) {
    return { error: 'unknown asset', suggestedLot: minLot };
  }
  if (!slDistance || slDistance <= 0) {
    return { error: 'invalid SL distance', suggestedLot: minLot };
  }
  if (!capital || capital <= 0) {
    return { error: 'invalid capital', suggestedLot: minLot };
  }

  const pipSize = asset.pipSize;
  const pipValue = asset.dollarPerPipPerLot;
  if (!pipSize || !pipValue) {
    return { error: 'asset metadata incomplete', suggestedLot: minLot };
  }

  const riskCapacity = capital * riskPercent;
  const pipsAtRisk = slDistance / pipSize;
  const dollarPerPipForLot1 = pipValue;          // for 1 lot
  const rawLot = riskCapacity / (pipsAtRisk * dollarPerPipForLot1);

  // Round DOWN to the nearest lot increment (conservative)
  let lot = Math.floor(rawLot / lotIncrement) * lotIncrement;
  // Respect min
  if (lot < minLot) lot = minLot;
  // Round to 2 decimals (typical lot resolution)
  lot = Math.round(lot * 100) / 100;

  const actualRisk = lot * pipsAtRisk * dollarPerPipForLot1;

  return {
    suggestedLot: lot,
    riskDollars: actualRisk,
    riskPercentActual: actualRisk / capital,
    pipsAtRisk,
    pipValue,
    pipSize,
    math: {
      capital,
      riskPercent,
      riskCapacity,
      slDistance,
      rawLot,
      finalLot: lot,
    },
  };
}

// Compute dollar P&L per TP for a given lot, for cockpit display
// Returns array matching the targets array: [{ price, rMultiple, dollarProfit }]
function computeTPDollars({ assetId, lot, entry, targets, direction }) {
  const asset = getAssetById(assetId);
  if (!asset || !lot || !entry || !targets) return [];

  return targets.map((t) => {
    const distance = Math.abs(t.price - entry);
    const pips = distance / asset.pipSize;
    const dollarProfit = pips * asset.dollarPerPipPerLot * lot;
    return {
      ...t,
      pips,
      dollarProfit,
    };
  });
}

// Compute SL dollar loss for a given lot
function computeSLDollars({ assetId, lot, entry, sl }) {
  const asset = getAssetById(assetId);
  if (!asset || !lot || !entry || !sl) return null;

  const distance = Math.abs(entry - sl);
  const pips = distance / asset.pipSize;
  const dollarLoss = pips * asset.dollarPerPipPerLot * lot;
  return {
    pips,
    dollarLoss,
  };
}

// HTTP handler — for debugging / cockpit suggestion fetching
module.exports = async (req, res) => {
  try {
    const assetId = req.query.asset;
    const slDistance = parseFloat(req.query.sl || '0');
    const capital = parseFloat(req.query.capital || '10000');
    const riskPercent = parseFloat(req.query.risk || '0.01');

    if (!assetId || !slDistance) {
      return res.status(400).json({ error: 'asset and sl required' });
    }

    const result = suggestLot({ assetId, slDistance, capital, riskPercent });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.suggestLot = suggestLot;
module.exports.computeTPDollars = computeTPDollars;
module.exports.computeSLDollars = computeSLDollars;