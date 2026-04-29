/* eslint-disable */
// V10 — api/ai.js
// AI decision engine. Full rewrite from V9. Key differences:
//   * 9-timeframe context (1m/5m/15m/30m/1h/4h/1d/1w/1mn) -- not just 3
//   * 3-layer memory injected in prompt header (short/mid/long)
//   * Family-based decisions (TREND/REVERSION/STRUCTURE/BREAKOUT/RANGE/NEWS)
//   * Bayesian Thompson sampling over family WR distributions
//   * Regime-aware: family choice gated by current regime
//   * Correlation cluster awareness
//
// Returns: { decision, family, rawTactic, confidence, volume, reason, regime, sampledWR, ... }

const {
  getRedis, applyCors, normSym, instCategory, safeParse,
  FAMILY_META, tacticFamily,
  betaMean, betaCI, betaSample,
  atr,
} = require('./_lib');

const { fetchMultiTF, fetchPositions } = require('./broker');
const { getRegimeFor } = require('./regime');
const { readMemory, buildPromptContext, appendDecision } = require('./memory');
const { readFamilyForSymbol } = require('./trades');
const { clusterFor } = require('./pair-intel');

const FAMILIES = ['TREND', 'REVERSION', 'STRUCTURE', 'BREAKOUT', 'RANGE', 'NEWS'];

// V10: Read cached backtest stats for a symbol -- used to detect overfit families
async function readBacktestStats(sym) {
  const r = getRedis(); if (!r) return {};
  const keys = [];
  let cursor = 0;
  try {
    do {
      const result = await r.scan(cursor, { match: 'v10:backtest:' + sym + ':*', count: 100 }).catch(() => [0, []]);
      cursor = parseInt(result[0], 10);
      keys.push(...result[1]);
    } while (cursor !== 0);
  } catch (_) {}
  const out = {};
  for (const k of keys) {
    const raw = await r.get(k).catch(() => null);
    const parsed = safeParse(raw);
    if (parsed && parsed.family && parsed.stats) {
      // Take most recent for each family
      if (!out[parsed.family] || (out[parsed.family].ts || 0) < (parsed.ts || 0)) {
        out[parsed.family] = parsed;
      }
    }
  }
  return out;
}

// Regime-family fitness — which families work in which regimes (from our research + literature)
const FAMILY_REGIME_FIT = {
  TREND:     { TRENDING: 1.0, RANGING: 0.2, VOLATILE: 0.6, QUIET: 0.4, MIXED: 0.5 },
  REVERSION: { TRENDING: 0.3, RANGING: 1.0, VOLATILE: 0.5, QUIET: 0.7, MIXED: 0.6 },
  STRUCTURE: { TRENDING: 0.8, RANGING: 0.7, VOLATILE: 0.6, QUIET: 0.5, MIXED: 0.7 },
  BREAKOUT:  { TRENDING: 0.7, RANGING: 0.4, VOLATILE: 0.9, QUIET: 0.8, MIXED: 0.5 },
  RANGE:     { TRENDING: 0.2, RANGING: 0.9, VOLATILE: 0.3, QUIET: 0.6, MIXED: 0.4 },
  NEWS:      { TRENDING: 0.5, RANGING: 0.5, VOLATILE: 0.7, QUIET: 0.3, MIXED: 0.5 },
};

