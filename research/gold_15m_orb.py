"""
Frankfurt ORB + NY ORB — Proper 15m Test
=========================================
The H1 backtest breaks Setup M and H because:
  - Frankfurt ORB window = 07:00-07:30 UTC (2 × 15m bars)
  - NY ORB window       = 14:00-14:30 UTC (2 × 15m bars)
  Using an H1 bar (60 min) doubles the range → SL doubles → TP twice as far → WR collapses.

This script uses proper GC=F 15m data (yfinance max = 60 days).
Short window but correct resolution for ORB setups.
Also tests Judas Sweep and FVG on 15m as a cross-check.
"""

import pandas as pd
import numpy as np
import yfinance as yf
from scipy import stats
import warnings
warnings.filterwarnings('ignore')

FOMC_DATES = {
    '2025-07-30','2025-09-17',
    '2026-01-29','2026-03-19','2026-05-06','2026-06-17','2026-07-29',
}
US_CPI_DATES = {
    '2025-07-15','2025-08-12','2026-01-15','2026-02-12','2026-03-12',
    '2026-04-10','2026-05-13','2026-06-11','2026-07-15','2026-08-12',
}
def get_nfp_dates():
    dates = set()
    for ms in pd.date_range('2025-01-01','2027-01-01', freq='MS'):
        d = ms
        while d.weekday() != 4:
            d += pd.Timedelta(days=1)
        dates.add(d.strftime('%Y-%m-%d'))
    return dates

ALL_NEWS = FOMC_DATES | US_CPI_DATES | get_nfp_dates()

def is_news(s): return s in ALL_NEWS

# ─── DATA ─────────────────────────────────────────────────────────────────────
def download_15m():
    print("Downloading GC=F 15m (60 days max from yfinance)…")
    df = yf.download("GC=F", period="60d", interval="15m",
                     auto_adjust=True, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df.columns = [c.lower() for c in df.columns]
    df.index = df.index.tz_convert('UTC')
    df = df.dropna(subset=['open','high','low','close'])
    print(f"  {len(df):,} bars  {df.index[0].date()} → {df.index[-1].date()}")
    return df

def build_15m(df, ema_p=20):
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift(1)).abs(),
        (df['low']  - df['close'].shift(1)).abs(),
    ], axis=1).max(axis=1)
    df['atr']  = tr.ewm(span=14, adjust=False).mean()
    df['date_str'] = df.index.strftime('%Y-%m-%d')
    df['utc_min']  = df.index.hour * 60 + df.index.minute
    df['dow']      = df.index.dayofweek

    # HTF bias from 15m resampled
    h1_cl  = df['close'].resample('1h').last().dropna()
    h1_ema = h1_cl.ewm(span=ema_p, adjust=False).mean().shift(1)
    h1b    = pd.Series(np.sign(h1_cl - h1_ema).fillna(0).astype(int), index=h1_cl.index)
    df['h1_bias'] = h1b.reindex(df.index, method='ffill').fillna(0).astype(int)

    h4_cl  = df['close'].resample('4h').last().dropna()
    h4_ema = h4_cl.ewm(span=ema_p, adjust=False).mean().shift(1)
    h4b    = pd.Series(np.sign(h4_cl - h4_ema).fillna(0).astype(int), index=h4_cl.index)
    df['h4_bias'] = h4b.reindex(df.index, method='ffill').fillna(0).astype(int)

    d_cl   = df['close'].resample('1D').last().dropna()
    d_ema  = d_cl.ewm(span=ema_p, adjust=False).mean().shift(1)
    db     = pd.Series(np.sign(d_cl - d_ema).fillna(0).astype(int), index=d_cl.index)
    df['d_bias'] = db.reindex(df.index, method='ffill').fillna(0).astype(int)

    # ADR (no lookahead)
    d_hi_s = df['high'].resample('1D').max()
    d_lo_s = df['low'].resample('1D').min()
    d_rng  = (d_hi_s - d_lo_s).ewm(span=14, adjust=False).mean().shift(1)
    df['d_atr'] = d_rng.reindex(df.index, method='ffill')
    df['r_hi']  = df.groupby('date_str')['high'].transform(lambda x: x.expanding().max()).shift(1)
    df['r_lo']  = df.groupby('date_str')['low'].transform(lambda x: x.expanding().min()).shift(1)
    df['adr']   = ((df['r_hi']-df['r_lo']).clip(lower=0) / df['d_atr'].clip(lower=1e-6))

    return df

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
                if bl <= sl:     outcome = -1.0; break
                if bh >= tp_lvl: outcome =  tp_r; break
            else:
                if bh >= sl:     outcome = -1.0; break
                if bl <= tp_lvl: outcome =  tp_r; break
        results.append({'pnl': outcome if outcome is not None else -1.0,
                        'date': t['date'], 'dir': d})
    return results

