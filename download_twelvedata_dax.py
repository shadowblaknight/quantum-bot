#!/usr/bin/env python3
"""
DAX 15m / 30m / 1h Downloader — Twelve Data
─────────────────────────────────────────────
Free API key required (2-min signup, no credit card):
  https://twelvedata.com  → Sign up → Dashboard → API Keys

Free tier: 800 credits/day  |  Each fetch below costs 1-2 credits total.

SETUP:
  1. Paste your key in API_KEY below (or set env var TD_API_KEY=yourkey)
  2. Run:  python download_twelvedata_dax.py

Output:  dax_15m_raw.csv   dax_30m_raw.csv   dax_1h_raw.csv
Next:    python dax_judas_miner.py
"""

import os, time
import requests
import pandas as pd
from pathlib import Path

# ─── PASTE YOUR KEY HERE (or set env var TD_API_KEY) ─────────────────────────
API_KEY = os.getenv("TD_API_KEY", "7a56659902cd4756a8a65068af305db4")

START   = "2023-01-01"       # free tier covers ~2 yrs; adjust if needed
END     = "2026-08-22"
OUT_DIR = Path(r"C:\Users\Omar Nasr\quantum-bot")
BASE    = "https://api.twelvedata.com/time_series"

STEP_MIN = {"15min": 15, "30min": 30, "1h": 60}

TARGETS = [
    ("15min", "dax_15m_raw.csv"),
    ("30min", "dax_30m_raw.csv"),
    ("1h",    "dax_1h_raw.csv"),
]


def fetch(symbol: str, interval: str) -> list:
    """Page through the full date range in 5000-bar chunks (oldest-first)."""
    step     = STEP_MIN[interval]
    curr     = START
    all_bars = []
    page     = 1

    while curr < END:
        params = {
            "symbol":     symbol,
            "interval":   interval,
            "start_date": curr,
            "end_date":   END,
            "outputsize": 5000,
            "order":      "ASC",
            "timezone":   "UTC",
            "apikey":     API_KEY,
        }

        for attempt in range(4):
            try:
                r = requests.get(BASE, params=params, timeout=30)
                d = r.json()
                break
            except Exception as e:
                time.sleep(5)
        else:
            break

        if d.get("status") == "error":
            msg = d.get("message", "")
            # Rate-limited → wait 65s and retry same page
            if "credits" in msg.lower() or "rate" in msg.lower():
                print(f"\n  ⏳ rate limit — waiting 65s ...", end="", flush=True)
                time.sleep(65)
                continue
            # No data for this date range → we've reached the end of history
            if "no data" in msg.lower() or "not available" in msg.lower():
                break
            # Truly invalid symbol
            print(f"\n  ✗ [{symbol}] {msg}")
            return []

        values = d.get("values", [])
        if not values:
            break

        all_bars.extend(values)
        print(f"    page {page}: {len(values)} bars  (total {len(all_bars):,})", end="\r")
        page += 1

        if len(values) < 5000:
            break   # last page — got everything

        last_ts = pd.Timestamp(values[-1]["datetime"])
        curr    = (last_ts + pd.Timedelta(minutes=step)).strftime("%Y-%m-%d %H:%M:%S")
        time.sleep(1.2)   # stay under 8 req/min free-tier limit

    return all_bars


def to_df(bars: list) -> pd.DataFrame:
    df = pd.DataFrame(bars)
    df.index = pd.to_datetime(df["datetime"], utc=True)
    df.index.name = "ts"
    for c in ["open", "high", "low", "close"]:
        df[c] = pd.to_numeric(df[c])
    df = (df[["open", "high", "low", "close"]]
            .sort_index()
            .pipe(lambda d: d[~d.index.duplicated(keep="first")]))
    return df


def main():
    if API_KEY == "YOUR_KEY_HERE":
        print("=" * 60)
        print("  SETUP — get your free key first:")
        print()
        print("  1. Open: https://twelvedata.com")
        print("  2. Sign Up (free, no credit card)")
        print("  3. Dashboard → API Keys → copy key")
        print("  4. Paste it in this file where it says YOUR_KEY_HERE")
        print("     or run:  set TD_API_KEY=yourkey  then re-run script")
        print("=" * 60)
        return

    print("DAX Downloader — Twelve Data")
    print(f"Symbols: DAX / GDAXI  |  {START} → {END}")
    print()

    # ── Auto-discover the correct Frankfurt DAX symbol ───────────────────────
    print("Searching for Frankfurt DAX symbol ...")
    sym_found = None
    r = requests.get("https://api.twelvedata.com/symbol_search", params={
        "symbol": "DAX", "outputsize": 30, "apikey": API_KEY,
    }, timeout=20)
    results = r.json().get("data", [])
    print(f"  Found {len(results)} matches:")
    for item in results:
        sym   = item.get("symbol","")
        name  = item.get("instrument_name","")
        exch  = item.get("exchange","")
        ctype = item.get("instrument_type","")
        country = item.get("country","")
        print(f"    {sym:15s}  {exch:12s}  {ctype:15s}  {country:10s}  {name}")
        # Pick first result that is a German/Frankfurt index or stock
        if sym_found is None and country.lower() in ("germany","de") and "index" in ctype.lower():
            sym_found = sym

    if sym_found is None:
        # Fallback: look for any non-US result
        for item in results:
            if item.get("country","").lower() not in ("united states","us","usa",""):
                sym_found = item.get("symbol")
                break

    if sym_found is None:
        sym_found = "DAX"   # last resort
    print(f"\n  → Using symbol: {sym_found}")
    print()

    symbols_to_try = [sym_found, "^GDAXI", "DAX"]

    for interval, fname in TARGETS:
        print(f"  [{interval}] fetching ...", flush=True)

        bars = []
        for sym in symbols_to_try:
            bars = fetch(sym, interval)
            if bars:
                print(f"\n    symbol: {sym}")
                break
            time.sleep(2)

        print()   # newline after \r progress

        if not bars:
            print(f"  ✗ no data for {interval}")
            continue

        df   = to_df(bars)
        hrs  = sorted(df.index.hour.unique())

        # Reject US-hours data (VanEck DAX ETF trades 13-20 UTC)
        # Frankfurt DAX trades 07-16 UTC
        if min(hrs) >= 13:
            print(f"  ✗ hours={hrs[:3]}... → US market hours, not Frankfurt — wrong symbol")
            continue

        span = (df.index[-1] - df.index[0]).days / 365.25
        out  = OUT_DIR / fname
        df.to_csv(out)
        print(f"  ✓ {len(df):,} bars  "
              f"{df.index[0].date()} → {df.index[-1].date()}  "
              f"({span:.2f}yr)  hours(UTC)={hrs[:4]}..{hrs[-1]}")
        print(f"    Saved → {fname}")
        print()

    print("Done.  Run:  python dax_judas_miner.py")


if __name__ == "__main__":
    main()
