/* eslint-disable */
// api/ai.js — V5 Brain — Gold-aware sizing + SL/TP logic
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};

    // ── Manual AI analysis (AI tab button) ──
    if (body.prompt && !body.marketSnapshot) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: body.prompt }],
        }),
      });
      const data = await response.json();
      const text = data.content?.map(b => b.text || '').join('') || 'No response.';
      return res.status(200).json({ analysis: text, text });
    }

    // ── V5 Brain ──
    const { marketSnapshot, instrument, previousDecisions } = body;
    if (!marketSnapshot || !instrument) {
      return res.status(400).json({ error: 'Missing marketSnapshot or instrument' });
    }

    const {
      symbol, price,
      candles_m1, candles_m15, candles_h4, candles_d1,
      rsi, ema21, price_vs_ema21,
      equilibrium_zone, equilibrium_position,
      session, session_allowed,
      news, calendar_events,
      open_positions,
      account_balance,
      today_pnl,
      today_trades,
      loss_streak,
      win_streak,
      overall_win_rate,
      today_long_results,
      today_short_results,
    } = marketSnapshot;

    // ── Volume sizing ──
    const balance  = Number(account_balance) || 10000;
    const winRate  = Number(overall_win_rate) || 0;
    const winStrk  = Number(win_streak)  || 0;
    const lossStrk = Number(loss_streak) || 0;

    const baseVolume =
      balance >= 20000 ? 0.20 :
      balance >= 10000 ? 0.15 :
      balance >= 5000  ? 0.10 : 0.05;

    const winRateMult =
      winRate >= 75 ? 3.0 :
      winRate >= 65 ? 2.0 :
      winRate >= 55 ? 1.5 :
      winRate >= 40 ? 1.0 : 0.5;

    const streakBonus    = winStrk  >= 3 ? 0.5 : 0;
    const lossProtection = lossStrk >= 3 ? 0   : lossStrk >= 2 ? 0.5 : 1.0;

    const suggestedBase = Math.min(0.50,
      Math.round(((baseVolume * winRateMult + streakBonus) * lossProtection) / 0.01) * 0.01
    );

    const prevContext = previousDecisions?.length > 0
      ? `\nYour last ${previousDecisions.length} decisions on ${symbol}:\n` +
        previousDecisions.map((d, i) =>
          `${i+1}. ${d.decision} @ ${d.price} → ${d.outcome || 'open'} ${d.pnl ? `($${d.pnl > 0 ? '+' : ''}${d.pnl})` : ''} | ${d.reason}`
        ).join('\n')
      : '\nNo previous decisions on this instrument yet.';

    // ── GOLD-SPECIFIC SYSTEM PROMPT ──
    const systemPrompt = `You are the trading brain of Quantum Bot V5, trading XAUUSD (Gold) exclusively.

Gold is NOT like forex. You must understand its unique characteristics:

GOLD PRICE CHARACTERISTICS:
- Gold moves in $5–$30 ranges per session on normal days
- Gold moves in $50–$150 ranges on high-impact news days (CPI, NFP, Fed)
- 1 pip on Gold = $1 per 0.01 lot. So 0.10 lot × $20 move = $200 profit/loss
- Gold respects round numbers ($4800, $4820, $4850) as strong S/R levels
- Gold is extremely reactive to USD strength/weakness and geopolitical news
- Gold trends strongly — when H4 is bullish, it stays bullish for days
- Gold rarely reverses cleanly at M1 levels — you need M15/H4 confluence

STOP LOSS RULES FOR GOLD:
- SL must be placed beyond a real structural level (swing high/low on M15 or H4)
- Minimum SL distance: 8 pips ($0.80 per 0.01 lot)
- Maximum SL distance: 30 pips on normal days ($3.00 per 0.01 lot)
- Never place SL at a round number — place it 2-3 pips beyond it
- A SL of less than 8 pips on Gold will be hunted immediately

TAKE PROFIT RULES FOR GOLD:
- TP1 must be at minimum 1.5× the SL distance (not 1:1 — Gold needs room)
- TP2 must be at minimum 2.5× the SL distance
- TP3 must be at minimum 4× the SL distance — Gold runners are REAL
- All TPs must land at or just before key round numbers or structural levels
- Example: if SL is 15 pips, TP1 = 22+ pips, TP2 = 37+ pips, TP3 = 60+ pips
- A TP1 of only 5-8 pips on Gold is not worth the risk — skip or widen it

GOLD MARKET BEHAVIOR:
- During London open (08:00-10:00 UTC): Gold makes its first strong directional move
- During NY open (13:00-15:00 UTC): Gold often reverses or accelerates the London move
- During London/NY overlap (13:00-16:00 UTC): Highest volatility, best setups
- If H4 shows a strong trend: trade only in that direction, pullbacks are entries
- If RSI > 70 in a downtrend or RSI < 30 in an uptrend: mean reversion risk
- If today's short results show 3+ losses: the market is bullish — stop shorting
- If today's long results show 3+ losses: the market is bearish — stop buying

SIZING RULES (MANDATORY):
Suggested base volume: ${suggestedBase} lots
- confidence >= 85: suggestedBase × 1.5 (max 0.50)
- confidence 75-84: suggestedBase × 1.25
- confidence 60-74: suggestedBase × 1.0
- confidence < 60:  suggestedBase × 0.5
- Round to nearest 0.01. Never exceed 0.50 lots.
- If WAIT: volume = null

RISK/REWARD REQUIREMENT:
- Never take a trade where TP1 is less than 1.5× the SL distance
- Never take a trade where TP3 is less than 4× the SL distance
- If you cannot find a TP3 that is 4× the SL away with a clear target: WAIT
- A bad RR trade on Gold with 0.10-0.50 lots can wipe $100-$500 in one hit

CRITICAL: Respond ONLY with valid JSON. No text before or after. No markdown.

Response format:
{
  "decision": "LONG" | "SHORT" | "WAIT",
  "confidence": 0-100,
  "entry": price or null,
  "stopLoss": price or null,
  "takeProfit1": price or null,
  "takeProfit2": price or null,
  "takeProfit3": price or null,
  "volume": calculated lots or null,
  "reason": "1-2 sentence reasoning",
  "marketRead": "what you see in Gold right now — trend, structure, key levels",
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "slPips": SL distance in pips (e.g. 15),
  "tp1Pips": TP1 distance in pips,
  "rrRatio": TP3/SL ratio (e.g. 4.2)
}`;

    const userPrompt = `Analyze XAU/USD and make a trading decision now.

CURRENT PRICE: $${price}
SESSION: ${session} | Trading allowed: ${session_allowed}

MARKET STRUCTURE:
Equilibrium zone: ${equilibrium_zone} (${equilibrium_position}% of H4 range)
Price vs EMA21: ${price_vs_ema21}
RSI(14): ${rsi}

CANDLE CONTEXT (this is how Gold has moved):
${candles_m1}
${candles_m15}
${candles_h4}
${candles_d1}

TODAY'S DIRECTION RESULTS:
${today_long_results || 'No longs today'}
${today_short_results || 'No shorts today'}

ACCOUNT STATE:
Balance: $${balance.toFixed(2)}
Today P&L: $${today_pnl}
Trades today: ${today_trades}
Overall win rate: ${overall_win_rate}%
Win streak: ${winStrk} | Loss streak: ${lossStrk}
Open positions: ${open_positions?.length || 0}
${open_positions?.length > 0 ? open_positions.map(p => `  ${p.symbol} ${p.type} ${p.profit >= 0 ? '+' : ''}$${p.profit?.toFixed(2)}`).join('\n') : ''}

SUGGESTED VOLUME: ${suggestedBase} lots
(calculated from win rate ${overall_win_rate}% and balance $${balance.toFixed(0)})

NEWS:
${news?.slice(0,3).map(n => `- ${n.title}`).join('\n') || 'No recent news'}

ECONOMIC EVENTS:
${calendar_events?.length > 0 ? calendar_events.slice(0,3).map(e => `- ${e.name} (${e.date})`).join('\n') : 'No major events'}

${prevContext}

Remember: You are trading GOLD. SL must be beyond real structure. TP1 minimum 1.5× SL. TP3 minimum 4× SL.
If the R/R does not meet the minimum, say WAIT. Respond JSON only.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 700,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    const raw  = data.content?.map(b => b.text || '').join('') || '';

    let decision;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      decision = JSON.parse(clean);
    } catch(e) {
      return res.status(200).json({ decision: 'WAIT', reason: 'Parse error', raw });
    }

    if (!['LONG', 'SHORT', 'WAIT'].includes(decision.decision)) decision.decision = 'WAIT';

    // ── Safety: validate RR before executing ──
    if (decision.decision !== 'WAIT' && decision.stopLoss && decision.takeProfit1 && decision.takeProfit3) {
      const slDist  = Math.abs(decision.entry   - decision.stopLoss);
      const tp1Dist = Math.abs(decision.takeProfit1 - decision.entry);
      const tp3Dist = Math.abs(decision.takeProfit3 - decision.entry);
      const rr1 = tp1Dist / slDist;
      const rr3 = tp3Dist / slDist;

      // Block trades with bad RR — protects when scaling up lots
      if (rr1 < 1.2 || rr3 < 3.5) {
        console.log(`RR BLOCKED: TP1 RR=${rr1.toFixed(2)} TP3 RR=${rr3.toFixed(2)} — forcing WAIT`);
        decision.decision = 'WAIT';
        decision.reason   = `RR too low for Gold: TP1=${rr1.toFixed(1)}:1, TP3=${rr3.toFixed(1)}:1 (need 1.2:1 and 3.5:1 minimum)`;
        decision.volume   = null;
      }
    }

    console.log(JSON.stringify({
      symbol, decision: decision.decision,
      confidence: decision.confidence,
      volume: decision.volume,
      slPips: decision.slPips,
      tp1Pips: decision.tp1Pips,
      rrRatio: decision.rrRatio,
      suggestedBase, winRate, balance: balance.toFixed(0)
    }));

    return res.status(200).json(decision);

  } catch(e) {
    console.error('AI brain error:', e);
    return res.status(500).json({ error: e.message });
  }
};