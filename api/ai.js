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
// V11 step 2: setup detector + observation memory
const { readSetupsFor }                    = require('./setup-detector');
const { readObservations, writeObservations } = require('./observation-memory');
// V11 step 3: pattern learner output (refreshed end-of-day)
const { readPatternsForAI }                = require('./pattern-learner');
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
function buildPrompt({ sym, multiTF, regime, chaos, memory, familyStats, backtestStats, openPositions, correlationCluster, sessionLabel, setups, observations, patterns }) {
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
    ? 'CHAOS DETECTED on ' + sym + ' (1m/1h ATR ratio ' + chaos.ratio + 'x). Volatility is unusually concentrated -- consider in your sizing.'
    : 'No chaos signal.';

  const clusterLine = correlationCluster
    ? 'Correlation cluster: ' + correlationCluster + '. Check open positions in this cluster before adding.'
    : 'No correlation cluster.';

  // V11 STEP 2: Active setups (mechanical pattern detector)
  let setupsBlock = '';
  if (Array.isArray(setups) && setups.length > 0) {
    const lines = setups.map(s =>
      '  • ' + s.pattern + ' ' + s.direction + ' (quality ' + (s.quality * 100).toFixed(0) + '%) @ ' + s.level.toFixed(5) +
      '\n    invalidates if price ' + (s.direction === 'LONG' ? '<' : '>') + ' ' + s.invalidatesAt.toFixed(5) +
      '\n    evidence: ' + (s.evidence || []).join('; ')
    );
    setupsBlock = '\n=== ACTIVE SETUPS DETECTED (V11) ===\n' + lines.join('\n') +
                  '\nTreat these as mechanically-detected patterns. Quality is detector confidence (0-100%), not your trading confidence.\n';
  } else {
    setupsBlock = '\n=== ACTIVE SETUPS DETECTED (V11) ===\n  (none currently — no liquidity sweep, range break, session drive, news momentum, or confluence detected)\n';
  }

  // V11 STEP 2: Your past observations on this instrument
  let obsBlock = '';
  if (Array.isArray(observations) && observations.length > 0) {
    const lines = observations.map(o => {
      let line = '  • [' + o.id + '] ' + o.text;
      if (o.direction && o.direction !== 'NEUTRAL') line += ' (lean: ' + o.direction + ')';
      if (o.watchLevel != null) line += ' watchLevel=' + o.watchLevel;
      if (o.invalidatesAt != null) line += ' invalidates@' + o.invalidatesAt;
      const ageMin = Math.floor((Date.now() - o.createdAt) / 60000);
      line += ' (age: ' + ageMin + 'min)';
      return line;
    });
    obsBlock = '\n=== YOUR ACTIVE OBSERVATIONS ON ' + sym + ' (continuous study) ===\n' + lines.join('\n') +
               '\nThese are notes you wrote in previous calls. You can refresh them (keep watching), let them expire (silence = expire in ' + Math.floor(4) + 'h), or invalidate them (price broke level).\n';
  }

  // V11 STEP 3: Pattern learner output (refreshed end-of-day from your own closed trades)
  let patternsBlock = '';
  if (patterns && patterns.totalTrades > 0) {
    const symU = normSym(sym);
    // Tight patterns matching this symbol (PRIORITIZE)
    const tightForSym = (patterns.tight || []).filter(p => p.signature.startsWith(symU + '/'));
    const avoidForSym = (patterns.avoid || []).filter(p => p.signature.startsWith(symU + '/'));
    // Loose patterns matching this symbol
    const looseForSym = (patterns.loose || []).filter(p => p.symbol === symU);

    if (tightForSym.length > 0 || avoidForSym.length > 0 || looseForSym.length > 0) {
      let lines = [];
      lines.push('  Based on ' + patterns.totalTrades + ' closed trades over ' + patterns.daysBack + ' days (overall WR ' + patterns.overallWR + '%):');
      if (tightForSym.length > 0) {
        lines.push('  ✓ PRIORITIZE these signatures (proven winning combos):');
        for (const p of tightForSym.slice(0, 5)) {
          lines.push('    • ' + p.signature.replace(symU + '/', '') + ' — ' + p.wins + '/' + p.n + ' wins (' + p.wr + '% WR, expR=' + p.expectancyR + ')');
        }
      }
      if (avoidForSym.length > 0) {
        lines.push('  ✗ AVOID these signatures (consistently losing):');
        for (const p of avoidForSym.slice(0, 5)) {
          lines.push('    • ' + p.signature.replace(symU + '/', '') + ' — ' + p.wins + '/' + p.n + ' wins (' + p.wr + '% WR, expR=' + p.expectancyR + ')');
        }
      }
      if (looseForSym.length > 0) {
        lines.push('  ⚙ Single-dimension trends:');
        for (const p of looseForSym.slice(0, 4)) {
          lines.push('    • ' + p.dimension + ': ' + p.recommendation);
        }
      }
      patternsBlock = '\n=== LEARNED PATTERNS FROM YOUR PRIOR TRADES ===\n' + lines.join('\n') +
                     '\n  Use these as priors. A signature matching PRIORITIZE = +5-10 confidence. Matching AVOID = -10-15 confidence (or pick a different family).\n';
    } else {
      patternsBlock = '\n=== LEARNED PATTERNS FROM YOUR PRIOR TRADES ===\n  No patterns matching ' + symU + ' yet. Need ≥6 trades with same (family/mode/session/regime/aligned) signature for tight patterns, ≥10 trades total on symbol for loose patterns.\n  Total trades on all symbols: ' + patterns.totalTrades + '.\n';
    }
  }

  return `You are the decision layer of an algorithmic trading system. Make ONE decision now.

=== CONTEXT ===
Symbol: ${sym}  ·  Category: ${instCategory(sym)}  ·  Session: ${sessionLabel}  ·  UTC: ${new Date().toISOString()}

${memCtx ? '=== YOUR MEMORY (continuous identity across calls) ===\n' + memCtx + '\n' : ''}
=== MARKET REGIME ===
Current regime: ${regime.regime} (score ${regime.score}/100)
Indicators: ADX=${((regime.indicators && regime.indicators.h1Adx14) || 0).toFixed(1)} · ATR=${((regime.indicators && regime.indicators.h1Atr14) || 0).toFixed(5)} · BB-width=${(((regime.indicators && regime.indicators.h1BBwidth) || 0) * 100).toFixed(2)}% · MA-diff=${((regime.indicators && regime.indicators.maDiff) || 0).toFixed(2)} · H4 trend dir=${(regime.indicators && regime.indicators.h4TrendDir) || 0}
${chaosLine}
${clusterLine}
${setupsBlock}${obsBlock}${patternsBlock}
=== MULTI-TIMEFRAME VIEW ===
${tfLines.join('\n')}

=== FAMILY PERFORMANCE ON ${sym} (Bayesian) ===
${famLines.join('\n')}

=== CURRENT OPEN POSITIONS ===
${openLines}

=== INSTRUCTIONS ===
You are an active trading decision maker. Your job is to TRADE setups when conditions warrant — not to find reasons NOT to trade.

**V11 — IMPORTANT: There are NO hard gates downstream of you.** The system will execute whatever you decide. Chaos info, correlation cluster, regime — all are informational signals you weigh in your decision. The only hard check is "position already open on this symbol" (broker enforces). So your decision really matters: there is no second layer that catches a bad trade for you.

**ANTI-PATTERN TO AVOID:** If your memory shows several consecutive WAIT decisions on this symbol, do NOT treat that as evidence to wait again. Each decision must be made fresh on the current chart. A streak of WAITs is a hint that you may be over-cautious, not that the next answer should also be WAIT.

1. **Family selection.** Choose TREND, REVERSION, STRUCTURE, BREAKOUT, RANGE, NEWS — or WAIT only if there is genuinely no actionable setup. Family must match regime: don't pick TREND in pure RANGING. STRUCTURE and BREAKOUT work in most regimes.

2. **Raw tactic.** Specific label (e.g. "TREND_H4+MOM_SESSION", "ICT_KILLZONE+SWEEP") for learning.

3. **Confidence scale.**
   - 85+ = oversized full position (very high conviction, rare).
   - 70+ = full size.
   - 55+ = standard size.
   - 40+ = small size.
   - 25+ = micro size (you're committing but acknowledging uncertainty).
   - Below 25 = nano size if you still want to enter (you're testing a marginal idea).

   **No hard floor.** If you decide BUY or SELL, the system will size accordingly. Output WAIT only when there is genuinely no actionable read — not because confidence is "low." A confidence of 35 with a clear setup is better than WAIT.

4. **Volume tags.** Treat as ONE supporting signal among many, not a veto.
   - SPIKE/high vol = nice confirmation, +5-10 confidence.
   - normal vol = expected, no adjustment.
   - THIN vol = mild caution, -5 confidence MAX. Asian-session and pre-news thin volume is normal — don't hard-reject.

5. **Multi-TF reading — KEY RULE.**
   - **H1 + H4 alignment is the primary signal.** If H1 trend and H4 trend BOTH point the same direction (both up or both down), the setup IS valid — TAKE THE TRADE. Confidence floor 50 in this case unless something is clearly broken (chaos, regime mismatch, news).
   - 1m/5m moving against H1+H4 is just noise/pullback — that's actually a BETTER entry, not a reason to wait.
   - 15m/30m matter for entry timing; if they align with H1+H4 too, confidence 60+. If they conflict, you're catching a pullback — still trade, conf 50-55.
   - D1/W: backdrop only. Disagreement reduces confidence by ~5-10 but doesn't veto.
   - **Only output WAIT if H1 and H4 themselves disagree.** That's the genuine "messy chart" condition.

6. **Backtest divergence (overfit warning).**
   - Treat as soft signal, not a hard rule.
   - If live WR > backtest WR (live edge): -5 to -10 confidence (real edge but be modest).
   - If live WR < backtest WR significantly: -10 to -15 confidence (live underperforming).
   - Never let this alone push you to WAIT. The Bayesian sampler already handles uncertainty separately.

7. **Chaos signal.** If chaos flag is set, conditions are unusually volatile (news spike, flash event). Consider this when sizing — chaos is a context flag, not a hard veto. You can still trade through chaos if the setup is strong enough. Reduce confidence by 10-15 in chaos unless the setup specifically benefits from it (e.g. news momentum trade).

8. **Trading mode (required).** You must specify ONE of:
   - **SCALP**: quick reversal, 1-1.5R targets, hold ~minutes-1h. Use when the setup is a reactive bounce or fade with tight risk.
   - **DAY**: intraday swing, 1-4R targets, hold ~1-8h. **Default for most setups.** Use when H1+H4 align and you expect a trending move during the active session.
   - **SWING**: multi-day, 1.5-8R targets, hold ~1-3 days. Use only when D1/W structure supports it AND H4 is clearly aligned. Rare — most setups are DAY mode.

9. **slPips (required).** SL distance in instrument-native pips. Suggested 1R defaults:
   - Forex non-JPY: SCALP 12, DAY 25, SWING 50
   - JPY pairs: SCALP 15, DAY 30, SWING 60
   - Gold: SCALP 150, DAY 400, SWING 1000 (in $0.01 pips, so DAY 400 = $4)
   - BTC: SCALP 300, DAY 800, SWING 2000 ($)
   - Indices: SCALP 25, DAY 60, SWING 150 (points)
   You can scale by 1.5x for high-volatility conditions or 0.7x for tight ranges. The TP ladder is auto-built from SL distance + mode — don't compute TPs yourself.

11. **Observations (V11 — your continuous study).**
    Beyond the immediate trade decision, you can leave OBSERVATIONS for your future calls. These are notes you write to yourself that persist across cron ticks. Useful when the chart is "almost ready" but no trade yet.

    Examples of good observations:
    - { id: "EURUSD-asia-low", text: "Watching for sweep of Asia low at 1.1690. If sweep + reversal candle on H1, short setup.", direction: "SHORT", watchLevel: 1.1690, invalidatesAt: 1.1720, refreshHours: 4 }
    - { id: "XAUUSD-range", text: "Gold consolidating 4585-4605 since London open. Break either side with volume = trade.", direction: "NEUTRAL", refreshHours: 4 }
    - { id: "BTC-FOMC-fade", text: "BTC dumped 2% post-FOMC. Watching for institutional fade if M5 reverses near 76800.", direction: "LONG", watchLevel: 76800, invalidatesAt: 75500, refreshHours: 2 }

    Rules:
    - Write 0-3 observations per call. Empty array if you have nothing meaningful.
    - Use stable IDs (e.g. "EURUSD-asia-low") so future calls can refresh the same observation rather than duplicating it.
    - If a previous observation is still valid, repeat it with the SAME id to refresh it. If you don't include it, it expires after refreshHours.
    - If a previous observation should be invalidated NOW (you saw the level break), add a new obs with the same id and { text: "INVALIDATED: <reason>", direction: "NEUTRAL", refreshHours: 0 }.

12. **Output JSON only:**
{
  "decision": "BUY" | "SELL" | "WAIT",
  "mode": "SCALP" | "DAY" | "SWING",
  "family": "TREND" | "REVERSION" | "STRUCTURE" | "BREAKOUT" | "RANGE" | "NEWS",
  "rawTactic": "string -- specific label",
  "confidence": 0-100,
  "reason": "concise multi-TF + regime reasoning, MAX 2 sentences",
  "slPips": number,
  "memo": "optional one-line note for next AI call to remember",
  "observations": [
    { "id": "...", "text": "...", "direction": "LONG|SHORT|NEUTRAL", "watchLevel": number?, "invalidatesAt": number?, "refreshHours": number? }
  ]
}

DO NOT include anything before or after the JSON.`;
}

