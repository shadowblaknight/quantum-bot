#!/usr/bin/env python3
"""
DAX Frankfurt Judas Swing Miner — Multi-Timeframe

AUTO-DETECTS data type:
  24h futures (MT5/Dukascopy):  Asian range 00:00-07:00 UTC → Frankfurt sweep 07:00-08:30 UTC
  Cash session (Yahoo Finance):  ORB range 07:00-09:00 UTC  → London sweep  09:00-10:30 UTC

Run download:
  python download_yf_dax.py          ← Yahoo Finance ^GDAXI (cash, 730 days)
  python download_mt5_ger40.py       ← MT5 futures (full 24h, if available)
  python download_dukascopy_ger40.py ← Dukascopy public feed (full 24h)

Files:  dax_15m_raw.csv  dax_30m_raw.csv  dax_1h_raw.csv
"""

import pandas as pd
import numpy as np
from pathlib import Path

# ─── CONFIG ──────────────────────────────────────────────────────────────────
TP_MULT      = 2.0
SL_BUF       = 0.15
ATR_LEN      = 14

# ── FULL 24h mode (MT5 / Dukascopy futures data)
ASIAN_S      = 0;   ASIAN_E  = 7     # Asian range build
FRANK_S      = 7;   FRANK_E  = 8.5   # Frankfurt sweep window
ENTRY_S      = 7;   ENTRY_E  = 10    # FVG entry window
HARD_CLOSE   = 11                    # Hard close (dead zone starts)
ASIAN_MIN    = 15.0
ASIAN_MAX    = 80.0

# ── CASH SESSION mode (Yahoo Finance ^GDAXI cash data)
ORB_S        = 7;   ORB_E    = 9     # Frankfurt first-2h as range proxy
SWEEP_S      = 9;   SWEEP_E  = 10.5  # London open sweep window
ENTRY_S_C    = 9;   ENTRY_E_C = 12   # FVG entry window
HARD_CLOSE_C = 13                    # Hard close before NY
ORB_MIN      = 20.0                  # Min range to trade
ORB_MAX      = 150.0                 # Max range (news day filter)

# FVG min per TF (DAX points)
FVG_MIN_BY_TF = {"15m": 15.0, "30m": 20.0, "1h": 30.0}

FVG_SWEEP_BY_TF = {
    "15m": [5,  8,  10, 12, 15, 18, 20, 25, 30, 40],
    "30m": [8,  10, 15, 20, 25, 30, 40, 50, 60, 80],
    "1h":  [10, 15, 20, 25, 30, 40, 50, 60, 80, 100],
}

SEP = "═" * 70


# ─── LOAD DATA ────────────────────────────────────────────────────────────────
def load_csv(path: str) -> pd.DataFrame:
    print(f"  Loading {path} ...", end="", flush=True)
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")
    df.columns = [c.lower().strip() for c in df.columns]
    df.index.name = "ts"
    for col in ["open", "high", "low", "close"]:
        if col not in df.columns:
            raise ValueError(f"Missing column: {col} in {path}")
    df = df[["open", "high", "low", "close"]].dropna()
    df = df[~df.index.duplicated(keep="first")].sort_index()
    span = (df.index[-1] - df.index[0]).days / 365.25
    print(f" {len(df):,} bars  {df.index[0].date()} → {df.index[-1].date()}  ({span:.2f}yr)")
    return df


