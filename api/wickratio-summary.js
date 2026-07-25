'use strict';
/* eslint-disable */
// api/wickratio-summary.js  v15.8
// GET /api/wickratio-summary
//
// Joins closed ledger trades with wick-ratio shadow records (via dedupeKey)
// and reports win-rate / net-PnL split by wick-ratio band.
//
// Bands: 0-0.25 (tight body), 0.25-0.5, 0.50-0.75, 0.75-1.0 (dominated by wick)
// Full-trust (BTC/ETH/XAUUSD/NAS/US500) vs FX split reported separately.
//
// n ≥ 8 gate on every cell — insufficient buckets are surfaced as { insufficient:true }.
// Shadow-only endpoint: cannot gate or alter live execution. Read-only.

const { applyCors, getRedis, safeParse } = require('./_lib');
const { WR_SHADOW_KEY, WR_SHADOW_INDEX_KEY } = require('./wickratio-shadow');

const LEDGER_INDEX_KEY = 'v14:ledger:index';
const LEDGER_TRADE_KEY = (id) => `v14:ledger:trade:${id}`;
const MIN_N = 8;

// Assets where CVD / footprint data is high-trust (non-FX)
const FULL_TRUST_ASSETS = new Set(['btcusd', 'btc', 'ethusd', 'eth', 'xauusd', 'gold', 'nas100', 'us500', 'spx500usd', 'ustec']);

function isFx(assetId) {
  return !FULL_TRUST_ASSETS.has((assetId || '').toLowerCase());
}

function wickBand(wr) {
  if (wr == null) return null;
  if (wr < 0.25)  return '0.00-0.25';
  if (wr < 0.50)  return '0.25-0.50';
  if (wr < 0.75)  return '0.50-0.75';
  return '0.75-1.00';
}

const BANDS = ['0.00-0.25', '0.25-0.50', '0.50-0.75', '0.75-1.00'];

async function loadAllLedger(r) {
  const raw = await r.get(LEDGER_INDEX_KEY).catch(() => null);
  const idx = safeParse(raw) || [];
  if (!idx.length) return [];
  try {
    const pipe = r.pipeline();
    for (const e of idx) pipe.get(LEDGER_TRADE_KEY(e.id));
    const res = await pipe.exec();
    return res.map(v => {
      const t = v ? (typeof v === 'string' ? safeParse(v) : v) : null;
      return (t && typeof t === 'object') ? t : null;
    }).filter(Boolean);
  } catch (_) {
    const out = [];
    for (const e of idx) {
      const v = safeParse(await r.get(LEDGER_TRADE_KEY(e.id)).catch(() => null));
      if (v) out.push(v);
    }
    return out;
  }
}

async function loadAllShadows(r) {
  const raw = await r.get(WR_SHADOW_INDEX_KEY).catch(() => null);
  const idx = safeParse(raw) || [];
  if (!idx.length) return [];
  try {
    const pipe = r.pipeline();
    for (const e of idx) pipe.get(WR_SHADOW_KEY(e.id));
    const res = await pipe.exec();
    return res.map(v => {
      const t = v ? (typeof v === 'string' ? safeParse(v) : v) : null;
      return (t && typeof t === 'object') ? t : null;
    }).filter(Boolean);
  } catch (_) {
    const out = [];
    for (const e of idx) {
      const v = safeParse(await r.get(WR_SHADOW_KEY(e.id)).catch(() => null));
      if (v) out.push(v);
    }
    return out;
  }
}

function stats(trades) {
  const n      = trades.length;
  if (!n) return { n: 0, wins: 0, losses: 0, winRate: null, netPnl: null, avgR: null };
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const netPnl = r2(trades.reduce((s, t) => s + (t.netPnl || 0), 0));
  const rList  = trades.filter(t => t.pnlR != null).map(t => t.pnlR);
  const avgR   = rList.length ? r2(rList.reduce((s, v) => s + v, 0) / rList.length) : null;
  return { n, wins: wins.length, losses: n - wins.length, winRate: r3(wins.length / n), netPnl, avgR };
}

function gated(st) {
  if (st.n < MIN_N) return { ...st, winRate: null, avgR: null, netPnl: null, insufficient: true };
  return st;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    const r = getRedis();
    if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

    const [ledger, shadows] = await Promise.all([
      loadAllLedger(r).catch(() => []),
      loadAllShadows(r).catch(() => []),
    ]);

    const shadowMap = new Map(shadows.map(s => [s.id, s]));
    const withBarData = shadows.filter(s => s.hasBarData).length;

    // Join closed ledger trades with their wick shadow
    const joined = ledger
      .filter(t => t.outcome && t.outcome !== 'OPEN')
      .map(t => {
        const wr = (t.dedupeKey ? shadowMap.get(t.dedupeKey) : null) || null;
        return {
          id:         t.id,
          template:   t.template   || 'unknown',
          assetId:    (t.asset || t.assetId || '').toLowerCase(),
          direction:  t.direction  || null,
          outcome:    t.outcome,
          netPnl:     t.netPnl     || 0,
          pnlR:       t.pnlR       || null,
          hasWr:      !!(wr && wr.hasBarData && wr.wickRatio != null),
          wickRatio:  wr?.hasBarData ? wr.wickRatio : null,
          band:       wr?.hasBarData ? wickBand(wr.wickRatio) : null,
          isFx:       isFx(t.asset || t.assetId || ''),
        };
      });

    const withWr   = joined.filter(t => t.hasWr);
    const coverage = joined.length > 0 ? withWr.length / joined.length : 0;

    // ── By band (all) ─────────────────────────────────────────────────────────
    const byBand = {};
    for (const band of BANDS) {
      byBand[band] = gated(stats(withWr.filter(t => t.band === band)));
    }

    // ── By band, full-trust only ──────────────────────────────────────────────
    const byBandFullTrust = {};
    for (const band of BANDS) {
      byBandFullTrust[band] = gated(stats(withWr.filter(t => t.band === band && !t.isFx)));
    }

    // ── By band, FX only ─────────────────────────────────────────────────────
    const byBandFx = {};
    for (const band of BANDS) {
      byBandFx[band] = gated(stats(withWr.filter(t => t.band === band && t.isFx)));
    }

    // ── Per-template ─────────────────────────────────────────────────────────
    const byTemplate = {};
    const tplKeys = [...new Set(withWr.map(t => t.template))].sort();
    for (const tpl of tplKeys) {
      const ts = withWr.filter(t => t.template === tpl);
      const tplBands = {};
      for (const band of BANDS) {
        tplBands[band] = gated(stats(ts.filter(t => t.band === band)));
      }
      byTemplate[tpl] = { all: gated(stats(ts)), byBand: tplBands };
    }

    return res.status(200).json({
      ok:          true,
      generatedAt: Date.now(),
      bands: BANDS,
      minN:  MIN_N,
      coverage: {
        totalClosed:    joined.length,
        withWrShadow:   withWr.length,
        totalShadows:   shadows.length,
        withBarData,
        coveragePct:    Math.round(coverage * 1000) / 10,
        note: withBarData === 0
          ? 'Pine scripts not yet updated — barOpen/barHigh/barLow/barClose not emitted; records accumulating with hasBarData=false'
          : coverage < 0.5
          ? 'low coverage — shadow accumulating (new trades only)'
          : 'ok',
      },
      byBand,
      byBandFullTrust,
      byBandFx,
      byTemplate,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

function r2(x) { return x == null || !isFinite(x) ? null : Math.round(x * 100) / 100; }
function r3(x) { return x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000; }
