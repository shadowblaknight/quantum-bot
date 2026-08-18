#!/usr/bin/env python3
"""
nas100_amd_miner.py  --  NAS100 AMD Cycle: Judas Sweep + Post-Sweep FVG Entry
=============================================================================
Full ICT strategy -- no day filtering, no limit orders, no curve fitting:
  1. Pre-market range    07:00–09:30 ET  (UTC 11:00–13:30)
  2. Judas sweep         09:30–10:00 ET  (UTC 13:30–14:00)
       LONG : wick below PM Lo, close back inside  -> bear trap
       SHORT: wick above PM Hi, close back inside  -> bull trap
  3. Post-Judas FVG      Silver Bullet 10:00–11:00 ET  (UTC 14:00–15:00)
       Bullish FVG: bar[i-2].high < bar[i].low  (gap = LONG entry zone)
       Bearish FVG: bar[i-2].low  > bar[i].high (gap = SHORT entry zone)
  4. Entry at close when price retraces INTO the FVG
       SL below FVG lo (LONG) / above FVG hi (SHORT) + ATR buffer
  5. DOW Tier (metadata only -- NEVER a filter):
       Tier A: Tue/Wed/Thu   Tier B: Mon   Tier C: Fri

Data: nas100_miner_raw.csv  (broker UTC+3, 15m bars)
"""

import pandas as pd
import numpy as np
import warnings
warnings.filterwarnings('ignore')

# --- TIMEZONE ----------------------------------------------------------------
TZ_OFFSET_HRS = 3   # broker = UTC+3

def _bmin(utc_h, utc_m=0):
    return ((utc_h + TZ_OFFSET_HRS) % 24) * 60 + utc_m

PREMARKET_START = _bmin(11,  0)   # ET 07:00 -> broker 14:00 -> 840
PREMARKET_END   = _bmin(13, 30)   # ET 09:30 -> broker 16:30 -> 990
JUDAS_START     = _bmin(13, 30)   # ET 09:30 -> broker 16:30 -> 990
JUDAS_END       = _bmin(14,  0)   # ET 10:00 -> broker 17:00 -> 1020
SB_START        = _bmin(14,  0)   # ET 10:00 -> broker 17:00 -> 1020
SB_END          = _bmin(15,  0)   # ET 11:00 -> broker 18:00 -> 1080
HARD_CLOSE      = _bmin(16, 30)   # ET 12:30 -> broker 19:30 -> 1170

ATR_PERIOD = 14
EMA_PERIOD = 200
DOW_NAMES  = {0:'Mon', 1:'Tue', 2:'Wed', 3:'Thu', 4:'Fri'}

# --- HELPERS -----------------------------------------------------------------

def compute_atr(df, period=14):
    h, l, c = df['high'], df['low'], df['close']
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()

def compute_ema(series, period):
    return series.ewm(span=period, adjust=False).mean()

def bar_minute(dt):
    return dt.hour * 60 + dt.minute

def simulate_trade(day_df, entry, sl, tp, entry_iloc, direction):
    """Scan bars after entry_iloc for SL/TP/hard-close. Returns (outcome, exit_price, gross_r)."""
    is_long = (direction == 'LONG')
    for iloc in range(entry_iloc + 1, len(day_df)):
        bar  = day_df.iloc[iloc]
        bmin = bar_minute(bar.name)
        if bmin >= HARD_CLOSE:
            ep  = bar['open']
            pnl = (ep - entry) if is_long else (entry - ep)
            rr  = pnl / abs(entry - sl) if abs(entry - sl) > 0 else 0
            return 'hard-close', ep, rr
        sl_hit = bar['low'] <= sl if is_long else bar['high'] >= sl
        tp_hit = bar['high'] >= tp if is_long else bar['low'] <= tp
        if sl_hit and tp_hit:
            return 'loss', sl, -1.0    # conservative: SL first
        if sl_hit:
            return 'loss', sl, -1.0
        if tp_hit:
            return 'win',  tp, abs(tp - entry) / abs(entry - sl)
    return 'open', entry, 0.0

