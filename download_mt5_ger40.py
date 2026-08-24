#!/usr/bin/env python3
"""
MT5 Historical Data Exporter — GER40.s (DAX CFD)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Requirements:
  pip install MetaTrader5 pandas

Usage:
  1. Make sure MetaTrader5 terminal is OPEN and LOGGED IN
  2. Run:  python download_mt5_ger40.py
  3. Drop the output CSV files in:  C:\\Users\\Omar Nasr\\quantum-bot\\

Output files (UTC timestamps, OHLC):
  dax_15m_raw.csv   ← main validation target
  dax_30m_raw.csv
  dax_1h_raw.csv
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import MetaTrader5 as mt5
except ImportError:
    print("Installing MetaTrader5 ...")
    import subprocess
    subprocess.run([sys.executable, "-m", "pip", "install", "MetaTrader5", "pandas", "-q"])
    import MetaTrader5 as mt5

import pandas as pd

# ─── CONFIG ──────────────────────────────────────────────────────────────────
SYMBOL     = "GER40.s"
START_DATE = datetime(2020, 1, 1,  tzinfo=timezone.utc)
END_DATE   = datetime(2026, 8, 21, tzinfo=timezone.utc)
OUT_DIR    = Path(r"C:\Users\Omar Nasr\quantum-bot")

TIMEFRAMES = {
    "15m": mt5.TIMEFRAME_M15,
    "30m": mt5.TIMEFRAME_M30,
    "1h":  mt5.TIMEFRAME_H1,
}

# ─── CONNECT ─────────────────────────────────────────────────────────────────
if not mt5.initialize():
    print(f"\n✗ mt5.initialize() failed: {mt5.last_error()}")
    print("  → Make sure MetaTrader5 terminal is running and logged in.")
    sys.exit(1)

acc = mt5.account_info()
print(f"✓ Connected  |  Broker: {acc.server}  |  Account: {acc.login}")
print(f"  Symbol: {SYMBOL}  |  Range: {START_DATE.date()} → {END_DATE.date()}")
print()

# Verify symbol is available
sym_info = mt5.symbol_info(SYMBOL)
if sym_info is None:
    print(f"✗ Symbol '{SYMBOL}' not found on this broker.")
    print("  → Check exact symbol name in MT5 Market Watch. Common variants:")
    print("    GER40   GER40.s   DE40   GERMANY40   DAX40")
    mt5.shutdown()
    sys.exit(1)

print(f"  Symbol info: digits={sym_info.digits}  point={sym_info.point}  spread={sym_info.spread}")
print()

# ─── EXPORT ──────────────────────────────────────────────────────────────────
exported = []
for tf_name, mt5_tf in TIMEFRAMES.items():
    print(f"  Fetching {SYMBOL} {tf_name} ...", end="", flush=True)
    rates = mt5.copy_rates_range(SYMBOL, mt5_tf, START_DATE, END_DATE)

    if rates is None or len(rates) == 0:
        print(f" ✗ FAILED — {mt5.last_error()}")
        print(f"    → Try requesting history download first:")
        print(f"      MT5 → Tools → History Center → {SYMBOL} → {tf_name} → Download")
        continue

    df = pd.DataFrame(rates)
    # MT5 timestamps are in SECONDS since epoch (broker timezone offset already applied → UTC)
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.rename(columns={"time": "ts"})
    df = df[["ts", "open", "high", "low", "close", "tick_volume"]].copy()
    df = df.set_index("ts")
    df.index.name = "ts"

    out_path = OUT_DIR / f"dax_{tf_name}_raw.csv"
    df.to_csv(out_path)

    span = (df.index[-1] - df.index[0]).days / 365.25
    print(f" ✓ {len(df):,} bars | {df.index[0].date()} → {df.index[-1].date()} | {span:.1f}yr → {out_path.name}")
    exported.append(tf_name)

mt5.shutdown()

print()
if exported:
    print(f"✓ Exported: {', '.join(exported)}")
    print(f"\nNext step — run the miner:")
    print(f"  cd C:\\Users\\Omar Nasr\\quantum-bot")
    print(f"  python dax_judas_miner.py")
    print()
    print(f"  (miner reads dax_15m_raw.csv, dax_30m_raw.csv, dax_1h_raw.csv)")
else:
    print("✗ Nothing exported. Check symbol name and MT5 connection.")
