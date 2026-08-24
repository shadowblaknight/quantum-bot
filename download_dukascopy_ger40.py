#!/usr/bin/env python3
"""
Dukascopy GER30/DAX Historical Data Downloader
───────────────────────────────────────────────
No account or API key required.
Downloads 1m candles from Dukascopy public feed → aggregates to 15m / 30m / 1h.
Caches each day locally so partial runs resume instantly.

Output files (UTC timestamps):
    dax_15m_raw.csv   dax_30m_raw.csv   dax_1h_raw.csv   dax_1m_raw.csv

Next step:
    python dax_judas_miner.py

Estimated time (first run): ~50 min for 6 years at 2s/day.
Re-runs are instant (fully cached).
"""

import struct, lzma, time, datetime
from pathlib import Path
from typing import Optional

try:
    import requests
    import pandas as pd
except ImportError:
    import subprocess, sys
    subprocess.run([sys.executable, "-m", "pip", "install", "requests", "pandas", "-q"])
    import requests
    import pandas as pd

# ─── CONFIG ──────────────────────────────────────────────────────────────────
# Dukascopy has two possible instrument names for DAX; probed automatically.
INSTRUMENTS = ["GER30", "GER40"]
START    = datetime.date(2020, 1,  1)
END      = datetime.date(2026, 8, 21)
DELAY    = 2.0     # seconds between live HTTP requests (be polite)
MAX_RETRY = 4
CACHE_DIR = Path(r"C:\Users\Omar Nasr\quantum-bot\dax_duka_cache")
OUT_DIR   = Path(r"C:\Users\Omar Nasr\quantum-bot")

SESS = requests.Session()
SESS.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer":    "https://www.dukascopy.com/",
    "Accept":     "*/*",
})

# ─── BINARY RECORD FORMAT ─────────────────────────────────────────────────────
# Big-endian:  uint32 ms_from_midnight  +  float32 ×5 (open high low close vol)
FMT  = ">Ifffff"
RSIZ = struct.calcsize(FMT)   # 24 bytes per 1m bar


# ─── HELPERS ─────────────────────────────────────────────────────────────────
def day_url(instr: str, date: datetime.date) -> str:
    return (f"https://datafeed.dukascopy.com/datafeed/{instr}/"
            f"{date.year}/{date.month-1:02d}/{date.day:02d}/BID_candles_min_1.bi5")


def probe_instrument() -> str:
    """Find which instrument name is live for a known trading day."""
    probe_day = datetime.date(2024, 1, 2)   # Tuesday, known trading day
    for instr in INSTRUMENTS:
        try:
            r = SESS.get(day_url(instr, probe_day), timeout=20)
            if r.status_code == 200 and len(r.content) > 10:
                print(f"  ✓ Instrument confirmed: {instr}")
                return instr
        except Exception:
            pass
        time.sleep(1.5)
    raise RuntimeError(
        f"None of {INSTRUMENTS} returned data.\n"
        "  Check: internet connection, firewall, or try again in a few minutes."
    )


def fetch_day(instr: str, date: datetime.date) -> Optional[bytes]:
    cache = CACHE_DIR / f"{instr}_{date.isoformat()}.bi5"
    if cache.exists():
        data = cache.read_bytes()
        return data if data else None   # empty file = confirmed holiday

    url = day_url(instr, date)
    for attempt in range(MAX_RETRY):
        try:
            r = SESS.get(url, timeout=30)
            if r.status_code == 200 and r.content:
                cache.write_bytes(r.content)
                return r.content
            if r.status_code in (404, 204):
                cache.write_bytes(b"")   # mark as holiday
                return None
            if r.status_code == 429:
                wait = 20 * (attempt + 1)
                print(f"\n    429 rate-limit — waiting {wait}s", end="", flush=True)
                time.sleep(wait)
                continue
            # Any other HTTP error — skip this day
            return None
        except requests.exceptions.Timeout:
            time.sleep(6 * (attempt + 1))
        except Exception:
            time.sleep(3)
    return None


