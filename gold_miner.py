#!/usr/bin/env python3
"""
gold_miner.py — XAUUSD 15M Pattern Discovery Engine
=====================================================
Fetches 6 years of XAUUSD 15M data from Twelve Data (same key the bot already uses),
engineers 50+ features on every bar, then lets a Decision Tree + Random Forest
discover which conditions predict a profitable move — without any preconceived signals.

Requirements:
    pip install pandas numpy scikit-learn requests

Usage:
    1. Set TWELVE_DATA_KEY below (same key in your .env / Vercel env)
    2. python gold_miner.py
    3. Results print to console + 3 CSV files saved locally

What comes out:
    • Conditional WR table  — every condition cross-tabulated vs win rate
    • Decision Tree rules   — auto-discovered "if X and Y and Z → 68% WR"
    • Feature importance    — what actually drives gold price action
    Any row with Est PF ≥ 1.3 and N ≥ 500 over bars is a candidate new signal.
"""

import os, time, warnings
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from sklearn.ensemble import RandomForestClassifier
from sklearn.tree import DecisionTreeClassifier, export_text
warnings.filterwarnings('ignore')

# ═══════════════════════════════════════════════════════════════════════
# CONFIG — edit these
# ═══════════════════════════════════════════════════════════════════════
TWELVE_DATA_KEY = os.getenv('TWELVE_DATA_KEY', 'YOUR_KEY_HERE')
START_DATE      = '2019-12-01'   # free tier limit — data available from ~Dec 2019
END_DATE        = '2025-08-01'

CACHE_FILE      = 'gold_miner_raw.csv'   # local disk cache — survives rate-limit restarts
SLEEP_BETWEEN   = 9      # seconds between requests (free plan: 8/min limit)
RETRY_ON_429    = 90     # seconds to wait before retrying after rate limit

# Strategy params matching our Pine Script best config
ATR_PERIOD   = 14
TP_MULT      = 0.75   # 0.75R = best exit found in backtests
SL_MULT      = 1.0    # 1R stop (Wide SL equivalent)
FORWARD_BARS = 16     # 16 × 15min = 4 hours to hit target

MIN_TRADES   = 100    # minimum occurrences for a pattern to qualify
MIN_WR       = 0.60   # only show patterns with WR ≥ 60%

# ═══════════════════════════════════════════════════════════════════════
# DATA FETCH
# ═══════════════════════════════════════════════════════════════════════
def fetch_chunk(start_str, end_str):
    url = 'https://api.twelvedata.com/time_series'
    params = {
        'symbol':     'XAU/USD',
        'interval':   '15min',
        'start_date': start_str,
        'end_date':   end_str,
        'outputsize': 5000,
        'format':     'JSON',
        'apikey':     TWELVE_DATA_KEY,
    }
    r = requests.get(url, params=params, timeout=30)
    if r.status_code == 429:
        raise RateLimitError("429 Too Many Requests")
    if r.status_code == 400:
        raise DataUnavailableError(f"400 Bad Request (data not in plan range)")
    r.raise_for_status()
    data = r.json()
    if data.get('status') == 'error':
        raise ValueError(f"Twelve Data: {data.get('message')}")
    values = data.get('values', [])
    if not values:
        return pd.DataFrame()
    df = pd.DataFrame(values)
    df['datetime'] = pd.to_datetime(df['datetime'])
    df = df.sort_values('datetime').reset_index(drop=True)
    for col in ['open', 'high', 'low', 'close']:
        df[col] = df[col].astype(float)
    df['volume'] = df.get('volume', pd.Series([0]*len(df))).astype(float)
    return df[['datetime','open','high','low','close','volume']]

class RateLimitError(Exception): pass
class DataUnavailableError(Exception): pass

