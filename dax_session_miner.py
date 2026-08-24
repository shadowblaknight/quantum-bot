#!/usr/bin/env python3
"""
dax_session_miner.py — GER40 Session Intel Miner
=================================================
NAS100-style 3-phase strategy applied to GER40/DAX:

  Phase 1: Asian range    00:00 – 07:00 UTC  (liquidity hi/lo)
  Phase 2: London sweep   07:00 – 13:30 UTC  (sweep Asian H or L → sets day bias)
  Phase 3: NY entry       13:00 – 17:30 UTC  (ORB BOS → Silver Bullet FVG retest)

Confirmed edge on NAS100: LONG only, clean Asian LO sweep, WR 59.72% / PF 2.507 / 72/yr
This miner tests whether the same structure has edge on DAX.

Data source: MetaAPI GER40.s  (download_metaapi_dax.py)
Reads:  dax_15m_raw.csv / dax_30m_raw.csv / dax_1h_raw.csv

Sections:
  1. Baseline (FVG=20pt | TP=2.0× | reqSweep=ON | reqBOS=ON)
  2. FVG min-size sweep
  3. TP multiplier sweep
  4. Filter ablation (reqSweep / reqBOS / useH4 / full NY window)
  5. Sweep quality (clean LONG / clean SHORT / both swept)
  6. Full parameter grid (TP × FVG × reqBOS)
  7. Multi-TP scaled exit
  8. Year-by-year stability
"""

import warnings, itertools
import pandas as pd
import numpy as np
from pathlib import Path

warnings.filterwarnings('ignore')

DATA_DIR = Path(r"C:\Users\Omar Nasr\quantum-bot")

# ─── Baseline params ──────────────────────────────────────────────────────────
BASE_FVG_PTS = 20.0    # min FVG gap in DAX points
BASE_TP      = 2.0     # TP = N × risk
BASE_SL_BUF  = 0.15    # SL buffer = fraction of ATR

# ─── Session windows — UTC minutes-of-day ─────────────────────────────────────
# Data from MetaAPI is UTC-stamped; no broker TZ conversion needed.
ASIAN_START  =  0 * 60           #  00:00 UTC  — overnight range begins
ASIAN_END    =  7 * 60           #  07:00 UTC  — Frankfurt open
LONDON_START =  7 * 60           #  07:00 UTC  — Frankfurt / London session
LONDON_END   = 13 * 60 + 30      #  13:30 UTC  — NYSE opens, Frankfurt phase ends
ORB_START    = 13 * 60           #  13:00 UTC  — wide ORB (catches 1h bar at 13:00)
ORB_END      = 14 * 60 + 30      #  14:30 UTC
NY_START     = 13 * 60           #  13:00 UTC  — FVG search begins
SB_START     = 14 * 60           #  14:00 UTC  — Silver Bullet opens
SB_EXT_END   = 16 * 60           #  16:00 UTC  — extended SB window closes
HARD_CLOSE   = 17 * 60 + 30      #  17:30 UTC  — DAX official close


def bmin(idx):
    """UTC minutes-of-day. Data is already UTC so no offset."""
    return idx.hour * 60 + idx.minute


# ─── Utilities ────────────────────────────────────────────────────────────────

