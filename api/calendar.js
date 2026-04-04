/* eslint-disable */
// api/calendar.js - Economic calendar via Twelve Data (server-side)
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY;
  if (!TWELVE_DATA_KEY) {
    return res.status(500).json({ error: 'Missing TWELVE_DATA_KEY', events: [] });
  }

  try {
    const today    = new Date().toISOString().split('T')[0];
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await fetch(
      `https://api.twelvedata.com/economic_calendar?start_date=${today}&end_date=${nextWeek}&importance=high&apikey=${TWELVE_DATA_KEY}`
    );

    if (!response.ok) {
      const text = await response.text();
      // Calendar unavailable - return empty and let frontend pause trading
      return res.status(response.status).json({
        error: text || 'Failed to fetch calendar',
        events: [],
        source: 'unavailable'
      });
    }

    const data = await response.json();
    const rawEvents = data.result?.list || data.data || [];

    if (!Array.isArray(rawEvents)) {
      return res.status(502).json({
        error: 'Unexpected calendar response format',
        events: [],
        source: 'unavailable'
      });
    }

    const events = rawEvents
      .map(e => ({
        name:       e.event || e.name || 'Unknown event',
        date:       e.date  || e.datetime || null,
        country:    e.country || e.country_code || 'N/A',
        importance: e.importance || e.impact || 'unknown',
        actual:     e.actual   ?? null,
        forecast:   e.forecast ?? null,
        previous:   e.previous ?? null,
      }))
      .filter(e => e.date && !Number.isNaN(new Date(e.date).getTime()));

    return res.status(200).json({ events, count: events.length, source: 'twelvedata' });

  } catch(e) {
    // On any failure return empty - safer to pause than to invent events
    return res.status(503).json({
      error: e.message || 'Calendar service unavailable',
      events: [],
      source: 'unavailable'
    });
  }
};