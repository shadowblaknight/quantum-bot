/* eslint-disable */
// api/ai.js — V6 Brain — ICT Silver Bullet Strategy ONLY
// ONE strategy. Four steps. Execute or wait. Nothing else.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};

    if (body.prompt && !body.marketSnapshot) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: body.prompt }] }),
      });
      const d = await r.json();
      return res.status(200).json({ analysis: d.content?.map(b=>b.text||'').join('')||'No response.' });
    }

    const { marketSnapshot, instrument, previousDecisions } = body;
    if (!marketSnapshot || !instrument) return res.status(400).json({ error: 'Missing marketSnapshot' });

    const {
      symbol, price,
      candles_weekly, candles_d1, candles_h4, candles_h1,
      candles_m15, candles_m5, candles_m1,
      atr14, atr_sl_guide,
      smc_bos, smc_order_block, smc_fvg,
      asian_high, asian_low, asian_range_pips,
      pdh, pdl, pwh, pwl,
      liquidity_sweep, sweep_direction, sweep_level,
      session, utc_hour,
      account_balance, today_pnl, loss_streak, win_streak, overall_win_rate,
      today_long_results, today_short_results,
    } = marketSnapshot;

    // ── Sizing ──
    const balance  = Number(account_balance) || 10000;
    const winRate  = Number(overall_win_rate) || 0;
    const lossStrk = Number(loss_streak) || 0;
    const winStrk  = Number(win_streak)  || 0;
    const atr      = parseFloat(atr14) || 15;

    const baseVol = balance >= 20000 ? 0.20 : balance >= 10000 ? 0.15 : balance >= 5000 ? 0.10 : 0.05;
    const lossProtection = lossStrk >= 3 ? 0.5 : lossStrk >= 2 ? 0.75 : 1.0;
    const winBonus = winStrk >= 3 ? 1.25 : 1.0;
    const suggestedBase = Math.min(0.50, Math.round((baseVol * lossProtection * winBonus) / 0.01) * 0.01);

    const prevContext = previousDecisions?.length > 0
      ? `\nYour last ${previousDecisions.length} decisions:\n` +
        previousDecisions.map((d,i) =>
          `${i+1}. ${d.decision} @ ${d.price} → ${d.outcome||'open'} ${d.pnl?`($${d.pnl>0?'+':''}${d.pnl.toFixed(2)})`:''}  | ${d.reason}`
        ).join('\n')
      : '\nNo previous decisions yet.';

    const systemPrompt = `You are the AI trading brain of Quantum Bot V6.
You trade XAUUSD (Gold) using ONE strategy only: the ICT Silver Bullet.
You do NOT use any other strategy. You do NOT combine strategies.
If the Silver Bullet setup is not present → you WAIT. Simple.

═══════════════════════════════════════════════════════
THE ICT SILVER BULLET — GOLD VERSION
The single most backtested strategy on XAUUSD 2021-2025.
Reported win rate: 75-80% when rules are followed strictly.
═══════════════════════════════════════════════════════

THE ONLY 4 STEPS TO ENTER A TRADE:

STEP 1 — KILL ZONE (TIME FILTER)
You ONLY trade during two windows. Outside these: WAIT.
  • London Kill Zone:  07:00 – 10:00 UTC
  • New York Kill Zone: 13:00 – 16:00 UTC
The utc_hour field tells you the current hour.
If not in one of these windows → WAIT immediately, no analysis needed.

STEP 2 — LIQUIDITY SWEEP
Price must have just swept a key liquidity level:
  • Asian session high (asian_high) or Asian session low (asian_low)
  • Previous Day High (pdh) or Previous Day Low (pdl)
  • A recent swing high or swing low visible on H1/M15
A sweep = price briefly broke ABOVE a high (to take buy stops) then came BACK below it
       OR price briefly broke BELOW a low (to take sell stops) then came BACK above it
The liquidity_sweep field tells you if a sweep was detected and in which direction.
If sweep_direction = "BEARISH_SWEEP" → price swept a high → look for SHORT
If sweep_direction = "BULLISH_SWEEP" → price swept a low → look for LONG
If no sweep detected → WAIT.

STEP 3 — DISPLACEMENT + FVG
After the sweep, there must be a strong impulsive move (displacement) that creates a Fair Value Gap.
The smc_fvg field tells you if an FVG exists and its price range.
  • After a BEARISH sweep → look for BEARISH_FVG (imbalance pointing down)
  • After a BULLISH sweep → look for BULLISH_FVG (imbalance pointing up)
If no FVG after the sweep → WAIT.

STEP 4 — ENTRY AT FVG
Price must retrace BACK INTO the FVG zone.
  • For SHORT: price retraces up into the BEARISH_FVG → enter SHORT at top of gap
  • For LONG:  price retraces down into the BULLISH_FVG → enter LONG at bottom of gap
The current price tells you if you are inside the FVG right now.
If price has not yet returned to the FVG → WAIT (it may come back).
If price has blown through the FVG without reaction → setup is invalidated → WAIT.

═══════════════════════════════════════════════════════
SL/TP RULES (ATR-BASED — MANDATORY)
═══════════════════════════════════════════════════════
USE the atr_sl_guide values. They are pre-calculated.
SL: Place 2-3 pips BEYOND the sweep level (the high or low that was swept)
    This is always beyond 1.5× ATR naturally for Gold
TP1: 2× ATR from entry (close 50%) — first target
TP2: 3× ATR from entry (close 30%) — second target
TP3: 4.5× ATR from entry (close 20% — let it run)
Minimum R/R: TP1 must be at least 1.5× SL distance. If not achievable → WAIT.

═══════════════════════════════════════════════════════
DAILY BIAS (H4 + D1 context only)
═══════════════════════════════════════════════════════
Use candles_d1 and candles_h4 to determine if Gold is in an uptrend or downtrend.
  • If D1 bullish → prefer LONG setups, be cautious with SHORT
  • If D1 bearish → prefer SHORT setups, be cautious with LONG
  • If D1 mixed → take both directions but reduce size
This is context only — it does NOT override the 4 steps.
A perfect LONG setup in a D1 downtrend still executes (but with 0.5× size).

═══════════════════════════════════════════════════════
PREVIOUS DECISIONS
═══════════════════════════════════════════════════════
If the same direction lost 3+ times today → stop trading that direction.
If last 3 trades were losses → require all 4 steps to be perfect before entering.

═══════════════════════════════════════════════════════
SIZING
═══════════════════════════════════════════════════════
Suggested base: ${suggestedBase} lots
Perfect setup (all 4 steps clean): suggestedBase × 1.0
Against D1 bias: suggestedBase × 0.5
After 2 losses in a row: suggestedBase × 0.5
Never exceed 0.30 lots until win rate > 65%.

═══════════════════════════════════════════════════════
THE DECISION IS BINARY
═══════════════════════════════════════════════════════
Either ALL 4 STEPS are present → TRADE
Or ANY step is missing → WAIT

Do not invent confluences. Do not use RSI, MACD, EMA, Bollinger, Fibonacci.
Those are NOT part of this strategy. Ignore them.
The Silver Bullet is: Kill Zone + Liquidity Sweep + Displacement FVG + Price at FVG.
That is everything. Nothing more.

CRITICAL: Respond ONLY with valid JSON. No text, no markdown.
{
  "decision": "LONG" | "SHORT" | "WAIT",
  "confidence": 0-100,
  "entry": price or null,
  "stopLoss": price or null,
  "takeProfit1": price or null,
  "takeProfit2": price or null,
  "takeProfit3": price or null,
  "volume": lots or null,
  "reason": "which of the 4 steps passed and which failed — be specific",
  "step1_killzone": "PASS" | "FAIL" | reason,
  "step2_sweep": "PASS" | "FAIL" | reason,
  "step3_fvg": "PASS" | "FAIL" | reason,
  "step4_entry": "PASS" | "FAIL" | reason,
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "slPips": number,
  "rrRatio": number
}`;

    const userPrompt = `Analyze XAUUSD Silver Bullet setup now.

CURRENT PRICE: $${price}
UTC HOUR: ${utc_hour}
SESSION: ${session}

══ KILL ZONE CHECK ══
London KZ:  07:00-10:00 UTC
New York KZ: 13:00-16:00 UTC
Current UTC hour: ${utc_hour}
In Kill Zone: ${(utc_hour>=7&&utc_hour<10)||(utc_hour>=13&&utc_hour<16)?'YES ✅':'NO ❌ → WAIT'}

══ LIQUIDITY LEVELS ══
Asian High: ${asian_high||'—'}
Asian Low:  ${asian_low||'—'}
Asian Range: ${asian_range_pips||'—'} pips
Prev Day High (PDH): ${pdh||'—'}
Prev Day Low  (PDL): ${pdl||'—'}
Prev Week High: ${pwh||'—'}
Prev Week Low:  ${pwl||'—'}

══ SWEEP DETECTION ══
Sweep detected: ${liquidity_sweep||'NONE'}
Sweep direction: ${sweep_direction||'none'}
Swept level: ${sweep_level||'—'}

══ FVG AFTER DISPLACEMENT ══
FVG: ${marketSnapshot.smc_fvg||'none'}
BOS: ${smc_bos||'none'}
Order Block: ${smc_order_block||'none'}

══ ATR GUIDE ══
ATR(14): ${atr14} pips
${atr_sl_guide}

══ MARKET CONTEXT (bias only) ══
Weekly: ${candles_weekly}
Daily:  ${candles_d1}
H4:     ${candles_h4}
H1:     ${candles_h1}
M15:    ${candles_m15}
M5:     ${candles_m5}

══ ACCOUNT ══
Balance: $${balance.toFixed(2)} | Today P&L: $${today_pnl}
Win rate: ${overall_win_rate}% | Win streak: ${winStrk} | Loss streak: ${lossStrk}
Today longs:  ${today_long_results}
Today shorts: ${today_short_results}
Suggested volume: ${suggestedBase} lots

${prevContext}

Check all 4 steps in order. If any step FAILS → decision must be WAIT.
Report exactly which steps passed and which failed. JSON only.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY||'', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    const raw  = data.content?.map(b=>b.text||'').join('')||'';

    let decision;
    try {
      decision = JSON.parse(raw.replace(/```json|```/g,'').trim());
    } catch(e) {
      return res.status(200).json({ decision:'WAIT', reason:'Parse error', raw });
    }

    if (!['LONG','SHORT','WAIT'].includes(decision.decision)) decision.decision = 'WAIT';

    // ── Hard RR gate ──
    if (decision.decision !== 'WAIT' && decision.stopLoss && decision.takeProfit1) {
      const slD  = Math.abs((decision.entry||price) - decision.stopLoss);
      const tp1D = Math.abs(decision.takeProfit1 - (decision.entry||price));
      if (slD === 0 || tp1D/slD < 1.2) {
        decision.decision = 'WAIT';
        decision.reason   = `RR too low: ${(tp1D/slD).toFixed(2)}:1 — need 1.2:1 minimum`;
        decision.volume   = null;
      }
    }

    // ── ATR gate ──
    if (decision.decision !== 'WAIT' && decision.stopLoss) {
      const slD = Math.abs((decision.entry||price) - decision.stopLoss);
      if (slD < atr * 0.8) {
        decision.decision = 'WAIT';
        decision.reason   = `SL ${slD.toFixed(1)} pips too tight vs ATR ${atr.toFixed(1)}`;
        decision.volume   = null;
      }
    }

    console.log(JSON.stringify({
      symbol, decision: decision.decision, confidence: decision.confidence,
      step1: decision.step1_killzone, step2: decision.step2_sweep,
      step3: decision.step3_fvg, step4: decision.step4_entry,
      reason: decision.reason?.slice(0,80),
      atr: atr.toFixed(2), suggestedBase, balance: balance.toFixed(0)
    }));

    return res.status(200).json(decision);

  } catch(e) {
    console.error('AI brain error:', e);
    return res.status(500).json({ error: e.message });
  }
};