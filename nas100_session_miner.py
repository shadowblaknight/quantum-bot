#!/usr/bin/env python3
"""
nas100_session_miner.py — NAS100 Session Intel Parameter Sweep
===============================================================
Signal:   TJR narrative — London sweep → ORB BOS → Silver Bullet FVG retest
          Pine confirmed: WR 59.72% | PF 2.507 | 72 trades/yr (20pt FVG, TP 2.0×, extended SB)

3-phase logic (matches qb-nas100-session.pine exactly):
  Phase 1: Asian range  00:00–07:00 UTC  → hi/lo = liquidity targets
  Phase 2: London       07:00–13:30 UTC  → sweep Asian H or L (bear/bull trap) → sets day bias
  Phase 3: NY           13:30–19:30 UTC  → ORB BOS confirms, FVG retraces → entry

Sections:
  1. Baseline confirmation (reproduces Pine confirmed numbers)
  2. FVG min-size sweep (5–60 pts)
  3. TP multiplier sweep (0.5×–4.0×)
  4. Filter ablation: reqSweep / reqBOS / useH4 / PM window
  5. Day-of-week + direction breakdown
  6. Full parameter grid (TP × FVG size × reqBOS)
  7. Multi-TP scaled exit analysis (TP1 + TP2 + runner, BE after TP1)
  8. Year-by-year stability (walk-forward check)
"""

import os, warnings, itertools
import pandas as pd
import numpy as np
warnings.filterwarnings('ignore')

CACHE_FILE = 'nas100_miner_raw.csv'

# ── Broker timezone ────────────────────────────────────────────────────────────
# Data timestamps are in broker time (UTC+3). UTC → broker: add 3h.
TZ = 3

def _bmin(utc_h, utc_m=0):
    return ((utc_h + TZ) % 24) * 60 + utc_m

# Session windows in broker-time minutes-of-day
ASIAN_START  = _bmin( 0,  0)   #  03:00 broker
ASIAN_END    = _bmin( 7,  0)   #  10:00 broker
LONDON_START = _bmin( 7,  0)   #  10:00 broker
LONDON_END   = _bmin(13, 30)   #  16:30 broker
ORB_START    = _bmin(13, 30)   #  16:30 broker — NYSE ORB bar
ORB_END      = _bmin(13, 45)   #  16:45 broker
NY_START     = _bmin(13, 30)   #  16:30 broker — FVG search begins here
SB_START     = _bmin(14,  0)   #  17:00 broker — Silver Bullet opens
SB_EXT_END   = _bmin(16,  0)   #  19:00 broker — extended SB closes
PM_START     = _bmin(18,  0)   #  21:00 broker — optional PM window
PM_END       = _bmin(19,  0)   #  22:00 broker
HARD_CLOSE   = _bmin(19, 30)   #  22:30 broker — session end

# Confirmed baseline params (Pine script tooltips)
BASE_FVG_PTS = 20.0
BASE_TP      = 2.0
BASE_SL_BUF  = 0.15   # × ATR

# ═══════════════════════════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════════════════════════

