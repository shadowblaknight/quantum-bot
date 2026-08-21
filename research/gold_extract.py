"""
QB Gold Specialist — Python Extraction & Validation v2
=======================================================
Replicates the exact logic of qb-gold-specialist.pine on real GC=F H1 data.

Root-cause fix: ADR was using full-day resample (lookahead bias), giving
values of 3-10x instead of 0-1x. All gates blocked. Now uses:
  - d_atr : 14-day EMA of daily ranges (shifted 1 day, fully known)
  - adr   : running intraday range up to current bar / d_atr (no lookahead)

Setups:
  A) FVG Retest   — London/NY overlap, BOS required
  B) Judas Sweep  — Asian range sweep during London, closes back inside
  C) Silver Bullet— FVG retest locked 15:00-16:00 UTC
  D) Psych Level  — 50pt/100pt gold bounce during kill zones
  M) Frankfurt ORB— SHORT only, H1+H4 bearish, below Asian low
  H) NY ORB       — Both directions, 14:00 UTC range break

Pass criteria: 0.5-3 trades/wk · WR>55% · PF>1.5 · Min yr WR>50%
"""

import pandas as pd
import numpy as np
import yfinance as yf
from scipy import stats
import warnings
warnings.filterwarnings('ignore')

# ─── NEWS DATES ───────────────────────────────────────────────────────────────
FOMC_DATES = {
    '2022-01-26','2022-03-16','2022-05-04','2022-06-15',
    '2022-07-27','2022-09-21','2022-11-02','2022-12-14',
    '2023-02-01','2023-03-22','2023-05-03','2023-06-14',
    '2023-07-26','2023-09-20','2023-11-01','2023-12-13',
    '2024-01-31','2024-03-20','2024-05-01','2024-06-12',
    '2024-07-31','2024-09-18','2024-11-07','2024-12-18',
    '2025-01-29','2025-03-19','2025-05-07','2025-06-18',
    '2025-07-30','2025-09-17',
}
US_CPI_DATES = {
    '2024-01-11','2024-02-13','2024-03-12','2024-04-10',
    '2024-05-15','2024-06-12','2024-07-11','2024-08-14',
    '2024-09-11','2024-10-10','2024-11-13','2024-12-11',
    '2025-01-15','2025-02-12','2025-03-12','2025-04-10',
    '2025-05-13','2025-06-11','2025-07-15','2025-08-12',
}
def get_nfp_dates():
    dates = set()
    for ms in pd.date_range('2022-01-01','2026-06-01', freq='MS'):
        d = ms
        while d.weekday() != 4:
            d += pd.Timedelta(days=1)
        dates.add(d.strftime('%Y-%m-%d'))
    return dates

ALL_NEWS_DAYS = FOMC_DATES | US_CPI_DATES | get_nfp_dates()

def is_news_day(s): return s in ALL_NEWS_DAYS

