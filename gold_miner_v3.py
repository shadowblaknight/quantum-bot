#!/usr/bin/env python3
"""
gold_miner_v3.py — ORB Signal Quality Deep Dive
=================================================
Reads the existing gold_miner_raw.csv cache (5.5yr, 128K bars).
Simulates the exact Pine Script Frankfurt ORB SHORT (Signal M) and NY ORB
(Signal H) execution logic and asks: what additional filters push WR from
66% toward 73%+ (PF 2.0)?

Current known best: M short only + H both + H4 bias + TP1 → PF 1.622, 66.67% WR
Target:             PF 2.0, WR ~73%

Strategy:
  1. Replay every Frankfurt ORB SHORT signal with Pine-exact SL/TP logic
  2. Record rich features at signal time
  3. Cross-tab every feature vs WR to find what separates wins from losses
  4. Decision Tree to find combination rules
  5. Repeat for NY ORB signals

Output: console + gold_frb_signals.csv + gold_nyorb_signals.csv
"""

import os, warnings
import pandas as pd
import numpy as np
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.ensemble import RandomForestClassifier
warnings.filterwarnings('ignore')

CACHE_FILE   = 'gold_miner_raw.csv'
EMA_PERIOD   = 20
ATR_PERIOD   = 14
MAX_BARS_FWD = 48   # max 12 hours to resolve trade

# ═══════════════════════════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════════════════════════

def compute_atr(df, period=14):
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift(1)).abs(),
        (df['low']  - df['close'].shift(1)).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()

def htf_bias(m15_df, tf_minutes, ema_p=20):
    """Resample to tf_minutes, compute EMA-20 state, forward-fill to M15 index."""
    ohlc = {'open':'first','high':'max','low':'min','close':'last'}
    rule = f'{tf_minutes}min'
    htf = m15_df.resample(rule, closed='right', label='right').agg(ohlc).dropna()
    ema = htf['close'].ewm(span=ema_p, adjust=False).mean()
    bias = np.where(htf['close'].shift(1) > ema.shift(1), 1,
                    np.where(htf['close'].shift(1) < ema.shift(1), -1, 0))
    s = pd.Series(bias, index=htf.index)
    return s.reindex(m15_df.index, method='ffill').fillna(0).astype(int)

def htf_ema_slope(m15_df, tf_minutes, ema_p=20):
    """Resample, compute EMA, return slope (rising=1 / flat=0 / falling=-1)."""
    ohlc = {'open':'first','high':'max','low':'min','close':'last'}
    htf = m15_df.resample(f'{tf_minutes}min', closed='right', label='right').agg(ohlc).dropna()
    ema = htf['close'].ewm(span=ema_p, adjust=False).mean()
    slope = np.sign(ema - ema.shift(1)).fillna(0).astype(int)
    return slope.reindex(m15_df.index, method='ffill').fillna(0).astype(int)

def min_of_day(idx):
    return idx.hour * 60 + idx.minute

def compute_pf(df_sig):
    """Profit Factor from per-trade win flag + actual price distances."""
    gw = gl = 0.0
    for _, r in df_sig.iterrows():
        if r['win']:
            gw += abs(r['entry'] - r['tp1'])
        else:
            gl += abs(r['sl'] - r['entry'])
    return gw / gl if gl > 0 else float('inf')

def label_trade_short(df_fwd, entry, sl, tp1, max_bars=48):
    """Check if SHORT trade hits tp1 before sl within max_bars. Returns (win:bool, bars:int)."""
    for i in range(min(max_bars, len(df_fwd))):
        bar = df_fwd.iloc[i]
        if bar['high'] >= sl:   # SL hit first
            return False, i + 1
        if bar['low'] <= tp1:   # TP hit first
            return True, i + 1
    return False, max_bars

def label_trade_long(df_fwd, entry, sl, tp1, max_bars=48):
    """Check if LONG trade hits tp1 before sl within max_bars."""
    for i in range(min(max_bars, len(df_fwd))):
        bar = df_fwd.iloc[i]
        if bar['low'] <= sl:    # SL hit first
            return False, i + 1
        if bar['high'] >= tp1:  # TP hit first
            return True, i + 1
    return False, max_bars

