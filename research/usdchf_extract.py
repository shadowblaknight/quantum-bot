"""
QB USDCHF — Tactic Extraction from Real Data
=============================================
No guessing. Every number comes from real price data.

Research basis implemented here:
  1. ARLB  — Asian Range London Breakout
             Asian session (00:00-06:59 UTC) sets a range.
             London open breaks it. Most documented professional CHF tactic.
             Source: SNB intervention patterns + London session dominance research.

  2. PDB   — Previous Day Break
             Previous day's high/low = institutional stop clusters.
             Clean break during session = momentum continuation.

  3. LOC   — London Open Candle
             08:00 UTC H1 candle close as entry signal.
             Body conviction filter + gold bias.

Gold filter: XAUUSD (GC=F) D EMA50 bias, inverted for USDCHF.
News filter: ENTIRE news days excluded (not just ±N hours).

Pass criteria: 1-2 trades/week · WR > 55% · PF > 1.5
"""

import pandas as pd
import numpy as np
import yfinance as yf
from scipy import stats
import warnings
warnings.filterwarnings('ignore')

# ─── VERIFIED NEWS EVENT DATES (Source: official SNB/Fed calendars) ───────────
SNB_DATES = {
    '2022-03-24', '2022-06-16', '2022-09-22', '2022-12-15',
    '2023-03-23', '2023-06-22', '2023-09-21', '2023-12-14',
    '2024-03-21', '2024-06-20', '2024-09-26', '2024-12-12',
    '2025-03-20', '2025-06-19', '2025-09-25',
}

FOMC_DATES = {
    '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15',
    '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
    '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14',
    '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
    '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12',
    '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
    '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
    '2025-07-30', '2025-09-17',
}

def get_nfp_dates():
    """First Friday of every month = NFP. Calculated, not guessed."""
    dates = set()
    for month_start in pd.date_range('2022-01-01', '2025-10-01', freq='MS'):
        d = month_start
        while d.weekday() != 4:   # 4 = Friday
            d += pd.Timedelta(days=1)
        dates.add(d.strftime('%Y-%m-%d'))
    return dates

ALL_NEWS_DAYS = SNB_DATES | FOMC_DATES | get_nfp_dates()

# ─── DATA DOWNLOAD ────────────────────────────────────────────────────────────
def download():
    print("Downloading USDCHF=X H1 (2 years)...")
    chf = yf.download("USDCHF=X", period="2y", interval="1h",
                      auto_adjust=True, progress=False)
    if isinstance(chf.columns, pd.MultiIndex):
        chf.columns = chf.columns.get_level_values(0)
    chf.columns = [c.lower() for c in chf.columns]
    if chf.index.tz is None:
        chf.index = chf.index.tz_localize('UTC')
    else:
        chf.index = chf.index.tz_convert('UTC')
    chf = chf.dropna(subset=['open','high','low','close'])

    print("Downloading GC=F daily (3 years) for gold bias...")
    gold = yf.download("GC=F", period="3y", interval="1d",
                       auto_adjust=True, progress=False)
    if isinstance(gold.columns, pd.MultiIndex):
        gold.columns = gold.columns.get_level_values(0)
    gold.columns = [c.lower() for c in gold.columns]
    if gold.index.tz is None:
        gold.index = gold.index.tz_localize('UTC')
    else:
        gold.index = gold.index.tz_convert('UTC')
    gold = gold.dropna(subset=['close'])

    if len(gold) == 0:
        raise RuntimeError("GC=F download failed — check internet / yfinance version.")

    return chf, gold

# ─── GOLD BIAS SIGNAL ────────────────────────────────────────────────────────
def add_gold_bias(chf, gold, ema_period=50):
    """
    Gold D EMA50 bias, shifted 1 day (no lookahead).
    gold_bull → USDCHF SHORT bias  (gold up = dollar weak = CHF up = USDCHF down)
    gold_bear → USDCHF LONG  bias
    """
    gold = gold.copy()
    gold['g_ema']     = gold['close'].ewm(span=ema_period, adjust=False).mean()
    gold['gold_bull'] = (gold['close'] > gold['g_ema']).shift(1).fillna(False)
    gold['gold_bear'] = (gold['close'] < gold['g_ema']).shift(1).fillna(False)

    g = gold[['gold_bull', 'gold_bear']].reindex(chf.index, method='ffill').fillna(False)
    chf['gold_bull'] = g['gold_bull'].astype(bool)
    chf['gold_bear'] = g['gold_bear'].astype(bool)
    return chf

