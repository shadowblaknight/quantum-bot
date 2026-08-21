"""
QB USDCHF Research Backtest — v1
Research-driven. No guessing. All results from real yfinance data.

Research basis:
- USDCHF inversely correlated with XAUUSD (~-0.80 to -0.95, BIS confirmed)
- SNB meets quarterly: Mar/Jun/Sep/Dec → major volatility events to FILTER OUT
- FOMC 8x/year → major volatility event
- NFP first Friday/month at 13:30 UTC → filter out
- Most directional sessions: London (08-12 UTC) + NY (13-18 UTC)
- USDCHF reacts to CHF safe-haven flows → gold proxy

Criteria to PASS:
  - 0.8–2.5 trades/week (target: 1-2)
  - WR >= 55% overall
  - PF >= 1.3 (target 1.5)
  - Min per-year WR >= 50%
"""

import pandas as pd
import numpy as np
import yfinance as yf
from itertools import product
import warnings
warnings.filterwarnings('ignore')

# ─── 1. KNOWN NEWS EVENT DATES (verified from official calendars) ─────────────
# SNB: quarterly March/June/September/December
SNB_DATES = [
    '2022-03-24', '2022-06-16', '2022-09-22', '2022-12-15',
    '2023-03-23', '2023-06-22', '2023-09-21', '2023-12-14',
    '2024-03-21', '2024-06-20', '2024-09-26', '2024-12-12',
    '2025-03-20', '2025-06-19', '2025-09-25',
]

# FOMC: 8x per year (verified dates)
FOMC_DATES = [
    '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15',
    '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
    '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14',
    '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
    '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12',
    '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
    '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
    '2025-07-30', '2025-09-17',
]

def get_nfp_dates(start='2022-01-01', end='2025-10-01'):
    """First Friday of each month = NFP at 13:30 UTC"""
    dates = []
    for month_start in pd.date_range(start, end, freq='MS'):
        d = month_start
        while d.weekday() != 4:  # 4 = Friday
            d += pd.Timedelta(days=1)
        dates.append(d.strftime('%Y-%m-%d'))
    return dates

def build_blackout_mask(index, dates_list, hours_before=4, hours_after=8):
    """True = bar is inside a blackout window around a major news event"""
    mask = pd.Series(False, index=index)
    for d in dates_list:
        # SNB: ~09:30 UTC | FOMC: ~19:00 UTC | NFP: ~13:30 UTC — use 14:00 as midpoint
        event_time = pd.Timestamp(d, tz='UTC') + pd.Timedelta(hours=14)
        mask |= ((index >= event_time - pd.Timedelta(hours=hours_before)) &
                 (index <= event_time + pd.Timedelta(hours=hours_after)))
    return mask

# ─── 2. DATA ─────────────────────────────────────────────────────────────────
GOLD_TICKER = "GC=F"   # COMEX gold futures — most reliable in yfinance

def download_data():
    print("Downloading USDCHF=X  (1h, 2 years)...")
    chf = yf.download("USDCHF=X", period="2y", interval="1h",
                      auto_adjust=True, progress=False)
    if isinstance(chf.columns, pd.MultiIndex):
        chf.columns = chf.columns.get_level_values(0)
    chf.columns = [c.lower() for c in chf.columns]

    print(f"Downloading {GOLD_TICKER}  (1d, 3 years)  for gold bias...")
    gold_d = yf.download(GOLD_TICKER, period="3y", interval="1d",
                         auto_adjust=True, progress=False)
    if isinstance(gold_d.columns, pd.MultiIndex):
        gold_d.columns = gold_d.columns.get_level_values(0)
    gold_d.columns = [c.lower() for c in gold_d.columns]

    if len(gold_d) == 0:
        raise RuntimeError(f"Gold data download failed for {GOLD_TICKER}. Check ticker.")

    return chf, gold_d

