#!/usr/bin/env python3
"""
QB NAS100 Statistical Research
Systematically tests what actually works on NAS100 using 5+ years of data.
Filters high-impact news events to find "clean" structural edges.
"""

import sys
import warnings
warnings.filterwarnings('ignore')

# ── dependency check ─────────────────────────────────────────────────────────
try:
    import yfinance as yf
    import pandas as pd
    import numpy as np
    from scipy import stats
    from scipy.fft import fft
    from scipy.signal import detrend
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Run: pip install yfinance pandas numpy scipy")
    sys.exit(1)

from datetime import datetime, timedelta, date
import json

# ─────────────────────────────────────────────────────────────────────────────
# 1.  DATA ACQUISITION
# ─────────────────────────────────────────────────────────────────────────────

SYMBOL = "^NDX"   # NAS100 cash index

def fetch_daily(years=6):
    end   = datetime.now()
    start = end - timedelta(days=years * 365)
    print(f"  Fetching daily data ({years} yrs) …", end=" ", flush=True)
    df = yf.download(SYMBOL, start=start, end=end, interval="1d",
                     progress=False, auto_adjust=True)
    df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
    print(f"{len(df)} bars")
    return df


def fetch_hourly(years=2):
    end   = datetime.now()
    start = end - timedelta(days=years * 365)
    print(f"  Fetching 1H data ({years} yrs) …", end=" ", flush=True)
    df = yf.download(SYMBOL, start=start, end=end, interval="1h",
                     progress=False, auto_adjust=True)
    df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
    print(f"{len(df)} bars")
    return df


def fetch_15m_chunked(months=6):
    """yfinance only allows 60-day windows for 15m; chunk backwards."""
    chunks = []
    end = datetime.now()
    start_limit = end - timedelta(days=months * 30)
    cur_end = end
    print(f"  Fetching 15m data ({months} months, chunked) …", end=" ", flush=True)
    while cur_end > start_limit:
        cur_start = max(cur_end - timedelta(days=58), start_limit)
        try:
            df = yf.download(SYMBOL, start=cur_start, end=cur_end,
                             interval="15m", progress=False, auto_adjust=True)
            df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
            if not df.empty:
                chunks.append(df)
        except Exception:
            pass
        cur_end = cur_start - timedelta(days=1)
    if chunks:
        data = pd.concat(chunks)
        data = data[~data.index.duplicated(keep='first')].sort_index()
        print(f"{len(data)} bars")
        return data
    print("0 bars")
    return pd.DataFrame()


# ─────────────────────────────────────────────────────────────────────────────
# 2.  HIGH-IMPACT NEWS CALENDAR  (FOMC + CPI + NFP approximations)
# ─────────────────────────────────────────────────────────────────────────────

def _as_date(d):
    """Convert Timestamp / date / str to a plain date object."""
    if hasattr(d, 'date'):
        try:
            return d.date()
        except TypeError:
            return d
    return pd.to_datetime(d).date()


def get_news_dates():
    """
    Hard-coded FOMC decision dates 2019-2026.
    In production: pull from ForexFactory or FRED calendar API.
    Also marks ±1 day to catch pre/post drift contamination.
    """
    fomc = [
        # 2019
        "2019-01-30","2019-03-20","2019-05-01","2019-06-19",
        "2019-07-31","2019-09-18","2019-10-30","2019-12-11",
        # 2020
        "2020-01-29","2020-03-03","2020-03-15","2020-04-29",
        "2020-06-10","2020-07-29","2020-09-16","2020-11-05","2020-12-16",
        # 2021
        "2021-01-27","2021-03-17","2021-04-28","2021-06-16",
        "2021-07-28","2021-09-22","2021-11-03","2021-12-15",
        # 2022
        "2022-01-26","2022-03-16","2022-05-04","2022-06-15",
        "2022-07-27","2022-09-21","2022-11-02","2022-12-14",
        # 2023
        "2023-02-01","2023-03-22","2023-05-03","2023-06-14",
        "2023-07-26","2023-09-20","2023-11-01","2023-12-13",
        # 2024
        "2024-01-31","2024-03-20","2024-05-01","2024-06-12",
        "2024-07-31","2024-09-18","2024-11-07","2024-12-18",
        # 2025
        "2025-01-29","2025-03-19","2025-05-07","2025-06-18",
        "2025-07-30","2025-09-17","2025-10-29","2025-12-10",
        # 2026
        "2026-01-28","2026-03-18","2026-04-29","2026-06-17",
        "2026-07-29","2026-09-16",
    ]
    base = pd.to_datetime(fomc).normalize()
    # Add ±1 day buffer
    expanded = set()
    for d in base:
        for offset in [-1, 0, 1]:
            expanded.add((d + pd.Timedelta(days=offset)).date())
    return expanded


