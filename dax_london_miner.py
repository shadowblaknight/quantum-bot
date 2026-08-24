#!/usr/bin/env python3
"""
dax_london_miner.py — GER40 London Open Gap Distribution Miner
==============================================================
Core concept: DAX/GER40 DISTRIBUTES at London market open (07:00 UTC).
Direction is predicted by 3 confluent factors:

  1. MULTI-TF GAP SCAN (most important)
     Scan all unfilled FVGs on 5m/15m/30m/1h before 07:00 UTC.
     - Bear FVGs ABOVE current price → bullish pull (price must go UP to fill)
     - Bull FVGs BELOW current price → bearish pull (price must go DOWN to fill)
     Net weighted score → gap direction bias.

  2. PREV DAY NY SESSION (13:30-17:30 UTC)
     Was yesterday's NY session bullish or bearish?
     Did it create gaps that London NEEDS to distribute into?

  3. PREV DAY OVERNIGHT / ASIAN SESSION (17:30 UTC → 07:00 UTC)
     Direction of the overnight move.
     The overnight H/L also sets the SL anchors.

Entry:     Open of first 5m bar at 07:00 UTC (London open)
SL:        Overnight session low (LONG) or high (SHORT) ± ATR buffer
TP:        Fixed 2.0× SL distance  OR  nearest unfulfilled gap target
Hard close: 13:00 UTC (before NY disrupts London distribution)

Data:  dax_5m_raw.csv / dax_15m_raw.csv / dax_30m_raw.csv / dax_1h_raw.csv
       (produced by download_metaapi_dax.py)

Sections:
  1. Baseline confirmation
  2. Min-score threshold sweep (signal confidence filter)
  3. Gap TP vs fixed TP comparison
  4. Filter ablation (gap-only / NY-only / overnight-only / combined)
  5. Confluence quality breakdown (2/3 vs 3/3 agreement)
  6. Parameter grid (min_score × TP mult × lookback days)
  7. Year-by-year stability
  8. Day-of-week + direction breakdown
"""

import warnings, itertools
from datetime import date as date_type, timedelta
import pandas as pd
import numpy as np
from pathlib import Path

warnings.filterwarnings('ignore')

DATA_DIR = Path(r"C:\Users\Omar Nasr\quantum-bot")

# ─── Session windows (UTC minutes-of-day) ─────────────────────────────────────
LONDON_OPEN     =  7 * 60        # 07:00 UTC — entry
HARD_CLOSE      = 13 * 60        # 13:00 UTC — forced exit
NY_START        = 13 * 60 + 30   # 13:30 UTC
DAX_CLOSE       = 17 * 60 + 30   # 17:30 UTC — overnight session starts

# ─── Gap scan config ──────────────────────────────────────────────────────────
FVG_LOOKBACK_DAYS = 3            # how many days back to scan for unfilled gaps

# TF weights: higher TF gaps have more institutional relevance
TF_WEIGHTS = {'5m': 1, '15m': 2, '30m': 3, '1h': 4}

# Recency weights: fresher gaps have stronger pull
RECENCY_THRESHOLDS = [(24, 3), (48, 2), (72, 1)]  # (hours, weight)

# ─── Scoring weights ──────────────────────────────────────────────────────────
NY_WEIGHT       = 3   # prev-day NY session contribution to composite score
OVERNIGHT_WEIGHT = 2  # overnight (Asian) session contribution
BASE_MIN_SCORE  = 3   # minimum |total_score| to take a trade (baseline)

# ─── Trade params ─────────────────────────────────────────────────────────────
BASE_TP     = 2.0    # TP = N × SL distance
BASE_SL_BUF = 0.5    # SL = overnight extreme ± ATR × SL_BUF

def bmin(idx):
    return idx.hour * 60 + idx.minute


# ─── Utilities ────────────────────────────────────────────────────────────────

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


# ─── FVG detection ────────────────────────────────────────────────────────────

