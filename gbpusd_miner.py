#!/usr/bin/env python3
"""
gbpusd_miner.py — GBPUSD Specialist Backtest Engine  (multi-timeframe)
=======================================================================
Exact port of qb-gbpusd-specialist-bt.pine v4 signal logic:

  A) SFP   : Asian Sweep Failure — London KZ 07–09 UTC, same-bar
  B) AOI-D : Prior-day H/L rejection  + ≥1 confluence (EMA50 | round# | weekly)
  C) AOI-W : Prior-week H/L rejection + weekly bias  + ≥1 confluence

Timeframe support:
  Signal detection runs on any bar resolution: M15, M30, H1, H4.
  Asian range is always built from the finest available bars.
  Trade labeling (SL/TP hit) uses the finest available bars for accuracy.
  The miner auto-detects the base resolution from the CSV.

Day rules (hard-wired):
  Monday → no signals    |  Thursday → SL × 1.2
  Tuesday → Tier A       |  Friday   → cut at 15:00 UTC

Input : gbpusd_miner_raw.csv  — OHLCV in broker time (default UTC+3)
        Recommended: M15 bars (run gbpusd_download.py — defaults to 15m).
        Or export from TradingView: GBPUSD, TF=15, 5+ years → UTC → set TZ=0.

Output sections:
  1. Baseline (H1, all signals)        5. Confluence sensitivity
  2. Timeframe sweep M15→H4            6. Bias filter impact (reqBias ON/OFF)
  3. TP multiplier sweep               7. Multi-TP scaled exits
  4. Day-of-week breakdown

Requirements:  pip install pandas numpy
"""

import os, warnings
import pandas as pd
import numpy as np
warnings.filterwarnings('ignore')

# ══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════════════

# Downloaded TF files (from gbpusd_download.py).  Miner loads finest available.
TF_FILES = {
    15:  'gbpusd_m15.csv',
    30:  'gbpusd_m30.csv',
    60:  'gbpusd_h1.csv',
    240: 'gbpusd_h4.csv',
}
CACHE_FILE    = 'gbpusd_miner_raw.csv'   # legacy fallback
ATR_PERIOD    = 14
MAX_BARS_FWD  = 120     # max BASE bars forward per trade (120×M15 = 30 hours)

# Broker timezone offset (broker = UTC + TZ_OFFSET_HRS)
# MetaAPI (summer, most brokers): 3.  TradingView UTC export: 0.
TZ_OFFSET_HRS = 3

# Strategy defaults (mirror Pine Script)
TP_MULT_DEF  = 2.0
SL_BUF_DEF   = 0.20
ATR_AOI_DEF  = 0.15
SFP_ADR_MAX  = 1.20
AOI_ADR_MAX  = 0.85
BASE_TF_MIN  = 60       # auto-set by _detect_base_tf()
YEARS_TOTAL  = 1.0      # auto-set from data

_IND_COLS = ['h1_atr', 'd_atr', 'ema50', 'd_bias', 'h4_bias', 'w_bias',
             'prior_day_hi', 'prior_day_lo', 'prior_week_hi', 'prior_week_lo', 'adr_cons']
_TF_NAMES  = {15: 'M15', 30: 'M30', 60: 'H1', 120: 'H2', 240: 'H4'}


# ══════════════════════════════════════════════════════════════════════════════
# SESSION WINDOWS  (broker-time minutes-of-day)
# ══════════════════════════════════════════════════════════════════════════════

def bmin(utc_h, utc_m=0):
    return ((utc_h + TZ_OFFSET_HRS) % 24) * 60 + utc_m

ASIAN_START = bmin(0)       # broker 03:00  (UTC 00:00)
ASIAN_END   = bmin(7)       # broker 10:00  (UTC 07:00)
SFP_START   = bmin(7)       # broker 10:00
SFP_END     = bmin(9)       # broker 12:00  (UTC 09:00)
LDN_END     = bmin(10, 30)  # broker 13:30  (UTC 10:30)
NY_START    = bmin(13, 30)  # broker 16:30  (UTC 13:30)
NY_END      = bmin(15)      # broker 18:00  (UTC 15:00)
EOS_BMIN    = bmin(15)      # hard close-all

def _bm(ts):             return ts.hour * 60 + ts.minute
def _in_asian(bm):       return ASIAN_START <= bm < ASIAN_END
def _in_sfp(bm):         return SFP_START   <= bm < SFP_END
def _in_ldn_ext(bm):     return SFP_END     <= bm < LDN_END
def _in_ny(bm):          return NY_START    <= bm < NY_END
def _in_active(bm):      return _in_sfp(bm) or _in_ldn_ext(bm) or _in_ny(bm)


# ══════════════════════════════════════════════════════════════════════════════
# UTILITIES
# ══════════════════════════════════════════════════════════════════════════════

def _detect_base_tf(df):
    """Detect median bar interval in minutes."""
    diffs = df.index.to_series().diff().dropna().dt.total_seconds() / 60
    med   = diffs[diffs > 0].median()
    for tf in [1, 5, 15, 30, 60, 120, 240, 1440]:
        if abs(med - tf) <= tf * 0.4:
            return tf
    return max(1, int(round(med)))


def compute_atr(df, period=14):
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift(1)).abs(),
        (df['low']  - df['close'].shift(1)).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()


def htf_bias(base_df, tf_minutes, ema_p=20):
    ohlc = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
    htf  = base_df.resample(f'{tf_minutes}min', closed='right', label='right').agg(ohlc).dropna()
    ema  = htf['close'].ewm(span=ema_p, adjust=False).mean()
    bias = np.where(htf['close'].shift(1) > ema.shift(1),  1,
           np.where(htf['close'].shift(1) < ema.shift(1), -1, 0))
    return (pd.Series(bias, index=htf.index)
              .reindex(base_df.index, method='ffill')
              .fillna(0).astype(int))