def stats(results):
    if not results:
        return dict(N=0, WR=0.0, PF=0.0, trades_yr=0.0)
    wins   = [r for r in results if r['outcome'] == 'win']
    losses = [r for r in results if r['outcome'] in ('loss', 'hard-close')]
    N      = len(results)
    span   = results[-1]['date'] - results[0]['date']
    yrs    = max(span.days / 365.25, 0.01)
    gw     = sum(r.get('gross_r', 1)        for r in wins)
    gl     = sum(abs(r.get('gross_r', 1))   for r in losses)
    pf     = gw / gl if gl > 0 else (9.99 if gw > 0 else 0.0)
    return dict(N=N, WR=round(len(wins)/N*100, 1), PF=round(pf, 3),
                trades_yr=round(N / yrs, 1))

def fmt_s(s, note=''):
    mark = ' ok' if s['PF'] >= 1.2 else ' ^' if s['PF'] >= 1.0 else ' X'
    return (f"N={s['N']:>4}  {s['trades_yr']:>5.1f}/yr  "
            f"WR={s['WR']:>5.1f}%  PF={s['PF']:>6.3f}{mark}  {note}")

# --- LOAD DATA ---------------------------------------------------------------
print("NAS100 AMD FVG MINER -- ICT Judas Sweep + Post-Sweep FVG Entry")
print("=" * 70)
print("Loading nas100_miner_raw.csv ...")

df = pd.read_csv('nas100_miner_raw.csv', parse_dates=['datetime'])
df = df.set_index('datetime').sort_index()
for c in ['open', 'high', 'low', 'close']:
    df[c] = pd.to_numeric(df[c], errors='coerce')
df = df.dropna(subset=['open', 'high', 'low', 'close'])

span_yrs = (df.index[-1] - df.index[0]).days / 365.25
print(f"  {len(df):,} bars  ({df.index[0].date()} to {df.index[-1].date()})")
print(f"  Dataset: {span_yrs:.2f} years")

# --- HTF BIAS ----------------------------------------------------------------
print("Computing EMA200 H4 + H1 ...")
h4 = df.resample('4h').agg({'open':'first','high':'max','low':'min','close':'last'}).dropna(subset=['close'])
h4['ema200'] = compute_ema(h4['close'], EMA_PERIOD)
h4['bias']   = np.where(h4['close'] > h4['ema200'],  1,
               np.where(h4['close'] < h4['ema200'], -1, 0))

h1 = df.resample('1h').agg({'open':'first','high':'max','low':'min','close':'last'}).dropna(subset=['close'])
h1['ema200'] = compute_ema(h1['close'], EMA_PERIOD)
h1['bias']   = np.where(h1['close'] > h1['ema200'],  1,
               np.where(h1['close'] < h1['ema200'], -1, 0))

df['h4_bias'] = h4['bias'].reindex(df.index, method='ffill').ffill().bfill()
df['h1_bias'] = h1['bias'].reindex(df.index, method='ffill').ffill().bfill()
df['atr15']   = compute_atr(df, ATR_PERIOD)
df['bar_min'] = df.index.hour * 60 + df.index.minute
df['date']    = df.index.date
df['dow']     = df.index.dayofweek   # 0=Mon … 4=Fri

# ===============================================================================
# CORE ENGINE  --  AMD FVG SIGNAL
# ===============================================================================