def detect_fvgs(df):
    """
    Vectorized FVG detection.
    Bullish FVG: bar[i-2].high < bar[i].low  (gap left on upward move, below current bar)
    Bearish FVG: bar[i-2].low  > bar[i].high (gap left on downward move, above current bar)
    Returns DataFrame: type, top, bot, mid, ts
    """
    if len(df) < 3:
        return pd.DataFrame(columns=['type','top','bot','mid','ts'])

    h  = df['high'].values
    l  = df['low'].values
    ts = df.index  # keep as DatetimeIndex to preserve timezone

    # Bullish FVG: gap between bar[i-2].high and bar[i].low
    bull_mask = l[2:] > h[:-2]
    # Bearish FVG: gap between bar[i].high and bar[i-2].low
    bear_mask = l[:-2] > h[2:]

    records = []
    idx = np.where(bull_mask)[0]
    for i in idx:
        top, bot = float(l[i+2]), float(h[i])
        if top > bot:
            records.append({'type': 'bull', 'top': top, 'bot': bot,
                            'mid': (top+bot)/2, 'ts': ts[i+2]})

    idx = np.where(bear_mask)[0]
    for i in idx:
        top, bot = float(l[i]), float(h[i+2])
        if top > bot:
            records.append({'type': 'bear', 'top': top, 'bot': bot,
                            'mid': (top+bot)/2, 'ts': ts[i]})

    return (pd.DataFrame(records).sort_values('ts').reset_index(drop=True)
            if records else pd.DataFrame(columns=['type','top','bot','mid','ts']))


def is_filled(fvg_top, fvg_bot, bars_h, bars_l):
    """Check if FVG (bot, top) was touched by any bar in bars_h / bars_l arrays."""
    if len(bars_h) == 0:
        return False
    return bool(((bars_l <= fvg_top) & (bars_h >= fvg_bot)).any())


# ─── Trade resolver ───────────────────────────────────────────────────────────

def resolve_trade(df5, entry_ts, entry, sl, tp, is_long):
    """Scan London session forward from entry_ts bar. Returns (win, bars, exit_ts, mfe)."""
    london_bars = df5[df5.index >= entry_ts]
    mfe = 0.0
    for i in range(1, len(london_bars)):
        bar = london_bars.iloc[i]
        bm  = bmin(bar.name)
        if bm >= HARD_CLOSE:
            ep  = bar['open']
            pnl = (ep - entry) if is_long else (entry - ep)
            return pnl > 0, i, bar.name, mfe
        sl_hit = bar['low'] <= sl if is_long else bar['high'] >= sl
        tp_hit = bar['high'] >= tp if is_long else bar['low'] <= tp
        if sl_hit and tp_hit:
            return False, i, bar.name, mfe
        if sl_hit:
            return False, i, bar.name, mfe
        if tp_hit:
            return True,  i, bar.name, mfe
        mfe = max(mfe, bar['high'] - entry) if is_long else max(mfe, entry - bar['low'])
    # Session ended without SL or TP
    return False, max(0, len(london_bars)-1), london_bars.index[-1] if len(london_bars) else entry_ts, mfe


# ─── Signal engine ────────────────────────────────────────────────────────────