# ═══════════════════════════════════════════════════════════════════════════════
# FRANKFURT ORB SHORT (Signal M, H4 bearish, short only)
# Pine logic: range 07:00–07:30, first bar after 07:30 that closes < frb_lo
#             SL = frb_hi + max(atr*0.10, 0.50)
#             TP1 = frb_lo - orb_range * 1.0  (TP1 · 1R exit mode)
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_frb_shorts(df):
    print("\n" + "═"*70)
    print("FRANKFURT ORB SHORT ANALYSIS  (07:00-07:30 UTC, H4 bearish)")
    print("═"*70)

    rows = []
    dates = sorted(set(df.index.date))

    for i, date in enumerate(dates):
        day = df[df.index.date == date]
        if len(day) < 10:
            continue

        # Frankfurt range bars: 07:00-07:30 UTC (420-449 min)
        frb_win = day[(day.index.map(min_of_day) >= 420) & (day.index.map(min_of_day) < 450)]
        if frb_win.empty:
            continue
        frb_hi = frb_win['high'].max()
        frb_lo = frb_win['low'].min()
        orb_range = frb_hi - frb_lo
        if orb_range < 0.50:
            continue

        # Asian range for this day (00:00-07:00 UTC)
        asian = day[day.index.map(min_of_day) < 420]
        ar_hi = asian['high'].max() if not asian.empty else np.nan
        ar_lo = asian['low'].min() if not asian.empty else np.nan

        # Previous day data for context
        if i > 0:
            prev_day = df[df.index.date == dates[i - 1]]
            pd_hi = prev_day['high'].max()
            pd_lo = prev_day['low'].min()
        else:
            pd_hi = pd_lo = np.nan

        # Pre-Frankfurt hour: 06:00-07:00 UTC (360-420 min)
        pre_frb = day[(day.index.map(min_of_day) >= 360) & (day.index.map(min_of_day) < 420)]

        # Trade window: bars AFTER 07:30 UTC (min >= 450)
        trade = day[day.index.map(min_of_day) >= 450]
        if trade.empty:
            continue

        # Find first bar closing below frb_lo with H4 bearish
        signal_bar = None
        signal_idx = None
        for j, (idx, bar) in enumerate(trade.iterrows()):
            if bar['close'] < frb_lo and bar['h4_bias'] == -1:
                signal_bar = bar
                signal_idx = idx
                break

        if signal_bar is None:
            continue

        entry = signal_bar['close']
        buf   = max(signal_bar['atr'] * 0.10, 0.50)
        sl    = frb_hi + buf
        tp1   = frb_lo - orb_range * 1.0   # TP1 mode: 1× OR range below frb_lo

        if sl <= entry or tp1 >= entry:
            continue  # invalid geometry

        # Forward label
        df_fwd = df[df.index > signal_idx]
        win, bars_held = label_trade_short(df_fwd, entry, sl, tp1, max_bars=MAX_BARS_FWD)

        # === Features at signal time ===
        atr_v    = signal_bar['atr']
        pre_mom  = ((pre_frb['close'].iloc[-1] - pre_frb['open'].iloc[0]) / atr_v
                    if not pre_frb.empty and atr_v > 0 else 0.0)

        row = {
            'date'           : date,
            'signal_time'    : signal_idx,
            # HTF bias
            'h4b'            : int(signal_bar['h4_bias']),    # always -1 (filter)
            'h1b'            : int(signal_bar['h1_bias']),
            'hdb'            : int(signal_bar['hd_bias']),
            'h4_slope'       : int(signal_bar['h4_slope']),
            # Range quality
            'orb_range_atr'  : orb_range / atr_v if atr_v > 0 else 0,
            'asian_range_atr': (ar_hi - ar_lo) / atr_v if (not np.isnan(ar_lo) and atr_v > 0) else 0,
            # Key structural conditions
            'breaks_asian_lo': 1 if (not np.isnan(ar_lo) and entry < ar_lo) else 0,
            'breaks_pdl'     : 1 if (not np.isnan(pd_lo) and entry < pd_lo) else 0,
            # Momentum
            'pre_frb_mom'    : pre_mom,   # negative = falling into Frankfurt open
            'ret4bar'        : signal_bar['ret4bar'],
            # Session / calendar
            'dow'            : pd.Timestamp(date).dayofweek,  # 0=Mon, 4=Fri
            'month'          : pd.Timestamp(date).month,
            # ADR consumed before Frankfurt
            'adr_at_frb'     : signal_bar['adr_consumed'],
            # Trade geometry
            'entry'          : entry,
            'sl'             : sl,
            'tp1'            : tp1,
            'sl_dist'        : sl - entry,
            'reward'         : entry - tp1,
            'bars_held'      : bars_held,
            'win'            : int(win),
        }
        rows.append(row)

    df_sig = pd.DataFrame(rows)
    if df_sig.empty:
        print("No Frankfurt ORB short signals found.")
        return df_sig

    _print_orb_analysis(df_sig, label="Frankfurt ORB SHORT")
    return df_sig


