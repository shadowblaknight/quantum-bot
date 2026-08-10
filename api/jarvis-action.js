/* eslint-disable */
// api/jarvis-action.js  v1.0 — JARVIS Co-Pilot Write Path
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/jarvis-action
//   body: { action, ...params, dryRun? }
//   returns: { ok, result, speech, auditId }
//
// JARVIS's ONLY authorized write path into the trading system.
// All actions are logged to Redis. DryRun mode returns what WOULD happen.
//
// Authorized actions:
//   MODIFY_POSITION   — change SL and/or TP on a live MT5 position
//   MOVE_BREAKEVEN    — move SL to entry + pip buffer (never worsens position)
//   CLOSE_POSITION    — close an open position (requires confirmed:true)
//   SET_MODE          — change activeMode (active/defensive/sleep/vacation)
//   SET_LOT_MULT      — update tierA/tierB lot multipliers
//
// NEVER does: create orders, touch closed trades, alter prices or outcomes.
// ─────────────────────────────────────────────────────────────────────────────

const { applyCors, getRedis, safeParse } = require('./_lib');
const { getAssetById } = require('./asset-registry');

const RULES_KEY   = 'v13:pilot:rules';
const AUDIT_KEY   = 'v1:jarvis:action:audit';
const PENDING_KEY = 'v1:jarvis:pending_action';
const AUDIT_CAP   = 200;
const VALID_MODES = ['active', 'defensive', 'sleep', 'vacation'];

// ─── MetaAPI trade call (same pattern as manage-trades.js) ────────────────────
async function metaApiTrade(payload) {
  const token     = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  const region    = process.env.METAAPI_REGION || 'london';
  if (!token || !accountId) return { ok: false, error: 'MetaAPI credentials not configured' };

  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/trade`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'auth-token': token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `MetaAPI ${resp.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, data: await resp.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Round price to pip precision for the given asset
function roundToPip(price, assetId) {
  const meta = getAssetById(assetId);
  if (!meta?.pipSize) return price;
  const decimals = String(meta.pipSize).includes('.') ? String(meta.pipSize).split('.')[1].length : 0;
  return +price.toFixed(Math.max(decimals, 2));
}

// ─── Action handlers ─────────────────────────────────────────────────────────

async function doModifyPosition(params, dryRun) {
  const { positionId, sl, tp, assetId } = params;
  if (!positionId) return { ok: false, error: 'positionId required' };
  if (sl == null && tp == null) return { ok: false, error: 'sl or tp required' };

  const slR = sl != null ? roundToPip(Number(sl), assetId) : null;
  const tpR = tp != null ? roundToPip(Number(tp), assetId) : null;

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      description: `MODIFY position ${positionId}${slR != null ? ` → SL ${slR}` : ''}${tpR != null ? ` → TP ${tpR}` : ''}`,
      speech: `Ready to move the stop loss to ${slR}${tpR ? ` and take profit to ${tpR}` : ''} on position ${positionId}. Say confirm to execute.`,
    };
  }

  const payload = { actionType: 'POSITION_MODIFY', positionId: String(positionId) };
  if (slR != null) payload.stopLoss   = slR;
  if (tpR != null) payload.takeProfit = tpR;
  const result = await metaApiTrade(payload);
  return {
    ...result,
    description: `Modified position ${positionId} SL=${slR} TP=${tpR}`,
    speech: result.ok
      ? `Done, Sir. Position ${positionId} updated — SL ${slR != null ? slR : 'unchanged'}${tpR != null ? `, TP ${tpR}` : ''}.`
      : `Modification failed, Sir. MetaAPI returned: ${result.error}.`,
  };
}

async function doMoveBreakeven(params, dryRun) {
  const { positionId, entryPrice, direction, assetId } = params;
  if (!positionId || entryPrice == null || !direction)
    return { ok: false, error: 'positionId, entryPrice, direction required' };

  const meta = getAssetById(assetId);
  const pipBuffer = meta?.pipSize ? meta.pipSize * 2 : 0.0002; // 2-pip buffer
  const beLevel = direction === 'BUY' || direction === 'LONG'
    ? roundToPip(Number(entryPrice) + pipBuffer, assetId)
    : roundToPip(Number(entryPrice) - pipBuffer, assetId);

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      description: `BREAKEVEN position ${positionId} — SL → ${beLevel}`,
      speech: `I will move the stop loss on position ${positionId} to ${beLevel}, which is entry plus ${direction === 'BUY' || direction === 'LONG' ? 'a 2-pip buffer above' : 'a 2-pip buffer below'} your entry at ${entryPrice}. This locks in a risk-free trade. Say confirm to execute.`,
    };
  }

  const result = await metaApiTrade({
    actionType: 'POSITION_MODIFY',
    positionId: String(positionId),
    stopLoss: beLevel,
  });
  return {
    ...result,
    description: `Moved position ${positionId} to breakeven at ${beLevel}`,
    speech: result.ok
      ? `Breakeven set, Sir. Stop loss moved to ${beLevel} on position ${positionId}. This trade is now risk-free.`
      : `Failed to set breakeven, Sir. MetaAPI returned: ${result.error}.`,
  };
}