def collect_signals(df_by_tf,
                    tp_mult        = BASE_TP,
                    sl_buf         = BASE_SL_BUF,
                    min_score      = BASE_MIN_SCORE,
                    lookback_days  = FVG_LOOKBACK_DAYS,
                    use_gap_bias   = True,
                    use_ny_bias    = True,
                    use_night_bias = True,
                    use_gap_tp     = False):
    """
    Day-by-day London open signal collection.

    For each trading day:
      1. Scan multi-TF unfilled FVGs before 07:00 UTC → gap direction score
      2. Prev day NY session direction → ny_score
      3. Overnight session direction → overnight_score
      4. If |combined score| >= min_score → entry at London open
    """
    df5 = next((df_by_tf[k] for k in ('5m', '15m', '30m', '1h') if k in df_by_tf), None)
    if df5 is None:
        return pd.DataFrame()

    rows  = []
    dates = sorted({d for d in df5.index.date if pd.Timestamp(d).day_of_week < 5})

    for day_date in dates:
        day_ts = pd.Timestamp(day_date, tz='UTC')

        # ─── Entry bar at London open ──────────────────────────────────
        london_open_ts = day_ts.replace(hour=7, minute=0)
        entry_bars = df5[df5.index >= london_open_ts]
        if entry_bars.empty:
            continue
        entry_bar  = entry_bars.iloc[0]
        # Only proceed if the entry bar is on the right date
        if entry_bar.name.date() != day_date:
            continue
        entry_price = float(entry_bar['open'])
        atr_val     = float(entry_bar.get('atr', entry_bar['high'] - entry_bar['low']))

        # ─── Overnight session: prev DAX close (17:30) → today 07:00 ──
        prev_date = day_date - timedelta(days=1)
        while pd.Timestamp(prev_date).day_of_week >= 5:
            prev_date -= timedelta(days=1)

        overnight_start_ts = pd.Timestamp(prev_date, tz='UTC').replace(hour=17, minute=30)
        overnight_end_ts   = london_open_ts

        overnight = df5[(df5.index >= overnight_start_ts) & (df5.index < overnight_end_ts)]
        if len(overnight) < 3:
            continue

        overnight_hi  = float(overnight['high'].max())
        overnight_lo  = float(overnight['low'].min())
        night_first   = float(overnight.iloc[0]['open'])
        night_last    = float(overnight.iloc[-1]['close'])
        overnight_bias = 1 if night_last > night_first else -1

        # ─── Prev day NY session (13:30-17:30 UTC) ────────────────────
        ny_start_ts  = pd.Timestamp(prev_date, tz='UTC').replace(hour=13, minute=30)
        ny_end_ts    = pd.Timestamp(prev_date, tz='UTC').replace(hour=17, minute=30)
        prev_ny      = df5[(df5.index >= ny_start_ts) & (df5.index < ny_end_ts)]

        if len(prev_ny) < 3:
            prev_ny_bias = 0
        else:
            prev_ny_bias = 1 if float(prev_ny.iloc[-1]['close']) > float(prev_ny.iloc[0]['open']) else -1

        # ─── Multi-TF gap scan ─────────────────────────────────────────
        lookback_start_ts = london_open_ts - pd.Timedelta(days=lookback_days)
        fill_ref_h = df5.loc[
            (df5.index > lookback_start_ts) & (df5.index < london_open_ts), 'high'
        ].values
        fill_ref_l = df5.loc[
            (df5.index > lookback_start_ts) & (df5.index < london_open_ts), 'low'
        ].values
        fill_ref_ts = df5.index[
            (df5.index > lookback_start_ts) & (df5.index < london_open_ts)
        ]

        long_score  = 0.0   # bear FVGs above entry_price → LONG pull
        short_score = 0.0   # bull FVGs below entry_price → SHORT pull
        n_long_gaps = 0
        n_short_gaps = 0
        nearest_long_gap  = None  # closest gap target above price
        nearest_short_gap = None  # closest gap target below price

        for tf, tf_w in TF_WEIGHTS.items():
            df_tf = df_by_tf.get(tf)
            if df_tf is None:
                continue
            tf_slice = df_tf[(df_tf.index >= lookback_start_ts) & (df_tf.index < london_open_ts)]
            fvgs = detect_fvgs(tf_slice)
            if fvgs.empty:
                continue

            for _, fvg in fvgs.iterrows():
                # Bars after FVG formation (for fill check), using 5m base
                after_mask  = fill_ref_ts > fvg['ts']
                if not after_mask.any():
                    continue
                filled = is_filled(fvg['top'], fvg['bot'],
                                   fill_ref_h[after_mask], fill_ref_l[after_mask])
                if filled:
                    continue

                # Recency weight
                age_h = (london_open_ts - pd.Timestamp(fvg['ts'])).total_seconds() / 3600
                rw = next((w for h_limit, w in RECENCY_THRESHOLDS if age_h <= h_limit), 1)
                contrib = float(tf_w * rw)

                # Direction of pull
                if fvg['type'] == 'bear' and fvg['mid'] > entry_price:
                    # Bear FVG above → bullish magnet → LONG pull
                    long_score  += contrib
                    n_long_gaps += 1
                    if nearest_long_gap is None or fvg['bot'] < nearest_long_gap:
                        nearest_long_gap = float(fvg['bot'])

                elif fvg['type'] == 'bull' and fvg['mid'] < entry_price:
                    # Bull FVG below → bearish magnet → SHORT pull
                    short_score  += contrib
                    n_short_gaps += 1
                    if nearest_short_gap is None or fvg['top'] > nearest_short_gap:
                        nearest_short_gap = float(fvg['top'])

        # ─── Composite score ───────────────────────────────────────────
        gap_net = long_score - short_score

        ny_contrib    = prev_ny_bias    * NY_WEIGHT     if use_ny_bias    else 0
        night_contrib = overnight_bias  * OVERNIGHT_WEIGHT if use_night_bias else 0
        gap_contrib   = gap_net                          if use_gap_bias   else 0

        total = gap_contrib + ny_contrib + night_contrib

        if abs(total) < min_score:
            continue

        is_long   = (total > 0)
        direction = 'LONG' if is_long else 'SHORT'

        # Confluence count (how many of the 3 factors agree)
        gap_dir    = (1 if gap_net > 0 else -1) if gap_net != 0 else 0
        confluence = sum([
            1 if (is_long and gap_dir == 1 or not is_long and gap_dir == -1) else 0,
            1 if (is_long and prev_ny_bias == 1 or not is_long and prev_ny_bias == -1) else 0,
            1 if (is_long and overnight_bias == 1 or not is_long and overnight_bias == -1) else 0,
        ])

        # ─── SL / TP ───────────────────────────────────────────────────
        if is_long:
            sl = overnight_lo - atr_val * sl_buf
            if use_gap_tp and nearest_long_gap is not None and nearest_long_gap > entry_price:
                tp = max(nearest_long_gap, entry_price + (entry_price - sl) * 1.0)
            else:
                tp = entry_price + (entry_price - sl) * tp_mult
        else:
            sl = overnight_hi + atr_val * sl_buf
            if use_gap_tp and nearest_short_gap is not None and nearest_short_gap < entry_price:
                tp = min(nearest_short_gap, entry_price - (sl - entry_price) * 1.0)
            else:
                tp = entry_price - (sl - entry_price) * tp_mult

        sl_dist = abs(entry_price - sl)
        tp_dist = abs(tp - entry_price)

        if sl_dist <= 0 or tp_dist <= 0:
            continue
        if is_long  and (sl >= entry_price or tp <= entry_price):
            continue
        if not is_long and (sl <= entry_price or tp >= entry_price):
            continue

        # ─── Resolve trade ─────────────────────────────────────────────
        win, bars_held, exit_ts, mfe = resolve_trade(df5, london_open_ts, entry_price, sl, tp, is_long)

        rows.append({
            'date':          day_date,
            'entry_ts':      entry_bar.name,
            'exit_ts':       exit_ts,
            'direction':     direction,
            'entry':         entry_price,
            'sl':            sl,
            'tp':            tp,
            'sl_dist':       sl_dist,
            'tp_dist':       tp_dist,
            'win':           int(win),
            'bars_held':     bars_held,
            'mfe':           mfe,
            'total_score':   total,
            'gap_net':       gap_net,
            'long_score':    long_score,
            'short_score':   short_score,
            'n_long_gaps':   n_long_gaps,
            'n_short_gaps':  n_short_gaps,
            'prev_ny_bias':  prev_ny_bias,
            'night_bias':    overnight_bias,
            'confluence':    confluence,
            'overnight_hi':  overnight_hi,
            'overnight_lo':  overnight_lo,
            'dow':           pd.Timestamp(day_date).day_name()[:3],
        })

    return pd.DataFrame(rows)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — BASELINE