# ═══════════════════════════════════════════════════════════════════════════════
# NY ORB (Signal H) — BOTH directions, H4 bias aligned
# Pine logic: range 14:00–14:30, first bar after 14:30 closing outside range
#             SL = opposite extreme + buf; TP1 = 1× OR range
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_nyorb(df):
    print("\n" + "═"*70)
    print("NY ORB ANALYSIS  (14:00-14:30 UTC, H4 bias aligned, BOTH directions)")
    print("═"*70)

    rows = []
    dates = sorted(set(df.index.date))

    for i, date in enumerate(dates):
        day = df[df.index.date == date]
        if len(day) < 10:
            continue

        # NY ORB range: 14:00-14:30 UTC (840-869 min)
        orb_win = day[(day.index.map(min_of_day) >= 840) & (day.index.map(min_of_day) < 870)]
        if orb_win.empty:
            continue
        orb_hi = orb_win['high'].max()
        orb_lo = orb_win['low'].min()
        orb_range = orb_hi - orb_lo
        if orb_range < 0.50:
            continue

        # Frankfurt context for this day
        frb_win  = day[(day.index.map(min_of_day) >= 420) & (day.index.map(min_of_day) < 450)]
        frb_hi   = frb_win['high'].max() if not frb_win.empty else np.nan
        frb_lo   = frb_win['low'].min()  if not frb_win.empty else np.nan
        frb_short_day = 0  # did Frankfurt break SHORT today?
        if not np.isnan(frb_lo):
            frb_trade = day[(day.index.map(min_of_day) >= 450) & (day.index.map(min_of_day) < 660)]
            for _, bar in frb_trade.iterrows():
                if bar['close'] < frb_lo:
                    frb_short_day = 1
                    break

        # Previous day context
        pd_hi = pd_lo = np.nan
        if i > 0:
            prev_day = df[df.index.date == dates[i - 1]]
            pd_hi = prev_day['high'].max()
            pd_lo = prev_day['low'].min()

        # Trade window: after 14:30 UTC (min >= 870)
        trade = day[day.index.map(min_of_day) >= 870]
        if trade.empty:
            continue

        # Find first signal bar
        signal_bar = None
        signal_idx = None
        direction  = None
        for j, (idx, bar) in enumerate(trade.iterrows()):
            if bar['close'] > orb_hi and bar['h4_bias'] == 1:
                signal_bar = bar; signal_idx = idx; direction = 'long'
                break
            elif bar['close'] < orb_lo and bar['h4_bias'] == -1:
                signal_bar = bar; signal_idx = idx; direction = 'short'
                break

        if signal_bar is None:
            continue

        entry = signal_bar['close']
        buf   = max(signal_bar['atr'] * 0.10, 0.50)
        atr_v = signal_bar['atr']

        if direction == 'short':
            sl  = orb_hi + buf
            tp1 = orb_lo - orb_range * 1.0
            if sl <= entry or tp1 >= entry:
                continue
        else:
            sl  = orb_lo - buf
            tp1 = orb_hi + orb_range * 1.0
            if sl >= entry or tp1 <= entry:
                continue

        # Forward label
        df_fwd = df[df.index > signal_idx]
        if direction == 'short':
            win, bars_held = label_trade_short(df_fwd, entry, sl, tp1, MAX_BARS_FWD)
        else:
            win, bars_held = label_trade_long(df_fwd, entry, sl, tp1, MAX_BARS_FWD)

        row = {
            'date'           : date,
            'direction'      : direction,
            'h4b'            : int(signal_bar['h4_bias']),
            'h1b'            : int(signal_bar['h1_bias']),
            'hdb'            : int(signal_bar['hd_bias']),
            'h4_slope'       : int(signal_bar['h4_slope']),
            'orb_range_atr'  : orb_range / atr_v if atr_v > 0 else 0,
            'frb_short_day'  : frb_short_day,   # Frankfurt was short today
            'breaks_pdl'     : 1 if (direction == 'short' and not np.isnan(pd_lo) and entry < pd_lo) else 0,
            'breaks_pdh'     : 1 if (direction == 'long'  and not np.isnan(pd_hi) and entry > pd_hi) else 0,
            'ret4bar'        : signal_bar['ret4bar'],
            'dow'            : pd.Timestamp(date).dayofweek,
            'month'          : pd.Timestamp(date).month,
            'adr_at_nyorb'   : signal_bar['adr_consumed'],
            'entry'          : entry,
            'sl'             : sl,
            'tp1'            : tp1,
            'sl_dist'        : abs(sl - entry),
            'reward'         : abs(tp1 - entry),
            'bars_held'      : bars_held,
            'win'            : int(win),
        }
        rows.append(row)

    df_sig = pd.DataFrame(rows)
    if df_sig.empty:
        print("No NY ORB signals found.")
        return df_sig

    _print_orb_analysis(df_sig, label="NY ORB (both directions)")

    # Also split by direction
    for d in ['short', 'long']:
        sub = df_sig[df_sig['direction'] == d]
        if len(sub) >= 20:
            _print_orb_analysis(sub, label=f"NY ORB {d.upper()} only")

    return df_sig