def metrics(results, total_weeks):
    if len(results) < 5: return None
    df  = pd.DataFrame(results)
    df['date'] = pd.to_datetime(df['date'], utc=True)
    wins = df['pnl'] > 0
    n    = len(df); wr = wins.sum()/n
    gp   = df.loc[wins, 'pnl'].sum()
    gl   = df.loc[~wins,'pnl'].abs().sum()
    pf   = (gp/gl) if gl > 0 else 999.0
    tpw  = n / total_weeks
    yr_wr = df.groupby(df['date'].dt.year).apply(lambda g: (g['pnl']>0).mean()).to_dict()
    min_yr = min(yr_wr.values()) if yr_wr else 0.0
    try:
        bp = stats.binomtest(int(wins.sum()), n, 0.5, alternative='greater').pvalue
    except Exception:
        bp = 1.0
    return {'n': n, 'tpw': round(tpw,2), 'wr': round(wr*100,1),
            'pf': round(pf,3), 'min_yr_wr': round(min_yr*100,1),
            'yr_wr': {y: round(v*100,1) for y,v in yr_wr.items()},
            'binom_p': round(bp,4), 'sig': bp < 0.05}

def print_m(m, indent='  '):
    if m is None: print(f"{indent}< 5 trades"); return
    passed = (0.5<=m['tpw']<=3.0 and m['wr']>=55 and m['pf']>=1.5 and m['min_yr_wr']>=50)
    tag  = '  ★ PASSES' if passed else ''
    sig  = '✅ significant' if m['sig'] else '⚠️  not sig'
    print(f"{indent}n={m['n']} ({m['tpw']}/wk) | WR {m['wr']}% | PF {m['pf']} | MinYr {m['min_yr_wr']}%{tag} | {sig}")