def fetch_all():
    # ── Resume from disk cache if it exists ──────────────────────────────────
    import os
    cached_end = None
    cached_chunks = []
    if os.path.exists(CACHE_FILE):
        print(f"  Found {CACHE_FILE} — resuming from last saved point...")
        cached_df = pd.read_csv(CACHE_FILE, parse_dates=['datetime'])
        cached_chunks.append(cached_df)
        cached_end = cached_df['datetime'].max()
        resume_from = cached_end + timedelta(minutes=15)
        print(f"  Cache covers up to {str(cached_end)[:10]} ({len(cached_df):,} bars)")
    else:
        resume_from = datetime.strptime(START_DATE, '%Y-%m-%d')

    print(f"\nFetching XAUUSD 15M  {str(resume_from)[:10]} → {END_DATE} ...")
    print(f"  Sleep={SLEEP_BETWEEN}s/req  Retry-on-429={RETRY_ON_429}s\n")

    new_chunks = []
    cur = resume_from
    end = datetime.strptime(END_DATE, '%Y-%m-%d')

    while cur < end:
        nxt = min(cur + timedelta(days=50), end)
        s = cur.strftime('%Y-%m-%d %H:%M:%S')
        e = nxt.strftime('%Y-%m-%d %H:%M:%S')

        while True:   # retry loop for 429
            try:
                ch = fetch_chunk(s, e)
                if not ch.empty:
                    new_chunks.append(ch)
                    print(f"  ✓ {s[:10]} → {e[:10]}  {len(ch)} bars")
                else:
                    print(f"  ○ {s[:10]} → {e[:10]}  no data")
                break
            except RateLimitError:
                print(f"  ⏳ Rate limited — waiting {RETRY_ON_429}s then retrying {s[:10]}...")
                # Save what we have before waiting
                if new_chunks:
                    _save_cache(cached_chunks + new_chunks)
                time.sleep(RETRY_ON_429)
            except DataUnavailableError as ex:
                print(f"  ✗ {s[:10]} → {e[:10]}  {ex} (skipping)")
                break
            except Exception as ex:
                print(f"  ✗ {s[:10]} → {e[:10]}  {ex} (skipping)")
                break

        cur = nxt + timedelta(days=1)
        time.sleep(SLEEP_BETWEEN)

    all_chunks = cached_chunks + new_chunks
    if not all_chunks:
        raise RuntimeError("No data fetched. Check TWELVE_DATA_KEY and plan limits.")

    df = pd.concat(all_chunks, ignore_index=True)
    df = df.drop_duplicates('datetime').sort_values('datetime').reset_index(drop=True)

    # Save full cache to disk
    _save_cache([df])
    print(f"\n✓ Total bars: {len(df):,}  ({str(df['datetime'].min())[:10]} → {str(df['datetime'].max())[:10]})\n")
    return df

def _save_cache(chunks):
    combined = pd.concat(chunks, ignore_index=True)
    combined = combined.drop_duplicates('datetime').sort_values('datetime').reset_index(drop=True)
    combined.to_csv(CACHE_FILE, index=False)
    print(f"  💾 Cache saved: {CACHE_FILE} ({len(combined):,} bars)")

# ═══════════════════════════════════════════════════════════════════════
# FEATURE ENGINEERING
# ═══════════════════════════════════════════════════════════════════════
def _atr(df, p=14):
    h, l, c = df['high'], df['low'], df['close']
    tr = pd.concat([(h-l), (h-c.shift(1)).abs(), (l-c.shift(1)).abs()], axis=1).max(axis=1)
    return tr.ewm(span=p, adjust=False).mean()

def _htf_bias(df, tf_min, ema_p):
    """Compute EMA bias on a higher timeframe, map back to 15M index."""
    htf = df.set_index('datetime').resample(f'{tf_min}min').agg(
        {'open':'first','high':'max','low':'min','close':'last'}).dropna()
    htf['ema']  = htf['close'].ewm(span=ema_p, adjust=False).mean()
    htf['bias'] = np.where(htf['close'] > htf['ema'], 1,
                  np.where(htf['close'] < htf['ema'], -1, 0))
    merged = df.set_index('datetime')[[]].join(htf[['bias']], how='left')
    return merged['bias'].ffill().fillna(0).astype(int).values