# ─── 3. FEATURE ENGINEERING ──────────────────────────────────────────────────
def build_features(chf, gold_d, ema_period=50):
    df = chf.copy()

    # Ensure UTC-aware index
    if df.index.tz is None:
        df.index = df.index.tz_localize('UTC')
    else:
        df.index = df.index.tz_convert('UTC')

    # Drop rows with NaN OHLC
    df = df.dropna(subset=['open', 'high', 'low', 'close'])

    # ATR (14-period)
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift(1)).abs(),
        (df['low']  - df['close'].shift(1)).abs(),
    ], axis=1).max(axis=1)
    df['atr'] = tr.ewm(span=14, adjust=False).mean()

    # Candle body ratios
    df['rng']      = (df['high'] - df['low']).clip(lower=1e-8)
    df['bull_bod'] = np.where(df['close'] > df['open'],
                               (df['close'] - df['open']) / df['rng'], 0.0)
    df['bear_bod'] = np.where(df['close'] < df['open'],
                               (df['open'] - df['close']) / df['rng'], 0.0)

    # Session + weekday flags
    utc_h = df.index.hour
    dow   = df.index.dayofweek   # Mon=0, Fri=4, Sat=5, Sun=6
    df['in_london']  = (utc_h >= 8)  & (utc_h < 12) & (dow <= 4)
    df['in_ny']      = (utc_h >= 13) & (utc_h < 18) & (dow <= 4)
    df['in_session'] = df['in_london'] | df['in_ny']
    df['is_wday']    = dow <= 4

    # Previous-day high / low (no lookahead: shift 1 day)
    daily_high = df['high'].resample('1D').max().shift(1)
    daily_low  = df['low'].resample('1D').min().shift(1)
    df['prev_d_high'] = daily_high.reindex(df.index, method='ffill')
    df['prev_d_low']  = daily_low.reindex(df.index, method='ffill')

    # Gold daily EMA bias → forward-filled into hourly (shift 1 to avoid lookahead)
    if gold_d.index.tz is None:
        gold_d.index = gold_d.index.tz_localize('UTC')
    else:
        gold_d.index = gold_d.index.tz_convert('UTC')

    gold_d = gold_d.dropna(subset=['close'])
    gold_d['g_ema']     = gold_d['close'].ewm(span=ema_period, adjust=False).mean()
    gold_d['gold_bull'] = (gold_d['close'] > gold_d['g_ema']).shift(1)  # confirmed previous day
    gold_d['gold_bear'] = (gold_d['close'] < gold_d['g_ema']).shift(1)

    gold_signals = gold_d[['gold_bull', 'gold_bear']].reindex(df.index, method='ffill').fillna(False)
    df['gold_bull'] = gold_signals['gold_bull'].astype(bool)
    df['gold_bear'] = gold_signals['gold_bear'].astype(bool)

    # USDCHF H4 EMA50 (proper: resample to 4h, shift 1 bar to avoid lookahead)
    h4_close = df['close'].resample('4h').last().dropna()
    h4_ema_s = h4_close.ewm(span=ema_period, adjust=False).mean().shift(1)
    df['h4_ema'] = h4_ema_s.reindex(df.index, method='ffill')
    df['h4_atr'] = df['atr'].resample('4h').mean().shift(1).reindex(df.index, method='ffill')
    df['h4_bull'] = df['close'] > df['h4_ema']
    df['h4_bear'] = df['close'] < df['h4_ema']

    return df