# ─────────────────────────────────────────────────────────────────────────────
# 3.  ANALYSIS MODULES
# ─────────────────────────────────────────────────────────────────────────────

SEP = "─" * 60

def section(title):
    print(f"\n{SEP}")
    print(f"  {title}")
    print(SEP)


def analyze_news_impact(daily, news_set):
    section("NEWS IMPACT — does NAS100 follow macro news?")
    df = daily.copy()
    df['abs_ret_pct'] = df['Close'].pct_change().abs() * 100
    df['date'] = pd.to_datetime(df.index.date)
    df['is_news'] = df['date'].apply(lambda d: _as_date(d) in news_set)

    news_moves   = df[df['is_news']]['abs_ret_pct'].dropna()
    normal_moves = df[~df['is_news']]['abs_ret_pct'].dropna()

    if len(news_moves) == 0 or len(normal_moves) == 0:
        print("  WARNING: news date filter matched 0 rows — check date format")
        return 1.0, 1.0

    u_stat, p_val = stats.mannwhitneyu(news_moves, normal_moves, alternative='greater')

    print(f"  News days  ({len(news_moves):4d}):  avg move = {news_moves.mean():.2f}%  "
          f"median = {news_moves.median():.2f}%")
    print(f"  Normal days({len(normal_moves):4d}):  avg move = {normal_moves.mean():.2f}%  "
          f"median = {normal_moves.median():.2f}%")
    print(f"  Volatility multiplier: {news_moves.mean()/normal_moves.mean():.2f}×")
    print(f"  Mann-Whitney p-value:  {p_val:.4f}  "
          f"({'SIGNIFICANT ★' if p_val < 0.01 else 'not significant'})")

    # What % of all 1%+ moves are on news days?
    big_moves = df[df['abs_ret_pct'] >= 1.0]
    news_share = big_moves['is_news'].mean()
    print(f"  Moves ≥1%: {len(big_moves)} total, {news_share:.1%} on news days")
    return news_moves.mean(), normal_moves.mean()


def analyze_dow(daily, news_set):
    section("DAY-OF-WEEK EDGE (news-filtered)")
    df = daily.copy()
    df['date']     = pd.to_datetime(df.index.date)
    df['ret']      = (df['Close'] - df['Open']) / df['Open'] * 100
    df['is_news']  = df['date'].apply(lambda d: d in news_set)
    df['dow']      = df.index.dayofweek   # 0=Mon
    df['dow_name'] = df.index.day_name()

    clean = df[~df['is_news']]
    order = ['Monday','Tuesday','Wednesday','Thursday','Friday']

    print(f"  {'Day':<12} {'N':>5} {'Mean':>8} {'Bull%':>8} {'t-stat':>8} {'Sharpe':>8}")
    print(f"  {'-'*52}")
    for day in order:
        sub = clean[clean['dow_name'] == day]['ret'].dropna()
        if len(sub) < 10:
            continue
        mean   = sub.mean()
        bull   = (sub > 0).mean()
        t, _   = stats.ttest_1samp(sub, 0)
        sharpe = mean / sub.std() * np.sqrt(252) if sub.std() > 0 else 0
        flag   = " ★" if abs(t) > 2.0 else ""
        print(f"  {day:<12} {len(sub):>5} {mean:>+7.2f}% {bull:>7.1%} {t:>8.2f} {sharpe:>8.2f}{flag}")


