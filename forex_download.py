#!/usr/bin/env python3
"""
forex_download.py — Download M15 bars for multiple forex pairs from MetaAPI
============================================================================
Downloads M15 only (alexg_miner resamples to H1, H4, D internally).

Pairs (mirrors alexg-run.js INSTRUMENTS):
  eurusd  usdjpy  usdchf  audusd  nzdusd  usdcad  eurjpy  gbpjpy  eurgbp

Usage:
  python forex_download.py                        # all 9 pairs, 5 years
  python forex_download.py --pairs eurusd usdjpy  # specific pairs
  python forex_download.py --years 3
  python forex_download.py --tf 1h                # download H1 instead of M15
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

# ── Pair config ───────────────────────────────────────────────────────────────
# symbol → broker symbol (try variations on failure)
PAIRS = {
    'eurusd': ['EURUSD', 'EUR/USD', 'EURUSD.raw', 'EURUSDm'],
    'usdjpy': ['USDJPY', 'USD/JPY', 'USDJPY.raw', 'USDJPYm'],
    'usdchf': ['USDCHF', 'USD/CHF', 'USDCHF.raw', 'USDCHFm'],
    'audusd': ['AUDUSD', 'AUD/USD', 'AUDUSD.raw', 'AUDUSDm'],
    'nzdusd': ['NZDUSD', 'NZD/USD', 'NZDUSD.raw', 'NZDUSDm'],
    'usdcad': ['USDCAD', 'USD/CAD', 'USDCAD.raw', 'USDCADm'],
    'eurjpy': ['EURJPY', 'EUR/JPY', 'EURJPY.raw', 'EURJPYm'],
    'gbpjpy': ['GBPJPY', 'GBP/JPY', 'GBPJPY.raw', 'GBPJPYm'],
    'eurgbp': ['EURGBP', 'EUR/GBP', 'EURGBP.raw', 'EURGBPm'],
}
DEFAULT_PAIRS = list(PAIRS.keys())

TF_API_MAP = {
    '15m': '15m',
    '30m': '30m',
    '1h':  '1h',
    '4h':  '4h',
}


# ── API helpers ───────────────────────────────────────────────────────────────
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


def fetch_chunk(host, symbol, timeframe, start_iso, limit=1000):
    url = (f'{host}/users/current/accounts/{ACCOUNT_ID}'
           f'/historical-market-data/symbols/{symbol}'
           f'/timeframes/{timeframe}/candles')
    params = {'startTime': start_iso, 'limit': limit}
    try:
        r = requests.get(url, headers=HEADERS, params=params, timeout=30)
        if r.status_code == 404:
            return None, f'symbol {symbol!r} not found (404)'
        if r.status_code == 401:
            return None, 'unauthorized (401)'
        r.raise_for_status()
        return r.json(), None
    except requests.exceptions.Timeout:
        return None, 'timeout'
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


def probe_symbol(host, pair, tf_api):
    """Try each symbol variant until one returns data. Returns working symbol or None."""
    variants = PAIRS.get(pair, [pair.upper()])
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    start_iso = cutoff.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    for sym in variants:
        data, err = fetch_chunk(host, sym, tf_api, start_iso, limit=10)
        if err:
            continue
        if data and len(data) > 0:
            print(f"    Symbol: {sym}")
            return sym
    return None


def download_pair(host, pair, tf_key, years, out_file):
    tf_api       = TF_API_MAP[tf_key]
    print(f"\n  ── {pair.upper()} / {tf_key.upper()} ──────────────────────────────")

    # Probe for working symbol name
    symbol = probe_symbol(host, pair, tf_api)
    if symbol is None:
        print(f"    ERROR: no working symbol variant found for {pair}")
        print(f"    Tried: {PAIRS.get(pair, [])}")
        return False

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

        candles, err = fetch_chunk(host, symbol, tf_api, start_iso, 1000)

        if err:
            print(f"    ERROR: {err}")
            return False

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
        print(f"    No data downloaded.")
        return False

    df_all = pd.concat(all_dfs).drop_duplicates('datetime').sort_values('datetime')
    span   = (df_all['datetime'].max() - df_all['datetime'].min()).days / 365.25
    print(f"    {len(df_all):,} bars  |  {df_all['datetime'].iloc[0].date()} → "
          f"{df_all['datetime'].iloc[-1].date()}  |  ~{span:.2f} years")
    df_all.to_csv(out_file, index=False)
    print(f"    Saved → {out_file}")
    return True


def main():
    if not TOKEN:
        print("ERROR: METAAPI_TOKEN not set in .env.local or environment")
        sys.exit(1)

    ap = argparse.ArgumentParser(description='Forex multi-pair MetaAPI downloader')
    ap.add_argument('--pairs', nargs='+', default=DEFAULT_PAIRS,
                    choices=DEFAULT_PAIRS, metavar='PAIR',
                    help=f'Pairs to download (default: all {len(DEFAULT_PAIRS)})')
    ap.add_argument('--years', type=int, default=5,
                    help='Years of history (default: 5)')
    ap.add_argument('--tf', default='15m', choices=list(TF_API_MAP.keys()),
                    help='Timeframe (default: 15m)')
    args = ap.parse_args()

    tf_label = args.tf.upper()
    out_suffix = {'15m': 'm15', '30m': 'm30', '1h': 'h1', '4h': 'h4'}[args.tf]

    print(f"\n{'='*62}")
    print(f"Forex MetaAPI Downloader — {tf_label}")
    print(f"  Account  : {ACCOUNT_ID[:8] if ACCOUNT_ID else '?'}...")
    print(f"  Pairs    : {', '.join(p.upper() for p in args.pairs)}")
    print(f"  TF       : {tf_label}")
    print(f"  Target   : {args.years} years each")
    print(f"{'='*62}")

    print("\nGetting account region ...")
    region = get_account_region()
    host   = f'https://mt-market-data-client-api-v1.{region}.agiliumtrade.ai'
    print(f"  Region   : {region}")
    print(f"  Endpoint : {host}")

    saved, failed = [], []
    for pair in args.pairs:
        out_file = f'{pair}_{out_suffix}.csv'
        ok = download_pair(host, pair, args.tf, args.years, out_file)
        if ok:
            saved.append(pair)
        else:
            failed.append(pair)

    print(f"\n{'='*62}")
    print(f"DOWNLOAD COMPLETE — {len(saved)}/{len(args.pairs)} pairs saved")
    for p in saved:
        print(f"  ✓ {p.upper():8} → {p}_{out_suffix}.csv")
    for p in failed:
        print(f"  ✗ {p.upper():8} → FAILED")

    if saved:
        pairs_str = ' '.join(saved)
        print(f"\nNext step — run the miner across all pairs:")
        print(f"  python alexg_miner.py --pair all --long-only")

    return len(saved) > 0


if __name__ == '__main__':
    ok = main()
    if not ok:
        sys.exit(1)