def engineer(df):
    print("Engineering features...")
    d = df.copy()
    safe_atr = lambda s: s.replace(0, np.nan)

    # ── Time ─────────────────────────────────────────────────────────────────
    d['hour_utc']     = d['datetime'].dt.hour
    d['min_of_day']   = d['hour_utc'] * 60 + d['datetime'].dt.minute
    d['day_of_week']  = d['datetime'].dt.dayofweek   # 0=Mon 4=Fri
    d['month']        = d['datetime'].dt.month
    for i, name in enumerate(['mon','tue','wed','thu','fri']):
        d[f'is_{name}'] = (d['day_of_week'] == i).astype(int)

    # ── Sessions (UTC) ────────────────────────────────────────────────────────
    m = d['min_of_day']
    d['in_asian']         = ((m >= 0)   & (m < 480)).astype(int)
    d['in_frankfurt_win'] = ((m >= 420) & (m < 450)).astype(int)  # FRB range window
    d['in_frb_trade']     = ((m >= 450) & (m < 660)).astype(int)  # FRB trade window
    d['in_london']        = ((m >= 480) & (m < 660)).astype(int)
    d['in_ny_overlap']    = ((m >= 780) & (m < 1020)).astype(int)
    d['in_ny_orb_win']    = ((m >= 840) & (m < 870)).astype(int)  # NY ORB range
    d['in_ny_orb_trade']  = ((m >= 870) & (m < 1020)).astype(int) # NY ORB trade
    d['in_silver_bullet'] = ((m >= 900) & (m < 960)).astype(int)
    d['in_pm_fix']        = ((m >= 720) & (m < 750)).astype(int)  # 12:00 UTC
    d['in_pre_ny']        = ((m >= 780) & (m < 840)).astype(int)  # 13:00-14:00

    # ── ATR ───────────────────────────────────────────────────────────────────
    d['atr'] = _atr(d, ATR_PERIOD)
    atr_s    = safe_atr(d['atr'])

    # ── Candlestick ───────────────────────────────────────────────────────────
    d['body']       = (d['close'] - d['open']).abs()
    d['body_dir']   = np.sign(d['close'] - d['open'])
    d['up_wick']    = d['high'] - d[['close','open']].max(axis=1)
    d['dn_wick']    = d[['close','open']].min(axis=1) - d['low']
    d['bar_range']  = d['high'] - d['low']

    d['body_atr']    = d['body']      / atr_s
    d['up_wick_atr'] = d['up_wick']   / atr_s
    d['dn_wick_atr'] = d['dn_wick']   / atr_s
    d['range_atr']   = d['bar_range'] / atr_s

    d['is_bull']     = (d['body_dir'] ==  1).astype(int)
    d['is_bear']     = (d['body_dir'] == -1).astype(int)
    d['is_doji']     = (d['body_atr'] < 0.15).astype(int)
    d['is_large']    = (d['range_atr'] > 1.5).astype(int)
    d['is_small']    = (d['range_atr'] < 0.4).astype(int)

    # Pin bar: wick > 2× body
    d['bull_pin']  = ((d['dn_wick'] > 2*d['body']) & (d['body_atr'] < 0.6)).astype(int)
    d['bear_pin']  = ((d['up_wick'] > 2*d['body']) & (d['body_atr'] < 0.6)).astype(int)

    # Inside / outside / engulfing
    d['inside_bar']   = ((d['high'] < d['high'].shift(1)) & (d['low'] > d['low'].shift(1))).astype(int)
    d['outside_bar']  = ((d['high'] > d['high'].shift(1)) & (d['low'] < d['low'].shift(1))).astype(int)
    d['bull_engulf']  = ((d['close'] > d['open'].shift(1)) & (d['open'] < d['close'].shift(1)) & (d['body_dir'].shift(1) == -1)).astype(int)
    d['bear_engulf']  = ((d['close'] < d['open'].shift(1)) & (d['open'] > d['close'].shift(1)) & (d['body_dir'].shift(1) ==  1)).astype(int)

    # ── Momentum ──────────────────────────────────────────────────────────────
    bull = (d['close'] > d['open']).astype(int)
    bear = (d['close'] < d['open']).astype(int)
    d['consec_bull'] = bull.groupby((bull==0).cumsum()).cumcount().add(bull).clip(0,5)
    d['consec_bear'] = bear.groupby((bear==0).cumsum()).cumcount().add(bear).clip(0,5)
    d['ret_1bar']    = (d['close'] - d['close'].shift(1)) / atr_s
    d['ret_4bar']    = (d['close'] - d['close'].shift(4)) / atr_s

    # ── ADR consumed ──────────────────────────────────────────────────────────
    d['date']       = d['datetime'].dt.date
    d['day_hi']     = d.groupby('date')['high'].transform('cummax')
    d['day_lo']     = d.groupby('date')['low'].transform('cummin')
    d['day_atr']    = d.groupby('date')['atr'].transform('first')
    d['adr']        = (d['day_hi'] - d['day_lo']) / safe_atr(d['day_atr'])
    d['adr_lt40']   = (d['adr'] < 0.40).astype(int)
    d['adr_40_65']  = ((d['adr'] >= 0.40) & (d['adr'] < 0.65)).astype(int)
    d['adr_65_90']  = ((d['adr'] >= 0.65) & (d['adr'] < 0.90)).astype(int)
    d['adr_gt90']   = (d['adr'] >= 0.90).astype(int)

    # ── Round number proximity ────────────────────────────────────────────────
    d['dist50']  = d['close'].apply(lambda x: min(x % 50, 50 - x % 50))
    d['dist100'] = d['close'].apply(lambda x: min(x % 100, 100 - x % 100))
    d['near50']  = (d['dist50']  < 2.0).astype(int)
    d['near100'] = (d['dist100'] < 2.0).astype(int)

    # ── Asian range ───────────────────────────────────────────────────────────
    asian_mask  = d['hour_utc'] < 8
    asian_hi    = d[asian_mask].groupby('date')['high'].max()
    asian_lo    = d[asian_mask].groupby('date')['low'].min()
    d['ar_hi']  = d['date'].map(asian_hi)
    d['ar_lo']  = d['date'].map(asian_lo)
    d['ar_sz']  = (d['ar_hi'] - d['ar_lo']) / atr_s
    d['above_ar'] = (d['close'] > d['ar_hi']).astype(int)
    d['below_ar'] = (d['close'] < d['ar_lo']).astype(int)
    d['in_ar']    = ((d['close'] <= d['ar_hi']) & (d['close'] >= d['ar_lo'])).astype(int)
    # Sweep + close back: SFP signal
    d['bull_sfp'] = ((d['low'] < d['ar_lo']) & (d['close'] > d['ar_lo'])).astype(int)
    d['bear_sfp'] = ((d['high'] > d['ar_hi']) & (d['close'] < d['ar_hi'])).astype(int)

    # ── HTF bias ──────────────────────────────────────────────────────────────
    print("  Computing H1 + H4 EMA-20 bias (takes ~30s)...")
    d['h1_bias'] = _htf_bias(d, 60,  20)
    d['h4_bias'] = _htf_bias(d, 240, 20)

    # ── Prior bar ─────────────────────────────────────────────────────────────
    d['prev_bull']  = d['is_bull'].shift(1).fillna(0).astype(int)
    d['prev_bear']  = d['is_bear'].shift(1).fillna(0).astype(int)
    d['prev_large'] = d['is_large'].shift(1).fillna(0).astype(int)

    # ── Seasonality ───────────────────────────────────────────────────────────
    d['is_sep']  = (d['month'] == 9).astype(int)
    d['is_jan']  = (d['month'] == 1).astype(int)
    d['is_nfp']  = ((d['day_of_week'] == 4) & (d['datetime'].dt.day <= 7)).astype(int)

    print(f"  ✓ Done — {len(d)} bars, {len(FEATURES)} features\n")
    return d