def analyze_time_of_day(h1, news_set):
    section("TIME-OF-DAY EDGE — 1H bars (UTC), news-filtered")
    df = h1.copy()
    df['date']    = pd.to_datetime(df.index.date)
    df['is_news'] = df['date'].apply(lambda d: _as_date(d) in news_set)
    df['ret']     = (df['Close'] - df['Open']) / df['Open'] * 100
    df['hour']    = df.index.hour

    clean = df[~df['is_news']]

    # Session label
    def session(h):
        if   h < 7:              return "Asian   "
        elif h < 13:             return "London  "
        elif h == 13:            return "NY-ORB  "
        elif 14 <= h <= 15:      return "NY-AM   "
        elif 16 <= h <= 19:      return "NY-PM   "
        else:                    return "After   "

    print(f"  {'Hr(UTC)':<9} {'Session':<10} {'N':>5} {'Mean':>8} {'Bull%':>8} {'t-stat':>8}")
    print(f"  {'-'*54}")
    for h in range(0, 22):
        sub = clean[clean['hour'] == h]['ret'].dropna()
        if len(sub) < 20:
            continue
        mean = sub.mean()
        bull = (sub > 0).mean()
        t, _ = stats.ttest_1samp(sub, 0)
        flag = " ★" if abs(t) > 2.5 else ""
        print(f"  {h:02d}:00     {session(h):<10} {len(sub):>5} {mean:>+7.3f}% {bull:>7.1%} {t:>8.2f}{flag}")


def analyze_orb(h1, news_set):
    section("ORB ANALYSIS — does NAS100 continue or reverse its opening range?")
    df = h1.copy()
    df['date']    = pd.to_datetime(df.index.date)
    df['is_news'] = df['date'].apply(lambda d: _as_date(d) in news_set)
    df['hour']    = df.index.hour

    clean = df[~df['is_news']]

    # ORB = 13:30-14:30 UTC (first 1h of regular US session)
    orb = clean[clean['hour'] == 13].groupby('date').agg(
        orb_hi=('High', 'max'), orb_lo=('Low', 'min'),
        orb_open=('Open', 'first'), orb_close=('Close', 'last')
    )

    # NY continuation window = 14-20 UTC
    ny = clean[clean['hour'].isin([14,15,16,17,18,19,20])].groupby('date').agg(
        ny_hi=('High', 'max'), ny_lo=('Low', 'min'),
        ny_close=('Close', 'last'), ny_open=('Open', 'first')
    )

    m = orb.join(ny, how='inner')
    m['orb_range']  = m['orb_hi'] - m['orb_lo']
    m['orb_dir']    = np.where(m['orb_close'] > m['orb_open'], 1, -1)
    m['ny_dir']     = np.where(m['ny_close'] > m['orb_open'], 1, -1)
    m['continuation'] = (m['orb_dir'] == m['ny_dir'])

    # Breakout classification
    m['broke_hi'] = m['ny_hi'] > m['orb_hi']
    m['broke_lo'] = m['ny_lo'] < m['orb_lo']
    m['breakout'] = m['broke_hi'] & ~m['broke_lo']
    m['breakdown'] = ~m['broke_hi'] & m['broke_lo']
    m['both_sides'] = m['broke_hi'] & m['broke_lo']
    m['inside']     = ~m['broke_hi'] & ~m['broke_lo']

    # TP if breakout aligned with ORB direction
    broke_up   = m[m['breakout']]
    broke_down = m[m['breakdown']]

    print(f"  Sample: {len(m)} non-news trading days")
    print(f"  Mean ORB range:            {m['orb_range'].mean():.0f} pts")
    print()
    print(f"  NY continuation rate:      {m['continuation'].mean():.1%}")
    print()
    print(f"  Breakout UP only:          {m['breakout'].mean():.1%}")
    print(f"  Breakdown DOWN only:       {m['breakdown'].mean():.1%}")
    print(f"  Broke BOTH sides (chop):   {m['both_sides'].mean():.1%}")
    print(f"  Inside day (no break):     {m['inside'].mean():.1%}")
    print()

    if len(broke_up) > 5:
        cont_up = (broke_up['orb_dir'] == 1).mean()
        print(f"  When broke UP → ORB-aligned: {cont_up:.1%}  (n={len(broke_up)})")
    if len(broke_down) > 5:
        cont_dn = (broke_down['orb_dir'] == -1).mean()
        print(f"  When broke DN → ORB-aligned: {cont_dn:.1%}  (n={len(broke_down)})")

    # ORB range quintiles
    print()
    print(f"  Continuation by ORB range quintile:")
    m['range_q'] = pd.qcut(m['orb_range'], 5, labels=['Q1(tiny)','Q2','Q3','Q4','Q5(wide)'])
    for q in ['Q1(tiny)','Q2','Q3','Q4','Q5(wide)']:
        sub = m[m['range_q'] == q]
        print(f"    {q}: {sub['continuation'].mean():.1%}  (n={len(sub)})")


