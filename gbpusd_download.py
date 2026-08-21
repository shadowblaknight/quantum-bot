#!/usr/bin/env python3
"""
gbpusd_download.py — Pull GBPUSD bars from MetaAPI (all timeframes)
=====================================================================
Downloads M15, M30, H1, and H4 by default.
Saves → gbpusd_m15.csv, gbpusd_m30.csv, gbpusd_h1.csv, gbpusd_h4.csv

Usage:
  python gbpusd_download.py                   # all 4 TFs, 5 years
  python gbpusd_download.py --tfs 15m 1h      # only M15 + H1
  python gbpusd_download.py --years 3
  python gbpusd_download.py --symbol GBPUSD.raw
"""

import os, sys, time, argparse
from datetime import datetime, timezone, timedelta
import requests
import pandas as pd

# ── Credentials ───────────────────────────────────────────────────────────────
def load_env_local():
    env_path = os.path.join(os.path.dirname(__file__), '.env.local')
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

load_env_local()

ACCOUNT_ID = os.environ.get('METAAPI_ACCOUNT_ID', '')
TOKEN      = os.environ.get('METAAPI_TOKEN', '')
HEADERS    = {'auth-token': TOKEN, 'Content-Type': 'application/json'}
PROVISIONING_HOST = 'https://mt-provisioning-api-v1.agiliumtrade.ai'

# TF → MetaAPI timeframe string → output filename
TF_CONFIG = {
    '15m': {'api': '15m',  'file': 'gbpusd_m15.csv',  'label': 'M15'},
    '30m': {'api': '30m',  'file': 'gbpusd_m30.csv',  'label': 'M30'},
    '1h':  {'api': '1h',   'file': 'gbpusd_h1.csv',   'label': 'H1'},
    '4h':  {'api': '4h',   'file': 'gbpusd_h4.csv',   'label': 'H4'},
}
DEFAULT_TFS = ['15m', '30m', '1h', '4h']


def get_account_region():
    url = f'{PROVISIONING_HOST}/users/current/accounts/{ACCOUNT_ID}'
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        data   = r.json()
        region = data.get('region') or data.get('server', {}).get('region', 'london')
        return region.lower()
    except Exception as e:
        print(f"  Warning: could not determine region ({e}), defaulting to 'london'")
        return 'london'


def fetch_candles_chunk(host, symbol, timeframe, start_iso, limit=1000):
    url = (f'{host}/users/current/accounts/{ACCOUNT_ID}'
           f'/historical-market-data/symbols/{symbol}'
           f'/timeframes/{timeframe}/candles')
    params = {'startTime': start_iso, 'limit': limit}
    try:
        r = requests.get(url, headers=HEADERS, params=params, timeout=30)
        if r.status_code == 404:
            return None, f'Symbol {symbol!r} not found (404)'
        if r.status_code == 401:
            return None, 'Unauthorized (401) — token may be expired'
        r.raise_for_status()
        return r.json(), None
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
            try:
                dt = pd.to_datetime(ts).tz_localize(None)
            except Exception:
                continue
        rows.append({
            'datetime': dt,
            'open':   float(c.get('open',       c.get('o', 0))),
            'high':   float(c.get('high',       c.get('h', 0))),
            'low':    float(c.get('low',        c.get('l', 0))),
            'close':  float(c.get('close',      c.get('c', 0))),
            'volume': float(c.get('tickVolume', c.get('volume', c.get('v', 0)))),
        })
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows).drop_duplicates('datetime').sort_values('datetime')
    return df[df['close'] > 0]


