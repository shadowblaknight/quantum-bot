// =====================================================================
// V12.4.1 — /api/diag
// =====================================================================
// One-click diagnostic for the whole pipeline. Hit this in a browser:
//   /api/diag
//   /api/diag?asset=gold (deep-dive single asset)
//
// Reports:
//   1. MetaAPI account connection (deployed? connected? last sync?)
//   2. Broker symbol map (how many symbols available, which are mapped)
//   3. Per-asset, per-TF candle freshness (CRITICAL: shows broker streaming health)
//   4. Active kill zone vs system time
//   5. Watcher state (events count, last tick age)
//   6. Cron last run time
//
// If candles are hours-stale across all assets while account-information is
// fresh, the broker-side data feed is broken — not the code. User must check
// MetaAPI dashboard, MT5 terminal deployment, or upgrade plan.
// =====================================================================

const { getRedis, safeParse, applyCors, getCurrentSession } = require('./_lib');
const { getAllAssets, getAssetById } = require('./asset-registry');
const { fetchAccount, fetchPositions } = require('./broker');
const { fetchCandles } = require('./candle-source');
const { resolveSymbol, getMappedAssets, getSyncMeta } = require('./symbol-resolver');
const { checkKillZone, killZoneDisplayName } = require('./kill-zones');

const WATCHLIST_KEY = 'v12:watchlist';

