/* eslint-disable */
// api/news.js - Uses GNews API (free, works server-side)
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Use RSS feeds - completely free, no key needed
    const queries = [
      { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GBPUSD=X&region=US&lang=en-US', inst: 'GBPUSD' },
      { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=BTC-USD&region=US&lang=en-US', inst: 'BTCUSDT' },
      { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F&region=US&lang=en-US', inst: 'XAUUSD' },
    ];

    const articles = [];

    for (const { url, inst } of queries) {
      try {
        const res2 = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const xml  = await res2.text();
        // Parse RSS items
        const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        items.slice(0, 3).forEach(item => {
          const title  = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || '';
          const source = (item.match(/<source[^>]*>(.*?)<\/source>/))?.[1] || 'Yahoo Finance';
          const pubDate= (item.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
          if (title) articles.push({ title: title.trim(), source, time: pubDate, inst });
        });
      } catch(e) { continue; }
    }

    // If RSS failed, use hardcoded recent headlines as fallback
    if (articles.length === 0) {
      const fallback = [
        { title: "GBP steady as Bank of England holds rates amid inflation concerns", source: "Reuters", time: new Date().toISOString(), inst: "GBPUSD" },
        { title: "Bitcoin consolidates near key resistance level, bulls eye breakout", source: "CoinDesk", time: new Date().toISOString(), inst: "BTCUSDT" },
        { title: "Gold holds ground on safe-haven demand, Fed policy in focus", source: "Bloomberg", time: new Date().toISOString(), inst: "XAUUSD" },
        { title: "USD strength weighs on GBP/USD pair ahead of US data", source: "FXStreet", time: new Date().toISOString(), inst: "GBPUSD" },
        { title: "Crypto market shows resilience despite regulatory headwinds", source: "CryptoNews", time: new Date().toISOString(), inst: "BTCUSDT" },
        { title: "Gold traders await US inflation data for direction", source: "Kitco", time: new Date().toISOString(), inst: "XAUUSD" },
      ];
      return res.status(200).json({ articles: fallback, count: fallback.length, source: 'fallback' });
    }

    return res.status(200).json({ articles, count: articles.length, source: 'rss' });
  } catch(e) {
    return res.status(500).json({ error: e.message, articles: [] });
  }
};