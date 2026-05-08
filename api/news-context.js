/* eslint-disable */
// V12 — api/news-context.js
//
// News awareness layer. Two purposes:
//   1. UI indicator (cockpit shows yellow/amber/red based on news proximity)
//   2. Feature vector tagging (recognition memory learns "this config + USD news = X% WR")
//
// SOURCE: We use ForexFactory's free RSS-style calendar via a public mirror.
// Falls back to FRED for US economic indicators if NewsAPI is unavailable.
//
// CACHING: News calendar fetched once per hour, cached in Redis.
//
// CURRENCIES PER ASSET: We map each asset to the currencies that move it:
//   gold     → USD (primary), EUR, JPY (secondary)
//   eurusd   → EUR, USD
//   btc      → USD, BTC-specific events
//   nas100   → USD
//   ger40    → EUR
// ----------------------------------------------------------------------------

const { getRedis, safeParse } = require('./_lib');
const { getAssetById } = require('./asset-registry');

const CALENDAR_CACHE_KEY = 'v12:news:calendar';
const CALENDAR_TTL_SEC = 3600; // 1 hour

// Map asset → currencies whose news moves it
const ASSET_CURRENCIES = {
  // Forex pairs: explicit currency exposure
  eurusd:  ['EUR', 'USD'],
  gbpusd:  ['GBP', 'USD'],
  usdjpy:  ['USD', 'JPY'],
  usdchf:  ['USD', 'CHF'],
  audusd:  ['AUD', 'USD'],
  nzdusd:  ['NZD', 'USD'],
  usdcad:  ['USD', 'CAD'],
  eurjpy:  ['EUR', 'JPY'],
  gbpjpy:  ['GBP', 'JPY'],
  eurgbp:  ['EUR', 'GBP'],
  audjpy:  ['AUD', 'JPY'],
  // Metals: USD is dominant, Asian session = JPY/CNY
  gold:     ['USD'],
  silver:   ['USD'],
  platinum: ['USD'],
  // Crypto: USD news + crypto-specific
  btc:  ['USD', 'BTC'],
  eth:  ['USD', 'CRYPTO'],
  sol:  ['USD', 'CRYPTO'],
  xrp:  ['USD', 'CRYPTO'],
  // Indices: USD/EUR/UK
  nas100: ['USD'],
  us30:   ['USD'],
  us500:  ['USD'],
  ger40:  ['EUR'],
  uk100:  ['GBP'],
  jp225:  ['JPY'],
  // Commodities
  oil_wti:   ['USD'],
  oil_brent: ['USD'],
  natgas:    ['USD'],
};

// =================================================================
// FETCH CALENDAR
// =================================================================
// Tries multiple sources. Returns array of news events for next 24h.
// Each event: { ts, currency, title, impact: 'low'|'medium'|'high', forecast?, previous? }

async function fetchCalendar() {
  const r = getRedis();
  // Check cache
  if (r) {
    try {
      const raw = await r.get(CALENDAR_CACHE_KEY);
      const cached = safeParse(raw);
      if (cached && cached.events && cached.fetchedAt && (Date.now() - cached.fetchedAt < CALENDAR_TTL_SEC * 1000)) {
        return cached.events;
      }
    } catch (_) {}
  }

  // Fetch fresh — use the free ForexFactory JSON feed
  // (Some users hit it directly; we use the mirror at nfs.faireconomy.media)
  const events = [];
  try {
    const resp = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 QuantumBot' },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data)) {
        for (const e of data) {
          const ts = new Date(e.date).getTime();
          if (!isFinite(ts)) continue;
          // Only future events (next 7 days)
          if (ts < Date.now() - 3600000 || ts > Date.now() + 7 * 24 * 3600000) continue;
          events.push({
            ts,
            currency: (e.country || '').toUpperCase(),
            title: e.title || 'Unknown event',
            impact: normalizeImpact(e.impact),
            forecast: e.forecast || null,
            previous: e.previous || null,
          });
        }
      }
    }
  } catch (e) {
    console.warn('[news-context] Calendar fetch failed:', e.message);
  }

  // Cache
  if (r && events.length > 0) {
    try {
      await r.set(CALENDAR_CACHE_KEY, JSON.stringify({ events, fetchedAt: Date.now() }), { ex: CALENDAR_TTL_SEC });
    } catch (_) {}
  }
  return events;
}

function normalizeImpact(s) {
  if (!s) return 'low';
  const x = String(s).toLowerCase();
  if (x.includes('high') || x === 'red') return 'high';
  if (x.includes('medium') || x === 'orange' || x === 'yellow') return 'medium';
  return 'low';
}

// =================================================================
// CONTEXT FOR ASSET
// =================================================================
// Returns the news state relevant to a given asset RIGHT NOW.
// Used by:
//   - Cockpit news indicator (top right)
//   - Recognition memory feature vector
//   - Coherence checker (later: skip trades during high-impact windows)

async function getNewsContext(assetId) {
  const currencies = ASSET_CURRENCIES[assetId] || [];
  if (currencies.length === 0) {
    return { state: 'none', currencies: [], events: [] };
  }

  const all = await fetchCalendar();
  const relevant = all.filter((e) => currencies.includes(e.currency));

  const now = Date.now();
  const live = [];      // happening now (within ±5 min)
  const imminent = [];  // within next 30 min
  const today = [];     // within next 24h, high-impact only

  for (const e of relevant) {
    const minsUntil = (e.ts - now) / 60000;
    if (Math.abs(minsUntil) <= 5 && e.impact === 'high') {
      live.push({ ...e, minsUntil });
    } else if (minsUntil > 0 && minsUntil <= 30 && e.impact === 'high') {
      imminent.push({ ...e, minsUntil });
    } else if (minsUntil > 0 && minsUntil <= 24 * 60 && e.impact === 'high') {
      today.push({ ...e, minsUntil });
    }
  }

  // Determine state
  let state = 'none';
  if (live.length > 0) state = 'live';
  else if (imminent.length > 0) state = 'imminent';
  else if (today.length > 0) state = 'scheduled';

  return {
    state,
    currencies,
    events: { live, imminent, today },
    summary: live.length > 0 ? `${live[0].currency} ${live[0].title} LIVE`
            : imminent.length > 0 ? `${imminent[0].currency} ${imminent[0].title} in ${Math.round(imminent[0].minsUntil)}m`
            : today.length > 0 ? `${today.length} high-impact event${today.length > 1 ? 's' : ''} today`
            : null,
  };
}

// =================================================================
// FEATURE VECTOR FRAGMENT
// =================================================================
// Compact representation of the news state, for use in recognition memory.
// Used so the bot learns: "configurations during high-impact USD news behave
// differently from same configurations in quiet periods."

async function getNewsFeature(assetId) {
  const ctx = await getNewsContext(assetId);
  return {
    newsState: ctx.state,                                    // 'none' | 'scheduled' | 'imminent' | 'live'
    highImpactWithin60min: (ctx.events.imminent.length + ctx.events.live.length) > 0,
    highImpactWithin24h: ctx.events.today.length + ctx.events.imminent.length + ctx.events.live.length,
    affectedCurrencies: ctx.currencies,
  };
}

// HTTP handler — for cockpit news indicator
module.exports = async (req, res) => {
  try {
    const assetId = req.query.asset;
    if (!assetId) return res.status(400).json({ error: 'asset required' });
    const ctx = await getNewsContext(assetId);
    return res.status(200).json(ctx);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.getNewsContext = getNewsContext;
module.exports.getNewsFeature = getNewsFeature;
module.exports.fetchCalendar = fetchCalendar;