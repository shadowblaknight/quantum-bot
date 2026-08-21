"""
Gold Specialist - All 4 Setups on Proper 15m Data
===================================================
Tests: FVG+BOS, Judas Sweep, Psych Level Bounce, Silver Bullet
on GC=F 15m (60 days max from yfinance).

Why H1 results were wrong:
  1. FVG same-bar lookahead bug: bar i detects FVG using bar i's low,
     immediately "touches" it (bar i's low = FVG top edge always). Not a retest.
  2. H1 entry price bias: Judas/Psych use exact limit prices at pattern
     levels - harder to fill in reality after bar-close confirmation.
  3. Trending market bias: gold went from ~2000 to ~4500 (2024-2026),
     systematically favouring longs which skewed H1 numbers up.
  4. H1 resolution hides 15m structure needed for these patterns.
"""

import pandas as pd
import numpy as np
import yfinance as yf
from scipy import stats
import warnings
warnings.filterwarnings('ignore')

ALL_NEWS = {
    '2026-06-11','2026-06-18','2026-07-02','2026-07-15',
    '2026-07-29','2026-08-01','2026-08-06','2026-08-12',
}

def is_news(s): return s in ALL_NEWS

def download_15m():
    print("Downloading GC=F 15m (60 days) ?")
    df = yf.download("GC=F", period="60d", interval="15m",
                     auto_adjust=True, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df.columns = [c.lower() for c in df.columns]
    df.index = df.index.tz_convert('UTC')
    df = df.dropna(subset=['open','high','low','close'])
    print(f"  {len(df):,} bars  {df.index[0].date()} to {df.index[-1].date()}")
    return df

def build_features(df, ema_p=20):
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift(1)).abs(),
        (df['low']  - df['close'].shift(1)).abs(),
    ], axis=1).max(axis=1)
    df['atr'] = tr.ewm(span=14, adjust=False).mean()

    df['date_str'] = df.index.strftime('%Y-%m-%d')
    df['utc_min']  = df.index.hour * 60 + df.index.minute
    df['dow']      = df.index.dayofweek

    # HTF bias
    for tf, col in [('1h','h1'),('4h','h4'),('1D','d')]:
        cl  = df['close'].resample(tf).last().dropna()
        ema = cl.ewm(span=ema_p, adjust=False).mean().shift(1)
        b   = pd.Series(np.sign(cl - ema).fillna(0).astype(int), index=cl.index)
        df[f'{col}_bias'] = b.reindex(df.index, method='ffill').fillna(0).astype(int)

    # ADR (no lookahead)
    d_rng  = (df['high'].resample('1D').max() - df['low'].resample('1D').min()
              ).ewm(span=14, adjust=False).mean().shift(1)
    df['d_atr'] = d_rng.reindex(df.index, method='ffill')
    df['r_hi']  = df.groupby('date_str')['high'].transform(lambda x: x.expanding().max()).shift(1)
    df['r_lo']  = df.groupby('date_str')['low'].transform(lambda x: x.expanding().min()).shift(1)
    df['adr']   = ((df['r_hi']-df['r_lo']).clip(lower=0) / df['d_atr'].clip(lower=1e-6))

    # Session flags (UTC min)
    m = df['utc_min']
    wd = df['dow'] <= 4
    df['in_asian']  = (m < 480)                           & wd
    df['in_london'] = (m >= 480) & (m < 660)              & wd
    df['in_kz']     = ((m >= 480) & (m < 660)) | ((m >= 780) & (m < 1020))
    df['in_kz']     = df['in_kz'] & wd
    df['in_sb']     = (m >= 900) & (m < 960)              & wd  # 15:00-16:00 UTC
    return df

def simulate(trades, tp_r):
    results = []
    for t in trades:
        entry = t['entry']; sl = t['sl']; d = t['dir']
        sl_d  = abs(entry - sl)
        if sl_d < 1e-6: continue
        tp    = entry + d * sl_d * tp_r
        out   = None
        for bh, bl in t['future_bars']:
            if d == 1:
                if bl <= sl:  out = -1.0; break
                if bh >= tp:  out =  tp_r; break
            else:
                if bh >= sl:  out = -1.0; break
                if bl <= tp:  out =  tp_r; break
        results.append({'pnl': out if out is not None else -1.0,
                        'date': t['date'], 'dir': d})
    return results

