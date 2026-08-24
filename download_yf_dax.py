#!/usr/bin/env python3
"""
DAX Downloader — Yahoo Finance  (same approach as NAS100 / gold)
Ticker: ^GDAXI

Yahoo Finance limits (hard — nothing we can do about it):
  1h  → 730 days  ✓ good for stats
  30m → 60 days   ⚠ borderline
  15m → 60 days   ⚠ borderline

For 15m/30m with proper history (2+ years), export from MT5 instead:
  python download_mt5_ger40.py

Usage:
    python download_yf_dax.py

Output:
    dax_1h_raw.csv   dax_30m_raw.csv   dax_15m_raw.csv

Next step:
    python dax_judas_miner.py
"""

try:
    import yfinance as yf
    import pandas as pd
except ImportError:
    import subprocess, sys
    subprocess.run([sys.executable, "-m", "pip", "install", "yfinance", "pandas", "-q"])
    import yfinance as yf
    import pandas as pd

from pathlib import Path

TICKER  = "^GDAXI"
OUT_DIR = Path(r"C:\Users\Omar Nasr\quantum-bot")

# (interval, period, output filename)
TARGETS = [
    ("1h",  "730d", "dax_1h_raw.csv"),
    ("30m", "60d",  "dax_30m_raw.csv"),
    ("15m", "60d",  "dax_15m_raw.csv"),
]


def fetch(interval: str, period: str) -> pd.DataFrame:
    df = yf.download(TICKER, period=period, interval=interval,
                     auto_adjust=True, progress=False)
    if df.empty:
        return pd.DataFrame()

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0].lower() for c in df.columns]
    else:
        df.columns = [c.lower() for c in df.columns]

    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")
    df.index.name = "ts"

    df = df[["open", "high", "low", "close"]].dropna()
    return df[~df.index.duplicated(keep="first")].sort_index()


def main():
    print(f"Downloading {TICKER} from Yahoo Finance ...")
    print()

    any_saved = False
    for interval, period, fname in TARGETS:
        print(f"  {interval:3s} ({period:4s} history) ...", end=" ", flush=True)
        df = fetch(interval, period)

        if df.empty:
            print("✗ no data")
            continue

        span  = (df.index[-1] - df.index[0]).days / 365.25
        hours = sorted(df.index.hour.unique())
        note  = "⚠ only 60d" if period == "60d" else "✓"

        out = OUT_DIR / fname
        df.to_csv(out)

        print(f"{len(df):,} bars  {df.index[0].date()} → {df.index[-1].date()}"
              f"  ({span:.2f}yr)  {note}")

        if 0 not in hours and interval == "1h":
            print(f"       Cash session only (07:00-17:30 UTC) — miner uses ORB proxy")

        any_saved = True

    print()
    if any_saved:
        print("⚠  15m and 30m have only ~60 days — results will have low N.")
        print("   For proper 15m/30m stats: use MT5 or Dukascopy data instead.")
        print()
        print("Run miner:  python dax_judas_miner.py")
    else:
        print("✗ Nothing saved. Check internet connection.")


if __name__ == "__main__":
    main()