def parse_bi5(data: bytes, date: datetime.date) -> list:
    try:
        raw = lzma.decompress(data)
    except Exception:
        return []
    base = datetime.datetime(date.year, date.month, date.day,
                             tzinfo=datetime.timezone.utc)
    rows = []
    for i in range(len(raw) // RSIZ):
        ms, o, h, l, c, v = struct.unpack(FMT, raw[i*RSIZ : (i+1)*RSIZ])
        rows.append({
            "ts":     base + datetime.timedelta(milliseconds=int(ms)),
            "open":   o, "high": h, "low": l, "close": c, "volume": v,
        })
    return rows


def iter_weekdays(start: datetime.date, end: datetime.date):
    d = start
    while d <= end:
        if d.weekday() < 5:   # Monday–Friday
            yield d
        d += datetime.timedelta(days=1)


# ─── MAIN ────────────────────────────────────────────────────────────────────
def main():
    days  = list(iter_weekdays(START, END))
    total = len(days)
    est_min = sum(
        1 for d in days
        if not (CACHE_DIR / f"GER30_{d.isoformat()}.bi5").exists()
           and not (CACHE_DIR / f"GER40_{d.isoformat()}.bi5").exists()
    ) * DELAY / 60

    print("=" * 65)
    print("Dukascopy GER30/DAX Downloader  (no API key required)")
    print(f"Range : {START} → {END}  ({total} trading days)")
    print(f"Delay : {DELAY}s per live request  |  Est. new: ~{est_min:.0f} min")
    print(f"Cache : {CACHE_DIR}")
    print("=" * 65)
    print()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print("Detecting instrument name ...")
    instr = probe_instrument()
    print()

    all_bars  = []
    n_cached  = 0
    n_dl      = 0
    n_skip    = 0

    print(f"Fetching {total} days ...")
    for i, day in enumerate(days):
        is_cached = (CACHE_DIR / f"{instr}_{day.isoformat()}.bi5").exists()
        data      = fetch_day(instr, day)

        if data:
            all_bars.extend(parse_bi5(data, day))

        if is_cached:
            n_cached += 1
        elif data:
            n_dl += 1
            time.sleep(DELAY)
        else:
            n_skip += 1
            if not is_cached:
                time.sleep(0.4)   # short pause even on holidays

        if (i + 1) % 100 == 0 or (i + 1) == total:
            print(f"  [{i+1:4d}/{total}] {(i+1)/total*100:.0f}%  "
                  f"bars={len(all_bars):,}  dl={n_dl}  cached={n_cached}  skip={n_skip}")

    if not all_bars:
        print()
        print("✗ No bars collected. Troubleshooting:")
        print("  1. Check internet connection")
        print("  2. Increase DELAY to 3.0 at top of script and run again")
        print("  3. The cache preserves progress — re-runs skip already-fetched days")
        return

    # ── Build 1m DataFrame ────────────────────────────────────────────────────
    df1m = pd.DataFrame(all_bars)
    df1m["ts"] = pd.to_datetime(df1m["ts"], utc=True)
    df1m = (df1m.set_index("ts")
                .sort_index()
                .pipe(lambda d: d[~d.index.duplicated(keep="first")]))

    # Price sanity check — DAX should be roughly 10000–20000 in 2020-2026
    med = df1m["close"].median()
    print(f"\n  Median close = {med:.2f}", end="")
    if med < 1000:
        df1m[["open","high","low","close"]] *= 10
        print("  → scaled ×10")
    elif med > 200_000:
        df1m[["open","high","low","close"]] /= 10
        print("  → scaled ÷10")
    else:
        print("  ✓ prices look correct")

    span = (df1m.index[-1] - df1m.index[0]).days / 365.25
    print(f"  1m: {len(df1m):,} bars  "
          f"{df1m.index[0].date()} → {df1m.index[-1].date()}  ({span:.2f}yr)")

    # ── Save 1m ───────────────────────────────────────────────────────────────
    out1m = OUT_DIR / "dax_1m_raw.csv"
    df1m.to_csv(out1m)
    print(f"  Saved → {out1m.name}")

    # ── Resample to target timeframes ─────────────────────────────────────────
    agg = {"open":"first", "high":"max", "low":"min",
           "close":"last", "volume":"sum"}
    for rule, name in [("15min","15m"), ("30min","30m"), ("1h","1h")]:
        dfr = (df1m.resample(rule, closed="left", label="left")
                   .agg(agg)
                   .dropna(subset=["open"]))
        out = OUT_DIR / f"dax_{name}_raw.csv"
        dfr.to_csv(out)
        print(f"  Saved → {out.name}  ({len(dfr):,} bars)")

    print()
    print("✓ All done!  Run the miner next:")
    print("  python dax_judas_miner.py")


if __name__ == "__main__":
    main()
