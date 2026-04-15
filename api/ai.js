/* eslint-disable */
// api/ai.js — V6 Brain — Full professional trader setup
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};

    if (body.prompt && !body.marketSnapshot) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: body.prompt }] }),
      });
      const data = await response.json();
      return res.status(200).json({ analysis: data.content?.map(b => b.text||'').join('')||'No response.', text: data.content?.map(b=>b.text||'').join('')||'' });
    }

    const { marketSnapshot, instrument, previousDecisions } = body;
    if (!marketSnapshot || !instrument) return res.status(400).json({ error: 'Missing marketSnapshot or instrument' });

    const {
      symbol, price,
      candles_weekly, candles_d1, candles_h4, candles_h1, candles_m15, candles_m5, candles_m1,
      rsi14, ema21, ema50, ema200, price_vs_ema21, price_vs_ema50, ema_alignment,
      atr14, atr_sl_guide, macd, bbands, bb_position,
      fib_levels, fib_nearest,
      smc_bos, smc_order_block, smc_fvg,
      equilibrium_zone, equilibrium_position, weekly_bias, round_levels,
      session,
      news, calendar_events,
      open_positions, account_balance,
      today_pnl, today_trades, loss_streak, win_streak, overall_win_rate,
      today_long_results, today_short_results,
    } = marketSnapshot;

    // ── Sizing ──
    const balance  = Number(account_balance) || 10000;
    const winRate  = Number(overall_win_rate) || 0;
    const winStrk  = Number(win_streak)  || 0;
    const lossStrk = Number(loss_streak) || 0;
    const atr      = parseFloat(atr14) || 15;

    const baseVolume = balance >= 20000 ? 0.20 : balance >= 10000 ? 0.15 : balance >= 5000 ? 0.10 : 0.05;
    const winRateMult = winRate >= 75 ? 3.0 : winRate >= 65 ? 2.0 : winRate >= 55 ? 1.5 : winRate >= 40 ? 1.0 : 0.5;
    const streakBonus    = winStrk  >= 3 ? 0.5 : 0;
    const lossProtection = lossStrk >= 3 ? 0   : lossStrk >= 2 ? 0.5 : 1.0;
    const suggestedBase  = Math.min(0.50, Math.round(((baseVolume * winRateMult + streakBonus) * lossProtection) / 0.01) * 0.01);

    const prevContext = previousDecisions?.length > 0
      ? `\nYour last ${previousDecisions.length} decisions:\n` +
        previousDecisions.map((d,i) => `${i+1}. ${d.decision} @ ${d.price} → ${d.outcome||'open'} ${d.pnl?`($${d.pnl>0?'+':''}${d.pnl})`:''} | ${d.reason}`).join('\n')
      : '\nNo previous decisions yet.';

    const systemPrompt = `You are the AI trading brain of Quantum Bot V6 — an institutional-grade autonomous Gold trader.

You think and trade like a professional prop firm trader with 10 years of Gold experience.
You have access to every tool a professional uses: multi-timeframe analysis, indicators, Fibonacci, SMC, and session analysis.

═══════════════════════════════════════════════════════
GOLD FUNDAMENTALS — NEVER FORGET THESE
═══════════════════════════════════════════════════════
- 1 pip on XAUUSD = $1.00 per 0.01 lot
- 0.10 lot × 20 pip move = $200 profit/loss
- Gold respects round numbers ($4800, $4820, $4850, $4900) with extreme precision
- Gold trends for days/weeks then reverses sharply — trend following beats mean reversion
- Highest volatility: London open (08:00–10:00 UTC) and NY open (13:00–15:00 UTC)
- London/NY overlap (13:00–16:00 UTC): highest volume, best setups
- Gold reacts to: USD strength (inverse), US10Y yields (inverse), geopolitical fear (positive)
- Never trade Gold in Asian session unless there's exceptional geopolitical news

═══════════════════════════════════════════════════════
HOW TO READ THE INDICATORS
═══════════════════════════════════════════════════════

ATR (Average True Range):
- This is your SL/TP calculator. Always use it.
- SL = 1.5× ATR minimum (never less — Gold will hunt it)
- TP1 = 2.0× ATR (first target, partial close 50%)
- TP2 = 3.0× ATR (partial close 30%)
- TP3 = 4.5× ATR minimum (let the runner breathe)
- The atr_sl_guide field already calculates this for you — use it directly

RSI(14):
- RSI > 70 = overbought — avoid LONG entries, good for SHORT pullbacks
- RSI < 30 = oversold — avoid SHORT entries, good for LONG pullbacks
- RSI 45–55 = neutral — wait for clearer signal
- RSI divergence: price makes new high but RSI doesn't = weakness (bearish)
- RSI divergence: price makes new low but RSI doesn't = strength (bullish)
- In a strong trend, RSI can stay above 60 (bullish) or below 40 (bearish) for hours

EMA Stack (21/50/200):
- BULLISH_STACK (21 > 50 > 200): Only take LONG trades
- BEARISH_STACK (21 < 50 < 200): Only take SHORT trades
- MIXED: Reduced confidence, smaller size, or WAIT
- Price above EMA21 + EMA50: bullish momentum
- Price below EMA21 + EMA50: bearish momentum
- EMA200 is the macro trend filter — never fight it

MACD(12,26,9):
- Histogram positive and growing: strong bullish momentum → LONG confirmation
- Histogram negative and falling: strong bearish momentum → SHORT confirmation
- MACD line crossing above signal: bullish crossover → entry trigger
- MACD line crossing below signal: bearish crossover → entry trigger
- Never enter against MACD direction

Bollinger Bands(20,2):
- BB position 0–20%: price near lower band → potential LONG from support
- BB position 80–100%: price near upper band → potential SHORT from resistance
- BB position 40–60%: mid-band, wait for breakout
- BB SQUEEZE: volatility compression → big move incoming, prepare for breakout
- Price breaking above upper band with volume: strong bullish breakout
- Price breaking below lower band: strong bearish breakout

═══════════════════════════════════════════════════════
FIBONACCI — YOUR PRECISION ENTRY TOOL
═══════════════════════════════════════════════════════
The fib_levels field gives you 23.6%, 38.2%, 50%, 61.8%, 78.6% retracements from H4 swing.

- 38.2% retracement: shallow pullback in strong trend → high probability continuation
- 50.0% retracement: classic mid-point support/resistance
- 61.8% (Golden Ratio): strongest retracement level — if price holds here, trend continues
- 78.6%: deep retracement — last chance for trend continuation before reversal

ENTRY RULE: Look for price to REACT at a fib level, not just touch it.
- Price comes into 61.8% + RSI < 40 in uptrend = strong LONG setup
- Price comes into 61.8% + bearish MACD in downtrend = strong SHORT setup
- fib_nearest tells you which level price is closest to right now

═══════════════════════════════════════════════════════
SMART MONEY CONCEPTS (SMC)
═══════════════════════════════════════════════════════
The smc fields give you institutional footprints.

smc_bos (Break of Structure):
- BULLISH_BOS: price broke above previous swing high → trend is UP, only LONG
- BEARISH_BOS: price broke below previous swing low → trend is DOWN, only SHORT
- NONE: no clear structure break → lower confidence, smaller size

smc_order_block:
- BULLISH_OB: zone where institutions bought aggressively (last bearish candle before rally)
  → Price returning to this zone = ideal LONG entry
- BEARISH_OB: zone where institutions sold aggressively (last bullish candle before drop)
  → Price returning to this zone = ideal SHORT entry

smc_fvg (Fair Value Gap):
- Imbalance that price "wants" to fill
- BULLISH_FVG: gap above current price = magnet for upside move → LONG target
- BEARISH_FVG: gap below current price = magnet for downside move → SHORT target
- Price often returns to fill FVG before continuing the trend

═══════════════════════════════════════════════════════
CONFLUENCE SCORING — HOW TO DECIDE
═══════════════════════════════════════════════════════
Count your confluences before entering. More = higher confidence and size.

Each confluence adds ~10-15 points to confidence:
+15: Weekly bias agrees with trade direction
+15: EMA stack agrees (BULLISH_STACK for LONG, BEARISH_STACK for SHORT)
+15: MACD histogram in same direction as trade
+12: RSI confirms (not overbought for LONG, not oversold for SHORT)
+12: SMC Break of Structure in trade direction
+12: Price at Fibonacci 61.8% or 38.2% level
+10: Price at Order Block in correct direction
+10: BB position correct (low for LONG, high for SHORT)
+10: FVG as magnet in trade direction
+8:  Session timing correct (London/NY/Overlap)
+8:  Round number support/resistance nearby for SL/TP anchor
+8:  Price vs EMA21/50 alignment

90–100: EXTREMELY HIGH confidence — max size
75–89:  HIGH confidence — full size
60–74:  MEDIUM confidence — standard size
45–59:  LOW confidence — half size or WAIT
<45:    WAIT — setup not clear enough

═══════════════════════════════════════════════════════
SL/TP RULES (ATR-BASED — NON NEGOTIABLE)
═══════════════════════════════════════════════════════
ALWAYS use the atr_sl_guide values. These are calculated from real market volatility.

SL placement:
1. Calculate 1.5× ATR as minimum distance
2. Find nearest structural level (swing high/low, Order Block, Fibonacci level)
3. Place SL 2–3 pips BEYOND that structure (not at it — Gold hunts tight SLs)
4. Never place SL at a round number — always 2–3 beyond it

TP placement:
1. TP1 = 2× ATR from entry (50% close) — land near a fib or round level
2. TP2 = 3× ATR from entry (30% close) — land near next fib or structure
3. TP3 = 4.5× ATR minimum (20% runner) — land at the swing high/low or FVG fill

RISK/REWARD minimum:
- TP1 ≥ 1.5× SL distance (non-negotiable)
- TP3 ≥ 4× SL distance (non-negotiable)
- If you cannot place SL/TP at logical structural levels that meet RR: WAIT

═══════════════════════════════════════════════════════
SESSION RULES
═══════════════════════════════════════════════════════
- London (08:00–16:00 UTC): First move defines direction. Best BOS entries.
- New York (13:00–21:00 UTC): Either accelerates or reverses London move.
- Overlap (13:00–16:00 UTC): Highest conviction moves. Best R/R setups.
- Asian (00:00–08:00 UTC): WAIT unless extraordinary geopolitical event.
- Sunday open: WAIT — low volume, spreads wide.

═══════════════════════════════════════════════════════
LEARNING FROM PAST DECISIONS
═══════════════════════════════════════════════════════
- If same direction lost 3+ times today: STOP trading that direction
- If last 3 decisions were losses: reduce size by 50%, require 80+ confidence
- If last 3 decisions were wins: you're in flow — maintain size
- Never revenge trade. A loss means the setup was wrong, not that you need to recover.

═══════════════════════════════════════════════════════
SIZING (MANDATORY)
═══════════════════════════════════════════════════════
Suggested base: ${suggestedBase} lots (pre-calculated from win rate + balance + streaks)
- confidence ≥ 85: suggestedBase × 1.5 (max 0.50)
- confidence 75–84: suggestedBase × 1.25
- confidence 60–74: suggestedBase × 1.0
- confidence < 60:  suggestedBase × 0.5
- Round to nearest 0.01. Never exceed 0.50 lots.
- WAIT = volume null

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
  "reason": "2-3 sentences: what you see, why you're entering or waiting",
  "marketRead": "full market picture: trend, key levels, what price is doing",
  "confluences": ["list", "of", "confluences", "found"],
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "slPips": number,
  "tp1Pips": number,
  "rrRatio": number
}`;

    const userPrompt = `Analyze XAU/USD now and make your decision.

PRICE: $${price}
SESSION: ${session} | Market is OPEN and in active trading window

══ TIMEFRAME ANALYSIS ══
Weekly:  ${candles_weekly}
Daily:   ${candles_d1}
H4:      ${candles_h4}
H1:      ${candles_h1}
M15:     ${candles_m15}
M5:      ${candles_m5}
M1:      ${candles_m1}

Weekly bias: ${weekly_bias}

══ INDICATORS ══
RSI(14):     ${rsi14}
EMA Stack:   21=${ema21} | 50=${ema50} | 200=${ema200}
EMA Align:   ${ema_alignment}
Price/EMA21: ${price_vs_ema21} | Price/EMA50: ${price_vs_ema50}
ATR(14):     ${atr14} pips
ATR GUIDE:   ${atr_sl_guide}
MACD:        ${macd||'insufficient data'}
Bollinger:   ${bbands||'insufficient data'} | Position: ${bb_position!=null?bb_position+'%':'—'}

══ FIBONACCI (from H4 swing) ══
${fib_levels||'insufficient data'}
Nearest: ${fib_nearest||'—'}

══ SMART MONEY (H1) ══
Break of Structure: ${smc_bos||'none'}
Order Block:        ${smc_order_block||'none'}
Fair Value Gap:     ${smc_fvg||'none'}

══ STRUCTURE ══
Equilibrium zone: ${equilibrium_zone} (${equilibrium_position}% of H4 range)
Key round levels: ${round_levels}

══ NEWS & EVENTS ══
${news?.slice(0,3).map(n=>`- ${n.title}`).join('\n')||'No major news'}
Events: ${calendar_events?.length>0?calendar_events.slice(0,3).map(e=>`${e.name} (${e.date})`).join(' | '):'None'}

══ ACCOUNT ══
Balance: $${balance.toFixed(2)} | Today P&L: $${today_pnl}
Win rate: ${overall_win_rate}% | Win streak: ${winStrk} | Loss streak: ${lossStrk}
Today longs:  ${today_long_results}
Today shorts: ${today_short_results}
Open positions: ${open_positions?.length||0}
${open_positions?.length>0?open_positions.map(p=>`  ${p.symbol} ${p.type} $${p.profit?.toFixed(2)}`).join('\n'):''}

Suggested volume: ${suggestedBase} lots

${prevContext}

Count your confluences. Use ATR for SL/TP. Check Fib levels. Check SMC. Trade with the weekly bias.
If confluence score < 45, say WAIT. Score 45-59 = enter with 0.5× size. Score 60+ = full size. Respond JSON only.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 900,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    const raw  = data.content?.map(b => b.text||'').join('') || '';

    let decision;
    try {
      decision = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch(e) {
      return res.status(200).json({ decision:'WAIT', reason:'Parse error', raw });
    }

    if (!['LONG','SHORT','WAIT'].includes(decision.decision)) decision.decision = 'WAIT';

    // ── Hard RR safety gate ──
    if (decision.decision !== 'WAIT' && decision.stopLoss && decision.takeProfit1 && decision.takeProfit3) {
      const slD  = Math.abs((decision.entry||price) - decision.stopLoss);
      const tp1D = Math.abs(decision.takeProfit1 - (decision.entry||price));
      const tp3D = Math.abs(decision.takeProfit3 - (decision.entry||price));
      const rr1  = tp1D / slD;
      const rr3  = tp3D / slD;
      if (rr1 < 1.2 || rr3 < 3.5) {
        console.log(`RR GATE BLOCKED: TP1=${rr1.toFixed(2)} TP3=${rr3.toFixed(2)}`);
        decision.decision = 'WAIT';
        decision.reason   = `RR failed: TP1=${rr1.toFixed(1)}:1 TP3=${rr3.toFixed(1)}:1 — need ≥1.2 and ≥3.5`;
        decision.volume   = null;
      }
      // ── ATR gate: SL too tight means it will be hunted ──
      if (decision.decision !== 'WAIT' && slD < atr * 0.5) {
        console.log(`ATR GATE BLOCKED: SL=${slD.toFixed(2)} < ATR=${atr.toFixed(2)}`);
        decision.decision = 'WAIT';
        decision.reason   = `SL too tight: ${slD.toFixed(1)} pips < ATR ${atr.toFixed(1)} pips minimum`;
        decision.volume   = null;
      }
    }

    console.log(JSON.stringify({
      symbol, decision: decision.decision, confidence: decision.confidence,
      volume: decision.volume, slPips: decision.slPips, rrRatio: decision.rrRatio,
      confluences: decision.confluences?.length||0,
      confluenceList: decision.confluences||[],
      reason: decision.reason,
      marketRead: decision.marketRead?.slice(0,100),
      atr: atr.toFixed(2), suggestedBase, winRate, balance: balance.toFixed(0),
      session, slD: decision.stopLoss ? Math.abs((decision.entry||price)-decision.stopLoss).toFixed(2) : null
    }));

    return res.status(200).json(decision);

  } catch(e) {
    console.error('AI brain error:', e);
    return res.status(500).json({ error: e.message });
  }
};