# Feature list used for ML
FEATURES = [
    'hour_utc','min_of_day','day_of_week','month',
    'is_mon','is_tue','is_wed','is_thu','is_fri',
    'in_asian','in_frankfurt_win','in_frb_trade','in_london',
    'in_ny_overlap','in_ny_orb_win','in_ny_orb_trade',
    'in_silver_bullet','in_pm_fix','in_pre_ny',
    'is_bull','is_bear','is_doji','is_large','is_small',
    'bull_pin','bear_pin','inside_bar','outside_bar',
    'bull_engulf','bear_engulf',
    'body_atr','up_wick_atr','dn_wick_atr','range_atr',
    'consec_bull','consec_bear','ret_1bar','ret_4bar',
    'adr_lt40','adr_40_65','adr_65_90','adr_gt90',
    'near50','near100',
    'ar_sz','above_ar','below_ar','in_ar','bull_sfp','bear_sfp',
    'h1_bias','h4_bias',
    'prev_bull','prev_bear','prev_large',
    'is_sep','is_jan','is_nfp',
]

# ═══════════════════════════════════════════════════════════════════════
# LABELING
# ═══════════════════════════════════════════════════════════════════════
def label(df):
    """
    For every bar: simulate long and short entry at bar close.
    TP = close ± TP_MULT × ATR,  SL = close ∓ SL_MULT × ATR
    Look forward FORWARD_BARS to see which hits first.
    """
    print("Labeling forward outcomes (this takes ~1 min)...")
    n      = len(df)
    closes = df['close'].values
    highs  = df['high'].values
    lows   = df['low'].values
    atrs   = df['atr'].values

    long_win  = np.zeros(n, dtype=np.int8)
    short_win = np.zeros(n, dtype=np.int8)

    for i in range(n - FORWARD_BARS):
        atr = atrs[i]
        if atr <= 0:
            continue
        entry = closes[i]
        tp_l, sl_l = entry + TP_MULT*atr, entry - SL_MULT*atr
        tp_s, sl_s = entry - TP_MULT*atr, entry + SL_MULT*atr
        for j in range(i+1, i+FORWARD_BARS+1):
            if highs[j] >= tp_l: long_win[i]  = 1; break
            if lows[j]  <= sl_l: break
        for j in range(i+1, i+FORWARD_BARS+1):
            if lows[j]  <= tp_s: short_win[i] = 1; break
            if highs[j] >= sl_s: break

    df = df.copy()
    df['long_win']  = long_win
    df['short_win'] = short_win

    l_wr = long_win.mean();  s_wr = short_win.mean()
    print(f"  Baseline LONG  WR (all bars): {l_wr:.1%}  ({long_win.sum():,} wins)")
    print(f"  Baseline SHORT WR (all bars): {s_wr:.1%}  ({short_win.sum():,} wins)")
    print()
    return df

