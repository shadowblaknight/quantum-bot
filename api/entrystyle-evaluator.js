/* eslint-disable */
// V15.6 — api/entrystyle-evaluator.js
// Evaluates Immediate-vs-Retest shadow records after a 4h minimum age.
// Fetches 5m candles from MetaAPI for a 48h window and determines outcomes
// for both the immediate branch and the retest branch per signal.
// Called from cron.js — safe to fail without affecting live trading.

const { getRedis, safeParse } = require('./_lib');
const { resolveSymbol }       = require('./symbol-resolver');
const { ES_SHADOW_KEY, ES_SHADOW_INDEX_KEY, ES_SHADOW_TTL_SEC } = require('./entrystyle-shadow');

const METAAPI_REGION    = process.env.METAAPI_REGION || 'london';
const EVAL_MIN_AGE_MS   = 4  * 3600 * 1000;  // wait 4h before first evaluation pass
const EVAL_WINDOW_MS    = 48 * 3600 * 1000;  // 48h max candle scan window
const MAX_PER_TICK      = 20;                 // cap work per cron tick

// =================================================================
// CANDLE FETCH — targeted historical window
// =================================================================
// MetaAPI endpoint loads candles BACKWARD from startTime (batch ENDS at startTime).
// Set startTime = min(signalTs + 48h, now) + 1 bar nudge → batch covers the signal window.
// Returns ascending array of { time: ms, high, low } within the signal window.