def run_fvg(df, direction='LONG', tp_mult=1.5, atr_buf=0.20,
            bias_mode='H4', require_judas=True):
    """
    AMD FVG entry signal.
    - No DOW filter of any kind.
    - Entry at close when price retraces into post-Judas FVG (market order).
    - SL anchored to FVG structural level (not the Judas wick).
    - dow_tier stored as metadata: A=Tue/Wed/Thu  B=Mon  C=Fri
    """
    results = []
    grouped = df.groupby('date')

    for day, day_df in grouped:
        dow = int(day_df['dow'].iloc[0])
        if dow >= 5:
            continue

        pm_bars    = day_df[(day_df['bar_min'] >= PREMARKET_START) & (day_df['bar_min'] < PREMARKET_END)]
        judas_bars = day_df[(day_df['bar_min'] >= JUDAS_START)     & (day_df['bar_min'] < JUDAS_END)]
        sb_bars    = day_df[(day_df['bar_min'] >= SB_START)        & (day_df['bar_min'] < SB_END)]

        if len(pm_bars) < 2 or len(judas_bars) == 0 or len(sb_bars) == 0:
            continue

        pm_hi = float(pm_bars['high'].max())
        pm_lo = float(pm_bars['low'].min())
        if pm_hi <= pm_lo:
            continue

        atr_val = float(judas_bars['atr15'].iloc[-1])
        if np.isnan(atr_val) or atr_val <= 0:
            continue

        h4b = int(judas_bars['h4_bias'].iloc[-1])
        h1b = int(judas_bars['h1_bias'].iloc[-1])

        # Bias filter
        if bias_mode == 'H4':
            bias_ok = (h4b == 1) if direction == 'LONG' else (h4b == -1)
        elif bias_mode == 'H4+H1':
            bias_ok = (h4b == 1 and h1b == 1) if direction == 'LONG' else (h4b == -1 and h1b == -1)
        elif bias_mode == 'NONE':
            bias_ok = True
        else:
            bias_ok = (h4b == 1) if direction == 'LONG' else (h4b == -1)

        if not bias_ok:
            continue

        # Judas sweep detection
        if direction == 'LONG':
            judas_ok = any(
                float(row['low']) < pm_lo and float(row['close']) > pm_lo
                for _, row in judas_bars.iterrows()
            )
        else:
            judas_ok = any(
                float(row['high']) > pm_hi and float(row['close']) < pm_hi
                for _, row in judas_bars.iterrows()
            )

        if require_judas and not judas_ok:
            continue

        # All bars from Judas start (needed for 3-bar FVG pattern)
        pj_df   = day_df[day_df['bar_min'] >= JUDAS_START]
        pj_list = [(idx, row) for idx, row in pj_df.iterrows()]

        if len(pj_list) < 3:
            continue

        # -- FIND FIRST FVG COMPLETING IN SB WINDOW --------------------------
        # bar[i-2].high < bar[i].low  -> bullish FVG (LONG)
        # bar[i-2].low  > bar[i].high -> bearish FVG (SHORT)
        # bar[i] must be in the SB window; bar[i-2] can be in Judas window
        fvg     = None
        fvg_idx = None

        for i in range(2, len(pj_list)):
            _, row_i = pj_list[i]
            bmin_i   = int(row_i['bar_min'])
            if not (SB_START <= bmin_i < SB_END):
                continue

            b0h = float(pj_list[i-2][1]['high'])
            b0l = float(pj_list[i-2][1]['low'])
            b2h = float(row_i['high'])
            b2l = float(row_i['low'])

            if direction == 'LONG' and b0h < b2l:
                fvg     = {'lo': b0h, 'hi': b2l, 'ce': (b0h + b2l) / 2.0}
                fvg_idx = i
                break
            elif direction == 'SHORT' and b0l > b2h:
                fvg     = {'hi': b0l, 'lo': b2h, 'ce': (b0l + b2h) / 2.0}
                fvg_idx = i
                break

        if fvg is None:
            continue   # no FVG formed in SB window

        # -- FIND FIRST RETRACEMENT INTO FVG (bar AFTER fvg formation) -------
        entry_price = None
        sl_price    = None
        entry_dt    = None

        for i in range(fvg_idx + 1, len(pj_list)):
            entry_dt_c, row = pj_list[i]
            bmin = int(row['bar_min'])
            if bmin >= SB_END:
                break

            lo = float(row['low'])
            hi = float(row['high'])
            cl = float(row['close'])

            if direction == 'LONG':
                # price dips into bullish FVG
                if lo <= fvg['hi'] and hi >= fvg['lo']:
                    ep = cl
                    sp = fvg['lo'] - atr_val * atr_buf
                    if ep > sp:
                        entry_price = ep
                        sl_price    = sp
                        entry_dt    = entry_dt_c
                        break
            else:
                # price rallies into bearish FVG
                if hi >= fvg['lo'] and lo <= fvg['hi']:
                    ep = cl
                    sp = fvg['hi'] + atr_val * atr_buf
                    if ep < sp:
                        entry_price = ep
                        sl_price    = sp
                        entry_dt    = entry_dt_c
                        break

        if entry_price is None:
            continue

        # Locate entry bar position inside day_df
        iloc_map  = {ts: pos for pos, ts in enumerate(day_df.index)}
        entry_iloc = iloc_map.get(entry_dt)
        if entry_iloc is None:
            continue

        sl_dist  = abs(entry_price - sl_price)
        if sl_dist <= 0:
            continue
        tp_price = (entry_price + sl_dist * tp_mult if direction == 'LONG'
                    else entry_price - sl_dist * tp_mult)

        outcome, exit_p, gross_r = simulate_trade(
            day_df, entry_price, sl_price, tp_price, entry_iloc, direction)

        dow_tier = 'A' if dow in (1, 2, 3) else ('B' if dow == 0 else 'C')

        results.append({
            'date':    pd.Timestamp(day),
            'dow':     dow,
            'tier':    dow_tier,
            'dir':     direction,
            'outcome': 'loss' if outcome == 'hard-close' else outcome,
            'gross_r': gross_r,
            'entry':   entry_price,
            'sl':      sl_price,
            'tp':      tp_price,
            'fvg_lo':  fvg['lo'],
            'fvg_hi':  fvg['hi'],
            'fvg_sz':  fvg['hi'] - fvg['lo'],
            'h4b':     h4b,
            'h1b':     h1b,
        })

    return results