# ═══════════════════════════════════════════════════════════════════════════════
# ANALYSIS ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

def _print_orb_analysis(df_sig, label):
    n   = len(df_sig)
    wr  = df_sig['win'].mean()
    pf  = compute_pf(df_sig)

    print(f"\n{'─'*70}")
    print(f"  {label}")
    print(f"  N={n}  WR={wr*100:.1f}%  PF={pf:.3f}")
    print(f"{'─'*70}")

    # ── Cross-tab on key filters ──────────────────────────────────────────
    print("\n  CROSS-TABS (factors to add on top of current setup)")

    for feat, vals, fmt in [
        ('h1b',            [-1, 0, 1],    lambda v: f"h1={'BEAR' if v==-1 else 'FLAT' if v==0 else 'BULL'}"),
        ('hdb',            [-1, 0, 1],    lambda v: f"hd={'BEAR' if v==-1 else 'FLAT' if v==0 else 'BULL'}"),
        ('h4_slope',       [-1, 0, 1],    lambda v: f"h4_slope={'↓' if v==-1 else '─' if v==0 else '↑'}"),
        ('breaks_asian_lo',[0, 1],        lambda v: f"below_asian_lo={'YES' if v else 'no'}") if 'breaks_asian_lo' in df_sig.columns else (None, [], None),
        ('breaks_pdl',     [0, 1],        lambda v: f"below_PDL={'YES' if v else 'no'}")      if 'breaks_pdl' in df_sig.columns else (None, [], None),
        ('frb_short_day',  [0, 1],        lambda v: f"frb_short_day={'YES' if v else 'no'}")  if 'frb_short_day' in df_sig.columns else (None, [], None),
        ('dow',            list(range(5)),lambda v: f"dow={['Mon','Tue','Wed','Thu','Fri'][v]}"),
    ]:
        if feat is None or feat not in df_sig.columns:
            continue
        print(f"\n  -- {feat} --")
        for v in vals:
            sub = df_sig[df_sig[feat] == v]
            if len(sub) < 15:
                continue
            sub_wr  = sub['win'].mean()
            sub_pf  = compute_pf(sub)
            pct_all = len(sub) / n * 100
            star    = ' ***' if sub_pf >= 1.8 else (' **' if sub_pf >= 1.5 else '')
            print(f"    {fmt(v):30s}  N={len(sub):4d} ({pct_all:4.0f}%)  "
                  f"WR={sub_wr*100:5.1f}%  PF={sub_pf:.3f}{star}")

    # ── ORB range quality ─────────────────────────────────────────────────
    if 'orb_range_atr' in df_sig.columns:
        print(f"\n  -- orb_range_atr (Frankfurt/NY range as fraction of ATR) --")
        bins = [0, 0.3, 0.5, 0.7, 1.0, 99]
        labels = ['<0.3', '0.3-0.5', '0.5-0.7', '0.7-1.0', '>1.0']
        df_sig['rng_bin'] = pd.cut(df_sig['orb_range_atr'], bins=bins, labels=labels)
        for lbl in labels:
            sub = df_sig[df_sig['rng_bin'] == lbl]
            if len(sub) < 10:
                continue
            sub_wr = sub['win'].mean()
            sub_pf = compute_pf(sub)
            star   = ' ***' if sub_pf >= 1.8 else (' **' if sub_pf >= 1.5 else '')
            print(f"    orb_range={lbl:10s}  N={len(sub):4d}  WR={sub_wr*100:5.1f}%  PF={sub_pf:.3f}{star}")

    # ── Combinations (top 2–3 filters) ───────────────────────────────────
    print(f"\n  TOP COMBINATIONS:")
    combo_results = []

    combo_cols = [c for c in ['h1b', 'hdb', 'breaks_asian_lo', 'breaks_pdl',
                               'h4_slope', 'frb_short_day']
                  if c in df_sig.columns]

    # 2-way combos
    for i, f1 in enumerate(combo_cols):
        for f2 in combo_cols[i+1:]:
            for v1 in df_sig[f1].unique():
                for v2 in df_sig[f2].unique():
                    sub = df_sig[(df_sig[f1] == v1) & (df_sig[f2] == v2)]
                    if len(sub) < 30:
                        continue
                    sub_wr = sub['win'].mean()
                    sub_pf = compute_pf(sub)
                    combo_results.append({
                        'filter': f"{f1}={v1} & {f2}={v2}",
                        'n': len(sub),
                        'wr': sub_wr,
                        'pf': sub_pf,
                        'pct': len(sub)/n*100,
                    })

    # 3-way combos (top candidates only)
    if 'h1b' in combo_cols and 'hdb' in combo_cols and 'breaks_asian_lo' in combo_cols:
        for v1 in [-1, 1]:
            for v2 in [-1, 1]:
                for v3 in [0, 1]:
                    sub = df_sig[(df_sig['h1b'] == v1) & (df_sig['hdb'] == v2) & (df_sig['breaks_asian_lo'] == v3)]
                    if len(sub) < 20:
                        continue
                    sub_wr = sub['win'].mean()
                    sub_pf = compute_pf(sub)
                    combo_results.append({
                        'filter': f"h1b={v1} & hdb={v2} & asian_break={v3}",
                        'n': len(sub),
                        'wr': sub_wr,
                        'pf': sub_pf,
                        'pct': len(sub)/n*100,
                    })

    if combo_results:
        top = sorted(combo_results, key=lambda x: x['pf'], reverse=True)[:15]
        for r in top:
            star = ' ****' if r['pf'] >= 2.0 else (' ***' if r['pf'] >= 1.8 else (' **' if r['pf'] >= 1.5 else ''))
            print(f"    {r['filter']:50s}  N={r['n']:4d} ({r['pct']:4.0f}%)  "
                  f"WR={r['wr']*100:5.1f}%  PF={r['pf']:.3f}{star}")

    # ── Decision Tree ─────────────────────────────────────────────────────
    feat_cols = [c for c in ['h1b', 'hdb', 'h4_slope', 'breaks_asian_lo',
                              'breaks_pdl', 'orb_range_atr', 'pre_frb_mom',
                              'ret4bar', 'dow', 'month', 'adr_at_frb',
                              'adr_at_nyorb', 'frb_short_day']
                 if c in df_sig.columns]

    if len(feat_cols) >= 2 and len(df_sig) >= 100:
        X = df_sig[feat_cols].fillna(0)
        y = df_sig['win']
        dt = DecisionTreeClassifier(max_depth=4, min_samples_leaf=25, random_state=42)
        dt.fit(X, y)
        print(f"\n  DECISION TREE RULES (min 25 trades/leaf):")
        print(export_text(dt, feature_names=feat_cols))

        rf = RandomForestClassifier(n_estimators=200, max_depth=6, min_samples_leaf=20, random_state=42)
        rf.fit(X, y)
        fi = pd.Series(rf.feature_importances_, index=feat_cols).sort_values(ascending=False)
        print(f"\n  FEATURE IMPORTANCE (Random Forest):")
        for feat_name, imp in fi.items():
            if imp >= 0.01:
                print(f"    {feat_name:25s}  {imp*100:.1f}%")