# ─── SETUP M: FRANKFURT ORB (15m) ─────────────────────────────────────────────
def setup_frb_15m(df, total_weeks, tp_r_list):
    """
    Exact Pine logic on 15m:
    - FRB range = bars at 07:00 + 07:15 UTC (30 min) → FRB_HI / FRB_LO
    - SHORT only
    - Entry: first 15m bar 07:30-11:00 UTC that CLOSES below FRB_LO
    - Gate: H1 bias = -1, H4 bias = -1, close < Asian lo (00:00-07:00)
    - SL: FRB_HI + buf
    - TP: FRB_LO - 0.75 × FRB_range (Pine original) AND fixed 1/1.5/2R
    """
    print(f"\n{'═'*60}")
    print("SETUP M: Frankfurt ORB — 15m PROPER IMPLEMENTATION")
    print("  FRB = 07:00+07:15 UTC (30min) | SHORT | H1+H4 bearish")
    print(f"{'═'*60}")

    trades = []
    for date_str, day in df.groupby('date_str'):
        if is_news(date_str) or day['dow'].iloc[0] > 4: continue

        # FRB range: 07:00 and 07:15 UTC bars only
        frb_bars = day[day['utc_min'].isin([420, 435])]  # 07:00=420, 07:15=435
        if len(frb_bars) == 0: continue
        frb_hi = frb_bars['high'].max()
        frb_lo = frb_bars['low'].min()
        orb_rng = frb_hi - frb_lo
        if orb_rng < 0.20: continue  # minimum 20¢ range (gold is quoted in $/oz)

        # Asian low (00:00-07:00 UTC, i.e. utc_min < 420)
        asian_bars = day[day['utc_min'] < 420]
        if len(asian_bars) == 0: continue
        asian_lo = asian_bars['low'].min()

        d_atr = float(day['d_atr'].iloc[0])
        if pd.isna(d_atr) or d_atr <= 0: continue

        # Entry window: 07:30-11:00 UTC (utc_min 450-660)
        entry_bars = day[(day['utc_min'] >= 450) & (day['utc_min'] < 660)]
        done = False
        for _, bar in entry_bars.iterrows():
            if done: break
            if bar['adr'] >= 2.00: continue
            h1b = int(bar['h1_bias']); h4b = int(bar['h4_bias'])
            cl  = float(bar['close'])
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr/4

            if cl < frb_lo and cl < asian_lo:
                buf = max(atr * 0.10, 0.50)
                sl  = frb_hi + buf
                sl_d = sl - cl
                if sl_d <= 0: continue
                fb  = day[day.index > bar.name]
                fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))
                t = {'entry': cl, 'sl': sl, 'dir': -1,
                     'date': bar.name, 'future_bars': fut,
                     'frb_hi': frb_hi, 'frb_lo': frb_lo, 'orb_rng': orb_rng,
                     'h1b': h1b, 'h4b': h4b, 'sl_d': sl_d}
                trades.append(t)
                done = True

    t_any   = [t for t in trades if t['h1b']==-1 or t['h4b']==-1]
    t_both  = [t for t in trades if t['h1b']==-1 and t['h4b']==-1]

    print(f"\n  Signals: no-filter={len(trades)} | any-HTF={len(t_any)} | H1+H4={len(t_both)}")
    print(f"  Avg SL distance: {np.mean([t['sl_d'] for t in trades]):.1f}pt" if trades else "")

    for tp_r in tp_r_list:
        print(f"\n  ── Fixed TP {tp_r}R ──────────────────────────────────")
        for lbl, tds in [('No filter', trades), ('Any HTF', t_any), ('H1+H4', t_both)]:
            r = simulate(tds, tp_r)
            m = metrics(r, total_weeks)
            print(f"    {lbl}:"); print_m(m, '      ')

    # Pine original TP: FRB_lo - 0.75 × FRB_range
    print(f"\n  ── Pine TP = FRB_lo - 0.75×range ───────────────────")
    for lbl, tds in [('No filter', trades), ('H1+H4', t_both)]:
        results = []
        for t in tds:
            tp_lvl = t['frb_lo'] - 0.75 * t['orb_rng']
            sl_d   = t['sl_d']
            tp_d   = abs(t['entry'] - tp_lvl)
            outcome = None
            for bh, bl in t['future_bars']:
                if bh >= t['sl']:   outcome = -sl_d; break
                if bl <= tp_lvl:    outcome =  tp_d; break
            pnl_r = (outcome if outcome is not None else -sl_d) / sl_d
            results.append({'pnl': pnl_r, 'date': t['date'], 'dir': -1})
        m = metrics(results, total_weeks)
        print(f"    {lbl}:"); print_m(m, '      ')

    return trades

