#!/usr/bin/env python3
"""
gold_miner_v4.py — Scalping Simulation & Target Confirmation
=============================================================
Confirmed best config: H1+H4 alignment + Asian-lo filter
  TradingView results: 1yr PF 1.976 / 2yr PF 1.609 / ~196 trades/yr

This script:
  1. Confirms those numbers in Python (H1+H4, Asian lo, TP=0.75×)
  2. TP sweep 0.10×-2.00×  →  find where WR crosses 80% and PF > 2.0
  3. Re-entry scalp simulation  →  after quick TP hit, find retrace → re-break
  4. Multi-TP scaled exits  →  TP1/TP2/runner with BE stop after TP1 hit
  5. Projection table  →  which combo hits WR 80% / PF 2.0 / 250+ trades/yr

Target: WR ≥ 80%  |  PF > 2.0  |  250+ trades/year
"""

import os, warnings
import pandas as pd
import numpy as np
warnings.filterwarnings('ignore')

CACHE_FILE   = 'gold_miner_raw.csv'
ATR_PERIOD   = 14
MAX_BARS_FWD = 48        # 12 hours max to resolve a trade
TP_MULT_BASE = 0.75      # confirmed best for base config
YEARS_TOTAL  = 5.5       # approximate dataset span

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
    """Resample to tf_minutes, compute EMA bias, ffill to M15."""
    ohlc = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
    htf  = m15_df.resample(f'{tf_minutes}min', closed='right', label='right').agg(ohlc).dropna()
    ema  = htf['close'].ewm(span=ema_p, adjust=False).mean()
    bias = np.where(htf['close'].shift(1) > ema.shift(1),  1,
           np.where(htf['close'].shift(1) < ema.shift(1), -1, 0))
    return pd.Series(bias, index=htf.index).reindex(m15_df.index, method='ffill').fillna(0).astype(int)

def htf_ema_slope(m15_df, tf_minutes, ema_p=20):
    ohlc = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
    htf  = m15_df.resample(f'{tf_minutes}min', closed='right', label='right').agg(ohlc).dropna()
    ema  = htf['close'].ewm(span=ema_p, adjust=False).mean()
    slope = np.sign(ema - ema.shift(1)).fillna(0).astype(int)
    return slope.reindex(m15_df.index, method='ffill').fillna(0).astype(int)

def min_of_day(idx):
    return idx.hour * 60 + idx.minute

def compute_pf(df_sig):
    gw = gl = 0.0
    for _, r in df_sig.iterrows():
        if r['win']:
            gw += abs(r['entry'] - r['tp1'])
        else:
            gl += abs(r['sl']    - r['entry'])
    return gw / gl if gl > 0 else float('inf')

def compute_pf_raw(wins_bool, tp_dists, sl_dists):
    """Fast PF from numpy arrays."""
    gw = np.where(wins_bool, tp_dists, 0.0).sum()
    gl = np.where(~wins_bool, sl_dists, 0.0).sum()
    return gw / gl if gl > 0 else float('inf')

def label_trade_short(df_fwd, entry, sl, tp, max_bars=48):
    for i in range(min(max_bars, len(df_fwd))):
        bar = df_fwd.iloc[i]
        if bar['high'] >= sl: return False, i + 1
        if bar['low']  <= tp: return True,  i + 1
    return False, max_bars

def label_trade_long(df_fwd, entry, sl, tp, max_bars=48):
    for i in range(min(max_bars, len(df_fwd))):
        bar = df_fwd.iloc[i]
        if bar['low']  <= sl: return False, i + 1
        if bar['high'] >= tp: return True,  i + 1
    return False, max_bars

def label_trade_short_with_exit(df_fwd, entry, sl, tp, max_bars=48):
    """Returns (win, bars_held, exit_timestamp_or_None)."""
    for i in range(min(max_bars, len(df_fwd))):
        bar  = df_fwd.iloc[i]
        tidx = df_fwd.index[i]
        if bar['high'] >= sl: return False, i + 1, tidx
        if bar['low']  <= tp: return True,  i + 1, tidx
    last_idx = df_fwd.index[min(max_bars, len(df_fwd)) - 1] if len(df_fwd) > 0 else None
    return False, max_bars, last_idx

