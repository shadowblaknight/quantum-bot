#!/usr/bin/env python3
"""
dax_london_v2_miner.py — GER40 London Open 3-Phase Strategy v2
===============================================================
Applies the proven NAS100 3-phase structure to DAX's London session.

  Phase 1: Overnight range    17:30 – 07:00 UTC  (liquidity hi/lo reference)
  Phase 2: London sweep       07:00 – 09:00 UTC  (sweep overnight H or L → sets bias)
  Phase 3: London entry       09:00 – 13:00 UTC  (ORB BOS → FVG retest)

Why v2 over v1 (London gap distribution):
  v1 ablation found multi-TF FVG gap scoring HURT the edge (PF 1.145 vs 1.540 overnight-only).
  Gap bias was always SHORT because DAX bull trend leaves bullish FVGs below price.
  Fix: drop gap scoring entirely; use overnight session momentum as bias, add NAS100-style entry.

Data: MetaAPI GER40.s  →  dax_5m_raw.csv / dax_15m_raw.csv
"""

import sys, io, warnings, itertools
import pandas as pd
import numpy as np
from pathlib import Path

if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
if hasattr(sys.stderr, 'buffer'):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

warnings.filterwarnings('ignore')

DATA_DIR = Path(r"C:\Users\Omar Nasr\quantum-bot")

BASE_FVG_PTS = 20.0
BASE_TP      = 2.0
BASE_SL_BUF  = 0.5   # fraction of ATR added to overnight H/L for SL

# Session windows — UTC minutes-of-day
SWEEP_START  =  7 * 60        # 07:00 UTC — London open / sweep window
SWEEP_END    =  9 * 60        # 09:00 UTC — sweep window closes
ORB_START    =  9 * 60        # 09:00 UTC — London ORB begins
ORB_END      = 10 * 60        # 10:00 UTC — London ORB ends
ENTRY_START  =  9 * 60        # 09:00 UTC — earliest entry (simultaneous with ORB)
HARD_CLOSE   = 13 * 60        # 13:00 UTC — forced flat


# ─── Utilities ────────────────────────────────────────────────────────────────

def bmin(idx):
    return idx.hour * 60 + idx.minute