# ===============================================================================
# SECTION 0  --  SIGNAL FREQUENCY FUNNEL (no bias, both directions)
# ===============================================================================
print(f"\n[0/5] AMD FVG Signal Frequency Funnel ...")
print("=" * 70)
print("  Stage funnel: Days -> Judas -> FVG in SB -> FVG retracement (entry)")
print()

total_days = 0
judas_long_days  = judas_short_days  = 0
fvg_long_days    = fvg_short_days    = 0
entry_long_days  = entry_short_days  = 0

for day, day_df in df.groupby('date'):
    dow = int(day_df['dow'].iloc[0])
    if dow >= 5:
        continue
    total_days += 1

    pm_bars    = day_df[(day_df['bar_min'] >= PREMARKET_START) & (day_df['bar_min'] < PREMARKET_END)]
    judas_bars = day_df[(day_df['bar_min'] >= JUDAS_START)     & (day_df['bar_min'] < JUDAS_END)]
    sb_bars    = day_df[(day_df['bar_min'] >= SB_START)        & (day_df['bar_min'] < SB_END)]

    if len(pm_bars) < 2 or len(judas_bars) == 0:
        continue

    pm_hi = float(pm_bars['high'].max())
    pm_lo = float(pm_bars['low'].min())

    jl = any(float(r['low'])  < pm_lo and float(r['close']) > pm_lo for _, r in judas_bars.iterrows())
    js = any(float(r['high']) > pm_hi and float(r['close']) < pm_hi for _, r in judas_bars.iterrows())

    if jl: judas_long_days  += 1
    if js: judas_short_days += 1

    if len(sb_bars) == 0:
        continue

    pj_df   = day_df[day_df['bar_min'] >= JUDAS_START]
    pj_list = list(pj_df.iterrows())

    for direction, judas_ok, fvg_count, entry_count in [
        ('LONG',  jl, 'fvg_long_days',  'entry_long_days'),
        ('SHORT', js, 'fvg_short_days', 'entry_short_days'),
    ]:
        if not judas_ok or len(pj_list) < 3:
            continue

        fvg = None; fvg_idx = None
        for i in range(2, len(pj_list)):
            _, row_i = pj_list[i]
            bmin_i = int(row_i['bar_min'])
            if not (SB_START <= bmin_i < SB_END):
                continue
            b0h = float(pj_list[i-2][1]['high']); b0l = float(pj_list[i-2][1]['low'])
            b2h = float(row_i['high']); b2l = float(row_i['low'])
            if direction == 'LONG' and b0h < b2l:
                fvg = {'lo': b0h, 'hi': b2l}; fvg_idx = i; break
            elif direction == 'SHORT' and b0l > b2h:
                fvg = {'hi': b0l, 'lo': b2h}; fvg_idx = i; break

        if fvg is None:
            continue

        if direction == 'LONG':
            fvg_long_days += 1
        else:
            fvg_short_days += 1

        # Check if retracement exists
        atr_val = float(judas_bars['atr15'].iloc[-1]) if len(judas_bars) else 0
        for i in range(fvg_idx + 1, len(pj_list)):
            _, row = pj_list[i]
            if int(row['bar_min']) >= SB_END:
                break
            lo = float(row['low']); hi = float(row['high']); cl = float(row['close'])
            if direction == 'LONG' and lo <= fvg['hi'] and hi >= fvg['lo']:
                sp = fvg['lo'] - atr_val * 0.20
                if cl > sp:
                    entry_long_days += 1; break
            elif direction == 'SHORT' and hi >= fvg['lo'] and lo <= fvg['hi']:
                sp = fvg['hi'] + atr_val * 0.20
                if cl < sp:
                    entry_short_days += 1; break

