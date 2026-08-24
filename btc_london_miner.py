#!/usr/bin/env python3
"""
BTC London Session Breakout Miner — Multi-Timeframe
Strategy: Asian range (00:00-07:00 UTC) → London sweep (07:00-09:00 UTC)
          → BOS above/below Asian range → FVG retest entry (09:00-16:00 UTC)
Data: Binance public API, BTCUSDT (no auth required)
"""

import time
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from pathlib import Path

# ─── CONFIG ──────────────────────────────────────────────────────────────────
SYMBOL      = "BTCUSDT"
TF_LIST     = ["15m", "30m", "1h", "4h"]

START_MS    = int(datetime(2020, 1, 1,  tzinfo=timezone.utc).timestamp() * 1000)
END_MS      = int(datetime(2026, 8, 1,  tzinfo=timezone.utc).timestamp() * 1000)

TP_MULT     = 2.0
SL_BUF      = 0.15       # × ATR below/above FVG edge
ATR_LEN     = 14
FVG_MIN_DEF = 150.0      # default FVG min in $ (≈ NAS100 20pts proportionally on 15m)

# Session hours UTC
ASIAN_S     = 0;    ASIAN_E  = 7     # Asian range
LONDON_S    = 7;    LONDON_E = 9     # London sweep window
ENTRY_S     = 9;    ENTRY_E  = 16    # FVG entry window (extended to NY lunch)
HARD_CLOSE  = 20                     # Force exit UTC hour

DATA_DIR    = Path("btc_miner_data")

# Per-TF defaults (FVG min scales with bar size)
FVG_MIN_BY_TF = {"15m": 150.0, "30m": 200.0, "1h": 300.0, "4h": 600.0}

# FVG sweep sizes per TF (Section 2)
FVG_SWEEP_BY_TF = {
    "15m": [50,  100, 150, 200,  300,  500,  750, 1000],
    "30m": [50,  100, 150, 200,  300,  500,  750, 1000],
    "1h":  [100, 150, 200, 300,  500,  750, 1000, 1500],
    "4h":  [200, 300, 500, 750, 1000, 1500, 2000, 3000],
}

SEP = "═" * 70


# ─── BINANCE FETCH ───────────────────────────────────────────────────────────
def fetch_binance(tf: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    all_rows = []
    cur_ms   = start_ms
    limit    = 1000
    retries  = 5

    print(f"  Fetching {SYMBOL} {tf} from Binance ...", end="", flush=True)
    while cur_ms < end_ms:
        for attempt in range(retries):
            try:
                resp = requests.get(
                    "https://api.binance.com/api/v3/klines",
                    params=dict(symbol=SYMBOL, interval=tf,
                                startTime=cur_ms, endTime=end_ms, limit=limit),
                    timeout=15,
                )
                resp.raise_for_status()
                rows = resp.json()
                break
            except Exception as e:
                if attempt == retries - 1:
                    raise
                time.sleep(2 ** attempt)

        if not rows:
            break
        all_rows.extend(rows)
        last_open = rows[-1][0]
        if last_open >= end_ms or len(rows) < limit:
            break
        cur_ms = last_open + 1
        time.sleep(0.05)   # ~20 req/s — well within 1200 weight/min limit

    print(f" {len(all_rows):,} bars")
    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows, columns=[
        "ts","open","high","low","close","volume",
        "close_time","qav","n_trades","tbbav","tbqav","ignore"
    ])
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    for col in ["open","high","low","close","volume"]:
        df[col] = df[col].astype(float)
    df = df.set_index("ts")[["open","high","low","close","volume"]]
    df = df[~df.index.duplicated(keep="first")].sort_index()
    return df


def load_or_fetch(tf: str) -> pd.DataFrame:
    DATA_DIR.mkdir(exist_ok=True)
    cache = DATA_DIR / f"btcusdt_{tf}.csv"
    if cache.exists():
        print(f"  Loading cached {SYMBOL} {tf} ...", end="", flush=True)
        df = pd.read_csv(cache, index_col=0, parse_dates=True)
        if df.index.tz is None:
            df.index = df.index.tz_localize("UTC")
        print(f" {len(df):,} bars (cached)")
        return df
    df = fetch_binance(tf, START_MS, END_MS)
    df.to_csv(cache)
    return df