# ═══════════════════════════════════════════════════════════════════════
# CONDITIONAL WR TABLE
# ═══════════════════════════════════════════════════════════════════════
def cond_table(df, target):
    """Cross-tabulate hand-crafted condition combinations vs WR."""
    t   = df[target]
    atr = df['atr']

    conditions = {
        # ── Session × HTF bias ────────────────────────────────────────────────
        'All bars (baseline)':                  pd.Series(True, index=df.index),
        'London':                               df['in_london']==1,
        'London + H4↑':                         (df['in_london']==1)&(df['h4_bias']==1),
        'London + H4↓':                         (df['in_london']==1)&(df['h4_bias']==-1),
        'London + H1↑ + H4↑':                  (df['in_london']==1)&(df['h1_bias']==1)&(df['h4_bias']==1),
        'Frankfurt trade window':               df['in_frb_trade']==1,
        'Frankfurt trade + H4↑':               (df['in_frb_trade']==1)&(df['h4_bias']==1),
        'Frankfurt trade + H4↓':               (df['in_frb_trade']==1)&(df['h4_bias']==-1),
        'NY ORB trade window':                  df['in_ny_orb_trade']==1,
        'NY ORB trade + H4↑':                  (df['in_ny_orb_trade']==1)&(df['h4_bias']==1),
        'NY ORB trade + H4↓':                  (df['in_ny_orb_trade']==1)&(df['h4_bias']==-1),
        'Silver Bullet window':                 df['in_silver_bullet']==1,
        'Silver Bullet + H4↑':                 (df['in_silver_bullet']==1)&(df['h4_bias']==1),
        'PM Fix window (12:00 UTC)':            df['in_pm_fix']==1,
        'Pre-NY (13:00-14:00 UTC)':             df['in_pre_ny']==1,
        # ── Session × ADR ──────────────────────────────────────────────────────
        'London + ADR<40%':                     (df['in_london']==1)&(df['adr_lt40']==1),
        'London + ADR<40% + H4↑':              (df['in_london']==1)&(df['adr_lt40']==1)&(df['h4_bias']==1),
        'Frankfurt + ADR<40%':                  (df['in_frb_trade']==1)&(df['adr_lt40']==1),
        'Frankfurt + ADR<40% + H4↑':           (df['in_frb_trade']==1)&(df['adr_lt40']==1)&(df['h4_bias']==1),
        'NY ORB + ADR<40%':                     (df['in_ny_orb_trade']==1)&(df['adr_lt40']==1),
        'NY ORB + ADR>90% (skip candidate)':    (df['in_ny_orb_trade']==1)&(df['adr_gt90']==1),
        # ── Candle patterns ────────────────────────────────────────────────────
        'Bull pin bar (any session)':           df['bull_pin']==1,
        'Bear pin bar (any session)':           df['bear_pin']==1,
        'Bull pin + London':                    (df['bull_pin']==1)&(df['in_london']==1),
        'Bear pin + London':                    (df['bear_pin']==1)&(df['in_london']==1),
        'Bull pin + London + H4↑':             (df['bull_pin']==1)&(df['in_london']==1)&(df['h4_bias']==1),
        'Bear pin + London + H4↓':             (df['bear_pin']==1)&(df['in_london']==1)&(df['h4_bias']==-1),
        'Bull engulf + London':                 (df['bull_engulf']==1)&(df['in_london']==1),
        'Bear engulf + London':                 (df['bear_engulf']==1)&(df['in_london']==1),
        'Bull engulf + H4↑':                   (df['bull_engulf']==1)&(df['h4_bias']==1),
        'Bear engulf + H4↓':                   (df['bear_engulf']==1)&(df['h4_bias']==-1),
        'Bull engulf + London + H4↑':          (df['bull_engulf']==1)&(df['in_london']==1)&(df['h4_bias']==1),
        'Bear engulf + London + H4↓':          (df['bear_engulf']==1)&(df['in_london']==1)&(df['h4_bias']==-1),
        'Inside bar breakout + London':         (df['inside_bar']==1)&(df['in_london']==1),
        'Large bar + London':                   (df['is_large']==1)&(df['in_london']==1),
        # ── Asian SFP ─────────────────────────────────────────────────────────
        'Bear SFP (swept Asian Hi) + Frankfurt':(df['bear_sfp']==1)&(df['in_frb_trade']==1),
        'Bull SFP (swept Asian Lo) + Frankfurt':(df['bull_sfp']==1)&(df['in_frb_trade']==1),
        'Bear SFP + London':                    (df['bear_sfp']==1)&(df['in_london']==1),
        'Bull SFP + London':                    (df['bull_sfp']==1)&(df['in_london']==1),
        'Bear SFP + H4↓':                      (df['bear_sfp']==1)&(df['h4_bias']==-1),
        'Bull SFP + H4↑':                      (df['bull_sfp']==1)&(df['h4_bias']==1),
        # ── Round numbers ──────────────────────────────────────────────────────
        'Near $50 round number':                df['near50']==1,
        'Near $100 round number':               df['near100']==1,
        'Near $50 + London':                    (df['near50']==1)&(df['in_london']==1),
        'Near $100 + London':                   (df['near100']==1)&(df['in_london']==1),
        # ── Asian range position ───────────────────────────────────────────────
        'Above Asian Hi + London':              (df['above_ar']==1)&(df['in_london']==1),
        'Below Asian Lo + London':              (df['below_ar']==1)&(df['in_london']==1),
        'Inside Asian range + London':          (df['in_ar']==1)&(df['in_london']==1),
        # ── Day of week ────────────────────────────────────────────────────────
        'Monday':                               df['is_mon']==1,
        'Tuesday':                              df['is_tue']==1,
        'Wednesday':                            df['is_wed']==1,
        'Thursday':                             df['is_thu']==1,
        'Friday':                               df['is_fri']==1,
        'Monday + London':                      (df['is_mon']==1)&(df['in_london']==1),
        'Tuesday + London':                     (df['is_tue']==1)&(df['in_london']==1),
        'Wednesday + London':                   (df['is_wed']==1)&(df['in_london']==1),
        # ── Seasonality ───────────────────────────────────────────────────────
        'September':                            df['is_sep']==1,
        'January':                              df['is_jan']==1,
        'NFP day (first Friday)':               df['is_nfp']==1,
        'Skip NFP (no first Friday)':           df['is_nfp']==0,
    }

    rows = []
    for name, mask in conditions.items():
        sub  = t[mask]
        n    = len(sub)
        w    = int(sub.sum())
        wr   = w / n if n > 0 else 0
        pf   = (wr * TP_MULT) / ((1-wr) * SL_MULT) if 0 < wr < 1 else 0
        rows.append({'Condition': name, 'N': n, 'Wins': w, 'WR': wr, 'Est_PF': round(pf,3)})

    return pd.DataFrame(rows).sort_values('Est_PF', ascending=False).reset_index(drop=True)

