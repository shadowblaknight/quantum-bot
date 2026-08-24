#!/usr/bin/env python3
"""
DAX Frankfurt ORB Miner — Multi-Timeframe
Strategy: Frankfurt ORB (first hour of session) → sweep of ORB range → BOS
          → FVG retest entry in European morning session
Auto-fetches ^GDAXI 1h from Yahoo Finance (2.87 yr).
For 15m/30m: drop an MT5 export as  dax_15m_raw.csv / dax_30m_raw.csv
  (columns: datetime, open, high, low, close — UTC timestamps)

Two sub-approaches tested:
  ICT Sweep:   ORB range swept then reversed → trade the reversal
  ORB Breakout: first BOS beyond ORB range → trade the breakout (no sweep req.)
"""

import warnings
warnings.filterwarnings("ignore")
import sys
import time
import pandas as pd
import numpy as np
from pathlib import Path

# ─── CONFIG ──────────────────────────────────────────────────────────────────
TP_MULT    = 2.0
SL_BUF     = 0.15      # × ATR below/above FVG edge
ATR_LEN    = 14

# FVG min in DAX points (GER40 ≈ €1 per point notional, similar to NQ)
FVG_DEFAULTS  = {"15m": 20.0, "30m": 30.0, "1h": 40.0, "4h": 80.0}
FVG_SWEEPS    = {
    "15m": [5,  10, 15,  20,  30,  50,  75, 100],
    "30m": [10, 15, 20,  30,  50,  75, 100, 150],
    "1h":  [15, 20, 30,  40,  60,  80, 120, 200],
    "4h":  [30, 50, 80, 120, 200, 300, 500, 750],
}

# Session bar counts per TF (all relative to session start bar = 0)
# ORB    = first N bars = first 60 min of Frankfurt session
# Sweep  = check for ORB sweep within sweep_end bars
# Entry  = FVG entry window closes at entry_end bar
# Close  = hard close at close_bar (no new entries, resolve existing)
TF_SESSION = {
    "15m": dict(orb=4,  sweep_end=12, entry_end=28, close_bar=32),  # 4×15=60m ORB, 8h session
    "30m": dict(orb=2,  sweep_end=6,  entry_end=14, close_bar=16),  # 2×30=60m ORB
    "1h":  dict(orb=1,  sweep_end=3,  entry_end=7,  close_bar=8),   # 1×60=60m ORB
    "4h":  dict(orb=1,  sweep_end=2,  entry_end=4,  close_bar=4),   # 1×4h ORB
}
# Defaults (overridden per TF via TF_SESSION)
ORB_BARS       = 1
SWEEP_END_BAR  = 3
ENTRY_END_BAR  = 7
HARD_CLOSE_BAR = 8

DATA_DIR = Path("dax_miner_data")
SEP      = "═" * 70


# ─── DATA LOADING ────────────────────────────────────────────────────────────
def load_yfinance_1h() -> pd.DataFrame:
    try:
        import yfinance as yf
    except ImportError:
        print("  Installing yfinance ...")
        import subprocess; subprocess.run([sys.executable, "-m", "pip", "install", "yfinance", "-q"])
        import yfinance as yf

    cache = DATA_DIR / "dax_1h_yahoo.csv"
    if cache.exists():
        print("  Loading cached ^GDAXI 1h ...", end="", flush=True)
        df = pd.read_csv(cache, index_col=0, parse_dates=True)
        if df.index.tz is None:
            df.index = df.index.tz_localize("UTC")
        print(f" {len(df):,} bars")
        return df

    print("  Fetching ^GDAXI 1h from Yahoo Finance ...", end="", flush=True)
    raw = yf.download("^GDAXI", period="730d", interval="1h",
                       progress=False, auto_adjust=True)
    if raw.empty:
        raise RuntimeError("yfinance returned no data")

    # Flatten multi-level columns if present
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = [c[0].lower() for c in raw.columns]
    else:
        raw.columns = [c.lower() for c in raw.columns]

    df = raw[["open","high","low","close","volume"]].copy()
    df = df[~df.index.duplicated()].sort_index()
    # Convert to UTC
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")
    df.index.name = "ts"
    df = df.drop(columns=["volume"], errors="ignore")

    print(f" {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})")
    DATA_DIR.mkdir(exist_ok=True)
    df.to_csv(cache)
    return df


def load_csv(path: str) -> pd.DataFrame:
    print(f"  Loading {path} ...", end="", flush=True)
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")
    df.columns = [c.lower().strip() for c in df.columns]
    df.index.name = "ts"
    df = df[["open","high","low","close"]].copy()
    df = df[~df.index.duplicated()].sort_index().dropna()
    print(f" {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})")
    return df