async function doClosePosition(params, dryRun) {
  const { positionId, assetId, reason } = params;
  if (!positionId) return { ok: false, error: 'positionId required' };

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      description: `CLOSE position ${positionId}${assetId ? ` (${assetId})` : ''}`,
      speech: `I will close position ${positionId}${assetId ? ` on ${assetId}` : ''} at market. This is irreversible. Say confirm to execute.`,
    };
  }

  const result = await metaApiTrade({
    actionType: 'POSITION_CLOSE_ID',
    positionId: String(positionId),
  });
  return {
    ...result,
    description: `Closed position ${positionId} — reason: ${reason || 'JARVIS'}`,
    speech: result.ok
      ? `Position ${positionId} closed at market, Sir.`
      : `Close failed, Sir. MetaAPI returned: ${result.error}.`,
  };
}

async function doSetMode(r, params, dryRun) {
  const { mode } = params;
  if (!VALID_MODES.includes(mode))
    return { ok: false, error: `invalid mode: ${mode}. Valid: ${VALID_MODES.join(', ')}` };

  if (dryRun) {
    const modeDesc = {
      active:    'all templates, full lot, max 5 positions',
      defensive: 'high-confidence only, half lot, min 2R, max 2 positions',
      sleep:     'effectively halted (OTE-continuation is disabled)',
      vacation:  'no new trades — existing positions continue',
    };
    return {
      ok: true, dryRun: true,
      description: `SET_MODE → ${mode}`,
      speech: `I will switch to ${mode} mode — ${modeDesc[mode]}. Say confirm to apply.`,
    };
  }

  const rawRules = await r.get(RULES_KEY).catch(() => null);
  const rules = safeParse(rawRules) || {};
  rules.activeMode   = mode;
  rules.lastModified = new Date().toISOString();
  rules.modifiedBy   = 'JARVIS';
  await r.set(RULES_KEY, JSON.stringify(rules));

  return {
    ok: true,
    description: `activeMode set to ${mode}`,
    speech: `Mode switched to ${mode}, Sir. The bot will apply these constraints to all new signals immediately.`,
  };
}

async function doSetLotMult(r, params, dryRun) {
  const { tierA, tierB } = params;
  if (tierA == null && tierB == null)
    return { ok: false, error: 'tierA or tierB required' };

  const aCap = 2.5, bCap = 2.5, floor = 0.25;
  const newA = tierA != null ? Math.max(floor, Math.min(aCap, Number(tierA))) : null;
  const newB = tierB != null ? Math.max(floor, Math.min(bCap, Number(tierB))) : null;

  if (dryRun) {
    const parts = [];
    if (newA != null) parts.push(`Tier-A → ${newA}×`);
    if (newB != null) parts.push(`Tier-B → ${newB}×`);
    return {
      ok: true, dryRun: true,
      description: `SET_LOT_MULT ${parts.join(', ')}`,
      speech: `I will set ${parts.join(' and ')}. This affects all new signals immediately. Say confirm to apply.`,
    };
  }

  const rawRules = await r.get(RULES_KEY).catch(() => null);
  const rules = safeParse(rawRules) || {};
  if (newA != null) rules.tierALotMultiplier = newA;
  if (newB != null) rules.tierBLotMultiplier = newB;
  rules.lastModified = new Date().toISOString();
  rules.modifiedBy   = 'JARVIS';
  await r.set(RULES_KEY, JSON.stringify(rules));

  const parts = [];
  if (newA != null) parts.push(`Tier-A ${newA}×`);
  if (newB != null) parts.push(`Tier-B ${newB}×`);

  return {
    ok: true,
    description: `Lot multipliers updated: ${parts.join(', ')}`,
    speech: `Sizing updated, Sir. ${parts.join(', ')}. All new signals will use these multipliers.`,
  };
}

