#!/usr/bin/env python3
"""
nas100_miner.py — NAS100 NYSE ORB Parameter Sweep
===================================================
Signal:   NYSE ORB  (13:30-13:45 UTC, one 15-min bar)
          Long only — shorts catastrophic on NQ (structural bullish bias)
Baseline: H4 EMA200 bias | TP=1.0× | OC=ON | ADR=OFF
          TV confirmed: WR 64.92% | PF 1.202 | 325 trades/6yr (~54/yr)

Input:    nas100_miner_raw.csv  (15m OHLCV from TradingView — NAS100/US100/NQ1!)
          Columns: datetime, open, high, low, close, volume

Sections:
  1. Baseline confirmation (reproduces TradingView numbers)
  2. TP multiplier sweep 0.10×–3.00×  → find PF peak and WR crossovers
  3. Opening candle filter ON vs OFF + day-of-week breakdown
  4. ORB min-range filter sweep (10–80 pts)
  5. Bias filter comparison (H4 EMA50/100/200, H1+H4, None)
  6. ADR gate threshold sweep
  7. Full parameter grid (TP × min_range × EMA_period × OC)
  8. Multi-TP scaled exit analysis (TP1 + TP2 + runner, BE after TP1)
"""

import os, warnings, itertools
import pandas as pd
import numpy as np
warnings.filterwarnings('ignore')

CACHE_FILE    = 'nas100_miner_raw.csv'
ATR_PERIOD    = 14
MAX_BARS_FWD  = 48          # 12 hours max to resolve a trade
TP_MULT_BASE  = 1.00        # confirmed best (TradingView 6yr)
MIN_ORB_PTS   = 20.0        # minimum ORB range in NQ points
BUF_PTS       = 5.0         # fixed SL buffer beyond ORB extreme
H4_EMA_BASE   = 200         # H4 EMA period (confirmed baseline)
YEARS_TOTAL   = 6.0         # auto-set from data span

# ── Broker timezone offset ────────────────────────────────────────────────────
# MetaAPI returns timestamps in broker server time (NOT UTC).
# Most MT4/5 brokers: UTC+3 in summer (EDT), UTC+2 in winter (EST).
# Change this if auto-detect below disagrees with your broker's server time.
TZ_OFFSET_HRS = 3   # ← set to 2 if you see ~1hr miss vs TradingView in winter

def _bmin(utc_h, utc_m):
    """UTC time → broker-time minutes-of-day."""
    return ((utc_h + TZ_OFFSET_HRS) % 24) * 60 + utc_m

# All windows expressed in broker-time minutes-of-day
ORB_WIN_START   = _bmin(13, 30)   # 16:30 broker (UTC+3) — NYSE ORB bar
ORB_WIN_END     = _bmin(13, 45)   # 16:45 broker
ENTRY_WIN_START = _bmin(13, 45)   # 16:45 broker — entry window opens
ENTRY_WIN_END   = _bmin(15, 30)   # 18:30 broker — entry window closes
HARD_CLOSE_MIN  = _bmin(19, 45)   # 22:45 broker — no new entries

# ═══════════════════════════════════════════════════════════════════════════════
# UTILITIES  (identical interface to gold_miner_v4 for familiarity)
# ═══════════════════════════════════════════════════════════════════════════════

def compute_atr(df, period=14):
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift(1)).abs(),
        (df['low']  - df['close'].shift(1)).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()

def htf_bias(m15_df, tf_minutes, ema_p=200):
    """Resample to tf_minutes, compute EMA bias, ffill to M15."""
    ohlc = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
    htf  = m15_df.resample(f'{tf_minutes}min', closed='right', label='right').agg(ohlc).dropna()
    ema  = htf['close'].ewm(span=ema_p, adjust=False).mean()
    bias = np.where(htf['close'].shift(1) > ema.shift(1),  1,
           np.where(htf['close'].shift(1) < ema.shift(1), -1, 0))
    return pd.Series(bias, index=htf.index).reindex(m15_df.index, method='ffill').fillna(0).astype(int)

def min_of_day(idx):
    return idx.hour * 60 + idx.minute

def compute_pf_arrays(wins_bool, tp_dists, sl_dists):
    gw = np.where(wins_bool,  tp_dists, 0.0).sum()
    gl = np.where(~wins_bool, sl_dists, 0.0).sum()
    return gw / gl if gl > 0 else float('inf')