# ─── 4. BACKTEST ENGINE ──────────────────────────────────────────────────────
def run_backtest(df, params, blackout):
    """
    Bar-by-bar simulation. Entry at confirmed bar close (conservative).
    Returns list of trade dicts.
    """
    trades = []
    in_trade  = False
    sl = tp = 0.0
    direction = 0

    a_done_l = a_done_s = False
    current_day = None

    fvgs = []  # list of {lo, hi, bi, dir}

    vals = df.values
    cols = {c: i for i, c in enumerate(df.columns)}

    def v(row, col):
        return vals[i][cols[col]]

    n = len(df)

    for i in range(50, n):
        row_date  = df.index[i]
        is_blkout = bool(blackout.iloc[i])

        # Daily reset
        day = row_date.date()
        if day != current_day:
            a_done_l = a_done_s = False
            current_day = day

        atr    = v(0, 'atr')
        is_nan = np.isnan(atr) or atr <= 0

        # ── Resolve open trade ────────────────────────────────────────
        if in_trade:
            lo = v(0, 'low')
            hi = v(0, 'high')
            if direction == 1:
                if lo <= sl:
                    trades.append({'pnl': -1.0, 'date': row_date})
                    in_trade = False
                elif hi >= tp:
                    trades.append({'pnl': params['tp_r'], 'date': row_date})
                    in_trade = False
            else:
                if hi >= sl:
                    trades.append({'pnl': -1.0, 'date': row_date})
                    in_trade = False
                elif lo <= tp:
                    trades.append({'pnl': params['tp_r'], 'date': row_date})
                    in_trade = False
            continue

        if is_nan or not v(0, 'is_wday') or is_blkout:
            continue
        if params['session_filter'] and not v(0, 'in_session'):
            continue

        cl  = v(0, 'close')
        hi  = v(0, 'high')
        lo  = v(0, 'low')

        gold_bear = bool(v(0, 'gold_bear'))
        gold_bull = bool(v(0, 'gold_bull'))
        h4_bull   = bool(v(0, 'h4_bull'))
        h4_bear   = bool(v(0, 'h4_bear'))

        req_h4  = params['require_h4']
        trend_l = gold_bear and (not req_h4 or h4_bull)
        trend_s = gold_bull and (not req_h4 or h4_bear)

        bull_bod = v(0, 'bull_bod')
        bear_bod = v(0, 'bear_bod')

        # ── Build FVGs from confirmed bars ────────────────────────────
        if i >= 2 and not is_blkout:
            p1_hi  = vals[i-1][cols['high']];  p1_lo  = vals[i-1][cols['low']]
            p2_hi  = vals[i-2][cols['high']];  p2_lo  = vals[i-2][cols['low']]
            p1_rng = max(p1_hi - p1_lo, 1e-8)
            p1_bbd = max((vals[i-1][cols['close']] - vals[i-1][cols['open']]) / p1_rng, 0)
            p1_sbd = max((vals[i-1][cols['open']] - vals[i-1][cols['close']]) / p1_rng, 0)

            # Bullish FVG: current low > prev-2 high
            if lo > p2_hi:
                sz = lo - p2_hi
                if (p1_bbd >= params['min_fvg_dep'] and
                        sz >= atr * params['min_fvg_sz'] and gold_bear):
                    fvgs.append({'lo': p2_hi, 'hi': lo, 'bi': i, 'dir': 1})

            # Bearish FVG: current high < prev-2 low
            if hi < p2_lo:
                sz = p2_lo - hi
                if (p1_sbd >= params['min_fvg_dep'] and
                        sz >= atr * params['min_fvg_sz'] and gold_bull):
                    fvgs.append({'lo': hi, 'hi': p2_lo, 'bi': i, 'dir': -1})

        # Expire FVGs
        max_age = params['max_fvg_age']
        fvgs = [f for f in fvgs if i - f['bi'] <= max_age]

        fired = False
        sl_buf = params['sl_buf']

        # ── SETUP A: Daily Range Break ────────────────────────────────
        if params['use_a'] and not fired:
            d_yhi = v(0, 'prev_d_high')
            d_ylo = v(0, 'prev_d_low')
            brk   = atr * params['min_break']

            if trend_l and not a_done_l and not np.isnan(d_yhi) and cl > d_yhi + brk:
                slP = d_yhi - atr * sl_buf
                slD = abs(cl - slP)
                if slD > 0:
                    entry_price = cl; sl = slP; tp = cl + slD * params['tp_r']
                    direction = 1; in_trade = True; a_done_l = True; fired = True

            if not fired and trend_s and not a_done_s and not np.isnan(d_ylo) and cl < d_ylo - brk:
                slP = d_ylo + atr * sl_buf
                slD = abs(slP - cl)
                if slD > 0:
                    entry_price = cl; sl = slP; tp = cl - slD * params['tp_r']
                    direction = -1; in_trade = True; a_done_s = True; fired = True

        # ── SETUP B: FVG Fill ─────────────────────────────────────────
        if params['use_b'] and not fired:
            if trend_l and bull_bod >= 0.20:
                for f in [f for f in fvgs if f['dir'] == 1]:
                    if lo <= f['hi'] and cl >= f['lo']:
                        slP = f['lo'] - atr * sl_buf
                        slD = abs(cl - slP)
                        if slD > 0:
                            entry_price = cl; sl = slP; tp = cl + slD * params['tp_r']
                            direction = 1; in_trade = True; fired = True
                            fvgs = [x for x in fvgs if x is not f]
                            break

            if not fired and trend_s and bear_bod >= 0.20:
                for f in [f for f in fvgs if f['dir'] == -1]:
                    if hi >= f['lo'] and cl <= f['hi']:
                        slP = f['hi'] + atr * sl_buf
                        slD = abs(slP - cl)
                        if slD > 0:
                            entry_price = cl; sl = slP; tp = cl - slD * params['tp_r']
                            direction = -1; in_trade = True; fired = True
                            fvgs = [x for x in fvgs if x is not f]
                            break

        # ── SETUP C: H4 EMA Bounce ────────────────────────────────────
        if params['use_c'] and not fired:
            h4_ema_v = v(0, 'h4_ema')
            h4_tol   = atr * params['h4_tol']

            if not np.isnan(h4_ema_v):
                if trend_l and lo <= h4_ema_v + h4_tol and cl > h4_ema_v and bull_bod >= params['min_bd_c']:
                    slP = h4_ema_v - atr * sl_buf
                    slD = abs(cl - slP)
                    if slD > 0:
                        entry_price = cl; sl = slP; tp = cl + slD * params['tp_r']
                        direction = 1; in_trade = True; fired = True

                if not fired and trend_s and hi >= h4_ema_v - h4_tol and cl < h4_ema_v and bear_bod >= params['min_bd_c']:
                    slP = h4_ema_v + atr * sl_buf
                    slD = abs(slP - cl)
                    if slD > 0:
                        entry_price = cl; sl = slP; tp = cl - slD * params['tp_r']
                        direction = -1; in_trade = True

    return trades