# ═══════════════════════════════════════════════════════════════════════════════

def section1_baseline(df_by_tf, years_total):
    print("\n" + "═" * 70)
    print("SECTION 1 — BASELINE")
    print(f"  min_score={BASE_MIN_SCORE} | TP={BASE_TP}× | gap+NY+overnight | lookback={FVG_LOOKBACK_DAYS}d")
    print("═" * 70)

    df_sig = collect_signals(df_by_tf)
    if df_sig.empty:
        print("  No signals generated.")
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
    print(f"\n  Direction:")
    for d in ['LONG', 'SHORT']:
        sub = df_sig[df_sig['direction'] == d]
        if len(sub) < 3:
            continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        print(f"    {d:5}: N={len(sub):3d}  WR={sw.mean()*100:.1f}%  PF={sp:.3f}")

    # Confluence quality
    print(f"\n  Confluence breakdown:")
    for c in sorted(df_sig['confluence'].unique(), reverse=True):
        sub = df_sig[df_sig['confluence'] == c]
        if len(sub) < 3:
            continue
        sw = sub['win'].values.astype(bool)
        sp = pf_of(sw, sub['tp_dist'].values, sub['sl_dist'].values)
        stars = '★★★' if c == 3 else '★★' if c == 2 else '★'
        print(f"    {c}/3 confluent  {stars}: N={len(sub):3d}  WR={sw.mean()*100:.1f}%  PF={sp:.3f}")

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
# SECTION 2 — MIN-SCORE THRESHOLD SWEEP
# ═══════════════════════════════════════════════════════════════════════════════