# ─── ATR (14-period, daily) ───────────────────────────────────────────────────
def add_atr_daily(chf):
    """Daily ATR for range filtering — resampled to daily, then forward-filled."""
    h1_atr_raw = (
        pd.concat([
            chf['high'] - chf['low'],
            (chf['high'] - chf['close'].shift(1)).abs(),
            (chf['low']  - chf['close'].shift(1)).abs(),
        ], axis=1).max(axis=1)
        .ewm(span=14, adjust=False).mean()
    )
    chf['h1_atr'] = h1_atr_raw

    daily_atr = h1_atr_raw.resample('1D').mean().shift(1)
    chf['daily_atr'] = daily_atr.reindex(chf.index, method='ffill')
    return chf

# ─── NEWS FILTER ─────────────────────────────────────────────────────────────
def is_news_day(date_str):
    return date_str in ALL_NEWS_DAYS

# ─── PREV DAY HIGH / LOW ─────────────────────────────────────────────────────
def add_prev_day_levels(chf):
    prev_hi = chf['high'].resample('1D').max().shift(1)
    prev_lo = chf['low'].resample('1D').min().shift(1)
    chf['prev_d_hi'] = prev_hi.reindex(chf.index, method='ffill')
    chf['prev_d_lo'] = prev_lo.reindex(chf.index, method='ffill')
    return chf

# ─── ACTUAL CORRELATION CHECK ─────────────────────────────────────────────────
def print_correlation(chf, gold):
    chf_d  = chf['close'].resample('1D').last().dropna()
    gold_d = gold['close'].reindex(chf_d.index, method='ffill').dropna()
    chf_d  = chf_d.reindex(gold_d.index).dropna()
    gold_d = gold_d.reindex(chf_d.index)

    corr_levels  = chf_d.corr(gold_d)
    corr_returns = chf_d.pct_change().dropna().corr(gold_d.pct_change().dropna())

    print(f"\n{'─'*60}")
    print(f"ACTUAL CORRELATIONS (real data, no assumptions):")
    print(f"  USDCHF vs Gold — price levels  : {corr_levels:.4f}")
    print(f"  USDCHF vs Gold — daily returns : {corr_returns:.4f}")
    print(f"  (Negative = inverse = gold up → USDCHF down)")
    print(f"{'─'*60}\n")

# ─── BACKTEST CORE ────────────────────────────────────────────────────────────
def simulate(trades_list, tp_r):
    """
    Given a list of (entry, sl, tp_target, date) tuples,
    compute simple fixed-RR results.

    We simulate bar-by-bar using the actual intraday data is NOT available
    in this setup — so we use pessimistic assumption:
      - SL = 1R loss
      - TP = tp_r R gain
    Win/Loss is determined by which level was reached first in the trade window.
    (We track this per-trade using the actual OHLC bars after entry.)
    """
    results = []
    for t in trades_list:
        entry    = t['entry']
        sl       = t['sl']
        direction= t['dir']   # 1 = long, -1 = short
        date     = t['date']
        bars     = t['future_bars']  # list of (high, low) for subsequent bars

        sl_dist = abs(entry - sl)
        if sl_dist < 1e-8:
            continue
        tp_level = entry + direction * sl_dist * tp_r

        outcome = None
        for (bar_hi, bar_lo) in bars:
            if direction == 1:   # long
                if bar_lo <= sl:
                    outcome = -1.0; break
                if bar_hi >= tp_level:
                    outcome = tp_r; break
            else:                # short
                if bar_hi >= sl:
                    outcome = -1.0; break
                if bar_lo <= tp_level:
                    outcome = tp_r; break

        if outcome is None:
            outcome = -1.0   # trade still open at end → count as loss (conservative)

        results.append({'pnl': outcome, 'date': date, 'dir': direction})

    return results