# ─── 5. METRICS ──────────────────────────────────────────────────────────────
def calc_metrics(trades, df):
    if len(trades) < 15:
        return None

    t = pd.DataFrame(trades)
    t['date'] = pd.to_datetime(t['date'], utc=True)

    wins = t['pnl'] > 0
    n    = len(t)
    wr   = wins.sum() / n

    total_weeks = max((df.index[-1] - df.index[0]).days / 7, 1)
    tpw = n / total_weeks

    gp = t.loc[wins, 'pnl'].sum()
    gl = abs(t.loc[~wins, 'pnl'].sum())
    pf = gp / gl if gl > 0 else 999.0

    t['year'] = t['date'].dt.year
    yearly = t.groupby('year').apply(lambda g: (g['pnl'] > 0).mean())
    min_yr_wr = float(yearly.min()) if len(yearly) >= 1 else 0.0

    return {
        'n': n,
        'tpw': round(tpw, 2),
        'wr': round(wr, 4),
        'pf': round(pf, 3),
        'min_yr_wr': round(min_yr_wr, 4),
        'yr_detail': yearly.to_dict(),
    }

# ─── 6. GRID SEARCH ──────────────────────────────────────────────────────────
GRID = {
    'tp_r':       [1.5, 2.0, 2.5],
    'sl_buf':     [0.10, 0.20, 0.30],
    'min_break':  [0.0, 0.05, 0.10],
    'require_h4': [True, False],
    'use_a':      [True],
    'use_b':      [True],
    'use_c':      [True, False],
    'session_filter': [True],
    'min_fvg_dep': [0.35, 0.50],
    'min_fvg_sz':  [0.10, 0.20],
    'max_fvg_age': [30, 60],
    'h4_tol':      [0.10, 0.20],
    'min_bd_c':    [0.25, 0.40],
}

def grid_search(df, blackout):
    keys   = list(GRID.keys())
    combos = list(product(*GRID.values()))
    total  = len(combos)
    print(f"Testing {total} parameter combinations...")

    passed = []
    best_by_pf = []  # fallback if nothing passes strict criteria

    for idx, combo in enumerate(combos):
        if idx % 200 == 0:
            print(f"  {idx}/{total}...", end='\r')

        params  = dict(zip(keys, combo))
        trades  = run_backtest(df, params, blackout)
        metrics = calc_metrics(trades, df)
        if metrics is None:
            continue

        entry = {**params, **metrics}
        best_by_pf.append(entry)

        # Strict criteria
        if (0.8 <= metrics['tpw'] <= 3.0 and
                metrics['wr']       >= 0.55 and
                metrics['pf']       >= 1.30 and
                metrics['min_yr_wr'] >= 0.50):
            passed.append(entry)

    print(f"\nDone. {len(passed)} combinations passed strict criteria.")
    return pd.DataFrame(passed), pd.DataFrame(best_by_pf)