// Compress candles into a compact text representation for AI prompt
function summarizeTF(tf, candles) {
  if (!candles || candles.length < 5) return tf + ': insufficient data';
  const c = candles.slice(-20); // last 20 for prompt
  const last = c[c.length - 1];
  const first = c[0];
  const high = Math.max(...c.map(x => x.high));
  const low = Math.min(...c.map(x => x.low));
  const move = ((last.close - first.close) / first.close) * 100;
  const range = ((high - low) / first.close) * 100;
  const _atr = atr(candles, 14) || 0;
  // Direction of last 5 candles
  const recent5 = candles.slice(-5);
  const upBars = recent5.filter(x => x.close > x.open).length;
  const dir = upBars >= 4 ? 'STRONG_UP' : upBars === 3 ? 'UP' : upBars === 2 ? 'DOWN' : upBars <= 1 ? 'STRONG_DOWN' : 'MIXED';

  // V10: Tick-volume z-score (current candle vol vs last 20 avg).
  // Strong divergence (|z| > 2) = institutional participation signal.
  let volTag = '';
  const volumes = candles.slice(-20).map(x => x.tickVolume || x.volume || 0).filter(v => v > 0);
  if (volumes.length >= 10) {
    const meanV = volumes.reduce((s, v) => s + v, 0) / volumes.length;
    const varV = volumes.reduce((s, v) => s + (v - meanV) ** 2, 0) / volumes.length;
    const stdV = Math.sqrt(varV);
    const lastV = last.tickVolume || last.volume || 0;
    if (lastV > 0 && stdV > 0) {
      const z = (lastV - meanV) / stdV;
      if (z >= 2.0)       volTag = ' vol=SPIKE+' + z.toFixed(1) + 'σ';
      else if (z >= 1.0)  volTag = ' vol=high+' + z.toFixed(1) + 'σ';
      else if (z <= -1.5) volTag = ' vol=THIN' + z.toFixed(1) + 'σ';
      else                volTag = ' vol=normal';
    }
  }

  return tf + ': move=' + move.toFixed(2) + '% range=' + range.toFixed(2) + '% ATR=' + _atr.toFixed(5) + ' last5=' + dir + volTag + ' last_close=' + last.close;
}