def metrics(results, total_weeks, label=''):
    if len(results) < 8:
        return None
    df = pd.DataFrame(results)
    df['date'] = pd.to_datetime(df['date'], utc=True)

    wins  = df['pnl'] > 0
    n     = len(df)
    wr    = wins.sum() / n
    gp    = df.loc[wins,  'pnl'].sum()
    gl    = df.loc[~wins, 'pnl'].abs().sum()
    pf    = gp / gl if gl > 0 else 999.0
    tpw   = n / total_weeks

    # Per-year WR
    df['year'] = df['date'].dt.year
    yr_wr = df.groupby('year').apply(lambda g: (g['pnl']>0).mean()).to_dict()
    min_yr_wr = min(yr_wr.values()) if yr_wr else 0.0

    # Statistical significance: is WR > 50% non-random?
    binom_p = stats.binom_test(wins.sum(), n, 0.5, alternative='greater') \
              if hasattr(stats, 'binom_test') \
              else stats.binomtest(wins.sum(), n, 0.5, alternative='greater').pvalue

    return {
        'label':      label,
        'n':          n,
        'tpw':        round(tpw, 2),
        'wr':         round(wr * 100, 1),
        'pf':         round(pf, 3),
        'min_yr_wr':  round(min_yr_wr * 100, 1),
        'yr_wr':      {y: round(v*100,1) for y,v in yr_wr.items()},
        'binom_p':    round(binom_p, 4),
        'significant': binom_p < 0.05,
    }

def print_metrics(m, tp_r, indent='  '):
    if m is None:
        print(f"{indent}< 8 trades — insufficient data")
        return
    sig = '✅ SIGNIFICANT' if m['significant'] else '⚠️  not significant'
    passed = (0.8 <= m['tpw'] <= 3.0 and
              m['wr'] >= 55 and
              m['pf'] >= 1.5 and
              m['min_yr_wr'] >= 50)
    tag = '  ★ PASSES CRITERIA' if passed else ''
    print(f"{indent}Trades    : {m['n']}  ({m['tpw']}/week)")
    print(f"{indent}Win rate  : {m['wr']}%{tag}")
    print(f"{indent}Prof.fact : {m['pf']}{tag}")
    print(f"{indent}Min yr WR : {m['min_yr_wr']}%")
    print(f"{indent}Per year  : {m['yr_wr']}")
    print(f"{indent}Stats sig : p={m['binom_p']}  {sig}")

