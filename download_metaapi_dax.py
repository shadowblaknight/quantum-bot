#!/usr/bin/env python3
"""
DAX 15m / 30m / 1h Downloader — MetaAPI
Same API the bot uses in candle-source.js — direct from your broker.
Symbol: GER40.s  |  Region: london

Output:  dax_15m_raw.csv   dax_30m_raw.csv   dax_1h_raw.csv
Next:    python dax_judas_miner.py
"""

import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
import pandas as pd

# ─── CREDENTIALS — read from .env.local ──────────────────────────────────────
def _load_env(path):
    env = {}
    try:
        for line in open(path):
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    except FileNotFoundError:
        pass
    return env

_env = _load_env(r"C:\Users\Omar Nasr\quantum-bot\.env.local")
TOKEN      = _env.get("METAAPI_TOKEN", "")
ACCOUNT_ID = _env.get("METAAPI_ACCOUNT_ID", "760fa78c-931e-4b3f-a4b4-9c308b06e169")
REGION     = "london"
SYMBOL     = "GER40.s"
START_DATE = datetime(2023, 1, 1, tzinfo=timezone.utc)
OUT_DIR    = Path(r"C:\Users\Omar Nasr\quantum-bot")

BASE    = f"https://mt-market-data-client-api-v1.{REGION}.agiliumtrade.ai"
HEADERS = {"auth-token": TOKEN, "Accept": "application/json"}
LIMIT   = 1000

TF_MIN = {"5m": 5, "15m": 15, "30m": 30, "1h": 60}
TARGETS = [
    ("5m",  "dax_5m_raw.csv"),
    ("15m", "dax_15m_raw.csv"),
    ("30m", "dax_30m_raw.csv"),
    ("1h",  "dax_1h_raw.csv"),
]


def fetch_batch(tf: str, start_time: datetime) -> list:
    url = (
        f"{BASE}/users/current/accounts/{ACCOUNT_ID}"
        f"/historical-market-data/symbols/{SYMBOL}"
        f"/timeframes/{tf}/candles"
        f"?startTime={start_time.strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
        f"&limit={LIMIT}"
    )
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)
    except Exception as e:
        print(f"\n  request error: {e}")
        return []

    if r.status_code == 401:
        print("\n  ✗ 401 Unauthorized — token may have expired")
        return None   # signal to stop
    if r.status_code != 200:
        print(f"\n  ✗ HTTP {r.status_code}: {r.text[:200]}")
        return []

    data = r.json()
    return data if isinstance(data, list) else []


def fetch_all(tf: str) -> pd.DataFrame:
    step = timedelta(minutes=TF_MIN[tf])
    all_bars: list = []
    # Start just past now so the current (possibly open) candle is included
    current = datetime.now(timezone.utc) + step
    batch_n = 1

    while True:
        batch = fetch_batch(tf, current)
        if batch is None:       # auth error — stop everything
            return pd.DataFrame()
        if not batch:
            break

        all_bars.extend(batch)
        oldest = min(pd.Timestamp(b["time"]) for b in batch)
        print(f"    batch {batch_n}: {len(batch)} bars  oldest={oldest.date()}  "
              f"total={len(all_bars):,}", end="\r")
        batch_n += 1

        if oldest <= pd.Timestamp(START_DATE):
            break
        if len(batch) < LIMIT:
            break

        # Walk backward: next startTime is one step before the oldest bar
        current = oldest.to_pydatetime() - step
        time.sleep(0.8)

    print()   # newline after \r
    if not all_bars:
        return pd.DataFrame()

    df = pd.DataFrame(all_bars)
    df["ts"] = pd.to_datetime(df["time"], utc=True)
    df = df.set_index("ts").sort_index()
    df.columns = [c.lower() for c in df.columns]
    df = df[["open", "high", "low", "close"]].dropna()
    df = df[df.index >= pd.Timestamp(START_DATE)]
    df = df[~df.index.duplicated(keep="first")]
    df.index.name = "ts"
    return df


def main():
    print("DAX Downloader — MetaAPI")
    print(f"Symbol: {SYMBOL}  |  Account: {ACCOUNT_ID[:8]}...  |  Region: {REGION}")
    print(f"Range:  {START_DATE.date()} → today")
    print()

    for tf, fname in TARGETS:
        print(f"  [{tf}] fetching ...", flush=True)
        df = fetch_all(tf)

        if df.empty:
            print(f"  ✗ no data for {tf}")
            continue

        span = (df.index[-1] - df.index[0]).days / 365.25
        hrs  = sorted(df.index.hour.unique())
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