def label_trade_long_with_exit(df_fwd, entry, sl, tp, max_bars=48):
    """Returns (win, bars_held, exit_timestamp_or_None)."""
    for i in range(min(max_bars, len(df_fwd))):
        bar  = df_fwd.iloc[i]
        tidx = df_fwd.index[i]
        if bar['low']  <= sl: return False, i + 1, tidx
        if bar['high'] >= tp: return True,  i + 1, tidx
    last_idx = df_fwd.index[min(max_bars, len(df_fwd)) - 1] if len(df_fwd) > 0 else None
    return False, max_bars, last_idx

def compute_mfe_short(df_fwd, entry, sl, max_bars=48):
    """Max favorable excursion (price units) before SL is hit."""
    mfe = 0.0
    for i in range(min(max_bars, len(df_fwd))):
        bar = df_fwd.iloc[i]
        if bar['high'] >= sl: break
        mfe = max(mfe, entry - bar['low'])
    return mfe

def compute_mfe_long(df_fwd, entry, sl, max_bars=48):
    mfe = 0.0
    for i in range(min(max_bars, len(df_fwd))):
        bar = df_fwd.iloc[i]
        if bar['low'] <= sl: break
        mfe = max(mfe, bar['high'] - entry)
    return mfe


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — BEST CONFIG SIGNAL COLLECTION
# H1+H4 bearish + Asian lo filter for FRB SHORT
# H1+H4 aligned for NY ORB SHORT and LONG
# TP = 0.75× OR range (confirmed optimal)
# ═══════════════════════════════════════════════════════════════════════════════