# ─── SETUP H: NY ORB (15m) ────────────────────────────────────────────────────
def setup_nyorb_15m(df, total_weeks, tp_r_list):
    """
    Exact Pine logic on 15m:
    - ORB range = bars at 14:00 + 14:15 UTC (30 min)
    - Both directions
    - Entry: first 15m bar 14:30-17:00 UTC that CLOSES outside range
    - Gate: H1+H4 aligned with direction
    - SL: opposite ORB extreme + buf
    """
    print(f"\n{'═'*60}")
    print("SETUP H: NY ORB — 15m PROPER IMPLEMENTATION")
    print("  ORB = 14:00+14:15 UTC (30min) | Both dirs | H1+H4 aligned")
    print(f"{'═'*60}")

    t_all = []; t_h1h4 = []
    for date_str, day in df.groupby('date_str'):
        if is_news(date_str) or day['dow'].iloc[0] > 4: continue

        # ORB range: 14:00 and 14:15 UTC bars
        orb_bars = day[day['utc_min'].isin([840, 855])]  # 14:00=840, 14:15=855
        if len(orb_bars) == 0: continue
        ny_hi = orb_bars['high'].max(); ny_lo = orb_bars['low'].min()
        orb_rng = ny_hi - ny_lo
        if orb_rng < 0.20: continue

        d_atr = float(day['d_atr'].iloc[0])
        if pd.isna(d_atr) or d_atr <= 0: continue

        # Entry window: 14:30-17:00 UTC
        entry_bars = day[(day['utc_min'] >= 870) & (day['utc_min'] < 1020)]
        done = False
        for _, bar in entry_bars.iterrows():
            if done: break
            if bar['adr'] >= 2.50: continue
            h1b = int(bar['h1_bias']); h4b = int(bar['h4_bias'])
            cl  = float(bar['close'])
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr/4
            buf = max(atr*0.10, 0.50)
            fb  = day[day.index > bar.name]
            fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))

            if cl > ny_hi:
                sl = ny_lo - buf; sl_d = cl - sl
                if sl_d > 0:
                    t = {'entry': cl, 'sl': sl, 'dir': 1,
                         'date': bar.name, 'future_bars': fut,
                         'h1b': h1b, 'h4b': h4b,
                         'orb_hi': ny_hi, 'orb_lo': ny_lo, 'orb_rng': orb_rng}
                    t_all.append(t)
                    if h1b==1 and h4b==1: t_h1h4.append(t)
                    done = True
            elif cl < ny_lo:
                sl = ny_hi + buf; sl_d = sl - cl
                if sl_d > 0:
                    t = {'entry': cl, 'sl': sl, 'dir': -1,
                         'date': bar.name, 'future_bars': fut,
                         'h1b': h1b, 'h4b': h4b,
                         'orb_hi': ny_hi, 'orb_lo': ny_lo, 'orb_rng': orb_rng}
                    t_all.append(t)
                    if h1b==-1 and h4b==-1: t_h1h4.append(t)
                    done = True

    print(f"\n  Signals: no-filter={len(t_all)} | H1+H4={len(t_h1h4)}")
    for tp_r in tp_r_list:
        print(f"\n  ── Fixed TP {tp_r}R ──────────────────────────────────────────")
        for lbl, tds in [('No filter', t_all), ('H1+H4', t_h1h4)]:
            r = simulate(tds, tp_r); m = metrics(r, total_weeks)
            print(f"    {lbl}:"); print_m(m, '      ')

    # Pine original TP: edge of ORB + 0.75 × ORB range
    print(f"\n  ── Pine TP = ORB_edge + 0.75×range (same as Frankfurt) ──")
    for lbl, tds in [('No filter', t_all), ('H1+H4', t_h1h4)]:
        results = []
        for t in tds:
            tp_lvl = (t['orb_hi'] + 0.75*t['orb_rng'] if t['dir']==1
                      else t['orb_lo'] - 0.75*t['orb_rng'])
            sl_d   = abs(t['entry'] - t['sl'])
            outcome = None
            for bh, bl in t['future_bars']:
                if t['dir'] == 1:
                    if bl <= t['sl']:  outcome = -sl_d; break
                    if bh >= tp_lvl:   outcome = abs(tp_lvl - t['entry']); break
                else:
                    if bh >= t['sl']:  outcome = -sl_d; break
                    if bl <= tp_lvl:   outcome = abs(t['entry'] - tp_lvl); break
            pnl_r = (outcome if outcome is not None else -sl_d) / sl_d
            results.append({'pnl': pnl_r, 'date': t['date'], 'dir': t['dir']})
        m = metrics(results, total_weeks)
        print(f"    {lbl}:"); print_m(m, '      ')

    return t_all, t_h1h4