def htf_bias_weekly(base_df, ema_p=20):
    ohlc = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
    htf  = base_df.resample('W-MON', closed='left', label='left').agg(ohlc).dropna()
    ema  = htf['close'].ewm(span=ema_p, adjust=False).mean()
    bias = np.where(htf['close'].shift(1) > ema.shift(1),  1,
           np.where(htf['close'].shift(1) < ema.shift(1), -1, 0))
    return (pd.Series(bias, index=htf.index)
              .reindex(base_df.index, method='ffill')
              .fillna(0).astype(int))


def near_round(p):
    """Within 5 pips of a 50-pip level — mirrors f_nearRound() in Pine."""
    nearest = round(p / 0.0050) * 0.0050
    return abs(p - nearest) <= 0.0005


def label_long(df_base_fwd, entry, sl, tp):
    mfe = 0.0
    for i in range(min(MAX_BARS_FWD, len(df_base_fwd))):
        bar  = df_base_fwd.iloc[i]
        tidx = df_base_fwd.index[i]
        if _bm(tidx) >= EOS_BMIN:      return False, i+1, tidx, mfe
        mfe = max(mfe, bar['high'] - entry)   # update BEFORE SL/TP so winning bar is captured
        if bar['low']  <= sl:           return False, i+1, tidx, mfe
        if bar['high'] >= tp:           return True,  i+1, tidx, mfe
    n = min(MAX_BARS_FWD, len(df_base_fwd))
    return False, n, (df_base_fwd.index[n-1] if n > 0 else None), mfe


def label_short(df_base_fwd, entry, sl, tp):
    mfe = 0.0
    for i in range(min(MAX_BARS_FWD, len(df_base_fwd))):
        bar  = df_base_fwd.iloc[i]
        tidx = df_base_fwd.index[i]
        if _bm(tidx) >= EOS_BMIN:      return False, i+1, tidx, mfe
        mfe = max(mfe, entry - bar['low'])     # update BEFORE SL/TP so winning bar is captured
        if bar['high'] >= sl:           return False, i+1, tidx, mfe
        if bar['low']  <= tp:           return True,  i+1, tidx, mfe
    n = min(MAX_BARS_FWD, len(df_base_fwd))
    return False, n, (df_base_fwd.index[n-1] if n > 0 else None), mfe


def compute_pf(wins_bool, tp_dists, sl_dists):
    gw = np.where(wins_bool,  tp_dists, 0.0).sum()
    gl = np.where(~wins_bool, sl_dists, 0.0).sum()
    return gw / gl if gl > 0 else float('inf')


def _tf_name(tf):
    return _TF_NAMES.get(tf, f'{tf}m')


