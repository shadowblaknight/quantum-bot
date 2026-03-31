/* eslint-disable */
// api/news.js - Server-side news fetching (bypasses NewsAPI CORS restriction)
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const NEWS_API_KEY = process.env.NEWS_API_KEY || 'a953ce48e4534a9ab1c5fec3031268dd';

  try {
    const queries = [
      { q: 'GBP USD forex pound sterling', inst: 'GBPUSD' },
      { q: 'Bitcoin BTC crypto cryptocurrency', inst: 'BTCUSDT' },
      { q: 'gold XAU commodity precious metals', inst: 'XAUUSD' },
    ];

    const results = await Promise.all(queries.map(({ q }) =>
      fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&pageSize=3&sortBy=publishedAt&language=en&apiKey=${NEWS_API_KEY}`)
        .then(r => r.json())
        .catch(() => ({ articles: [] }))
    ));

    const allNews = results.flatMap((r, i) =>
      (r.articles || []).slice(0, 3).map(a => ({
        title: a.title || '',
        source: a.source?.name || 'Unknown',
        time: a.publishedAt ? new Date(a.publishedAt).toLocaleTimeString() : '',
        url: a.url || '',
        inst: queries[i].inst,
      }))
    );

    return res.status(200).json({ articles: allNews, count: allNews.length });
  } catch (e) {
    console.error('News fetch error:', e);
    return res.status(500).json({ error: e.message, articles: [] });
  }
};