def pct(n): return n / max(total_days, 1) * 100

print(f"  Total trading days:             {total_days:>5}")
print()
print(f"  {'Stage':<35}  {'LONG':>8}  {'SHORT':>8}  {'% of days':>10}")
print(f"  {'-----':<35}  {'----':>8}  {'-----':>8}  {'---------':>10}")
print(f"  {'Judas sweep detected':<35}  {judas_long_days:>8}  {judas_short_days:>8}  "
      f"{pct(judas_long_days+judas_short_days):>9.1f}%")
print(f"  {'+ FVG forms in SB window':<35}  {fvg_long_days:>8}  {fvg_short_days:>8}  "
      f"{pct(fvg_long_days+fvg_short_days):>9.1f}%")
print(f"  {'+ Price retraces into FVG':<35}  {entry_long_days:>8}  {entry_short_days:>8}  "
      f"{pct(entry_long_days+entry_short_days):>9.1f}%")
print()
print(f"  FVG-to-Judas yield: LONG {fvg_long_days/max(judas_long_days,1)*100:.0f}%   "
      f"SHORT {fvg_short_days/max(judas_short_days,1)*100:.0f}%")
print(f"  Entry-to-FVG yield: LONG {entry_long_days/max(fvg_long_days,1)*100:.0f}%   "
      f"SHORT {entry_short_days/max(fvg_short_days,1)*100:.0f}%")


# ===============================================================================
# SECTION 1  --  FVG SIGNAL PERFORMANCE  (H4 bias, no DOW filter, both dirs)
# ===============================================================================
print(f"\n[1/5] FVG Signal Performance (H4 bias, no DOW filter) ...")
print("=" * 70)

r_long  = run_fvg(df, direction='LONG',  tp_mult=1.5, bias_mode='H4')
r_short = run_fvg(df, direction='SHORT', tp_mult=1.5, bias_mode='H4')
r_both  = sorted(r_long + r_short, key=lambda x: x['date'])

s_l = stats(r_long)
s_s = stats(r_short)
s_b = stats(r_both)

print(f"  TP=1.5×  ATR buf=0.20  H4 bias  Judas required  No DOW filter")
print()
print(f"  {'Direction':<10}  {fmt_s(stats([]))}")   # header-like spacing
print(f"  {'----------':<10}  {'----------------------------------------'}")
print(f"  {'LONG':<10}  {fmt_s(s_l)}")
print(f"  {'SHORT':<10}  {fmt_s(s_s)}")
print(f"  {'BOTH':<10}  {fmt_s(s_b)}")

# Period breakdown for BOTH
if r_both:
    last_date = r_both[-1]['date']
    print(f"\n  BOTH -- period breakdown:")
    print(f"  {'Period':<6}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'------':<6}  {'----':>4}  {'---------':>9}  {'------':>6}  {'-------':>7}")
    for label, yrs in [('1yr',1),('2yr',2),('3yr',3),('6yr',6)]:
        cutoff = last_date - pd.DateOffset(years=yrs)
        sub    = [r for r in r_both if r['date'] >= cutoff]
        s      = stats(sub)
        star   = ' ***' if s['PF']>=2.0 else ' **' if s['PF']>=1.5 else ' *' if s['PF']>=1.2 else ''
        print(f"  {label:<6}  {s['N']:>4}  {s['trades_yr']:>9.1f}  {s['WR']:>6.1f}  {s['PF']:>7.3f}{star}")