# ─────────────────────────────────────────────────────────────────────────────
# TACTIC 1: ASIAN RANGE LONDON BREAKOUT (ARLB)
# ─────────────────────────────────────────────────────────────────────────────
def tactic_arlb(chf, total_weeks, tp_r_list, sl_buf_atr=0.15, min_rng_atr=0.25):
    """
    Asian session (00:00–06:59 UTC) sets the range.
    London open (07:00–11:00 UTC): first H1 close that breaks the range = entry.
    Gold D EMA50 bias (inverted) used as macro filter.

    min_rng_atr: Asian range must be at least this fraction of daily ATR
                 (filters choppy/insignificant consolidation days)
    """
    print(f"\n{'═'*60}")
    print(f"TACTIC 1: Asian Range London Breakout (ARLB)")
    print(f"  Asian window  : 00:00-06:59 UTC")
    print(f"  Entry window  : 07:00-10:59 UTC  (first break, then wait for close)")
    print(f"  SL buffer     : {sl_buf_atr} × daily ATR")
    print(f"  Min range     : {min_rng_atr} × daily ATR")
    print(f"{'═'*60}")

    # Group by date
    chf['date_str'] = chf.index.strftime('%Y-%m-%d')
    chf['utc_hour'] = chf.index.hour
    chf['dow']      = chf.index.dayofweek  # Mon=0

    trades_all  = []   # without gold filter
    trades_gold = []   # with gold filter

    clean_days = news_days = skipped_rng = 0

    for date_str, day_df in chf.groupby('date_str'):
        if is_news_day(date_str):
            news_days += 1
            continue
        if day_df['dow'].iloc[0] > 4:   # skip weekend
            continue

        # Asian range bars: hour 0-6
        asian = day_df[day_df['utc_hour'] < 7]
        if len(asian) < 3:   # need at least 3 bars of Asia
            continue

        asian_hi  = asian['high'].max()
        asian_lo  = asian['low'].min()
        asian_rng = asian_hi - asian_lo

        d_atr = day_df['daily_atr'].iloc[0]
        if pd.isna(d_atr) or d_atr <= 0:
            continue

        # Filter: range must be meaningful
        if asian_rng < d_atr * min_rng_atr:
            skipped_rng += 1
            continue

        clean_days += 1

        # London entry window: hour 7-10
        london = day_df[day_df['utc_hour'].between(7, 10)]
        if len(london) == 0:
            continue

        # Gold bias at start of this day
        gold_bear = bool(london['gold_bear'].iloc[0])   # → USDCHF LONG bias
        gold_bull = bool(london['gold_bull'].iloc[0])   # → USDCHF SHORT bias

        # First bar that closes above Asian high → LONG signal
        # First bar that closes below Asian low  → SHORT signal
        entry_found = False
        for idx in range(len(london)):
            bar = london.iloc[idx]

            # LONG signal: close above Asian high
            if bar['close'] > asian_hi and not entry_found:
                entry  = bar['close']
                sl     = asian_hi - d_atr * sl_buf_atr   # SL: back inside range
                sl_dist = abs(entry - sl)
                if sl_dist < 1e-8:
                    continue

                # Collect future bars (rest of London + NY) for outcome simulation
                future_idx   = london.index[idx]
                future_bars_df = day_df[day_df.index > future_idx]
                future_bars  = list(zip(future_bars_df['high'], future_bars_df['low']))

                trade = {
                    'entry': entry, 'sl': sl, 'dir': 1,
                    'date': bar.name, 'future_bars': future_bars,
                    'gold_agree': gold_bear,
                }
                trades_all.append(trade)
                if gold_bear:
                    trades_gold.append(trade)
                entry_found = True
                break

            # SHORT signal: close below Asian low
            if bar['close'] < asian_lo and not entry_found:
                entry  = bar['close']
                sl     = asian_lo + d_atr * sl_buf_atr
                sl_dist = abs(sl - entry)
                if sl_dist < 1e-8:
                    continue

                future_idx   = london.index[idx]
                future_bars_df = day_df[day_df.index > future_idx]
                future_bars  = list(zip(future_bars_df['high'], future_bars_df['low']))

                trade = {
                    'entry': entry, 'sl': sl, 'dir': -1,
                    'date': bar.name, 'future_bars': future_bars,
                    'gold_agree': gold_bull,
                }
                trades_all.append(trade)
                if gold_bull:
                    trades_gold.append(trade)
                entry_found = True
                break

    print(f"\n  Data summary:")
    print(f"    Total trading days  : {clean_days + news_days}")
    print(f"    News days excluded  : {news_days}")
    print(f"    Range too small     : {skipped_rng}")
    print(f"    Clean days traded   : {clean_days}")
    print(f"    Signals (no filter) : {len(trades_all)}")
    print(f"    Signals (gold filt) : {len(trades_gold)}")

    for tp_r in tp_r_list:
        print(f"\n  ── TP = {tp_r}R ──────────────────────────────────────────")

        r_all  = simulate(trades_all,  tp_r)
        r_gold = simulate(trades_gold, tp_r)

        m_all  = metrics(r_all,  total_weeks, 'ARLB no-filter')
        m_gold = metrics(r_gold, total_weeks, 'ARLB gold-filter')

        print(f"    WITHOUT gold filter:")
        print_metrics(m_all, tp_r, indent='      ')
        print(f"    WITH gold filter (inverse correlation):")
        print_metrics(m_gold, tp_r, indent='      ')

    return trades_all, trades_gold