// Volume sizing tiers (V9 compatible)
// V11 sizing: smooth scale, no hard cutoff. AI decided BUY/SELL — we honor it at any
// confidence. Below 30 = nano position (5% of base). Up to 85+ = full base.
function sizingFor(confidence, riskMode, category) {
  const baseFx     = riskMode === 'AGGRESSIVE' ? 0.50 : riskMode === 'REGULAR' ? 0.20 : 0.05;
  const baseGold   = riskMode === 'AGGRESSIVE' ? 0.20 : riskMode === 'REGULAR' ? 0.10 : 0.02;
  const baseCrypto = riskMode === 'AGGRESSIVE' ? 0.10 : riskMode === 'REGULAR' ? 0.05 : 0.01;
  const baseIndex  = riskMode === 'AGGRESSIVE' ? 1.00 : riskMode === 'REGULAR' ? 0.50 : 0.10;
  const base = category === 'GOLD' || category === 'METAL' ? baseGold
             : category === 'CRYPTO' ? baseCrypto
             : category === 'INDEX'  ? baseIndex
             : baseFx;
  if (confidence >= 85) return base;             // oversized / full
  if (confidence >= 70) return base * 0.8;       // full
  if (confidence >= 55) return base * 0.5;       // standard
  if (confidence >= 40) return base * 0.3;       // small
  if (confidence >= 25) return base * 0.15;      // micro
  return base * 0.05;                            // nano (AI is committing despite low conf)
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
    // 1. Fetch all the context in parallel (including V11 setups + observations + patterns)
    const [multiTF, regime, memory, familyStats, positionsResp, backtestStats, setups, observations, patterns] = await Promise.all([
      fetchMultiTF(sym),
      getRegimeFor(sym),
      readMemory(),
      readFamilyForSymbol(sym),
      fetchPositions(),
      readBacktestStats(sym),
      readSetupsFor(sym),
      readObservations(sym),
      readPatternsForAI(),
    ]);
    const openPositions = positionsResp.positions || [];

    // V11: Only ONE hard check remains — already-open on same symbol. Broker enforces this
    // anyway, so we skip the AI call to avoid wasted tokens. Everything else (cluster,
    // chaos, confidence) is now AI-informed soft signal, not hard gate.
    const alreadyOpen = openPositions.some(p => normSym(p.symbol) === sym);
    if (alreadyOpen) {
      return res.status(200).json({
        decision: 'WAIT',
        reason: 'Position already open on ' + sym,
        skipReason: 'already-open',
      });
    }

    // V11: Cluster info is passed to AI as context, but no hard veto.
    const myCluster = clusterFor(sym);

    // 3. Build prompt + call Claude
    const sessionLabel = getSessionLabel();
    const prompt = buildPrompt({
      sym, multiTF, regime, chaos: regime.chaos, memory, familyStats, backtestStats,
      openPositions, correlationCluster: myCluster, sessionLabel,
      setups, observations, patterns,
    });

    const claudeResp = await callClaude(prompt);
    if (claudeResp.error) {
      return res.status(200).json({ decision: 'WAIT', reason: 'AI error: ' + claudeResp.error, error: claudeResp.error });
    }
    const decision = parseDecision(claudeResp.text);
    if (!decision || !decision.decision) {
      return res.status(200).json({ decision: 'WAIT', reason: 'AI did not return parseable decision', raw: (claudeResp.text || '').slice(0, 300) });
    }

    // V11 STEP 2: Persist any observations the AI wrote in this call.
    if (Array.isArray(decision.observations) && decision.observations.length > 0) {
      try {
        const result = await writeObservations(sym, decision.observations);
        decision.observationsWritten = result.written;
      } catch (e) { console.warn('[AI] observations write: ' + e.message); }
    }

    // 4. Validate family + adjust confidence with Bayesian sampling.
    // V11: Bayesian adjustment is INFORMATIONAL only -- we record both raw and adjusted
    // confidence but DON'T use the adjusted one to override AI's BUY/SELL decision.
    if (!FAMILIES.includes(decision.family)) decision.family = tacticFamily(decision.rawTactic || '');
    const adjustedConf = adjustConfidenceWithBayes(decision.confidence || 0, decision.family, familyStats, regime);
    decision.aiRawConfidence = decision.confidence;
    decision.bayesianConfidence = adjustedConf;
    // We keep AI's raw confidence as the canonical value (used for sizing).
    // Bayesian shows up in logs but doesn't change the trade.

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