def metrics(results, weeks):
    if len(results) < 5: return None
    dfr = pd.DataFrame(results)
    dfr['date'] = pd.to_datetime(dfr['date'], utc=True)
    wins = dfr['pnl'] > 0; n = len(dfr)
    wr   = wins.sum()/n
    gp   = dfr.loc[wins,'pnl'].sum(); gl = dfr.loc[~wins,'pnl'].abs().sum()
    pf   = (gp/gl) if gl > 0 else 999.0
    tpw  = n/weeks
    yr   = dfr.groupby(dfr['date'].dt.year).apply(lambda g: (g['pnl']>0).mean()).to_dict()
    miny = min(yr.values()) if yr else 0.0
    try:
        bp = stats.binomtest(int(wins.sum()), n, 0.5, alternative='greater').pvalue
    except: bp = 1.0
    return {'n':n,'tpw':round(tpw,2),'wr':round(wr*100,1),'pf':round(pf,3),
            'min_yr':round(miny*100,1),'yr':{y:round(v*100,1) for y,v in yr.items()},
            'p':round(bp,4),'sig':bp<0.05}

def print_m(m, indent='  '):
    if m is None: print(f"{indent}< 5 trades"); return
    passed = 0.5<=m['tpw']<=3 and m['wr']>=55 and m['pf']>=1.5 and m['min_yr']>=50
    tag  = ' *PASSES' if passed else ''
    sig  = 'OK' if m['sig'] else 'WARN'
    print(f"{indent}n={m['n']} ({m['tpw']}/wk) WR={m['wr']}% PF={m['pf']} MinYr={m['min_yr']}%{tag} {sig}p={m['p']}")

