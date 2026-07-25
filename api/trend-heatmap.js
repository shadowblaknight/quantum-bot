'use strict';
/* eslint-disable */
// api/trend-heatmap.js  v15.9
// GET /api/trend-heatmap
//
// Classifies each closed ledger / perf-ranking trade as TREND, COUNTER, UNCLEAR,
// or EXCLUDED using the ACTUAL Daily 20/50 EMA at each trade's openedAt timestamp.
//
// Rule (same as scratchpad/trend_classify.js report):
//   up    = lastClose > ema50 AND ema20 > ema50
//   down  = lastClose < ema50 AND ema20 < ema50
//   else  = unclear
//
// TREND  = trade direction agrees with htfTrend (LONG in up-trend, SHORT in down-trend)
// COUNTER = trade direction opposes htfTrend
// UNCLEAR = EMA state is mixed at entry time
// EXCLUDED = recog-only trade (_source==='recog'), or < 60 daily bars before trade date,
//            or 1d candle cache unavailable
//
// Why NOT a static map: gold/BTC trend shifts over time; a frozen constant will
// mislabel trend↔counter as markets move.
//
// Cache: results cached in Redis for 1 h (1d candles are watcher-cached).
//
// v15.9 change: loads trade data directly from Redis instead of self-calling
// /api/perf-ranking via HTTP — Vercel serverless functions cannot reliably call
// themselves (cascading cold-starts + shared timeout budget).

const { applyCors, getRedis, safeParse } = require('./_lib');
const { getAllTrades }                    = require('./recognition-memory');
const { loadAllLedger, mergeRecord, classifySession } = require('./perf-ranking');

const CACHE_KEY     = 'v14:trend-heatmap:cache';
const CACHE_TTL_SEC = 3600; // 1 h
const EMA_MIN_BARS  = 60;   // minimum bars before trade date to classify

const EXCL_TEMPLATES = new Set(['unknown', 'legacy', 'legacy-unknown']);

function calcEma(closes, period) {
  if (closes.length < period) return null;
  const k    = 2 / (period + 1);
  let ema    = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const emas = new Array(period - 1).fill(null);
  emas.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    emas.push(ema);
  }
  return emas;
}

// Returns an array of { barTs (ms), ema20, ema50, close } for bars that have valid EMAs.
function buildEmaTimeSeries(candles) {
  if (!candles || candles.length < 50) return [];
  const closes = candles.map(c => c.close);
  const ema20s = calcEma(closes, 20);
  const ema50s = calcEma(closes, 50);
  if (!ema20s || !ema50s) return [];

  return candles.map((c, i) => {
    if (ema20s[i] == null || ema50s[i] == null) return null;
    return {
      barTs: new Date(c.time).getTime(),
      close: c.close,
      ema20: ema20s[i],
      ema50: ema50s[i],
    };
  }).filter(Boolean);
}

// For a given openedAt (ms), find the last bar that closed STRICTLY before that time.
function findBarAtEntry(emaSeries, openedAtMs) {
  let best = null;
  for (const row of emaSeries) {
    if (row.barTs < openedAtMs) best = row;
    else break; // series is sorted ascending
  }
  return best;
}