# ─────────────────────────────────────────────────────────────────────────────
# TACTIC 2: PREVIOUS DAY BREAK (PDB)
# ─────────────────────────────────────────────────────────────────────────────
def tactic_pdb(chf, total_weeks, tp_r_list, sl_buf_atr=0.15, min_break_atr=0.05):
    """
    Price closes beyond previous day's high or low during London/NY session.
    One trade per direction per day.
    Gold D bias filter tested with and without.
    """
    print(f"\n{'═'*60}")
    print(f"TACTIC 2: Previous Day Break (PDB)")
    print(f"  Session       : London (08-12 UTC) + NY (13-18 UTC)")
    print(f"  SL buffer     : {sl_buf_atr} × ATR")
    print(f"  Min clean brk : {min_break_atr} × ATR")
    print(f"{'═'*60}")

    trades_all  = []
    trades_gold = []

    for date_str, day_df in chf.groupby('date_str'):
        if is_news_day(date_str):
            continue
        if day_df['dow'].iloc[0] > 4:
            continue

        session = day_df[
            (day_df['utc_hour'].between(8, 11)) |
            (day_df['utc_hour'].between(13, 17))
        ]
        if len(session) == 0:
            continue

        d_atr    = day_df['daily_atr'].iloc[0]
        if pd.isna(d_atr) or d_atr <= 0:
            continue

        gold_bear = bool(session['gold_bear'].iloc[0])
        gold_bull = bool(session['gold_bull'].iloc[0])

        done_l = done_s = False

        for idx in range(len(session)):
            bar     = session.iloc[idx]
            d_hi    = bar['prev_d_hi']
            d_lo    = bar['prev_d_lo']
            h1_atr  = bar['h1_atr']
            cl      = bar['close']
            atr     = h1_atr if not pd.isna(h1_atr) and h1_atr > 0 else d_atr * 0.25

            if pd.isna(d_hi) or pd.isna(d_lo):
                continue

            # LONG: close above prev-day high + buffer
            if not done_l and cl > d_hi + atr * min_break_atr:
                sl = d_hi - atr * sl_buf_atr
                sl_dist = abs(cl - sl)
                if sl_dist > 0:
                    future_bars_df = day_df[day_df.index > bar.name]
                    future_bars    = list(zip(future_bars_df['high'], future_bars_df['low']))
                    trade = {
                        'entry': cl, 'sl': sl, 'dir': 1,
                        'date': bar.name, 'future_bars': future_bars,
                        'gold_agree': gold_bear,
                    }
                    trades_all.append(trade)
                    if gold_bear:
                        trades_gold.append(trade)
                    done_l = True

            # SHORT: close below prev-day low - buffer
            if not done_s and cl < d_lo - atr * min_break_atr:
                sl = d_lo + atr * sl_buf_atr
                sl_dist = abs(sl - cl)
                if sl_dist > 0:
                    future_bars_df = day_df[day_df.index > bar.name]
                    future_bars    = list(zip(future_bars_df['high'], future_bars_df['low']))
                    trade = {
                        'entry': cl, 'sl': sl, 'dir': -1,
                        'date': bar.name, 'future_bars': future_bars,
                        'gold_agree': gold_bull,
                    }
                    trades_all.append(trade)
                    if gold_bull:
                        trades_gold.append(trade)
                    done_s = True

            if done_l and done_s:
                break

    print(f"\n  Signals (no filter) : {len(trades_all)}")
    print(f"  Signals (gold filt) : {len(trades_gold)}")

    for tp_r in tp_r_list:
        print(f"\n  ── TP = {tp_r}R ──────────────────────────────────────────")
        r_all  = simulate(trades_all,  tp_r)
        r_gold = simulate(trades_gold, tp_r)
        m_all  = metrics(r_all,  total_weeks, 'PDB no-filter')
        m_gold = metrics(r_gold, total_weeks, 'PDB gold-filter')
        print(f"    WITHOUT gold filter:")
        print_metrics(m_all, tp_r, indent='      ')
        print(f"    WITH gold filter:")
        print_metrics(m_gold, tp_r, indent='      ')

    return trades_all, trades_gold

