'use strict';

const https = require('https');
const { getRedis } = require('./_lib');

const CACHE_KEY = 'v20:news:ff:week';
const CACHE_TTL = 30 * 60;          // 30 minutes in seconds
const FF_URL    = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const WINDOW_MS = 60 * 60 * 1000;   // ±1 hour in ms

// Map specialist template → currency pair to watch
const TEMPLATE_CURRENCY = {
  'gold-specialist':    'USD',
  'gold-specialist-2':  'USD',
  'nas100-specialist':  'USD',
  'ger40-bg-specialist':'EUR',
};

function _fetchFF() {
  return new Promise((resolve, reject) => {
    const req = https.get(FF_URL, { timeout: 4000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ff-timeout')); });
  });
}

// Returns cached calendar array or fetches fresh; null on any failure.
async function _getCalendar() {
  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
  }
  const events = await _fetchFF();
  if (r && Array.isArray(events)) {
    r.set(CACHE_KEY, JSON.stringify(events), { ex: CACHE_TTL }).catch(() => {});
  }
  return Array.isArray(events) ? events : null;
}

// FF JSON uses "High" / "Medium" / "Low" strings; also guard numeric 3 just in case.
function _isHigh(impact) {
  return impact === 'High' || impact === 3 || impact === '3';
}

/**
 * Returns { canTrade: true } or { canTrade: false, reason, event, currency, evTime }.
 * Always resolves — never rejects. Fail-open: any error → canTrade: true.
 *
 * @param {string} template  - e.g. 'gold-specialist-2'
 * @param {number} [nowMs]   - override for testing (defaults to Date.now())
 */
async function checkNewsBlock(template, nowMs) {
  try {
    const currency = TEMPLATE_CURRENCY[template];
    if (!currency) return { canTrade: true };

    // Hard 3-second deadline — keeps webhook fast even if FF is slow.
    const events = await Promise.race([
      _getCalendar(),
      new Promise((res) => setTimeout(() => res(null), 3000)),
    ]);
    if (!events) return { canTrade: true };

    const now = nowMs || Date.now();
    for (const ev of events) {
      if (!_isHigh(ev.impact)) continue;
      // FF JSON uses 'country' for the currency code (e.g. "USD"), fallback to 'currency'.
      const evCcy = (ev.country || ev.currency || '').toUpperCase();
      if (evCcy !== currency) continue;
      const evTime = ev.date ? new Date(ev.date).getTime() : NaN;
      if (isNaN(evTime)) continue;
      if (Math.abs(now - evTime) <= WINDOW_MS) {
        return {
          canTrade: false,
          reason:   'news-block',
          event:    ev.title || 'high-impact-event',
          currency,
          evTime:   new Date(evTime).toISOString(),
        };
      }
    }
    return { canTrade: true };
  } catch (_) {
    return { canTrade: true }; // fail-open
  }
}

module.exports = { checkNewsBlock };