# DOW breakdown (purely informational)
print(f"\n  LONG -- DOW breakdown (informational, no filtering):")
print(f"  {'Day':<5}  {'Tier':<5}  {'N':>4}  {'WR%':>6}  {'PF':>7}")
print(f"  {'-----':<5}  {'-----':<5}  {'----':>4}  {'------':>6}  {'-------':>7}")
for d, name in DOW_NAMES.items():
    sub  = [r for r in r_long if r['dow'] == d]
    s    = stats(sub)
    tier = 'A' if d in (1,2,3) else 'B' if d==0 else 'C'
    print(f"  {name:<5}  {tier:<5}  {s['N']:>4}  {s['WR']:>6.1f}  {s['PF']:>7.3f}")

print()
print(f"  SHORT -- DOW breakdown (informational, no filtering):")
print(f"  {'Day':<5}  {'Tier':<5}  {'N':>4}  {'WR%':>6}  {'PF':>7}")
print(f"  {'-----':<5}  {'-----':<5}  {'----':>4}  {'------':>6}  {'-------':>7}")
for d, name in DOW_NAMES.items():
    sub  = [r for r in r_short if r['dow'] == d]
    s    = stats(sub)
    tier = 'A' if d in (1,2,3) else 'B' if d==0 else 'C'
    print(f"  {name:<5}  {tier:<5}  {s['N']:>4}  {s['WR']:>6.1f}  {s['PF']:>7.3f}")


# ===============================================================================
# SECTION 2  --  DOW TIER ANALYSIS  (Tier A vs B vs C -- NOT a filter)
# ===============================================================================
print(f"\n[2/5] DOW Tier Analysis (metadata only -- no filtering) ...")
print("=" * 70)
print(f"  Tier A: Tue/Wed/Thu  |  Tier B: Mon  |  Tier C: Fri")
print()

for tier_label, tier_days in [('A', (1,2,3)), ('B', (0,)), ('C', (4,))]:
    sub_l = [r for r in r_long  if r['dow'] in tier_days]
    sub_s = [r for r in r_short if r['dow'] in tier_days]
    sub_b = sorted(sub_l + sub_s, key=lambda x: x['date'])
    sl = stats(sub_l); ss = stats(sub_s); sb = stats(sub_b)
    mark = ' **' if sb['PF'] >= 2.0 else ' *' if sb['PF'] >= 1.5 else ''
    print(f"  Tier {tier_label}  LONG : {fmt_s(sl)}")
    print(f"  Tier {tier_label}  SHORT: {fmt_s(ss)}")
    print(f"  Tier {tier_label}  BOTH : {fmt_s(sb)}{mark}")
    print()