def label_trade_long_with_exit(df_fwd, entry, sl, tp, max_bars=MAX_BARS_FWD):
    for i in range(min(max_bars, len(df_fwd))):
        bar  = df_fwd.iloc[i]
        tidx = df_fwd.index[i]
        if bar['low']  <= sl: return False, i + 1, tidx
        if bar['high'] >= tp: return True,  i + 1, tidx
    last_idx = df_fwd.index[min(max_bars, len(df_fwd)) - 1] if len(df_fwd) > 0 else None
    return False, max_bars, last_idx

def compute_mfe_long(df_fwd, entry, sl, max_bars=MAX_BARS_FWD):
    """Max favorable excursion (pts above entry) before SL is hit."""
    mfe = 0.0
    for i in range(min(max_bars, len(df_fwd))):
        bar = df_fwd.iloc[i]
        if bar['low'] <= sl:
            break
        mfe = max(mfe, bar['high'] - entry)
    return mfe


# ═══════════════════════════════════════════════════════════════════════════════
# SIGNAL COLLECTION
# ═══════════════════════════════════════════════════════════════════════════════

def collect_signals(df,
                    tp_mult      = TP_MULT_BASE,
                    min_orb_pts  = MIN_ORB_PTS,
                    bias_col     = 'h4_bias',
                    require_bias = True,
                    opening_candle = True,
                    adr_max      = None):
    """
    Collect NYSE ORB LONG signals with configurable filters.

    ORB window :  13:30-13:45 UTC (ORB_WIN_START to ORB_WIN_END)
    Entry window: 13:45-15:30 UTC (ENTRY_WIN_START to ENTRY_WIN_END)
    Entry trigger: first bar whose close > orb_hi AND all filters pass.
    SL  = orb_lo - BUF_PTS
    TP1 = orb_hi + tp_mult * orb_range

    opening_candle: if True, skip day if ORB bar (13:30 bar) closed BELOW its open
                    (bearish ORB candle = no long bias today)
    adr_max:        if float, skip bar when adr_consumed[prev bar] > adr_max
    """
    rows  = []
    dates = sorted(set(df.index.date))

    for date in dates:
        day = df[df.index.date == date]
        if len(day) < 4:
            continue

        # ── ORB range (13:30-13:45 UTC) ─────────────────────────────────────
        orb_bars = day[(day.index.map(min_of_day) >= ORB_WIN_START) &
                       (day.index.map(min_of_day) <  ORB_WIN_END)]
        if orb_bars.empty:
            continue

        orb_hi    = orb_bars['high'].max()
        orb_lo    = orb_bars['low'].min()
        orb_range = orb_hi - orb_lo

        if orb_range < min_orb_pts:
            continue

        # ── Opening candle direction filter ─────────────────────────────────
        if opening_candle:
            orb_bar = orb_bars.iloc[0]
            if orb_bar['close'] <= orb_bar['open']:
                continue  # bearish ORB candle → skip long today

        # ── Entry window (13:45-15:30 UTC) ──────────────────────────────────
        entry_bars = day[(day.index.map(min_of_day) >= ENTRY_WIN_START) &
                         (day.index.map(min_of_day) <  ENTRY_WIN_END)]

        for idx, bar in entry_bars.iterrows():
            if bar['close'] <= orb_hi:
                continue

            # Bias filter
            if require_bias and bar[bias_col] != 1:
                continue

            # ADR gate (optional)
            if adr_max is not None and bar['adr_consumed'] > adr_max:
                continue

            entry = bar['close']
            sl    = orb_lo - BUF_PTS
            tp1   = orb_hi + tp_mult * orb_range

            if sl >= entry or tp1 <= entry:
                continue

            df_fwd = df[df.index > idx]
            win, bars_held, exit_ts = label_trade_long_with_exit(df_fwd, entry, sl, tp1)
            mfe = compute_mfe_long(df_fwd, entry, sl)

            rows.append({
                'date':      date,
                'signal_ts': idx,
                'exit_ts':   exit_ts,
                'orb_hi':    orb_hi,
                'orb_lo':    orb_lo,
                'orb_range': orb_range,
                'entry':     entry,
                'sl':        sl,
                'tp1':       tp1,
                'sl_dist':   entry - sl,
                'tp1_dist':  tp1 - entry,
                'win':       int(win),
                'bars_held': bars_held,
                'mfe':       mfe,
                'h4b':       int(bar['h4_bias']),
                'h1b':       int(bar.get('h1_bias', 0)),
                'dow':       pd.Timestamp(date).day_name()[:3],
            })
            break  # one trade per day

    return pd.DataFrame(rows)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — BASELINE CONFIRMATION
