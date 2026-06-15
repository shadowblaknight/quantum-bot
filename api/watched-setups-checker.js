/* eslint-disable */
// api/watched-setups-checker.js  (Pilot Dashboard v1.2 — v14 template labels)
const { getActiveWatched, updateWatchedSetup, pruneExpired, priceInZone } = require('./watched-setups');
const { fetchCandles } = require('./broker');
const { sendOnce } = require('./telegram');
const { templateLabelMap } = require('./_templates');

const TEMPLATE_LABELS = templateLabelMap();

async function getCurrentPrice(assetId) {
  try {
    const result = await fetchCandles(assetId, '1m', 2);
    if (!result || !result.candles || result.candles.length === 0) return null;
    const last = result.candles[result.candles.length - 1];
    return last && isFinite(last.close) ? last.close : null;
  } catch (e) {
    return null;
  }
}

async function fireEntryAlert(setup, currentPrice) {
  const tmplLabel = TEMPLATE_LABELS[setup.template] || setup.template;
  const dirEmoji = setup.direction === 'LONG' ? '🟢' : '🔴';
  const tpLine = setup.tp1 != null
    ? `TPs: ${[setup.tp1, setup.tp2, setup.tp3].filter((x) => x != null).join(' / ')}\n` : '';

  await sendOnce(`enter:${setup.id}`,
    `⚡ <b>TIME TO ENTER — ${setup.asset.toUpperCase()}</b>\n\n` +
    `Setup: ${tmplLabel}\n` +
    `${dirEmoji} ${setup.direction}  •  Lot: ${setup.finalLot}\n` +
    `Current price: <code>${currentPrice}</code>\n` +
    `Entry: <code>${setup.entry}</code>\n` +
    `SL: <code>${setup.sl}</code>\n` +
    tpLine +
    `\n💡 Price has entered the zone. Place this trade manually in MT5 if you want to take it.\n` +
    `<i>This alert won't repeat for this setup.</i>`
  );
}

async function checkAllWatchedSetups() {
  const expiredCount = await pruneExpired();
  const active = await getActiveWatched();
  if (active.length === 0) {
    return { active: 0, alerted: 0, expired: expiredCount };
  }

  const byAsset = {};
  for (const s of active) {
    if (s.status !== 'watching') continue;
    if (!byAsset[s.asset]) byAsset[s.asset] = [];
    byAsset[s.asset].push(s);
  }

  let alerted = 0;
  const errors = [];

  for (const assetId of Object.keys(byAsset)) {
    const price = await getCurrentPrice(assetId);
    if (price == null) {
      errors.push({ asset: assetId, error: 'no current price' });
      continue;
    }
    for (const setup of byAsset[assetId]) {
      if (!priceInZone(price, setup)) continue;
      try {
        await fireEntryAlert(setup, price);
        await updateWatchedSetup(setup.id, {
          status: 'alerted', alertedAt: Date.now(), alertedAtPrice: price,
        });
        alerted++;
      } catch (e) {
        errors.push({ id: setup.id, error: e.message });
      }
    }
  }
  return { active: active.length, alerted, expired: expiredCount, errors };
}

module.exports = { checkAllWatchedSetups, getCurrentPrice };