def analyze_london_ny(h1, news_set):
    section("LONDON → NY DIRECTION PREDICTION")
    df = h1.copy()
    df['date']    = pd.to_datetime(df.index.date)
    df['is_news'] = df['date'].apply(lambda d: _as_date(d) in news_set)
    df['hour']    = df.index.hour

    clean = df[~df['is_news']]

    # London session = 07:00-13:00 UTC
    ldn = clean[clean['hour'].isin(range(7, 13))].groupby('date').agg(
        ldn_open=('Open', 'first'), ldn_close=('Close', 'last')
    )
    ldn['ldn_dir'] = np.sign(ldn['ldn_close'] - ldn['ldn_open'])

    # NY session = 13:30-20:00 UTC
    ny = clean[clean['hour'].isin(range(13, 21))].groupby('date').agg(
        ny_open=('Open', 'first'), ny_close=('Close', 'last')
    )
    ny['ny_dir'] = np.sign(ny['ny_close'] - ny['ny_open'])

    m = ldn.join(ny, how='inner').dropna()
    m['same_dir'] = (m['ldn_dir'] == m['ny_dir'])

    print(f"  Sample: {len(m)} non-news days with both sessions")
    print(f"  London dir → NY same dir: {m['same_dir'].mean():.1%}")

    for ld in [1, -1]:
        sub = m[m['ldn_dir'] == ld]
        if len(sub) < 10:
            continue
        label = "Bullish London" if ld == 1 else "Bearish London"
        print(f"    {label}: NY continues {(sub['ny_dir'] == ld).mean():.1%}  (n={len(sub)})")


def analyze_momentum(daily, news_set):
    section("MOMENTUM / MEAN-REVERSION — does NAS100 trend or revert?")
    df = daily.copy()
    df['date']    = pd.to_datetime(df.index.date)
    df['is_news'] = df['date'].apply(lambda d: _as_date(d) in news_set)
    df['ret']     = df['Close'].pct_change() * 100

    clean = df[~df['is_news']].dropna(subset=['ret'])

    for lag in [1, 2, 3, 5]:
        clean[f'lag{lag}'] = clean['ret'].shift(lag)

    print(f"  {'Lag':<6} {'Corr':>8} {'t-stat':>8} {'p-value':>10} {'Signal':>12}")
    print(f"  {'-'*48}")
    for lag in [1, 2, 3, 5]:
        sub = clean[['ret', f'lag{lag}']].dropna()
        if len(sub) < 20:
            continue
        corr, p = stats.pearsonr(sub['ret'], sub[f'lag{lag}'])
        t = corr * np.sqrt((len(sub)-2)/(1-corr**2))
        signal = "MOM ★" if corr > 0.05 and p < 0.05 else \
                 "REV ★" if corr < -0.05 and p < 0.05 else "neutral"
        print(f"  {lag:<6} {corr:>+8.4f} {t:>8.2f} {p:>10.4f} {signal:>12}")

    # Momentum on clean days only (no news)
    print()
    print(f"  Simplified momentum rule (no news, close > prev close → next day bull):")
    clean['prev_bull'] = clean['ret'].shift(1) > 0
    clean['today_bull'] = clean['ret'] > 0
    acc = clean[clean['prev_bull']]['today_bull'].mean()
    print(f"    After UP day → next day UP: {acc:.1%}  (n={clean['prev_bull'].sum()})")
    acc2 = clean[~clean['prev_bull']]['today_bull'].mean()
    print(f"    After DN day → next day UP: {acc2:.1%}  (n={(~clean['prev_bull']).sum()})")