# ─── ATR ─────────────────────────────────────────────────────────────────────
def add_atr(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    h, l, c = df["high"], df["low"], df["close"].shift()
    tr = pd.concat([(h-l), (h-c).abs(), (l-c).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1/ATR_LEN, adjust=False).mean()
    return df


# ─── SIGNAL EXTRACTION ───────────────────────────────────────────────────────
def extract_signals(df: pd.DataFrame, fvg_min: float, approach: str = "sweep",
                    sess: dict = None) -> pd.DataFrame:
    """
    approach='sweep'    — ICT: ORB swept + reversed, trade reversal
    approach='breakout' — Classical ORB: BOS beyond ORB, trade continuation
    """
    df = df.copy()
    df["date"] = df.index.normalize().tz_localize(None)

    if sess is None:
        sess = dict(orb=ORB_BARS, sweep_end=SWEEP_END_BAR,
                    entry_end=ENTRY_END_BAR, close_bar=HARD_CLOSE_BAR)
    ORB  = sess["orb"];  SW_END = sess["sweep_end"]
    EN_END = sess["entry_end"];  CL_BAR = sess["close_bar"]

    records = []
    for day, day_df in df.groupby("date"):
        bars = day_df.reset_index()
        bars.rename(columns={bars.columns[0]: "ts"}, inplace=True)
        n    = len(bars)
        if n < ORB + 2:
            continue

        # ── ORB (first N bars)
        orb  = bars.iloc[:ORB]
        orb_hi = orb["high"].max()
        orb_lo = orb["low"].min()
        if (orb_hi - orb_lo) < 5:       # degenerate / holiday
            continue

        atr_v = float(bars["atr"].iloc[ORB]) if not np.isnan(bars["atr"].iloc[ORB]) else (orb_hi - orb_lo)

        if approach == "sweep":
            # Look for ORB sweep in bars ORB..SW_END
            sw_zone = bars.iloc[ORB : SW_END + 1]
            sw_hi = (sw_zone["high"]  > orb_hi).any()
            sw_lo = (sw_zone["low"]   < orb_lo).any()

            if   sw_lo and not sw_hi:
                bias = 1;  sw_q = "clean_lo"
            elif sw_hi and not sw_lo:
                bias = -1; sw_q = "clean_hi"
            elif sw_lo and sw_hi:
                last = sw_zone.iloc[-1]
                bias = 1 if last["close"] < last["open"] else -1
                sw_q = "both"
            else:
                continue   # no sweep

            # BOS: close beyond ORB in bias direction (after sweep zone)
            bos_zone = bars.iloc[ORB:]
            bos_seen = False
            for _, row in bos_zone.iterrows():
                if bias == 1  and row["close"] > orb_hi: bos_seen = True; break
                if bias == -1 and row["close"] < orb_lo: bos_seen = True; break
            if not bos_seen:
                continue

        else:  # breakout
            # First bar that closes beyond ORB range
            bos_zone = bars.iloc[ORB:]
            bias  = None; sw_q = "bk"
            for _, row in bos_zone.iterrows():
                if row["close"] > orb_hi: bias = 1;  break
                if row["close"] < orb_lo: bias = -1; break
            if bias is None:
                continue

        # ── FVG detection in entry window
        ew = bars.iloc[ORB : EN_END + 1].reset_index(drop=True)
        if len(ew) < 3:
            continue

        sig = None
        for j in range(2, len(ew)):
            bar   = ew.iloc[j]
            prev2 = ew.iloc[j-2]
            av    = float(bar["atr"]) if not np.isnan(bar["atr"]) else atr_v

            if bias == 1:
                gap = float(bar["low"]) - float(prev2["high"])
                if gap < fvg_min:
                    continue
                fvg_lo = float(prev2["high"])
                fvg_hi = float(bar["low"])
                sl     = fvg_lo - av * SL_BUF
                ep     = float(bar["close"])
                dist   = ep - sl
                if dist <= 0: continue
                tp = ep + dist * TP_MULT
            else:
                gap = float(prev2["low"]) - float(bar["high"])
                if gap < fvg_min:
                    continue
                fvg_hi = float(prev2["low"])
                fvg_lo = float(bar["high"])
                sl     = fvg_hi + av * SL_BUF
                ep     = float(bar["close"])
                dist   = sl - ep
                if dist <= 0: continue
                tp = ep - dist * TP_MULT

            sig = dict(
                date=day, ts=bar["ts"], bias=bias, sw_q=sw_q,
                orb_hi=orb_hi, orb_lo=orb_lo, orb_rng=orb_hi-orb_lo,
                fvg_lo=fvg_lo, fvg_hi=fvg_hi, fvg_size=gap,
                entry=ep, sl=sl, tp=tp, sl_dist=dist, atr=av,
                session_bar=j,
            )
            break

        if sig is None:
            continue

        # ── Resolve — use remaining session bars up to CL_BAR
        remaining = bars.iloc[ORB + sig["session_bar"] + 1 : CL_BAR + 1]
        win, exit_ts, mfe = resolve(remaining, sig["entry"], sig["sl"], sig["tp"], bias)
        sig.update(win=win, exit_ts=exit_ts, mfe=mfe,
                   mfe_r=mfe/sig["sl_dist"] if sig["sl_dist"] > 0 else 0)
        records.append(sig)

    return pd.DataFrame(records) if records else pd.DataFrame()


def resolve(bars, entry, sl, tp, bias):
    mfe = 0.0
    for _, row in bars.iterrows():
        sl_hit = (row["low"]  <= sl) if bias == 1 else (row["high"] >= sl)
        tp_hit = (row["high"] >= tp) if bias == 1 else (row["low"]  <= tp)

        if sl_hit and tp_hit:
            return False, row["ts"], mfe
        if sl_hit:
            return False, row["ts"], mfe
        if tp_hit:
            mfe = max(mfe, (tp-entry) if bias == 1 else (entry-tp))
            return True, row["ts"], mfe

        fav = (row["high"]-entry) if bias == 1 else (entry-row["low"])
        mfe = max(mfe, fav)

    # Hard close — last bar
    ts_last = bars.index[-1] if not bars.empty else None
    return False, ts_last, mfe


# ─── STATS ───────────────────────────────────────────────────────────────────
def _pf(df):
    if df.empty: return 0.0
    w = df[df["win"]==1]; l = df[df["win"]==0]
    gw = (w["sl_dist"] * TP_MULT).sum(); gl = l["sl_dist"].sum()
    return round(gw/gl, 3) if gl > 0 else (float("inf") if gw > 0 else 0.0)

def _wr(df): return round(df["win"].mean()*100, 1) if not df.empty else 0.0
def _tpy(df, s): return round(len(df)/s, 1) if s > 0 else 0.0
def _fmt(df, span, note=""):
    return f"N={len(df):4d}  {_tpy(df,span):5.1f}/yr  WR={_wr(df):5.1f}%  PF={_pf(df):6.3f}  {note}"


# ─── ANALYZE ─────────────────────────────────────────────────────────────────
def analyze(df: pd.DataFrame, tf: str, span: float, approach: str):
    fmin = FVG_DEFAULTS[tf]
    sess = TF_SESSION.get(tf, TF_SESSION["1h"])
    aname = "ICT Sweep" if approach == "sweep" else "ORB Breakout"

    print(f"\n{SEP}")
    print(f"  [{tf}] {aname.upper()}  FVG≥{fmin}pts  TP={TP_MULT}×")
    print(SEP)

    sig = extract_signals(df, fmin, approach, sess)
    if sig.empty:
        print("  No signals found.")
        return None

    print(f"  Full dataset:   {_fmt(sig, span)}")

    print(f"\n  Direction:")
    for b, label in [(1,"LONG"), (-1,"SHORT")]:
        s = sig[sig["bias"] == b]
        mark = " ★★" if _pf(s) > 2.0 else (" ★" if _pf(s) > 1.4 else "")
        print(f"    {label:5s}: {_fmt(s, span, mark)}")

    if approach == "sweep":
        print(f"\n  Sweep quality:")
        for q, ql in [("clean_lo","Asian LO sweep (LONG)"), ("clean_hi","Asian HI sweep (SHORT)"), ("both","Both (tiebreak)")]:
            s = sig[sig["sw_q"] == q]
            mark = " ★★" if _pf(s) > 2.0 else (" ★" if _pf(s) > 1.4 else "")
            print(f"    {ql}: {_fmt(s, span, mark)}")

    print(f"\n  Day-of-week:")
    sig["dow"] = pd.to_datetime(sig["date"]).dt.dayofweek
    DOW = {0:"Mon",1:"Tue",2:"Wed",3:"Thu",4:"Fri"}
    for d in sorted(sig["dow"].unique()):
        s = sig[sig["dow"] == d]
        mark = " ★★★" if _pf(s) > 4 else (" ★★" if _pf(s) > 2 else (" ★" if _pf(s) > 1.4 else ""))
        print(f"    {DOW.get(d,'?'):3s}: {_fmt(s, span, mark)}")

    # FVG min sweep
    print(f"\n  FVG min sweep:")
    print(f"  {'FVG':>8s}  {'N':>5s}  {'T/yr':>6s}  {'WR%':>6s}  {'PF':>7s}")
    for fv in FVG_SWEEPS[tf]:
        s = extract_signals(df, fv, approach, sess)
        mark = " ←" if fv == fmin else ""
        print(f"  {fv:>7.0f}pt  {len(s):>5d}  {_tpy(s,span):>6.1f}  {_wr(s):>6.1f}%  {_pf(s):>7.3f}{mark}")

    # TP sweep (MFE-based)
    print(f"\n  TP sweep (MFE-based):")
    print(f"  {'TP':>6s}  {'WR%':>6s}  {'PF':>7s}  Wins")
    mfe_a = sig["mfe"].values; sld_a = sig["sl_dist"].values
    for tm in [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0]:
        tp_d  = tm * sld_a; wins = (mfe_a >= tp_d)
        gw    = (sld_a[wins] * tm).sum(); gl = sld_a[~wins].sum()
        pf_v  = round(gw/gl, 3) if gl > 0 else (float("inf") if gw > 0 else 0.0)
        mark  = " ←" if tm == TP_MULT else ""
        print(f"  {tm:>5.2f}×  {wins.sum()/len(sig)*100:>6.1f}%  {pf_v:>7.3f}  {wins.sum()}{mark}")

    # Year-by-year
    print(f"\n  Year-by-year:")
    sig["year"] = pd.to_datetime(sig["date"]).dt.year
    print(f"  {'Year':>6s}  {'N':>4s}  {'WR%':>6s}  {'PF':>7s}  verdict")
    cumr = peak = mxdd = 0.0
    for yr in sorted(sig["year"].unique()):
        s = sig[sig["year"] == yr]; p = _pf(s)
        v = "OK" if p >= 1.2 else ("X" if p < 0.7 else "~")
        print(f"  {yr}    {len(s):>4d}  {_wr(s):>6.1f}%  {p:>7.3f}  {v}")
        for _, row in s.iterrows():
            cumr += TP_MULT if row["win"] else -1.0
            peak = max(peak, cumr); mxdd = max(mxdd, peak-cumr)
    print(f"\n  Cumulative R: peak={peak:.1f}R  final={cumr:.1f}R  max-DD={mxdd:.1f}R")

    # Save signals
    out = DATA_DIR / f"dax_{tf}_{approach}_signals.csv"
    sig.to_csv(out, index=False)
    print(f"\n  Saved → {out.name}")
    return sig


# ─── MAIN ────────────────────────────────────────────────────────────────────
def run_tf(tf: str, df: pd.DataFrame, span: float):
    print(f"\n\n{'#'*70}")
    print(f"# TIMEFRAME: {tf.upper()}")
    print(f"{'#'*70}")
    print(f"\n  {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})  span={span:.2f}yr")

    r_sweep = analyze(df, tf, span, "sweep")
    r_bk    = analyze(df, tf, span, "breakout")
    return r_sweep, r_bk


def main():
    DATA_DIR.mkdir(exist_ok=True)

    print("=" * 70)
    print("DAX FRANKFURT ORB MINER — MULTI-TIMEFRAME")
    print("Approaches: [A] ICT Sweep & Reverse  [B] Classical ORB Breakout")
    print("=" * 70)

    results  = {}
    spans    = {}

    # ── 1h: auto-fetch from Yahoo Finance
    df_1h        = add_atr(load_yfinance_1h())
    spans["1h"]  = (df_1h.index[-1] - df_1h.index[0]).days / 365.25
    results["1h"] = run_tf("1h", df_1h, spans["1h"])

    # ── 15m / 30m: load from user-provided CSV if present
    for tf, path in [("15m", "dax_15m_raw.csv"), ("30m", "dax_30m_raw.csv")]:
        p = Path(path)
        if p.exists():
            df_tf       = add_atr(load_csv(str(p)))
            spans[tf]   = (df_tf.index[-1] - df_tf.index[0]).days / 365.25
            results[tf] = run_tf(tf, df_tf, spans[tf])
        else:
            print(f"\n  [{tf}] No data file found ({path}) — export from MT5 to validate on {tf}")

    # ── Summary
    print(f"\n\n{'='*70}")
    print("SUMMARY — ALL TIMEFRAMES × BOTH APPROACHES")
    print(f"{'='*70}")
    print(f"  {'TF':>4s}  {'Approach':>12s}  {'N':>5s}  {'T/yr':>6s}  {'WR%':>6s}  {'PF':>7s}")
    for tf, (rs, rb) in results.items():
        s_yrs = spans.get(tf, 0)
        for label, sig in [("ICT-Sweep", rs), ("ORB-BK", rb)]:
            if sig is None or sig.empty:
                print(f"  {tf:>4s}  {label:>12s}  — no signals —")
                continue
            print(f"  {tf:>4s}  {label:>12s}  {len(sig):>5d}  {_tpy(sig,s_yrs):>6.1f}  {_wr(sig):>6.1f}%  {_pf(sig):>7.3f}")

    print(f"\n  MT5 export instructions for 15m/30m:")
    print(f"  MT5 → symbol GER40 → History Center → export CSV → save as dax_15m_raw.csv")
    print(f"  Columns needed: datetime (UTC), open, high, low, close")

    print(f"\n{'='*70}")
    print("DONE")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