async function fetchCandlesForEval(assetId, signalTs) {
  const token     = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  if (!token || !accountId) return [];

  let brokerSymbol;
  try { brokerSymbol = await resolveSymbol(assetId); } catch (_) {}
  if (!brokerSymbol) return [];

  const windowEndMs = Math.min(signalTs + EVAL_WINDOW_MS, Date.now());
  const startIso    = new Date(windowEndMs + 5 * 60 * 1000).toISOString(); // 1-bar nudge

  // 576 candles = 48h ÷ 5m
  const url = `https://mt-market-data-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai`
    + `/users/current/accounts/${accountId}`
    + `/historical-market-data/symbols/${encodeURIComponent(brokerSymbol)}`
    + `/timeframes/5m/candles`
    + `?startTime=${encodeURIComponent(startIso)}&limit=576`;

  try {
    const resp = await fetch(url, { headers: { 'auth-token': token, Accept: 'application/json' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    return data
      .map((c) => ({
        time: new Date(c.time).getTime(),
        high: parseFloat(c.high),
        low:  parseFloat(c.low),
      }))
      .filter((c) => c.time >= signalTs && c.time <= windowEndMs)
      .sort((a, b) => a.time - b.time);
  } catch (_) {
    return [];
  }
}

// =================================================================
// BRANCH SCANNERS
// =================================================================

// Returns { outcome, R } for the immediate branch.
// Same-bar SL+TP collision → SL wins (conservative).
function scanImmediateBranch(candles, sl, tp1, tp2, tp3, direction) {
  const isLong = direction === 'LONG';
  for (const c of candles) {
    const slHit = isLong ? c.low  <= sl  : c.high >= sl;
    const t3Hit = tp3 != null && (isLong ? c.high >= tp3 : c.low <= tp3);
    const t2Hit = tp2 != null && (isLong ? c.high >= tp2 : c.low <= tp2);
    const t1Hit =               (isLong ? c.high >= tp1 : c.low <= tp1);

    if (slHit) return { outcome: 'sl', R: -1 };  // SL wins same-bar collision
    if (t3Hit) return { outcome: 'tp3', R: 3 };
    if (t2Hit) return { outcome: 'tp2', R: 2 };
    if (t1Hit) return { outcome: 'tp1', R: 1 };
  }
  return { outcome: 'open', R: 0 };
}

// Returns { filled, outcome, R } for the retest branch.
// Phase 1: scan for fill (limit entry touched). Phase 2: scan from fill bar for TP/SL.
function scanRetestBranch(candles, retestEntry, sl, tp1, tp2, tp3, direction) {
  const isLong = direction === 'LONG';

  // Validate retestEntry is on the correct side of sl
  if (isLong  && retestEntry <= sl) return { filled: false, outcome: 'no_fill', R: 0 };
  if (!isLong && retestEntry >= sl) return { filled: false, outcome: 'no_fill', R: 0 };

  // Phase 1: find fill bar
  let fillIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const touched = isLong ? c.low <= retestEntry : c.high >= retestEntry;
    if (touched) { fillIdx = i; break; }
  }

  if (fillIdx === -1) return { filled: false, outcome: 'no_fill', R: 0 };

  // Phase 2: scan from fill bar onwards for TP/SL
  for (let i = fillIdx; i < candles.length; i++) {
    const c = candles[i];
    const slHit = isLong ? c.low  <= sl  : c.high >= sl;
    const t3Hit = tp3 != null && (isLong ? c.high >= tp3 : c.low <= tp3);
    const t2Hit = tp2 != null && (isLong ? c.high >= tp2 : c.low <= tp2);
    const t1Hit =               (isLong ? c.high >= tp1 : c.low <= tp1);

    if (slHit) return { filled: true, outcome: 'sl', R: -1 };
    if (t3Hit) return { filled: true, outcome: 'tp3', R: 3 };
    if (t2Hit) return { filled: true, outcome: 'tp2', R: 2 };
    if (t1Hit) return { filled: true, outcome: 'tp1', R: 1 };
  }
  return { filled: true, outcome: 'open', R: 0 };
}

// =================================================================
// MAIN EVALUATOR
// =================================================================

async function runEntryStyleEvaluator() {
  const r = getRedis();
  if (!r) return { skipped: 'no-redis' };

  const raw = await r.get(ES_SHADOW_INDEX_KEY).catch(() => null);
  const idx = safeParse(raw);
  if (!Array.isArray(idx) || idx.length === 0) return { skipped: 'empty-index' };

  const now = Date.now();
  let evaluated = 0, skippedRecent = 0, skippedNoData = 0, alreadyResolved = 0;

  for (const entry of idx) {
    if (evaluated >= MAX_PER_TICK) break;

    // Don't evaluate until at least EVAL_MIN_AGE_MS has passed
    if (now - entry.ts < EVAL_MIN_AGE_MS) { skippedRecent++; continue; }

    const key = ES_SHADOW_KEY(entry.id);
    const recRaw = await r.get(key).catch(() => null);
    const rec = safeParse(recRaw);
    if (!rec) continue;
    if (rec.resolvedAt != null) { alreadyResolved++; continue; }

    // Non-diverge records: mark resolved immediately with no-diverge outcome
    if (!rec.entryDiverge) {
      rec.immOutcome  = 'no-diverge';
      rec.immR        = null;
      rec.retFilled   = null;
      rec.retOutcome  = 'no-diverge';
      rec.retR        = null;
      rec.resolvedAt  = now;
      await r.set(key, JSON.stringify(rec), { ex: ES_SHADOW_TTL_SEC }).catch(() => {});
      evaluated++;
      continue;
    }

    // Fetch candles for the evaluation window
    const candles = await fetchCandlesForEval(rec.assetId, rec.ts);
    if (candles.length < 3) { skippedNoData++; continue; }

    // Check that we have covered enough of the window (at least 1h of candles)
    const latestCandleTime = candles[candles.length - 1].time;
    if (latestCandleTime - rec.ts < 3600 * 1000) { skippedNoData++; continue; }

    // Scan immediate branch
    const immResult = scanImmediateBranch(
      candles, rec.sl, rec.immTP1, rec.immTP2, rec.immTP3, rec.direction
    );
    rec.immOutcome = immResult.outcome;
    rec.immR       = immResult.R;

    // Scan retest branch
    const retResult = scanRetestBranch(
      candles, rec.retestEntry, rec.sl, rec.retTP1, rec.retTP2, rec.retTP3, rec.direction
    );
    rec.retFilled  = retResult.filled;
    rec.retOutcome = retResult.outcome;
    rec.retR       = retResult.R;

    rec.resolvedAt = now;
    await r.set(key, JSON.stringify(rec), { ex: ES_SHADOW_TTL_SEC }).catch(() => {});
    evaluated++;
  }

  return { evaluated, skippedRecent, skippedNoData, alreadyResolved, indexSize: idx.length };
}

module.exports = { runEntryStyleEvaluator };