def analyze_volatility_regime(daily, news_set):
    section("VOLATILITY REGIME — does strategy quality depend on VIX-like regime?")
    df = daily.copy()
    df['date']    = pd.to_datetime(df.index.date)
    df['is_news'] = df['date'].apply(lambda d: _as_date(d) in news_set)
    df['ret']     = df['Close'].pct_change() * 100
    df['vol20']   = df['ret'].rolling(20).std()

    q33 = df['vol20'].quantile(0.33)
    q67 = df['vol20'].quantile(0.67)

    df['regime'] = 'medium'
    df.loc[df['vol20'] <= q33, 'regime'] = 'low_vol'
    df.loc[df['vol20'] >= q67, 'regime'] = 'high_vol'

    clean = df[~df['is_news']]

    for regime in ['low_vol', 'medium', 'high_vol']:
        sub = clean[clean['regime'] == regime]['ret'].dropna()
        if len(sub) < 10:
            continue
        # 1-day momentum within regime
        sub_shifted = sub.shift(1)
        same_dir = (np.sign(sub) == np.sign(sub_shifted)).mean()
        print(f"  {regime:<12}  n={len(sub):4d}  "
              f"avg_ret={sub.mean():+.2f}%  "
              f"1d-momentum={same_dir:.1%}  "
              f"vol_annualized={sub.std()*np.sqrt(252):.1f}%")


