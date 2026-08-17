#!/usr/bin/env python3
"""
nas100_download.py — Pull NAS100 15m bars from MetaAPI
========================================================
Uses your existing MetaAPI credentials (already in your bot).
Saves → nas100_miner_raw.csv  (ready for nas100_miner.py)

Usage:  python nas100_download.py
        python nas100_download.py --symbol US100   (if broker uses US100)
        python nas100_download.py --years 3        (pull 3 years instead of 6)
"""

import os, sys, time, argparse
from datetime import datetime, timezone, timedelta
import requests
import pandas as pd

# ── Credentials (pulled from .env.local or env vars) ─────────────────────────
def load_env_local():
    env_path = os.path.join(os.path.dirname(__file__), '.env.local')
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))

load_env_local()

ACCOUNT_ID = os.environ.get('METAAPI_ACCOUNT_ID', '760fa78c-931e-4b3f-a4b4-9c308b06e169')
TOKEN      = os.environ.get('METAAPI_TOKEN', '')

if not TOKEN:
    print("ERROR: METAAPI_TOKEN not found in environment or .env.local")
    sys.exit(1)

HEADERS = {'auth-token': TOKEN, 'Content-Type': 'application/json'}

# ── MetaAPI REST helpers ──────────────────────────────────────────────────────

PROVISIONING_HOST = 'https://mt-provisioning-api-v1.agiliumtrade.ai'

def get_account_region():
    """Get the account's server region so we hit the right data endpoint."""
    url = f'{PROVISIONING_HOST}/users/current/accounts/{ACCOUNT_ID}'
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        data = r.json()
        region = data.get('region') or data.get('server', {}).get('region', 'london')
        return region.lower()
    except Exception as e:
        print(f"  Warning: could not determine region ({e}), defaulting to 'london'")
        return 'london'

def fetch_candles_chunk(host, symbol, timeframe, start_iso, limit=1000):
    """Fetch up to `limit` candles from MetaAPI historical data API."""
    url = (f'{host}/users/current/accounts/{ACCOUNT_ID}'
           f'/historical-market-data/symbols/{symbol}'
           f'/timeframes/{timeframe}/candles')
    params = {'startTime': start_iso, 'limit': limit}
    try:
        r = requests.get(url, headers=HEADERS, params=params, timeout=30)
        if r.status_code == 404:
            return None, 'Symbol not found (404) — try --symbol US100 or NQ1!'
        if r.status_code == 401:
            return None, 'Unauthorized (401) — MetaAPI token may be expired'
        r.raise_for_status()
        candles = r.json()
        return candles, None
    except requests.exceptions.Timeout:
        return None, 'Request timed out'
    except Exception as e:
        return None, str(e)

def candles_to_df(candles):
    rows = []
    for c in candles:
        ts = c.get('time') or c.get('t') or c.get('brokerTime')
        if not ts:
            continue
        try:
            dt = pd.to_datetime(ts, utc=True).tz_localize(None)
        except Exception:
            continue
        rows.append({
            'datetime': dt,
            'open':     float(c.get('open',  c.get('o', 0))),
            'high':     float(c.get('high',  c.get('h', 0))),
            'low':      float(c.get('low',   c.get('l', 0))),
            'close':    float(c.get('close', c.get('c', 0))),
            'volume':   float(c.get('tickVolume', c.get('volume', c.get('v', 0)))),
        })
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows).drop_duplicates('datetime').sort_values('datetime')
    return df[df['close'] > 0]

# ── Main download loop ────────────────────────────────────────────────────────

