/* eslint-disable */
// api/ai.js — V5 Brain — Aggressive sizing
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

    // ── V5 Brain: autonomous trade decision ──
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
    } = marketSnapshot;

    // ── Calculate aggressive volume ──
    const balance  = Number(account_balance) || 10000;
    const winRate  = Number(overall_win_rate) || 0;
    const winStrk  = Number(win_streak)  || 0;
    const lossStrk = Number(loss_streak) || 0;

    // Base by balance
    const baseVolume =
      balance >= 20000 ? 0.20 :
      balance >= 10000 ? 0.15 :
      balance >= 5000  ? 0.10 : 0.05;

    // Win rate multiplier — AGGRESSIVE
    const winRateMult =
      winRate >= 75 ? 3.0 :
      winRate >= 65 ? 2.0 :
      winRate >= 55 ? 1.5 :
      winRate >= 40 ? 1.0 : 0.5;

    // Win streak bonus
    const streakBonus = winStrk >= 3 ? 0.5 : 0;

    // Loss streak protection
    const lossProtection = lossStrk >= 3 ? 0 : lossStrk >= 2 ? 0.5 : 1.0;

    // Suggested volume (confidence multiplier applied after Claude decides)
    const suggestedBase = Math.min(0.50,
      Math.round(((baseVolume * winRateMult + streakBonus) * lossProtection) / 0.01) * 0.01
    );

    // Previous decisions context
    const prevContext = previousDecisions?.length > 0
      ? `\nYour last ${previousDecisions.length} decisions on ${symbol}:\n` +
        previousDecisions.map((d, i) =>
          `${i+1}. ${d.decision} @ ${d.price} → ${d.outcome || 'open'} ${d.pnl ? `($${d.pnl > 0 ? '+' : ''}${d.pnl})` : ''} | ${d.reason}`
        ).join('\n')
      : '\nNo previous decisions on this instrument yet.';

    const systemPrompt = `You are the trading brain of Quantum Bot V5.
You are an aggressive, experienced institutional trader.
You read the full market picture and make bold, well-reasoned decisions.
You are NOT conservative. When the setup is good, you size up hard.
You think like a prop firm trader with a clear edge.

SIZING RULES (MANDATORY — follow exactly):
The suggested base volume for this trade is: ${suggestedBase} lots
- If confidence >= 85: use suggestedBase × 1.5 (max 0.50)
- If confidence 75-84: use suggestedBase × 1.25
- If confidence 60-74: use suggestedBase × 1.0
- If confidence < 60:  use suggestedBase × 0.5
- Round to nearest 0.01
- Never exceed 0.50 lots
- If WAIT: volume = null

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
  "marketRead": "what you see happening in the market right now",
  "risk": "LOW" | "MEDIUM" | "HIGH"
}

TRADING RULES:
- stopLoss: place beyond nearest structure (swing high/low), not too tight
- takeProfit1: 1:1 RR (partial close 50%)
- takeProfit2: 1:2.5 RR (partial close 30%)  
- takeProfit3: 1:4 RR minimum — let winners run
- Say WAIT if market is choppy, unclear, or against session
- Learn from previous decisions — if you lost on this exact setup, be cautious
- DISCOUNT zone + H4 uptrend + London/NY = high confidence LONG
- PREMIUM zone + H4 downtrend + London/NY = high confidence SHORT
- Asian session = lower confidence, smaller size`;

    const userPrompt = `Analyze ${symbol} and make a trading decision now.

PRICE: ${price}
SESSION: ${session} | Allowed: ${session_allowed}
EQUILIBRIUM: ${equilibrium_zone} (${equilibrium_position}% of H4 range)
PRICE vs EMA21: ${price_vs_ema21}
RSI(14): ${rsi}

CANDLE CONTEXT:
${candles_m1}
${candles_m15}
${candles_h4}
${candles_d1}

ACCOUNT STATE:
Balance: $${balance.toFixed(2)}
Today P&L: $${today_pnl}
Today trades: ${today_trades}
Win rate: ${overall_win_rate}%
Win streak: ${winStrk} | Loss streak: ${lossStrk}
Open positions: ${open_positions?.length || 0}
${open_positions?.length > 0 ? open_positions.map(p => `  ${p.symbol} ${p.type} ${p.profit >= 0 ? '+' : ''}$${p.profit?.toFixed(2)}`).join('\n') : ''}

SUGGESTED BASE VOLUME: ${suggestedBase} lots
(Win rate ${overall_win_rate}% × balance $${balance.toFixed(0)} calculation)

NEWS:
${news?.slice(0,3).map(n => `- ${n.title}`).join('\n') || 'No recent news'}

EVENTS:
${calendar_events?.length > 0 ? calendar_events.slice(0,3).map(e => `- ${e.name} (${e.date})`).join('\n') : 'No major events'}
${prevContext}

Make your decision. Be aggressive when the setup is clear. Respond JSON only.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    const raw  = data.content?.map(b => b.text || '').join('') || '';

    let decision;
    try {
  // Try multiple extraction methods
  let clean = raw.replace(/```json|```/g, '').trim();
  
  // If still not valid JSON, extract the JSON object
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (jsonMatch) clean = jsonMatch[0];
  
  decision = JSON.parse(clean);
} catch(e) {
  // Log the raw response to debug
  console.error('Parse error. Raw response:', raw);
  return res.status(200).json({ 
    decision: 'WAIT', 
    reason: `Parse error: ${raw?.slice(0, 100)}`, 
    raw 
  });
}

    if (!['LONG', 'SHORT', 'WAIT'].includes(decision.decision)) decision.decision = 'WAIT';
    decision.confidence = Number(decision.confidence) || 0;
decision.risk       = decision.risk     || 'MEDIUM';
decision.reason     = decision.reason   || 'No reason provided';
decision.marketRead = decision.marketRead || '';
decision.volume     = decision.volume   || null;
decision.stopLoss   = decision.stopLoss || null;
decision.takeProfit1 = decision.takeProfit1 || null;
decision.takeProfit2 = decision.takeProfit2 || null;
decision.takeProfit3 = decision.takeProfit3 || null;

    // Log sizing info
    console.log(JSON.stringify({
      symbol, decision: decision.decision,
      confidence: decision.confidence,
      volume: decision.volume,
      suggestedBase, winRate, winStrk, balance: balance.toFixed(0)
    }));

    return res.status(200).json(decision);

  } catch(e) {
    console.error('AI brain error:', e);
    return res.status(500).json({ error: e.message });
  }
};