# --- SETUP B: JUDAS SWEEP (15m) -----------------------------------------------
def setup_judas_15m(df, weeks, tp_list):
    print(f"\n{'='*60}")
    print("SETUP B: Judas Sweep (15m proper)")
    print("  Asian 00-07:59 UTC | London 08:00-10:59 | wick sweep + close back")
    print(f"{'='*60}")

    t_all = []; t_any = []
    for date_str, day in df.groupby('date_str'):
        if is_news(date_str) or day['dow'].iloc[0] > 4: continue
        asian  = day[day['in_asian']]
        london = day[day['in_london']]
        if len(asian) < 4 or len(london) == 0: continue
        d_atr  = float(day['d_atr'].iloc[0])
        if pd.isna(d_atr) or d_atr <= 0: continue
        ar_hi  = asian['high'].max(); ar_lo = asian['low'].min()
        done_hi = done_lo = False

        for _, bar in london.iterrows():
            if float(bar['adr']) >= 0.90: continue
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr/4
            h1b = int(bar['h1_bias']); h4b = int(bar['h4_bias'])

            # SHORT: wick above Asian high, close back BELOW
            if not done_hi and bar['high'] > ar_hi and bar['close'] < ar_hi:
                if (bar['high'] - ar_hi) >= atr * 0.40:  # real sweep, not a tick
                    sl  = bar['high'] + atr * 0.60
                    # entry AFTER bar close = next bar open (simulate as limit at ar_hi)
                    fb  = day[day.index > bar.name]
                    fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))
                    t   = {'entry': ar_hi, 'sl': sl, 'dir': -1, 'date': bar.name, 'future_bars': fut}
                    t_all.append(t)
                    if h1b == -1 or h4b == -1: t_any.append(t)
                    done_hi = True

            # LONG: wick below Asian low, close back ABOVE
            if not done_lo and bar['low'] < ar_lo and bar['close'] > ar_lo:
                if (ar_lo - bar['low']) >= atr * 0.40:
                    sl  = bar['low'] - atr * 0.60
                    fb  = day[day.index > bar.name]
                    fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))
                    t   = {'entry': ar_lo, 'sl': sl, 'dir': 1, 'date': bar.name, 'future_bars': fut}
                    t_all.append(t)
                    if h1b == 1 or h4b == 1: t_any.append(t)
                    done_lo = True

    print(f"\n  Signals: no-filter={len(t_all)} | any-HTF={len(t_any)}")
    for tp_r in tp_list:
        print(f"\n  TP {tp_r}R:")
        for lbl, tds in [('No filter', t_all), ('Any HTF', t_any)]:
            r = simulate(tds, tp_r); m = metrics(r, weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t_all

# --- SETUP D: PSYCH LEVEL BOUNCE (15m) ---------------------------------------
def setup_psych_15m(df, weeks, tp_list, tol_pts=5.0):
    print(f"\n{'='*60}")
    print("SETUP D: Psychological Level Bounce (15m proper)")
    print(f"  50pt/100pt gold levels | tol={tol_pts}pt | London+NY overlap")
    print(f"{'='*60}")

    t_any = []; t_all3 = []
    for date_str, day in df.groupby('date_str'):
        if is_news(date_str) or day['dow'].iloc[0] > 4: continue
        kz = day[day['in_kz']]
        if len(kz) == 0: continue
        d_atr = float(day['d_atr'].iloc[0])
        if pd.isna(d_atr) or d_atr <= 0: continue

        fired = set(); done = False
        for _, bar in kz.iterrows():
            if done: break
            if float(bar['adr']) >= 1.20: continue
            atr = float(bar['atr']) if not pd.isna(bar['atr']) and bar['atr'] > 0 else d_atr/4
            cl  = float(bar['close']); hi = float(bar['high']); lo = float(bar['low'])
            h1b = int(bar['h1_bias']); h4b = int(bar['h4_bias']); db = int(bar['d_bias'])
            op  = float(bar['open'])

            lvl50  = round(cl / 50.0)  * 50.0
            lvl100 = round(cl / 100.0) * 100.0
            for near in sorted({lvl50, lvl100}, key=lambda v: abs(cl - v)):
                if near in fired: continue
                if abs(cl - near) > tol_pts * 3: continue

                # Bullish: wick touches or goes below level, bar CLOSES above level
                if lo <= near + tol_pts and cl > near and cl > op:
                    align = (h1b==1)+(h4b==1)+(db==1)
                    if align >= 1:
                        sl_  = lo - max(atr*0.30, tol_pts*1.5)
                        if near - sl_ > 0:
                            fb  = day[day.index > bar.name]
                            fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))
                            t   = {'entry': near, 'sl': sl_, 'dir': 1, 'date': bar.name, 'future_bars': fut}
                            t_any.append(t)
                            if align == 3: t_all3.append(t)
                            fired.add(near); done = True; break

                # Bearish: wick touches or goes above level, bar CLOSES below level
                elif hi >= near - tol_pts and cl < near and cl < op:
                    align = (h1b==-1)+(h4b==-1)+(db==-1)
                    if align >= 1:
                        sl_  = hi + max(atr*0.30, tol_pts*1.5)
                        if sl_ - near > 0:
                            fb  = day[day.index > bar.name]
                            fut = list(zip(fb['high'].astype(float), fb['low'].astype(float)))
                            t   = {'entry': near, 'sl': sl_, 'dir': -1, 'date': bar.name, 'future_bars': fut}
                            t_any.append(t)
                            if align == 3: t_all3.append(t)
                            fired.add(near); done = True; break

    print(f"\n  Signals: any-HTF={len(t_any)} | all-3-HTF={len(t_all3)}")
    for tp_r in tp_list:
        print(f"\n  TP {tp_r}R:")
        for lbl, tds in [('Any HTF', t_any), ('All 3 HTF', t_all3)]:
            r = simulate(tds, tp_r); m = metrics(r, weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t_any, t_all3

# --- SETUP A: FVG + BOS (15m) -------------------------------------------------
def setup_fvg_15m(df, weeks, tp_list):
    """
    Key fix vs H1 version: age >= 1 enforced so FVG entries only happen
    on bars AFTER the FVG was formed (real retest, not same-bar lookahead).
    """
    print(f"\n{'='*60}")
    print("SETUP A: FVG Retest + BOS (15m proper)")
    print("  Fix: age>=1 - entry only on retest bars, not creation bar")
    print(f"{'='*60}")

    ts  = df.index.copy()
    df2 = df.reset_index(drop=True)
    n   = len(df2); SWG = 3
    fvgs = []; bos_bL = bos_bS = None; prev_ph = prev_pl = None
    t1 = []; t2 = []

    for i in range(SWG*2+1, n):
        row  = df2.iloc[i]
        atr  = float(row['atr'])
        if pd.isna(atr) or atr <= 0: continue
        ds   = str(row['date_str']); dow = int(row['dow'])
        if is_news(ds) or dow > 4: continue

        hi = float(row['high']); lo = float(row['low'])
        h1b= int(row['h1_bias']); h4b=int(row['h4_bias']); db=int(row['d_bias'])
        in_kz = bool(row['in_kz']); adr_ = float(row['adr']) if not pd.isna(row['adr']) else 0.0

        # BOS
        pi = i - SWG
        if pi >= SWG:
            ph = float(df2.iloc[pi]['high']); pl = float(df2.iloc[pi]['low'])
            nh = [float(df2.iloc[pi+k]['high']) for k in range(-SWG,SWG+1) if k!=0]
            nl = [float(df2.iloc[pi+k]['low'])  for k in range(-SWG,SWG+1) if k!=0]
            if ph >= max(nh):
                if prev_ph is not None and ph > prev_ph: bos_bL = pi
                prev_ph = ph
            if pl <= min(nl):
                if prev_pl is not None and pl < prev_pl: bos_bS = pi
                prev_pl = pl
        bL = bos_bL is not None and (i-bos_bL) <= 60   # 60 bars = 15 hours on 15m
        bS = bos_bS is not None and (i-bos_bS) <= 60

        # Detect new FVGs
        if i >= 2:
            hi2 = float(df2.iloc[i-2]['high']); lo2 = float(df2.iloc[i-2]['low'])
            if (lo - hi2) >= atr * 0.10:
                fvgs.append({'lo':hi2,'hi':lo,'dir':1,'bi':i,'fill':0.0,'fired':False})
            if (lo2 - hi) >= atr * 0.10:
                fvgs.append({'lo':hi,'hi':lo2,'dir':-1,'bi':i,'fill':0.0,'fired':False})
        fvgs = fvgs[-25:]

        # Fill update
        for f in fvgs:
            gsz = f['hi']-f['lo']
            if gsz <= 0: continue
            if f['dir']==1  and lo < f['hi']:
                f['fill'] = min(1.0, max(f['fill'], (f['hi']-max(f['lo'],lo))/gsz))
            if f['dir']==-1 and hi > f['lo']:
                f['fill'] = min(1.0, max(f['fill'], (min(f['hi'],hi)-f['lo'])/gsz))

        if not in_kz or adr_ >= 0.85: continue

        for f in fvgs:
            if f['fired']: continue
            age = i - f['bi']
            if age == 0: continue           # ? THE KEY FIX: no same-bar entry
            if age > 80 or f['fill'] > 0.50: continue  # 80 bars = 20h on 15m
            d = f['dir']
            touched = ((d==1 and lo<=f['hi'] and hi>=f['lo']) or
                       (d==-1 and hi>=f['lo'] and lo<=f['hi']))
            if not touched: continue
            if not ((d==1 and bL) or (d==-1 and bS)): continue

            entry = f['hi'] if d==1 else f['lo']     # proximal edge
            buf   = atr * 0.20
            sl_p  = (f['lo']-buf) if d==1 else (f['hi']+buf)
            sl_d  = abs(entry-sl_p)
            if sl_d <= 0: continue
            if not (0.30 <= sl_d/atr <= 3.00): continue

            align = (h1b==d)+(h4b==d)+(db==d)
            fut   = list(zip(df2.iloc[i+1:]['high'].astype(float),
                             df2.iloc[i+1:]['low'].astype(float)))
            t = {'entry':entry,'sl':sl_p,'dir':d,'date':ts[i],'future_bars':fut,'align':align}
            f['fired'] = True
            if align >= 1: t1.append(t)
            if align >= 2: t2.append(t)
            break

    print(f"\n  Signals: >=1 HTF={len(t1)} | >=2 HTF={len(t2)}")
    for tp_r in tp_list:
        print(f"\n  TP {tp_r}R:")
        for lbl, tds in [('>=1 HTF', t1), ('>=2 HTF', t2)]:
            r = simulate(tds, tp_r); m = metrics(r, weeks)
            print(f"    {lbl}:"); print_m(m, '      ')
    return t1, t2

# --- SETUP C: SILVER BULLET (15m) ---------------------------------------------
def setup_sb_15m(df, weeks, tp_list):
    """Silver Bullet: FVG retest in 15:00-16:00 UTC window. Same age>=1 fix."""
    print(f"\n{'='*60}")
    print("SETUP C: Silver Bullet (15m proper, 15:00-16:00 UTC)")
    print(f"{'='*60}")

    ts  = df.index.copy()
    df2 = df.reset_index(drop=True)
    n   = len(df2); SWG = 3
    fvgs = []; bos_bL = bos_bS = None; prev_ph = prev_pl = None
    t1 = []; done_dates = set()

    for i in range(SWG*2+1, n):
        row  = df2.iloc[i]
        atr  = float(row['atr'])
        if pd.isna(atr) or atr <= 0: continue
        ds   = str(row['date_str']); dow = int(row['dow'])
        if is_news(ds) or dow > 4: continue

        hi = float(row['high']); lo = float(row['low'])
        h1b= int(row['h1_bias']); h4b=int(row['h4_bias']); db=int(row['d_bias'])
        in_sb = bool(row['in_sb']); adr_ = float(row['adr']) if not pd.isna(row['adr']) else 0.0

        pi = i - SWG
        if pi >= SWG:
            ph = float(df2.iloc[pi]['high']); pl = float(df2.iloc[pi]['low'])
            nh = [float(df2.iloc[pi+k]['high']) for k in range(-SWG,SWG+1) if k!=0]
            nl = [float(df2.iloc[pi+k]['low'])  for k in range(-SWG,SWG+1) if k!=0]
            if ph >= max(nh):
                if prev_ph is not None and ph > prev_ph: bos_bL = pi
                prev_ph = ph
            if pl <= min(nl):
                if prev_pl is not None and pl < prev_pl: bos_bS = pi
                prev_pl = pl
        bL = bos_bL is not None and (i-bos_bL) <= 96
        bS = bos_bS is not None and (i-bos_bS) <= 96

        if i >= 2:
            hi2 = float(df2.iloc[i-2]['high']); lo2 = float(df2.iloc[i-2]['low'])
            if (lo-hi2) >= atr*0.10:
                fvgs.append({'lo':hi2,'hi':lo,'dir':1,'bi':i,'fill':0.0,'fired':False})
            if (lo2-hi) >= atr*0.10:
                fvgs.append({'lo':hi,'hi':lo2,'dir':-1,'bi':i,'fill':0.0,'fired':False})
        fvgs = fvgs[-25:]
        for f in fvgs:
            gsz = f['hi']-f['lo']
            if gsz <= 0: continue
            if f['dir']==1  and lo < f['hi']:
                f['fill'] = min(1.0, max(f['fill'], (f['hi']-max(f['lo'],lo))/gsz))
            if f['dir']==-1 and hi > f['lo']:
                f['fill'] = min(1.0, max(f['fill'], (min(f['hi'],hi)-f['lo'])/gsz))

        if not in_sb or adr_ >= 0.85 or ds in done_dates: continue

        for f in fvgs:
            if f['fired']: continue
            age = i - f['bi']
            if age == 0: continue           # same fix
            if age > 96 or f['fill'] > 0.50: continue
            d = f['dir']
            touched = ((d==1 and lo<=f['hi'] and hi>=f['lo']) or
                       (d==-1 and hi>=f['lo'] and lo<=f['hi']))
            if not touched: continue
            if not ((d==1 and bL) or (d==-1 and bS)): continue

            entry = f['hi'] if d==1 else f['lo']
            buf   = atr * 0.20
            sl_p  = (f['lo']-buf) if d==1 else (f['hi']+buf)
            sl_d  = abs(entry-sl_p)
            if sl_d <= 0 or not (0.30 <= sl_d/atr <= 3.00): continue

            align = (h1b==d)+(h4b==d)+(db==d)
            fut   = list(zip(df2.iloc[i+1:]['high'].astype(float),
                             df2.iloc[i+1:]['low'].astype(float)))
            t1.append({'entry':entry,'sl':sl_p,'dir':d,'date':ts[i],'future_bars':fut,'align':align})
            f['fired'] = True; done_dates.add(ds)
            break

    print(f"\n  Signals: {len(t1)}")
    for tp_r in tp_list:
        print(f"\n  TP {tp_r}R:"); r = simulate(t1, tp_r); m = metrics(r, weeks)
        print_m(m, '    ')
    return t1

# --- MAIN ---------------------------------------------------------------------
if __name__ == '__main__':
    print("=" * 60)
    print(" Gold Specialist - FVG, Judas, Psych, SB on 15m")
    print(" (H1 gave false passes; this is the honest 15m test)")
    print("=" * 60)

    df    = download_15m()
    df    = build_features(df)
    weeks = (df.index[-1] - df.index[0]).days / 7

    days_all  = set(df[df['dow'] <= 4]['date_str'].unique())
    days_excl = days_all & ALL_NEWS
    print(f"\nClean days: {len(days_all)-len(days_excl)} of {len(days_all)} | "
          f"{weeks:.1f} weeks")
    print("NOTE: 60-day window - trends and regimes matter. "
          "Pine strategy on TradingView has the full history.")

    TP = [1.0, 1.5, 2.0]

    setup_judas_15m(df, weeks, TP)
    setup_psych_15m(df, weeks, TP)
    setup_fvg_15m(df, weeks, TP)
    setup_sb_15m(df, weeks, TP)

    print(f"\n{'='*60}")
    print(" Criteria: 0.5-3/wk ? WR>55% ? PF>1.5 ? MinYr>50%")
    print(f"{'='*60}")