# ═══════════════════════════════════════════════════════════════════════
# DECISION TREE — auto-discovered rules
# ═══════════════════════════════════════════════════════════════════════
def decision_tree(df, target, label):
    valid = df.dropna(subset=FEATURES+[target])
    X = valid[FEATURES].fillna(0)
    y = valid[target]

    dt = DecisionTreeClassifier(
        max_depth=4,
        min_samples_leaf=MIN_TRADES,
        class_weight='balanced',
        random_state=42,
    )
    dt.fit(X, y)

    # Leaf stats
    leaf_ids = dt.apply(X.values)
    rows = []
    for lf in np.unique(leaf_ids):
        mask = leaf_ids == lf
        n    = mask.sum()
        w    = y.values[mask].sum()
        wr   = w/n if n>0 else 0
        pf   = (wr*TP_MULT)/((1-wr)*SL_MULT) if 0<wr<1 else 0
        if n >= MIN_TRADES and wr >= MIN_WR:
            rows.append({'leaf':lf,'N':n,'Wins':w,'WR':wr,'Est_PF':round(pf,3)})

    print(f"\n  Auto-discovered leaves (min {MIN_TRADES} samples, WR≥{MIN_WR:.0%}):")
    if rows:
        res = pd.DataFrame(rows).sort_values('Est_PF', ascending=False)
        print(f"  {'Leaf':>5}  {'N':>7}  {'Wins':>6}  {'WR':>6}  {'Est PF':>7}")
        print(f"  {'-'*42}")
        for _, r in res.iterrows():
            star = '★★★' if r.Est_PF>=1.5 else '★★' if r.Est_PF>=1.3 else '★' if r.Est_PF>=1.2 else ''
            print(f"  {int(r.leaf):>5}  {int(r.N):>7}  {int(r.Wins):>6}  {r.WR:>6.1%}  {r.Est_PF:>7.3f}  {star}")
    else:
        print("  (none met threshold — try lowering MIN_TRADES or MIN_WR)")

    print(f"\n  Full tree rules ({label}):")
    print(export_text(dt, feature_names=FEATURES, max_depth=4))
    return dt