def download(symbol='NAS100', years=6, timeframe='15m'):
    print(f"\n{'='*60}")
    print(f"NAS100 MetaAPI Downloader")
    print(f"  Account : {ACCOUNT_ID[:8]}...")
    print(f"  Symbol  : {symbol}")
    print(f"  TF      : {timeframe}")
    print(f"  Target  : {years} years")
    print(f"{'='*60}\n")

    print("Getting account region ...")
    region = get_account_region()
    print(f"  Region: {region}")

    host = f'https://mt-market-data-client-api-v1.{region}.agiliumtrade.ai'
    print(f"  Endpoint: {host}\n")

    cutoff    = datetime.now(timezone.utc) - timedelta(days=years * 365)
    cursor    = datetime.now(timezone.utc)
    all_dfs   = []
    n_total   = 0
    batch     = 0
    BATCH_LIM = 1000
    MAX_EMPTY = 3

    empty_streak = 0

    print("Downloading (newest → oldest) ...")
    while cursor > cutoff:
        batch    += 1
        start_iso = cutoff.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        end_iso   = cursor.strftime('%Y-%m-%dT%H:%M:%S.000Z')

        # MetaAPI wants startTime as the START of the window (oldest end of chunk)
        # We'll paginate by requesting from `cutoff` and moving the window forward.
        # Actually: request from start, get up to 1000 bars forward.
        chunk_start = max(cutoff, cursor - timedelta(days=30))
        chunk_start_iso = chunk_start.strftime('%Y-%m-%dT%H:%M:%S.000Z')

        candles, err = fetch_candles_chunk(host, symbol, timeframe, chunk_start_iso, BATCH_LIM)

        if err:
            print(f"\nERROR: {err}")
            if 'not found' in err.lower() or '404' in err:
                print("\nTry running with a different symbol:")
                print("  python nas100_download.py --symbol US100")
                print("  python nas100_download.py --symbol USTEC")
                print("  python nas100_download.py --symbol NQ1!")
            break

        if not candles:
            empty_streak += 1
            print(f"  Batch {batch:3d}: 0 bars (empty)  cursor={cursor.date()}")
            cursor -= timedelta(days=30)
            if empty_streak >= MAX_EMPTY:
                print("  3 empty batches in a row — stopping.")
                break
            continue

        empty_streak = 0
        df_chunk = candles_to_df(candles)

        if df_chunk.empty:
            cursor -= timedelta(days=30)
            continue

        already_got = set()
        if all_dfs:
            for d in all_dfs:
                already_got.update(d['datetime'].values)

        df_new = df_chunk[~df_chunk['datetime'].isin(already_got)]
        n_new  = len(df_new)

        if n_new > 0:
            all_dfs.append(df_new)
            n_total += n_new

        oldest_in_chunk = df_chunk['datetime'].min()
        print(f"  Batch {batch:3d}: {n_new:5d} bars  oldest={pd.Timestamp(oldest_in_chunk).date()}  "
              f"total={n_total:,}")

        cursor = pd.Timestamp(oldest_in_chunk).to_pydatetime().replace(tzinfo=timezone.utc) - timedelta(minutes=15)

        if cursor <= cutoff:
            break

        time.sleep(0.3)  # gentle rate limiting

    if not all_dfs:
        print("\nNo data downloaded. Possible reasons:")
        print("  1. Symbol not available on your broker (try --symbol US100 or USTEC)")
        print("  2. MetaAPI historical data not enabled for your account tier")
        print("  3. Token expired — regenerate at app.metaapi.cloud")
        return False

    print(f"\nCombining {len(all_dfs)} chunks ...")
    df_all = pd.concat(all_dfs).drop_duplicates('datetime').sort_values('datetime')

    # Filter to market hours + some buffer (exclude weekends with no bars)
    span = (df_all['datetime'].max() - df_all['datetime'].min()).days / 365.25
    print(f"  {len(df_all):,} bars  |  {df_all['datetime'].iloc[0].date()} → "
          f"{df_all['datetime'].iloc[-1].date()}  |  ~{span:.2f} years")
    print(f"  Price range: {df_all['close'].min():.1f} – {df_all['close'].max():.1f}")

    out = 'nas100_miner_raw.csv'
    df_all.to_csv(out, index=False)
    print(f"\n  Saved → {out}")
    print("\nNow run:  python nas100_miner.py")
    return True


# ── Alternative: Twelve Data fallback ────────────────────────────────────────

