#!/usr/bin/env python3
"""
DAX 15m / 30m / 1h Downloader — Stooq public feed
No API key or signup required.

Output:  dax_15m_raw.csv   dax_30m_raw.csv   dax_1h_raw.csv
Next:    python dax_judas_miner.py
"""

import time
from io import StringIO
from pathlib import Path

import requests
import pandas as pd

SYMBOL  = "^dax"
START   = "20230101"
END     = "20260822"
OUT_DIR = Path(r"C:\Users\Omar Nasr\quantum-bot")

SESS = requests.Session()
SESS.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer":    "https://stooq.com/",
})

TARGETS = [
    (15, "15m", "dax_15m_raw.csv"),
    (30, "30m", "dax_30m_raw.csv"),
    (60, "1h",  "dax_1h_raw.csv"),
]


def fetch_stooq(symbol: str, interval_min: int, start: str, end: str) -> pd.DataFrame:
    url = (f"https://stooq.com/q/d/l/"
           f"?s={symbol}&i={interval_min}&d1={start}&d2={end}")
    try:
        r = SESS.get(url, timeout=30)
    except Exception as e:
        print(f"  connection error: {e}")
        return pd.DataFrame()

    if r.status_code != 200:
        print(f"  HTTP {r.status_code}")
        return pd.DataFrame()

    text = r.text.strip()
    if not text or text.startswith("No data"):
        return pd.DataFrame()

    try:
        df = pd.read_csv(StringIO(text))
    except Exception:
        return pd.DataFrame()

    # Expect columns: Date, [Time,] Open, High, Low, Close, Volume
    if "Date" not in df.columns:
        return pd.DataFrame()

    if "Time" in df.columns:
        df["ts"] = pd.to_datetime(
            df["Date"].astype(str) + " " + df["Time"].astype(str),
            format="mixed", utc=False
        )
    else:
        df["ts"] = pd.to_datetime(df["Date"])

    df = df.set_index("ts")
    df.columns = [c.lower() for c in df.columns]
    cols = [c for c in ["open","high","low","close"] if c in df.columns]
    if not cols:
        return pd.DataFrame()

    df = df[cols].dropna()
    df = df[~df.index.duplicated(keep="first")].sort_index()

    # Convert exchange-local time to UTC
    # DAX trades in CET (UTC+1) / CEST (UTC+2)
    try:
        df.index = df.index.tz_localize("Europe/Berlin", ambiguous="infer",
                                         nonexistent="shift_forward")
        df.index = df.index.tz_convert("UTC")
    except Exception:
        pass

    df.index.name = "ts"
    return df


def main():
    print("DAX Downloader — Stooq  (no API key needed)")
    print(f"Symbol: {SYMBOL}  |  {START[:4]}-{START[4:6]}-{START[6:]} → "
          f"{END[:4]}-{END[4:6]}-{END[6:]}")
    print()

    any_ok = False

    for interval_min, tf, fname in TARGETS:
        print(f"  [{tf}] fetching ...", end=" ", flush=True)
        df = fetch_stooq(SYMBOL, interval_min, START, END)

        if df.empty:
            print("✗ no data")
            print(f"       Stooq may not carry intraday data for {SYMBOL} at {tf}.")
            continue

        span = (df.index[-1] - df.index[0]).days / 365.25
        hrs  = sorted(df.index.hour.unique())

        if min(hrs) >= 13:
            print(f"✗ wrong hours {hrs[:3]}... (US market, not Frankfurt)")
            continue

        out = OUT_DIR / fname
        df.to_csv(out)
        print(f"✓ {len(df):,} bars  "
              f"{df.index[0].date()} → {df.index[-1].date()}  "
              f"({span:.2f}yr)  hours(UTC)={hrs[:4]}..{hrs[-1]}")
        print(f"       Saved → {fname}")
        any_ok = True
        time.sleep(1)

    print()
    if any_ok:
        print("Run miner:  python dax_judas_miner.py")
    else:
        print("Stooq has no intraday DAX data.")
        print()
        print("Remaining options for 15m/30m data:")
        print("  1. Export from MT5:       python download_mt5_ger40.py")
        print("     (open MT5 → log in → run script)")
        print()
        print("  2. Manual TradingView export:")
        print("     Open GER40 15m chart → right-click price chart →")
        print("     'Export chart data' → save CSV → rename to dax_15m_raw.csv")
        print("     Place in: C:\\Users\\Omar Nasr\\quantum-bot\\")
        print()
        print("  3. 1h only (Yahoo Finance, 730 days — already works):")
        print("     python download_yf_dax.py")


if __name__ == "__main__":
    main()