# ═══════════════════════════════════════════════════════════════════════
# RANDOM FOREST — feature importance
# ═══════════════════════════════════════════════════════════════════════
def random_forest(df, target, label):
    valid = df.dropna(subset=FEATURES+[target])
    X = valid[FEATURES].fillna(0)
    y = valid[target]

    rf = RandomForestClassifier(
        n_estimators=300, max_depth=8, min_samples_leaf=50,
        class_weight='balanced', n_jobs=-1, random_state=42,
    )
    rf.fit(X, y)

    imp = pd.Series(rf.feature_importances_, index=FEATURES).sort_values(ascending=False)
    print(f"\n  RF Feature Importance — {label}:")
    print(f"  {'Feature':<25} {'Importance':>10}  Bar")
    print(f"  {'-'*55}")
    for feat, v in imp.head(20).items():
        bar = '█' * int(v * 80)
        print(f"  {feat:<25} {v:>10.4f}  {bar}")
    return imp

# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════
def sep(title=''):
    w = 68
    print('\n' + '═'*w)
    if title:
        pad = (w - len(title) - 2) // 2
        print(' '*pad + ' ' + title + ' ' + ' '*pad)
        print('═'*w)

def print_table(tbl, top=40):
    print(f"\n  {'Condition':<43} {'N':>7}  {'WR':>6}  {'Est PF':>7}")
    print(f"  {'-'*68}")
    for _, r in tbl.head(top).iterrows():
        star = '  ★★★' if r.Est_PF>=1.5 else '  ★★' if r.Est_PF>=1.3 else '  ★' if r.Est_PF>=1.2 else ''
        mark = '  ✕' if r.Est_PF < 0.95 else ''
        print(f"  {r.Condition:<43} {int(r.N):>7}  {r.WR:>6.1%}  {r.Est_PF:>7.3f}{star}{mark}")