# ─────────────────────────────────────────────────────────────────────────────
# TACTIC 3: LONDON OPEN CANDLE (LOC)
# ─────────────────────────────────────────────────────────────────────────────
def tactic_loc(chf, total_weeks, tp_r_list, sl_buf_atr=0.15, min_body=0.45):
    """
    The 08:00 UTC H1 candle (first London candle) as signal.
    Conviction close (body >= min_body fraction) + gold bias.
    Most directional candle of the session statistically.
    """
    print(f"\n{'═'*60}")
    print(f"TACTIC 3: London Open Candle (LOC)")
    print(f"  Signal candle : 08:00 UTC H1 close")
    print(f"  Min body      : {int(min_body*100)}% of candle range")
    print(f"  SL            : opposite end of signal candle + buffer")
    print(f"{'═'*60}")

    trades_all  = []
    trades_gold = []

    for date_str, day_df in chf.groupby('date_str'):
        if is_news_day(date_str):
            continue
        if day_df['dow'].iloc[0] > 4:
            continue

        # Get the 08:00 UTC candle
        lon_open = day_df[day_df['utc_hour'] == 8]
        if len(lon_open) == 0:
            continue

        bar = lon_open.iloc[0]
        rng = bar['high'] - bar['low']
        if rng < 1e-6:
            continue

        d_atr    = day_df['daily_atr'].iloc[0]
        h1_atr   = bar['h1_atr']
        atr      = h1_atr if not pd.isna(h1_atr) and h1_atr > 0 else (d_atr * 0.25 if not pd.isna(d_atr) else None)
        if atr is None:
            continue

        bull_bod = (bar['close'] - bar['open']) / rng if bar['close'] > bar['open'] else 0
        bear_bod = (bar['open'] - bar['close']) / rng if bar['close'] < bar['open'] else 0

        gold_bear = bool(bar['gold_bear'])
        gold_bull = bool(bar['gold_bull'])

        future_bars_df = day_df[day_df.index > bar.name]
        future_bars    = list(zip(future_bars_df['high'], future_bars_df['low']))

        # LONG: bullish close with conviction
        if bull_bod >= min_body:
            sl = bar['low'] - atr * sl_buf_atr
            sl_dist = abs(bar['close'] - sl)
            if sl_dist > 0:
                trade = {
                    'entry': bar['close'], 'sl': sl, 'dir': 1,
                    'date': bar.name, 'future_bars': future_bars,
                    'gold_agree': gold_bear,
                }
                trades_all.append(trade)
                if gold_bear:
                    trades_gold.append(trade)

        # SHORT: bearish close with conviction
        elif bear_bod >= min_body:
            sl = bar['high'] + atr * sl_buf_atr
            sl_dist = abs(sl - bar['close'])
            if sl_dist > 0:
                trade = {
                    'entry': bar['close'], 'sl': sl, 'dir': -1,
                    'date': bar.name, 'future_bars': future_bars,
                    'gold_agree': gold_bull,
                }
                trades_all.append(trade)
                if gold_bull:
                    trades_gold.append(trade)

    print(f"\n  Signals (no filter) : {len(trades_all)}")
    print(f"  Signals (gold filt) : {len(trades_gold)}")

    for tp_r in tp_r_list:
        print(f"\n  ── TP = {tp_r}R ──────────────────────────────────────────")
        r_all  = simulate(trades_all,  tp_r)
        r_gold = simulate(trades_gold, tp_r)
        m_all  = metrics(r_all,  total_weeks, 'LOC no-filter')
        m_gold = metrics(r_gold, total_weeks, 'LOC gold-filter')
        print(f"    WITHOUT gold filter:")
        print_metrics(m_all, tp_r, indent='      ')
        print(f"    WITH gold filter:")
        print_metrics(m_gold, tp_r, indent='      ')

    return trades_all, trades_gold