# ─── ATR ──────────────────────────────────────────────────────────────────────
def add_atr(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    h, l, c = df["high"], df["low"], df["close"].shift()
    tr = pd.concat([(h-l), (h-c).abs(), (l-c).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1/ATR_LEN, adjust=False).mean()
    return df


# ─── DATA MODE DETECTION ─────────────────────────────────────────────────────
def detect_mode(df: pd.DataFrame) -> str:
    """'full24h' if data has overnight bars (00:00-07:00 UTC), else 'cash'."""
    overnight = df[df.index.hour < 7]
    pct = len(overnight) / len(df) if len(df) > 0 else 0
    mode = "full24h" if pct > 0.05 else "cash"
    print(f"  Data mode: {mode.upper()}  "
          f"(overnight bars: {len(overnight):,} / {len(df):,} = {pct:.1%})")
    if mode == "cash":
        print("  Using Frankfurt ORB range (07:00-09:00 UTC) as Asian-range proxy")
    return mode


# ─── SIGNAL EXTRACTION ───────────────────────────────────────────────────────
def extract_signals(df: pd.DataFrame, fvg_min: float,
                    req_closeback: bool = True, mode: str = "auto") -> pd.DataFrame:
    """
    mode='full24h': True Judas Swing — overnight Asian range 00:00-07:00 UTC.
    mode='cash':    ORB proxy — Frankfurt first-2h range 07:00-09:00 UTC.
    mode='auto':    detect from data.
    """
    if mode == "auto":
        mode = detect_mode(df)

    if mode == "full24h":
        rng_s, rng_e   = ASIAN_S,   ASIAN_E
        swp_s, swp_e   = FRANK_S,   FRANK_E
        ent_s, ent_e   = ENTRY_S,   ENTRY_E
        hard_c         = HARD_CLOSE
        rng_min        = ASIAN_MIN
        rng_max        = ASIAN_MAX
    else:
        rng_s, rng_e   = ORB_S,     ORB_E
        swp_s, swp_e   = SWEEP_S,   SWEEP_E
        ent_s, ent_e   = ENTRY_S_C, ENTRY_E_C
        hard_c         = HARD_CLOSE_C
        rng_min        = ORB_MIN
        rng_max        = ORB_MAX

    df = df.copy()
    df["date"] = df.index.normalize().tz_localize(None)

    records = []
    for day, dd in df.groupby("date"):
        h = dd.index.hour + dd.index.minute / 60.0

        # ── Build range
        rng_bars = dd[(h >= rng_s) & (h < rng_e)]
        if len(rng_bars) < 1:
            continue
        a_hi  = rng_bars["high"].max()
        a_lo  = rng_bars["low"].min()
        a_rng = a_hi - a_lo
        if a_rng < rng_min or a_rng > rng_max:
            continue

        # ── Sweep (sweep zone)
        swp_bars = dd[(h >= swp_s) & (h < swp_e)]
        if swp_bars.empty:
            continue

        sw_lo = False; sw_hi = False; bias = 0
        for ts, row in swp_bars.iterrows():
            if not sw_lo and row["low"]  < a_lo: sw_lo = True
            if not sw_hi and row["high"] > a_hi: sw_hi = True
            if sw_lo and not sw_hi:
                if not req_closeback or row["close"] >= a_lo:
                    bias = 1; break
            elif sw_hi and not sw_lo:
                if not req_closeback or row["close"] <= a_hi:
                    bias = -1; break
            elif sw_lo and sw_hi:
                bias = 1 if row["close"] < row["open"] else -1; break

        if bias == 0:
            continue

        # ── BOS: close beyond range in bias direction
        post_swp = dd[h >= swp_s]
        bos_seen = False
        for ts, row in post_swp.iterrows():
            if bias == 1  and row["close"] > a_hi: bos_seen = True; break
            if bias == -1 and row["close"] < a_lo: bos_seen = True; break
        if not bos_seen:
            continue

        # ── FVG detection in entry window
        ew = dd[(h >= ent_s) & (h < ent_e)].reset_index()
        ew.rename(columns={ew.columns[0]: "ts"}, inplace=True)
        if len(ew) < 3:
            continue

        sig = None
        for j in range(2, len(ew)):
            bar   = ew.iloc[j]
            prev2 = ew.iloc[j-2]
            atr_v = float(bar["atr"]) if "atr" in bar and not np.isnan(bar["atr"]) else a_rng

            if bias == 1:
                gap = float(bar["low"]) - float(prev2["high"])
                if gap < fvg_min: continue
                fvg_lo = float(prev2["high"]); fvg_hi = float(bar["low"])
                sl = fvg_lo - atr_v * SL_BUF
                ep = float(bar["close"]); dist = ep - sl
                if dist <= 0: continue
                tp = ep + dist * TP_MULT
            else:
                gap = float(prev2["low"]) - float(bar["high"])
                if gap < fvg_min: continue
                fvg_hi = float(prev2["low"]); fvg_lo = float(bar["high"])
                sl = fvg_hi + atr_v * SL_BUF
                ep = float(bar["close"]); dist = sl - ep
                if dist <= 0: continue
                tp = ep - dist * TP_MULT

            sig = dict(
                date=day, ts=bar["ts"], bias=bias,
                sw_lo=sw_lo, sw_hi=sw_hi,
                a_hi=a_hi, a_lo=a_lo, a_rng=a_rng,
                fvg_lo=fvg_lo, fvg_hi=fvg_hi, fvg_size=gap,
                entry=ep, sl=sl, tp=tp, sl_dist=dist, atr=atr_v,
                mode=mode,
            )
            break

        if sig is None:
            continue

        future = dd[dd.index > sig["ts"]]
        win, exit_ts, mfe = resolve(future, sig["entry"], sig["sl"], sig["tp"],
                                    bias, hard_c)
        sig.update(win=win, exit_ts=exit_ts, mfe=mfe,
                   mfe_r=mfe/sig["sl_dist"] if sig["sl_dist"] > 0 else 0)
        records.append(sig)

    return pd.DataFrame(records) if records else pd.DataFrame()


def resolve(future, entry, sl, tp, bias, hard_c=11):
    mfe = 0.0
    for ts, row in future.iterrows():
        if ts.hour >= hard_c:
            fav = (row["high"]-entry) if bias == 1 else (entry-row["low"])
            return False, ts, max(mfe, fav)
        sl_hit = (row["low"]  <= sl) if bias == 1 else (row["high"] >= sl)
        tp_hit = (row["high"] >= tp) if bias == 1 else (row["low"]  <= tp)
        if sl_hit and tp_hit: return False, ts, mfe
        if sl_hit:  return False, ts, mfe
        if tp_hit:
            mfe = max(mfe, (tp-entry) if bias == 1 else (entry-tp))
            return True, ts, mfe
        fav = (row["high"]-entry) if bias == 1 else (entry-row["low"])
        mfe = max(mfe, fav)
    return False, future.index[-1] if not future.empty else None, mfe


# ─── STATS ───────────────────────────────────────────────────────────────────
def _pf(df):
    if df.empty: return 0.0
    w = df[df["win"]==1]; l = df[df["win"]==0]
    gw = (w["sl_dist"]*TP_MULT).sum(); gl = l["sl_dist"].sum()
    return round(gw/gl, 3) if gl > 0 else (float("inf") if gw > 0 else 0.0)

def _wr(df): return round(df["win"].mean()*100, 1) if not df.empty and "win" in df else 0.0
def _tpy(df, s): return round(len(df)/s, 1) if s > 0 else 0.0
def _fmt(df, span, note=""):
    return f"N={len(df):4d}  {_tpy(df,span):5.1f}/yr  WR={_wr(df):5.1f}%  PF={_pf(df):6.3f}  {note}"


# ─── ANALYZE ONE TIMEFRAME ────────────────────────────────────────────────────
def analyze_tf(tf: str, df: pd.DataFrame):
    print(f"\n\n{'#'*70}")
    print(f"# TIMEFRAME: {tf.upper()}")
    print(f"{'#'*70}")

    fmin = FVG_MIN_BY_TF.get(tf, 15.0)
    span = (df.index[-1] - df.index[0]).days / 365.25
    print(f"\n  Default FVG min: {fmin}pt  |  Dataset span: {span:.2f}yr")

    mode = detect_mode(df)   # detect once, pass to all calls

    # ── Section 1: Baseline ──────────────────────────────────────────────────
    rng_label = "Asian range 00:00-07:00 UTC" if mode == "full24h" else "Frankfurt ORB 07:00-09:00 UTC"
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 1 — BASELINE  {rng_label}  FVG≥{fmin}pt  TP={TP_MULT}×")
    print(SEP)

    sig = extract_signals(df, fmin, mode=mode)
    if sig.empty:
        print("  No signals. Check: range valid days, FVG min size, data coverage.")
        return None, span

    print(f"  Full dataset:   {_fmt(sig, span)}")

    print(f"\n  Direction:")
    for b, label in [(1,"LONG"), (-1,"SHORT")]:
        s = sig[sig["bias"] == b]
        mark = " ★★" if _pf(s) > 2.0 else (" ★" if _pf(s) > 1.4 else "")
        print(f"    {label:5s}: {_fmt(s, span, mark)}")

    print(f"\n  Sweep quality:")
    # Clean single-side sweeps
    s_clean_lo = sig[ sig["sw_lo"] &  ~sig["sw_hi"]]  # Asian LO only → LONG
    s_clean_hi = sig[~sig["sw_lo"] &   sig["sw_hi"]]  # Asian HI only → SHORT
    s_both     = sig[ sig["sw_lo"] &   sig["sw_hi"]]  # Both swept
    for s, label in [(s_clean_lo, "Asian LO swept (LONG bias)"),
                     (s_clean_hi, "Asian HI swept (SHORT bias)"),
                     (s_both,     "Both swept (tiebreak)")]:
        mark = " ★★" if _pf(s) > 2.0 else (" ★" if _pf(s) > 1.4 else "")
        print(f"    {label:30s}: {_fmt(s, span, mark)}")

    print(f"\n  Day-of-week:")
    sig["dow"] = pd.to_datetime(sig["date"]).dt.dayofweek
    DOW = {0:"Mon",1:"Tue",2:"Wed",3:"Thu",4:"Fri"}
    for d in sorted(sig["dow"].unique()):
        s = sig[sig["dow"] == d]
        mark = " ★★★" if _pf(s) > 4 else (" ★★" if _pf(s) > 2 else (" ★" if _pf(s) > 1.4 else ""))
        print(f"    {DOW.get(d,'?'):3s}: {_fmt(s, span, mark)}")

    # ── Section 2: FVG min sweep ─────────────────────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 2 — FVG MIN SIZE SWEEP")
    print(SEP)
    print(f"  {'FVG':>6s}  {'N':>5s}  {'T/yr':>6s}  {'WR%':>6s}  {'PF':>7s}")
    for fv in FVG_SWEEP_BY_TF.get(tf, []):
        s    = extract_signals(df, fv, mode=mode)
        mark = " ←" if fv == fmin else ""
        print(f"  {fv:>5.0f}pt  {len(s):>5d}  {_tpy(s,span):>6.1f}  {_wr(s):>6.1f}%  {_pf(s):>7.3f}{mark}")

    # ── Section 3: TP sweep (MFE-based) ─────────────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 3 — TP MULTIPLIER SWEEP  (MFE-based)")
    print(SEP)
    print(f"  {'TP':>6s}  {'WR%':>6s}  {'PF':>7s}  Wins")
    mfe_a = sig["mfe"].values; sld_a = sig["sl_dist"].values
    for tm in [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0]:
        tp_d = tm*sld_a; wins = mfe_a >= tp_d
        gw = (sld_a[wins]*tm).sum(); gl = sld_a[~wins].sum()
        pf_v = round(gw/gl, 3) if gl > 0 else (float("inf") if gw > 0 else 0.0)
        mark = " ←" if tm == TP_MULT else ""
        print(f"  {tm:>5.2f}×  {wins.sum()/len(sig)*100:>6.1f}%  {pf_v:>7.3f}  {wins.sum()}{mark}")

    # ── Section 4: LONG clean sweep (key metric — should match Pine) ─────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 4 — LONG CLEAN SWEEP ONLY  (Asian LO swept, single side)")
    print(SEP)
    lc = s_clean_lo.copy()
    mark = " ★★" if _pf(lc) > 2.0 else (" ★" if _pf(lc) > 1.4 else "")
    print(f"  All:   {_fmt(lc, span, mark)}")
    if not lc.empty:
        lc["dow"] = pd.to_datetime(lc["date"]).dt.dayofweek
        for d in sorted(lc["dow"].unique()):
            s = lc[lc["dow"] == d]
            mark2 = " ★★★" if _pf(s) > 4 else (" ★★" if _pf(s) > 2 else "")
            print(f"    {DOW.get(d,'?'):3s}: {_fmt(s, span, mark2)}")

    # ── Section 5: SHORT clean sweep ─────────────────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 5 — SHORT CLEAN SWEEP ONLY  (Asian HI swept, single side)")
    print(SEP)
    sc = s_clean_hi.copy()
    print(f"  All:   {_fmt(sc, span)}")
    if not sc.empty:
        sc["dow"] = pd.to_datetime(sc["date"]).dt.dayofweek
        for d in sorted(sc["dow"].unique()):
            s = sc[sc["dow"] == d]
            print(f"    {DOW.get(d,'?'):3s}: {_fmt(s, span)}")

    # ── Section 6: Range filter sweep ────────────────────────────────────────
    rng_pairs = ([(10,120),(15,80),(15,60),(15,50),(20,60),(20,80)]
                 if mode == "full24h" else
                 [(20,200),(30,150),(40,120),(50,100),(60,120),(80,150)])
    default_pair = (15,80) if mode == "full24h" else (40,120)
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 6 — RANGE FILTER SWEEP")
    print(SEP)
    print(f"  {'Rng min':>8s}  {'Rng max':>8s}  {'N':>5s}  {'T/yr':>6s}  {'WR%':>6s}  {'PF':>7s}")
    import sys as _sys
    _mod = _sys.modules[__name__]
    for rmin, rmax in rng_pairs:
        if mode == "full24h":
            _mod.ASIAN_MIN = rmin; _mod.ASIAN_MAX = rmax
        else:
            _mod.ORB_MIN = rmin; _mod.ORB_MAX = rmax
        s = extract_signals(df, fmin, mode=mode)
        mark = " ←" if (rmin, rmax) == default_pair else ""
        print(f"  {rmin:>7.0f}pt  {rmax:>7.0f}pt  {len(s):>5d}  {_tpy(s,span):>6.1f}  {_wr(s):>6.1f}%  {_pf(s):>7.3f}{mark}")
    _mod.ASIAN_MIN = ASIAN_MIN; _mod.ASIAN_MAX = ASIAN_MAX
    _mod.ORB_MIN   = ORB_MIN;   _mod.ORB_MAX   = ORB_MAX

    # ── Section 7: Year-by-year ───────────────────────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 7 — YEAR-BY-YEAR STABILITY")
    print(SEP)
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

    out = Path(f"dax_{tf}_judas_signals.csv")
    sig.to_csv(out, index=False)
    print(f"\n  Saved → {out.name}")
    return sig, span


# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    print("=" * 70)
    print("DAX FRANKFURT JUDAS SWING MINER — Multi-Timeframe")
    print("Strategy: Asian 00:00-07:00 UTC range → Frankfurt sweep 07:00-08:30 UTC")
    print("          → BOS → FVG entry 07:00-10:00 UTC → Hard close 11:00 UTC")
    print("=" * 70)
    print()
    print(f"  Asian range filter: {ASIAN_MIN:.0f}pt ≤ range ≤ {ASIAN_MAX:.0f}pt")
    print(f"  Require close-back: YES  |  Require BOS: YES")
    print()

    results = {}
    found_any = False

    for tf, fname in [("15m", "dax_15m_raw.csv"), ("30m", "dax_30m_raw.csv"), ("1h", "dax_1h_raw.csv")]:
        p = Path(fname)
        if not p.exists():
            print(f"  [{tf}] {fname} not found — skipping")
            continue
        df = add_atr(load_csv(str(p)))
        res = analyze_tf(tf, df)
        if res[0] is not None:
            results[tf] = res
            found_any = True

    if not found_any:
        print("\n  No data files found. Run one of:")
        print("    python download_yf_dax.py          ← Yahoo Finance (easiest, cash session)")
        print("    python download_mt5_ger40.py        ← MT5 (full 24h, if MT5 available)")
        print("    python download_dukascopy_ger40.py  ← Dukascopy public feed (full 24h)")
        return

    # ── Summary ────────────────────────────────────────────────────────────────
    print(f"\n\n{'='*70}")
    print("MULTI-TIMEFRAME SUMMARY  (Judas Swing strategy)")
    print(f"{'='*70}")
    print(f"  {'TF':>4s}  {'N':>5s}  {'T/yr':>6s}  {'WR%':>6s}  {'PF':>7s}"
          f"  {'LONG-clean WR':>14s}  {'LONG-clean PF':>13s}")
    for tf, (sig, span) in results.items():
        lc = sig[sig["sw_lo"] & ~sig["sw_hi"]]
        print(f"  {tf:>4s}  {len(sig):>5d}  {_tpy(sig,span):>6.1f}"
              f"  {_wr(sig):>6.1f}%  {_pf(sig):>7.3f}"
              f"  {_wr(lc):>12.1f}%  {_pf(lc):>11.3f}")

    print(f"\n{'='*70}")
    print("DONE — if LONG clean sweep PF > 1.5 on ≥ 100 signals: build the specialist")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