# ═══════════════════════════════════════════════════════════════════════════════

def print_baseline_summary(df_sig, label="H4 EMA200 | Long only | TP=1.0× | OC=ON | ADR=OFF"):
    print("\n" + "═" * 70)
    print("SECTION 1 — BASELINE CONFIRMATION")
    print(f"  Config: {label}")
    print("═" * 70)

    if df_sig.empty:
        print("  No signals."); return

    df_sig = df_sig.copy()
    df_sig['date_ts'] = pd.to_datetime(df_sig['date'])
    latest = df_sig['date_ts'].max()
    n_total = len(df_sig)
    wins    = df_sig['win'].values.astype(bool)
    wr_all  = wins.mean()
    pf_all  = compute_pf_arrays(wins, df_sig['tp1_dist'].values, df_sig['sl_dist'].values)

    print(f"\n  Full dataset: N={n_total}  WR={wr_all*100:.1f}%  PF={pf_all:.3f}"
          f"  ~{n_total/YEARS_TOTAL:.0f} trades/yr")

    print(f"\n  {'Period':6}  {'N':>5}  {'Trades/yr':>10}  {'WR%':>6}  {'PF':>6}  notes")
    print(f"  {'─'*6}  {'─'*5}  {'─'*10}  {'─'*6}  {'─'*6}")
    for yrs, lbl in [(1, '1yr'), (2, '2yr'), (4, '4yr'), (6, '6yr')]:
        cutoff = latest - pd.DateOffset(years=yrs)
        sub    = df_sig[df_sig['date_ts'] >= cutoff]
        if len(sub) < 5:
            continue
        w = sub['win'].values.astype(bool)
        sw = w.mean()
        sp = compute_pf_arrays(w, sub['tp1_dist'].values, sub['sl_dist'].values)
        tyr = len(sub) / yrs
        star = ' ***' if sp >= 1.5 else (' **' if sp >= 1.3 else '')
        print(f"  {lbl:6}  {len(sub):>5}  {tyr:>10.0f}  {sw*100:>6.1f}  {sp:>6.3f}{star}")

    # Day-of-week breakdown
    print(f"\n  DOW breakdown:")
    for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
        sub = df_sig[df_sig['dow'] == dow]
        if len(sub) < 5:
            continue
        w = sub['win'].values.astype(bool)
        sw = w.mean()
        sp = compute_pf_arrays(w, sub['tp1_dist'].values, sub['sl_dist'].values)
        print(f"    {dow}: N={len(sub):3d}  WR={sw*100:.1f}%  PF={sp:.3f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — TP MULTIPLIER SWEEP
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_tp_sweep(df_sig, label="Baseline longs"):
    print("\n" + "═" * 70)
    print(f"SECTION 2 — TP SWEEP  [{label}]")
    print("═" * 70)

    n = len(df_sig)
    if n < 20:
        print("  Not enough data."); return None

    tp_mults  = np.round(np.arange(0.10, 3.01, 0.05), 2)
    mfe_arr   = df_sig['mfe'].values
    sl_arr    = df_sig['sl_dist'].values
    orb_arr   = df_sig['orb_range'].values
    results   = []

    for tm in tp_mults:
        tp_dists = tm * orb_arr
        wins     = mfe_arr >= tp_dists
        wr       = wins.mean()
        gw       = np.where(wins, tp_dists, 0.0).sum()
        gl       = np.where(~wins, sl_arr,  0.0).sum()
        pf       = gw / gl if gl > 0 else float('inf')
        results.append({'tp_mult': tm, 'wr': wr * 100, 'pf': pf, 'wins': int(wins.sum())})

    df_sw = pd.DataFrame(results)

    print(f"\n  {'TP mult':>8}  {'WR%':>6}  {'PF':>7}  {'Wins':>5}  notes")
    print(f"  {'─'*8}  {'─'*6}  {'─'*7}  {'─'*5}")

    hit_wr65 = hit_pf13 = hit_pf15 = False
    for _, r in df_sw.iterrows():
        tm   = r['tp_mult']
        wr   = r['wr']
        pf   = r['pf']
        note = ''
        if wr >= 65.0 and not hit_wr65:
            note += ' ← WR 65%'
            hit_wr65 = True
        if pf >= 1.3 and not hit_pf13:
            note += ' ← PF 1.3'
            hit_pf13 = True
        if pf >= 1.5 and not hit_pf15:
            note += ' ← PF 1.5'
            hit_pf15 = True
        if abs(tm - round(tm, 1)) < 0.001 or note:
            star = ' ★★★' if pf >= 1.5 and wr >= 65 else (' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else ''))
            print(f"  {tm:>8.2f}  {wr:>6.1f}  {pf:>7.3f}  {int(r['wins']):>5}  {note}{star}")

    # Highlight baseline TP
    for base_tm in [0.50, 0.75, 1.00]:
        row = df_sw[abs(df_sw['tp_mult'] - base_tm) < 0.001]
        if not row.empty:
            b = row.iloc[0]
            print(f"\n  TP={base_tm:.2f}×: WR={b['wr']:.1f}%  PF={b['pf']:.3f}  wins={int(b['wins'])}/{n}")

    # Best PF among all multiples
    best_pf = df_sw.loc[df_sw['pf'].idxmax()]
    print(f"\n  Best PF overall: TP={best_pf['tp_mult']:.2f}×  WR={best_pf['wr']:.1f}%  PF={best_pf['pf']:.3f}")

    # Best PF where WR >= 60%
    valid = df_sw[df_sw['wr'] >= 60.0]
    if not valid.empty:
        best = valid.loc[valid['pf'].idxmax()]
        print(f"  Best PF (WR≥60%): TP={best['tp_mult']:.2f}×  WR={best['wr']:.1f}%  PF={best['pf']:.3f}")

    return df_sw


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — OPENING CANDLE FILTER ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_opening_candle(df, tp_mult=TP_MULT_BASE, min_orb_pts=MIN_ORB_PTS,
                            bias_col='h4_bias'):
    print("\n" + "═" * 70)
    print("SECTION 3 — OPENING CANDLE FILTER (ORB bar bull/bear)")
    print("═" * 70)

    # All days (no OC filter)
    df_all = collect_signals(df, tp_mult=tp_mult, min_orb_pts=min_orb_pts,
                             bias_col=bias_col, require_bias=True, opening_candle=False)
    # OC=ON days only
    df_oc  = collect_signals(df, tp_mult=tp_mult, min_orb_pts=min_orb_pts,
                             bias_col=bias_col, require_bias=True, opening_candle=True)

    def summary(df_s, lbl):
        if df_s.empty:
            print(f"  {lbl}: no signals")
            return
        w  = df_s['win'].values.astype(bool)
        pf = compute_pf_arrays(w, df_s['tp1_dist'].values, df_s['sl_dist'].values)
        print(f"  {lbl:<35} N={len(df_s):4d} (~{len(df_s)/YEARS_TOTAL:5.1f}/yr)  "
              f"WR={w.mean()*100:5.1f}%  PF={pf:.3f}")

    summary(df_all, "OC=OFF (all H4-bullish days)")
    summary(df_oc,  "OC=ON  (ORB bar closes bullish)")

    if df_all.empty or len(df_all) < 10:
        return

    # Days where OC was filtered out (bearish ORB bar)
    df_oc_filtered = df_all[~df_all['date'].isin(df_oc['date'])] if not df_oc.empty else df_all
    summary(df_oc_filtered, "OC=ON  (filtered-out days only)")

    # Day-of-week breakdown with OC=ON
    print(f"\n  OC=ON day-of-week breakdown:")
    if not df_oc.empty:
        for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
            sub = df_oc[df_oc['dow'] == dow]
            if len(sub) < 3:
                continue
            w = sub['win'].values.astype(bool)
            pf = compute_pf_arrays(w, sub['tp1_dist'].values, sub['sl_dist'].values)
            print(f"    {dow}: N={len(sub):3d}  WR={w.mean()*100:.1f}%  PF={pf:.3f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — ORB MIN-RANGE FILTER SWEEP
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_min_range(df, tp_mult=TP_MULT_BASE, bias_col='h4_bias',
                      opening_candle=True):
    print("\n" + "═" * 70)
    print("SECTION 4 — ORB MIN-RANGE FILTER SWEEP")
    print("═" * 70)

    thresholds = [0, 10, 15, 20, 25, 30, 35, 40, 50, 60, 80]
    print(f"\n  {'Min pts':>8}  {'N':>5}  {'Trades/yr':>10}  {'WR%':>6}  {'PF':>7}  notes")
    print(f"  {'─'*8}  {'─'*5}  {'─'*10}  {'─'*6}  {'─'*7}")

    for mn in thresholds:
        df_s = collect_signals(df, tp_mult=tp_mult, min_orb_pts=float(mn),
                               bias_col=bias_col, require_bias=True,
                               opening_candle=opening_candle)
        if len(df_s) < 5:
            print(f"  {mn:>8}  {'<5':>5}")
            continue
        w  = df_s['win'].values.astype(bool)
        pf = compute_pf_arrays(w, df_s['tp1_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / YEARS_TOTAL
        star = ' ★★' if pf >= 1.4 and w.mean() >= 0.62 else (' ★' if pf >= 1.3 else '')
        note = f"  confirmed baseline" if mn == int(MIN_ORB_PTS) else ''
        print(f"  {mn:>8}  {len(df_s):>5}  {tyr:>10.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}{star}{note}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — BIAS FILTER COMPARISON
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_bias_filters(df, tp_mult=TP_MULT_BASE, min_orb_pts=MIN_ORB_PTS,
                          opening_candle=True):
    print("\n" + "═" * 70)
    print("SECTION 5 — BIAS FILTER COMPARISON")
    print("═" * 70)

    configs = [
        ("No bias filter",         None,       False, None),
        ("H4 EMA50",               'h4b_e50',  True,  None),
        ("H4 EMA100",              'h4b_e100', True,  None),
        ("H4 EMA200 (baseline)",   'h4_bias',  True,  None),
        ("H1 EMA50",               'h1b_e50',  True,  None),
        ("H1 EMA200",              'h1_bias',  True,  None),
        ("H1+H4 EMA200 both bull", 'h1h4_200', True,  None),
    ]

    # Pre-compute extra bias columns if not already there
    if 'h4b_e50' not in df.columns:
        print("  Computing additional bias columns ...")
        df['h4b_e50']  = htf_bias(df, 240, ema_p=50)
        df['h4b_e100'] = htf_bias(df, 240, ema_p=100)
        df['h1b_e50']  = htf_bias(df, 60,  ema_p=50)

    # Synthetic H1+H4 column (both must be 1)
    df['h1h4_200'] = np.where((df['h1_bias'] == 1) & (df['h4_bias'] == 1), 1,
                    np.where((df['h1_bias'] ==-1) & (df['h4_bias'] ==-1), -1, 0))

    print(f"\n  {'Config':<30}  {'N':>5}  {'Trades/yr':>10}  {'WR%':>6}  {'PF':>7}  notes")
    print(f"  {'─'*30}  {'─'*5}  {'─'*10}  {'─'*6}  {'─'*7}")

    for lbl, col, req, _ in configs:
        df_s = collect_signals(df, tp_mult=tp_mult, min_orb_pts=min_orb_pts,
                               bias_col=col if col else 'h4_bias',
                               require_bias=req,
                               opening_candle=opening_candle)
        if len(df_s) < 5:
            print(f"  {lbl:<30}  <5 signals")
            continue
        w  = df_s['win'].values.astype(bool)
        pf = compute_pf_arrays(w, df_s['tp1_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / YEARS_TOTAL
        star = ' ★★' if pf >= 1.4 and w.mean() >= 0.62 else (' ★' if pf >= 1.3 else '')
        print(f"  {lbl:<30}  {len(df_s):>5}  {tyr:>10.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}{star}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — ADR GATE THRESHOLD SWEEP
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_adr_gate(df, tp_mult=TP_MULT_BASE, min_orb_pts=MIN_ORB_PTS,
                     opening_candle=True, bias_col='h4_bias'):
    print("\n" + "═" * 70)
    print("SECTION 6 — ADR GATE THRESHOLD SWEEP")
    print("═" * 70)

    thresholds = [None, 0.5, 0.6, 0.7, 0.75, 0.80, 0.85, 0.90, 1.00, 1.20]
    print(f"\n  {'ADR max':>8}  {'N':>5}  {'Trades/yr':>10}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*8}  {'─'*5}  {'─'*10}  {'─'*6}  {'─'*7}")

    for adr in thresholds:
        df_s = collect_signals(df, tp_mult=tp_mult, min_orb_pts=min_orb_pts,
                               bias_col=bias_col, require_bias=True,
                               opening_candle=opening_candle, adr_max=adr)
        lbl = "OFF" if adr is None else f"{adr:.2f}"
        if len(df_s) < 5:
            print(f"  {lbl:>8}  <5")
            continue
        w  = df_s['win'].values.astype(bool)
        pf = compute_pf_arrays(w, df_s['tp1_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / YEARS_TOTAL
        note = "  ← baseline" if adr is None else ""
        print(f"  {lbl:>8}  {len(df_s):>5}  {tyr:>10.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}{note}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — FULL PARAMETER GRID SEARCH
# TP × min_range × H4_EMA_period × opening_candle
# ═══════════════════════════════════════════════════════════════════════════════

def run_grid_search(df):
    print("\n" + "═" * 70)
    print("SECTION 7 — FULL PARAMETER GRID SEARCH")
    print("═" * 70)

    tp_vals      = [0.50, 0.75, 1.00, 1.25, 1.50]
    range_vals   = [20.0, 30.0, 40.0]
    ema_map      = {50: 'h4b_e50', 100: 'h4b_e100', 200: 'h4_bias'}
    oc_vals      = [True, False]

    # Ensure extra columns exist
    if 'h4b_e50' not in df.columns:
        df['h4b_e50']  = htf_bias(df, 240, ema_p=50)
        df['h4b_e100'] = htf_bias(df, 240, ema_p=100)

    results = []
    combos = list(itertools.product(tp_vals, range_vals, ema_map.items(), oc_vals))
    print(f"\n  Testing {len(combos)} combinations ...")

    for tp, mn, (ema_p, bias_col), oc in combos:
        df_s = collect_signals(df, tp_mult=tp, min_orb_pts=mn,
                               bias_col=bias_col, require_bias=True,
                               opening_candle=oc)
        if len(df_s) < 10:
            continue
        w  = df_s['win'].values.astype(bool)
        pf = compute_pf_arrays(w, df_s['tp1_dist'].values, df_s['sl_dist'].values)
        results.append({
            'tp_mult':  tp,
            'min_range': mn,
            'h4_ema':   ema_p,
            'oc':       oc,
            'n':        len(df_s),
            'tyr':      len(df_s) / YEARS_TOTAL,
            'wr':       w.mean() * 100,
            'pf':       pf,
        })

    if not results:
        print("  No results."); return

    df_grid = pd.DataFrame(results).sort_values('pf', ascending=False)

    print(f"\n  Top 20 combinations by PF:")
    print(f"  {'TP':>6}  {'MinRng':>7}  {'H4EMA':>6}  {'OC':>4}  {'N':>5}  "
          f"{'Trades/yr':>10}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*6}  {'─'*7}  {'─'*6}  {'─'*4}  {'─'*5}  {'─'*10}  {'─'*6}  {'─'*7}")

    for _, r in df_grid.head(20).iterrows():
        star = ' ★★★' if r['pf'] >= 1.5 and r['wr'] >= 62 else (' ★★' if r['pf'] >= 1.4 else (' ★' if r['pf'] >= 1.3 else ''))
        bl = ' ← TV baseline' if (r['tp_mult'] == 1.0 and r['min_range'] == 20.0 and r['h4_ema'] == 200 and r['oc']) else ''
        print(f"  {r['tp_mult']:>6.2f}  {r['min_range']:>7.0f}  {r['h4_ema']:>6.0f}  "
              f"{'ON' if r['oc'] else 'OFF':>4}  {r['n']:>5}  {r['tyr']:>10.1f}  "
              f"{r['wr']:>6.1f}  {r['pf']:>7.3f}{star}{bl}")

    # Best by combined score: PF * (trades/yr / 50) — reward both edge and volume
    df_grid['score'] = df_grid['pf'] * (df_grid['tyr'] / 50.0)
    best = df_grid.sort_values('score', ascending=False).iloc[0]
    print(f"\n  Best by score (PF × vol): TP={best['tp_mult']:.2f}×  MinRng={best['min_range']:.0f}pt  "
          f"H4EMA={best['h4_ema']:.0f}  OC={'ON' if best['oc'] else 'OFF'}  "
          f"N={best['n']:.0f}  WR={best['wr']:.1f}%  PF={best['pf']:.3f}")

    return df_grid


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — MULTI-TP SCALED EXIT ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_multi_tp(df_sig, tp_levels, weights, label=""):
    """BE stop after tp_levels[0] is hit (same model as gold_miner_v4 Section 4)."""
    assert len(tp_levels) == len(weights)
    assert abs(sum(weights) - 1.0) < 0.001

    results = []
    for _, r in df_sig.iterrows():
        mfe     = r['mfe']
        orb     = r['orb_range']
        sl_d    = r['sl_dist']
        net_pnl = 0.0
        tp1_hit = mfe >= tp_levels[0] * orb

        for tp_m, w in zip(tp_levels, weights):
            tp_dist = tp_m * orb
            hit     = mfe >= tp_dist
            if hit:
                net_pnl += w * tp_dist
            else:
                net_pnl += 0.0 if tp1_hit else (-w * sl_d)

        results.append({'net_pnl': net_pnl, 'win': int(net_pnl > 0)})

    df_res = pd.DataFrame(results)
    n      = len(df_res)
    wr     = df_res['win'].mean()
    gw     = df_res[df_res['net_pnl'] > 0]['net_pnl'].sum()
    gl     = df_res[df_res['net_pnl'] < 0]['net_pnl'].abs().sum()
    pf     = gw / gl if gl > 0 else float('inf')
    tyr    = n / YEARS_TOTAL

    lvl_str = [f"{t:.2f}×({int(w*100)}%)" for t, w in zip(tp_levels, weights)]
    star = ' ★★' if pf >= 1.4 and wr >= 0.62 else (' ★' if pf >= 1.3 else '')
    print(f"  Multi-TP {lvl_str}  {label}")
    print(f"  N={n}  WR={wr*100:.1f}%  PF={pf:.3f}  ~{tyr:.0f} trades/yr{star}")
    return df_res


# ═══════════════════════════════════════════════════════════════════════════════
# LOAD + ENRICH DATA
# ═══════════════════════════════════════════════════════════════════════════════

def load_and_enrich():
    if not os.path.exists(CACHE_FILE):
        print(f"ERROR: {CACHE_FILE} not found.")
        print(f"  Export 15m OHLCV from TradingView (NAS100/US100/NQ1!) as CSV.")
        print(f"  Required columns: datetime, open, high, low, close, volume")
        return None

    print(f"Loading {CACHE_FILE} ...")
    df = pd.read_csv(CACHE_FILE, parse_dates=['datetime'])
    df = df.sort_values('datetime').drop_duplicates('datetime').set_index('datetime')
    df.index = df.index.tz_localize(None)
    print(f"  {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})")

    # Auto-set YEARS_TOTAL from data span
    global YEARS_TOTAL
    span_days  = (df.index[-1] - df.index[0]).days
    YEARS_TOTAL = max(1.0, round(span_days / 365.25, 2))
    print(f"  Dataset span: {YEARS_TOTAL:.2f} years")

    # ── Timezone diagnostic ───────────────────────────────────────────────────
    # Peak volume hour in the data should map to ~13-14 UTC (NYSE open).
    # If peak is at hour 16-17, data is broker time UTC+3.  If 15-16, UTC+2.
    hourly_vol  = df.groupby(df.index.hour)['volume'].sum()
    top3_hours  = sorted(hourly_vol.nlargest(3).index.tolist())
    median_peak = sorted(top3_hours)[1]
    implied_tz  = median_peak - 13          # NYSE opens 13:30 UTC
    print(f"  Timezone check: peak volume hours {top3_hours}  "
          f"→ implied broker offset UTC+{implied_tz}  "
          f"(using TZ_OFFSET_HRS={TZ_OFFSET_HRS})")
    if abs(implied_tz - TZ_OFFSET_HRS) >= 2:
        print(f"  WARNING: detected offset ({implied_tz}) differs from TZ_OFFSET_HRS "
              f"({TZ_OFFSET_HRS}) by ≥2h — edit TZ_OFFSET_HRS at top of script.")
    print(f"  ORB window in broker time: "
          f"{ORB_WIN_START//60:02d}:{ORB_WIN_START%60:02d}–"
          f"{ORB_WIN_END//60:02d}:{ORB_WIN_END%60:02d}")

    print("Computing ATR, H4 bias, H1 bias ...")
    df['atr']     = compute_atr(df, ATR_PERIOD)
    df['h4_bias'] = htf_bias(df, 240, ema_p=H4_EMA_BASE)   # H4 EMA200 (baseline)
    df['h1_bias'] = htf_bias(df, 60,  ema_p=50)             # H1 EMA50

    # Daily stats for ADR gate — use proper 14-day DAILY ATR, not 15m ATR
    df['_date']   = df.index.date
    df['_day_hi'] = df.groupby('_date')['high'].transform('cummax')
    df['_day_lo'] = df.groupby('_date')['low'].transform('cummin')
    daily = (df.resample('D')
               .agg({'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'})
               .dropna(subset=['close']))
    daily_atr = compute_atr(daily, ATR_PERIOD)
    df['daily_atr'] = daily_atr.reindex(df.index, method='ffill').ffill().bfill()
    df['adr_consumed'] = np.where(
        df['daily_atr'] > 0,
        (df['_day_hi'] - df['_day_lo']) / df['daily_atr'],
        0.0
    )
    df.drop(columns=['_date', '_day_hi', '_day_lo'], inplace=True)

    return df


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("=" * 70)
    print("NAS100 MINER — NYSE ORB Parameter Sweep")
    print("Signal: 13:30-13:45 UTC ORB | Long only | H4 EMA200 bias")
    print("=" * 70)

    df = load_and_enrich()
    if df is None:
        exit(1)

    # ── 1. Baseline confirmation ──────────────────────────────────────────
    print("\n[1/8] Baseline confirmation (H4 EMA200, OC=ON, TP=1.0×, ADR=OFF) ...")
    df_base = collect_signals(df,
                              tp_mult=TP_MULT_BASE,
                              min_orb_pts=MIN_ORB_PTS,
                              bias_col='h4_bias',
                              require_bias=True,
                              opening_candle=True,
                              adr_max=None)

    if df_base.empty:
        print("  No signals found — check CSV date range and column names."); exit(1)

    print_baseline_summary(df_base)
    df_base.to_csv('nas100_best_config.csv', index=False)
    print(f"\n  Saved {len(df_base)} signals → nas100_best_config.csv")

    # ── 2. TP sweep ───────────────────────────────────────────────────────
    print("\n[2/8] TP sweep (0.10×–3.00×) ...")
    df_sweep = analyze_tp_sweep(df_base, label="Baseline (H4 EMA200, OC=ON)")

    # ── 3. Opening candle filter analysis ─────────────────────────────────
    print("\n[3/8] Opening candle filter analysis ...")
    analyze_opening_candle(df, tp_mult=TP_MULT_BASE, min_orb_pts=MIN_ORB_PTS)

    # ── 4. Min-range filter sweep ─────────────────────────────────────────
    print("\n[4/8] ORB min-range filter sweep ...")
    analyze_min_range(df, tp_mult=TP_MULT_BASE, opening_candle=True)

    # ── 5. Bias filter comparison ──────────────────────────────────────────
    print("\n[5/8] Bias filter comparison ...")
    analyze_bias_filters(df, tp_mult=TP_MULT_BASE, min_orb_pts=MIN_ORB_PTS, opening_candle=True)

    # ── 6. ADR gate sweep ─────────────────────────────────────────────────
    print("\n[6/8] ADR gate threshold sweep ...")
    analyze_adr_gate(df, tp_mult=TP_MULT_BASE, min_orb_pts=MIN_ORB_PTS, opening_candle=True)

    # ── 7. Full parameter grid ────────────────────────────────────────────
    print("\n[7/8] Full parameter grid search ...")
    df_grid = run_grid_search(df)

    # ── 8. Multi-TP scaled exit ───────────────────────────────────────────
    print("\n" + "═" * 70)
    print("SECTION 8 — MULTI-TP SCALED EXIT  (baseline signals)")
    print("═" * 70)

    analyze_multi_tp(df_base,
                     tp_levels=(0.50, 1.00, 1.50), weights=(0.33, 0.33, 0.34),
                     label="TP1=0.50×(33%) TP2=1.00×(33%) runner=1.50×(34%) BE after TP1")

    analyze_multi_tp(df_base,
                     tp_levels=(0.50, 1.25, 2.00), weights=(0.50, 0.30, 0.20),
                     label="TP1=0.50×(50%) TP2=1.25×(30%) runner=2.00×(20%) BE after TP1")

    analyze_multi_tp(df_base,
                     tp_levels=(0.75, 1.50, 2.50), weights=(0.40, 0.40, 0.20),
                     label="TP1=0.75×(40%) TP2=1.50×(40%) runner=2.50×(20%) BE after TP1")

    # ── Final summary ─────────────────────────────────────────────────────
    w  = df_base['win'].values.astype(bool)
    pf = compute_pf_arrays(w, df_base['tp1_dist'].values, df_base['sl_dist'].values)

    print("\n" + "═" * 70)
    print("DONE")
    print("═" * 70)
    print(f"\n  Baseline (TV confirmed): WR={w.mean()*100:.1f}%  PF={pf:.3f}"
          f"  ~{len(df_base)/YEARS_TOTAL:.0f} trades/yr")
    print(f"\n  Read sections above for optimal parameters.")
    print(f"  If grid search finds PF > 1.4 with ≥ 40 trades/yr → lock into Pine Script.")