# ===============================================================================
# SECTION 3  --  BIAS FILTER COMPARISON
# ===============================================================================
print(f"\n[3/5] Bias Filter Comparison ...")
print("=" * 70)
print(f"  {'Config':<22}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
print(f"  {'----------------------':>22}  {'----':>4}  {'---------':>9}  {'------':>6}  {'-------':>7}")

for label, mode in [('No bias (NONE)', 'NONE'), ('H4 only', 'H4'),
                     ('H1 only', 'H1'), ('H4+H1 both', 'H4+H1')]:
    rl = run_fvg(df, direction='LONG',  bias_mode=mode)
    rs = run_fvg(df, direction='SHORT', bias_mode=mode)
    rb = sorted(rl + rs, key=lambda x: x['date'])
    s  = stats(rb)
    star = ' **' if s['PF']>=2.0 else ' *' if s['PF']>=1.5 else ''
    print(f"  {label:<22}  {s['N']:>4}  {s['trades_yr']:>9.1f}  {s['WR']:>6.1f}  {s['PF']:>7.3f}{star}")


# ===============================================================================
# SECTION 4  --  TP MULTIPLIER SWEEP  (BOTH directions, H4 bias)
# ===============================================================================
print(f"\n[4/5] TP Multiplier Sweep (BOTH, H4, no DOW filter) ...")
print("=" * 70)
print(f"  {'TP mult':<9}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
print(f"  {'---------':>9}  {'----':>4}  {'---------':>9}  {'------':>6}  {'-------':>7}")

best_tp = 1.5; best_pf = 0.0
for tp in [0.50, 0.75, 1.00, 1.25, 1.50, 1.75, 2.00, 2.50, 3.00]:
    rl = run_fvg(df, direction='LONG',  tp_mult=tp, bias_mode='H4')
    rs = run_fvg(df, direction='SHORT', tp_mult=tp, bias_mode='H4')
    rb = sorted(rl + rs, key=lambda x: x['date'])
    s  = stats(rb)
    star = ' **' if s['PF']>=2.0 else ' *' if s['PF']>=1.5 else ''
    print(f"  {tp:<9.2f}  {s['N']:>4}  {s['trades_yr']:>9.1f}  {s['WR']:>6.1f}  {s['PF']:>7.3f}{star}")
    if s['PF'] > best_pf and s['N'] >= 20:
        best_pf = s['PF']; best_tp = tp

print(f"\n  Best TP by PF (N>=20): {best_tp}×  (PF={best_pf:.3f})")


# ===============================================================================
# SECTION 5  --  FINAL DEPLOYMENT VALIDATION
# ===============================================================================
print(f"\n[5/5] * FINAL DEPLOYMENT CONFIG ...")
print("=" * 70)
print(f"  TP={best_tp}×  ATR buf=0.20  H4 EMA200 bias  Judas required  NO DOW filter")
print(f"  BOTH directions  |  FVG-based entry (market at close)")
print()

r_final_l = run_fvg(df, direction='LONG',  tp_mult=best_tp, bias_mode='H4')
r_final_s = run_fvg(df, direction='SHORT', tp_mult=best_tp, bias_mode='H4')
r_final   = sorted(r_final_l + r_final_s, key=lambda x: x['date'])

sl = stats(r_final_l); ss = stats(r_final_s); sb = stats(r_final)

print(f"  LONG : {fmt_s(sl)}")
print(f"  SHORT: {fmt_s(ss)}")
print(f"  BOTH : {fmt_s(sb)}")

# Period breakdown
if r_final:
    last_date = r_final[-1]['date']
    print(f"\n  Period breakdown:")
    print(f"  {'Period':<6}  {'N':>4}  {'Trades/yr':>9}  {'WR%':>6}  {'PF':>7}")
    print(f"  {'------':<6}  {'----':>4}  {'---------':>9}  {'------':>6}  {'-------':>7}")
    for label, yrs in [('1yr',1),('2yr',2),('3yr',3),('6yr',6)]:
        cutoff = last_date - pd.DateOffset(years=yrs)
        sub    = [r for r in r_final if r['date'] >= cutoff]
        s      = stats(sub)
        star   = ' ***' if s['PF']>=2.0 else ' **' if s['PF']>=1.5 else ' *' if s['PF']>=1.2 else ''
        print(f"  {label:<6}  {s['N']:>4}  {s['trades_yr']:>9.1f}  {s['WR']:>6.1f}  {s['PF']:>7.3f}{star}")

    # DOW Tier summary
    print(f"\n  DOW Tier summary (BOTH, final config):")
    print(f"  {'Tier':<6}  {'Days':<14}  {'N':>4}  {'WR%':>6}  {'PF':>7}  Note")
    print(f"  {'------':<6}  {'--------------':<14}  {'----':>4}  {'------':>6}  {'-------':>7}  --------")
    for tier_label, tier_days, note in [
        ('A', (1,2,3), 'Tue/Wed/Thu -- fullsize'),
        ('B', (0,),    'Mon -- monitor'),
        ('C', (4,),    'Fri -- reduced size'),
    ]:
        sub = [r for r in r_final if r['dow'] in tier_days]
        s   = stats(sub)
        print(f"  {tier_label:<6}  {note:<14}  {s['N']:>4}  {s['WR']:>6.1f}  {s['PF']:>7.3f}")

# Final verdict
print()
print("  -" * 35)
s = stats(r_final)
if s['PF'] >= 1.3 and s['trades_yr'] >= 30:
    verdict = f"ok DEPLOY  PF={s['PF']}  {s['trades_yr']:.0f} trades/yr  WR={s['WR']}%"
elif s['PF'] >= 1.0:
    verdict = f"^ MARGINAL -- review period breakdown before deploying"
else:
    verdict = f"X DO NOT DEPLOY -- FVG signal does not show edge at market entry"
print(f"  VERDICT: {verdict}")
print()
print("=" * 70)
print("  DONE")
print("=" * 70)