// Build the AI prompt.
function buildPrompt({ sym, multiTF, regime, chaos, memory, familyStats, backtestStats, openPositions, correlationCluster, sessionLabel }) {
  const memCtx = buildPromptContext(memory, sym);

  const tfLines = [];
  for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mn']) {
    tfLines.push('  ' + summarizeTF(tf, multiTF.timeframes[tf] || []));
  }

  // Family stats summary
  const famLines = [];
  for (const fam of FAMILIES) {
    const s = familyStats[fam];
    const bt = backtestStats[fam];
    let line;
    if (!s || s.total === 0) {
      line = '  ' + fam + ': untested live (Beta(1,1) = 50% prior, very wide CI)';
    } else {
      const fit = (FAMILY_REGIME_FIT[fam] && FAMILY_REGIME_FIT[fam][regime.regime]) || 0.5;
      line = '  ' + fam + ': ' + s.wins + 'W/' + s.losses + 'L · liveWR=' + s.winRate + '% · CI=[' + s.ci[0] + '-' + s.ci[1] + '%] · expectancy=$' + s.expectancy.toFixed(2) + ' · regime-fit=' + fit.toFixed(1);
    }
    // V10: Append backtest validation if available
    if (bt && bt.stats) {
      line += '\n      backtest(' + bt.start + '..' + bt.end + ', n=' + bt.stats.total + '): WR=' + bt.stats.winRate + '% PF=' + bt.stats.profitFactor + ' expectancy=' + bt.stats.expectancyR + 'R MaxDD=' + bt.stats.maxDrawdownR + 'R';
      // Overfit detection: live WR diverges from backtest WR by more than 15 percentage points
      if (s && s.total >= 10) {
        const divergence = Math.abs(s.winRate - bt.stats.winRate);
        if (divergence > 15) {
          line += '\n      ⚠ OVERFIT WARNING: live WR ' + s.winRate + '% diverges from backtest ' + bt.stats.winRate + '% by ' + divergence.toFixed(0) + 'pp -- treat live edge with caution';
        }
      }
    }
    famLines.push(line);
  }

  // Open positions summary
  const openLines = openPositions.length
    ? openPositions.map(p => '  ' + p.symbol + ': ' + p.direction + ' ' + p.volume + 'L @ ' + p.openPrice + ' (P&L $' + (p.profit || 0).toFixed(2) + ')').join('\n')
    : '  (none)';

  const chaosLine = chaos && chaos.chaos
    ? 'CHAOS DETECTED on ' + sym + ' (1m/1h ATR ratio ' + chaos.ratio + 'x). Strongly avoid new trades unless setup is overwhelming.'
    : 'No chaos signal.';

  const clusterLine = correlationCluster
    ? 'Correlation cluster: ' + correlationCluster + '. Check open positions in this cluster before adding.'
    : 'No correlation cluster.';

  return `You are the decision layer of an algorithmic trading system. Make ONE decision now.

=== CONTEXT ===
Symbol: ${sym}  ·  Category: ${instCategory(sym)}  ·  Session: ${sessionLabel}  ·  UTC: ${new Date().toISOString()}

${memCtx ? '=== YOUR MEMORY (continuous identity across calls) ===\n' + memCtx + '\n' : ''}
=== MARKET REGIME ===
Current regime: ${regime.regime} (score ${regime.score}/100)
Indicators: ADX=${(regime.indicators.h1Adx14 || 0).toFixed(1)} · ATR=${(regime.indicators.h1Atr14 || 0).toFixed(5)} · BB-width=${((regime.indicators.h1BBwidth || 0) * 100).toFixed(2)}% · MA-diff=${(regime.indicators.maDiff || 0).toFixed(2)} · H4 trend dir=${regime.indicators.h4TrendDir}
${chaosLine}
${clusterLine}

=== MULTI-TIMEFRAME VIEW ===
${tfLines.join('\n')}

=== FAMILY PERFORMANCE ON ${sym} (Bayesian) ===
${famLines.join('\n')}

=== CURRENT OPEN POSITIONS ===
${openLines}

=== INSTRUCTIONS ===
You are an active trading decision maker. Your job is to TRADE setups when conditions warrant — not to find reasons NOT to trade. The bot has many other safety layers (chaos detector, correlation cap, position-already-open check, family Bayesian floor). Your job is the entry decision.

1. **Family selection.** Choose TREND, REVERSION, STRUCTURE, BREAKOUT, RANGE, NEWS — or WAIT only if there is genuinely no actionable setup. Family must match regime: don't pick TREND in pure RANGING. STRUCTURE and BREAKOUT work in most regimes.

2. **Raw tactic.** Specific label (e.g. "TREND_H4+MOM_SESSION", "ICT_KILLZONE+SWEEP") for learning.

3. **Confidence scale.**
   - 30+ = take the trade (small size). The system will scale position size.
   - 50+ = standard size.
   - 65+ = full size.
   - 80+ = oversized.
   - Below 30 = WAIT.

   **Important:** A confidence of 45% does NOT mean "wait" — it means "take it small." Only output WAIT when conditions are genuinely confused, not just because confidence sits in the 35-50 range.

4. **Volume tags.** Treat as ONE supporting signal among many, not a veto.
   - SPIKE/high vol = nice confirmation, +5-10 confidence.
   - normal vol = expected, no adjustment.
   - THIN vol = mild caution, -5 confidence MAX. Asian-session and pre-news thin volume is normal — don't hard-reject.

5. **Multi-TF conflict.** Conflicting TFs are normal. Use this hierarchy:
   - **H1 + H4 alignment** = primary direction signal. If both agree, trade with them.
   - **15m/30m** = entry timing only. Conflict with H1 just means the setup hasn't materialized yet, not that the setup is invalid.
   - **D1/W** = backdrop. Disagreement with H1/H4 reduces confidence by ~5-10 but doesn't veto.

6. **Backtest divergence (overfit warning).**
   - Treat as soft signal, not a hard rule.
   - If live WR > backtest WR (live edge): -5 to -10 confidence (real edge but be modest).
   - If live WR < backtest WR significantly: -10 to -15 confidence (live underperforming).
   - Never let this alone push you to WAIT. The Bayesian sampler already handles uncertainty separately.

7. **Chaos veto.** If chaos flag is set: only trade with confidence 80+. Otherwise normal rules.

8. **Pip distances.** slPips and tp1Pips in instrument-native pips:
   - Forex: typical SL 15-40 pips, TP 30-100.
   - Gold (XAUUSD): typical SL 50-150 pips ($0.50-$1.50), TP 100-400 pips.
   - BTC: typical SL 200-600 pips, TP 500-1500.
   - Indices: typical SL 30-80 points, TP 60-200.

9. **Output JSON only:**
{
  "decision": "BUY" | "SELL" | "WAIT",
  "family": "TREND" | "REVERSION" | "STRUCTURE" | "BREAKOUT" | "RANGE" | "NEWS",
  "rawTactic": "string -- specific label",
  "confidence": 0-100,
  "reason": "concise multi-TF + regime reasoning, MAX 2 sentences",
  "tp1Pips": number,
  "slPips": number,
  "memo": "optional one-line note for next AI call to remember"
}

DO NOT include anything before or after the JSON.`;
}

