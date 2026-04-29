/* eslint-disable */
// api/history.js -- Closed deals from PU Prime via MetaAPI.
// CRITICAL FIX: DEAL_ENTRY_OUT deals have INVERTED types vs the original position.
// When you SELL to open, and later close, MetaAPI records the closing deal as DEAL_TYPE_BUY.
// We invert on DEAL_ENTRY_OUT so the displayed direction matches the original position side.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', deals: [] });
  }

  const TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;

  if (!TOKEN || !ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing env vars', deals: [] });
  }

  try {
    const now = new Date();
    const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString();
    const toStr = now.toISOString();
    const region = process.env.META_REGION || 'london';
    const baseUrl = 'https://mt-client-api-v1.' + region + '.agiliumtrade.ai/users/current/accounts/' + ACCOUNT_ID;

    const url = baseUrl + '/history-deals/time/' + encodeURIComponent(fromStr) + '/' + encodeURIComponent(toStr);

    const r = await fetch(url, { method: 'GET', headers: { 'auth-token': TOKEN } });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({
        deals: [],
        trades: [],
        error: (text || 'Failed to fetch history').slice(0, 500),
      });
    }

    const data = await r.json();
    const raw = Array.isArray(data) ? data : ((data && data.deals) || []);

    // V10 DIAGNOSTIC: capture stats on the raw response BEFORE filtering
    const rawSorted = [...raw].sort((a, b) => new Date(b.time || b.brokerTime || 0) - new Date(a.time || a.brokerTime || 0));
    const rawCount = raw.length;
    const rawLatestTime = rawSorted.length > 0 ? (rawSorted[0].time || rawSorted[0].brokerTime) : null;
    const rawTypes = {};
    const rawEntryTypes = {};
    for (const d of raw) {
      rawTypes[d.type || 'null'] = (rawTypes[d.type || 'null'] || 0) + 1;
      rawEntryTypes[d.entryType || 'null'] = (rawEntryTypes[d.entryType || 'null'] || 0) + 1;
    }

    // V10: also pull history-orders -- gives us a parallel view in case deals lag
    let ordersInfo = null;
    try {
      const orderUrl = baseUrl + '/history-orders/time/' + encodeURIComponent(fromStr) + '/' + encodeURIComponent(toStr);
      const oR = await fetch(orderUrl, { headers: { 'auth-token': TOKEN } });
      if (oR.ok) {
        const oRaw = await oR.json();
        const oArr = Array.isArray(oRaw) ? oRaw : ((oRaw && oRaw.historyOrders) || []);
        ordersInfo = {
          count: oArr.length,
          latest: oArr.length > 0 ? oArr.sort((a, b) => new Date(b.doneTime || b.time) - new Date(a.doneTime || a.time))[0].doneTime || oArr[0].time : null,
        };
      }
    } catch (_) {}

    const deals = raw
      .filter(function (d) {
        return d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL';
      })
      .filter(function (d) {
        return d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_INOUT';
      })
      .map(function (d) {
        // Fix: closing deals report the OPPOSITE type of the original position.
        // A SELL position closes with a DEAL_TYPE_BUY.
        // A BUY  position closes with a DEAL_TYPE_SELL.
        // So for DEAL_ENTRY_OUT we invert to show the original side.
        var rawType = d.type;
        var positionSide;
        if (d.entryType === 'DEAL_ENTRY_OUT') {
          positionSide = rawType === 'DEAL_TYPE_BUY' ? 'SELL' : 'BUY';
        } else {
          // DEAL_ENTRY_INOUT (hedged close or partial): rare, treat as same side
          positionSide = rawType === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';
        }

        return {
          id:         d.id || d.dealId || null,
          symbol:     d.symbol || '',
          type:       positionSide,                 // display side (matches MT5 position)
          rawDealType: rawType,                     // kept for debugging if needed
          entryType:  d.entryType || null,
          volume:     Number(d.volume || 0),
          openPrice:  null,
          closePrice: Number(d.price || 0),
          price:      Number(d.price || 0),         // alias for old UI code
          profit:     Number(d.profit || 0),
          commission: Number(d.commission || 0),
          swap:       Number(d.swap || 0),
          time:       d.time || d.brokerTime || null,
          comment:    d.comment || '',
        };
      })
      .sort(function (a, b) {
        return new Date(b.time) - new Date(a.time);
      });

    return res.status(200).json({
      deals: deals,
      trades: deals,                      // V10: alias, frontend may read either
      count: deals.length,
      source: 'puprime',
      fetchedFrom: fromStr,               // diagnostic
      fetchedTo:   toStr,
      latestDealTime: deals.length > 0 ? deals[0].time : null,
      ordersInfo,                         // V10: parallel view from history-orders endpoint
      // V10 DIAGNOSTIC: tells us if filter is dropping recent deals or MetaAPI doesn't have them
      diagnostic: {
        rawCount,
        rawLatestTime,
        filteredCount: deals.length,
        filteredLatestTime: deals.length > 0 ? deals[0].time : null,
        rawTypes,
        rawEntryTypes,
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