def section2_score_sweep(df_by_tf, years_total):
    print("\n" + "═" * 70)
    print("SECTION 2 — MIN-SCORE THRESHOLD SWEEP")
    print("  Higher score = more agreement between gap bias, NY, overnight")
    print("═" * 70)

    scores = [1, 2, 3, 4, 5, 6, 7, 8, 10]
    print(f"\n  {'Score≥':>6}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*6}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for s in scores:
        df_s = collect_signals(df_by_tf, min_score=s)
        if len(df_s) < 5:
            print(f"  {s:>6}     <5 signals")
            continue
        w   = df_s['win'].values.astype(bool)
        pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        note = '  ← baseline' if s == BASE_MIN_SCORE else ''
        print(f"  {s:>6}  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}{note}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — GAP TP vs FIXED TP
# ═══════════════════════════════════════════════════════════════════════════════

def section3_gap_tp(df_by_tf, years_total):
    print("\n" + "═" * 70)
    print("SECTION 3 — GAP TP vs FIXED TP")
    print("  Gap TP: nearest unfulfilled gap as target (natural price magnet)")
    print("═" * 70)

    configs = [
        ("Fixed 2.0×",         dict(tp_mult=2.0, use_gap_tp=False)),
        ("Fixed 1.5×",         dict(tp_mult=1.5, use_gap_tp=False)),
        ("Fixed 2.5×",         dict(tp_mult=2.5, use_gap_tp=False)),
        ("Fixed 3.0×",         dict(tp_mult=3.0, use_gap_tp=False)),
        ("Nearest gap TP",     dict(tp_mult=2.0, use_gap_tp=True)),
    ]

    print(f"\n  {'Config':<25}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*25}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for lbl, kw in configs:
        df_s = collect_signals(df_by_tf, **kw)
        if len(df_s) < 5:
            print(f"  {lbl:<25}  <5 signals")
            continue
        w   = df_s['win'].values.astype(bool)
        pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        print(f"  {lbl:<25}  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — FILTER ABLATION
# ═══════════════════════════════════════════════════════════════════════════════

def section4_ablation(df_by_tf, years_total):
    print("\n" + "═" * 70)
    print("SECTION 4 — FILTER ABLATION")
    print("  What happens when each bias component is removed?")
    print("═" * 70)

    configs = [
        ("All three (baseline)",          dict(use_gap_bias=True,  use_ny_bias=True,  use_night_bias=True)),
        ("Gap bias only",                  dict(use_gap_bias=True,  use_ny_bias=False, use_night_bias=False, min_score=1)),
        ("NY bias only",                   dict(use_gap_bias=False, use_ny_bias=True,  use_night_bias=False, min_score=1)),
        ("Overnight bias only",            dict(use_gap_bias=False, use_ny_bias=False, use_night_bias=True,  min_score=1)),
        ("Gap + NY (no overnight)",        dict(use_gap_bias=True,  use_ny_bias=True,  use_night_bias=False)),
        ("Gap + overnight (no NY)",        dict(use_gap_bias=True,  use_ny_bias=False, use_night_bias=True)),
        ("NY + overnight (no gap)",        dict(use_gap_bias=False, use_ny_bias=True,  use_night_bias=True,  min_score=2)),
        ("All OFF (random entry)",         dict(use_gap_bias=False, use_ny_bias=False, use_night_bias=False, min_score=0)),
    ]

    print(f"\n  {'Config':<35}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}  verdict")
    print(f"  {'─'*35}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")

    base_pf = None
    for lbl, kw in configs:
        kw_full = {**dict(min_score=BASE_MIN_SCORE), **kw}
        df_s = collect_signals(df_by_tf, **kw_full)
        if len(df_s) < 5:
            print(f"  {lbl:<35}  <5 signals")
            continue
        w   = df_s['win'].values.astype(bool)
        pf  = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / years_total
        if base_pf is None:
            base_pf = pf
            verdict = '← baseline'
        else:
            verdict = f'Δ{pf - base_pf:+.3f}'
        print(f"  {lbl:<35}  {len(df_s):>4}  {tyr:>9.1f}  {w.mean()*100:>6.1f}  {pf:>7.3f}  {verdict}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — CONFLUENCE QUALITY
# ═══════════════════════════════════════════════════════════════════════════════

def section5_confluence(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 5 — CONFLUENCE QUALITY")
    print("  3/3: gap + NY + overnight all point same direction")
    print("  2/3: two of three agree")
    print("═" * 70)

    def show(sub, lbl):
        if len(sub) < 4:
            return
        w   = sub['win'].values.astype(bool)
        pf  = pf_of(w, sub['tp_dist'].values, sub['sl_dist'].values)
        tyr = len(sub) / years_total
        print(f"  {lbl:<45}  {fmt_row(len(sub), tyr, w.mean()*100, pf)}")

    show(df_sig, "All signals")
    for c in sorted(df_sig['confluence'].unique(), reverse=True):
        show(df_sig[df_sig['confluence'] == c], f"  {c}/3 confluent")

    print(f"\n  LONG vs SHORT:")
    show(df_sig[df_sig['direction'] == 'LONG'],  "  LONG")
    show(df_sig[df_sig['direction'] == 'SHORT'], "  SHORT")

    # High-confluence LONG and SHORT
    hc = df_sig[df_sig['confluence'] == 3]
    if len(hc) >= 5:
        print(f"\n  3/3 confluence by direction:")
        show(hc[hc['direction'] == 'LONG'],  "    3/3 LONG")
        show(hc[hc['direction'] == 'SHORT'], "    3/3 SHORT")

    print(f"\n  Gap net magnitude:")
    if 'gap_net' in df_sig.columns:
        df_sig['gap_mag'] = df_sig['gap_net'].abs()
        for q in [4, 8, 12, 20]:
            sub = df_sig[df_sig['gap_mag'] >= q]
            show(sub, f"  |gap_net| ≥ {q}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — PARAMETER GRID
# ═══════════════════════════════════════════════════════════════════════════════

def section6_grid(df_by_tf, years_total):
    print("\n" + "═" * 70)
    print("SECTION 6 — PARAMETER GRID  (min_score × TP × lookback_days)")
    print("═" * 70)

    score_vals    = [2, 3, 5]
    tp_vals       = [1.5, 2.0, 2.5, 3.0]
    lookback_vals = [2, 3, 4]

    combos  = list(itertools.product(score_vals, tp_vals, lookback_vals))
    results = []
    print(f"\n  Testing {len(combos)} combinations ...")

    for ms, tp, lb in combos:
        df_s = collect_signals(df_by_tf, min_score=ms, tp_mult=tp, lookback_days=lb)
        if len(df_s) < 8:
            continue
        w  = df_s['win'].values.astype(bool)
        pf = pf_of(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        results.append({'ms': ms, 'tp': tp, 'lb': lb,
                        'n': len(df_s), 'tyr': len(df_s)/years_total,
                        'wr': w.mean()*100, 'pf': pf})

    if not results:
        print("  No combinations with ≥8 signals.")
        return

    df_grid = pd.DataFrame(results).sort_values('pf', ascending=False)

    print(f"\n  Top 15 by PF (min 8 signals):")
    print(f"  {'Score':>5}  {'TP':>5}  {'LB':>3}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'─'*5}  {'─'*5}  {'─'*3}  {'─'*4}  {'─'*9}  {'─'*6}  {'─'*7}")
    for _, r in df_grid.head(15).iterrows():
        bl = '  ← baseline' if (r['ms'] == BASE_MIN_SCORE and r['tp'] == BASE_TP and r['lb'] == FVG_LOOKBACK_DAYS) else ''
        print(f"  {r['ms']:>5.0f}  {r['tp']:>5.1f}  {r['lb']:>3.0f}  "
              f"{r['n']:>4}  {r['tyr']:>9.1f}  {r['wr']:>6.1f}  {r['pf']:>7.3f}{bl}")

    df_grid['score'] = df_grid['pf'] * (df_grid['tyr'] / 30.0)
    best = df_grid.sort_values('score', ascending=False).iloc[0]
    print(f"\n  Best by score (PF×vol): min_score={best['ms']:.0f}  TP={best['tp']:.1f}×"
          f"  LB={best['lb']:.0f}d  WR={best['wr']:.1f}%  PF={best['pf']:.3f}  ({best['tyr']:.0f}/yr)")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — YEAR-BY-YEAR STABILITY
# ═══════════════════════════════════════════════════════════════════════════════

def section7_year_by_year(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 7 — YEAR-BY-YEAR STABILITY")
    print("═" * 70)

    df_sig = df_sig.copy()
    df_sig['year'] = pd.to_datetime(df_sig['date']).dt.year

    print(f"\n  {'Year':>6}  {'N':>4}  {'WR%':>6}  {'PF':>7}  bar")
    print(f"  {'─'*6}  {'─'*4}  {'─'*6}  {'─'*7}")
    for yr, grp in df_sig.groupby('year'):
        w   = grp['win'].values.astype(bool)
        pf  = pf_of(w, grp['tp_dist'].values, grp['sl_dist'].values)
        wr  = w.mean() * 100
        bw  = int(pf * 8)
        bar = '█' * min(bw, 40)
        trend = '★' if pf >= 2.0 else ('✓' if pf >= 1.3 else '✗')
        print(f"  {yr:>6}  {len(grp):>4}  {wr:>6.1f}  {pf:>7.3f}  {trend}  {bar}")

    # 3/3 confluence year-by-year
    hc = df_sig[df_sig['confluence'] == 3]
    if len(hc) >= 5:
        print(f"\n  3/3 confluence year-by-year:")
        for yr, grp in hc.groupby('year'):
            w  = grp['win'].values.astype(bool)
            pf = pf_of(w, grp['tp_dist'].values, grp['sl_dist'].values)
            print(f"  {yr:>6}  N={len(grp):>3}  WR={w.mean()*100:>5.1f}%  PF={pf:.3f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — DAY-OF-WEEK + SCORE MAGNITUDE BREAKDOWN
# ═══════════════════════════════════════════════════════════════════════════════

def section8_dow_and_score(df_sig, years_total):
    print("\n" + "═" * 70)
    print("SECTION 8 — DAY-OF-WEEK + SCORE MAGNITUDE")
    print("═" * 70)

    def show(sub, lbl):
        if len(sub) < 4:
            return
        w   = sub['win'].values.astype(bool)
        pf  = pf_of(w, sub['tp_dist'].values, sub['sl_dist'].values)
        tyr = len(sub) / years_total
        print(f"  {lbl:<40}  {fmt_row(len(sub), tyr, w.mean()*100, pf)}")

    print(f"\n  Day-of-week:")
    for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
        show(df_sig[df_sig['dow'] == dow], f"  {dow}")

    print(f"\n  Score magnitude:")
    for s_min in [3, 5, 7, 9, 12]:
        show(df_sig[df_sig['total_score'].abs() >= s_min], f"  |score| ≥ {s_min}")

    print(f"\n  Gap net magnitude:")
    for g_min in [2, 4, 6, 8, 12]:
        sub = df_sig[df_sig['gap_net'].abs() >= g_min]
        show(sub, f"  |gap_net| ≥ {g_min}")


# ═══════════════════════════════════════════════════════════════════════════════
# DATA LOADER
# ═══════════════════════════════════════════════════════════════════════════════

def load_all_tfs() -> dict:
    fname_map = {
        '5m':  'dax_5m_raw.csv',
        '15m': 'dax_15m_raw.csv',
        '30m': 'dax_30m_raw.csv',
        '1h':  'dax_1h_raw.csv',
    }
    loaded = {}
    for tf, fname in fname_map.items():
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
        loaded[tf] = df
        print(f"  Loaded {tf:3s}: {len(df):>7,} bars  "
              f"{df.index[0].date()} → {df.index[-1].date()}")
    return loaded


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print("DAX London Open Gap Distribution Miner")
    print("=" * 70)
    print()
    print("  Signal logic (evaluated before 07:00 UTC each day):")
    print("  ① Multi-TF unfilled FVGs → bear gaps above price = LONG pull")
    print("                              bull gaps below price = SHORT pull")
    print("  ② Prev day NY (13:30-17:30 UTC) bias: bullish/bearish")
    print("  ③ Overnight (17:30 UTC → 07:00 UTC) bias: bullish/bearish")
    print("  Entry: London open (07:00 UTC) | SL: overnight H/L | Hard close: 13:00 UTC")
    print()

    print("Loading data ...")
    df_by_tf = load_all_tfs()
    if not df_by_tf:
        print("ERROR: No data files found. Run:  python download_metaapi_dax.py")
        return

    # Use longest available TF for date range
    base_tf = max(df_by_tf.keys(), key=lambda k: len(df_by_tf[k]))
    df_base = df_by_tf[base_tf]
    years_total = (df_base.index[-1] - df_base.index[0]).days / 365.25
    print(f"\n  Base TF: {base_tf}  ({years_total:.2f}yr)")
    print()

    df_sig = section1_baseline(df_by_tf, years_total)
    if df_sig.empty:
        print("\nNo signals. Check that overnight bars exist (17:30 UTC prev day to 07:00 UTC).")
        return

    section2_score_sweep(df_by_tf, years_total)
    section3_gap_tp(df_by_tf, years_total)
    section4_ablation(df_by_tf, years_total)
    section5_confluence(df_sig, years_total)
    section6_grid(df_by_tf, years_total)
    section7_year_by_year(df_sig, years_total)
    section8_dow_and_score(df_sig, years_total)

    print("\n" + "═" * 70)
    print("DONE")
    print("  Key metrics to check: Section 5 (3/3 confluence) + Section 6 grid")
    print("  Compare with NAS100: LONG only WR 59.72% / PF 2.507 / 72/yr")
    print("═" * 70)


if __name__ == '__main__':
    main()