# ─────────────────────────────────────────────────────────────────────────────
# TACTIC 4: ARLB FADE — institutional liquidity grab reversal
# ─────────────────────────────────────────────────────────────────────────────
def tactic_arlb_fade(chf, total_weeks, tp_r_list, sl_buf_atr=0.15, min_rng_atr=0.25):
    """
    Data showed ARLB fails 65% of time — institutions sweep stops above/below
    Asian range then reverse. Fade the breakout:
      Close ABOVE Asian high → SHORT (expecting reversal back in range)
      Close BELOW Asian low  → LONG  (expecting reversal back in range)

    SL: just beyond the breakout candle extreme (not back at entry level).
    TP target: back to Asian midpoint (range/2 minimum) or fixed RR.
    Gold filter: for FADE longs (close<Asian low), gold must be bearish.
                 for FADE shorts (close>Asian hi), gold must be bullish.
    """
    print(f"\n{'═'*60}")
    print(f"TACTIC 4: ARLB FADE — Fade the Liquidity Grab")
    print(f"  Logic         : Break above Asian hi → SHORT (reversal)")
    print(f"                  Break below Asian lo → LONG  (reversal)")
    print(f"  SL buffer     : {sl_buf_atr} × ATR beyond breakout candle extreme")
    print(f"  Min range     : {min_rng_atr} × daily ATR")
    print(f"{'═'*60}")

    trades_all  = []
    trades_gold = []

    for date_str, day_df in chf.groupby('date_str'):
        if is_news_day(date_str):
            continue
        if day_df['dow'].iloc[0] > 4:
            continue

        asian = day_df[day_df['utc_hour'] < 7]
        if len(asian) < 3:
            continue

        asian_hi  = asian['high'].max()
        asian_lo  = asian['low'].min()
        asian_rng = asian_hi - asian_lo
        asian_mid = (asian_hi + asian_lo) / 2

        d_atr = day_df['daily_atr'].iloc[0]
        if pd.isna(d_atr) or d_atr <= 0:
            continue
        if asian_rng < d_atr * min_rng_atr:
            continue

        london = day_df[day_df['utc_hour'].between(7, 10)]
        if len(london) == 0:
            continue

        gold_bear = bool(london['gold_bear'].iloc[0])
        gold_bull = bool(london['gold_bull'].iloc[0])

        entry_found = False
        for idx in range(len(london)):
            bar = london.iloc[idx]
            atr = bar['h1_atr'] if not pd.isna(bar['h1_atr']) and bar['h1_atr'] > 0 else d_atr * 0.25

            # Fade SHORT: close above Asian high → expect reversal DOWN
            if bar['close'] > asian_hi and not entry_found:
                entry  = bar['close']
                sl     = bar['high'] + atr * sl_buf_atr   # SL above bar high
                sl_dist = abs(sl - entry)
                if sl_dist < 1e-8:
                    continue
                future_bars_df = day_df[day_df.index > bar.name]
                future_bars    = list(zip(future_bars_df['high'], future_bars_df['low']))
                trade = {
                    'entry': entry, 'sl': sl, 'dir': -1,
                    'date': bar.name, 'future_bars': future_bars,
                    'gold_agree': gold_bull,   # gold bullish = CHF weak = USDCHF up? No — actually
                    # For a FADE SHORT on USDCHF, we want USDCHF to go DOWN
                    # That needs gold to go UP → gold_bull = True
                }
                trades_all.append(trade)
                if gold_bull:
                    trades_gold.append(trade)
                entry_found = True
                break

            # Fade LONG: close below Asian low → expect reversal UP
            if bar['close'] < asian_lo and not entry_found:
                entry  = bar['close']
                sl     = bar['low'] - atr * sl_buf_atr    # SL below bar low
                sl_dist = abs(entry - sl)
                if sl_dist < 1e-8:
                    continue
                future_bars_df = day_df[day_df.index > bar.name]
                future_bars    = list(zip(future_bars_df['high'], future_bars_df['low']))
                trade = {
                    'entry': entry, 'sl': sl, 'dir': 1,
                    'date': bar.name, 'future_bars': future_bars,
                    'gold_agree': gold_bear,   # gold bearish = USDCHF going UP = correct direction
                }
                trades_all.append(trade)
                if gold_bear:
                    trades_gold.append(trade)
                entry_found = True
                break

    print(f"\n  Signals (no filter) : {len(trades_all)}")
    print(f"  Signals (gold filt) : {len(trades_gold)}")

    for tp_r in tp_r_list:
        print(f"\n  ── TP = {tp_r}R ──────────────────────────────────────────")
        r_all  = simulate(trades_all,  tp_r)
        r_gold = simulate(trades_gold, tp_r)
        m_all  = metrics(r_all,  total_weeks, 'FADE no-filter')
        m_gold = metrics(r_gold, total_weeks, 'FADE gold-filter')
        print(f"    WITHOUT gold filter:")
        print_metrics(m_all, tp_r, indent='      ')
        print(f"    WITH gold filter:")
        print_metrics(m_gold, tp_r, indent='      ')

    return trades_all, trades_gold