def main():
    sep('GOLD PATTERN MINER — XAUUSD 15M')
    print(f"  TP = {TP_MULT}R   SL = {SL_MULT}R   Forward window = {FORWARD_BARS} bars ({FORWARD_BARS*15}min)")
    print(f"  Min trades per pattern: {MIN_TRADES}   Min WR to report: {MIN_WR:.0%}")

    if TWELVE_DATA_KEY == 'YOUR_KEY_HERE':
        print("\n⚠  Set TWELVE_DATA_KEY at the top of this file")
        print("   Same key already used in your Vercel env / .env file")
        return

    # 1. Fetch
    df = fetch_all()

    # 2. Features
    df = engineer(df)

    # 3. Labels
    df = label(df)

    # 4. Conditional WR tables
    sep('LONG ENTRIES — Which conditions predict UP moves?')
    l_tbl = cond_table(df, 'long_win')
    print_table(l_tbl)

    sep('SHORT ENTRIES — Which conditions predict DOWN moves?')
    s_tbl = cond_table(df, 'short_win')
    print_table(s_tbl)

    # 5. Decision tree rules
    sep('AUTO-DISCOVERED RULES — LONG (Decision Tree)')
    decision_tree(df, 'long_win',  'LONG')

    sep('AUTO-DISCOVERED RULES — SHORT (Decision Tree)')
    decision_tree(df, 'short_win', 'SHORT')

    # 6. Feature importance
    sep('FEATURE IMPORTANCE — What actually drives GOLD direction?')
    l_imp = random_forest(df, 'long_win',  'LONG')
    s_imp = random_forest(df, 'short_win', 'SHORT')

    # 7. Save
    df.to_csv('gold_miner_bars.csv', index=False)
    l_tbl.to_csv('gold_long_patterns.csv',  index=False)
    s_tbl.to_csv('gold_short_patterns.csv', index=False)

    sep('SUMMARY')
    print("\n  Files saved:")
    print("    gold_miner_bars.csv        — full bar dataset with all features + labels")
    print("    gold_long_patterns.csv     — ranked long conditions")
    print("    gold_short_patterns.csv    — ranked short conditions")
    print("\n  How to read the results:")
    print("    Est PF ≥ 1.3 + N ≥ 500  →  candidate signal (backtest in Pine Script)")
    print("    Est PF < 1.0             →  this condition actively hurts (avoid or reverse)")
    print("    Decision Tree leaf       →  exact if/else rule ready for Pine Script")
    print("\n  Next step: take the top 3-5 patterns, code them as new signals A-Z,")
    print("  run the 6-year Pine Script backtest, verify PF ≥ 1.3 on real fills.")
    print()

if __name__ == '__main__':
    main()