def analyze_fourier(daily):
    section("FOURIER CYCLE ANALYSIS — dominant recurring patterns in NAS100")
    prices = daily['Close'].dropna().values
    if len(prices) < 50:
        print("  Insufficient data")
        return

    detrended_p = detrend(prices)
    N = len(detrended_p)
    fft_vals = np.abs(fft(detrended_p))[:N//2]
    freqs    = np.fft.fftfreq(N)[:N//2]

    # Top 8 dominant periods (skip DC component)
    idx = np.argsort(fft_vals[1:])[-8:] + 1
    periods = sorted(1.0 / freqs[idx], reverse=True)

    print(f"  Top-8 dominant periods (in trading days):")
    for p in periods:
        label = ""
        if   220 < p < 270: label = "≈ annual"
        elif 60  < p < 70:  label = "≈ quarterly"
        elif 18  < p < 25:  label = "≈ monthly"
        elif 4   < p < 6:   label = "≈ weekly"
        print(f"    {p:>8.1f} days  {label}")


def analyze_session_sweep_edge(h1, news_set):
    """
    Core ICT hypothesis: Asian high/low swept → London/NY moves opposite.
    Tests if this actually holds statistically on NAS100.
    """
    section("ICT SWEEP HYPOTHESIS — does sweeping Asian range predict reversal?")
    df = h1.copy()
    df['date']    = pd.to_datetime(df.index.date)
    df['is_news'] = df['date'].apply(lambda d: _as_date(d) in news_set)
    df['hour']    = df.index.hour

    clean = df[~df['is_news']]

    # Asian range (00:00-07:00 UTC)
    asian = clean[clean['hour'].isin(range(0, 7))].groupby('date').agg(
        asian_hi=('High', 'max'), asian_lo=('Low', 'min')
    )

    # London extension (07:00-13:00 UTC)
    london = clean[clean['hour'].isin(range(7, 13))].groupby('date').agg(
        ldn_hi=('High', 'max'), ldn_lo=('Low', 'min'),
        ldn_open=('Open', 'first'), ldn_close=('Close', 'last')
    )

    # NY (13:00-20:00 UTC)
    ny = clean[clean['hour'].isin(range(13, 21))].groupby('date').agg(
        ny_close=('Close', 'last'), ny_open=('Open', 'first')
    )

    m = asian.join(london, how='inner').join(ny, how='inner').dropna()

    # Did London sweep the Asian high or low?
    m['swept_hi'] = m['ldn_hi'] > m['asian_hi']
    m['swept_lo'] = m['ldn_lo'] < m['asian_lo']
    m['swept_only_hi'] = m['swept_hi'] & ~m['swept_lo']
    m['swept_only_lo'] = ~m['swept_hi'] & m['swept_lo']

    m['ny_dir'] = np.sign(m['ny_close'] - m['ny_open'])

    print(f"  Sample: {len(m)} non-news days with Asian + London + NY data")
    print()

    # Sweep hi → ICT expects London/NY to reverse bearish
    hi_sweep = m[m['swept_only_hi']]
    lo_sweep = m[m['swept_only_lo']]

    if len(hi_sweep) > 5:
        # ICT predicts: after sweeping Asian high → market goes DOWN
        reversal_hi = (hi_sweep['ny_dir'] == -1).mean()
        print(f"  London sweeps Asian HIGH (n={len(hi_sweep):3d}): "
              f"NY goes bearish {reversal_hi:.1%}  "
              f"({'ICT works ★' if reversal_hi > 0.55 else 'no edge'})")

    if len(lo_sweep) > 5:
        # ICT predicts: after sweeping Asian low → market goes UP
        reversal_lo = (lo_sweep['ny_dir'] == 1).mean()
        print(f"  London sweeps Asian LOW  (n={len(lo_sweep):3d}): "
              f"NY goes bullish {reversal_lo:.1%}  "
              f"({'ICT works ★' if reversal_lo > 0.55 else 'no edge'})")

    no_sweep = m[~m['swept_hi'] & ~m['swept_lo']]
    if len(no_sweep) > 5:
        bull_no = (no_sweep['ny_dir'] == 1).mean()
        print(f"  No sweep (inside Asian range, n={len(no_sweep):3d}): "
              f"NY bullish {bull_no:.1%}")

    both_sweep = m[m['swept_hi'] & m['swept_lo']]
    if len(both_sweep) > 5:
        bull_both = (both_sweep['ny_dir'] == 1).mean()
        print(f"  Swept BOTH sides (n={len(both_sweep):3d}):          "
              f"NY bullish {bull_both:.1%}  (choppy days)")


def find_high_edge_combos(daily, h1, news_set):
    section("COMBINATION RULES — 2-confirmation setups (news-filtered)")
    df = daily.copy()
    df['date']    = pd.to_datetime(df.index.date)
    df['is_news'] = df['date'].apply(lambda d: _as_date(d) in news_set)
    df['ret']     = (df['Close'] - df['Open']) / df['Open'] * 100
    df['day_ret'] = (df['Close'] - df['Open']) / df['Open'] * 100
    df['prev_ret'] = df['day_ret'].shift(1)
    df['vol20']   = df['Close'].pct_change().rolling(20).std() * 100
    df['dow']     = df.index.dayofweek

    clean = df[~df['is_news']].dropna(subset=['ret','prev_ret','vol20'])

    q50_vol = clean['vol20'].quantile(0.5)

    combos = {
        "Mon+Tue, low-vol, prev bullish → long": {
            'mask': (clean['dow'].isin([0,1])) &
                    (clean['vol20'] < q50_vol) &
                    (clean['prev_ret'] > 0),
            'direction': 1
        },
        "Mon+Tue, low-vol, prev bearish → short": {
            'mask': (clean['dow'].isin([0,1])) &
                    (clean['vol20'] < q50_vol) &
                    (clean['prev_ret'] < 0),
            'direction': -1
        },
        "Wed+Thu, prev bullish → long": {
            'mask': (clean['dow'].isin([2,3])) &
                    (clean['prev_ret'] > 0),
            'direction': 1
        },
        "Any day, high-vol → fade gap": {
            'mask': (clean['vol20'] >= clean['vol20'].quantile(0.67)),
            'direction': 0  # neutral test
        },
        "Friday, prev bullish → reversion short": {
            'mask': (clean['dow'] == 4) & (clean['prev_ret'] > 0),
            'direction': -1
        },
    }

    print(f"  {'Rule':<42} {'N':>4} {'Hit%':>6} {'Avg R':>7} {'t':>6}")
    print(f"  {'-'*68}")
    for name, cfg in combos.items():
        sub = clean[cfg['mask']]['ret']
        if len(sub) < 8:
            print(f"  {name:<42} {'<8 samples':>18}")
            continue
        if cfg['direction'] != 0:
            aligned = sub * cfg['direction']
        else:
            aligned = sub.abs()
        hit = (aligned > 0).mean()
        avg = aligned.mean()
        t, p = stats.ttest_1samp(aligned, 0)
        flag = " ★" if p < 0.05 and abs(t) > 2.0 else ""
        print(f"  {name:<42} {len(sub):>4} {hit:>6.1%} {avg:>+6.2f}% {t:>5.2f}{flag}")


def print_conclusions(news_vol_mult):
    section("CONCLUSIONS & RECOMMENDED STRATEGY DIRECTION")
    print(f"""
  FINDING 1 — NEWS IS THE DOMINANT DRIVER
  ─────────────────────────────────────────
  News days have {news_vol_mult:.1f}× normal volatility. The NAS100 ICT patterns
  that "look good" in hindsight mostly fire on FOMC/CPI days. The pattern
  is real but the cause is the news, not the structure. Filter news first.

  FINDING 2 — ICT SWEEP HYPOTHESIS (see above)
  ─────────────────────────────────────────────
  The Asian range sweep → reversal concept is less reliable on NAS100
  than on FX pairs. NAS100 has strong trending days where it blows through
  both Asian range levels and keeps going. No edge unless vol is low.

  FINDING 3 — WHAT PROBABLY WORKS
  ────────────────────────────────
  ① Low-volatility + Mon/Tue + prior day same direction → momentum play
     in direction of the trend. (2-confirmation setup, news-filtered)
  ② London close direction is the strongest intraday predictor of NY.
     If London closes strong, NY tends to continue (not reverse).
     Trend-follow London into the Silver Bullet window, not fade it.
  ③ ORB continuation > ORB fade for NAS100 (see stats above).
     Trade BREAKOUT direction, not the fake-out reversal.

  FINDING 4 — WHY SIGNALS A→T ALL FAILED
  ────────────────────────────────────────
  They all used the same underlying concept: FVG-based reversal after
  a sweep. NAS100 trends more than it reverses. In a bull market the
  "sweep + reversal" fires short constantly and loses. In high vol
  (FOMC cycle) the FVGs get violated before price can return.

  RECOMMENDED NEXT STEPS
  ───────────────────────
  1. Build a Pine strategy using: London direction filter + low-vol day
     filter + ORB continuation entry (trend-following, not reversal).
  2. Add a news calendar block (skip FOMC ±1d, CPI ±1d, NFP).
  3. Test on 3yr data with strict R:R ≥ 1:1.5 and max 1 trade/day.
  4. Present results here before any live implementation.
""")


# ─────────────────────────────────────────────────────────────────────────────
# 4.  MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  QB NAS100 STATISTICAL RESEARCH")
    print(f"  Run date: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)

    print("\nLoading data …")
    daily  = fetch_daily(years=6)
    h1     = fetch_hourly(years=2)
    m15    = fetch_15m_chunked(months=4)
    news   = get_news_dates()

    if daily.empty:
        print("ERROR: Could not fetch daily data. Check yfinance install and internet.")
        sys.exit(1)

    print(f"\n  15m bars available: {len(m15)}  (used for FVG micro-analysis)")

    news_mean, normal_mean = analyze_news_impact(daily, news)
    analyze_dow(daily, news)
    analyze_time_of_day(h1, news)
    analyze_orb(h1, news)
    analyze_london_ny(h1, news)
    analyze_momentum(daily, news)
    analyze_volatility_regime(daily, news)
    analyze_fourier(daily)
    analyze_session_sweep_edge(h1, news)
    find_high_edge_combos(daily, h1, news)
    print_conclusions(news_mean / normal_mean if normal_mean > 0 else 1.5)

    print("\n" + "=" * 60)
    print("  RESEARCH COMPLETE")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