def try_twelve_data(symbol='NDX', years=6, api_key=None):
    """Fallback downloader using Twelve Data (requires TWELVE_DATA_KEY env var)."""
    api_key = api_key or os.environ.get('TWELVE_DATA_KEY')
    if not api_key:
        print("\nTwelve Data fallback: TWELVE_DATA_KEY not set.")
        print("  1. Go to twelvedata.com → sign up free")
        print("  2. Copy your API key")
        print("  3. Run: python nas100_download.py --source twelvedata --tdkey YOUR_KEY")
        return False

    print(f"\nTwelve Data downloader: {symbol} | 15min | {years}yr")
    TD_HOST = 'https://api.twelvedata.com/time_series'

    now      = datetime.now(timezone.utc)
    cutoff   = now - timedelta(days=years * 365)
    cursor   = now
    all_dfs  = []
    n_total  = 0

    while cursor > cutoff:
        chunk_start = max(cutoff, cursor - timedelta(days=50))
        params = {
            'symbol':     symbol,
            'interval':   '15min',
            'start_date': chunk_start.strftime('%Y-%m-%d %H:%M:%S'),
            'end_date':   cursor.strftime('%Y-%m-%d %H:%M:%S'),
            'timezone':   'UTC',
            'outputsize': 5000,
            'apikey':     api_key,
        }
        try:
            r = requests.get(TD_HOST, params=params, timeout=30)
            data = r.json()
        except Exception as e:
            print(f"  Error: {e}"); break

        if data.get('status') == 'error':
            print(f"  TwelveData error: {data.get('message')}")
            break

        values = data.get('values', [])
        if not values:
            print(f"  No data for {chunk_start.date()} – {cursor.date()}")
            cursor = chunk_start - timedelta(minutes=15)
            continue

        rows = []
        for v in values:
            rows.append({
                'datetime': pd.to_datetime(v['datetime'], utc=True).tz_localize(None),
                'open':     float(v['open']),
                'high':     float(v['high']),
                'low':      float(v['low']),
                'close':    float(v['close']),
                'volume':   float(v.get('volume', 0)),
            })
        df_chunk = pd.DataFrame(rows).sort_values('datetime')
        n_total += len(df_chunk)
        all_dfs.append(df_chunk)

        oldest = df_chunk['datetime'].min()
        print(f"  {len(df_chunk):5d} bars  oldest={oldest.date()}  total={n_total:,}")
        cursor = oldest.to_pydatetime().replace(tzinfo=timezone.utc) - timedelta(minutes=15)
        time.sleep(1.2)  # TD free tier: ~8 req/min

    if not all_dfs:
        return False

    df_all = pd.concat(all_dfs).drop_duplicates('datetime').sort_values('datetime')
    df_all.to_csv('nas100_miner_raw.csv', index=False)
    print(f"\n  Saved {len(df_all):,} bars → nas100_miner_raw.csv")
    return True


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='NAS100 15m data downloader')
    parser.add_argument('--symbol', default='NAS100',
                        help='Broker symbol (NAS100 / US100 / USTEC / NQ1!)')
    parser.add_argument('--years',  type=int, default=6,
                        help='Years of history to fetch (default 6)')
    parser.add_argument('--source', choices=['metaapi', 'twelvedata'], default='metaapi',
                        help='Data source (default: metaapi)')
    parser.add_argument('--tdkey',  default=None,
                        help='Twelve Data API key (if --source twelvedata)')
    parser.add_argument('--tdsym',  default='NDX',
                        help='Twelve Data symbol (default NDX)')
    args = parser.parse_args()

    if args.source == 'twelvedata':
        ok = try_twelve_data(symbol=args.tdsym, years=args.years, api_key=args.tdkey)
    else:
        ok = download(symbol=args.symbol, years=args.years)
        if not ok:
            print("\nMetaAPI download failed. Trying fallback instructions:")
            print("  Option A: python nas100_download.py --symbol US100")
            print("  Option B: python nas100_download.py --symbol USTEC")
            print("  Option C: Get free key at twelvedata.com, then:")
            print("            python nas100_download.py --source twelvedata --tdkey YOUR_KEY")