# ─── DOWNLOAD ─────────────────────────────────────────────────────────────────
def download():
    print("Downloading GC=F H1 (2 years) …")
    df = yf.download("GC=F", period="2y", interval="1h",
                     auto_adjust=True, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df.columns = [c.lower() for c in df.columns]
    df.index = df.index.tz_convert('UTC')
    df = df.dropna(subset=['open','high','low','close'])
    return df

# ─── FEATURES ─────────────────────────────────────────────────────────────────
def build_features(df, ema_p=20):
    # ── ATR (H1) ──────────────────────────────────────────────────────────────
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift(1)).abs(),
        (df['low']  - df['close'].shift(1)).abs(),
    ], axis=1).max(axis=1)
    df['atr'] = tr.ewm(span=14, adjust=False).mean()

    # ── Candle metrics ─────────────────────────────────────────────────────────
    rng = (df['high'] - df['low']).clip(lower=1e-6)
    df['bull_bod'] = np.where(df['close'] > df['open'],
                               (df['close']-df['open'])/rng, 0.0)
    df['bear_bod'] = np.where(df['close'] < df['open'],
                               (df['open']-df['close'])/rng, 0.0)

    # ── Session (all UTC) ──────────────────────────────────────────────────────
    h   = df.index.hour
    dow = df.index.dayofweek
    df['utc_hour'] = h
    df['dow']      = dow
    df['date_str'] = df.index.strftime('%Y-%m-%d')

    wd = dow <= 4
    df['in_asian']   = (h < 8)                              & wd
    df['in_london']  = ((h >= 8)  & (h < 11))              & wd
    df['in_overlap'] = ((h >= 13) & (h < 17))              & wd
    df['in_kz']      = (((h >= 8) & (h < 11)) | ((h >= 13) & (h < 17))) & wd
    df['in_sb']      = (h == 15)                            & wd
    df['in_frb_win'] = (h == 7)                             & wd
    df['in_frb_trd'] = ((h >= 8) & (h < 11))               & wd
    df['in_nyorb_w'] = (h == 14)                            & wd
    df['in_nyorb_e'] = ((h >= 15) & (h < 18))              & wd

    # ── HTF bias (H1, H4, D) — EMA20, 1-bar lag ───────────────────────────────
    h1_ema = df['close'].ewm(span=ema_p, adjust=False).mean().shift(1)
    df['h1_bias'] = np.sign(df['close'] - h1_ema).fillna(0).astype(int)

    h4_cl  = df['close'].resample('4h').last().dropna()
    h4_ema = h4_cl.ewm(span=ema_p, adjust=False).mean().shift(1)
    h4b    = pd.Series(np.sign(h4_cl - h4_ema).fillna(0).astype(int), index=h4_cl.index)
    df['h4_bias'] = h4b.reindex(df.index, method='ffill').fillna(0).astype(int)

    d_cl   = df['close'].resample('1D').last().dropna()
    d_ema  = d_cl.ewm(span=ema_p, adjust=False).mean().shift(1)
    db     = pd.Series(np.sign(d_cl - d_ema).fillna(0).astype(int), index=d_cl.index)
    df['d_bias'] = db.reindex(df.index, method='ffill').fillna(0).astype(int)

    # ── ADR (FIXED — no lookahead) ─────────────────────────────────────────────
    # Denominator: 14-day EMA of (daily high − daily low), shifted 1 day
    d_hi_s = df['high'].resample('1D').max()
    d_lo_s = df['low'].resample('1D').min()
    d_rng  = (d_hi_s - d_lo_s).ewm(span=14, adjust=False).mean().shift(1)
    df['d_atr'] = d_rng.reindex(df.index, method='ffill')

    # Numerator: running H/L within today shifted 1 bar (bar i gets max of bars 0..i-1)
    df['r_hi'] = (df.groupby('date_str')['high']
                  .transform(lambda x: x.expanding().max())
                  .shift(1))
    df['r_lo'] = (df.groupby('date_str')['low']
                  .transform(lambda x: x.expanding().min())
                  .shift(1))

    df['adr'] = ((df['r_hi'] - df['r_lo']).clip(lower=0)
                 / df['d_atr'].clip(lower=1e-6))

    return df

# ─── SIMULATE & METRICS ───────────────────────────────────────────────────────
def simulate(trades, tp_r):
    results = []
    for t in trades:
        entry = t['entry']; sl = t['sl']; d = t['dir']
        sl_d  = abs(entry - sl)
        if sl_d < 1e-6: continue
        tp_lvl = entry + d * sl_d * tp_r
        outcome = None
        for bh, bl in t['future_bars']:
            if d == 1:
                if bl <= sl:       outcome = -1.0; break
                if bh >= tp_lvl:   outcome =  tp_r; break
            else:
                if bh >= sl:       outcome = -1.0; break
                if bl <= tp_lvl:   outcome =  tp_r; break
        results.append({'pnl': outcome if outcome is not None else -1.0,
                        'date': t['date'], 'dir': d})
    return results

def metrics(results, total_weeks, label=''):
    if len(results) < 10: return None
    df  = pd.DataFrame(results)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    wins = df['pnl'] > 0
    n    = len(df)
    wr   = wins.sum() / n
    gp   = df.loc[wins,  'pnl'].sum()
    gl   = df.loc[~wins, 'pnl'].abs().sum()
    pf   = (gp/gl) if gl > 0 else 999.0
    tpw  = n / total_weeks
    yr_wr = df.groupby(df['date'].dt.year).apply(lambda g: (g['pnl']>0).mean()).to_dict()
    min_yr = min(yr_wr.values()) if yr_wr else 0.0
    try:
        bp = stats.binomtest(int(wins.sum()), n, 0.5, alternative='greater').pvalue
    except Exception:
        bp = 1.0
    return {'n': n, 'tpw': round(tpw,2),
            'wr': round(wr*100,1), 'pf': round(pf,3),
            'min_yr_wr': round(min_yr*100,1),
            'yr_wr': {y: round(v*100,1) for y,v in yr_wr.items()},
            'binom_p': round(bp,4), 'sig': bp < 0.05}

