/* eslint-disable */
// V12.3 — api/cockpit-grid.js
//
// READ-ONLY endpoint that powers the plain-cockpit multi-instrument grid view.
// Reads exclusively from Redis (cached watcher state). Calls NO broker, NO
// TwelveData. Safe to poll every 5 seconds without burning any tokens.
//
// Returns one row per watchlist asset:
//   {
//     id, name, category,
//     status: 'watching' | 'pending' | 'placed' | 'in-trade' | 'paused',
//     currentPrice, atrH1,
//     lastSetup: { template, direction, entry, sl, tp1, mode } | null,
//     activePending: { id, status, createdAt, expiresAt } | null,
//     openPosition: { ticket, direction, openPrice, currentPnL, lot } | null,
//     recognition: { winRate, matchCount, advice } | null,
//   }
// ----------------------------------------------------------------------------

const { applyCors, getRedis, safeParse } = require('./_lib');
const { getAssetById } = require('./asset-registry');
const { checkKillZone, killZoneDisplayName } = require('./kill-zones');

const WATCHLIST_KEY = 'v12:watchlist';
const STATE_KEY = (asset) => `v12:watcher:${asset}:state`;
const PENDING_KEY = (asset) => `v12:watcher:${asset}:pending`;
const PAUSE_KEY = (asset) => `v12:watcher:${asset}:paused`;
const POSITION_STATE_KEY = (positionId) => `v12:position:${positionId}`;

async function readAssetRow(r, assetId) {
  const asset = getAssetById(assetId);
  if (!asset) return null;

  const [stateRaw, pendingRaw, pausedRaw] = await Promise.all([
    r.get(STATE_KEY(assetId)).catch(() => null),
    r.get(PENDING_KEY(assetId)).catch(() => null),
    r.get(PAUSE_KEY(assetId)).catch(() => null),
  ]);

  const state = safeParse(stateRaw) || {};
  const pendingList = safeParse(pendingRaw) || [];
  const isPaused = !!safeParse(pausedRaw);

  // Active pending (pending or placed, not closed/invalidated)
  const activePending = pendingList.find((p) =>
    p.status === 'pending' || p.status === 'placed'
  );

  // Most recent closed setup for "last setup" display
  const closedList = pendingList
    .filter((p) => p.status === 'closed' && p.closedAt)
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  const lastClosed = closedList[0];

  // Determine status
  let status = 'watching';
  if (isPaused) status = 'paused';
  else if (activePending?.status === 'placed' && activePending.filledAt) status = 'in-trade';
  else if (activePending?.status === 'placed') status = 'awaiting-fill';
  else if (activePending?.status === 'pending') status = 'pending';

  // Build last setup summary
  const sourcePending = activePending || lastClosed;
  const lastSetup = sourcePending ? {
    template: sourcePending.templateName || sourcePending.setup?.templateName,
    direction: sourcePending.setup?.direction,
    mode: sourcePending.setup?.mode,
    entry: sourcePending.plannedEntry,
    sl: sourcePending.slPrice,
    tp1: sourcePending.tpLevels?.[0]?.price,
    formedAt: sourcePending.createdAt,
    status: sourcePending.status,
    pnl: sourcePending.finalPnL,
  } : null;

  // Active position
  const openPosition = activePending?.filledAt ? {
    ticket: activePending.brokerOrderId,
    direction: activePending.setup?.direction,
    openPrice: activePending.actualEntry || activePending.plannedEntry,
    lot: activePending.sizing?.recommendedLot,
    filledAt: activePending.filledAt,
  } : null;

  // Recognition score from current pending (template-level history)
  const recognition = activePending?.recognition ? {
    winRate: activePending.recognition.winRate,
    matchCount: activePending.recognition.matchCount,
    advice: activePending.recognition.advice,
  } : null;

  return {
    id: assetId,
    name: asset.name,
    category: asset.category,
    status,
    currentPrice: state.currentPrice || null,
    atrH1: state.atrByTF?.['1h'] || null,
    session: state.session || null,
    lastTickAt: state.ts || null,
    lastSetup,
    activePending: activePending ? {
      id: activePending.id,
      status: activePending.status,
      createdAt: activePending.createdAt,
      expiresAt: activePending.expiresAt,
      killZone: activePending.placedKillZone,
    } : null,
    openPosition,
    recognition,
  };
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const r = getRedis();
  if (!r) return res.status(500).json({ error: 'redis unavailable' });

  try {
    // Read watchlist
    let watchlist = ['gold', 'eurusd'];
    const raw = await r.get(WATCHLIST_KEY).catch(() => null);
    const parsed = safeParse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      watchlist = parsed.filter((a) => getAssetById(a));
    }

    const rows = await Promise.all(watchlist.map((id) => readAssetRow(r, id)));
    const validRows = rows.filter(Boolean);

    return res.status(200).json({
      ts: Date.now(),
      killZone: checkKillZone(),
      killZoneDisplay: killZoneDisplayName(checkKillZone().name),
      watchlist,
      assets: validRows,
      summary: {
        total: validRows.length,
        inTrade: validRows.filter((r) => r.status === 'in-trade').length,
        pending: validRows.filter((r) => r.status === 'pending' || r.status === 'awaiting-fill').length,
        watching: validRows.filter((r) => r.status === 'watching').length,
        paused: validRows.filter((r) => r.status === 'paused').length,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};