# ─────────────────────────────────────────────────────────────────────────────
# TACTIC 5: COMBINED — best setup from T1 + T2 (non-overlapping, priority order)
# ─────────────────────────────────────────────────────────────────────────────
def tactic_combined(chf, total_weeks, tp_r_list,
                    arlb_trades_gold, pdb_trades_gold, label='TACTIC 5'):
    """
    Priority: ARLB fires first if available. PDB fills in days ARLB didn't fire.
    This is the candidate strategy for the Pine indicator.
    """
    print(f"\n{'═'*60}")
    print(f"TACTIC 5: ARLB + PDB Combined (gold filter only, priority order)")
    print(f"{'═'*60}")

    # Get dates ARLB already covered
    arlb_dates = {t['date'].date() for t in arlb_trades_gold}

    # Only add PDB trades on days ARLB didn't fire
    extra_pdb = [t for t in pdb_trades_gold
                 if t['date'].date() not in arlb_dates]

    combined = arlb_trades_gold + extra_pdb

    print(f"\n  ARLB trades      : {len(arlb_trades_gold)}")
    print(f"  PDB fill-in      : {len(extra_pdb)}")
    print(f"  Combined total   : {len(combined)}")

    for tp_r in tp_r_list:
        print(f"\n  ── TP = {tp_r}R ──────────────────────────────────────────")
        r = simulate(combined, tp_r)
        m = metrics(r, total_weeks, 'Combined')
        print_metrics(m, tp_r, indent='    ')

# ─── MAIN ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("=" * 60)
    print(" QB USDCHF — Tactic Extraction from Real Data")
    print("=" * 60)

    chf, gold = download()

    print(f"\nUSDCHF bars : {len(chf):,}  ({chf.index[0].date()} → {chf.index[-1].date()})")
    print(f"Gold bars   : {len(gold):,}  ({gold.index[0].date()} → {gold.index[-1].date()})")

    # Add features
    chf = add_gold_bias(chf, gold, ema_period=50)
    chf = add_atr_daily(chf)
    chf = add_prev_day_levels(chf)

    # Actual correlation
    print_correlation(chf, gold)

    # Total weeks in dataset
    total_weeks = (chf.index[-1] - chf.index[0]).days / 7

    # News summary
    chf['date_str'] = chf.index.strftime('%Y-%m-%d')
    chf['utc_hour'] = chf.index.hour
    chf['dow']      = chf.index.dayofweek
    all_days = set(chf[chf['dow'] <= 4]['date_str'].unique())
    news_overlap = all_days & ALL_NEWS_DAYS
    print(f"Trading days in dataset : {len(all_days)}")
    print(f"News days excluded      : {len(news_overlap)}")
    print(f"Clean days for analysis : {len(all_days) - len(news_overlap)}")
    print(f"News events covered     : {len(SNB_DATES)} SNB + {len(FOMC_DATES)} FOMC + {len(get_nfp_dates())} NFP")

    TP_LIST = [1.5, 2.0, 2.5]

    # Run all tactics
    arlb_all, arlb_gold = tactic_arlb(chf, total_weeks, TP_LIST,
                                       sl_buf_atr=0.15, min_rng_atr=0.25)

    pdb_all, pdb_gold   = tactic_pdb(chf, total_weeks, TP_LIST,
                                      sl_buf_atr=0.15, min_break_atr=0.05)

    loc_all, loc_gold   = tactic_loc(chf, total_weeks, TP_LIST,
                                      sl_buf_atr=0.15, min_body=0.45)

    tactic_combined(chf, total_weeks, TP_LIST, arlb_gold, pdb_gold)

    # FADE TACTIC — reverse of ARLB
    # Data showed ARLB fails 65% → fade the break (institutional liquidity grab)
    tactic_arlb_fade(chf, total_weeks, TP_LIST, sl_buf_atr=0.15, min_rng_atr=0.25)

    print(f"\n{'='*60}")
    print(" EXTRACTION COMPLETE")
    print(f" Criteria: 1-2 trades/week · WR>55% · PF>1.5 · Min yr WR>50%")
    print(f"{'='*60}")
