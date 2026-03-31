/* eslint-disable */
// api/calendar.js - Economic calendar via Twelve Data (server-side)
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY || '7a56659902cd4756a8a65068af305db4';

  try {
    const today = new Date().toISOString().split('T')[0];
    const nextWeek = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];

    const response = await fetch(
      `https://api.twelvedata.com/economic_calendar?start_date=${today}&end_date=${nextWeek}&importance=high&apikey=${TWELVE_DATA_KEY}`
    );
    const data = await response.json();
    const events = (data.result?.list || []).map(e => ({
      name: e.event,
      date: e.date,
      country: e.country,
      importance: e.importance,
      actual: e.actual,
      forecast: e.forecast,
      previous: e.previous,
    }));
    return res.status(200).json({ events, count: events.length });
  } catch(e) {
    // Return fallback hardcoded major events if API fails
    const fallback = [
      { name: "Fed Interest Rate Decision", date: new Date(Date.now() + 2*24*60*60*1000).toISOString(), country: "US", importance: "high", forecast: "5.25%", previous: "5.25%" },
      { name: "US Non-Farm Payrolls", date: new Date(Date.now() + 3*24*60*60*1000).toISOString(), country: "US", importance: "high", forecast: "180K", previous: "175K" },
      { name: "UK CPI Inflation", date: new Date(Date.now() + 4*24*60*60*1000).toISOString(), country: "GB", importance: "high", forecast: "3.1%", previous: "3.4%" },
      { name: "US CPI Inflation", date: new Date(Date.now() + 5*24*60*60*1000).toISOString(), country: "US", importance: "high", forecast: "3.2%", previous: "3.1%" },
    ];
    return res.status(200).json({ events: fallback, count: fallback.length, source: 'fallback' });
  }
};