# ─── CROSS-CHECK: Judas Sweep on 15m ─────────────────────────────────────────
def setup_judas_15m(df, total_weeks, tp_r_list):
    """
    Judas Sweep on 15m — compare to H1 result (should be similar or better).
    """
    print(f"\n{'═'*60}")
    print("CROSS-CHECK: Judas Sweep on 15m")
    print("  (H1 test showed WR 73.9% — verifying same edge on 15m)")
    print(f"{'═'*60}")

    t_all = []
    for date_str, day in df.groupby('date_str'):
        if is_news(date_str) or day['dow'].iloc[0] > 4: continue
        asian  = day[day['utc_min'] < 480]   # 00:00-07:59 UTC
        london = day[(day['utc_min'] >= 480) & (day['utc_min'] < 660)]  # 08:00-10:59 UTC
        if len(asian) < 4 or len(london) == 0: continue
        d_atr = float(day['d_atr'].iloc[0])
        if pd.isna(d_atr) or d_atr <= 0: continue

        ar_hi = asian['high'].max(); ar_lo = asian['low'].min()
        done_hi = done_lo = False

        for _, bar in london.iterrows():
            if bar['adr'] >= 0.90: continue
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr*0.06
            fb  = day[day.index > bar.name]
            fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))

            if not done_hi and bar['high'] > ar_hi and bar['close'] < ar_hi:
                if (bar['high'] - ar_hi) >= atr * 0.40:
                    sl = bar['high'] + atr * 0.60
                    t_all.append({'entry': ar_hi, 'sl': sl, 'dir': -1,
                                  'date': bar.name, 'future_bars': fut})
                    done_hi = True

            if not done_lo and bar['low'] < ar_lo and bar['close'] > ar_lo:
                if (ar_lo - bar['low']) >= atr * 0.40:
                    sl = bar['low'] - atr * 0.60
                    t_all.append({'entry': ar_lo, 'sl': sl, 'dir': 1,
                                  'date': bar.name, 'future_bars': fut})
                    done_lo = True

    print(f"\n  Signals: {len(t_all)}")
    for tp_r in tp_r_list:
        print(f"\n  ── TP {tp_r}R ──────────────────────────────────────────")
        r = simulate(t_all, tp_r); m = metrics(r, total_weeks)
        print_m(m, '    ')
    return t_all

# ─── MAIN ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("=" * 60)
    print(" Frankfurt ORB + NY ORB — Proper 15m Extraction")
    print(" (H1 was wrong: doubled ORB range → SL too wide → WR collapse)")
    print("=" * 60)

    df = download_15m()
    df = build_15m(df)

    total_weeks = (df.index[-1] - df.index[0]).days / 7
    days_all  = set(df[df['dow'] <= 4]['date_str'].unique())
    news_excl = days_all & ALL_NEWS
    print(f"\nClean trading days: {len(days_all) - len(news_excl)}  "
          f"(excl. {len(news_excl)} news days)")
    print(f"Total weeks: {total_weeks:.1f}")
    print(f"\nNOTE: 60 days is a short window — treat as directional "
          f"check, not full validation. Pine strategy on TradingView "
          f"has years of history and should be primary reference.")

    TP_LIST = [1.0, 1.5, 2.0]

    frb_trades          = setup_frb_15m(df, total_weeks, TP_LIST)
    ny_all, ny_h1h4     = setup_nyorb_15m(df, total_weeks, TP_LIST)
    judas_15m           = setup_judas_15m(df, total_weeks, [1.0, 1.5])

    print(f"\n{'='*60}")
    print(" COMPLETE")
    print(f" Criteria: 0.5-3/wk · WR>55% · PF>1.5 · MinYr>50%")
    print(f"{'='*60}")