def print_m(m, indent='  '):
    if m is None: print(f"{indent}< 10 trades"); return
    passed = (0.5<=m['tpw']<=3.0 and m['wr']>=55 and
              m['pf']>=1.5 and m['min_yr_wr']>=50)
    tag    = '  ★ PASSES ALL CRITERIA' if passed else ''
    sig    = '✅ significant' if m['sig'] else '⚠️  not significant'
    print(f"{indent}Trades   : {m['n']}  ({m['tpw']}/wk){tag}")
    print(f"{indent}Win rate : {m['wr']}%")
    print(f"{indent}PF       : {m['pf']}")
    print(f"{indent}Min yr WR: {m['min_yr_wr']}%  {m['yr_wr']}")
    print(f"{indent}p-value  : {m['binom_p']}  {sig}")

# ─── SETUP B: JUDAS SWEEP ─────────────────────────────────────────────────────
def setup_judas(df, total_weeks, tp_list):
    print(f"\n{'═'*60}")
    print("SETUP B: Judas Sweep")
    print("  Asian 00-07 UTC range | London 08-10 UTC first sweep+reverse")
    print(f"{'═'*60}")

    t_all = []; t_any = []; t_both = []
    for date_str, day in df.groupby('date_str'):
        if is_news_day(date_str) or day['dow'].iloc[0] > 4: continue
        asian  = day[day['in_asian']]
        london = day[day['in_london']]
        if len(asian) < 2 or len(london) == 0: continue
        d_atr = day['d_atr'].iloc[0]
        if pd.isna(d_atr) or d_atr <= 0: continue

        ar_hi = asian['high'].max(); ar_lo = asian['low'].min()
        done_hi = done_lo = False

        for _, bar in london.iterrows():
            if bar['adr'] >= 0.90: continue
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr*0.25
            h1b = int(bar['h1_bias']); h4b = int(bar['h4_bias'])

            if not done_hi and bar['high'] > ar_hi and bar['close'] < ar_hi:
                if (bar['high'] - ar_hi) >= atr * 0.15:
                    sl  = bar['high'] + atr * 0.20
                    fb  = day[day.index > bar.name]
                    fut = list(zip(fb['high'], fb['low']))
                    t   = {'entry': ar_hi, 'sl': sl, 'dir': -1,
                           'date': bar.name, 'future_bars': fut}
                    t_all.append(t)
                    if h1b == -1 or h4b == -1: t_any.append(t)
                    if h1b == -1 and h4b == -1: t_both.append(t)
                    done_hi = True

            if not done_lo and bar['low'] < ar_lo and bar['close'] > ar_lo:
                if (ar_lo - bar['low']) >= atr * 0.15:
                    sl  = bar['low'] - atr * 0.20
                    fb  = day[day.index > bar.name]
                    fut = list(zip(fb['high'], fb['low']))
                    t   = {'entry': ar_lo, 'sl': sl, 'dir': 1,
                           'date': bar.name, 'future_bars': fut}
                    t_all.append(t)
                    if h1b == 1 or h4b == 1: t_any.append(t)
                    if h1b == 1 and h4b == 1: t_both.append(t)
                    done_lo = True

    print(f"\n  Signals: no-filter={len(t_all)} | any-HTF={len(t_any)} | H1+H4={len(t_both)}")
    for tp_r in tp_list:
        print(f"\n  ── TP {tp_r}R ──────────────────────────────────────────")
        for lbl, trades in [('No filter', t_all), ('Any HTF', t_any), ('H1+H4', t_both)]:
            r = simulate(trades, tp_r); m = metrics(r, total_weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t_all, t_any, t_both

# ─── SETUP M: FRANKFURT ORB ───────────────────────────────────────────────────
def setup_frb(df, total_weeks, tp_list):
    print(f"\n{'═'*60}")
    print("SETUP M: Frankfurt ORB — SHORT ONLY")
    print("  FRB bar: 07:00 UTC H1 | Gate: H1+H4 SHORT + close < Asian lo")
    print("  Pine comment says PF=1.976, WR=63% — verifying…")
    print(f"{'═'*60}")

    t_strict = []; t_loose = []
    for date_str, day in df.groupby('date_str'):
        if is_news_day(date_str) or day['dow'].iloc[0] > 4: continue
        frb_bars = day[day['in_frb_win']]
        if len(frb_bars) == 0: continue
        fb_bar  = frb_bars.iloc[0]
        frb_hi  = float(fb_bar['high']); frb_lo = float(fb_bar['low'])
        orb_rng = frb_hi - frb_lo
        if orb_rng < 0.50: continue

        asian_lo = float(day[day['in_asian']]['low'].min()) \
                   if len(day[day['in_asian']]) > 0 else np.nan
        if pd.isna(asian_lo): continue

        d_atr = float(day['d_atr'].iloc[0])
        if pd.isna(d_atr) or d_atr <= 0: continue

        done = False
        for _, bar in day[day['in_frb_trd']].iterrows():
            if done: break
            if float(bar['adr']) >= 2.00: continue
            h1b = int(bar['h1_bias']); h4b = int(bar['h4_bias'])
            cl  = float(bar['close'])
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr*0.25
            buf = max(atr*0.10, 0.50)
            fb  = day[day.index > bar.name]
            fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))

            # STRICT: H1+H4 both bear AND close below Asian lo AND below frb_lo
            if h1b == -1 and h4b == -1 and cl < frb_lo and cl < asian_lo:
                sl = frb_hi + buf
                if sl - cl > 0:
                    t_strict.append({'entry': cl, 'sl': sl, 'dir': -1,
                                     'date': bar.name, 'future_bars': fut})
                    done = True

            # LOOSE: close breaks frb_lo (any HTF)
            elif not done and cl < frb_lo and (h1b == -1 or h4b == -1):
                sl = frb_hi + buf
                if sl - cl > 0:
                    t_loose.append({'entry': cl, 'sl': sl, 'dir': -1,
                                    'date': bar.name, 'future_bars': fut})
                    done = True

    print(f"\n  Signals: strict={len(t_strict)} | loose(any-HTF)={len(t_loose)}")
    for tp_r in tp_list:
        print(f"\n  ── TP {tp_r}R ──────────────────────────────────────────")
        for lbl, trades in [('Strict (H1+H4+AsianLo)', t_strict),
                             ('Loose (any HTF)',        t_loose)]:
            r = simulate(trades, tp_r); m = metrics(r, total_weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t_strict, t_loose

# ─── SETUP H: NY ORB ─────────────────────────────────────────────────────────
def setup_nyorb(df, total_weeks, tp_list):
    print(f"\n{'═'*60}")
    print("SETUP H: NY ORB — Both directions")
    print("  ORB: 14:00 UTC bar | Entry 15:00-17:00 | Gate: H1+H4 aligned")
    print(f"{'═'*60}")

    t_h1h4 = []; t_none = []
    for date_str, day in df.groupby('date_str'):
        if is_news_day(date_str) or day['dow'].iloc[0] > 4: continue
        orb_bars = day[day['in_nyorb_w']]
        if len(orb_bars) == 0: continue
        orb_bar = orb_bars.iloc[0]
        ny_hi   = float(orb_bar['high']); ny_lo = float(orb_bar['low'])
        orb_rng = ny_hi - ny_lo
        if orb_rng < 0.50: continue
        d_atr = float(day['d_atr'].iloc[0])
        if pd.isna(d_atr) or d_atr <= 0: continue

        done = False
        for _, bar in day[day['in_nyorb_e']].iterrows():
            if done: break
            if float(bar['adr']) >= 2.50: continue
            h1b = int(bar['h1_bias']); h4b = int(bar['h4_bias'])
            cl  = float(bar['close'])
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr*0.25
            buf = max(atr*0.10, 0.50)
            fb  = day[day.index > bar.name]
            fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))

            if cl > ny_hi:
                sl = ny_lo - buf; sl_d = cl - sl
                if sl_d > 0:
                    t = {'entry': cl, 'sl': sl, 'dir': 1,
                         'date': bar.name, 'future_bars': fut}
                    t_none.append(t)
                    if h1b == 1 and h4b == 1: t_h1h4.append(t)
                    done = True
            elif cl < ny_lo:
                sl = ny_hi + buf; sl_d = sl - cl
                if sl_d > 0:
                    t = {'entry': cl, 'sl': sl, 'dir': -1,
                         'date': bar.name, 'future_bars': fut}
                    t_none.append(t)
                    if h1b == -1 and h4b == -1: t_h1h4.append(t)
                    done = True

    # Also test FADE (reverse direction) — ORB breaks often fail on gold
    t_fade = [{'entry': t['entry'], 'sl': t['entry'] + t['dir'] * abs(t['entry'] - t['sl']),
               'dir': -t['dir'], 'date': t['date'], 'future_bars': t['future_bars']}
              for t in t_none]

    print(f"\n  Signals: no-filter={len(t_none)} | H1+H4={len(t_h1h4)} | fade={len(t_fade)}")
    for tp_r in tp_list:
        print(f"\n  ── TP {tp_r}R ──────────────────────────────────────────")
        for lbl, trades in [('No filter', t_none), ('H1+H4', t_h1h4), ('FADE', t_fade)]:
            r = simulate(trades, tp_r); m = metrics(r, total_weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t_none, t_h1h4

# ─── SETUP D: PSYCHOLOGICAL LEVEL BOUNCE ─────────────────────────────────────
def setup_psych(df, total_weeks, tp_list, tol_pts=8.0):
    print(f"\n{'═'*60}")
    print("SETUP D: Psychological Level Bounce")
    print(f"  50pt/100pt gold levels | tol={tol_pts}pt | London+NY overlap")
    print(f"{'═'*60}")

    t_any = []; t_all3 = []
    for date_str, day in df.groupby('date_str'):
        if is_news_day(date_str) or day['dow'].iloc[0] > 4: continue
        kz = day[day['in_kz']]
        if len(kz) == 0: continue
        d_atr = float(day['d_atr'].iloc[0])
        if pd.isna(d_atr) or d_atr <= 0: continue

        fired = set(); done = False
        for _, bar in kz.iterrows():
            if done: break
            if float(bar['adr']) >= 1.20: continue
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr*0.25
            cl  = float(bar['close'])
            hi  = float(bar['high']); lo = float(bar['low'])
            h1b = int(bar['h1_bias']); h4b = int(bar['h4_bias']); db = int(bar['d_bias'])

            lvl50  = round(cl / 50.0)  * 50.0
            lvl100 = round(cl / 100.0) * 100.0
            levels = sorted({lvl50, lvl100}, key=lambda v: abs(cl - v))

            for near in levels:
                if near in fired: continue
                if abs(cl - near) > tol_pts * 3: continue

                # Bullish bounce: wick touches or goes below level, close above
                if lo <= near + tol_pts and cl > near:
                    align = (h1b==1) + (h4b==1) + (db==1)
                    if align >= 1:
                        sl_  = lo - max(atr*0.30, tol_pts)
                        sl_d = near - sl_
                        if sl_d > 0:
                            fb  = day[day.index > bar.name]
                            fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))
                            t   = {'entry': near, 'sl': sl_, 'dir': 1,
                                   'date': bar.name, 'future_bars': fut}
                            t_any.append(t)
                            if align == 3: t_all3.append(t)
                            fired.add(near); done = True; break

                # Bearish rejection: wick touches or goes above level, close below
                elif hi >= near - tol_pts and cl < near:
                    align = (h1b==-1) + (h4b==-1) + (db==-1)
                    if align >= 1:
                        sl_  = hi + max(atr*0.30, tol_pts)
                        sl_d = sl_ - near
                        if sl_d > 0:
                            fb  = day[day.index > bar.name]
                            fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))
                            t   = {'entry': near, 'sl': sl_, 'dir': -1,
                                   'date': bar.name, 'future_bars': fut}
                            t_any.append(t)
                            if align == 3: t_all3.append(t)
                            fired.add(near); done = True; break

    print(f"\n  Signals: any-HTF={len(t_any)} | all-3-HTF={len(t_all3)}")
    for tp_r in tp_list:
        print(f"\n  ── TP {tp_r}R ──────────────────────────────────────────")
        for lbl, trades in [('Any HTF', t_any), ('All 3 HTF', t_all3)]:
            r = simulate(trades, tp_r); m = metrics(r, total_weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t_any, t_all3

# ─── SHARED FVG DETECTOR ──────────────────────────────────────────────────────
def run_fvg_stream(df, session_col, max_age=20, min_gap_atr=0.10,
                   max_fill=0.50, adr_gate=0.85, one_per_day=False):
    """Bar-by-bar FVG pool. Uses pandas .loc for type safety."""
    timestamps = df.index.copy()   # preserve UTC DatetimeIndex
    df2 = df.reset_index(drop=True)
    n   = len(df2)
    SWG = 3

    fvgs   = []
    bos_bL = bos_bS = None
    prev_ph = prev_pl = None
    fired_days = set()
    t1 = []; t2 = []

    for i in range(SWG * 2 + 1, n):
        row   = df2.iloc[i]
        atr   = float(row['atr'])
        if pd.isna(atr) or atr <= 0: continue
        date_str = str(row['date_str'])
        dow_v    = int(row['dow'])
        if is_news_day(date_str) or dow_v > 4: continue
        if one_per_day and date_str in fired_days: continue

        hi  = float(row['high']); lo = float(row['low'])
        h1b = int(row['h1_bias']); h4b = int(row['h4_bias']); db = int(row['d_bias'])
        in_s = bool(row[session_col])
        adr_ = float(row['adr']) if not pd.isna(row['adr']) else 0.0

        # ── BOS ────────────────────────────────────────────────────────────
        pi = i - SWG
        if pi >= SWG:
            ph = float(df2.iloc[pi]['high'])
            pl = float(df2.iloc[pi]['low'])
            neighbors_h = [float(df2.iloc[pi+k]['high']) for k in range(-SWG, SWG+1) if k != 0]
            neighbors_l = [float(df2.iloc[pi+k]['low'])  for k in range(-SWG, SWG+1) if k != 0]
            if ph >= max(neighbors_h):
                if prev_ph is not None and ph > prev_ph: bos_bL = pi
                prev_ph = ph
            if pl <= min(neighbors_l):
                if prev_pl is not None and pl < prev_pl: bos_bS = pi
                prev_pl = pl

        bos_L = bos_bL is not None and (i - bos_bL) <= 30
        bos_S = bos_bS is not None and (i - bos_bS) <= 30

        # ── FVG detection ──────────────────────────────────────────────────
        if i >= 2:
            hi2 = float(df2.iloc[i-2]['high'])
            lo2 = float(df2.iloc[i-2]['low'])
            if (lo - hi2) >= atr * min_gap_atr:
                fvgs.append({'lo': hi2, 'hi': lo, 'dir': 1, 'bi': i, 'fill': 0.0, 'fired': False})
            if (lo2 - hi) >= atr * min_gap_atr:
                fvgs.append({'lo': hi, 'hi': lo2, 'dir': -1, 'bi': i, 'fill': 0.0, 'fired': False})
        fvgs = fvgs[-25:]

        # ── Fill update ────────────────────────────────────────────────────
        for f in fvgs:
            gsz = f['hi'] - f['lo']
            if gsz <= 0: continue
            if f['dir'] == 1 and lo < f['hi']:
                f['fill'] = min(1.0, max(f['fill'], (f['hi'] - max(f['lo'], lo)) / gsz))
            if f['dir'] == -1 and hi > f['lo']:
                f['fill'] = min(1.0, max(f['fill'], (min(f['hi'], hi) - f['lo']) / gsz))

        if not in_s or adr_ >= adr_gate: continue

        bar_dt = timestamps[i]   # UTC timestamp for this bar

        for f in fvgs:
            if f['fired']: continue
            age = i - f['bi']
            if age > max_age or f['fill'] > max_fill: continue
            d = f['dir']
            touched = ((d == 1 and lo <= f['hi'] and hi >= f['lo']) or
                       (d == -1 and hi >= f['lo'] and lo <= f['hi']))
            if not touched: continue
            if not ((d == 1 and bos_L) or (d == -1 and bos_S)): continue

            # Proximal edge: top of bullish FVG (f['hi']) or bottom of bearish FVG (f['lo'])
            entry = f['hi'] if d == 1 else f['lo']
            buf   = atr * 0.20
            # SL at distal edge - buffer (gap + buffer total)
            sl_p  = (f['lo'] - buf) if d == 1 else (f['hi'] + buf)
            sl_d  = abs(entry - sl_p)
            if sl_d <= 0: continue
            if not (0.30 <= sl_d/atr <= 3.00): continue

            align = (h1b==d) + (h4b==d) + (db==d)
            fut_slice = df2.iloc[i+1:]
            fut = list(zip(fut_slice['high'].astype(float), fut_slice['low'].astype(float)))

            t = {'entry': entry, 'sl': sl_p, 'dir': d,
                 'date': bar_dt,
                 'future_bars': fut, 'align': align}
            f['fired'] = True
            if one_per_day: fired_days.add(date_str)
            if align >= 1: t1.append(t)
            if align >= 2: t2.append(t)
            break

    return t1, t2

# ─── SETUP A: FVG RETEST ──────────────────────────────────────────────────────
def setup_fvg(df, total_weeks, tp_list):
    print(f"\n{'═'*60}")
    print("SETUP A: FVG Retest + BOS")
    print("  London 08-10 + NY overlap 13-16 UTC | BOS required | ADR<85%")
    print(f"{'═'*60}")

    t1, t2 = run_fvg_stream(df, 'in_kz', max_age=20, adr_gate=0.85, one_per_day=False)
    print(f"\n  Signals: ≥1 HTF={len(t1)} | ≥2 HTF={len(t2)}")
    for tp_r in tp_list:
        print(f"\n  ── TP {tp_r}R ──────────────────────────────────────────")
        for lbl, trades in [('≥1 HTF', t1), ('≥2 HTF', t2)]:
            r = simulate(trades, tp_r); m = metrics(r, total_weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t1, t2

# ─── SETUP C: SILVER BULLET ───────────────────────────────────────────────────
def setup_sb(df, total_weeks, tp_list):
    print(f"\n{'═'*60}")
    print("SETUP C: Silver Bullet — FVG retest 15:00-16:00 UTC")
    print(f"{'═'*60}")

    t1, t2 = run_fvg_stream(df, 'in_sb', max_age=48, adr_gate=0.85, one_per_day=True)
    print(f"\n  Signals: ≥1 HTF={len(t1)} | ≥2 HTF={len(t2)}")
    for tp_r in tp_list:
        print(f"\n  ── TP {tp_r}R ──────────────────────────────────────────")
        for lbl, trades in [('≥1 HTF', t1), ('≥2 HTF', t2)]:
            r = simulate(trades, tp_r); m = metrics(r, total_weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t1, t2

# ─── MAIN ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("=" * 60)
    print(" QB Gold Specialist — Extraction & Validation v2")
    print("=" * 60)

    df = download()
    df = build_features(df)

    total_weeks = (df.index[-1] - df.index[0]).days / 7
    days_all  = set(df[df['dow'] <= 4]['date_str'].unique())
    days_excl = days_all & ALL_NEWS_DAYS
    print(f"\nBars        : {len(df):,}  ({df.index[0].date()} → {df.index[-1].date()})")
    print(f"Trading days: {len(days_all)}")
    print(f"News excl   : {len(days_excl)}")
    print(f"Clean days  : {len(days_all)-len(days_excl)}")

    adr_at_lon = df[df['in_london']]['adr'].dropna()
    print(f"ADR at London open: median={adr_at_lon.median():.2f}  "
          f"p90={adr_at_lon.quantile(0.9):.2f}  (should be 0.2-0.8 now)")

    TP_MAIN = [1.0, 1.5, 2.0, 2.5]
    TP_SB   = [1.5, 2.5, 4.0]

    j_all, j_any, j_both = setup_judas(df, total_weeks, TP_MAIN)
    frb_s, frb_l         = setup_frb(df, total_weeks, [1.0, 1.5, 2.0])
    ny_all, ny_h1h4      = setup_nyorb(df, total_weeks, TP_MAIN)
    p_any, p_all3        = setup_psych(df, total_weeks, TP_MAIN)
    fvg_1, fvg_2         = setup_fvg(df, total_weeks, TP_MAIN)
    sb_1, sb_2           = setup_sb(df, total_weeks, TP_SB)

    print(f"\n{'='*60}")
    print(" DONE — Criteria: 0.5-3/wk · WR>55% · PF>1.5 · MinYr>50%")
    print(f"{'='*60}")