def compute_atr(df, period=14):
    h, l, c = df['high'], df['low'], df['close']
    tr = pd.concat([h - l, (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()

def htf_bias_col(df15, tf_min, ema_p=200):
    """Resample to tf_min-minute bars, compute EMA bias, forward-fill to 15m index."""
    ohlc = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
    htf  = df15.resample(f'{tf_min}min', closed='right', label='right').agg(ohlc).dropna()
    ema  = htf['close'].ewm(span=ema_p, adjust=False).mean()
    bias = np.where(htf['close'].shift(1) > ema.shift(1),  1,
           np.where(htf['close'].shift(1) < ema.shift(1), -1, 0))
    return pd.Series(bias, index=htf.index).reindex(df15.index, method='ffill').fillna(0).astype(int)

def bmin(idx):
    return idx.hour * 60 + idx.minute

def pf_of(wins_arr, tp_dist_arr, sl_dist_arr):
    gw = np.where(wins_arr,  tp_dist_arr, 0.0).sum()
    gl = np.where(~wins_arr, sl_dist_arr, 0.0).sum()
    return gw / gl if gl > 0 else float('inf')

def fmt_row(n, tyr, wr, pf, star_thresh=(2.0, 2.5), note=''):
    s = ('  ★★★' if pf >= star_thresh[1] and wr >= 58
         else '  ★★' if pf >= star_thresh[0] and wr >= 55
         else '  ★'  if pf >= 1.5
         else '')
    return f"N={n:>4}  {tyr:>5.1f}/yr  WR={wr:>5.1f}%  PF={pf:>6.3f}{s}  {note}"


# ═══════════════════════════════════════════════════════════════════════════════
# SIGNAL ENGINE  (matches Pine logic exactly)
# ═══════════════════════════════════════════════════════════════════════════════

def resolve_trade(day_df, entry_iloc, entry, sl, tp, is_long):
    """Scan forward from entry bar. Returns (win, bars_held, exit_ts, mfe)."""
    mfe = 0.0
    for i in range(entry_iloc + 1, len(day_df)):
        bar  = day_df.iloc[i]
        bm   = bmin(bar.name)
        # Hard close at session end — exit at open of that bar
        if bm >= HARD_CLOSE:
            ep  = bar['open']
            pnl = (ep - entry) if is_long else (entry - ep)
            return pnl > 0, i - entry_iloc, bar.name, mfe
        # SL/TP
        sl_hit = bar['low'] <= sl if is_long else bar['high'] >= sl
        tp_hit = bar['high'] >= tp if is_long else bar['low'] <= tp
        if sl_hit and tp_hit:
            return False, i - entry_iloc, bar.name, mfe   # conservative: SL first
        if sl_hit:
            return False, i - entry_iloc, bar.name, mfe
        if tp_hit:
            return True,  i - entry_iloc, bar.name, mfe
        # Track MFE
        mfe = max(mfe, bar['high'] - entry) if is_long else max(mfe, entry - bar['low'])
    return False, len(day_df) - entry_iloc - 1, day_df.index[-1], mfe


def collect_signals(df,
                    tp_mult     = BASE_TP,
                    fvg_min_pts = BASE_FVG_PTS,
                    sl_buf      = BASE_SL_BUF,
                    req_sweep   = True,
                    req_bos     = True,
                    use_h4      = False,
                    trade_sb    = True,
                    trade_pm    = False,
                    both_dirs   = True,
                    max_per_day = 1):
    """
    Collect Session Intel signals day by day.

    Phase 1: Asian range  (ASIAN_START → ASIAN_END)
    Phase 2: London sweep detection (LONDON_START → LONDON_END)
             sw_lo: any bar where low < asian_lo AND close > asian_lo  → BULL bias
             sw_hi: any bar where high > asian_hi AND close < asian_hi → BEAR bias
    Phase 3: NY — ORB (ORB_START→ORB_END), BOS, FVG, entry
    """
    rows  = []
    dates = sorted(set(df.index.date))

    for date in dates:
        day = df[df.index.date == date].copy()
        if len(day) < 8:
            continue

        day_bmin = day.index.map(bmin)

        # ─── Phase 1: Asian range ──────────────────────────────────────────
        asian_bars = day[day_bmin.isin(range(ASIAN_START, ASIAN_END))]
        if asian_bars.empty:
            continue
        asian_hi = float(asian_bars['high'].max())
        asian_lo = float(asian_bars['low'].min())

        # ─── Phase 2: London sweep detection ──────────────────────────────
        ldn_bars = day[(day_bmin >= LONDON_START) & (day_bmin < LONDON_END)]
        sw_lo = False
        sw_hi = False
        for _, lbar in ldn_bars.iterrows():
            if not sw_lo and lbar['low'] < asian_lo and lbar['close'] > asian_lo:
                sw_lo = True
            if not sw_hi and lbar['high'] > asian_hi and lbar['close'] < asian_hi:
                sw_hi = True

        # ─── Narrative (matches Pine raw/day_bias exactly) ──────────────────
        h4b = int(day[day_bmin >= LONDON_END]['h4_bias'].iloc[0]) if len(day[day_bmin >= LONDON_END]) > 0 else 0
        if sw_lo and not sw_hi:
            raw = 1
        elif sw_hi and not sw_lo:
            raw = -1
        elif sw_lo and sw_hi:
            raw = h4b       # both swept → H4 tiebreak
        else:
            raw = 0 if req_sweep else h4b   # no sweep

        if use_h4:
            day_bias = raw if (raw == 0 or raw == h4b) else 0
        else:
            day_bias = raw

        if day_bias == 0:
            continue   # no trade today

        is_long = (day_bias == 1)

        # ─── ORB range (one 15m bar: 13:30-13:45 UTC) ─────────────────────
        orb_bars = day[(day_bmin >= ORB_START) & (day_bmin < ORB_END)]
        if orb_bars.empty:
            continue
        orb_hi = float(orb_bars['high'].max())
        orb_lo = float(orb_bars['low'].min())

        # ─── NY bars (FVG search + entry) ─────────────────────────────────
        ny_bars = day[day_bmin >= NY_START].copy()
        if len(ny_bars) < 3:
            continue

        # Detect first qualifying FVG in bias direction (from bar index 2 onwards)
        fvg_hi = fvg_lo = None
        ny_list = list(ny_bars.iterrows())

        bos_done = False
        trades_today = 0

        for j, (idx, bar) in enumerate(ny_list):
            bm = bmin(idx)

            if bm >= HARD_CLOSE:
                break

            # ── BOS check: first bar to close beyond ORB in bias direction ─
            if not bos_done:
                if is_long and bar['close'] > orb_hi:
                    bos_done = True
                elif not is_long and bar['close'] < orb_lo:
                    bos_done = True

            # ── FVG detection: need at least 2 prior NY bars ───────────────
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

            # ── PM session: reset FVG for a fresh attempt ─────────────────
            if trade_pm and bm == PM_START and trades_today < max_per_day:
                fvg_hi = fvg_lo = None

            # ── Entry gate ────────────────────────────────────────────────
            in_sb_ext = trade_sb and bm >= SB_START and bm < SB_EXT_END
            in_pm_win = trade_pm and bm >= PM_START and bm < PM_END
            if not (in_sb_ext or in_pm_win):
                continue
            if trades_today >= max_per_day:
                break
            if req_bos and not bos_done:
                continue
            if fvg_hi is None:
                continue

            # ── Check if price retraces into the FVG ──────────────────────
            in_fvg = (bar['low'] <= fvg_hi and bar['high'] >= fvg_lo)
            if not in_fvg:
                continue

            # ── Size the trade ─────────────────────────────────────────────
            entry = float(bar['close'])
            atr   = float(bar['atr'])
            if is_long:
                sl  = fvg_lo - atr * sl_buf
                tp  = entry + (entry - sl) * tp_mult
            else:
                sl  = fvg_hi + atr * sl_buf
                tp  = entry - (sl - entry) * tp_mult

            sl_dist = abs(entry - sl)
            tp_dist = abs(tp - entry)

            if sl_dist <= 0 or tp_dist <= 0:
                continue
            if is_long and (sl >= entry or tp <= entry):
                continue
            if not is_long and (sl <= entry or tp >= entry):
                continue

            # ── Resolve ────────────────────────────────────────────────────
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
            break   # one per session window (reset happens at PM_START above)

    return pd.DataFrame(rows)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — BASELINE CONFIRMATION
# ═══════════════════════════════════════════════════════════════════════════════

def section1_baseline(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 1 — BASELINE CONFIRMATION")
    print("  Config: FVG=20pt | TP=2.0× | reqSweep=ON | reqBOS=ON | useH4=OFF")
    print("  Pine confirmed: WR 59.72% | PF 2.507 | 72 trades/yr")
    print("═" * 70)

    df_sig = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=BASE_FVG_PTS,
                              req_sweep=True, req_bos=True, use_h4=False,
                              trade_sb=True, trade_pm=False)
    if df_sig.empty:
        print("  No signals — check data range and timezone."); return df_sig

    w   = df_sig['win'].values.astype(bool)
    pf  = pf_of(w, df_sig['tp_dist'].values, df_sig['sl_dist'].values)
    tyr = len(df_sig) / years_total
    print(f"\n  Full dataset: {fmt_row(len(df_sig), tyr, w.mean()*100, pf)}")

    # Rolling windows
    df_sig['date_ts'] = pd.to_datetime(df_sig['date'])
    latest = df_sig['date_ts'].max()
    print(f"\n  {'Period':6}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*6}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for yrs, lbl in [(1,'1yr'), (2,'2yr'), (3,'3yr'), (6,'6yr')]:
        sub = df_sig[df_sig['date_ts'] >= latest - pd.DateOffset(years=yrs)]
        if len(sub) < 5: continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        print(f"  {lbl:6}  {len(sub):>4}  {len(sub)/yrs:>9.1f}  {sw.mean()*100:>6.1f}  {sp:>7.3f}")

    # Long vs Short
    print(f"\n  Direction breakdown:")
    for d in ['LONG', 'SHORT']:
        sub = df_sig[df_sig['direction'] == d]
        if len(sub) < 3: continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        print(f"    {d:5}: N={len(sub):3d}  WR={sw.mean()*100:.1f}%  PF={sp:.3f}")

    # Day of week
    print(f"\n  Day-of-week breakdown:")
    for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
        sub = df_sig[df_sig['dow'] == dow]
        if len(sub) < 4: continue
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

    sizes = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60]
    print(f"\n  {'FVG min':>7}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}  notes")
    print(f"  {'─'*7}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")

    for sz in sizes:
        df_s = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=float(sz),
                               req_sweep=True, req_bos=True, use_h4=False)
        if len(df_s) < 5:
            print(f"  {sz:>7}pt  <5 signals"); continue
        w  = df_s['win'].values.astype(bool)
        pf = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        note = '  ← baseline confirmed' if sz == int(BASE_FVG_PTS) else ''
        print(f"  {sz:>7}pt  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}{note}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — TP MULTIPLIER SWEEP
# ═══════════════════════════════════════════════════════════════════════════════

def section3_tp_sweep(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 3 — TP MULTIPLIER SWEEP  (baseline signals, MFE-based)")
    print("═" * 70)

    tp_range = np.round(np.arange(0.25, 4.01, 0.25), 2)
    mfe_arr  = df_sig['mfe'].values
    sl_arr   = df_sig['sl_dist'].values
    n        = len(df_sig)

    print(f"\n  {'TP mult':>8}  {'WR%':>6}  {'PF':>7}  {'Wins':>5}  notes")
    print(f"  {'─'*8}  {'─'*6}  {'─'*7}  {'─'*5}")

    best_pf = 0.0
    for tm in tp_range:
        tp_dists = tm * sl_arr           # TP dist = tm × SL dist
        wins     = mfe_arr >= tp_dists
        wr       = wins.mean() * 100
        gw       = np.where(wins, tp_dists, 0.0).sum()
        gl       = np.where(~wins, sl_arr, 0.0).sum()
        pf_      = gw / gl if gl > 0 else float('inf')
        note = '  ← confirmed' if abs(tm - BASE_TP) < 0.01 else ''
        if pf_ > best_pf:
            best_pf  = pf_
            note    += '  ← best PF'
        print(f"  {tm:>8.2f}  {wr:>6.1f}  {pf_:>7.3f}  {int(wins.sum()):>5}  {note}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — FILTER ABLATION
# ═══════════════════════════════════════════════════════════════════════════════

def section4_filter_ablation(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 4 — FILTER ABLATION  (one filter off at a time vs baseline)")
    print("═" * 70)

    configs = [
        ("Baseline (all ON)",          dict(req_sweep=True,  req_bos=True,  use_h4=False, trade_pm=False)),
        ("reqSweep=OFF",               dict(req_sweep=False, req_bos=True,  use_h4=False, trade_pm=False)),
        ("reqBOS=OFF",                 dict(req_sweep=True,  req_bos=False, use_h4=False, trade_pm=False)),
        ("useH4=ON",                   dict(req_sweep=True,  req_bos=True,  use_h4=True,  trade_pm=False)),
        ("PM window=ON",               dict(req_sweep=True,  req_bos=True,  use_h4=False, trade_pm=True)),
        ("reqSweep=OFF + reqBOS=OFF",  dict(req_sweep=False, req_bos=False, use_h4=False, trade_pm=False)),
        ("reqSweep=OFF + useH4=ON",    dict(req_sweep=False, req_bos=True,  use_h4=True,  trade_pm=False)),
    ]

    print(f"\n  {'Config':<35}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}  verdict")
    print(f"  {'─'*35}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")

    base_pf = None
    for lbl, kw in configs:
        df_s = collect_signals(df, tp_mult=BASE_TP, fvg_min_pts=BASE_FVG_PTS, **kw)
        if len(df_s) < 5:
            print(f"  {lbl:<35}  <5 signals"); continue
        w   = df_s['win'].values.astype(bool)
        pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        if base_pf is None:
            base_pf = pf
            verdict = "← baseline"
        else:
            delta = pf - base_pf
            verdict = f"Δ{delta:+.3f} vs baseline"
        print(f"  {lbl:<35}  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}  {verdict}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — SWEEP QUALITY BREAKDOWN
# (A+ = NAS swept without SP500 matching, tested as metadata — no SMT data in CSV)
# ═══════════════════════════════════════════════════════════════════════════════

def section5_sweep_quality(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 5 — SWEEP QUALITY BREAKDOWN")
    print("═" * 70)

    def show(sub, lbl):
        if len(sub) < 4: return
        w  = sub['win'].values.astype(bool)
        pf = pf_of(w, sub['tp_dist'].values, sub['sl_dist'].values)
        tyr = len(sub) / years_total
        print(f"  {lbl:<35}  {fmt_row(len(sub), tyr, w.mean()*100, pf)}")

    # Clean sweep (one direction only)
    clean_bull = df_sig[(df_sig['sw_lo'] == 1) & (df_sig['sw_hi'] == 0)]
    clean_bear = df_sig[(df_sig['sw_lo'] == 0) & (df_sig['sw_hi'] == 1)]
    both_swept = df_sig[(df_sig['sw_lo'] == 1) & (df_sig['sw_hi'] == 1)]

    show(df_sig,     "All signals (baseline)")
    show(clean_bull, "LONG  — clean Asian LO sweep")
    show(clean_bear, "SHORT — clean Asian HI sweep")
    show(both_swept, "Both swept → H4 tiebreak days")

    # Long vs Short
    print(f"\n  Direction split:")
    for d in ['LONG', 'SHORT']:
        show(df_sig[df_sig['direction'] == d], f"  {d}")

    # Day of week
    print(f"\n  Day-of-week:")
    for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
        show(df_sig[df_sig['dow'] == dow], f"  {dow}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — FULL PARAMETER GRID
# TP × FVG size × reqBOS
# ═══════════════════════════════════════════════════════════════════════════════

def section6_grid(df, years_total):
    print("\n" + "═" * 70)
    print("SECTION 6 — FULL PARAMETER GRID  (TP × FVG size × reqBOS)")
    print("═" * 70)

    tp_vals  = [1.0, 1.5, 2.0, 2.5, 3.0]
    fvg_vals = [10.0, 20.0, 30.0, 40.0]
    bos_vals = [True, False]

    results = []
    combos = list(itertools.product(tp_vals, fvg_vals, bos_vals))
    print(f"\n  Testing {len(combos)} combinations ...")

    for tp, fvg, bos in combos:
        df_s = collect_signals(df, tp_mult=tp, fvg_min_pts=fvg,
                               req_sweep=True, req_bos=bos, use_h4=False)
        if len(df_s) < 8: continue
        w  = df_s['win'].values.astype(bool)
        pf = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        results.append({'tp':tp, 'fvg':fvg, 'bos':bos,
                        'n':len(df_s), 'tyr':len(df_s)/years_total,
                        'wr':w.mean()*100, 'pf':pf})

    if not results: print("  No results."); return

    df_grid = pd.DataFrame(results).sort_values('pf', ascending=False)

    print(f"\n  Top 15 by PF (min 8 signals):")
    print(f"  {'TP':>5}  {'FVG':>5}  {'BOS':>4}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*5}  {'─'*5}  {'─'*4}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")

    for _, r in df_grid.head(15).iterrows():
        bl = '  ← confirmed' if (r['tp']==2.0 and r['fvg']==20.0 and r['bos']) else ''
        print(f"  {r['tp']:>5.1f}  {r['fvg']:>5.0f}  {'ON' if r['bos'] else 'OFF':>4}  "
              f"{r['n']:>4}  {r['tyr']:>9.1f}  {r['wr']:>6.1f}  {r['pf']:>7.3f}{bl}")

    # Best by score (PF × normalized volume)
    df_grid['score'] = df_grid['pf'] * (df_grid['tyr'] / 50.0)
    best = df_grid.sort_values('score', ascending=False).iloc[0]
    print(f"\n  Best by score (PF×vol): TP={best['tp']:.1f}×  FVG={best['fvg']:.0f}pt  "
          f"BOS={'ON' if best['bos'] else 'OFF'}  "
          f"WR={best['wr']:.1f}%  PF={best['pf']:.3f}  ({best['tyr']:.0f}/yr)")

    return df_grid


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — MULTI-TP SCALED EXIT
# ═══════════════════════════════════════════════════════════════════════════════

def section7_multi_tp(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 7 — MULTI-TP SCALED EXIT  (MFE-based, BE after TP1)")
    print("═" * 70)

    mfe_arr = df_sig['mfe'].values
    sl_arr  = df_sig['sl_dist'].values
    n       = len(df_sig)

    configs = [
        ("TP1=1.0×(50%)  runner=2.0×(50%)",      [(1.0, 0.50), (2.0, 0.50)]),
        ("TP1=1.0×(33%)  TP2=2.0×(33%) R=3.0×(34%)", [(1.0,0.33),(2.0,0.33),(3.0,0.34)]),
        ("TP1=1.5×(50%)  runner=3.0×(50%)",      [(1.5, 0.50), (3.0, 0.50)]),
        ("TP1=1.5×(40%)  TP2=2.5×(40%) R=4.0×(20%)", [(1.5,0.40),(2.5,0.40),(4.0,0.20)]),
        ("Full 2.0× (baseline — no scale)",       [(2.0, 1.00)]),
    ]

    for label, levels in configs:
        net_pnls = []
        tp1_mult = levels[0][0]
        for i in range(n):
            mfe    = mfe_arr[i]
            sl_d   = sl_arr[i]
            tp1_hit = mfe >= tp1_mult * sl_d
            pnl    = 0.0
            for tm, wt in levels:
                if mfe >= tm * sl_d:
                    pnl += wt * tm * sl_d
                elif tp1_hit:
                    pnl += 0.0    # BE after TP1
                else:
                    pnl -= wt * sl_d
            net_pnls.append(pnl)

        arr  = np.array(net_pnls)
        wins = arr > 0
        gw   = arr[wins].sum()
        gl   = arr[~wins].abs().sum() if hasattr(arr[~wins], 'abs') else abs(arr[~wins]).sum()
        gl   = np.abs(arr[~wins]).sum()
        pf   = gw / gl if gl > 0 else float('inf')
        tyr  = n / years_total
        print(f"  {label}")
        print(f"    N={n}  WR={wins.mean()*100:.1f}%  PF={pf:.3f}  ~{tyr:.0f}/yr")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — YEAR-BY-YEAR STABILITY
# ═══════════════════════════════════════════════════════════════════════════════

def section8_yearly(df_sig):
    print("\n" + "═" * 70)
    print("SECTION 8 — YEAR-BY-YEAR WALK-FORWARD STABILITY")
    print("═" * 70)

    df_sig = df_sig.copy()
    df_sig['year'] = pd.to_datetime(df_sig['date']).dt.year

    print(f"\n  {'Year':>5}  {'N':>4}  {'WR%':>6}  {'PF':>7}  verdict")
    print(f"  {'─'*5}  {'─'*4}  {'─'*6}  {'─'*7}")

    for yr, sub in df_sig.groupby('year'):
        if len(sub) < 4: continue
        w  = sub['win'].values.astype(bool)
        pf = pf_of(w, sub['tp_dist'].values, sub['sl_dist'].values)
        verdict = ('  ok' if pf >= 1.5 else '  ^' if pf >= 1.0 else '  X')
        print(f"  {yr:>5}  {len(sub):>4}  {w.mean()*100:>6.1f}  {pf:>7.3f}{verdict}")

    # Cumulative R-multiple growth curve (proof of non-random edge)
    df_sig = df_sig.sort_values('signal_ts')
    df_sig['r_result'] = np.where(df_sig['win'].astype(bool),
                                   df_sig['tp_dist'] / df_sig['sl_dist'],
                                   -1.0)
    df_sig['cum_r'] = df_sig['r_result'].cumsum()
    peak   = df_sig['cum_r'].max()
    final  = df_sig['cum_r'].iloc[-1]
    dd     = (df_sig['cum_r'].cummax() - df_sig['cum_r']).max()
    print(f"\n  Cumulative R: peak={peak:.1f}R  final={final:.1f}R  max-DD={dd:.1f}R")


# ═══════════════════════════════════════════════════════════════════════════════
# LOAD + ENRICH
# ═══════════════════════════════════════════════════════════════════════════════

def load_and_enrich():
    if not os.path.exists(CACHE_FILE):
        print(f"ERROR: {CACHE_FILE} not found.")
        print("  Export 15m OHLCV from TradingView (NAS100/US100/NQ1!) as CSV.")
        print("  Required columns: datetime, open, high, low, close, volume")
        return None, 0.0

    print(f"Loading {CACHE_FILE} ...")
    df = pd.read_csv(CACHE_FILE, parse_dates=['datetime'])
    df = df.sort_values('datetime').drop_duplicates('datetime').set_index('datetime')
    df.index = df.index.tz_localize(None)
    for col in ['open','high','low','close']:
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df.dropna(subset=['open','high','low','close'], inplace=True)

    span_days   = (df.index[-1] - df.index[0]).days
    years_total = max(1.0, round(span_days / 365.25, 2))

    print(f"  {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})")
    print(f"  Dataset span: {years_total:.2f} years")

    # Timezone sanity: peak volume hour should be 13-14 UTC (NYSE open).
    # UTC+3 broker → peak at hours 16-17.
    hourly_vol = df.groupby(df.index.hour)['volume'].sum()
    top3       = sorted(hourly_vol.nlargest(3).index.tolist())
    implied    = sorted(top3)[1] - 13
    print(f"  TZ check: peak volume hours {top3} → implied UTC+{implied}  (using TZ={TZ})")
    if abs(implied - TZ) >= 2:
        print(f"  WARNING: implied offset differs from TZ={TZ} — edit TZ at top if wrong.")
    print(f"  Session windows (broker time):")
    print(f"    Asian   {ASIAN_START//60:02d}:{ASIAN_START%60:02d}–{ASIAN_END//60:02d}:{ASIAN_END%60:02d}")
    print(f"    London  {LONDON_START//60:02d}:{LONDON_START%60:02d}–{LONDON_END//60:02d}:{LONDON_END%60:02d}")
    print(f"    ORB     {ORB_START//60:02d}:{ORB_START%60:02d}–{ORB_END//60:02d}:{ORB_END%60:02d}")
    print(f"    SB ext  {SB_START//60:02d}:{SB_START%60:02d}–{SB_EXT_END//60:02d}:{SB_EXT_END%60:02d}")

    print("Computing ATR + H4 EMA200 bias ...")
    df['atr']     = compute_atr(df, 14)
    df['h4_bias'] = htf_bias_col(df, 240, ema_p=200)

    return df, years_total


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("=" * 70)
    print("NAS100 SESSION INTEL MINER")
    print("Signal: London sweep → ORB BOS → Silver Bullet FVG retest")
    print("Pine confirmed: WR 59.72% | PF 2.507 | 72 trades/yr")
    print("=" * 70)

    df, years_total = load_and_enrich()
    if df is None:
        exit(1)

    # 1. Baseline
    print("\n[1/8] Baseline confirmation ...")
    df_base = section1_baseline(df, years_total)

    if df_base.empty:
        print("  No baseline signals — check data range."); exit(1)

    # Save baseline
    df_base.to_csv('nas100_session_signals.csv', index=False)
    print(f"\n  Saved {len(df_base)} baseline signals → nas100_session_signals.csv")

    # 2. FVG size sweep
    print("\n[2/8] FVG min-size sweep ...")
    section2_fvg_sweep(df, years_total)

    # 3. TP sweep
    print("\n[3/8] TP multiplier sweep ...")
    section3_tp_sweep(df_base, years_total)

    # 4. Filter ablation
    print("\n[4/8] Filter ablation ...")
    section4_filter_ablation(df, years_total)

    # 5. Sweep quality breakdown
    print("\n[5/8] Sweep quality breakdown ...")
    section5_sweep_quality(df_base, years_total)

    # 6. Grid search
    print("\n[6/8] Full parameter grid ...")
    section6_grid(df, years_total)

    # 7. Multi-TP
    print("\n[7/8] Multi-TP scaled exit ...")
    section7_multi_tp(df_base, years_total)

    # 8. Year-by-year
    print("\n[8/8] Year-by-year stability ...")
    section8_yearly(df_base)

    # ── Final summary ──────────────────────────────────────────────────────────
    w   = df_base['win'].values.astype(bool)
    pf  = pf_of(w, df_base['tp_dist'].values, df_base['sl_dist'].values)
    tyr = len(df_base) / years_total

    print("\n" + "═" * 70)
    print("DONE")
    print("═" * 70)
    print(f"\n  Extracted: WR={w.mean()*100:.2f}%  PF={pf:.3f}  ~{tyr:.0f} trades/yr")
    print(f"  Pine confirmed: WR=59.72%  PF=2.507  ~72 trades/yr")
    match = abs(w.mean()*100 - 59.72) < 3.0 and abs(pf - 2.507) < 0.3
    print(f"  Match: {'YES ✓' if match else 'CHECK — recheck TZ or FVG detection'}")
    print(f"\n  Output: nas100_session_signals.csv")