def compute_atr(df, period=14):
    h, l, c = df['high'], df['low'], df['close']
    tr = pd.concat([h - l, (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()


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

def resolve_trade(entry_bars, entry_iloc, entry, sl, tp, is_long):
    """Scan forward from entry_iloc to HARD_CLOSE. Returns (win, bars_held, exit_ts, mfe)."""
    mfe = 0.0
    for i in range(entry_iloc + 1, len(entry_bars)):
        bar = entry_bars.iloc[i]
        bm  = bmin(bar.name)
        if bm >= HARD_CLOSE:
            ep  = bar['open']
            pnl = (ep - entry) if is_long else (entry - ep)
            return pnl > 0, i - entry_iloc, bar.name, mfe
        sl_hit = bar['low'] <= sl  if is_long else bar['high'] >= sl
        tp_hit = bar['high'] >= tp if is_long else bar['low']  <= tp
        if sl_hit and tp_hit:
            return False, i - entry_iloc, bar.name, mfe
        if sl_hit:
            return False, i - entry_iloc, bar.name, mfe
        if tp_hit:
            return True,  i - entry_iloc, bar.name, mfe
        mfe = max(mfe, bar['high'] - entry) if is_long else max(mfe, entry - bar['low'])
    return False, len(entry_bars) - entry_iloc - 1, entry_bars.index[-1], mfe


# ─── Signal engine ────────────────────────────────────────────────────────────

def collect_signals(df,
                    tp_mult             = BASE_TP,
                    fvg_min_pts         = BASE_FVG_PTS,
                    sl_buf              = BASE_SL_BUF,
                    req_sweep           = True,
                    req_bos             = True,
                    req_overnight_agree = False,
                    sl_mode             = 'overnight',  # 'overnight' or 'fvg'
                    max_per_day         = 1):
    """
    Phase 1: Overnight range  17:30 UTC prev day → 07:00 UTC today
    Phase 2: London sweep     07:00 → 09:00 UTC
             sw_lo: bar.low < overnight_lo AND close > overnight_lo → BULL bias
             sw_hi: bar.high > overnight_hi AND close < overnight_hi → BEAR bias
    Phase 3: London entry     09:00 → 13:00 UTC
             ORB BOS (09:00-10:00) → FVG retest → entry
    """
    rows  = []
    dates = sorted(set(df.index.date))

    for date in dates:
        today    = pd.Timestamp(date, tz='UTC')
        prev_day = today - pd.Timedelta(days=1)

        # ─── Phase 1: Overnight range ─────────────────────────────────────
        on_start = prev_day + pd.Timedelta(hours=17, minutes=30)
        on_end   = today    + pd.Timedelta(hours=7)
        on_bars  = df[(df.index >= on_start) & (df.index < on_end)]

        if len(on_bars) < 5:
            continue

        overnight_hi    = float(on_bars['high'].max())
        overnight_lo    = float(on_bars['low'].min())
        overnight_open  = float(on_bars.iloc[0]['open'])
        overnight_close = float(on_bars.iloc[-1]['close'])
        overnight_bias  = 1 if overnight_close > overnight_open else -1

        # ─── Phase 2: London sweep (07:00 → 09:00) ────────────────────────
        sw_start = today + pd.Timedelta(hours=7)
        sw_end   = today + pd.Timedelta(hours=9)
        sw_bars  = df[(df.index >= sw_start) & (df.index < sw_end)]

        if sw_bars.empty:
            continue

        sw_lo = False
        sw_hi = False
        for _, lbar in sw_bars.iterrows():
            if not sw_lo and lbar['low'] < overnight_lo and lbar['close'] > overnight_lo:
                sw_lo = True
            if not sw_hi and lbar['high'] > overnight_hi and lbar['close'] < overnight_hi:
                sw_hi = True

        # ─── Day bias ─────────────────────────────────────────────────────
        if sw_lo and not sw_hi:
            raw = 1
        elif sw_hi and not sw_lo:
            raw = -1
        elif sw_lo and sw_hi:
            raw = overnight_bias     # both swept → overnight tie-break
        else:
            raw = 0 if req_sweep else overnight_bias

        if raw == 0:
            continue

        # Overnight agreement filter (from ablation: overnight alone PF=1.540)
        if req_overnight_agree and raw != overnight_bias:
            continue

        is_long = (raw == 1)

        # ─── ORB (09:00 → 10:00) ─────────────────────────────────────────
        orb_start = today + pd.Timedelta(hours=9)
        orb_end   = today + pd.Timedelta(hours=10)
        orb_bars  = df[(df.index >= orb_start) & (df.index < orb_end)]

        orb_hi = float(orb_bars['high'].max()) if not orb_bars.empty else overnight_hi
        orb_lo = float(orb_bars['low'].min())  if not orb_bars.empty else overnight_lo

        # ─── Phase 3: Entry window (09:00 → 13:00) ────────────────────────
        entry_start = today + pd.Timedelta(hours=9)
        entry_end   = today + pd.Timedelta(hours=13)
        entry_bars  = df[(df.index >= entry_start) & (df.index < entry_end)].copy()

        if len(entry_bars) < 3:
            continue

        entry_list   = list(entry_bars.iterrows())
        fvg_hi = fvg_lo = None
        bos_done     = False
        trades_today = 0

        for j, (idx, bar) in enumerate(entry_list):
            bm = bmin(idx)
            if bm >= HARD_CLOSE:
                break

            # BOS: first close beyond ORB range in bias direction
            if not bos_done:
                if is_long and bar['close'] > orb_hi:
                    bos_done = True
                elif not is_long and bar['close'] < orb_lo:
                    bos_done = True

            # FVG detection (3-bar pattern, first qualifying gap)
            if j >= 2 and fvg_hi is None:
                prev2 = entry_list[j - 2][1]
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

            if sl_mode == 'overnight':
                sl = (overnight_lo - atr * sl_buf) if is_long else (overnight_hi + atr * sl_buf)
            else:
                sl = (fvg_lo - atr * sl_buf) if is_long else (fvg_hi + atr * sl_buf)

            tp = (entry + (entry - sl) * tp_mult) if is_long else (entry - (sl - entry) * tp_mult)

            sl_dist = abs(entry - sl)
            tp_dist = abs(tp - entry)

            if sl_dist <= 0 or tp_dist <= 0:
                continue
            if is_long  and (sl >= entry or tp <= entry):
                continue
            if not is_long and (sl <= entry or tp >= entry):
                continue

            win, bars_held, exit_ts, mfe = resolve_trade(entry_bars, j, entry, sl, tp, is_long)

            rows.append({
                'date':       date,
                'signal_ts':  idx,
                'exit_ts':    exit_ts,
                'direction':  'LONG' if is_long else 'SHORT',
                'entry':      entry,
                'sl':         sl,
                'tp':         tp,
                'sl_dist':    sl_dist,
                'tp_dist':    tp_dist,
                'win':        int(win),
                'bars_held':  bars_held,
                'mfe':        mfe,
                'sw_lo':      int(sw_lo),
                'sw_hi':      int(sw_hi),
                'on_bias':    overnight_bias,
                'fvg_size':   (fvg_hi - fvg_lo) if fvg_hi else 0.0,
                'orb_range':  orb_hi - orb_lo,
                'dow':        pd.Timestamp(date).day_name()[:3],
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
    print("  FVG=20pt | TP=2.0× | reqSweep=ON | reqBOS=ON | SL=overnight H/L")
    print("═" * 70)

    df_sig = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=BASE_FVG_PTS,
                              req_sweep=True, req_bos=True,
                              req_overnight_agree=False, sl_mode='overnight')
    if df_sig.empty:
        print("  No signals.")
        return df_sig

    w   = df_sig['win'].values.astype(bool)
    pf  = pf_of(w, df_sig['tp_dist'].values, df_sig['sl_dist'].values)
    tyr = len(df_sig) / years_total
    print(f"\n  Full dataset: {fmt_row(len(df_sig), tyr, w.mean()*100, pf)}")

    df_sig['date_ts'] = pd.to_datetime(df_sig['date'])
    latest = df_sig['date_ts'].max()
    print(f"\n  {'Period':6}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*6}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for yrs, lbl in [(1, '1yr'), (2, '2yr'), (3, '3yr')]:
        sub = df_sig[df_sig['date_ts'] >= latest - pd.DateOffset(years=yrs)]
        if len(sub) < 5:
            continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        print(f"  {lbl:6}  {len(sub):>4}  {len(sub)/yrs:>9.1f}  {sw.mean()*100:>6.1f}  {sp:>7.3f}")

    print(f"\n  Direction breakdown:")
    for d in ['LONG', 'SHORT']:
        sub = df_sig[df_sig['direction'] == d]
        if len(sub) < 3:
            continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        print(f"    {d:5}: N={len(sub):3d}  WR={sw.mean()*100:.1f}%  PF={sp:.3f}")

    # Overnight agreement split
    print(f"\n  Sweep agrees with overnight bias:")
    agree = df_sig[df_sig.apply(
        lambda r: (r['direction'] == 'LONG' and r['on_bias'] == 1) or
                  (r['direction'] == 'SHORT' and r['on_bias'] == -1), axis=1)]
    disagree = df_sig[~df_sig.index.isin(agree.index)]
    for lbl, sub in [("Sweep agrees overnight", agree), ("Sweep vs overnight", disagree)]:
        if len(sub) < 3:
            continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        tyr2 = len(sub) / years_total
        print(f"    {lbl:<30}  {fmt_row(len(sub), tyr2, sw.mean()*100, sp)}")

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
                               req_sweep=True, req_bos=True, sl_mode='overnight')
        if len(df_s) < 5:
            print(f"  {sz:>7}pt  <5 signals")
            continue
        w   = df_s['win'].values.astype(bool)
        pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        note = '  ← baseline' if sz == int(BASE_FVG_PTS) else ''
        print(f"  {sz:>7}pt  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}{note}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — SL MODE COMPARISON  (overnight anchor vs FVG edge)
# ═══════════════════════════════════════════════════════════════════════════════

def section3_sl_mode(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 3 — SL MODE COMPARISON")
    print("  overnight: SL = overnight_lo/hi ± ATR×0.5  (structural)")
    print("  fvg:       SL = fvg edge ± ATR×0.5          (tighter)")
    print("═" * 70)

    print(f"\n  {'Config':<35}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*35}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")

    for mode in ['overnight', 'fvg']:
        for tp in [2.0, 3.0]:
            df_s = collect_signals(df, tp_mult=tp, fvg_min_pts=BASE_FVG_PTS,
                                   req_sweep=True, req_bos=True, sl_mode=mode)
            if len(df_s) < 5:
                continue
            w   = df_s['win'].values.astype(bool)
            pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
            tyr = len(df_s) / years_total
            lbl = f"SL={mode}, TP={tp:.1f}×"
            print(f"  {lbl:<35}  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — FILTER ABLATION
# ═══════════════════════════════════════════════════════════════════════════════

def section4_filter_ablation(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 4 — FILTER ABLATION")
    print("═" * 70)

    configs = [
        ("Baseline (sweep+BOS, no on_agree)",     dict(req_sweep=True,  req_bos=True,  req_overnight_agree=False, sl_mode='overnight')),
        ("+ req_overnight_agree",                  dict(req_sweep=True,  req_bos=True,  req_overnight_agree=True,  sl_mode='overnight')),
        ("reqSweep=OFF (on_bias = direction)",     dict(req_sweep=False, req_bos=True,  req_overnight_agree=False, sl_mode='overnight')),
        ("reqBOS=OFF",                             dict(req_sweep=True,  req_bos=False, req_overnight_agree=False, sl_mode='overnight')),
        ("reqSweep=OFF + reqBOS=OFF",              dict(req_sweep=False, req_bos=False, req_overnight_agree=False, sl_mode='overnight')),
        ("reqBOS=OFF + req_overnight_agree",       dict(req_sweep=True,  req_bos=False, req_overnight_agree=True,  sl_mode='overnight')),
        ("SL=fvg edge",                            dict(req_sweep=True,  req_bos=True,  req_overnight_agree=False, sl_mode='fvg')),
        ("+ on_agree + SL=fvg",                   dict(req_sweep=True,  req_bos=True,  req_overnight_agree=True,  sl_mode='fvg')),
    ]

    print(f"\n  {'Config':<38}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}  verdict")
    print(f"  {'─'*38}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")

    base_pf = None
    for lbl, kw in configs:
        df_s = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=BASE_FVG_PTS, **kw)
        if len(df_s) < 5:
            print(f"  {lbl:<38}  <5 signals")
            continue
        w   = df_s['win'].values.astype(bool)
        pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        if base_pf is None:
            base_pf = pf
            verdict = "← baseline"
        else:
            verdict = f"Δ{pf - base_pf:+.3f}"
        print(f"  {lbl:<38}  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}  {verdict}")


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
        print(f"  {lbl:<42}  {fmt_row(len(sub), tyr, w.mean()*100, pf)}")

    clean_bull = df_sig[(df_sig['sw_lo'] == 1) & (df_sig['sw_hi'] == 0)]
    clean_bear = df_sig[(df_sig['sw_lo'] == 0) & (df_sig['sw_hi'] == 1)]
    both_swept = df_sig[(df_sig['sw_lo'] == 1) & (df_sig['sw_hi'] == 1)]

    show(df_sig,     "All signals (baseline)")
    show(clean_bull, "LONG  — clean overnight LO sweep only")
    show(clean_bear, "SHORT — clean overnight HI sweep only")
    show(both_swept, "Both swept → overnight bias tiebreak")

    print(f"\n  Direction split:")
    for d in ['LONG', 'SHORT']:
        show(df_sig[df_sig['direction'] == d], f"    {d}")

    print(f"\n  Overnight agree vs disagree:")
    agree = df_sig[((df_sig['direction'] == 'LONG') & (df_sig['on_bias'] == 1)) |
                   ((df_sig['direction'] == 'SHORT') & (df_sig['on_bias'] == -1))]
    disagree = df_sig[~df_sig.index.isin(agree.index)]
    show(agree,    "    Sweep agrees overnight")
    show(disagree, "    Sweep vs overnight")

    print(f"\n  Day-of-week:")
    for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
        show(df_sig[df_sig['dow'] == dow], f"    {dow}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — FULL PARAMETER GRID
# ═══════════════════════════════════════════════════════════════════════════════

def section6_grid(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 6 — FULL PARAMETER GRID  (TP × FVG × on_agree × req_bos)")
    print("═" * 70)

    tp_vals   = [1.5, 2.0, 2.5, 3.0]
    fvg_vals  = [10.0, 20.0, 30.0]
    agree_vals = [False, True]
    bos_vals  = [True, False]

    combos = list(itertools.product(tp_vals, fvg_vals, agree_vals, bos_vals))
    print(f"\n  Testing {len(combos)} combinations ...")

    results = []
    for tp, fvg, agree, bos in combos:
        df_s = collect_signals(df, tp_mult=tp, fvg_min_pts=fvg,
                               req_sweep=True, req_bos=bos,
                               req_overnight_agree=agree, sl_mode='overnight')
        if len(df_s) < 8:
            continue
        w  = df_s['win'].values.astype(bool)
        pf = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        results.append({'tp': tp, 'fvg': fvg, 'agree': agree, 'bos': bos,
                        'n': len(df_s), 'tyr': len(df_s) / years_total,
                        'wr': w.mean() * 100, 'pf': pf})

    if not results:
        print("  No combinations with ≥8 signals.")
        return

    df_grid = pd.DataFrame(results).sort_values('pf', ascending=False)
    print(f"\n  Top 15 by PF (min 8 signals):")
    print(f"  {'TP':>4}  {'FVG':>5}  {'on_agree':>8}  {'BOS':>4}  "
          f"{'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*4}  {'─'*5}  {'─'*8}  {'─'*4}  "
          f"{'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for _, r in df_grid.head(15).iterrows():
        bl = '  ← baseline' if (r['tp'] == 2.0 and r['fvg'] == 20.0
                                 and not r['agree'] and r['bos']) else ''
        print(f"  {r['tp']:>4.1f}  {r['fvg']:>5.0f}  {'YES' if r['agree'] else 'NO':>8}  "
              f"{'ON' if r['bos'] else 'OFF':>4}  "
              f"{r['n']:>4}  {r['tyr']:>9.1f}  {r['wr']:>6.1f}  {r['pf']:>7.3f}{bl}")

    df_grid['score'] = df_grid['pf'] * (df_grid['tyr'] / 30.0)
    best = df_grid.sort_values('score', ascending=False).iloc[0]
    print(f"\n  Best by PF×vol: TP={best['tp']:.1f}×  FVG={best['fvg']:.0f}pt  "
          f"on_agree={'YES' if best['agree'] else 'NO'}  "
          f"BOS={'ON' if best['bos'] else 'OFF'}  "
          f"WR={best['wr']:.1f}%  PF={best['pf']:.3f}  ({best['tyr']:.0f}/yr)")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — YEAR-BY-YEAR STABILITY
# ═══════════════════════════════════════════════════════════════════════════════

def section7_year_by_year(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 7 — YEAR-BY-YEAR STABILITY")
    print("═" * 70)

    df_sig = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=BASE_FVG_PTS,
                              req_sweep=True, req_bos=True, sl_mode='overnight')
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
        bar = '█' * min(bar_w, 40) + (f'  PF={pf:.2f}' if bar_w > 40 else '')
        trend = '★' if pf >= 2.0 else ('✓' if pf >= 1.3 else '✗')
        print(f"  {yr:>6}  {len(grp):>4}  {wr:>6.1f}  {pf:>7.3f}  {trend}  {bar}")

    print(f"\n  LONG-only year-by-year:")
    df_long = df_sig[df_sig['direction'] == 'LONG']
    if len(df_long) >= 5:
        for yr, grp in df_long.groupby('year'):
            w  = grp['win'].values.astype(bool)
            pf = pf_of(w, grp['tp_dist'].values, grp['sl_dist'].values)
            print(f"    {yr}  N={len(grp):>3}  WR={w.mean()*100:>5.1f}%  PF={pf:.3f}")

    print(f"\n  SHORT-only year-by-year:")
    df_short = df_sig[df_sig['direction'] == 'SHORT']
    if len(df_short) >= 5:
        for yr, grp in df_short.groupby('year'):
            w  = grp['win'].values.astype(bool)
            pf = pf_of(w, grp['tp_dist'].values, grp['sl_dist'].values)
            print(f"    {yr}  N={len(grp):>3}  WR={w.mean()*100:>5.1f}%  PF={pf:.3f}")


# ═══════════════════════════════════════════════════════════════════════════════
# DATA LOADER
# ═══════════════════════════════════════════════════════════════════════════════

def load_data() -> pd.DataFrame:
    """Load best available TF. Prefer 5m > 15m > 30m."""
    for fname in ['dax_5m_raw.csv', 'dax_15m_raw.csv', 'dax_30m_raw.csv']:
        path = DATA_DIR / fname
        if not path.exists():
            continue
        df = pd.read_csv(path, index_col='ts', parse_dates=True)
        if df.index.tz is None:
            df.index = df.index.tz_localize('UTC')
        else:
            df.index = df.index.tz_convert('UTC')
        df = df[['open', 'high', 'low', 'close']].dropna().sort_index()
        df = df[~df.index.duplicated(keep='first')]
        df['atr'] = compute_atr(df)
        tf = fname.split('_')[1].replace('raw.csv', '')
        print(f"  Loaded {tf}: {len(df):,} bars  {df.index[0].date()} → {df.index[-1].date()}")
        return df, tf
    return pd.DataFrame(), None


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print("DAX London Open 3-Phase Strategy v2")
    print("=" * 70)
    print()
    print("  Strategy (NAS100 structure, DAX London timing):")
    print("  1) Overnight range   17:30-07:00 UTC  (liquidity reference)")
    print("  2) London sweep      07:00-09:00 UTC  (sweeps overnight H or L -> bias)")
    print("  3) London entry      09:00-13:00 UTC  (ORB BOS -> FVG retest)")
    print()
    print("  SL anchored to overnight H/L  |  Hard close 13:00 UTC")
    print()

    result = load_data()
    if isinstance(result, tuple):
        df, tf_used = result
    else:
        df, tf_used = result, None

    if df.empty:
        print("ERROR: No data files found. Run:  python download_metaapi_dax.py")
        return

    years_total = (df.index[-1] - df.index[0]).days / 365.25
    print(f"  Base TF : {tf_used}  |  {years_total:.2f}yr")
    print()

    df_sig = section1_baseline(df, years_total)
    if df_sig.empty:
        print("\nNo signals. Check data.")
        return

    section2_fvg_sweep(df, years_total)
    section3_sl_mode(df, years_total)
    section4_filter_ablation(df, years_total)
    section5_sweep_quality(df_sig, years_total)
    section6_grid(df, years_total)
    section7_year_by_year(df, years_total)

    print("\n" + "═" * 70)
    print("DONE")
    print("  NAS100 benchmark: LONG only, clean sweep → WR 59.72% / PF 2.507 / 72/yr")
    print("  v1 London gap best: overnight-only → PF 1.540 / WR 44.4% / 253/yr")
    print("  v2 target: PF ≥ 2.0 with directional balance")
    print("═" * 70)


if __name__ == '__main__':
    main()