def download_one(host, symbol, tf_key, years, label):
    """Download one timeframe. Returns the saved filename or None on failure."""
    cfg       = TF_CONFIG[tf_key]
    api_tf    = cfg['api']
    out_file  = cfg['file']

    print(f"\n  ── {label} ({tf_key}) ─────────────────────────────")

    cutoff       = datetime.now(timezone.utc) - timedelta(days=years * 365)
    cursor       = datetime.now(timezone.utc)
    all_dfs      = []
    n_total      = 0
    batch        = 0
    empty_streak = 0

    while cursor > cutoff:
        batch       += 1
        chunk_start  = max(cutoff, cursor - timedelta(days=30))
        start_iso    = chunk_start.strftime('%Y-%m-%dT%H:%M:%S.000Z')

        candles, err = fetch_candles_chunk(host, symbol, api_tf, start_iso, 1000)

        if err:
            print(f"    ERROR: {err}")
            return None

        if not candles:
            empty_streak += 1
            print(f"    Batch {batch:3d}: 0 bars  cursor={cursor.date()}")
            cursor -= timedelta(days=30)
            if empty_streak >= 3:
                print("    3 empty batches — stopping.")
                break
            continue

        empty_streak = 0
        df_chunk     = candles_to_df(candles)

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

        oldest = df_chunk['datetime'].min()
        print(f"    Batch {batch:3d}: {n_new:5d} bars  oldest={pd.Timestamp(oldest).date()}  total={n_total:,}")
        cursor = pd.Timestamp(oldest).to_pydatetime().replace(tzinfo=timezone.utc) - timedelta(hours=1)

        if cursor <= cutoff:
            break

        time.sleep(0.3)

    if not all_dfs:
        print(f"    No data downloaded for {label}.")
        return None

    df_all = pd.concat(all_dfs).drop_duplicates('datetime').sort_values('datetime')
    span   = (df_all['datetime'].max() - df_all['datetime'].min()).days / 365.25
    print(f"    {len(df_all):,} bars  |  {df_all['datetime'].iloc[0].date()} → "
          f"{df_all['datetime'].iloc[-1].date()}  |  ~{span:.2f} years")
    df_all.to_csv(out_file, index=False)
    print(f"    Saved → {out_file}")
    return out_file


def download(symbol='GBPUSD', years=5, tfs=None):
    if not TOKEN:
        print("ERROR: METAAPI_TOKEN not set in .env.local or environment")
        sys.exit(1)

    if tfs is None:
        tfs = DEFAULT_TFS

    # Validate
    bad = [t for t in tfs if t not in TF_CONFIG]
    if bad:
        print(f"ERROR: unknown timeframes: {bad}")
        print(f"  Valid: {list(TF_CONFIG.keys())}")
        sys.exit(1)

    print(f"\n{'='*62}")
    print(f"GBPUSD MetaAPI Downloader — all timeframes")
    print(f"  Account  : {ACCOUNT_ID[:8] if ACCOUNT_ID else '?'}...")
    print(f"  Symbol   : {symbol}")
    print(f"  TFs      : {', '.join(TF_CONFIG[t]['label'] for t in tfs)}")
    print(f"  Target   : {years} years")
    print(f"{'='*62}")

    print("\nGetting account region ...")
    region = get_account_region()
    host   = f'https://mt-market-data-client-api-v1.{region}.agiliumtrade.ai'
    print(f"  Region   : {region}")
    print(f"  Endpoint : {host}")

    saved = []
    for tf_key in tfs:
        label = TF_CONFIG[tf_key]['label']
        out   = download_one(host, symbol, tf_key, years, label)
        if out:
            saved.append((label, out))

    print(f"\n{'='*62}")
    print(f"DOWNLOAD COMPLETE — {len(saved)}/{len(tfs)} TFs saved")
    for label, fname in saved:
        print(f"  {label:4} → {fname}")

    if saved:
        print(f"\nNow run:  python gbpusd_miner.py")
        print(f"  The miner uses gbpusd_m15.csv as its base (finest bars).")
        print(f"  It resamples to M30 / H1 / H4 internally for signal detection.")
        print(f"  Separate H1/H4 CSVs give you a cross-check or standalone run.")

    return len(saved) > 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='GBPUSD MetaAPI multi-TF downloader')
    parser.add_argument('--symbol', default='GBPUSD',
                        help='Broker symbol (default: GBPUSD)')
    parser.add_argument('--years',  type=int, default=5,
                        help='Years of history (default: 5)')
    parser.add_argument('--tfs',    nargs='+', default=DEFAULT_TFS,
                        choices=list(TF_CONFIG.keys()),
                        help='Timeframes to download (default: 15m 30m 1h 4h)')
    args = parser.parse_args()

    ok = download(symbol=args.symbol, years=args.years, tfs=args.tfs)
    if not ok:
        print("\nDownload failed. Try:")
        print("  python gbpusd_download.py --symbol GBP/USD")
        print("Or export OHLCV from TradingView → save as gbpusd_m15.csv")