def _summary_row(df_s, label, pad=40):
    if df_s is None or df_s.empty:
        print(f"  {label:<{pad}}  — no signals")
        return
    w  = df_s['win'].values.astype(bool)
    pf = compute_pf(w, df_s['tp1_dist'].values, df_s['sl_dist'].values)
    n  = len(df_s)
    tyr = n / YEARS_TOTAL
    star = ' ★★★' if pf >= 1.8 and w.mean() >= 0.55 else (' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else ''))
    print(f"  {label:<{pad}}  N={n:4d} (~{tyr:5.1f}/yr)  WR={w.mean()*100:5.1f}%  PF={pf:.3f}{star}")


# ══════════════════════════════════════════════════════════════════════════════
# LOAD + ENRICH  (always on base resolution)
# ══════════════════════════════════════════════════════════════════════════════

def load_and_enrich():
    global BASE_TF_MIN, YEARS_TOTAL

    # Pick the finest downloaded TF file available
    chosen_file = None
    for tf_min in sorted(TF_FILES.keys()):           # 15, 30, 60, 240
        fname = TF_FILES[tf_min]
        if os.path.exists(fname):
            chosen_file = fname
            break

    if chosen_file is None:
        # Legacy fallback
        if os.path.exists(CACHE_FILE):
            chosen_file = CACHE_FILE
        else:
            print("ERROR: No GBPUSD data files found.")
            print("  Run:  python gbpusd_download.py")
            print("  This downloads M15, M30, H1, H4 → gbpusd_m15.csv etc.")
            print("  Or export from TradingView and rename to gbpusd_m15.csv")
            return None

    print(f"Loading {chosen_file} ...")
    df = pd.read_csv(chosen_file, parse_dates=['datetime'])
    df = df.sort_values('datetime').drop_duplicates('datetime').set_index('datetime')
    df.index = df.index.tz_localize(None)

    BASE_TF_MIN = _detect_base_tf(df)
    span_days   = (df.index[-1] - df.index[0]).days
    YEARS_TOTAL = max(1.0, round(span_days / 365.25, 2))
    tf_name     = _tf_name(BASE_TF_MIN)

    print(f"  {len(df):,} bars  ({df.index[0].date()} → {df.index[-1].date()})")
    print(f"  Base timeframe: {tf_name} ({BASE_TF_MIN}min)    Span: {YEARS_TOTAL:.2f} years")

    # ── Timezone diagnostic ─────────────────────────────────────────────────
    vol_col = 'volume' if 'volume' in df.columns else 'close'
    hourly  = df.groupby(df.index.hour)[vol_col].count()
    peak    = hourly.idxmax()
    utc_peak = (peak - TZ_OFFSET_HRS) % 24
    print(f"  Busiest hour: broker {peak:02d}:00  →  UTC {utc_peak:02d}:00  "
          f"(GBPUSD London peak expected UTC 08–10)")
    if abs(utc_peak - 9) > 3:
        print(f"  ** WARNING: peak UTC hour {utc_peak} seems off.  "
              f"Try adjusting TZ_OFFSET_HRS (current={TZ_OFFSET_HRS})")
    print(f"  Session windows (broker UTC+{TZ_OFFSET_HRS}):")
    print(f"    Asian   00–07 UTC  → broker {ASIAN_START//60:02d}:00–{ASIAN_END//60:02d}:00")
    print(f"    SFP KZ  07–09 UTC  → broker {SFP_START//60:02d}:00–{SFP_END//60:02d}:00")
    print(f"    LDN ext 09–10:30   → broker {SFP_END//60:02d}:00–{LDN_END//60:02d}:30")
    print(f"    NY      13:30–15   → broker {NY_START//60:02d}:30–{NY_END//60:02d}:00")

    print(f"Computing {tf_name} ATR, EMA50, H4/D/W biases ...")
    df['h1_atr']  = compute_atr(df, ATR_PERIOD)    # always named h1_atr; may be M15 ATR
    df['ema50']   = df['close'].ewm(span=50, adjust=False).mean()
    df['d_bias']  = htf_bias(df, 1440, ema_p=20)
    df['h4_bias'] = htf_bias(df,  240, ema_p=20)
    df['w_bias']  = htf_bias_weekly(df, ema_p=20)

    # Daily ATR (for AOI confluence + ADR gate)
    daily = df.resample('D').agg({'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}).dropna(subset=['close'])
    d_atr = compute_atr(daily, ATR_PERIOD)
    df['d_atr'] = d_atr.reindex(df.index, method='ffill').ffill().bfill()

    # Prior-day H/L
    prior_day = daily[['high', 'low']].shift(1).rename(
        columns={'high': 'prior_day_hi', 'low': 'prior_day_lo'})
    df = df.join(prior_day.reindex(df.index, method='ffill'))

    # Prior-week H/L
    weekly = df.resample('W-MON', closed='left', label='left').agg(
        {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}).dropna(subset=['close'])
    prior_week = weekly[['high', 'low']].shift(1).rename(
        columns={'high': 'prior_week_hi', 'low': 'prior_week_lo'})
    df = df.join(prior_week.reindex(df.index, method='ffill'))

    # Running daily range (ADR consumed — updated every base bar)
    df['_dt']      = df.index.date
    df['_day_hi']  = df.groupby('_dt')['high'].transform('cummax')
    df['_day_lo']  = df.groupby('_dt')['low'].transform('cummin')
    df['adr_cons'] = np.where(df['d_atr'] > 0, (df['_day_hi'] - df['_day_lo']) / df['d_atr'], 0.0)
    df.drop(columns=['_dt', '_day_hi', '_day_lo'], inplace=True)

    print(f"  Ready.  Shape: {df.shape}")
    return df


# ══════════════════════════════════════════════════════════════════════════════
# SIGNAL COLLECTION  — supports any tf_minutes >= BASE_TF_MIN
# ══════════════════════════════════════════════════════════════════════════════

def collect_signals(df_base,
                    tf_minutes  = None,     # None = use base TF
                    tp_mult     = TP_MULT_DEF,
                    sl_buf      = SL_BUF_DEF,
                    atr_aoi     = ATR_AOI_DEF,
                    sfp_adr_max = SFP_ADR_MAX,
                    aoi_adr_max = AOI_ADR_MAX,
                    req_bias    = False,
                    max_trades  = 1,
                    run_sfp     = True,
                    run_aoid    = True,
                    run_aoiw    = True,
                    run_shorts  = True):
    """
    Signal detection on tf_minutes bars.
    Asian range + trade labeling always on df_base (finest bars).
    If tf_minutes > BASE_TF_MIN, the OHLCV is resampled to tf_minutes;
    all indicator values are forward-filled from df_base to keep them aligned.
    """
    tf = tf_minutes if tf_minutes and tf_minutes >= BASE_TF_MIN else BASE_TF_MIN

    # Build the "entry bar" DataFrame at the chosen TF
    if tf == BASE_TF_MIN:
        df_entry = df_base
    else:
        ohlc_agg = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
        df_entry = (df_base.resample(f'{tf}min', closed='left', label='left')
                           .agg(ohlc_agg)
                           .dropna(subset=['close']))
        for col in _IND_COLS:
            if col in df_base.columns:
                df_entry[col] = df_base[col].reindex(df_entry.index, method='ffill')

    rows  = []
    dates = sorted(set(df_base.index.date))

    for date in dates:
        ts  = pd.Timestamp(date)
        dow = ts.dayofweek          # 0=Mon … 4=Fri
        if dow >= 5 or dow == 0:    # weekend or Monday
            continue

        thu_mult = 1.2 if dow == 3 else 1.0

        # Asian range built from finest available bars
        base_day  = df_base[df_base.index.date == date]
        asn_bars  = base_day[[_in_asian(_bm(i)) for i in base_day.index]]
        if asn_bars.empty:
            continue
        asian_hi = asn_bars['high'].max()
        asian_lo = asn_bars['low'].min()

        # Signal detection on entry-TF bars
        entry_day = df_entry[df_entry.index.date == date]
        if entry_day.empty:
            continue

        trades = sfpL = sfpS = aoidL = aoidS = aoiwL = aoiwS = 0, False, False, False, False, False, False
        trades, sfpL, sfpS, aoidL, aoidS, aoiwL, aoiwS = 0, False, False, False, False, False, False

        for idx, bar in entry_day.iterrows():
            bm = _bm(idx)
            if trades >= max_trades:     break
            if dow == 4 and bm >= EOS_BMIN: break
            if not _in_active(bm):       continue

            atr = bar.get('h1_atr', np.nan)
            if np.isnan(atr) or atr <= 0:  continue

            adr  = bar.get('adr_cons', 0.0)
            dB   = int(bar.get('d_bias', 0))
            h4B  = int(bar.get('h4_bias', 0))
            wB   = int(bar.get('w_bias', 0))
            e50  = bar.get('ema50', np.nan)
            dAtr = bar.get('d_atr', np.nan)
            pdh  = bar.get('prior_day_hi', np.nan)
            pdl  = bar.get('prior_day_lo', np.nan)
            pwh  = bar.get('prior_week_hi', np.nan)
            pwl  = bar.get('prior_week_lo', np.nan)

            biasL = (not req_bias) or (dB == 1  and h4B == 1)
            biasS = (not req_bias) or (dB == -1 and h4B == -1)

            df_fwd = df_base[df_base.index > idx]  # finest bars for trade labeling

            # ─── A) SFP ────────────────────────────────────────────────────
            if run_sfp and _in_sfp(bm) and adr <= sfp_adr_max:

                if biasL and not sfpL:
                    if bar['low'] < asian_lo and bar['close'] > asian_lo:
                        ep, sl, dist = bar['close'], bar['low'] - atr * sl_buf * thu_mult, 0.0
                        dist = ep - sl
                        if dist > 0:
                            win, bh, ext, mfe = label_long(df_fwd, ep, sl, ep + dist * tp_mult)
                            rows.append(_mkrow(date, idx, ext, 'SFP', 'long', ts, dow, ep, sl,
                                              ep+dist*tp_mult, ep+dist*(tp_mult+1.0), dist,
                                              win, bh, mfe, atr, adr, dB, h4B, wB, 0, 0, 0, thu_mult, tf))
                            sfpL = True; trades += 1

                if run_shorts and biasS and not sfpS and trades < max_trades:
                    if bar['high'] > asian_hi and bar['close'] < asian_hi:
                        ep = bar['close']; sl = bar['high'] + atr * sl_buf * thu_mult
                        dist = sl - ep
                        if dist > 0:
                            win, bh, ext, mfe = label_short(df_fwd, ep, sl, ep - dist * tp_mult)
                            rows.append(_mkrow(date, idx, ext, 'SFP', 'short', ts, dow, ep, sl,
                                              ep-dist*tp_mult, ep-dist*(tp_mult+1.0), dist,
                                              win, bh, mfe, atr, adr, dB, h4B, wB, 0, 0, 0, thu_mult, tf))
                            sfpS = True; trades += 1

            # ─── B) AOI-D ──────────────────────────────────────────────────
            if run_aoid and _in_active(bm) and adr <= aoi_adr_max:

                if biasL and not aoidL and not np.isnan(pdl) and trades < max_trades:
                    touch = bar['low'] <= pdl and bar['close'] > pdl
                    emaC = not (np.isnan(e50) or np.isnan(dAtr)) and abs(e50 - pdl) <= atr_aoi * dAtr
                    rnC  = near_round(pdl)
                    wkC  = not np.isnan(pwl) and not np.isnan(dAtr) and abs(pwl - pdl) <= atr_aoi * dAtr
                    if touch and (emaC or rnC or wkC):
                        ep = bar['close']; sl = bar['low'] - atr * sl_buf * thu_mult
                        dist = ep - sl
                        if dist > 0:
                            tp1 = ep + dist * tp_mult
                            tp2 = pdh if not np.isnan(pdh) and pdh > ep else ep + dist * (tp_mult + 1.0)
                            win, bh, ext, mfe = label_long(df_fwd, ep, sl, tp1)
                            rows.append(_mkrow(date, idx, ext, 'AOI-D', 'long', ts, dow, ep, sl,
                                              tp1, tp2, dist, win, bh, mfe, atr, adr, dB, h4B, wB,
                                              int(emaC), int(rnC), int(wkC), thu_mult, tf))
                            aoidL = True; trades += 1

                if run_shorts and biasS and not aoidS and not np.isnan(pdh) and trades < max_trades:
                    touch = bar['high'] >= pdh and bar['close'] < pdh
                    emaC = not (np.isnan(e50) or np.isnan(dAtr)) and abs(e50 - pdh) <= atr_aoi * dAtr
                    rnC  = near_round(pdh)
                    wkC  = not np.isnan(pwh) and not np.isnan(dAtr) and abs(pwh - pdh) <= atr_aoi * dAtr
                    if touch and (emaC or rnC or wkC):
                        ep = bar['close']; sl = bar['high'] + atr * sl_buf * thu_mult
                        dist = sl - ep
                        if dist > 0:
                            tp1 = ep - dist * tp_mult
                            tp2 = pdl if not np.isnan(pdl) and pdl < ep else ep - dist * (tp_mult + 1.0)
                            win, bh, ext, mfe = label_short(df_fwd, ep, sl, tp1)
                            rows.append(_mkrow(date, idx, ext, 'AOI-D', 'short', ts, dow, ep, sl,
                                              tp1, tp2, dist, win, bh, mfe, atr, adr, dB, h4B, wB,
                                              int(emaC), int(rnC), int(wkC), thu_mult, tf))
                            aoidS = True; trades += 1

            # ─── C) AOI-W ──────────────────────────────────────────────────
            if run_aoiw and _in_active(bm) and adr <= aoi_adr_max:

                if wB == 1 and not aoiwL and not np.isnan(pwl) and trades < max_trades:
                    touch = bar['low'] <= pwl and bar['close'] > pwl
                    rnC   = near_round(pwl)
                    dAg   = dB == 1
                    if touch and (rnC or dAg):
                        ep = bar['close']; sl = bar['low'] - atr * sl_buf * 1.5 * thu_mult
                        dist = ep - sl
                        if dist > 0:
                            tp1 = ep + dist * tp_mult; tp2 = ep + dist * (tp_mult + 1.5)
                            win, bh, ext, mfe = label_long(df_fwd, ep, sl, tp1)
                            rows.append(_mkrow(date, idx, ext, 'AOI-W', 'long', ts, dow, ep, sl,
                                              tp1, tp2, dist, win, bh, mfe, atr, adr, dB, h4B, wB,
                                              0, int(rnC), int(dAg), thu_mult, tf))
                            aoiwL = True; trades += 1

                if run_shorts and wB == -1 and not aoiwS and not np.isnan(pwh) and trades < max_trades:
                    touch = bar['high'] >= pwh and bar['close'] < pwh
                    rnC   = near_round(pwh)
                    dAg   = dB == -1
                    if touch and (rnC or dAg):
                        ep = bar['close']; sl = bar['high'] + atr * sl_buf * 1.5 * thu_mult
                        dist = sl - ep
                        if dist > 0:
                            tp1 = ep - dist * tp_mult; tp2 = ep - dist * (tp_mult + 1.5)
                            win, bh, ext, mfe = label_short(df_fwd, ep, sl, tp1)
                            rows.append(_mkrow(date, idx, ext, 'AOI-W', 'short', ts, dow, ep, sl,
                                              tp1, tp2, dist, win, bh, mfe, atr, adr, dB, h4B, wB,
                                              0, int(rnC), int(dAg), thu_mult, tf))
                            aoiwS = True; trades += 1

    return pd.DataFrame(rows)


def _mkrow(date, sig_ts, exit_ts, sig, direction, ts, dow,
           ep, sl, tp1, tp2, dist, win, bh, mfe,
           atr, adr, dB, h4B, wB, c_ema, c_rn, c_wk, thu_mult, tf):
    return {
        'date': date, 'signal_ts': sig_ts, 'exit_ts': exit_ts,
        'tf': tf,
        'signal': sig, 'direction': direction,
        'dow': ts.day_name()[:3], 'dow_idx': dow,
        'entry': ep, 'sl': sl, 'tp1': tp1, 'tp2': tp2,
        'sl_dist': dist, 'tp1_dist': dist * tp1 / tp1 if tp1 else dist,  # = dist (same R)
        'dist_R': dist,
        'win': int(win), 'bars_held': bh, 'mfe': mfe,
        'h1_atr': atr, 'adr': adr,
        'd_bias': dB, 'h4_bias': h4B, 'w_bias': wB,
        'conf_ema': c_ema, 'conf_rn': c_rn, 'conf_wk': c_wk,
        'thu_mult': thu_mult,
    }


# Fix tp1_dist to always equal dist_R (tp1_dist is SL distance, used as 1R)
def _fix_dist(df_s):
    df_s = df_s.copy()
    df_s['tp1_dist'] = df_s['dist_R']    # 1R = SL distance
    return df_s


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — BASELINE SUMMARY  (H1)
# ══════════════════════════════════════════════════════════════════════════════

def section_baseline(df_sig):
    print("\n" + "═" * 72)
    print("SECTION 1 — BASELINE SUMMARY  (H1, TP=2R, SL=0.20×ATR, reqBias=OFF)")
    print("═" * 72)

    if df_sig.empty:
        print("  No signals. Check TZ_OFFSET_HRS and session window printout above."); return

    df = _fix_dist(df_sig)
    df['date_ts'] = pd.to_datetime(df['date'])
    latest = df['date_ts'].max()

    w  = df['win'].values.astype(bool)
    pf = compute_pf(w, df['tp1_dist'].values, df['sl_dist'].values)
    print(f"\n  Full dataset: N={len(df)}  WR={w.mean()*100:.1f}%  PF={pf:.3f}"
          f"  ~{len(df)/YEARS_TOTAL:.0f} trades/yr")

    print(f"\n  {'Period':6}  {'N':>5}  {'/yr':>5}  {'WR%':>6}  {'PF':>6}")
    print(f"  {'─'*6}  {'─'*5}  {'─'*5}  {'─'*6}  {'─'*6}")
    for yrs, lbl in [(1,'1yr'),(2,'2yr'),(3,'3yr'),(5,'5yr')]:
        sub = df[df['date_ts'] >= latest - pd.DateOffset(years=yrs)]
        if len(sub) < 5: continue
        ww  = sub['win'].values.astype(bool)
        sp  = compute_pf(ww, sub['tp1_dist'].values, sub['sl_dist'].values)
        star = ' ***' if sp >= 1.8 else (' **' if sp >= 1.5 else (' *' if sp >= 1.3 else ''))
        print(f"  {lbl:6}  {len(sub):>5}  {len(sub)/yrs:>5.0f}  {ww.mean()*100:>6.1f}  {sp:>6.3f}{star}")

    print(f"\n  By signal type:")
    for sig in ['SFP', 'AOI-D', 'AOI-W']:
        _summary_row(df[df['signal'] == sig], sig)

    print(f"\n  By direction:")
    for d in ['long', 'short']:
        _summary_row(df[df['direction'] == d], d.upper())

    print(f"\n  SFP — weekday split:")
    sfp = df[df['signal'] == 'SFP']
    for d in ['Tue', 'Wed', 'Thu', 'Fri']:
        _summary_row(sfp[sfp['dow'] == d], f"    {d}")


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — TIMEFRAME SWEEP  M15 / M30 / H1 / H4
# ══════════════════════════════════════════════════════════════════════════════

def section_tf_sweep(df_base, tp_mult=TP_MULT_DEF, sl_buf=SL_BUF_DEF):
    print("\n" + "═" * 72)
    print("SECTION 2 — TIMEFRAME SWEEP  (same signals, different bar resolution)")
    print("═" * 72)
    print(f"\n  Signal detection TF changes the bar used for the entry condition.")
    print(f"  Trade labeling always uses the finest available bars ({_tf_name(BASE_TF_MIN)}).")
    print(f"  SFP condition: wick through Asian H/L + body close back inside — on THAT TF bar.")

    # Show which native files exist vs resampled
    native = [_tf_name(tf) for tf, f in TF_FILES.items() if os.path.exists(f)]
    print(f"  Native CSVs on disk: {', '.join(native) if native else 'none'}"
          f"  (others resampled from {_tf_name(BASE_TF_MIN)})\n")

    tfs      = [tf for tf in [15, 30, 60, 240] if tf >= BASE_TF_MIN]
    results  = {}

    print(f"  {'TF':5}  {'N':>5}  {'/yr':>5}  {'WR%':>6}  {'PF':>6}  SFP  AOI-D  AOI-W")
    print(f"  {'─'*5}  {'─'*5}  {'─'*5}  {'─'*6}  {'─'*6}  {'─'*3}  {'─'*5}  {'─'*5}")

    for tf in tfs:
        df_s = _fix_dist(collect_signals(df_base, tf_minutes=tf,
                                         tp_mult=tp_mult, sl_buf=sl_buf))
        results[tf] = df_s
        if df_s.empty:
            print(f"  {_tf_name(tf):5}  — no signals"); continue

        w   = df_s['win'].values.astype(bool)
        pf  = compute_pf(w, df_s['tp1_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / YEARS_TOTAL
        ns  = len(df_s[df_s['signal'] == 'SFP'])
        nd  = len(df_s[df_s['signal'] == 'AOI-D'])
        nw  = len(df_s[df_s['signal'] == 'AOI-W'])
        star = ' ★★★' if pf >= 1.8 else (' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else ''))
        bl   = '  ← live TF' if tf == 60 else ''
        print(f"  {_tf_name(tf):5}  {len(df_s):>5}  {tyr:>5.0f}  {w.mean()*100:>6.1f}  {pf:>6.3f}  "
              f"{ns:>3}  {nd:>5}  {nw:>5}{star}{bl}")

    # Best TF per signal type
    print(f"\n  Best TF per signal type (by PF):")
    for sig in ['SFP', 'AOI-D', 'AOI-W']:
        best_tf = best_pf = None
        for tf, df_s in results.items():
            sub = df_s[df_s['signal'] == sig] if not df_s.empty else pd.DataFrame()
            if len(sub) < 5: continue
            w  = sub['win'].values.astype(bool)
            pf = compute_pf(w, sub['tp1_dist'].values, sub['sl_dist'].values)
            if best_pf is None or pf > best_pf:
                best_pf = pf; best_tf = tf
        if best_tf:
            sub = results[best_tf][results[best_tf]['signal'] == sig]
            w = sub['win'].values.astype(bool)
            print(f"    {sig:6}  → {_tf_name(best_tf):4}  "
                  f"N={len(sub)}  WR={w.mean()*100:.1f}%  PF={best_pf:.3f}")

    return results


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — TP MULTIPLIER SWEEP  (uses MFE — no re-running)
# ══════════════════════════════════════════════════════════════════════════════

def section_tp_sweep(df_sig, label="H1 baseline"):
    print("\n" + "═" * 72)
    print(f"SECTION 3 — TP MULTIPLIER SWEEP  [{label}]")
    print("═" * 72)

    df = _fix_dist(df_sig)
    if len(df) < 10:
        print("  Not enough data."); return None

    mfe_arr = df['mfe'].values
    sl_arr  = df['sl_dist'].values
    tp_mults = np.round(np.arange(0.5, 5.01, 0.25), 2)
    results  = []

    for tm in tp_mults:
        tp_d  = tm * sl_arr         # TP distance = R × SL_dist (so TP_mult=2 means 2R)
        wins  = mfe_arr >= tp_d
        pf    = compute_pf(wins, tp_d, sl_arr)
        results.append({'tp_mult': tm, 'wr': wins.mean()*100, 'pf': pf, 'n_wins': int(wins.sum())})

    df_sw = pd.DataFrame(results)

    print(f"\n  {'TP mult':>8}  {'WR%':>6}  {'PF':>7}  {'Wins':>5}  notes")
    print(f"  {'─'*8}  {'─'*6}  {'─'*7}  {'─'*5}")

    h50 = h15 = h18 = False
    for _, r in df_sw.iterrows():
        tm, wr, pf = r['tp_mult'], r['wr'], r['pf']
        note = ''
        if wr >= 50.0 and not h50: note += ' ← WR 50%'; h50 = True
        if pf >= 1.5  and not h15: note += ' ← PF 1.5'; h15 = True
        if pf >= 1.8  and not h18: note += ' ← PF 1.8'; h18 = True
        if abs(tm - round(tm)) < 0.001 or note:
            star = ' ★★★' if pf >= 1.8 and wr >= 50 else (' ★★' if pf >= 1.5 else (' ★' if wr >= 55 else ''))
            print(f"  {tm:>8.2f}  {wr:>6.1f}  {pf:>7.3f}  {int(r['n_wins']):>5}  {note}{star}")

    best_pf = df_sw.loc[df_sw['pf'].idxmax()]
    print(f"\n  Best PF: TP={best_pf['tp_mult']:.2f}×  WR={best_pf['wr']:.1f}%  PF={best_pf['pf']:.3f}")
    valid = df_sw[df_sw['wr'] >= 50.0]
    if not valid.empty:
        best = valid.loc[valid['pf'].idxmax()]
        print(f"  Best PF (WR≥50%): TP={best['tp_mult']:.2f}×  WR={best['wr']:.1f}%  PF={best['pf']:.3f}")

    return df_sw


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — DAY-OF-WEEK BREAKDOWN
# ══════════════════════════════════════════════════════════════════════════════

def section_dow(df_sig):
    print("\n" + "═" * 72)
    print("SECTION 4 — DAY-OF-WEEK  (Monday always excluded)")
    print("═" * 72)

    df = _fix_dist(df_sig)
    print(f"\n  {'Day':4}  {'N':>5}  {'/yr':>5}  {'WR%':>6}  {'PF':>6}  notes")
    print(f"  {'─'*4}  {'─'*5}  {'─'*5}  {'─'*6}  {'─'*6}")

    for d in ['Tue', 'Wed', 'Thu', 'Fri']:
        sub = df[df['dow'] == d]
        if len(sub) < 3: print(f"  {d:4}  <3"); continue
        w  = sub['win'].values.astype(bool)
        pf = compute_pf(w, sub['tp1_dist'].values, sub['sl_dist'].values)
        note = '  Tier A' if d == 'Tue' else ('  BOE risk (SL×1.2)' if d == 'Thu' else '')
        star = ' ★' if pf >= 1.3 else ''
        print(f"  {d:4}  {len(sub):>5}  {len(sub)/YEARS_TOTAL:>5.0f}  {w.mean()*100:>6.1f}  {pf:>6.3f}{star}{note}")

    print(f"\n  DOW × signal type:")
    print(f"  {'Day':4}  {'Sig':6}  {'N':>4}  {'WR%':>6}  {'PF':>6}")
    for d in ['Tue', 'Wed', 'Thu', 'Fri']:
        for sig in ['SFP', 'AOI-D', 'AOI-W']:
            sub = df[(df['dow'] == d) & (df['signal'] == sig)]
            if len(sub) < 3: continue
            w  = sub['win'].values.astype(bool)
            pf = compute_pf(w, sub['tp1_dist'].values, sub['sl_dist'].values)
            star = ' ★' if pf >= 1.3 else ''
            print(f"  {d:4}  {sig:6}  {len(sub):>4}  {w.mean()*100:>6.1f}  {pf:>6.3f}{star}")


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — CONFLUENCE SENSITIVITY
# ══════════════════════════════════════════════════════════════════════════════

def section_confluence(df_sig):
    print("\n" + "═" * 72)
    print("SECTION 5 — CONFLUENCE SENSITIVITY  (AOI-D + AOI-W only)")
    print("═" * 72)

    df  = _fix_dist(df_sig)
    aoi = df[df['signal'].isin(['AOI-D', 'AOI-W'])]
    if len(aoi) < 5:
        print("  Too few AOI signals."); return

    print(f"\n  {'Filter':<35}  {'N':>5}  {'WR%':>6}  {'PF':>6}")
    print(f"  {'─'*35}  {'─'*5}  {'─'*6}  {'─'*6}")

    def row(mask, lbl):
        s  = aoi[mask] if not isinstance(mask, slice) else aoi
        if len(s) < 3: return
        w  = s['win'].values.astype(bool)
        pf = compute_pf(w, s['tp1_dist'].values, s['sl_dist'].values)
        star = ' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else '')
        print(f"  {lbl:<35}  {len(s):>5}  {w.mean()*100:>6.1f}  {pf:>6.3f}{star}")

    row(slice(None),                                    "All AOI-D + AOI-W")
    row(aoi['conf_ema'] == 1,                           "EMA50 proximity fired")
    row(aoi['conf_rn']  == 1,                           "Round number fired")
    row(aoi['conf_wk']  == 1,                           "Weekly level fired")
    row((aoi['conf_ema']+aoi['conf_rn']+aoi['conf_wk']) >= 2, "2+ confluences")
    row((aoi['conf_ema']==1)&(aoi['conf_rn']==0)&(aoi['conf_wk']==0), "EMA only (pure)")
    row((aoi['conf_rn'] ==1)&(aoi['conf_ema']==0)&(aoi['conf_wk']==0), "Round# only (pure)")


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — BIAS FILTER  (reqBias ON vs OFF, per TF)
# ══════════════════════════════════════════════════════════════════════════════

def section_bias(df_base, tf_results):
    print("\n" + "═" * 72)
    print("SECTION 6 — BIAS FILTER  (D+H4 EMA20 aligned — reqBias ON vs OFF)")
    print("═" * 72)
    print(f"\n  Using H1 signals for this comparison:")

    # Collect with reqBias=ON at H1
    df_on  = _fix_dist(collect_signals(df_base, tf_minutes=60, req_bias=True))
    df_off = _fix_dist(collect_signals(df_base, tf_minutes=60, req_bias=False))

    print(f"\n  {'Config':<35}  {'N':>5}  {'/yr':>5}  {'WR%':>6}  {'PF':>6}")
    print(f"  {'─'*35}  {'─'*5}  {'─'*5}  {'─'*6}  {'─'*6}")
    _summary_row(df_off, "reqBias=OFF  (all H1 signals)", pad=35)
    _summary_row(df_on,  "reqBias=ON   (D+H4 aligned)",   pad=35)

    # Inline split of the no-bias set
    if not df_off.empty:
        print(f"\n  Inline bias cohort split (from reqBias=OFF H1 signals):")
        for lbl, cond in [
            ("D bull + H4 bull",    (df_off['d_bias']==1)  & (df_off['h4_bias']==1)),
            ("D bear + H4 bear",    (df_off['d_bias']==-1) & (df_off['h4_bias']==-1)),
            ("D vs H4 conflicting", (df_off['d_bias'] * df_off['h4_bias'] < 0)),
            ("Neither bias",        (df_off['d_bias']==0) | (df_off['h4_bias']==0)),
        ]:
            sub = df_off[cond]
            if len(sub) < 3: continue
            w  = sub['win'].values.astype(bool)
            pf = compute_pf(w, sub['tp1_dist'].values, sub['sl_dist'].values)
            star = ' ★' if pf >= 1.3 else ''
            print(f"    {lbl:<32}  N={len(sub):4d}  WR={w.mean()*100:.1f}%  PF={pf:.3f}{star}")

    # reqBias ON across all TFs
    print(f"\n  reqBias=ON across all TFs:")
    print(f"  {'TF':5}  {'N':>5}  {'WR%':>6}  {'PF':>6}")
    for tf in [tf for tf in [15, 30, 60, 120, 240] if tf >= BASE_TF_MIN]:
        df_s = _fix_dist(collect_signals(df_base, tf_minutes=tf, req_bias=True))
        if df_s.empty: continue
        w  = df_s['win'].values.astype(bool)
        pf = compute_pf(w, df_s['tp1_dist'].values, df_s['sl_dist'].values)
        star = ' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else '')
        print(f"  {_tf_name(tf):5}  {len(df_s):>5}  {w.mean()*100:>6.1f}  {pf:>6.3f}{star}")


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — MULTI-TP SCALED EXITS  (TP1 partial + TP2 runner, BE after TP1)
# ══════════════════════════════════════════════════════════════════════════════

def section_multi_tp(df_sig, label="H1 baseline"):
    print("\n" + "═" * 72)
    print(f"SECTION 7 — MULTI-TP SCALED EXITS  [{label}]")
    print("═" * 72)
    print(f"  BE stop after TP1 hit  (remaining position exits at entry = 0 gain).")

    df = _fix_dist(df_sig)
    if df.empty:
        print("  No data."); return

    configs = [
        ((1.0, 2.0), (0.50, 0.50)),
        ((1.5, 3.0), (0.50, 0.50)),
        ((1.0, 3.0), (0.33, 0.67)),
        ((1.5, 2.5), (0.40, 0.60)),
        ((2.0, 4.0), (0.50, 0.50)),
        ((1.0, 2.0), (0.70, 0.30)),
    ]

    print(f"\n  {'Config':<38}  {'N':>5}  {'WR%':>6}  {'PF':>6}")
    print(f"  {'─'*38}  {'─'*5}  {'─'*6}  {'─'*6}")

    for (t1m, t2m), (w1, w2) in configs:
        res = []
        for _, r in df.iterrows():
            mfe  = r['mfe']
            sl_d = r['sl_dist']
            t1d  = r['dist_R'] * t1m
            t2d  = r['dist_R'] * t2m
            t1h  = mfe >= t1d
            if mfe >= t2d:
                net = w1 * t1d + w2 * t2d
            elif t1h:
                net = w1 * t1d
            else:
                net = -(w1 + w2) * sl_d
            res.append({'net': net, 'win': int(net > 0)})
        df_r = pd.DataFrame(res)
        n    = len(df_r)
        wr   = df_r['win'].mean()
        gw   = df_r[df_r['net'] > 0]['net'].sum()
        gl   = df_r[df_r['net'] < 0]['net'].abs().sum()
        pf   = gw / gl if gl > 0 else float('inf')
        star = ' ★★★' if pf >= 1.8 and wr >= 0.55 else (' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else ''))
        cfg  = f"TP1={t1m:.1f}×({int(w1*100)}%) + TP2={t2m:.1f}×({int(w2*100)}%) BE"
        print(f"  {cfg:<38}  {n:>5}  {wr*100:>6.1f}  {pf:>6.3f}{star}")


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("=" * 72)
    print("GBPUSD SPECIALIST MINER  v2  (multi-timeframe)")
    print("Signals: A) SFP  B) AOI-D  C) AOI-W")
    print("TF sweep: M15 → M30 → H1 → H4  (signals on each, labels on base bars)")
    print("=" * 72)

    df = load_and_enrich()
    if df is None:
        raise SystemExit(1)

    # ── 1. Collect H1 baseline ─────────────────────────────────────────────
    print(f"\n[1/7] Collecting H1 baseline signals (TP={TP_MULT_DEF}R, SL={SL_BUF_DEF}×ATR) ...")
    df_h1 = _fix_dist(collect_signals(df, tf_minutes=60))

    if df_h1.empty:
        print("\n  *** No H1 signals found. ***")
        print(f"  Likely cause: TZ_OFFSET_HRS={TZ_OFFSET_HRS} doesn't match your data.")
        print(f"  Try TZ_OFFSET_HRS=0 (TradingView export) or 2 (winter broker).")
        raise SystemExit(1)

    print(f"  Found {len(df_h1)} signals  (~{len(df_h1)/YEARS_TOTAL:.0f}/yr)")
    df_h1.to_csv('gbpusd_signals_h1.csv', index=False)
    print(f"  Saved → gbpusd_signals_h1.csv")

    section_baseline(df_h1)

    # ── 2. TF sweep ────────────────────────────────────────────────────────
    print(f"\n[2/7] Timeframe sweep ...")
    tf_results = section_tf_sweep(df, tp_mult=TP_MULT_DEF, sl_buf=SL_BUF_DEF)

    # Save each TF signal set to CSV
    for tf, df_s in tf_results.items():
        if not df_s.empty:
            fname = f"gbpusd_signals_{_tf_name(tf).lower()}.csv"
            _fix_dist(df_s).to_csv(fname, index=False)
            print(f"  Saved {len(df_s)} signals → {fname}")

    # Determine best TF for deeper analysis
    best_pf_tf = 60  # fallback
    best_pf_val = 0.0
    for tf, df_s in tf_results.items():
        if df_s.empty: continue
        ds = _fix_dist(df_s)
        w  = ds['win'].values.astype(bool)
        pf = compute_pf(w, ds['tp1_dist'].values, ds['sl_dist'].values)
        if pf > best_pf_val:
            best_pf_val = pf; best_pf_tf = tf

    print(f"\n  → Best TF by PF: {_tf_name(best_pf_tf)} (PF={best_pf_val:.3f})")
    df_best = _fix_dist(tf_results.get(best_pf_tf, df_h1))

    # ── 3. TP sweep ────────────────────────────────────────────────────────
    print(f"\n[3/7] TP multiplier sweep ...")
    section_tp_sweep(df_h1, label=f"H1 (all signals)")
    if best_pf_tf != 60:
        section_tp_sweep(df_best, label=f"{_tf_name(best_pf_tf)} (best TF)")

    # Per-signal TP sweep on H1
    for sig in ['SFP', 'AOI-D', 'AOI-W']:
        sub = df_h1[df_h1['signal'] == sig]
        if len(sub) >= 10:
            section_tp_sweep(sub, label=f"H1 {sig} only")

    # ── 4. DOW breakdown ───────────────────────────────────────────────────
    print(f"\n[4/7] Day-of-week breakdown ...")
    section_dow(df_h1)

    # ── 5. Confluence sensitivity ──────────────────────────────────────────
    print(f"\n[5/7] Confluence sensitivity ...")
    section_confluence(df_h1)

    # ── 6. Bias filter ─────────────────────────────────────────────────────
    print(f"\n[6/7] Bias filter impact ...")
    section_bias(df, tf_results)

    # ── 7. Multi-TP exits ──────────────────────────────────────────────────
    print(f"\n[7/7] Multi-TP scaled exits ...")
    section_multi_tp(df_h1, label="H1 baseline")
    if best_pf_tf != 60:
        section_multi_tp(df_best, label=f"{_tf_name(best_pf_tf)} best TF")

    # ── Final summary ──────────────────────────────────────────────────────
    print("\n" + "═" * 72)
    print("DONE")
    print("═" * 72)
    w  = df_h1['win'].values.astype(bool)
    pf = compute_pf(w, df_h1['tp1_dist'].values, df_h1['sl_dist'].values)
    print(f"\n  H1 baseline : WR={w.mean()*100:.1f}%  PF={pf:.3f}  ~{len(df_h1)/YEARS_TOTAL:.0f}/yr")
    if best_pf_tf != 60:
        w2 = df_best['win'].values.astype(bool)
        pf2 = compute_pf(w2, df_best['tp1_dist'].values, df_best['sl_dist'].values)
        print(f"  {_tf_name(best_pf_tf):4} best TF: WR={w2.mean()*100:.1f}%  PF={pf2:.3f}  ~{len(df_best)/YEARS_TOTAL:.0f}/yr")
    print(f"\n  Tune Pine: set TP mult to Section 3 optimal.  Use best TF from Section 2.")
    print(f"  If reqBias=ON lifts PF ≥ 0.1 → enable it in the live indicator settings.")
    print(f"\n  CSV outputs per TF saved to gbpusd_signals_*.csv")
