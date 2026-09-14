/* eslint-disable */
// research/fetch-fx.js — pull 3y of OHLC for the 28 major-cross FX pairs.
//
// MetaAPI's historical-market-data endpoint loads candles BACKWARD from
// `startTime` (the batch ENDS at startTime, max 1000). So we walk backward:
// cursor starts at now, each page's OLDEST candle becomes the next cursor,
// until we pass the 3y target or the broker runs out of history.
//
// Deep history is slow on MetaAPI's side (first touch of a symbol/TF triggers a
// broker backfill: 1d took 16s, 1w 504'd on first call and succeeds on retry).
// So: sequential by design, generous timeout, retry with backoff on 429/5xx.
//
// Resumable — a pair/TF already written to data/ is skipped, so an interrupted
// run continues where it stopped.
//
//   node --env-file=.env.local api/research/fetch-fx.js <accountId> [pairFilter]

const fs   = require('fs');
const path = require('path');

const TOKEN  = process.env.METAAPI_TOKEN;
const ACCT   = process.argv[2] || process.env.METAAPI_ACCOUNT_ID;
const REGION = process.env.METAAPI_REGION || 'london';
const FILTER = process.argv[3] || null;          // optional: only this pair

if (!TOKEN || !ACCT) { console.error('missing METAAPI_TOKEN / account id'); process.exit(1); }

const MD      = `https://mt-market-data-client-api-v1.${REGION}.agiliumtrade.ai`;
const OUT_DIR = path.join(__dirname, 'data');
const YEARS   = 3;
const TARGET  = Date.now() - YEARS * 365.25 * 24 * 3600 * 1000;
// 1w is NOT fetched: MetaAPI cold-starts weekly history at ~5 min/pair (504s
// then retries), while aggregating it from 1d reproduces the broker's own
// weekly bars exactly (verified on EURUSD: 102/102 open/high/low identical,
// close within 0.3 pip on 1 bar). The backtester derives it.
const TFS     = ['15m', '1h', '4h', '1d'];

// 28 pairs = C(8,2) over USD EUR GBP CHF JPY NZD CAD AUD, in broker convention.
const PAIRS = [
  'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
  'EURGBP','EURJPY','EURCHF','EURCAD','EURAUD','EURNZD',
  'GBPJPY','GBPCHF','GBPCAD','GBPAUD','GBPNZD',
  'AUDJPY','AUDCHF','AUDCAD','AUDNZD',
  'NZDJPY','NZDCHF','NZDCAD',
  'CADJPY','CADCHF','CHFJPY',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function url(sym, tf, startIso, limit = 1000) {
  return `${MD}/users/current/accounts/${ACCT}`
    + `/historical-market-data/symbols/${encodeURIComponent(sym)}`
    + `/timeframes/${tf}/candles`
    + `?startTime=${encodeURIComponent(startIso)}&limit=${limit}`;
}

// One page, with retry. 429/5xx are transient here (backfill in progress), so
// back off and try again rather than abandoning the pair.
async function page(sym, tf, startIso, attempt = 0) {
  const MAX = 5;
  try {
    const ctl = setTimeout(() => {}, 0); clearTimeout(ctl);
    const r = await fetch(url(sym, tf, startIso), {
      headers: { 'auth-token': TOKEN, Accept: 'application/json' },
      signal: AbortSignal.timeout(120000),
    });
    if (r.status === 429 || r.status >= 500) {
      if (attempt >= MAX) return { err: `HTTP ${r.status} after ${MAX} retries` };
      const wait = Math.min(60000, 3000 * Math.pow(2, attempt));
      process.stdout.write(` [${r.status} retry ${attempt + 1} in ${wait / 1000}s]`);
      await sleep(wait);
      return page(sym, tf, startIso, attempt + 1);
    }
    if (!r.ok) return { err: `HTTP ${r.status} ${(await r.text()).slice(0, 120)}` };
    return { rows: await r.json() };
  } catch (e) {
    if (attempt >= MAX) return { err: `threw: ${e.message}` };
    const wait = Math.min(60000, 3000 * Math.pow(2, attempt));
    process.stdout.write(` [${e.name} retry ${attempt + 1} in ${wait / 1000}s]`);
    await sleep(wait);
    return page(sym, tf, startIso, attempt + 1);
  }
}

// Walk backward to TARGET, dedupe by timestamp, return ascending.
async function fetchSeries(sym, tf) {
  const seen = new Map();
  let cursor = new Date().toISOString();
  let pages = 0;

  while (true) {
    const { rows, err } = await page(sym, tf, cursor);
    if (err) { process.stdout.write(` ERR:${err}`); break; }
    if (!rows || !rows.length) break;

    let oldest = Infinity;
    for (const c of rows) {
      const t = Date.parse(c.time);
      if (!Number.isFinite(t)) continue;
      if (t < oldest) oldest = t;
      if (!seen.has(t)) seen.set(t, [t, c.open, c.high, c.low, c.close, c.tickVolume ?? c.volume ?? 0]);
    }
    pages++;
    process.stdout.write('.');

    if (oldest <= TARGET) break;          // reached 3y
    const next = new Date(oldest).toISOString();
    if (next === cursor) break;           // no progress — broker history exhausted
    cursor = next;
    await sleep(250);                     // stay well under the 5-concurrent cap
  }

  const out = [...seen.values()].filter(r => r[0] >= TARGET).sort((a, b) => a[0] - b[0]);
  return { rows: out, pages };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const list = FILTER ? PAIRS.filter(p => p === FILTER) : PAIRS;
  console.log(`fetching ${list.length} pairs x ${TFS.length} TFs | 3y back to ${new Date(TARGET).toISOString().slice(0, 10)}`);

  const t0 = Date.now();
  for (let i = 0; i < list.length; i++) {
    const sym = list[i];
    console.log(`\n[${i + 1}/${list.length}] ${sym}`);
    for (const tf of TFS) {
      const file = path.join(OUT_DIR, `${sym}_${tf}.csv`);
      if (fs.existsSync(file) && fs.statSync(file).size > 200) {
        const n = fs.readFileSync(file, 'utf8').split('\n').length - 2;
        console.log(`  ${tf.padEnd(4)} skip (have ${n})`);
        continue;
      }
      process.stdout.write(`  ${tf.padEnd(4)} `);
      const s = Date.now();
      const { rows, pages } = await fetchSeries(sym, tf);
      if (!rows.length) { console.log(` NO DATA`); continue; }
      const csv = 'time,open,high,low,close,volume\n'
        + rows.map(r => `${new Date(r[0]).toISOString()},${r[1]},${r[2]},${r[3]},${r[4]},${r[5]}`).join('\n');
      fs.writeFileSync(file, csv);
      const from = new Date(rows[0][0]).toISOString().slice(0, 10);
      console.log(` ${rows.length} candles, ${pages}p, ${((Date.now() - s) / 1000).toFixed(0)}s, from ${from}`);
    }
  }
  console.log(`\ndone in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