# ─── ATR ─────────────────────────────────────────────────────────────────────
def add_atr(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    h, l, c = df["high"], df["low"], df["close"].shift()
    tr = pd.concat([(h-l), (h-c).abs(), (l-c).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1/ATR_LEN, adjust=False).mean()
    return df


# ─── SIGNAL EXTRACTION ───────────────────────────────────────────────────────
def extract_signals(df: pd.DataFrame, fvg_min: float) -> pd.DataFrame:
    """
    Day-by-day:
      1. Asian range 00:00–07:00 UTC
      2. London sweep 07:00–09:00 UTC → sets bias (LONG if Asian LO swept, SHORT if HI swept)
      3. BOS: first bar close beyond Asian range in bias direction after London sweep
      4. FVG detection in entry window 09:00–16:00 UTC
      5. Entry on FVG-detection bar (same bar close, same as Pine process_on_close)
      6. SL = fvg_lo - ATR*0.15 (LONG) / fvg_hi + ATR*0.15 (SHORT)
      7. TP = entry + (entry-SL)*2.0
      8. Resolve vs future bars up to 20:00 UTC
    """
    df = df.copy()
    df["date"] = df.index.normalize()

    records = []
    days = sorted(df["date"].unique())
    day_df_map = {d: grp for d, grp in df.groupby("date")}

    for day in days:
        dd = day_df_map[day]
        h  = dd.index.hour

        # Phase 1: Asian range
        a  = dd[h < ASIAN_E]
        if len(a) < 2:
            continue
        a_hi = a["high"].max()
        a_lo = a["low"].min()
        if (a_hi - a_lo) < 50:       # degenerate / holiday
            continue

        # Phase 2: London sweep
        ld = dd[(h >= LONDON_S) & (h < LONDON_E)]
        if ld.empty:
            continue
        sw_hi = (ld["high"]  > a_hi).any()
        sw_lo = (ld["low"]   < a_lo).any()

        if   sw_lo and not sw_hi:
            bias = 1;  sw_q = "clean_lo"   # Asian LO swept → BULL
        elif sw_hi and not sw_lo:
            bias = -1; sw_q = "clean_hi"   # Asian HI swept → BEAR
        elif sw_lo and sw_hi:
            last = ld.iloc[-1]
            bias = 1 if last["close"] < last["open"] else -1
            sw_q = "both"
        else:
            continue    # no sweep

        # Phase 3: BOS — bar closes beyond Asian range in bias direction
        bos_zone = dd[h >= LONDON_E]
        bos_seen  = False
        for ts, row in bos_zone.iterrows():
            if bias == 1  and row["close"] > a_hi: bos_seen = True; break
            if bias == -1 and row["close"] < a_lo: bos_seen = True; break
        if not bos_seen:
            continue

        # Phase 4: FVG detection in entry window
        ew = dd[(h >= ENTRY_S) & (h < ENTRY_E)].reset_index()
        if len(ew) < 3:
            continue

        sig = None
        for j in range(2, len(ew)):
            bar   = ew.iloc[j]
            prev2 = ew.iloc[j-2]
            atr_v = float(bar["atr"]) if not np.isnan(bar["atr"]) else (a_hi - a_lo)

            if bias == 1:
                gap = float(bar["low"]) - float(prev2["high"])
                if gap < fvg_min:
                    continue
                fvg_lo = float(prev2["high"])
                fvg_hi = float(bar["low"])
                sl     = fvg_lo - atr_v * SL_BUF
                ep     = float(bar["close"])
                dist   = ep - sl
                if dist <= 0:
                    continue
                tp = ep + dist * TP_MULT
            else:
                gap = float(prev2["low"]) - float(bar["high"])
                if gap < fvg_min:
                    continue
                fvg_hi = float(prev2["low"])
                fvg_lo = float(bar["high"])
                sl     = fvg_hi + atr_v * SL_BUF
                ep     = float(bar["close"])
                dist   = sl - ep
                if dist <= 0:
                    continue
                tp = ep - dist * TP_MULT

            sig = dict(
                date=day, ts=bar["ts"], bias=bias, sw_q=sw_q,
                a_hi=a_hi, a_lo=a_lo, a_rng=a_hi-a_lo,
                fvg_lo=fvg_lo, fvg_hi=fvg_hi, fvg_size=gap,
                entry=ep, sl=sl, tp=tp, sl_dist=dist, atr=atr_v,
            )
            break

        if sig is None:
            continue

        # Phase 5: Resolve
        future = dd[dd.index > sig["ts"]]
        win, bars_held, exit_ts, mfe = resolve(future, sig["entry"], sig["sl"], sig["tp"], bias)
        sig.update(win=win, bars_held=bars_held, exit_ts=exit_ts,
                   mfe=mfe, mfe_r=mfe/sig["sl_dist"])
        records.append(sig)

    return pd.DataFrame(records) if records else pd.DataFrame()


def resolve(future, entry, sl, tp, bias):
    mfe = 0.0
    for ts, row in future.iterrows():
        if ts.hour >= HARD_CLOSE:
            fav = row["high"] - entry if bias == 1 else entry - row["low"]
            return False, None, ts, max(mfe, fav)

        sl_hit = (row["low"]  <= sl) if bias == 1 else (row["high"] >= sl)
        tp_hit = (row["high"] >= tp) if bias == 1 else (row["low"]  <= tp)

        if sl_hit and tp_hit:
            return False, None, ts, mfe   # worst-case: SL

        if sl_hit:
            return False, None, ts, mfe

        if tp_hit:
            mfe = max(mfe, (tp - entry) if bias == 1 else (entry - tp))
            return True, None, ts, mfe

        fav = (row["high"] - entry) if bias == 1 else (entry - row["low"])
        mfe = max(mfe, fav)

    return False, None, future.index[-1] if not future.empty else None, mfe


# ─── STATS ───────────────────────────────────────────────────────────────────
def _pf(df):
    if df.empty or "win" not in df:
        return 0.0
    w = df[df["win"] == 1];  l = df[df["win"] == 0]
    g_w = (w["sl_dist"] * TP_MULT).sum()
    g_l = l["sl_dist"].sum()
    return round(g_w / g_l, 3) if g_l > 0 else (float("inf") if g_w > 0 else 0.0)

def _wr(df):
    return round(df["win"].mean() * 100, 1) if not df.empty and "win" in df else 0.0

def _tpy(df, span): return round(len(df) / span, 1) if span > 0 else 0.0

def _fmt(df, span, note=""):
    n = len(df)
    return f"N={n:4d}  {_tpy(df,span):5.1f}/yr  WR={_wr(df):5.1f}%  PF={_pf(df):6.3f}  {note}"


# ─── ANALYZE ONE TIMEFRAME ───────────────────────────────────────────────────
def analyze_tf(tf: str):
    print(f"\n\n{'#'*70}")
    print(f"# TIMEFRAME: {tf.upper()}")
    print(f"{'#'*70}")

    df    = load_or_fetch(tf)
    df    = add_atr(df)
    span  = (df.index[-1] - df.index[0]).days / 365.25
    fmin  = FVG_MIN_BY_TF[tf]

    print(f"\n  {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})  span={span:.2f}yr")
    print(f"  Default FVG min: ${fmin:.0f}")

    # ── Section 1: Baseline ──────────────────────────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 1 — BASELINE  FVG≥${fmin:.0f}  TP={TP_MULT}×  reqSweep=ON  reqBOS=ON")
    print(SEP)

    sig = extract_signals(df, fmin)
    if sig.empty:
        print("  No signals found — FVG min may be too large for this TF.")
        return None, span

    print(f"  Full dataset:    {_fmt(sig, span)}")

    print(f"\n  Direction breakdown:")
    for bias, label in [(1, "LONG"), (-1, "SHORT")]:
        s = sig[sig["bias"] == bias]
        mark = " ★" if _pf(s) > 1.5 else ""
        print(f"    {label:5s}: {_fmt(s, span, mark)}")

    print(f"\n  Sweep quality:")
    qlabels = {
        "clean_lo": "Asian LO swept  (LONG bias)",
        "clean_hi": "Asian HI swept  (SHORT bias)",
        "both":     "Both swept      (tiebreak)",
    }
    for q, qlabel in qlabels.items():
        s = sig[sig["sw_q"] == q]
        mark = " ★★" if _pf(s) > 2.0 else (" ★" if _pf(s) > 1.5 else "")
        print(f"    {qlabel}: {_fmt(s, span, mark)}")

    print(f"\n  Day-of-week:")
    sig["dow"] = pd.to_datetime(sig["date"]).dt.dayofweek
    DOW = {0:"Mon",1:"Tue",2:"Wed",3:"Thu",4:"Fri",5:"Sat",6:"Sun"}
    for d in sorted(sig["dow"].unique()):
        s = sig[sig["dow"] == d]
        mark = " ★★★" if _pf(s) > 4 else (" ★★" if _pf(s) > 2 else (" ★" if _pf(s) > 1.5 else ""))
        print(f"    {DOW[d]:3s}: {_fmt(s, span, mark)}")

    # ── Section 2: FVG min sweep ─────────────────────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 2 — FVG MIN SIZE SWEEP")
    print(SEP)
    print(f"  {'FVG min':>10s}  {'N':>5s}  {'T/yr':>6s}  {'WR%':>6s}  {'PF':>7s}")
    for fv in FVG_SWEEP_BY_TF[tf]:
        s    = extract_signals(df, fv)
        mark = " ← default" if fv == fmin else ""
        print(f"  {fv:>9.0f}$  {len(s):>5d}  {_tpy(s,span):>6.1f}  {_wr(s):>6.1f}%  {_pf(s):>7.3f}{mark}")

    # ── Section 3: TP sweep (MFE-based) ─────────────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 3 — TP MULTIPLIER SWEEP  (MFE-based, baseline signals)")
    print(SEP)
    print(f"  {'TP':>6s}  {'WR%':>6s}  {'PF':>7s}  {'Wins':>5s}")
    mfe_a = sig["mfe"].values
    sld_a = sig["sl_dist"].values
    for tm in [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0]:
        tp_d  = tm * sld_a
        wins  = (mfe_a >= tp_d)
        gw    = (sld_a[wins] * tm).sum()
        gl    = sld_a[~wins].sum()
        pf_v  = round(gw/gl, 3) if gl > 0 else (float("inf") if gw > 0 else 0.0)
        wr_v  = round(wins.sum()/len(sig)*100, 1)
        mark  = " ← default" if tm == TP_MULT else ""
        print(f"  {tm:>5.2f}×  {wr_v:>6.1f}%  {pf_v:>7.3f}  {wins.sum():>5d}{mark}")

    # ── Section 4: LONG clean sweep deep-dive ───────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 4 — LONG ONLY  (clean Asian LO sweep)  ← key metric")
    print(SEP)
    lc = sig[(sig["bias"] == 1) & (sig["sw_q"] == "clean_lo")].copy()
    mark = " ★★" if _pf(lc) > 2.0 else (" ★" if _pf(lc) > 1.5 else "")
    print(f"  All:   {_fmt(lc, span, mark)}")
    if not lc.empty:
        lc["dow"] = pd.to_datetime(lc["date"]).dt.dayofweek
        for d in sorted(lc["dow"].unique()):
            s = lc[lc["dow"] == d]
            mark2 = " ★★★" if _pf(s) > 4 else (" ★★" if _pf(s) > 2 else "")
            print(f"    {DOW[d]:3s}: {_fmt(s, span, mark2)}")

    # ── Section 5: SHORT clean sweep deep-dive ──────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 5 — SHORT ONLY  (clean Asian HI sweep)")
    print(SEP)
    sc = sig[(sig["bias"] == -1) & (sig["sw_q"] == "clean_hi")].copy()
    print(f"  All:   {_fmt(sc, span)}")
    if not sc.empty:
        sc["dow"] = pd.to_datetime(sc["date"]).dt.dayofweek
        for d in sorted(sc["dow"].unique()):
            s = sc[sc["dow"] == d]
            print(f"    {DOW[d]:3s}: {_fmt(s, span)}")

    # ── Section 6: Combined LONG+SHORT clean sweep ───────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 6 — CLEAN SWEEP ONLY  (LONG + SHORT, no both-swept days)")
    print(SEP)
    cs = sig[sig["sw_q"].isin(["clean_lo","clean_hi"])].copy()
    mark = " ★★" if _pf(cs) > 2.0 else (" ★" if _pf(cs) > 1.5 else "")
    print(f"  All clean:  {_fmt(cs, span, mark)}")

    # ── Section 7: Year-by-year stability ───────────────────────────────────
    print(f"\n{SEP}")
    print(f"  [{tf}] SECTION 7 — YEAR-BY-YEAR STABILITY")
    print(SEP)
    sig["year"] = pd.to_datetime(sig["date"]).dt.year
    print(f"  {'Year':>6s}  {'N':>4s}  {'WR%':>6s}  {'PF':>7s}  verdict")
    cumr, peak, mxdd = 0.0, 0.0, 0.0
    for yr in sorted(sig["year"].unique()):
        s = sig[sig["year"] == yr]
        p = _pf(s)
        verdict = "OK" if p >= 1.2 else ("X" if p < 0.7 else "~")
        print(f"  {yr}    {len(s):>4d}  {_wr(s):>6.1f}%  {p:>7.3f}  {verdict}")
        for _, row in s.iterrows():
            cumr += TP_MULT if row["win"] else -1.0
            peak  = max(peak, cumr)
            mxdd  = max(mxdd, peak - cumr)
    print(f"\n  Cumulative R: peak={peak:.1f}R  final={cumr:.1f}R  max-DD={mxdd:.1f}R")

    sig.to_csv(DATA_DIR / f"btc_{tf}_signals.csv", index=False)
    print(f"\n  Saved signals → btc_miner_data/btc_{tf}_signals.csv")

    return sig, span


# ─── MAIN ────────────────────────────────────────────────────────────────────
def main():
    print("=" * 70)
    print("BTC LONDON SESSION BREAKOUT MINER — MULTI-TIMEFRAME")
    print("Signal: Asian range → London sweep → BOS → FVG entry")
    print(f"Data:   Binance BTCUSDT  {datetime(2020,1,1).date()} → {datetime(2026,8,1).date()}")
    print(f"Session windows (UTC): Asian={ASIAN_S}:00-{ASIAN_E}:00"
          f"  London={LONDON_S}:00-{LONDON_E}:00"
          f"  Entry={ENTRY_S}:00-{ENTRY_E}:00"
          f"  Close={HARD_CLOSE}:00")
    print("=" * 70)

    all_results = {}
    for tf in TF_LIST:
        sig, span = analyze_tf(tf)
        all_results[tf] = (sig, span)

    # ── Multi-TF summary ─────────────────────────────────────────────────────
    print(f"\n\n{'='*70}")
    print("MULTI-TIMEFRAME SUMMARY")
    print(f"{'='*70}")
    print(f"  {'TF':>4s}  {'N':>5s}  {'T/yr':>6s}  {'WR%':>6s}  {'PF':>7s}"
          f"  {'LONG-clean WR':>14s}  {'LONG-clean PF':>13s}  {'SHORT-clean PF':>14s}")
    for tf, (sig, span) in all_results.items():
        if sig is None or sig.empty:
            print(f"  {tf:>4s}  — no signals —")
            continue
        lc = sig[(sig["bias"] == 1)  & (sig["sw_q"] == "clean_lo")]
        sc = sig[(sig["bias"] == -1) & (sig["sw_q"] == "clean_hi")]
        print(
            f"  {tf:>4s}  {len(sig):>5d}  {_tpy(sig,span):>6.1f}"
            f"  {_wr(sig):>6.1f}%  {_pf(sig):>7.3f}"
            f"  {_wr(lc):>12.1f}%  {_pf(lc):>11.3f}"
            f"  {_pf(sc):>12.3f}"
        )

    print(f"\n  Best TF picks (LONG-clean PF):")
    ranked = []
    for tf, (sig, span) in all_results.items():
        if sig is None or sig.empty:
            continue
        lc = sig[(sig["bias"] == 1) & (sig["sw_q"] == "clean_lo")]
        if not lc.empty:
            ranked.append((tf, _pf(lc), _wr(lc), _tpy(lc, span)))
    ranked.sort(key=lambda x: x[1], reverse=True)
    for tf, pf_v, wr_v, tpy_v in ranked:
        print(f"    {tf}: PF={pf_v:.3f}  WR={wr_v:.1f}%  {tpy_v:.1f}/yr")

    print(f"\n{'='*70}")
    print("DONE")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