# ═══════════════════════════════════════════════════════════════════════════════
# LOAD + ENRICH DATA
# ═══════════════════════════════════════════════════════════════════════════════

def load_and_enrich():
    if not os.path.exists(CACHE_FILE):
        print(f"ERROR: {CACHE_FILE} not found. Run gold_miner.py first to fetch data.")
        return None

    print(f"Loading {CACHE_FILE} ...")
    df = pd.read_csv(CACHE_FILE, parse_dates=['datetime'])
    df = df.sort_values('datetime').drop_duplicates('datetime')
    df = df.set_index('datetime')
    df.index = df.index.tz_localize(None)
    print(f"  {len(df):,} bars loaded  ({df.index[0].date()} → {df.index[-1].date()})")

    print("Computing ATR and HTF bias ...")
    df['atr']      = compute_atr(df, ATR_PERIOD)
    df['h4_bias']  = htf_bias(df, 240)
    df['h1_bias']  = htf_bias(df, 60)
    df['hd_bias']  = htf_bias(df, 1440)
    df['h4_slope'] = htf_ema_slope(df, 240)

    # 4-bar momentum in ATR units
    df['ret4bar'] = np.where(df['atr'] > 0,
                              (df['close'] - df['close'].shift(4)) / df['atr'], 0.0)

    # Daily high/low running (for ADR consumed)
    df['_date'] = df.index.date
    df['_day_hi'] = df.groupby('_date')['high'].transform('cummax')
    df['_day_lo'] = df.groupby('_date')['low'].transform('cummin')
    atr14d = df['atr'].resample('D').last().reindex(df.index, method='ffill')
    df['adr_consumed'] = np.where(atr14d > 0,
                                   (df['_day_hi'] - df['_day_lo']) / atr14d, 0.0)
    df.drop(columns=['_date', '_day_hi', '_day_lo'], inplace=True)

    return df


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("=" * 70)
    print("GOLD MINER v3 — ORB Signal Quality Deep Dive")
    print("Goal: find filters to push from PF 1.622 (66.7% WR) -> PF 2.0 (73%+ WR)")
    print("=" * 70)

    df = load_and_enrich()
    if df is None:
        exit(1)

    # ── Frankfurt ORB SHORT analysis ──────────────────────────────────────
    frb_signals = analyze_frb_shorts(df)
    if not frb_signals.empty:
        frb_signals.to_csv('gold_frb_signals.csv', index=False)
        print(f"\nSaved {len(frb_signals)} Frankfurt ORB SHORT records → gold_frb_signals.csv")

    # ── NY ORB analysis ───────────────────────────────────────────────────
    nyorb_signals = analyze_nyorb(df)
    if not nyorb_signals.empty:
        nyorb_signals.to_csv('gold_nyorb_signals.csv', index=False)
        print(f"Saved {len(nyorb_signals)} NY ORB records → gold_nyorb_signals.csv")

    print("\nDone.")