function fmtMinAgo(ms) {
  if (ms == null || isNaN(ms)) return '?';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60 * 10) / 10}h`;
  return `${Math.round(mins / 1440 * 10) / 10}d`;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const t0 = Date.now();
  const focusAsset = req.query?.asset || null;

  const result = {
    ts: new Date().toISOString(),
    systemTime: { utc: new Date().toUTCString(), session: getCurrentSession() },
  };

  // ── 1. MetaAPI account info ──────────────────────────────────
  try {
    const account = await fetchAccount();
    result.account = account
      ? {
          ok: true,
          balance: account.balance,
          equity: account.equity,
          currency: account.currency,
          server: account.server,
          freeMargin: account.freeMargin,
        }
      : { ok: false, error: 'fetchAccount returned null' };
  } catch (e) {
    result.account = { ok: false, error: e.message };
  }

  // ── 2. Open positions ──────────────────────────────────────────
  try {
    const positions = await fetchPositions();
    result.positions = Array.isArray(positions)
      ? { count: positions.length, list: positions.map((p) => ({ symbol: p.symbol, profit: p.profit, volume: p.volume })) }
      : { count: 0, list: [] };
  } catch (e) {
    result.positions = { error: e.message };
  }

  // ── 3. Kill zone ──────────────────────────────────────────────
  try {
    const kz = checkKillZone();
    result.killZone = {
      inKillZone: kz.inKillZone,
      name: kz.name,
      display: kz.inKillZone ? killZoneDisplayName(kz.name) : null,
      minutesUntilClose: kz.minutesUntilClose,
      minutesUntilNext: kz.minutesUntilNext,
      nextKillZone: kz.nextKillZone,
    };
  } catch (e) {
    result.killZone = { error: e.message };
  }

  // ── 4. Symbol map ─────────────────────────────────────────────
  try {
    const mapped = await getMappedAssets();
    const meta = await getSyncMeta();
    result.symbolMap = {
      mapped: mapped || [],
      mappedCount: (mapped || []).length,
      lastSync: meta?.syncedAt ? new Date(meta.syncedAt).toISOString() : null,
      lastSyncAgeMin: meta?.syncedAt ? Math.round((Date.now() - meta.syncedAt) / 60000) : null,
      brokerSymbolCount: meta?.brokerSymbolCount || null,
    };
  } catch (e) {
    result.symbolMap = { error: e.message };
  }

  // ── 5. Watchlist ──────────────────────────────────────────────
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.get(WATCHLIST_KEY).catch(() => null);
      const wl = safeParse(raw);
      result.watchlist = Array.isArray(wl) ? wl : ['gold', 'eurusd'];
    } catch (_) {
      result.watchlist = [];
    }
  }

  // ── 6. Per-asset candle freshness ─────────────────────────────
  const assetsToCheck = focusAsset ? [focusAsset] : (result.watchlist || []);
  const nowMs = Date.now();
  result.candles = {};
  for (const asset of assetsToCheck) {
    if (!getAssetById(asset)) continue;
    const symbol = await resolveSymbol(asset).catch(() => null);
    const tfs = focusAsset ? ['1m', '5m', '15m', '1h', '4h', '1d'] : ['5m', '15m', '1h'];
    const perTf = {};
    for (const tf of tfs) {
      try {
        const cRes = await fetchCandles(asset, tf, 5);
        if (cRes.candles && cRes.candles.length > 0) {
          const last = cRes.candles[cRes.candles.length - 1];
          const ageMs = nowMs - new Date(last.time).getTime();
          perTf[tf] = {
            ok: true,
            count: cRes.candles.length,
            lastTime: last.time,
            lastClose: last.close,
            ageMin: Math.round(ageMs / 60000),
            ageHuman: fmtMinAgo(ageMs),
            source: cRes.source,
            warning: ageMs > 2 * 60 * 60 * 1000 ? 'STALE — broker may not be streaming this TF' : null,
          };
        } else {
          perTf[tf] = { ok: false, error: cRes.error || 'no candles', source: cRes.source };
        }
      } catch (e) {
        perTf[tf] = { ok: false, error: e.message };
      }
    }
    result.candles[asset] = { brokerSymbol: symbol, ...perTf };
  }

  // ── 7. Watcher state ──────────────────────────────────────────
  if (r) {
    result.watcherState = {};
    for (const asset of assetsToCheck) {
      try {
        const stateRaw = await r.get(`v12:watcher:${asset}:state`).catch(() => null);
        const parsed = safeParse(stateRaw);
        if (parsed) {
          result.watcherState[asset] = {
            ts: new Date(parsed.ts).toISOString(),
            lastTickAgeMin: Math.round((nowMs - parsed.ts) / 60000),
            eventCount: parsed.eventCount,
            currentPrice: parsed.currentPrice,
            intent: parsed.intent,
            coherenceDecision: parsed.coherence?.decision,
            coherenceReasoning: parsed.coherence?.reasoning,
          };
        }
      } catch (_) {}
    }
  }

  // ── 8. Diagnosis (auto-detect common issues) ──────────────────
  const diag = [];
  const candles = result.candles || {};
  const candleAssets = Object.keys(candles);

  if (!result.account?.ok) {
    diag.push({ severity: 'CRITICAL', msg: 'MetaAPI account connection failed: ' + result.account?.error });
  }

  // Check if ALL assets have stale 1h data → broker streaming issue
  if (candleAssets.length > 0) {
    const stale1h = candleAssets.filter((a) => candles[a]?.['1h']?.ageMin > 120);
    if (stale1h.length === candleAssets.length) {
      diag.push({
        severity: 'CRITICAL',
        msg: 'ALL assets have stale 1h data (>2h old). This is a broker streaming issue, not a code issue. ' +
             'Check: (1) MetaAPI dashboard account state is "DEPLOYED" and "CONNECTED", ' +
             '(2) symbols are in MT5 terminal Market Watch, (3) MetaAPI plan allows historical data streaming, ' +
             '(4) PU Prime account credentials in MetaAPI are valid.',
        assets: stale1h,
      });
    } else if (stale1h.length > 0) {
      diag.push({
        severity: 'WARNING',
        msg: 'Some assets have stale data: ' + stale1h.join(', '),
        assets: stale1h,
      });
    }

    // Per-asset: missing broker symbol
    for (const a of candleAssets) {
      if (!candles[a].brokerSymbol) {
        diag.push({ severity: 'WARNING', msg: `${a}: no broker symbol mapped. Force sync: /api/symbol-resolver?action=sync` });
      }
    }
  }

  if (result.killZone?.inKillZone && (!result.watcherState || Object.keys(result.watcherState).length === 0)) {
    diag.push({
      severity: 'WARNING',
      msg: 'In kill zone but no watcher state found. Cron may not be running. Check /api/cron or /api/watcher manually.',
    });
  }

  if (diag.length === 0) {
    diag.push({ severity: 'OK', msg: 'No issues detected.' });
  }
  result.diagnosis = diag;
  result.processingMs = Date.now() - t0;

  return res.status(200).json(result);
};