// Retrieve and clear the pending action (for CONFIRM intent)
async function getPendingAction(r) {
  const raw = await r.get(PENDING_KEY).catch(() => null);
  return safeParse(raw) || null;
}

async function clearPendingAction(r) {
  await r.del(PENDING_KEY).catch(() => {});
}

// Direct action executor — called by jarvis.js to avoid self-referential HTTP
async function executeAction(r, body) {
  const { action, dryRun = false, triggeredBy, ...params } = body || {};
  if (!action) return { ok: false, error: 'action required', speech: 'No action specified.' };
  switch (action.toUpperCase()) {
    case 'MODIFY_POSITION': return doModifyPosition(params, dryRun);
    case 'MOVE_BREAKEVEN':  return doMoveBreakeven(params, dryRun);
    case 'CLOSE_POSITION':
      if (!params.confirmed && !dryRun)
        return { ok: false, error: 'confirmed required', speech: 'Set confirmed:true to close a position, Sir.' };
      return doClosePosition(params, dryRun);
    case 'SET_MODE':     return doSetMode(r, params, dryRun);
    case 'SET_LOT_MULT': return doSetLotMult(r, params, dryRun);
    default: return { ok: false, error: `unknown action: ${action}`, speech: `Unknown action: ${action}` };
  }
}

// ─── Audit logger ─────────────────────────────────────────────────────────────
async function auditLog(r, action, params, result, triggeredBy) {
  if (!r) return;
  try {
    const entry = JSON.stringify({
      id:          `act_${Date.now()}`,
      ts:          new Date().toISOString(),
      action,
      params:      JSON.stringify(params).slice(0, 300),
      ok:          result.ok,
      description: result.description || '',
      triggeredBy: (triggeredBy || 'JARVIS').slice(0, 120),
    });
    await r.lpush(AUDIT_KEY, entry);
    await r.ltrim(AUDIT_KEY, 0, AUDIT_CAP - 1);
  } catch (_) {}
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const r = getRedis();
  if (!r) return res.status(503).json({ error: 'Redis unavailable' });

  const { action, dryRun = false, triggeredBy, ...params } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });

  let result;
  try {
    switch (action.toUpperCase()) {
      case 'MODIFY_POSITION':  result = await doModifyPosition(params, dryRun);      break;
      case 'MOVE_BREAKEVEN':   result = await doMoveBreakeven(params, dryRun);       break;
      case 'CLOSE_POSITION':
        // Closing is irreversible — require explicit confirmed:true (not just dryRun=false)
        if (!params.confirmed && !dryRun)
          return res.status(400).json({ ok: false, error: 'Set confirmed:true to close a position', speech: 'Closing a position is irreversible. Send confirmed:true to proceed.' });
        result = await doClosePosition(params, dryRun);
        break;
      case 'SET_MODE':         result = await doSetMode(r, params, dryRun);          break;
      case 'SET_LOT_MULT':     result = await doSetLotMult(r, params, dryRun);       break;
      // Store a pending action (JARVIS uses this before asking for confirmation)
      case 'STORE_PENDING': {
        await r.set(PENDING_KEY, JSON.stringify(params.pending || {}), { ex: 300 }); // 5 min TTL
        return res.status(200).json({ ok: true, speech: params.pending?.speech || 'Pending action stored.' });
      }
      case 'EXECUTE_PENDING': {
        const pending = await getPendingAction(r);
        if (!pending || !pending.action)
          return res.status(404).json({ ok: false, speech: 'No pending action found, Sir. Please specify the action again.' });
        await clearPendingAction(r);
        result = await executeAction(r, { ...pending, dryRun: false, triggeredBy: 'CONFIRM' });
        break;
      }
      default:
        return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
    }

    // Log every non-pending action
    if (action.toUpperCase() !== 'STORE_PENDING') {
      await auditLog(r, action, params, result, triggeredBy);
    }

    const auditId = `act_${Date.now()}`;
    return res.status(result.ok ? 200 : 422).json({
      ok:      result.ok,
      result,
      speech:  result.speech  || (result.ok ? 'Action completed, Sir.' : `Action failed: ${result.error}`),
      auditId,
      dryRun:  dryRun || false,
    });

  } catch (err) {
    await auditLog(r, action, params, { ok: false, description: err.message }, triggeredBy);
    return res.status(500).json({ ok: false, error: err.message, speech: `Action failed with an error, Sir: ${err.message}` });
  }
};

module.exports.executeAction = executeAction;