function classifyTrend(bar) {
  if (!bar) return 'UNCLEAR';
  const { close, ema20, ema50 } = bar;
  if (close > ema50 && ema20 > ema50) return 'UP';
  if (close < ema50 && ema20 < ema50) return 'DOWN';
  return 'UNCLEAR';
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  const refresh = req.query?.refresh === '1';

  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    // ── Cache check ───────────────────────────────────────────────────────────
    if (!refresh) {
      const cached = await r.get(CACHE_KEY).catch(() => null);
      const brief  = cached ? (typeof cached === 'string' ? safeParse(cached) : cached) : null;
      if (brief?.generatedAt && (Date.now() - brief.generatedAt) < CACHE_TTL_SEC * 1000) {
        return res.status(200).json({ ...brief, _fromCache: true });
      }
    }

    // ── 1. Load trades directly (same logic as perf-ranking, no HTTP call) ───
    const [recogRaw, ledgerRaw] = await Promise.all([
      getAllTrades(1000).catch(() => []),
      loadAllLedger(r).catch(() => []),
    ]);

    const recogFiltered  = recogRaw.filter(t => !t.deleted && !String(t.id || '').includes('legacy'));
    const ledgerFiltered = ledgerRaw.filter(t => !t._legacy);

    const recogMap  = new Map(recogFiltered.map(t => [t.id, t]));
    const ledgerMap = new Map(ledgerFiltered.map(t => [t.id, t]));
    const allIds    = new Set([...recogMap.keys(), ...ledgerMap.keys()]);

    const trades = [];
    for (const id of allIds) {
      const recog  = recogMap.get(id)  ?? null;
      const ledger = ledgerMap.get(id) ?? null;
      const merged = mergeRecord(ledger, recog);
      if (!merged.template || EXCL_TEMPLATES.has(merged.template)) continue;
      trades.push(merged);
    }

    if (!trades.length) {
      return res.status(200).json({ ok: true, trades: [], classifiedCount: 0, excludedCount: 0, byClass: {}, caveat: 'no trades found' });
    }

    // ── 2. Fetch 1d candles per unique asset ─────────────────────────────────
    const { fetchCandles } = require('./candle-source');
    const uniqueAssets = [...new Set(trades.map(t => (t.asset || '').toLowerCase()).filter(Boolean))];
    const emaSeriesByAsset = {};

    // Fetch in parallel; 300-bar limit paginates up to 6 pages via candle-source
    await Promise.all(uniqueAssets.map(async (assetId) => {
      try {
        const result = await fetchCandles(assetId, '1d', 300);
        if (result?.candles?.length) {
          emaSeriesByAsset[assetId] = buildEmaTimeSeries(result.candles);
        }
      } catch (_) {}
    }));

    // ── 3. Classify each trade ────────────────────────────────────────────────
    const classified = trades.map(t => {
      const assetId    = (t.asset || '').toLowerCase();
      const openedAtMs = t.openedAt ? new Date(t.openedAt).getTime() : null;

      if (t._source === 'recog') {
        return { ...t, htfTrend: null, trendClass: 'EXCLUDED', excludeReason: 'recog-only' };
      }
      if (!openedAtMs) {
        return { ...t, htfTrend: null, trendClass: 'EXCLUDED', excludeReason: 'no-openedAt' };
      }

      const emaSeries = emaSeriesByAsset[assetId];
      if (!emaSeries || emaSeries.length === 0) {
        return { ...t, htfTrend: null, trendClass: 'EXCLUDED', excludeReason: 'no-candle-cache' };
      }

      const barsBeforeEntry = emaSeries.filter(b => b.barTs < openedAtMs).length;
      if (barsBeforeEntry < EMA_MIN_BARS) {
        return { ...t, htfTrend: null, trendClass: 'EXCLUDED', excludeReason: `only-${barsBeforeEntry}-bars-before-entry` };
      }

      const bar      = findBarAtEntry(emaSeries, openedAtMs);
      const htfTrend = classifyTrend(bar);
      const dir      = t.direction;

      let trendClass = 'UNCLEAR';
      if (htfTrend === 'UP'   && dir === 'LONG')  trendClass = 'TREND';
      if (htfTrend === 'UP'   && dir === 'SHORT') trendClass = 'COUNTER';
      if (htfTrend === 'DOWN' && dir === 'SHORT') trendClass = 'TREND';
      if (htfTrend === 'DOWN' && dir === 'LONG')  trendClass = 'COUNTER';

      return { ...t, htfTrend, trendClass, excludeReason: null };
    });

    // ── 4. Aggregate ──────────────────────────────────────────────────────────
    const classifiedTrades = classified.filter(t => t.trendClass !== 'EXCLUDED');
    const excludedCount    = classified.length - classifiedTrades.length;

    const byClass = {};
    for (const cls of ['TREND', 'COUNTER', 'UNCLEAR']) {
      const grp  = classifiedTrades.filter(t => t.trendClass === cls);
      const n    = grp.length;
      const wins = grp.filter(t => t.outcome === 'WIN').length;
      const net  = grp.reduce((s, t) => s + (t.netPnl || 0), 0);
      byClass[cls] = {
        n,
        wins,
        losses:  n - wins,
        winRate: n > 0 ? Math.round(wins / n * 1000) / 1000 : null,
        netPnl:  Math.round(net * 100) / 100,
      };
    }

    const brief = {
      ok:              true,
      generatedAt:     Date.now(),
      rule:            'Daily 20/50 EMA: up=close>ema50 AND ema20>ema50; down=inverse; else unclear',
      minBarsRequired: EMA_MIN_BARS,
      total:           classified.length,
      classifiedCount: classifiedTrades.length,
      excludedCount,
      byClass,
      trades:          classified,
      caveat:          'htfTrend computed per-trade at openedAt from 1d candle cache — but watcher caches one batch and EMAs shift daily. Trend state is approximate for old trades if cache was repopulated after entry.',
    };

    await r.set(CACHE_KEY, JSON.stringify(brief), { ex: CACHE_TTL_SEC }).catch(() => {});

    return res.status(200).json(brief);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