// Volume sizing tiers (V9 compatible)
function sizingFor(confidence, riskMode, category) {
  const baseFx     = riskMode === 'AGGRESSIVE' ? 0.50 : riskMode === 'REGULAR' ? 0.20 : 0.05;
  const baseGold   = riskMode === 'AGGRESSIVE' ? 0.20 : riskMode === 'REGULAR' ? 0.10 : 0.02;
  const baseCrypto = riskMode === 'AGGRESSIVE' ? 0.10 : riskMode === 'REGULAR' ? 0.05 : 0.01;
  const baseIndex  = riskMode === 'AGGRESSIVE' ? 1.00 : riskMode === 'REGULAR' ? 0.50 : 0.10;
  const base = category === 'GOLD' || category === 'METAL' ? baseGold
             : category === 'CRYPTO' ? baseCrypto
             : category === 'INDEX'  ? baseIndex
             : baseFx;
  // V10: tiers re-aligned with prompt thresholds
  if (confidence >= 85) return base;             // oversized
  if (confidence >= 70) return base * 0.8;       // full
  if (confidence >= 55) return base * 0.5;       // standard
  if (confidence >= 40) return base * 0.3;       // small
  if (confidence >= 30) return base * 0.15;      // micro
  return 0;
}

function getSessionLabel() {
  const h = new Date().getUTCHours();
  if (h >= 13 && h < 16) return 'OVERLAP';
  if (h >= 13 && h < 18) return 'NEW_YORK';
  if (h >= 8  && h < 16) return 'LONDON';
  return 'ASIAN';
}

// Call Anthropic API
async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not set' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { error: 'Anthropic ' + r.status + ': ' + txt.slice(0, 300) };
    }
    const data = await r.json();
    const text = (data.content || []).map(c => c.text || '').join('');
    return { text, usage: data.usage };
  } catch (e) {
    return { error: e && e.message ? e.message : 'unknown' };
  }
}

// Parse AI response (strip markdown fences if any)
function parseDecision(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.trim();
  // strip ```json ... ``` fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  // find first { and last }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) { return null; }
}

// Apply Bayesian sampling adjustment to AI confidence
function adjustConfidenceWithBayes(aiConfidence, family, familyStats, regime) {
  const stats = familyStats[family];
  if (!stats || stats.total < 3) return aiConfidence; // not enough data
  const sampledWR = betaSample(stats.wins, stats.losses) * 100;
  const fit = (FAMILY_REGIME_FIT[family] && FAMILY_REGIME_FIT[family][regime.regime]) || 0.5;
  const fitAdj = (fit - 0.5) * 30; // -15 to +15
  // Blend: 60% AI confidence, 30% sampled WR, 10% regime fit
  const blended = aiConfidence * 0.6 + sampledWR * 0.3 + (50 + fitAdj) * 0.1;
  return Math.round(Math.max(0, Math.min(100, blended)));
}

