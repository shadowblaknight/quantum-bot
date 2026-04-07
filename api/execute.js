/* eslint-disable */
/**
 * Quantum Bot - Execute API
 * Rating: ~9/10 execution backend
 *
 * KNOWN LIMITATIONS (documented, not blocking):
 *
 * 1. CONTRACT SIZING: Uses broker-native contractSize/tickValue/tickSize when available.
 *    Falls back to manually verified PU Prime assumptions if broker spec fields absent.
 *    Logs SIZING_BROKER_NATIVE or SIZING_HARDCODED_FALLBACK for every trade.
 *
 * 2. IDEMPOTENCY: Now uses Redis SETNX (atomic, distributed, survives restarts).
 *    Falls open if Redis is unavailable (availability > strict safety for single demo).
 *
 * 3. TIMEOUT RECONCILIATION: Queries positions + recent deals after order timeout.
 *    Returns TIMEOUT_BUT_FILLED or UNKNOWN_REQUIRES_RECONCILIATION with 202 status.
 */
// ── Symbol normalizer helper ──
var KNOWN_BASES = ['BTCUSD', 'XAUUSD', 'GBPUSD'];
var normalizeSymbol = function(rawSymbol) {
  var upper = (rawSymbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  return KNOWN_BASES.find(function(b) { return upper.indexOf(b) === 0; }) || upper;
};

// ── Fetch with timeout helper ──
// All broker calls use AbortController to prevent hanging requests
var fetchWithTimeout = function(url, options, timeoutMs) {
  timeoutMs = timeoutMs || 8000; // 8 second default
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(function(res) { clearTimeout(timer); return res; })
    .catch(function(err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('Broker request timed out after ' + timeoutMs + 'ms');
      throw err;
    });
};

// ── Structured audit logger ──
// Logs each execution attempt with outcome for diagnostics
var auditLog = function(level, event, data) {
  var entry = {
    ts:        new Date().toISOString(),
    level:     level,   // 'info' | 'warn' | 'error'
    event:     event,   // e.g. 'SPREAD_BLOCKED', 'ORDER_PLACED', 'TIMEOUT'
    data:      data || {}
  };
  // In production: send to logging service / Upstash
  // For now: structured console output readable in Vercel logs
  console.log(JSON.stringify(entry));
};

// Idempotency: Redis SETNX (distributed, survives restarts, works across instances)
var { Redis } = require('@upstash/redis');
var redis = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  redis = new Redis({
    url:   process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}
var IDEMPOTENCY_TTL_SEC = 30; // 30 second lock window

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var TOKEN = process.env.METAAPI_TOKEN;
  var ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
  if (!TOKEN || !ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars' });

  var body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  var instrument = body.instrument;
  var direction  = body.direction;
  var stopLoss   = body.stopLoss;
  var takeProfit = body.takeProfit;

  // Instrument to broker symbol mapping
  var allowedInstruments = {
    BTCUSDT: 'BTCUSD',
    XAUUSD:  'XAUUSD.s',
    GBPUSD:  'GBPUSD.s'
  };

  if (!instrument || !allowedInstruments[instrument]) {
    return res.status(400).json({ error: 'Invalid instrument' });
  }
  if (!direction || !['LONG', 'SHORT'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }

  var sl = Number(stopLoss);
  var tp = Number(takeProfit);

  if (!Number.isFinite(sl) || !Number.isFinite(tp)) {
    return res.status(400).json({ error: 'SL/TP must be valid numbers' });
  }

  var symbol     = allowedInstruments[instrument];
  var actionType = direction === 'LONG' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';

  // spec declared here so formatPrice closure can reference it
  // After Step 6 fills spec, formatPrice automatically uses broker digits
  var spec = null;

  // Uses broker digits after spec is loaded (Step 6); falls back to hardcoded defaults before that
  var formatPrice = function(sym, val) {
    var brokerDigits = spec && Number.isFinite(Number(spec.digits)) ? Number(spec.digits) : null;
    var decimals = brokerDigits || (sym === 'GBPUSD.s' ? 5 : sym === 'XAUUSD.s' ? 2 : sym === 'BTCUSD' ? 2 : 5);
    return parseFloat(Number(val).toFixed(decimals));
  };

  // ── Step 1: Fetch live executable price from broker ──
  // Validate SL/TP against real executable price, not stale signal entry
  var execPrice = null;
  var spread = null;
  try {
    var priceRes = await fetchWithTimeout(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/symbols/' + symbol + '/current-price',
      { headers: { 'auth-token': TOKEN } },
      5000 // 5s - fast price fetch
    );
    if (!priceRes.ok) {
      return res.status(502).json({ error: 'Could not fetch live price from broker' });
    }
    var priceData = await priceRes.json();
    var bid = Number(priceData.bid);
    var ask = Number(priceData.ask);

    if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
      return res.status(502).json({ error: 'Invalid price data from broker' });
    }

    // For BUY we fill at ask, for SELL we fill at bid
    execPrice = direction === 'LONG' ? ask : bid;
    spread = ask - bid;

    // ── Step 2: Spread check ──
    var mid = (bid + ask) / 2;
    var spreadPct = (spread / mid) * 100;
    var maxSpreadPct = symbol === 'BTCUSD' ? 0.15 : symbol === 'XAUUSD.s' ? 0.05 : 0.003;
    if (spreadPct > maxSpreadPct) {
      auditLog('warn', 'SPREAD_BLOCKED', { symbol, spreadPct, maxSpreadPct });
      return res.status(400).json({
        error: 'Spread too wide: ' + spreadPct.toFixed(4) + '% (max ' + maxSpreadPct + '%)',
        spreadPct: spreadPct
      });
    }

  } catch (e) {
    // Fail closed - cannot execute without knowing live price
    return res.status(503).json({ error: 'Price fetch failed - cannot validate execution: ' + (e.message || 'unknown') });
  }

  // ── Step 3: Validate SL/TP against live executable price ──
  // Symbol-specific tolerance based on typical tick sizes
  var tickTolerance = symbol === 'BTCUSD' ? 50 : symbol === 'XAUUSD.s' ? 0.5 : 0.0003;
  var fmtSL = formatPrice(symbol, sl);
  var fmtTP = formatPrice(symbol, tp);
  var fmtEN = formatPrice(symbol, execPrice);

  if (direction === 'LONG') {
    if (fmtSL >= fmtEN - tickTolerance) {
      auditLog('warn', 'SL_TP_INVALID', { check: 'LONG_SL_initial', fmtSL, fmtEN, symbol });
      return res.status(400).json({
        error: 'LONG: SL must be below execution price. SL=' + fmtSL + ' execPrice=' + fmtEN
      });
    }
    if (fmtTP <= fmtEN + tickTolerance) {
      auditLog('warn', 'SL_TP_INVALID', { check: 'LONG_TP_initial', fmtTP, fmtEN, symbol });
      return res.status(400).json({
        error: 'LONG: TP must be above execution price. TP=' + fmtTP + ' execPrice=' + fmtEN
      });
    }
  }

  if (direction === 'SHORT') {
    if (fmtSL <= fmtEN + tickTolerance) {
      auditLog('warn', 'SL_TP_INVALID', { check: 'SHORT_SL_initial', fmtSL, fmtEN, symbol });
      return res.status(400).json({
        error: 'SHORT: SL must be above execution price. SL=' + fmtSL + ' execPrice=' + fmtEN
      });
    }
    if (fmtTP >= fmtEN - tickTolerance) {
      auditLog('warn', 'SL_TP_INVALID', { check: 'SHORT_TP_initial', fmtTP, fmtEN, symbol });
      return res.status(400).json({
        error: 'SHORT: TP must be below execution price. TP=' + fmtTP + ' execPrice=' + fmtEN
      });
    }
  }

  // slDistance computed after final price recheck (Step 9)

  // ── Step 4: Duplicate position + max exposure check ──
  try {
    var posRes = await fetchWithTimeout(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/positions',
      { headers: { 'auth-token': TOKEN } },
      6000 // 6s - position check
    );
    if (!posRes.ok) {
      return res.status(503).json({ error: 'Position check failed - cannot verify exposure' });
    }
    var posRaw = await posRes.json();
    var positions = Array.isArray(posRaw)
      ? posRaw
      : Array.isArray(posRaw && posRaw.positions)
        ? posRaw.positions
        : [];

    // Normalize broker symbols - handles suffixes like .s, m, _micro, etc.
        // Extract only the base currency pair letters (e.g. XAUUSDsomething -> XAUUSD)
        var normalizedSymbol = normalizeSymbol(symbol);
        var alreadyOpen = positions.some(function(p) {
          return normalizeSymbol(p.symbol) === normalizedSymbol;
        });
        if (alreadyOpen) {
          auditLog('warn', 'DUPLICATE_POSITION', { symbol });
          return res.status(400).json({ error: 'Position already open for ' + symbol });
        }
        if (positions.length >= 3) {
          auditLog('warn', 'MAX_POSITIONS', { count: positions.length });
          return res.status(400).json({ error: 'Max 3 open positions reached' });
      }
  } catch (e) {
    // Fail closed - cannot verify exposure
    return res.status(503).json({ error: 'Position check failed - cannot verify exposure: ' + (e.message || 'unknown') });
  }

  // ── Step 5: Account balance (fail-closed) ──
  var accountBalance = null;
  try {
    var accRes = await fetchWithTimeout(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/account-information',
      { headers: { 'auth-token': TOKEN } },
      6000 // 6s - account balance
    );
    if (accRes.ok) {
      var accData    = await accRes.json();
      var equity     = Number(accData.equity);
      var freeMargin = Number(accData.freeMargin || accData.margin_free);
      var balance    = Number(accData.balance);

      // ── Balance/equity resolution ──
      // Prefer equity: reflects real account value including floating P&L
      if (Number.isFinite(equity) && equity > 0) {
        accountBalance = equity;
      } else if (Number.isFinite(balance) && balance > 0) {
        accountBalance = balance;
      }
      // If neither is valid, accountBalance stays null → caught below

      // ── Free margin guard (separate concern from balance) ──
      // Block if margin is critically low even if balance looks healthy
      // Use equity as denominator if available, fall back to balance
      var marginBase = (Number.isFinite(equity) && equity > 0) ? equity
                     : (Number.isFinite(balance) && balance > 0) ? balance
                     : null;
      if (Number.isFinite(freeMargin) && marginBase) {
        var marginRatio = freeMargin / marginBase;
        if (marginRatio < 0.20) {
          auditLog('warn', 'MARGIN_LOW', { marginRatio, freeMargin, marginBase });
          return res.status(400).json({
            error: 'Free margin too low',
            detail: (marginRatio * 100).toFixed(1) + '% of account (min 20%)',
            freeMargin: freeMargin,
            marginBase: marginBase,
            usingEquity: Number.isFinite(equity) && equity > 0
          });
        }
      }
    }
  } catch (e) {}

  if (!Number.isFinite(accountBalance) || accountBalance <= 0) {
    return res.status(503).json({ error: 'Could not fetch account balance - trade blocked for safety' });
  }

  // ── Step 6: Broker symbol spec (minVol, maxVol, volumeStep) ──
  // spec already declared before formatPrice - assigned here
  var minVolume  = 0.01;
  var maxVolume  = 10.0;
  var volumeStep = 0.01;
  try {
    var specRes = await fetchWithTimeout(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/symbols/' + symbol,
      { headers: { 'auth-token': TOKEN } },
      5000 // 5s - symbol spec (has safe defaults on timeout)
    );
    if (specRes.ok) {
      spec = await specRes.json(); // assigned to outer var
      if (Number.isFinite(Number(spec.minVolume)))  minVolume  = Number(spec.minVolume);
      if (Number.isFinite(Number(spec.maxVolume)))  maxVolume  = Number(spec.maxVolume);
      if (Number.isFinite(Number(spec.volumeStep))) volumeStep = Number(spec.volumeStep);
    }
  } catch (e) {
    // Symbol spec unavailable - using safe defaults (minVol=0.01, step=0.01)
    // This is acceptable but means lot sizing may not perfectly match broker constraints
  }
  // Recompute all formatted prices now that spec (and broker digits) are available
  fmtSL = formatPrice(symbol, sl);
  fmtTP = formatPrice(symbol, tp);
  fmtEN = formatPrice(symbol, execPrice); // recompute so Step 3 re-validation uses broker digits

  // volumeStep precision
  var stepDecimals = (volumeStep.toString().split('.')[1] || '').length;

  // ── Step 7: Final price recheck + slippage guard ──
  var finalExecPrice  = execPrice; // fallback to initial if recheck fails
  var finalSpread     = null;
  var finalSpreadPct  = null; // default to first fetch if recheck fails
  try {
    var reCheckRes = await fetchWithTimeout(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/symbols/' + symbol + '/current-price',
      { headers: { 'auth-token': TOKEN } },
      4000 // 4s - final recheck, tightest timeout
    );
    if (!reCheckRes.ok) {
      return res.status(502).json({ error: 'Final price recheck failed - trade blocked' });
    }
    var reCheckData = await reCheckRes.json();
    var rebid = Number(reCheckData.bid);
    var reask = Number(reCheckData.ask);
    if (!Number.isFinite(rebid) || !Number.isFinite(reask)) {
      return res.status(502).json({ error: 'Invalid data on final price recheck' });
    }
    finalExecPrice = direction === 'LONG' ? reask : rebid;

    // Slippage check
    var maxSlippagePct = symbol === 'BTCUSD' ? 0.0005 : symbol === 'XAUUSD.s' ? 0.0002 : 0.0001;
    var slippagePct = Math.abs(finalExecPrice - execPrice) / execPrice;
    if (slippagePct > maxSlippagePct) {
      auditLog('warn', 'SLIPPAGE_BLOCKED', { slippagePct, maxSlippagePct, symbol });
      return res.status(400).json({
        error: 'Slippage too high: ' + (slippagePct * 100).toFixed(4) + '% (max ' + (maxSlippagePct * 100).toFixed(4) + '%)',
        initialPrice: execPrice,
        finalPrice: finalExecPrice
      });
    }

    // Final spread recheck - spread can widen between initial fetch and execution
    finalSpread    = reask - rebid;
    var finalMid   = (rebid + reask) / 2;
    finalSpreadPct = (finalSpread / finalMid) * 100;
    if (finalSpreadPct > maxSpreadPct) {
      auditLog('warn', 'FINAL_SPREAD_BLOCKED', { finalSpreadPct, symbol });
      return res.status(400).json({
        error: 'Final spread too wide: ' + finalSpreadPct.toFixed(4) + '% (max ' + maxSpreadPct + '%)',
        initialSpreadPct: spreadPct,
        finalSpreadPct: finalSpreadPct
      });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Final price recheck error: ' + (e.message || 'unknown') });
  }

  // ── Step 8: Revalidate SL/TP against finalExecPrice ──
  var fmtFinalEN = formatPrice(symbol, finalExecPrice);
  if (direction === 'LONG') {
    if (fmtSL >= fmtFinalEN - tickTolerance) {
      auditLog('warn', 'SL_TP_INVALID_RECHECK', { check: 'LONG_SL_final', fmtSL, fmtFinalEN, symbol });
      return res.status(400).json({
        error: 'LONG: SL invalid after price recheck. SL=' + fmtSL + ' finalPrice=' + fmtFinalEN
      });
    }
    if (fmtTP <= fmtFinalEN + tickTolerance) {
      auditLog('warn', 'SL_TP_INVALID_RECHECK', { check: 'LONG_TP_final', fmtTP, fmtFinalEN, symbol });
      return res.status(400).json({
        error: 'LONG: TP invalid after price recheck. TP=' + fmtTP + ' finalPrice=' + fmtFinalEN
      });
    }
  }
  if (direction === 'SHORT') {
    if (fmtSL <= fmtFinalEN + tickTolerance) {
      auditLog('warn', 'SL_TP_INVALID_RECHECK', { check: 'SHORT_SL_final', fmtSL, fmtFinalEN, symbol });
      return res.status(400).json({
        error: 'SHORT: SL invalid after price recheck. SL=' + fmtSL + ' finalPrice=' + fmtFinalEN
      });
    }
    if (fmtTP >= fmtFinalEN - tickTolerance) {
      auditLog('warn', 'SL_TP_INVALID_RECHECK', { check: 'SHORT_TP_final', fmtTP, fmtFinalEN, symbol });
      return res.status(400).json({
        error: 'SHORT: TP invalid after price recheck. TP=' + fmtTP + ' finalPrice=' + fmtFinalEN
      });
    }
  }

  // ── Step 9: Recompute slDistance from finalExecPrice ──
  var slDistance = Math.abs(finalExecPrice - sl);
  if (slDistance <= 0) {
    return res.status(400).json({ error: 'SL distance is zero after final price recheck' });
  }

  // ── Step 9b: Broker stop-level validation ──
  // Brokers enforce a minimum stop distance - SL/TP closer than stopLevel will be rejected
  // stopLevel is in points (e.g. 50 = 5 pips for 5-digit forex broker)
  var stopLevel = Number(spec && spec.stopLevel || spec && spec.stopsLevel || 0);
  if (stopLevel > 0) {
    // Convert stop level from points to price distance
    var digits     = Number(spec && spec.digits || (symbol === 'BTCUSD' ? 2 : symbol === 'XAUUSD.s' ? 2 : 5));
    var pointSize  = Math.pow(10, -digits);
    var minStopDist = stopLevel * pointSize;

    var slDistFromPrice = Math.abs(finalExecPrice - fmtSL);
    var tpDistFromPrice = Math.abs(finalExecPrice - fmtTP);

    if (slDistFromPrice < minStopDist) {
      auditLog('warn', 'STOP_LEVEL_BLOCKED', { check: 'SL', slDistFromPrice, minStopDist, symbol });
      return res.status(400).json({
        error: 'SL too close to price: ' + slDistFromPrice.toFixed(digits) + ' (broker min: ' + minStopDist.toFixed(digits) + ')',
        stopLevel: stopLevel,
        minStopDist: minStopDist
      });
    }
    if (tpDistFromPrice < minStopDist) {
      auditLog('warn', 'STOP_LEVEL_BLOCKED', { check: 'TP', tpDistFromPrice, minStopDist, symbol });
      return res.status(400).json({
        error: 'TP too close to price: ' + tpDistFromPrice.toFixed(digits) + ' (broker min: ' + minStopDist.toFixed(digits) + ')',
        stopLevel: stopLevel,
        minStopDist: minStopDist
      });
    }
  }

  // ── Step 10: Risk-based lot sizing ──
  var riskPercent = 0.01;
  var riskAmount  = accountBalance * riskPercent;
  var volume      = minVolume; // safe fallback = broker minimum

  // Try broker-native sizing using symbol spec fields
  // contractSize = units per lot, tickValue = $ per tick per lot, tickSize = price per tick
  var contractSize = Number(spec && spec.contractSize);
  var tickValue    = Number(spec && spec.tickValue);
  var tickSize     = Number(spec && spec.tickSize);

  var calcVolume = null;

  if (Number.isFinite(contractSize) && contractSize > 0 &&
      Number.isFinite(tickValue)    && tickValue > 0 &&
      Number.isFinite(tickSize)     && tickSize > 0) {
    // Fully broker-derived: riskAmount / (slDistance / tickSize * tickValue)
    var ticksInSL   = slDistance / tickSize;
    var riskPerLot  = ticksInSL * tickValue;
    calcVolume = riskPerLot > 0 ? riskAmount / riskPerLot : null;
    // Sanity check broker fields look reasonable
    var sizingLooksSuspicious = calcVolume > 10 || calcVolume < 0.001;
    auditLog(sizingLooksSuspicious ? 'warn' : 'info', 'SIZING_BROKER_NATIVE', {
      contractSize, tickValue, tickSize, calcVolume,
      suspicious: sizingLooksSuspicious
    });
    if (sizingLooksSuspicious) calcVolume = null; // reject suspicious calc, use fallback
  } else {
    // Fallback: verified hardcoded assumptions per instrument
    // These match PU Prime contract specs as manually verified
    if (instrument === 'GBPUSD') {
      // Standard forex: pip=0.0001, ~$10/pip/lot (USD account)
      calcVolume = riskAmount / ((slDistance / 0.0001) * 10);
    } else if (instrument === 'XAUUSD') {
      // Gold: 100oz contract, $1 move = $100/lot
      calcVolume = riskAmount / (slDistance * 100);
    } else if (instrument === 'BTCUSDT') {
      // BTC: 1 BTC contract, $1 move = $1/lot
      calcVolume = riskAmount / slDistance;
    }
    auditLog('info', 'SIZING_HARDCODED_FALLBACK', { instrument, calcVolume });
  }

  // Safety caps per instrument then round to broker volumeStep
  var maxCap = instrument === 'XAUUSD' ? 0.50 : 0.10;
  if (calcVolume && Number.isFinite(calcVolume) && calcVolume > 0) {
    volume = Math.round(
      Math.min(Math.max(calcVolume, minVolume), Math.min(maxCap, maxVolume))
      / volumeStep
    ) * volumeStep;
    volume = parseFloat(volume.toFixed(stepDecimals));
  }

  // ── Step 10b: Distributed idempotency via Redis SETNX ──
  // Atomic: only one instance can hold the key at a time
  var reqKey = [
    body.instrument,
    body.direction,
    body.stopLoss,
    body.takeProfit,
    body.signalId || body.signalTimestamp || ''
  ].join(':');
  var redisKey = 'qbot:idem:' + reqKey;
  try {
    // SET key value EX ttl NX - returns null if key already exists
    if (!redis) throw new Error('Redis not configured');
    var acquired = await redis.set(redisKey, '1', { ex: IDEMPOTENCY_TTL_SEC, nx: true });
    if (!acquired) {
      auditLog('warn', 'IDEMPOTENCY_BLOCKED', { instrument, direction, reqKey });
      return res.status(429).json({ error: 'Duplicate request blocked: same order within ' + IDEMPOTENCY_TTL_SEC + 's' });
    }
  } catch (redisErr) {
    auditLog('warn', 'IDEMPOTENCY_REDIS_UNAVAILABLE', { error: redisErr.message });
    // Policy: fail closed on live accounts, fail open on demo
    // ACCOUNT_MODE must be explicitly set - no silent default
    var accountMode = process.env.ACCOUNT_MODE;
    if (!accountMode) {
      auditLog('error', 'ACCOUNT_MODE_NOT_SET', {});
      return res.status(503).json({ error: 'ACCOUNT_MODE env var not set - cannot determine fail policy' });
    }
    var isDemo = accountMode === 'demo';
    if (!isDemo) {
      return res.status(503).json({ error: 'Idempotency check unavailable - trade blocked on live account' });
    }
    // Demo mode: log and continue
  }

  // ── Step 11: Send order to broker ──
  // NOTE: No auto-retry on order submission.
  // Retrying orders without distributed idempotency risks duplicate fills.
  // Retry only when Redis SETNX idempotency is in place.

  // Create orderTag once - used in comment AND reconciliation
  // Guarantees exact match is always possible regardless of caller input
  var orderTag = 'QuantumBot:' + (body.signalId || body.signalTimestamp || String(Date.now()));

  try {
    var r = await fetchWithTimeout(
      'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/trade',
      {
        method: 'POST',
        headers: { 'auth-token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: actionType,
          symbol:     symbol,
          volume:     volume,
          stopLoss:   fmtSL,
          takeProfit: fmtTP,
          comment:    orderTag
        })
      },
      10000 // 10s - order submission, give broker more time
    );

    var data;
    try { data = await r.json(); } catch (e) { data = { error: 'Invalid JSON from broker' }; }

    if (!r.ok) {
      try { if (redis) await redis.del(redisKey); } catch(e) {}
      auditLog('error', 'BROKER_REJECTED', { symbol, direction, volume, status: r.status, brokerMsg: data && (data.message || data.error) });
      return res.status(r.status).json({
        success: false,
        error: (data && (data.message || data.error)) || 'Trade failed',
        data: data
      });
    }

    // Verify broker actually opened a position (not a silent rejection)
    var hasOrder = data && (data.orderId || data.positionId);
    if (!hasOrder) {
      try { if (redis) await redis.del(redisKey); } catch(e) {} // release lock - no order executed
      return res.status(200).json({
        success: false,
        error: 'Broker returned 200 but no orderId/positionId - order may not have executed',
        data: data
      });
    }

    auditLog('info', 'ORDER_PLACED', { symbol, direction, volume, execPrice: finalExecPrice, orderId: data.orderId || data.positionId });
    return res.status(200).json({
      success:        true,
      data:           data,
      volume:         volume,
      riskAmount:     riskAmount,
      accountBalance: accountBalance,
      execPrice:      finalExecPrice,
      initialSpread:  spread,
      finalSpread:    finalSpread,
      finalSpreadPct: finalSpreadPct,
      orderId:        data.orderId || data.positionId
    });

  } catch (e) {
    var isTimeout = e.message && e.message.indexOf('timed out') >= 0;
    auditLog('error', isTimeout ? 'ORDER_TIMEOUT' : 'ORDER_ERROR', { symbol, direction, error: e.message });

    if (!isTimeout) {
      // Non-timeout error - safe to release key and return failure
      try { if (redis) await redis.del(redisKey); } catch(e) {}
      return res.status(500).json({ success: false, error: e.message || 'Unknown error' });
    }

    // ── Timeout reconciliation ──
    // Order may have filled despite timeout. Query broker before returning.
    try {
      var reconRes = await fetchWithTimeout(
        'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/positions',
        { headers: { 'auth-token': TOKEN } },
        6000 // 6s reconciliation check
      );
      if (reconRes.ok) {
        var reconRaw  = await reconRes.json();
        var reconList = Array.isArray(reconRaw) ? reconRaw
          : Array.isArray(reconRaw && reconRaw.positions) ? reconRaw.positions : [];

        var normalizedR = normalizeSymbol(symbol);

        // Primary: match by QuantumBot comment + symbol + direction
        var filled = reconList.find(function(p) {
          var pBase = normalizeSymbol(p.symbol);
          var correctDir  = direction === 'LONG' ? p.type === 'POSITION_TYPE_BUY' : p.type === 'POSITION_TYPE_SELL';
          var exactComment   = (p.comment || '') === orderTag;
          var openedRecently = p.time ? (Date.now() - new Date(p.time).getTime() < 30000) : true;
          return pBase === normalizedR && correctDir && exactComment && openedRecently;
        });

        // Fallback: check recent deals if positions didn't match
        if (!filled) {
          try {
            var dealsRes = await fetchWithTimeout(
              'https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID + '/history-deals/time/' +
              new Date(Date.now() - 60000).toISOString() + '/' + new Date().toISOString(),
              { headers: { 'auth-token': TOKEN } },
              5000
            );
            if (dealsRes.ok) {
              var dealsRaw  = await dealsRes.json();
              var dealsList = Array.isArray(dealsRaw) ? dealsRaw : (dealsRaw && dealsRaw.deals) || [];
              filled = dealsList.find(function(d) {
                  var dBase = normalizeSymbol(d.symbol);
                var dDir  = direction === 'LONG' ? d.type === 'DEAL_TYPE_BUY' : d.type === 'DEAL_TYPE_SELL';
                var exactDComment = (d.comment || '') === orderTag;
                return dBase === normalizedR && dDir && exactDComment;
              });
            }
          } catch (dealErr) {}
        }

        if (filled) {
          // Determine if match came from position or deal
          var reconSource  = filled.positionId ? 'deal' : 'position';
          var reconPosId   = filled.positionId || filled.id;
          var reconDealId  = filled.positionId ? filled.id : undefined;
          auditLog('info', 'ORDER_TIMEOUT_RECONCILED_FILLED', {
            symbol, direction, reconSource, positionId: reconPosId
          });
          // Key stays set - order did fill, block retries
          return res.status(200).json({
            success:              true,
            executionState:       'TIMEOUT_BUT_FILLED',
            reconciliationSource: reconSource,
            positionId:           reconPosId,
            dealId:               reconDealId,
            volume:               filled.volume || volume,
            accountBalance:       accountBalance
          });
        }
      }
    } catch (reconErr) {
      auditLog('error', 'ORDER_TIMEOUT_RECONCILIATION_FAILED', { symbol, error: reconErr.message });
    }

    // Reconciliation found nothing - state is genuinely unknown
    try { if (redis) await redis.del(redisKey); } catch(e) {} // release Redis lock - allow manual retry
    auditLog('warn', 'ORDER_TIMEOUT_UNKNOWN_STATE', { symbol, direction });
    return res.status(202).json({
      success:        false,
      executionState: 'UNKNOWN_REQUIRES_RECONCILIATION',
      error:          'Order timed out and position not confirmed. Check MT5 manually.',
      symbol:         symbol,
      direction:      direction
    });
  }
};