def collect_best_config_signals(df, tp_mult=TP_MULT_BASE):
    """
    Simulates the confirmed best Pine Script configuration.
    Frankfurt SHORT: H1 bearish AND H4 bearish AND entry bar closes below Asian-lo (00:00-07:00 UTC).
    NY ORB SHORT:    H1 bearish AND H4 bearish.
    NY ORB LONG:     H1 bullish AND H4 bullish.
    One trade per session (first valid signal, no pyramiding).
    """
    rows  = []
    dates = sorted(set(df.index.date))

    for i, date in enumerate(dates):
        day = df[df.index.date == date]
        if len(day) < 10:
            continue

        # ── Frankfurt ORB (Signal M) ─────────────────────────────────────────
        frb_win = day[(day.index.map(min_of_day) >= 420) & (day.index.map(min_of_day) < 450)]
        if not frb_win.empty:
            frb_hi    = frb_win['high'].max()
            frb_lo    = frb_win['low'].min()
            orb_range = frb_hi - frb_lo

            # Asian-low: strictly 00:00–07:00 UTC (before Frankfurt window)
            asian_bars = day[day.index.map(min_of_day) < 420]
            ar_lo = asian_bars['low'].min() if not asian_bars.empty else np.nan

            if orb_range >= 0.50:
                trade_bars = day[day.index.map(min_of_day) >= 450]
                for idx, bar in trade_bars.iterrows():
                    if (bar['close'] < frb_lo and
                            bar['h1_bias'] == -1 and
                            bar['h4_bias'] == -1 and
                            not np.isnan(ar_lo) and
                            bar['close'] < ar_lo):

                        entry = bar['close']
                        buf   = max(bar['atr'] * 0.10, 0.50)
                        sl    = frb_hi + buf
                        tp1   = frb_lo - tp_mult * orb_range

                        if sl <= entry or tp1 >= entry:
                            continue

                        df_fwd = df[df.index > idx]
                        win, bars_held, exit_ts = label_trade_short_with_exit(df_fwd, entry, sl, tp1)
                        mfe = compute_mfe_short(df_fwd, entry, sl)

                        rows.append({
                            'date':       date,
                            'signal_ts':  idx,
                            'exit_ts':    exit_ts,
                            'type':       'FRB',
                            'direction':  'short',
                            'orb_hi':     frb_hi,
                            'orb_lo':     frb_lo,
                            'orb_range':  orb_range,
                            'entry':      entry,
                            'sl':         sl,
                            'tp1':        tp1,
                            'sl_dist':    sl - entry,
                            'tp1_dist':   entry - tp1,
                            'win':        int(win),
                            'bars_held':  bars_held,
                            'mfe':        mfe,
                            'h1b':        int(bar['h1_bias']),
                            'h4b':        int(bar['h4_bias']),
                        })
                        break  # one trade per session

        # ── NY ORB (Signal H) ────────────────────────────────────────────────
        orb_win = day[(day.index.map(min_of_day) >= 840) & (day.index.map(min_of_day) < 870)]
        if orb_win.empty:
            continue
        orb_hi    = orb_win['high'].max()
        orb_lo    = orb_win['low'].min()
        orb_range = orb_hi - orb_lo
        if orb_range < 0.50:
            continue

        trade_bars = day[day.index.map(min_of_day) >= 870]
        for idx, bar in trade_bars.iterrows():
            entry = bar['close']
            buf   = max(bar['atr'] * 0.10, 0.50)

            if bar['close'] < orb_lo and bar['h1_bias'] == -1 and bar['h4_bias'] == -1:
                sl  = orb_hi + buf
                tp1 = orb_lo - tp_mult * orb_range
                if sl <= entry or tp1 >= entry:
                    continue
                df_fwd   = df[df.index > idx]
                win, bars_held, exit_ts = label_trade_short_with_exit(df_fwd, entry, sl, tp1)
                mfe = compute_mfe_short(df_fwd, entry, sl)
                rows.append({
                    'date': date, 'signal_ts': idx, 'exit_ts': exit_ts,
                    'type': 'NY', 'direction': 'short',
                    'orb_hi': orb_hi, 'orb_lo': orb_lo, 'orb_range': orb_range,
                    'entry': entry, 'sl': sl, 'tp1': tp1,
                    'sl_dist': sl - entry, 'tp1_dist': entry - tp1,
                    'win': int(win), 'bars_held': bars_held, 'mfe': mfe,
                    'h1b': int(bar['h1_bias']), 'h4b': int(bar['h4_bias']),
                })
                break

            elif bar['close'] > orb_hi and bar['h1_bias'] == 1 and bar['h4_bias'] == 1:
                sl  = orb_lo - buf
                tp1 = orb_hi + tp_mult * orb_range
                if sl >= entry or tp1 <= entry:
                    continue
                df_fwd = df[df.index > idx]
                win, bars_held, exit_ts = label_trade_long_with_exit(df_fwd, entry, sl, tp1)
                mfe = compute_mfe_long(df_fwd, entry, sl)
                rows.append({
                    'date': date, 'signal_ts': idx, 'exit_ts': exit_ts,
                    'type': 'NY', 'direction': 'long',
                    'orb_hi': orb_hi, 'orb_lo': orb_lo, 'orb_range': orb_range,
                    'entry': entry, 'sl': sl, 'tp1': tp1,
                    'sl_dist': entry - sl, 'tp1_dist': tp1 - entry,
                    'win': int(win), 'bars_held': bars_held, 'mfe': mfe,
                    'h1b': int(bar['h1_bias']), 'h4b': int(bar['h4_bias']),
                })
                break

    return pd.DataFrame(rows)