// === HTTP handler ===
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  if (!body || !body.symbol) return res.status(400).json({ error: 'symbol required in body' });

  const sym = normSym(body.symbol);
  const riskMode = body.riskMode || 'TEST';

  try {
    // 1. Fetch all the context in parallel
    const [multiTF, regime, memory, familyStats, positionsResp, backtestStats] = await Promise.all([
      fetchMultiTF(sym),
      getRegimeFor(sym),
      readMemory(),
      readFamilyForSymbol(sym),
      fetchPositions(),
      readBacktestStats(sym),
    ]);
    const openPositions = positionsResp.positions || [];

    // Skip if already open on this symbol
    const alreadyOpen = openPositions.some(p => normSym(p.symbol) === sym);
    if (alreadyOpen) {
      return res.status(200).json({
        decision: 'WAIT',
        reason: 'Position already open on ' + sym,
        skipReason: 'already-open',
      });
    }

    // 2. Correlation cluster check
    const myCluster = clusterFor(sym);
    if (myCluster) {
      const clusterMembers = openPositions.map(p => clusterFor(p.symbol)).filter(Boolean);
      if (clusterMembers.includes(myCluster)) {
        return res.status(200).json({
          decision: 'WAIT',
          reason: 'Correlation cluster ' + myCluster + ' already has an open position',
          skipReason: 'correlation-cluster',
        });
      }
    }

    // 3. Build prompt + call Claude
    const sessionLabel = getSessionLabel();
    const prompt = buildPrompt({
      sym, multiTF, regime, chaos: regime.chaos, memory, familyStats, backtestStats,
      openPositions, correlationCluster: myCluster, sessionLabel,
    });

    const claudeResp = await callClaude(prompt);
    if (claudeResp.error) {
      return res.status(200).json({ decision: 'WAIT', reason: 'AI error: ' + claudeResp.error, error: claudeResp.error });
    }
    const decision = parseDecision(claudeResp.text);
    if (!decision || !decision.decision) {
      return res.status(200).json({ decision: 'WAIT', reason: 'AI did not return parseable decision', raw: (claudeResp.text || '').slice(0, 300) });
    }

    // 4. Validate + adjust confidence with Bayesian sampling
    if (!FAMILIES.includes(decision.family)) decision.family = tacticFamily(decision.rawTactic || '');
    const adjustedConf = adjustConfidenceWithBayes(decision.confidence || 0, decision.family, familyStats, regime);
    decision.aiRawConfidence = decision.confidence;
    decision.confidence = adjustedConf;

    // Chaos veto
    if (regime.chaos && regime.chaos.chaos && decision.confidence < 80) {
      decision.decision = 'WAIT';
      decision.reason = 'Chaos detected (ratio ' + regime.chaos.ratio + 'x); confidence ' + decision.confidence + ' < 80 chaos threshold';
    }

    // Below-min veto (matches prompt instruction #3)
    if (decision.confidence < 30) {
      decision.decision = 'WAIT';
    }

    // 5. Volume sizing
    const cat = instCategory(sym);
    const volume = decision.decision === 'WAIT' ? null : sizingFor(decision.confidence, riskMode, cat);
    decision.volume = volume;
    decision.regime = regime.regime;
    decision.regimeScore = regime.score;
    decision.symbol = sym;
    decision.session = sessionLabel;

    // 6. Append to memory
    await appendDecision({
      sym,
      decision: decision.decision,
      family: decision.family,
      conf: decision.confidence,
      regime: regime.regime,
      reason: decision.reason,
    }).catch(() => {});

    return res.status(200).json(decision);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'Unknown', decision: 'WAIT' });
  }
};

module.exports.callClaude    = callClaude;
module.exports.parseDecision = parseDecision;
module.exports.buildPrompt   = buildPrompt;
module.exports.FAMILIES      = FAMILIES;
module.exports.FAMILY_REGIME_FIT = FAMILY_REGIME_FIT;