def compute_atr(df, period=14):
    h, l, c = df['high'], df['low'], df['close']
    tr = pd.concat([h - l, (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()


def htf_bias_col(df, tf_min=240, ema_p=200):
    """Resample to tf_min-min bars, EMA bias, forward-fill back to base TF index."""
    ohlc = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
    htf  = df.resample(f'{tf_min}min', closed='right', label='right').agg(ohlc).dropna()
    ema  = htf['close'].ewm(span=ema_p, adjust=False).mean()
    bias = np.where(htf['close'].shift(1) > ema.shift(1),  1,
           np.where(htf['close'].shift(1) < ema.shift(1), -1, 0))
    return pd.Series(bias, index=htf.index).reindex(df.index, method='ffill').fillna(0).astype(int)


def pf_of(wins_arr, tp_dist_arr, sl_dist_arr):
    gw = np.where(wins_arr,  tp_dist_arr, 0.0).sum()
    gl = np.where(~wins_arr, sl_dist_arr, 0.0).sum()
    return gw / gl if gl > 0 else float('inf')


def fmt_row(n, tyr, wr, pf, note=''):
    star = ('  ★★★' if pf >= 2.5 and wr >= 58
            else '  ★★' if pf >= 2.0 and wr >= 55
            else '  ★'  if pf >= 1.5
            else '')
    return f"N={n:>4}  {tyr:>5.1f}/yr  WR={wr:>5.1f}%  PF={pf:>6.3f}{star}  {note}"


# ─── Trade resolver ───────────────────────────────────────────────────────────

def resolve_trade(day_df, entry_iloc, entry, sl, tp, is_long):
    """Scan forward from entry bar. Returns (win, bars_held, exit_ts, mfe)."""
    mfe = 0.0
    for i in range(entry_iloc + 1, len(day_df)):
        bar = day_df.iloc[i]
        bm  = bmin(bar.name)
        if bm >= HARD_CLOSE:
            ep  = bar['open']
            pnl = (ep - entry) if is_long else (entry - ep)
            return pnl > 0, i - entry_iloc, bar.name, mfe
        sl_hit = bar['low'] <= sl if is_long else bar['high'] >= sl
        tp_hit = bar['high'] >= tp if is_long else bar['low'] <= tp
        if sl_hit and tp_hit:
            return False, i - entry_iloc, bar.name, mfe
        if sl_hit:
            return False, i - entry_iloc, bar.name, mfe
        if tp_hit:
            return True,  i - entry_iloc, bar.name, mfe
        mfe = max(mfe, bar['high'] - entry) if is_long else max(mfe, entry - bar['low'])
    return False, len(day_df) - entry_iloc - 1, day_df.index[-1], mfe


# ─── Signal engine ────────────────────────────────────────────────────────────

def collect_signals(df,
                    tp_mult      = BASE_TP,
                    fvg_min_pts  = BASE_FVG_PTS,
                    sl_buf       = BASE_SL_BUF,
                    req_sweep    = True,
                    req_bos      = True,
                    use_h4       = False,
                    trade_sb     = False,
                    trade_ny_full = True,
                    max_per_day  = 1):
    """
    3-phase GER40 session signals.

    Phase 1: Asian range   (ASIAN_START → ASIAN_END)
    Phase 2: London sweep  (LONDON_START → LONDON_END)
             sw_lo: bar.low < asian_lo AND close > asian_lo  → BULL bias
             sw_hi: bar.high > asian_hi AND close < asian_hi → BEAR bias
    Phase 3: NY entry      (NY_START → HARD_CLOSE)
             ORB BOS confirms → Silver Bullet FVG retest
    """
    rows  = []
    dates = sorted(set(df.index.date))

    for date in dates:
        day = df[df.index.date == date].copy()
        if len(day) < 8:
            continue

        day_bmin = day.index.map(bmin)

        # ─── Phase 1: Asian range ──────────────────────────────────────────
        asian_bars = day[(day_bmin >= ASIAN_START) & (day_bmin < ASIAN_END)]
        if asian_bars.empty:
            continue
        asian_hi = float(asian_bars['high'].max())
        asian_lo = float(asian_bars['low'].min())

        # ─── Phase 2: London sweep ─────────────────────────────────────────
        ldn_bars = day[(day_bmin >= LONDON_START) & (day_bmin < LONDON_END)]
        sw_lo = False
        sw_hi = False
        for _, lbar in ldn_bars.iterrows():
            if not sw_lo and lbar['low'] < asian_lo and lbar['close'] > asian_lo:
                sw_lo = True
            if not sw_hi and lbar['high'] > asian_hi and lbar['close'] < asian_hi:
                sw_hi = True

        # ─── Day bias ─────────────────────────────────────────────────────
        ny_start_bars = day[day_bmin >= LONDON_END]
        h4b = (int(ny_start_bars['h4_bias'].iloc[0])
               if (use_h4 and len(ny_start_bars) > 0 and 'h4_bias' in day.columns) else 0)

        if sw_lo and not sw_hi:
            raw = 1
        elif sw_hi and not sw_lo:
            raw = -1
        elif sw_lo and sw_hi:
            raw = h4b
        else:
            raw = 0 if req_sweep else h4b

        day_bias = raw if (not use_h4 or raw == 0 or raw == h4b) else 0

        if day_bias == 0:
            continue

        is_long = (day_bias == 1)

        # ─── ORB range ────────────────────────────────────────────────────
        orb_bars = day[(day_bmin >= ORB_START) & (day_bmin < ORB_END)]
        if orb_bars.empty:
            continue
        orb_hi = float(orb_bars['high'].max())
        orb_lo = float(orb_bars['low'].min())

        # ─── Phase 3: NY bars (BOS + FVG + entry) ─────────────────────────
        ny_bars = day[day_bmin >= NY_START].copy()
        if len(ny_bars) < 3:
            continue

        fvg_hi = fvg_lo = None
        ny_list = list(ny_bars.iterrows())
        bos_done = False
        trades_today = 0

        for j, (idx, bar) in enumerate(ny_list):
            bm = bmin(idx)

            if bm >= HARD_CLOSE:
                break

            # BOS: first close beyond ORB in bias direction
            if not bos_done:
                if is_long and bar['close'] > orb_hi:
                    bos_done = True
                elif not is_long and bar['close'] < orb_lo:
                    bos_done = True

            # FVG detection (3-bar pattern, first qualifying gap)
            if j >= 2 and fvg_hi is None:
                prev2 = ny_list[j - 2][1]
                if is_long and bar['low'] > prev2['high']:
                    gap = bar['low'] - prev2['high']
                    if gap >= fvg_min_pts:
                        fvg_lo = float(prev2['high'])
                        fvg_hi = float(bar['low'])
                elif not is_long and prev2['low'] > bar['high']:
                    gap = prev2['low'] - bar['high']
                    if gap >= fvg_min_pts:
                        fvg_lo = float(bar['high'])
                        fvg_hi = float(prev2['low'])

            # Entry gate
            in_sb  = trade_sb      and bm >= SB_START and bm < SB_EXT_END
            in_full = trade_ny_full and bm >= NY_START  and bm < HARD_CLOSE
            if not (in_sb or in_full):
                continue
            if trades_today >= max_per_day:
                break
            if req_bos and not bos_done:
                continue
            if fvg_hi is None:
                continue

            in_fvg = (bar['low'] <= fvg_hi and bar['high'] >= fvg_lo)
            if not in_fvg:
                continue

            entry = float(bar['close'])
            atr   = float(bar['atr'])
            if is_long:
                sl = fvg_lo - atr * sl_buf
                tp = entry + (entry - sl) * tp_mult
            else:
                sl = fvg_hi + atr * sl_buf
                tp = entry - (sl - entry) * tp_mult

            sl_dist = abs(entry - sl)
            tp_dist = abs(tp - entry)

            if sl_dist <= 0 or tp_dist <= 0:
                continue
            if is_long  and (sl >= entry or tp <= entry):
                continue
            if not is_long and (sl <= entry or tp >= entry):
                continue

            win, bars_held, exit_ts, mfe = resolve_trade(ny_bars, j, entry, sl, tp, is_long)

            rows.append({
                'date':      date,
                'signal_ts': idx,
                'exit_ts':   exit_ts,
                'direction': 'LONG' if is_long else 'SHORT',
                'entry':     entry,
                'sl':        sl,
                'tp':        tp,
                'sl_dist':   sl_dist,
                'tp_dist':   tp_dist,
                'win':       int(win),
                'bars_held': bars_held,
                'mfe':       mfe,
                'sw_lo':     int(sw_lo),
                'sw_hi':     int(sw_hi),
                'h4b':       h4b,
                'fvg_size':  (fvg_hi - fvg_lo) if fvg_hi else 0.0,
                'orb_range': orb_hi - orb_lo,
                'dow':       pd.Timestamp(date).day_name()[:3],
            })
            trades_today += 1
            break

    return pd.DataFrame(rows)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — BASELINE
# ═══════════════════════════════════════════════════════════════════════════════

def section1_baseline(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 1 — BASELINE")
    print("  FVG=20pt | TP=2.0× | reqSweep=ON | reqBOS=ON | Full NY window (13:00-17:30)")
    print("═" * 70)

    df_sig = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=BASE_FVG_PTS,
                              req_sweep=True, req_bos=True, use_h4=False,
                              trade_sb=False, trade_ny_full=True)
    if df_sig.empty:
        print("  No signals — check data range and session window alignment.")
        return df_sig

    w   = df_sig['win'].values.astype(bool)
    pf  = pf_of(w, df_sig['tp_dist'].values, df_sig['sl_dist'].values)
    tyr = len(df_sig) / years_total
    print(f"\n  Full dataset: {fmt_row(len(df_sig), tyr, w.mean()*100, pf)}")

    # Rolling windows
    df_sig['date_ts'] = pd.to_datetime(df_sig['date'])
    latest = df_sig['date_ts'].max()
    print(f"\n  {'Period':6}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*6}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for yrs, lbl in [(1,'1yr'), (2,'2yr'), (3,'3yr')]:
        sub = df_sig[df_sig['date_ts'] >= latest - pd.DateOffset(years=yrs)]
        if len(sub) < 5:
            continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        print(f"  {lbl:6}  {len(sub):>4}  {len(sub)/yrs:>9.1f}  {sw.mean()*100:>6.1f}  {sp:>7.3f}")

    # Direction
    print(f"\n  Direction breakdown:")
    for d in ['LONG', 'SHORT']:
        sub = df_sig[df_sig['direction'] == d]
        if len(sub) < 3:
            continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        print(f"    {d:5}: N={len(sub):3d}  WR={sw.mean()*100:.1f}%  PF={sp:.3f}")

    # Day of week
    print(f"\n  Day-of-week:")
    for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
        sub = df_sig[df_sig['dow'] == dow]
        if len(sub) < 4:
            continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        print(f"    {dow}: N={len(sub):3d}  WR={sw.mean()*100:.1f}%  PF={sp:.3f}")

    return df_sig


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — FVG MIN-SIZE SWEEP
# ═══════════════════════════════════════════════════════════════════════════════

def section2_fvg_sweep(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 2 — FVG MIN-SIZE SWEEP")
    print("═" * 70)

    sizes = [3, 5, 8, 10, 15, 20, 25, 30, 35, 40, 50]
    print(f"\n  {'FVG min':>7}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*7}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for sz in sizes:
        df_s = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=float(sz),
                               req_sweep=True, req_bos=True)
        if len(df_s) < 5:
            print(f"  {sz:>7}pt  <5 signals")
            continue
        w   = df_s['win'].values.astype(bool)
        pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        note = '  ← baseline' if sz == int(BASE_FVG_PTS) else ''
        print(f"  {sz:>7}pt  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}{note}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — TP MULTIPLIER SWEEP  (MFE-based)
# ═══════════════════════════════════════════════════════════════════════════════

def section3_tp_sweep(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 3 — TP MULTIPLIER SWEEP  (baseline signals, MFE-based)")
    print("═" * 70)

    tp_range = np.round(np.arange(0.25, 4.01, 0.25), 2)
    mfe_arr  = df_sig['mfe'].values
    sl_arr   = df_sig['sl_dist'].values

    print(f"\n  {'TP mult':>8}  {'WR%':>6}  {'PF':>7}  {'Wins':>5}  notes")
    print(f"  {'─'*8}  {'─'*6}  {'─'*7}  {'─'*5}")
    best_pf = 0.0
    for tm in tp_range:
        tp_dists = tm * sl_arr
        wins     = mfe_arr >= tp_dists
        wr       = wins.mean() * 100
        gw       = np.where(wins, tp_dists, 0.0).sum()
        gl       = np.where(~wins, sl_arr, 0.0).sum()
        pf       = gw / gl if gl > 0 else float('inf')
        note = '  ← confirmed' if abs(tm - BASE_TP) < 0.01 else ''
        if pf > best_pf:
            best_pf = pf
            note   += '  ← best PF'
        print(f"  {tm:>8.2f}  {wr:>6.1f}  {pf:>7.3f}  {int(wins.sum()):>5}{note}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — FILTER ABLATION
# ═══════════════════════════════════════════════════════════════════════════════

def section4_filter_ablation(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 4 — FILTER ABLATION")
    print("═" * 70)

    configs = [
        ("Baseline (full NY, BOS ON)",             dict(req_sweep=True,  req_bos=True,  use_h4=False, trade_ny_full=True,  trade_sb=False)),
        ("SB only (14:00-16:00)",                  dict(req_sweep=True,  req_bos=True,  use_h4=False, trade_ny_full=False, trade_sb=True)),
        ("reqSweep=OFF",                            dict(req_sweep=False, req_bos=True,  use_h4=False, trade_ny_full=True,  trade_sb=False)),
        ("reqBOS=OFF",                              dict(req_sweep=True,  req_bos=False, use_h4=False, trade_ny_full=True,  trade_sb=False)),
        ("useH4=ON",                                dict(req_sweep=True,  req_bos=True,  use_h4=True,  trade_ny_full=True,  trade_sb=False)),
        ("max_per_day=2",                           dict(req_sweep=True,  req_bos=True,  use_h4=False, trade_ny_full=True,  trade_sb=False, max_per_day=2)),
        ("max_per_day=3",                           dict(req_sweep=True,  req_bos=True,  use_h4=False, trade_ny_full=True,  trade_sb=False, max_per_day=3)),
        ("reqSweep=OFF + reqBOS=OFF",               dict(req_sweep=False, req_bos=False, use_h4=False, trade_ny_full=True,  trade_sb=False)),
    ]

    print(f"\n  {'Config':<35}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}  verdict")
    print(f"  {'─'*35}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")

    base_pf = None
    for lbl, kw in configs:
        df_s = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=BASE_FVG_PTS, **kw)
        if len(df_s) < 5:
            print(f"  {lbl:<35}  <5 signals")
            continue
        w   = df_s['win'].values.astype(bool)
        pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        if base_pf is None:
            base_pf = pf
            verdict = "← baseline"
        else:
            delta   = pf - base_pf
            verdict = f"Δ{delta:+.3f}"
        print(f"  {lbl:<35}  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}  {verdict}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — SWEEP QUALITY BREAKDOWN
# ═══════════════════════════════════════════════════════════════════════════════

def section5_sweep_quality(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 5 — SWEEP QUALITY BREAKDOWN")
    print("═" * 70)

    def show(sub, lbl):
        if len(sub) < 4:
            return
        w   = sub['win'].values.astype(bool)
        pf  = pf_of(w, sub['tp_dist'].values, sub['sl_dist'].values)
        tyr = len(sub) / years_total
        print(f"  {lbl:<40}  {fmt_row(len(sub), tyr, w.mean()*100, pf)}")

    clean_bull = df_sig[(df_sig['sw_lo'] == 1) & (df_sig['sw_hi'] == 0)]
    clean_bear = df_sig[(df_sig['sw_lo'] == 0) & (df_sig['sw_hi'] == 1)]
    both_swept = df_sig[(df_sig['sw_lo'] == 1) & (df_sig['sw_hi'] == 1)]

    show(df_sig,     "All signals (baseline)")
    show(clean_bull, "LONG  — clean Asian LO sweep only")
    show(clean_bear, "SHORT — clean Asian HI sweep only")
    show(both_swept, "Both swept → H4 tiebreak days")

    print(f"\n  Direction split:")
    for d in ['LONG', 'SHORT']:
        show(df_sig[df_sig['direction'] == d], f"  {d}")

    print(f"\n  Day-of-week:")
    for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
        show(df_sig[df_sig['dow'] == dow], f"  {dow}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — FULL PARAMETER GRID  (TP × FVG × reqBOS)
# ═══════════════════════════════════════════════════════════════════════════════

def section6_grid(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 6 — FULL PARAMETER GRID  (TP × FVG × reqBOS)")
    print("═" * 70)

    tp_vals  = [1.0, 1.5, 2.0, 2.5, 3.0]
    fvg_vals = [10.0, 20.0, 30.0, 40.0]
    bos_vals = [True, False]

    results = []
    combos  = list(itertools.product(tp_vals, fvg_vals, bos_vals))
    print(f"\n  Testing {len(combos)} combinations ...")

    for tp, fvg, bos in combos:
        df_s = collect_signals(df, tp_mult=tp, fvg_min_pts=fvg,
                               req_sweep=True, req_bos=bos)
        if len(df_s) < 8:
            continue
        w  = df_s['win'].values.astype(bool)
        pf = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        results.append({'tp': tp, 'fvg': fvg, 'bos': bos,
                        'n': len(df_s), 'tyr': len(df_s) / years_total,
                        'wr': w.mean() * 100, 'pf': pf})

    if not results:
        print("  No combinations with ≥8 signals.")
        return None

    df_grid = pd.DataFrame(results).sort_values('pf', ascending=False)

    print(f"\n  Top 15 by PF (min 8 signals):")
    print(f"  {'TP':>5}  {'FVG':>5}  {'BOS':>4}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*5}  {'─'*5}  {'─'*4}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for _, r in df_grid.head(15).iterrows():
        bl = '  ← baseline' if (r['tp'] == 2.0 and r['fvg'] == 20.0 and r['bos']) else ''
        print(f"  {r['tp']:>5.1f}  {r['fvg']:>5.0f}  {'ON' if r['bos'] else 'OFF':>4}  "
              f"{r['n']:>4}  {r['tyr']:>9.1f}  {r['wr']:>6.1f}  {r['pf']:>7.3f}{bl}")

    df_grid['score'] = df_grid['pf'] * (df_grid['tyr'] / 50.0)
    best = df_grid.sort_values('score', ascending=False).iloc[0]
    print(f"\n  Best by score (PF×vol): TP={best['tp']:.1f}×  FVG={best['fvg']:.0f}pt  "
          f"BOS={'ON' if best['bos'] else 'OFF'}  "
          f"WR={best['wr']:.1f}%  PF={best['pf']:.3f}  ({best['tyr']:.0f}/yr)")

    return df_grid


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — MULTI-TP SCALED EXIT  (MFE-based)
# ═══════════════════════════════════════════════════════════════════════════════

def section7_multi_tp(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 7 — MULTI-TP SCALED EXIT  (MFE-based, BE after TP1)")
    print("═" * 70)

    mfe_arr = df_sig['mfe'].values
    sl_arr  = df_sig['sl_dist'].values
    n       = len(df_sig)

    configs = [
        ("TP1=1.0×(50%)  runner=2.0×(50%)",          [(1.0, 0.50), (2.0, 0.50)]),
        ("TP1=1.0×(33%)  TP2=2.0×(33%)  R=3.0×(34%)", [(1.0, 0.33), (2.0, 0.33), (3.0, 0.34)]),
        ("TP1=1.5×(50%)  runner=3.0×(50%)",            [(1.5, 0.50), (3.0, 0.50)]),
        ("TP1=1.5×(40%)  TP2=2.5×(40%)  R=4.0×(20%)", [(1.5, 0.40), (2.5, 0.40), (4.0, 0.20)]),
        ("Full 2.0× (baseline — no scale)",            [(2.0, 1.00)]),
    ]

    print(f"\n  {'Config':<50}  {'WR%':>6}  {'PF':>7}  {'Trades/yr':>9}")
    print(f"  {'─'*50}  {'─'*6}  {'─'*7}  {'─'*9}")

    for label, levels in configs:
        tp1_mult = levels[0][0]
        net_pnls = []
        for i in range(n):
            mfe    = mfe_arr[i]
            sl_d   = sl_arr[i]
            tp1_hit = mfe >= tp1_mult * sl_d
            pnl    = 0.0
            for tm, wt in levels:
                if mfe >= tm * sl_d:
                    pnl += wt * tm * sl_d
                elif tp1_hit:
                    pnl += 0.0
                else:
                    pnl -= wt * sl_d
            net_pnls.append(pnl)

        arr  = np.array(net_pnls)
        wins = arr > 0
        gw   = arr[wins].sum()
        gl   = np.abs(arr[~wins]).sum()
        pf   = gw / gl if gl > 0 else float('inf')
        wr   = wins.mean() * 100
        print(f"  {label:<50}  {wr:>6.1f}  {pf:>7.3f}  {n/years_total:>9.1f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — YEAR-BY-YEAR STABILITY
# ═══════════════════════════════════════════════════════════════════════════════

def section8_year_by_year(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 8 — YEAR-BY-YEAR STABILITY")
    print("═" * 70)

    df_sig = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=BASE_FVG_PTS,
                              req_sweep=True, req_bos=True,
                              trade_sb=False, trade_ny_full=True)
    if df_sig.empty:
        print("  No signals.")
        return

    df_sig['year'] = pd.to_datetime(df_sig['date']).dt.year

    print(f"\n  {'Year':>6}  {'N':>4}  {'WR%':>6}  {'PF':>7}  bar")
    print(f"  {'─'*6}  {'─'*4}  {'─'*6}  {'─'*7}")
    for yr, grp in df_sig.groupby('year'):
        w  = grp['win'].values.astype(bool)
        pf = pf_of(w, grp['tp_dist'].values, grp['sl_dist'].values)
        wr = w.mean() * 100
        bar_w = int(pf * 10)
        bar = '█' * min(bar_w, 40) + ('  PF={:.2f}'.format(pf) if bar_w > 40 else '')
        trend = '★' if pf >= 2.0 else ('✓' if pf >= 1.3 else '✗')
        print(f"  {yr:>6}  {len(grp):>4}  {wr:>6.1f}  {pf:>7.3f}  {trend}  {bar}")

    # LONG-only year-by-year (key finding from NAS100)
    print(f"\n  LONG-only year-by-year:")
    df_long = df_sig[df_sig['direction'] == 'LONG']
    if len(df_long) >= 5:
        for yr, grp in df_long.groupby('year'):
            w  = grp['win'].values.astype(bool)
            pf = pf_of(w, grp['tp_dist'].values, grp['sl_dist'].values)
            wr = w.mean() * 100
            print(f"  {yr:>6}  N={len(grp):>3}  WR={wr:>5.1f}%  PF={pf:.3f}")


# ═══════════════════════════════════════════════════════════════════════════════
# DATA LOADER
# ═══════════════════════════════════════════════════════════════════════════════

def load_data(tf='5m') -> pd.DataFrame:
    fname_map = {'5m': 'dax_5m_raw.csv', '15m': 'dax_15m_raw.csv', '30m': 'dax_30m_raw.csv', '1h': 'dax_1h_raw.csv'}
    path = DATA_DIR / fname_map.get(tf, 'dax_15m_raw.csv')
    if not path.exists():
        return pd.DataFrame()

    df = pd.read_csv(path, index_col='ts', parse_dates=True)
    if df.index.tz is None:
        df.index = df.index.tz_localize('UTC')
    else:
        df.index = df.index.tz_convert('UTC')

    df = df[['open', 'high', 'low', 'close']].dropna().sort_index()
    df = df[~df.index.duplicated(keep='first')]
    df['atr']     = compute_atr(df)
    df['h4_bias'] = htf_bias_col(df, tf_min=240)
    return df


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print("DAX Session Intel Miner — NAS100-style 3-phase strategy")
    print("=" * 70)
    print("  Phase 1: Asian range  00:00–07:00 UTC")
    print("  Phase 2: London sweep 07:00–13:30 UTC  (sets day bias)")
    print("  Phase 3: NY entry     13:00–17:30 UTC  (ORB BOS → SB FVG)")
    print()

    # Load best available timeframe
    df = pd.DataFrame()
    tf_used = None
    for tf in ['5m', '15m', '30m', '1h']:
        candidate = load_data(tf)
        if not candidate.empty:
            # Prefer 15m but check Asian session coverage
            asian_hrs = sorted(candidate.index.hour.unique())
            has_asian = 0 in asian_hrs or 1 in asian_hrs or 2 in asian_hrs
            if has_asian or df.empty:
                df     = candidate
                tf_used = tf
            if has_asian:
                break

    if df.empty:
        print("ERROR: No data files found.")
        print("  Run:  python download_metaapi_dax.py")
        return

    asian_hrs = sorted(df.index.hour.unique())
    has_asian  = any(h < 7 for h in asian_hrs)
    years_total = (df.index[-1] - df.index[0]).days / 365.25

    print(f"  Timeframe : {tf_used}")
    print(f"  Range     : {df.index[0].date()} → {df.index[-1].date()}  ({years_total:.2f}yr)")
    print(f"  Bars      : {len(df):,}")
    print(f"  Hours UTC : {asian_hrs[:6]}..{asian_hrs[-1]}")
    if not has_asian:
        print()
        print("  WARNING: Asian session bars (00:00-07:00 UTC) not found in data.")
        print("  Phase 1 ranges will be incomplete — results may understate performance.")
        print("  Use MetaAPI data (download_metaapi_dax.py) for full 24h coverage.")

    print()

    df_sig = section1_baseline(df, years_total)
    if df_sig.empty:
        print("\nNo signals generated. Check that data has Asian session coverage.")
        return

    section2_fvg_sweep(df, years_total)
    section3_tp_sweep(df_sig, years_total)
    section4_filter_ablation(df, years_total)
    section5_sweep_quality(df_sig, years_total)
    section6_grid(df, years_total)
    section7_multi_tp(df_sig, years_total)
    section8_year_by_year(df, years_total)

    print("\n" + "═" * 70)
    print("DONE  —  compare key metrics:")
    print("  NAS100 baseline: LONG only, clean sweep → WR 59.72% / PF 2.507 / 72/yr")
    print("  DAX above       → see Section 5, LONG clean sweep row")
    print("═" * 70)


if __name__ == '__main__':
    main()
