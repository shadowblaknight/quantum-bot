/* eslint-disable */
// V10 — api/history.js
// Closed deals from PU Prime via MetaAPI.
//
// CRITICAL: MetaAPI's history-deals/time/{from}/{to} endpoint caps response at 1000 deals.
// If your account has >1000 deals in the requested window, MetaAPI returns the OLDEST 1000
// and silently drops everything more recent. With high-frequency trading (TP ladder = 4 deals
// per position) you blow past 1000 in a few weeks.
//
// Fix: walk backwards in time. Fetch most-recent N-day window first; if it returns exactly
// 1000 (window saturated), split it in half and recurse. Result: complete coverage of the
// configured window with no silent drops.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', deals: [] });

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
  if (!TOKEN || !ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars', deals: [] });

  const region = process.env.META_REGION || 'london';
  const baseUrl = 'https://mt-client-api-v1.' + region + '.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID;
  const HEADERS = { 'auth-token': TOKEN };

  // Time window — default 90 days, override via ?days=N
  const totalDays = Math.max(1, Math.min(365, parseInt(req.query.days || '90', 10)));
  const now = new Date();
  const oldest = new Date(now.getTime() - totalDays * 86400 * 1000);

  // Fetch a single window. Returns { deals, saturated, error }
  // saturated=true means MetaAPI returned exactly 1000 and we likely missed records.
  async function fetchWindow(fromDate, toDate) {
    const url = baseUrl + '/history-deals/time/' + encodeURIComponent(fromDate.toISOString()) + '/' + encodeURIComponent(toDate.toISOString());
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { deals: [], saturated: false, error: r.status + ': ' + txt.slice(0, 200) };
      }
      const data = await r.json();
      const deals = Array.isArray(data) ? data : ((data && data.deals) || []);
      return { deals, saturated: deals.length >= 1000, error: null };
    } catch (e) {
      return { deals: [], saturated: false, error: e && e.message };
    }
  }

  // Recursive splitter: when a window saturates, split in half and fetch each half.
  const minSpanMs = 6 * 60 * 60 * 1000; // 6 hours minimum chunk
  let totalApiCalls = 0;
  let saturatedWindows = 0;
  const allRaw = [];
  const seenIds = new Set();

  async function fetchRange(fromDate, toDate, depth) {
    if (totalApiCalls >= 30) return;          // hard cap to protect Vercel timeout
    if (depth > 6) return;                    // hard cap on recursion depth
    totalApiCalls++;
    const result = await fetchWindow(fromDate, toDate);
    if (result.error) return;
    const span = toDate.getTime() - fromDate.getTime();
    if (result.saturated && span > minSpanMs) {
      // Window is full -- split in half and re-query each half
      saturatedWindows++;
      const mid = new Date(fromDate.getTime() + span / 2);
      // Recent first (more interesting), older second
      await fetchRange(mid, toDate, depth + 1);
      await fetchRange(fromDate, mid, depth + 1);
    } else {
      // Window fits -- collect deals (dedup by id)
      for (const d of result.deals) {
        const id = d.id || d.dealId;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          allRaw.push(d);
        }
      }
    }
  }

  try {
    await fetchRange(oldest, now, 0);

    // Diagnostic stats on raw collection
    const rawCount = allRaw.length;
    const rawSorted = [...allRaw].sort((a, b) => new Date(b.time || b.brokerTime || 0) - new Date(a.time || a.brokerTime || 0));
    const rawLatestTime = rawSorted.length > 0 ? (rawSorted[0].time || rawSorted[0].brokerTime) : null;
    const rawTypes = {};
    const rawEntryTypes = {};
    for (const d of allRaw) {
      rawTypes[d.type || 'null'] = (rawTypes[d.type || 'null'] || 0) + 1;
      rawEntryTypes[d.entryType || 'null'] = (rawEntryTypes[d.entryType || 'null'] || 0) + 1;
    }

    // Filter to closing deals, invert type for display side
    const deals = allRaw
      .filter((d) => d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL')
      .filter((d) => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT')
      .map((d) => {
        const rawType = d.type;
        let positionSide;
        if (d.entryType === 'DEAL_ENTRY_OUT') {
          positionSide = rawType === 'DEAL_TYPE_BUY' ? 'SELL' : 'BUY';
        } else {
          positionSide = rawType === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';
        }
        return {
          id:          d.id || d.dealId || null,
          symbol:      d.symbol || '',
          type:        positionSide,
          rawDealType: rawType,
          entryType:   d.entryType || null,
          volume:      Number(d.volume || 0),
          openPrice:   null,
          closePrice:  Number(d.price || 0),
          price:       Number(d.price || 0),
          profit:      Number(d.profit || 0),
          commission:  Number(d.commission || 0),
          swap:        Number(d.swap || 0),
          time:        d.time || d.brokerTime || null,
          comment:     d.comment || '',
        };
      })
      .sort((a, b) => new Date(b.time) - new Date(a.time));

    return res.status(200).json({
      deals,
      trades: deals,
      count: deals.length,
      source: 'puprime',
      fetchedFrom: oldest.toISOString(),
      fetchedTo:   now.toISOString(),
      latestDealTime: deals.length > 0 ? deals[0].time : null,
      diagnostic: {
        rawCount,
        rawLatestTime,
        filteredCount: deals.length,
        filteredLatestTime: deals.length > 0 ? deals[0].time : null,
        rawTypes,
        rawEntryTypes,
        totalApiCalls,
        saturatedWindows,
        windowDays: totalDays,
      },
    });
  } catch (e) {
    return res.status(500).json({
      deals: [],
      trades: [],
      error: e && e.message ? e.message : 'Unknown server error',
    });
  }
};