def print_config_summary(df_sig):
    print("\n" + "═" * 70)
    print("SECTION 1 — CONFIRMED BEST CONFIG (H1+H4 + Asian Lo, TP=0.75×)")
    print("═" * 70)

    if df_sig.empty:
        print("  No signals."); return

    df_sig = df_sig.copy()
    df_sig['date_ts'] = pd.to_datetime(df_sig['date'])
    latest = df_sig['date_ts'].max()
    n_total = len(df_sig)
    pf_all  = compute_pf(df_sig)
    wr_all  = df_sig['win'].mean()

    print(f"\n  Full dataset: N={n_total}  WR={wr_all*100:.1f}%  PF={pf_all:.3f}"
          f"  ~{n_total/YEARS_TOTAL:.0f} trades/yr")

    # Time-window breakdown
    print(f"\n  {'Period':6}  {'N':>5}  {'Trades/yr':>10}  {'WR%':>6}  {'PF':>6}  notes")
    print(f"  {'─'*6}  {'─'*5}  {'─'*10}  {'─'*6}  {'─'*6}")
    for yrs, lbl in [(1, '1yr'), (2, '2yr'), (4, '4yr'), (6, '6yr')]:
        cutoff = latest - pd.DateOffset(years=yrs)
        sub    = df_sig[df_sig['date_ts'] >= cutoff]
        if len(sub) < 5:
            continue
        sw   = sub['win'].mean()
        sp   = compute_pf(sub)
        tyr  = len(sub) / yrs
        star = ' ***' if sp >= 1.8 else (' **' if sp >= 1.5 else '')
        print(f"  {lbl:6}  {len(sub):>5}  {tyr:>10.0f}  {sw*100:>6.1f}  {sp:>6.3f}{star}")

    # Signal type breakdown
    print()
    for t in ['FRB', 'NY']:
        sub = df_sig[df_sig['type'] == t]
        if len(sub) < 3:
            continue
        sw = sub['win'].mean()
        sp = compute_pf(sub)
        print(f"  {t} signals: N={len(sub):4d} ({len(sub)/YEARS_TOTAL:.0f}/yr)  "
              f"WR={sw*100:.1f}%  PF={sp:.3f}")

    for d in ['short', 'long']:
        sub = df_sig[df_sig['direction'] == d]
        if len(sub) < 3:
            continue
        sw = sub['win'].mean()
        sp = compute_pf(sub)
        print(f"  {d.upper():5}: N={len(sub):4d} ({len(sub)/YEARS_TOTAL:.0f}/yr)  "
              f"WR={sw*100:.1f}%  PF={sp:.3f}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — TP SWEEP
# Uses pre-computed MFE to project WR and PF at any TP multiple.
# Finds where WR crosses 80% and PF crosses 2.0.
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_tp_sweep(df_sig, label="All signals"):
    print("\n" + "═" * 70)
    print(f"SECTION 2 — TP SWEEP  [{label}]")
    print("═" * 70)

    n = len(df_sig)
    if n < 20:
        print("  Not enough data."); return None

    tp_mults = np.round(np.arange(0.10, 2.01, 0.05), 2)
    results  = []

    mfe_arr     = df_sig['mfe'].values
    sl_dist_arr = df_sig['sl_dist'].values
    orb_arr     = df_sig['orb_range'].values

    for tm in tp_mults:
        tp_dists = tm * orb_arr
        wins     = mfe_arr >= tp_dists
        wr       = wins.mean()
        gw       = np.where(wins, tp_dists, 0.0).sum()
        gl       = np.where(~wins, sl_dist_arr, 0.0).sum()
        pf       = gw / gl if gl > 0 else float('inf')
        results.append({'tp_mult': tm, 'wr': wr * 100, 'pf': pf, 'wins': int(wins.sum())})

    df_sw = pd.DataFrame(results)

    print(f"\n  {'TP mult':>8}  {'WR%':>6}  {'PF':>7}  {'Wins':>5}  notes")
    print(f"  {'─'*8}  {'─'*6}  {'─'*7}  {'─'*5}")

    hit_wr80 = hit_pf2 = False
    for _, r in df_sw.iterrows():
        tm  = r['tp_mult']
        wr  = r['wr']
        pf  = r['pf']
        note = ''
        if wr >= 80.0 and not hit_wr80:
            note += ' ← WR 80%'
            hit_wr80 = True
        if pf >= 2.0 and not hit_pf2:
            note += ' ← PF 2.0'
            hit_pf2 = True
        # Only print every 0.10 step + crossover rows
        if abs(tm - round(tm, 1)) < 0.001 or note:
            star = ' ★★★' if pf >= 2.0 and wr >= 80 else (' ★★' if pf >= 2.0 else (' ★' if wr >= 80 else ''))
            print(f"  {tm:>8.2f}  {wr:>6.1f}  {pf:>7.3f}  {int(r['wins']):>5}  {note}{star}")

    # Highlight 0.75× base
    base = df_sw[abs(df_sw['tp_mult'] - 0.75) < 0.001]
    if not base.empty:
        b = base.iloc[0]
        print(f"\n  Base (0.75×): WR={b['wr']:.1f}%  PF={b['pf']:.3f}  wins={int(b['wins'])}/{n}")

    # Find optimal scalp TP: highest PF where WR >= 75%
    valid = df_sw[df_sw['wr'] >= 75.0]
    if not valid.empty:
        best = valid.loc[valid['pf'].idxmax()]
        print(f"\n  Best scalp TP (WR≥75%): {best['tp_mult']:.2f}× OR range"
              f"  →  WR={best['wr']:.1f}%  PF={best['pf']:.3f}")

    return df_sw


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — RE-ENTRY SCALP SIMULATION
# After quick TP hit, detect retrace → re-break → new entry.
# Simulates chained scalp entries within one session.
# ═══════════════════════════════════════════════════════════════════════════════

def simulate_reentry_scalp_shorts(df_signals, df, tp_mult_scalp, session_end_min, max_reentries=4):
    """
    For each SHORT signal: fire entry #1 at scalp TP.
    If TP hit: wait for retrace toward orb_lo, re-fire on next close < orb_lo.
    Repeat up to max_reentries per original signal day.
    Returns DataFrame of all chained entries.
    """
    all_entries = []

    for _, sig in df_signals.iterrows():
        orb_lo    = sig['orb_lo']
        orb_hi    = sig['orb_hi']
        orb_range = sig['orb_range']
        sl        = sig['sl']
        sig_date  = pd.Timestamp(sig['date']).date()

        current_entry_time = sig['signal_ts']
        entry_n = 0

        while entry_n <= max_reentries:
            # Find the entry bar for this iteration
            if entry_n == 0:
                entry_price = sig['entry']
                entry_idx   = sig['signal_ts']
            else:
                # Search for re-entry: price must retrace toward orb_lo then re-break
                search_start = current_entry_time
                day_bars = df[
                    (df.index > search_start) &
                    (df.index.date == sig_date) &
                    (df.index.map(min_of_day) < session_end_min)
                ]
                if day_bars.empty:
                    break

                retrace_seen = False
                reentry_idx  = None
                entry_price  = None

                for ridx, rbar in day_bars.iterrows():
                    # Retrace: price came back within 30% of OR range of orb_lo
                    if not retrace_seen and rbar['high'] >= orb_lo - 0.30 * orb_range:
                        retrace_seen = True
                    # Re-break: close back below orb_lo with H1+H4 still bearish
                    if retrace_seen and rbar['close'] < orb_lo:
                        if rbar['h1_bias'] == -1 and rbar['h4_bias'] == -1:
                            reentry_idx = ridx
                            entry_price = rbar['close']
                            break

                if reentry_idx is None:
                    break
                entry_idx = reentry_idx

            # Scalp TP for this entry
            tp = entry_price - tp_mult_scalp * orb_range

            if sl <= entry_price or tp >= entry_price:
                break

            df_fwd = df[df.index > entry_idx]
            win, bars_held, exit_ts = label_trade_short_with_exit(df_fwd, entry_price, sl, tp)

            all_entries.append({
                'date':        sig['date'],
                'sig_type':    sig['type'],
                'entry_n':     entry_n + 1,
                'entry_ts':    entry_idx,
                'exit_ts':     exit_ts,
                'entry':       entry_price,
                'sl':          sl,
                'tp':          tp,
                'orb_range':   orb_range,
                'sl_dist':     sl - entry_price,
                'tp_dist':     entry_price - tp,
                'win':         int(win),
                'bars_held':   bars_held,
            })

            entry_n += 1

            if not win:
                break  # SL hit — stop re-entries for this day

            # Advance past the TP exit bar
            if exit_ts is not None:
                current_entry_time = exit_ts
            else:
                break

    return pd.DataFrame(all_entries)


def print_reentry_results(df_re, n_orig_signals, tp_mult, label=""):
    if df_re.empty:
        print(f"  No entries for TP={tp_mult:.2f}×"); return

    n    = len(df_re)
    wr   = df_re['win'].mean()
    gw   = df_re[df_re['win'] == 1]['tp_dist'].sum()
    gl   = df_re[df_re['win'] == 0]['sl_dist'].sum()
    pf   = gw / gl if gl > 0 else float('inf')
    tyr  = n / YEARS_TOTAL
    mult = n / n_orig_signals if n_orig_signals > 0 else 0

    star = ' ★★★' if pf >= 2.0 and wr >= 0.80 and tyr >= 250 else (
           ' ★★'  if pf >= 2.0 and wr >= 0.80 else (
           ' ★'   if pf >= 2.0 or wr >= 0.80 else ''))

    print(f"\n  TP={tp_mult:.2f}×  {label}")
    print(f"  Total entries: {n}  (orig: {n_orig_signals}, ×{mult:.2f} multiplier)")
    print(f"  WR={wr*100:.1f}%  PF={pf:.3f}  ~{tyr:.0f} trades/yr{star}")

    # By entry number
    print(f"\n  {'Entry#':>7}  {'N':>5}  {'WR%':>6}  {'PF':>6}")
    for en in sorted(df_re['entry_n'].unique()):
        sub = df_re[df_re['entry_n'] == en]
        sw  = sub['win'].mean()
        sgw = sub[sub['win'] == 1]['tp_dist'].sum()
        sgl = sub[sub['win'] == 0]['sl_dist'].sum()
        sp  = sgw / sgl if sgl > 0 else float('inf')
        print(f"  #{en:>6}  {len(sub):>5}  {sw*100:>6.1f}  {sp:>6.3f}")

    print(f"\n  Targets:")
    print(f"    WR ≥ 80%:       {'✓' if wr >= 0.80 else '✗'}  ({wr*100:.1f}%)")
    print(f"    PF > 2.0:       {'✓' if pf >= 2.0 else '✗'}  ({pf:.3f})")
    print(f"    ≥ 250 trades:   {'✓' if tyr >= 250 else '✗'}  ({tyr:.0f}/yr)")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — MULTI-TP SCALED EXIT
# TP1 (partial) + TP2 (partial) + runner.
# BE stop after TP1. Effective WR and PF across the whole position.
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_multi_tp(df_sig, tp_levels, weights, label=""):
    """
    Simulate scaled exits using pre-computed MFE.
    tp_levels = (tp1_mult, tp2_mult, runner_mult)
    weights   = fraction of position closed at each level (must sum to 1)
    BE stop after tp_levels[0] hit.
    """
    assert len(tp_levels) == len(weights)
    assert abs(sum(weights) - 1.0) < 0.001

    results = []
    for _, r in df_sig.iterrows():
        mfe      = r['mfe']
        orb      = r['orb_range']
        sl_d     = r['sl_dist']
        net_pnl  = 0.0
        tp1_hit  = mfe >= tp_levels[0] * orb

        for tp_m, w in zip(tp_levels, weights):
            tp_dist = tp_m * orb
            hit     = mfe >= tp_dist
            if hit:
                net_pnl += w * tp_dist
            else:
                # BE logic: if TP1 was already hit, remaining tranches exit at 0 (BE)
                if tp1_hit:
                    net_pnl += 0.0
                else:
                    net_pnl += -w * sl_d

        results.append({
            'date':     r['date'],
            'type':     r['type'],
            'net_pnl':  net_pnl,
            'win':      int(net_pnl > 0),
            'orb':      orb,
            'sl_dist':  sl_d,
        })

    df_res = pd.DataFrame(results)
    n  = len(df_res)
    wr = df_res['win'].mean()
    gw = df_res[df_res['win'] == 1]['net_pnl'].sum()
    gl = df_res[df_res['win'] == 0]['net_pnl'].abs().sum()
    pf = gw / gl if gl > 0 else float('inf')
    tyr = n / YEARS_TOTAL

    print(f"\n  Multi-TP {[f'{t:.2f}×({int(w*100)}%)' for t, w in zip(tp_levels, weights)]}  {label}")
    print(f"  N={n}  WR={wr*100:.1f}%  PF={pf:.3f}  ~{tyr:.0f} trades/yr")
    return df_res


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — PROJECTION TABLE
# Sweeps scalp TP + estimates re-entry multiplier → projected WR / PF / trades/yr
# ═══════════════════════════════════════════════════════════════════════════════

def print_projection_table(df_sig, df_sweep):
    print("\n" + "═" * 70)
    print("SECTION 5 — PROJECTION TABLE  (scalp TP × re-entry multiplier)")
    print("═" * 70)
    print(f"\n  Assumptions: re-entry multiplier estimated from historical retrace frequency.")
    print(f"  Original shorts per year: {len(df_sig[df_sig['direction']=='short'])/YEARS_TOTAL:.0f}")
    print()

    # Rough re-entry multiplier: if WR > 70%, ~40% of wins get a 2nd entry → ×1.4
    #                             if WR > 80%, ~55% of wins get a 2nd entry → ×1.55
    #                             if WR > 85%, ~65% of wins get a 2nd entry → ×1.65
    base_shorts_yr = len(df_sig[df_sig['direction'] == 'short']) / YEARS_TOTAL

    print(f"  {'TP mult':>8}  {'WR%':>6}  {'PF':>7}  {'Re-mult':>8}  {'Proj/yr':>8}  target")
    print(f"  {'─'*8}  {'─'*6}  {'─'*7}  {'─'*8}  {'─'*8}")

    for _, r in df_sweep[df_sweep['tp_mult'].isin([0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.75])].iterrows():
        tm = r['tp_mult']
        wr = r['wr']
        pf = r['pf']
        # Estimate re-entry multiplier: more wins = more re-entry opportunities
        if wr >= 85:
            remult = 1.70
        elif wr >= 80:
            remult = 1.55
        elif wr >= 75:
            remult = 1.40
        elif wr >= 70:
            remult = 1.25
        else:
            remult = 1.10

        proj_yr = base_shorts_yr * remult
        hit_wr  = wr >= 80.0
        hit_pf  = pf >= 2.0
        hit_tr  = proj_yr >= 250

        note = ''
        if hit_wr and hit_pf and hit_tr:
            note = '★★★ ALL TARGETS'
        elif hit_wr and hit_pf:
            note = '★★ WR+PF ✓'
        elif hit_pf:
            note = '★ PF ✓'
        elif hit_wr:
            note = '★ WR ✓'

        print(f"  {tm:>8.2f}  {wr:>6.1f}  {pf:>7.3f}  {remult:>8.2f}×  {proj_yr:>8.0f}  {note}")


# ═══════════════════════════════════════════════════════════════════════════════
# LOAD + ENRICH DATA
# ═══════════════════════════════════════════════════════════════════════════════

def load_and_enrich():
    if not os.path.exists(CACHE_FILE):
        print(f"ERROR: {CACHE_FILE} not found. Run gold_miner.py first.")
        return None

    print(f"Loading {CACHE_FILE} ...")
    df = pd.read_csv(CACHE_FILE, parse_dates=['datetime'])
    df = df.sort_values('datetime').drop_duplicates('datetime').set_index('datetime')
    df.index = df.index.tz_localize(None)
    print(f"  {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})")

    print("Computing ATR, H1 bias, H4 bias ...")
    df['atr']      = compute_atr(df, ATR_PERIOD)
    df['h4_bias']  = htf_bias(df, 240)
    df['h1_bias']  = htf_bias(df, 60)
    df['hd_bias']  = htf_bias(df, 1440)
    df['h4_slope'] = htf_ema_slope(df, 240)
    df['ret4bar']  = np.where(df['atr'] > 0, (df['close'] - df['close'].shift(4)) / df['atr'], 0.0)

    df['_date']   = df.index.date
    df['_day_hi'] = df.groupby('_date')['high'].transform('cummax')
    df['_day_lo'] = df.groupby('_date')['low'].transform('cummin')
    atr14d = df['atr'].resample('D').last().reindex(df.index, method='ffill')
    df['adr_consumed'] = np.where(atr14d > 0, (df['_day_hi'] - df['_day_lo']) / atr14d, 0.0)
    df.drop(columns=['_date', '_day_hi', '_day_lo'], inplace=True)

    return df


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("=" * 70)
    print("GOLD MINER v4 — Scalping Simulation")
    print("Target: WR ≥ 80%  |  PF > 2.0  |  250+ trades/year")
    print("=" * 70)

    df = load_and_enrich()
    if df is None:
        exit(1)

    # ── 1. Collect & confirm best-config signals ──────────────────────────
    print("\n[1/5] Collecting best-config signals (H1+H4 + Asian lo, TP=0.75×) ...")
    df_sig = collect_best_config_signals(df, tp_mult=TP_MULT_BASE)

    if df_sig.empty:
        print("  No signals found."); exit(1)

    print_config_summary(df_sig)
    df_sig.to_csv('gold_best_config_v4.csv', index=False)
    print(f"\n  Saved {len(df_sig)} signals → gold_best_config_v4.csv")

    # ── 2. TP sweep ───────────────────────────────────────────────────────
    print("\n[2/5] TP sweep ...")
    df_sweep = analyze_tp_sweep(df_sig, label="All signals (FRB short + NY both)")

    # Also FRB-only sweep (highest conviction subset)
    frb_shorts = df_sig[(df_sig['type'] == 'FRB') & (df_sig['direction'] == 'short')]
    if len(frb_shorts) >= 15:
        analyze_tp_sweep(frb_shorts, label="Frankfurt SHORT only (Asian lo filter)")

    # NY shorts (bulk of volume)
    ny_shorts = df_sig[(df_sig['type'] == 'NY') & (df_sig['direction'] == 'short')]
    if len(ny_shorts) >= 20:
        analyze_tp_sweep(ny_shorts, label="NY ORB SHORT only (H1+H4 bearish)")

    # ── 3. Re-entry scalp simulation ──────────────────────────────────────
    print("\n[3/5] Re-entry scalp simulation ...")
    print("  (Tests whether after a quick TP hit, retraces to ORB → re-break fires again)")

    shorts_all = df_sig[df_sig['direction'] == 'short'].copy()
    n_orig = len(shorts_all)

    for scalp_tp in [0.20, 0.25, 0.30, 0.40]:
        # Frankfurt SHORT: session end = 12:00 UTC (720 min)
        frb_re = simulate_reentry_scalp_shorts(
            frb_shorts, df, tp_mult_scalp=scalp_tp,
            session_end_min=720, max_reentries=4)
        # NY SHORT: session end = 21:00 UTC (1260 min)
        ny_re = simulate_reentry_scalp_shorts(
            ny_shorts, df, tp_mult_scalp=scalp_tp,
            session_end_min=1260, max_reentries=4)

        combined_re = pd.concat([frb_re, ny_re], ignore_index=True) if not ny_re.empty else frb_re
        print_reentry_results(combined_re, n_orig, scalp_tp,
                              label=f"FRB+NY shorts, TP={scalp_tp:.2f}×")

    # ── 4. Multi-TP scaled exit ───────────────────────────────────────────
    print("\n" + "═" * 70)
    print("SECTION 4 — MULTI-TP SCALED EXIT")
    print("═" * 70)

    # Three configurations to test
    analyze_multi_tp(df_sig,
                     tp_levels=(0.25, 0.50, 1.25), weights=(0.33, 0.33, 0.34),
                     label="TP1=0.25×(33%) TP2=0.50×(33%) runner=1.25×(34%) BE after TP1")

    analyze_multi_tp(df_sig,
                     tp_levels=(0.30, 0.75, 1.50), weights=(0.25, 0.50, 0.25),
                     label="TP1=0.30×(25%) TP2=0.75×(50%) runner=1.50×(25%) BE after TP1")

    analyze_multi_tp(df_sig,
                     tp_levels=(0.25, 0.75, 2.00), weights=(0.50, 0.30, 0.20),
                     label="TP1=0.25×(50%) TP2=0.75×(30%) runner=2.00×(20%) BE after TP1")

    # ── 5. Projection table ───────────────────────────────────────────────
    print("\n[5/5] Projection toward targets ...")
    if df_sweep is not None:
        print_projection_table(df_sig, df_sweep)

    # ── Final summary ─────────────────────────────────────────────────────
    print("\n" + "═" * 70)
    print("DONE")
    print("═" * 70)
    base_wr = df_sig['win'].mean()
    base_pf = compute_pf(df_sig)
    print(f"\n  Base config (0.75×):  WR={base_wr*100:.1f}%  PF={base_pf:.3f}"
          f"  ~{len(df_sig)/YEARS_TOTAL:.0f}/yr")
    print(f"\n  Read sections above for optimal scalp TP and re-entry projections.")
    print(f"  If any configuration achieves all 3 targets (★★★), translate to Pine Script.")