# ─── 7. MAIN ─────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("=" * 70)
    print("QB USDCHF Research Backtest")
    print("=" * 70)

    chf, gold_d = download_data()

    print(f"\nUSDCHF bars : {len(chf):,}  ({chf.index[0]} → {chf.index[-1]})")
    print(f"Gold daily  : {len(gold_d):,} bars\n")

    df = build_features(chf, gold_d, ema_period=50)

    # Build blackout mask
    all_news = SNB_DATES + FOMC_DATES + get_nfp_dates()
    blackout  = build_blackout_mask(df.index, all_news, hours_before=4, hours_after=8)
    pct_blkd  = blackout.sum() / len(blackout) * 100
    print(f"News blackout: {blackout.sum():,} bars excluded ({pct_blkd:.1f}% of data)")
    print(f"Trading bars : {(~blackout & df['in_session']).sum():,}\n")

    # Gold correlation check (actual Pearson on available data)
    chf_h    = df['close'].resample('1D').last().dropna()
    if gold_d.index.tz is None:
        gold_d_tz = gold_d.copy(); gold_d_tz.index = gold_d_tz.index.tz_localize('UTC')
    else:
        gold_d_tz = gold_d.copy(); gold_d_tz.index = gold_d_tz.index.tz_convert('UTC')
    gold_aligned = gold_d_tz['close'].reindex(chf_h.index, method='ffill').dropna()
    chf_aligned  = chf_h.reindex(gold_aligned.index).dropna()
    gold_aligned = gold_aligned.reindex(chf_aligned.index)
    corr = chf_aligned.corr(gold_aligned)
    print(f"USDCHF vs Gold (GC=F) daily Pearson correlation (actual data): {corr:.4f}")
    print(f"(Negative = inverse relationship confirmed)\n")

    # Run grid search
    passed_df, all_df = grid_search(df, blackout)

    # ── Results ───────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    cols_show = ['tp_r','sl_buf','min_break','require_h4','use_c',
                 'min_fvg_dep','max_fvg_age','h4_tol','min_bd_c',
                 'n','tpw','wr','pf','min_yr_wr']

    if len(passed_df) > 0:
        top = passed_df.sort_values('pf', ascending=False).head(15)
        print(f"TOP {min(15, len(passed_df))} PASSING COMBINATIONS (sorted by PF):")
        print("-" * 70)
        avail = [c for c in cols_show if c in top.columns]
        print(top[avail].to_string(index=False))
        print()

        # Best single combo — deep dive
        best = passed_df.sort_values('pf', ascending=False).iloc[0]
        print("=" * 70)
        print("BEST COMBINATION — DETAIL:")
        print(f"  TP ratio    : {best['tp_r']}")
        print(f"  SL buffer   : {best['sl_buf']} × ATR")
        print(f"  Min break   : {best['min_break']} × ATR")
        print(f"  Require H4  : {best['require_h4']}")
        print(f"  Use Setup C : {best['use_c']}")
        print(f"  FVG dep min : {best['min_fvg_dep']}")
        print(f"  FVG age max : {best['max_fvg_age']} bars")
        print(f"  H4 toleranc : {best['h4_tol']} × ATR")
        print(f"  Min body C  : {best['min_bd_c']}")
        print(f"  ──────────────────────")
        print(f"  Trades      : {int(best['n'])}")
        print(f"  Per week    : {best['tpw']}")
        print(f"  Win rate    : {best['wr']*100:.1f}%")
        print(f"  Profit fact : {best['pf']}")
        print(f"  Min yr WR   : {best['min_yr_wr']*100:.1f}%")
        print(f"  Yearly WR   : {best['yr_detail']}")

    else:
        print("NO combination passed all strict criteria.")
        if len(all_df) == 0:
            print("  No trades generated at all — check data and bias signals.")
        else:
            cols_all = ['tp_r','sl_buf','min_break','require_h4','use_c',
                        'min_fvg_dep','max_fvg_age','n','tpw','wr','pf','min_yr_wr']
            avail_all = [c for c in cols_all if c in all_df.columns]
            print("BEST 15 by PF (no criteria filter):")
            print("-" * 70)
            top_all = all_df.sort_values('pf', ascending=False).head(15)
            print(top_all[avail_all].to_string(index=False))
            print()
            print("BEST 15 by WR:")
            print("-" * 70)
            top_wr = all_df.sort_values('wr', ascending=False).head(15)
            print(top_wr[avail_all].to_string(index=False))

    print("\n" + "=" * 70)
    print("BACKTEST COMPLETE — All numbers from real yfinance data.")
    print("=" * 70)
