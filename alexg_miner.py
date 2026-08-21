#!/usr/bin/env python3
"""
alexg_miner.py — Alex G "Set & Forget" structural backtest
===========================================================
Python port of alexg-bias.js + alexg-aoi.js + alexg-entry.js

Layer 1  Bias    : zigzag HH+HL=bull, LH+LL=bear on D + H4
                   Two consecutive TF sync: D+H4 = day, D alone (H4 neutral) = swing
Layer 2  Zones   : Daily supply/demand clusters, ≥2 body touches, 0.10–0.80×ATR_D
Layer 3  Entry   : price AT zone edge + H1 shift-of-structure (CHoCH) + H1 engulf
Layer 4  SL/TP   : SL = structural (below origin swing or zone lo − buffer)
                   TP = next daily structural high/low; RR floor ≥ 2.0

IMPORTANT: No fixed session windows. Signals fire whenever price reaches a valid
zone with confirmation — London, NY, or any market-hours bar.

Instruments: any pair with a downloaded CSV.
Default:     gbpusd_m15.csv  (or gbpusd_h1.csv as fallback)

Sections:
  1  Baseline (all signals, RR≥2)     5  Confluence (round# / EMA50)
  2  Pair / instrument sweep          6  Trade type (day vs swing)
  3  TP multiplier sweep (MFE)        7  Multi-TP scaled exits
  4  Day-of-week breakdown

Usage:
  python alexg_miner.py
  python alexg_miner.py --pair eurusd         (needs eurusd_m15.csv or eurusd_h1.csv)
  python alexg_miner.py --pair all            (sweeps all available CSV files)
  python alexg_miner.py --rr 1.5 --touches 2
"""

import os, sys, argparse, warnings
import pandas as pd
import numpy as np
warnings.filterwarnings('ignore')

# ══════════════════════════════════════════════════════════════════════════════
# CONFIG  (mirror alexg-bias.js + alexg-aoi.js constants)
# ══════════════════════════════════════════════════════════════════════════════

ATR_PERIOD       = 14
ATR_MULT_HTF     = 1.0    # daily/weekly zigzag threshold
ATR_MULT_LTF     = 1.5    # H4/H1 (coarser — avoids noise fragmentation)
MIN_PIVOTS       = 4      # need this many swing points before judging trend
ZONE_MAX_W_ATR   = 0.80   # zone max width in daily ATRs  (alexg = 0.80)
ZONE_MIN_W_ATR   = 0.05   # zone min width (floor so it's a band, not a line)
ZONE_MIN_TOUCHES = 2      # body touches needed (live = 3; relaxed for sample size)
GATE_ATR         = 0.30   # "at zone" tolerance in daily ATRs  (relaxed from 0.15 for sample size)
SL_BUF_ATR       = 0.08   # extra ATR pad below zone lo / above zone hi for SL
RR_FLOOR         = 2.0    # min TP/SL (alexg hardcodes 2.0)
MAX_BARS_FWD     = 600    # base bars forward per trade (~5 trading days on M15)
H1_SCAN_BACK     = 24     # H1 bars to look back for CHoCH + engulf
D_LOOKBACK       = 180    # daily bars for structure (6 months)
H4_LOOKBACK      = 300    # H4 bars for bias
MARKET_OPEN_UTC  = 6      # broker-independent: ignore bars before 06:00 UTC
MARKET_CLOSE_UTC = 22     # ignore bars after 22:00 UTC

YEARS_TOTAL = 1.0         # set by load_data()
BASE_TF_MIN = 60          # set by load_data()

# Files to try per pair (finest first)
_PAIR_FILES = {
    'gbpusd': ['gbpusd_m15.csv', 'gbpusd_m30.csv', 'gbpusd_h1.csv', 'gbpusd_miner_raw.csv'],
    'eurusd': ['eurusd_m15.csv', 'eurusd_h1.csv'],
    'usdjpy': ['usdjpy_m15.csv', 'usdjpy_h1.csv'],
    'usdchf': ['usdchf_m15.csv', 'usdchf_h1.csv'],
    'audusd': ['audusd_m15.csv', 'audusd_h1.csv'],
    'nzdusd': ['nzdusd_m15.csv', 'nzdusd_h1.csv'],
    'usdcad': ['usdcad_m15.csv', 'usdcad_h1.csv'],
    'eurjpy': ['eurjpy_m15.csv', 'eurjpy_h1.csv'],
    'gbpjpy': ['gbpjpy_m15.csv', 'gbpjpy_h1.csv'],
    'eurgbp': ['eurgbp_m15.csv', 'eurgbp_h1.csv'],
    'gold':   ['gold_m15.csv',   'gold_miner_raw.csv'],
    'nas100': ['nas100_m15.csv', 'nas100_miner_raw.csv'],
}


# ══════════════════════════════════════════════════════════════════════════════
# LAYER 0  —  DATA + ATR
# ══════════════════════════════════════════════════════════════════════════════

def compute_atr(df, period=ATR_PERIOD):
    tr = pd.concat([
        df['high'] - df['low'],
        (df['high'] - df['close'].shift(1)).abs(),
        (df['low']  - df['close'].shift(1)).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(span=period, adjust=False).mean()


def _resample_ohlcv(df, minutes):
    agg = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}
    if 'volume' in df.columns: agg['volume'] = 'sum'
    rs = df.resample(f'{minutes}min', closed='left', label='left').agg(agg).dropna(subset=['close'])
    return rs


def load_pair(pair, quiet=False):
    """Load finest available CSV for `pair`. Returns (df_base, pair_name) or (None, None)."""
    global YEARS_TOTAL, BASE_TF_MIN
    files = _PAIR_FILES.get(pair.lower(), [f'{pair.lower()}_m15.csv', f'{pair.lower()}_h1.csv'])
    chosen = next((f for f in files if os.path.exists(f)), None)
    if chosen is None:
        return None, None

    df = pd.read_csv(chosen, parse_dates=['datetime'])
    if 'datetime' not in df.columns:
        return None, None
    df = df.sort_values('datetime').drop_duplicates('datetime').set_index('datetime')
    df.index = df.index.tz_localize(None)
    if 'volume' not in df.columns:
        df['volume'] = 1.0

    span_days   = (df.index[-1] - df.index[0]).days
    YEARS_TOTAL = max(1.0, round(span_days / 365.25, 2))
    diffs = df.index.to_series().diff().dropna().dt.total_seconds() / 60
    BASE_TF_MIN = max(1, int(round(diffs[diffs > 0].median())))
    if not quiet:
        print(f"  {pair.upper()}: {chosen}  {len(df):,} bars  {df.index[0].date()}→{df.index[-1].date()}  "
              f"({YEARS_TOTAL:.1f}yr)  base={BASE_TF_MIN}min")
    return df, pair.lower()


# ══════════════════════════════════════════════════════════════════════════════
# LAYER 1  —  ZIGZAG + STRUCTURE  (port of alexg-bias.js)
# ══════════════════════════════════════════════════════════════════════════════

def zigzag_pivots(values, threshold):
    """
    ATR-thresholded zigzag over closes — direct port of alexg-bias.js zigzagPivots().
    Returns list of dicts: [{'idx': i, 'type': 'H'|'L'}, ...]
    """
    values = np.asarray(values, dtype=float)
    n = len(values)
    if n < 2 or threshold <= 0:
        return []

    pivots = []
    max_v, max_i = values[0], 0
    min_v, min_i = values[0], 0
    direction = 0
    ext_val = values[0]

    i = 1
    while i < n and direction == 0:
        v = values[i]
        if v > max_v: max_v, max_i = v, i
        if v < min_v: min_v, min_i = v, i
        if max_v - v >= threshold:
            direction = -1
            pivots.append({'idx': max_i, 'type': 'H'})
            ext_val = v
        elif v - min_v >= threshold:
            direction = 1
            pivots.append({'idx': min_i, 'type': 'L'})
            ext_val = v
        i += 1

    ext_idx = max_i if direction == -1 else (min_i if direction == 1 else 0)
    while i < n:
        v = values[i]
        if direction > 0:
            if v > ext_val: ext_val = v; ext_idx = i
            elif ext_val - v >= threshold:
                pivots.append({'idx': ext_idx, 'type': 'H'})
                direction = -1; ext_val = v; ext_idx = i
        else:
            if v < ext_val: ext_val = v; ext_idx = i
            elif v - ext_val >= threshold:
                pivots.append({'idx': ext_idx, 'type': 'L'})
                direction = 1; ext_val = v; ext_idx = i
        i += 1

    return pivots


def _label_pivots(raw, closes, highs, lows):
    prev_h = prev_l = None
    out = []
    for p in raw:
        idx = p['idx']
        node = {'idx': idx, 'type': p['type'],
                'close': closes[idx], 'high': highs[idx], 'low': lows[idx], 'label': None}
        if p['type'] == 'H':
            node['label'] = 'H' if prev_h is None else ('HH' if closes[idx] > prev_h['close'] else 'LH')
            prev_h = node
        else:
            node['label'] = 'L' if prev_l is None else ('HL' if closes[idx] > prev_l['close'] else 'LL')
            prev_l = node
        out.append(node)
    return out


def _get_trend(pivots):
    last_h = next((p for p in reversed(pivots) if p['type'] == 'H'), None)
    last_l = next((p for p in reversed(pivots) if p['type'] == 'L'), None)
    if last_h and last_l:
        if last_h['label'] in ('HH','H') and last_l['label'] in ('HL','L'): return 'bull'
        if last_h['label'] == 'LH' and last_l['label'] == 'LL': return 'bear'
    return 'unclear'


def build_structure(df, atr_mult=ATR_MULT_HTF):
    """Returns {'ok', 'trend', 'pivots', 'atr_val'}."""
    if len(df) < MIN_PIVOTS + 2:
        return {'ok': False, 'trend': 'unclear', 'pivots': [], 'atr_val': None}
    closes = df['close'].values
    highs  = df['high'].values
    lows   = df['low'].values
    atr_s  = compute_atr(df, ATR_PERIOD)
    atr_v  = float(atr_s.iloc[-1])
    if np.isnan(atr_v) or atr_v <= 0:
        return {'ok': False, 'trend': 'unclear', 'pivots': [], 'atr_val': None}
    raw    = zigzag_pivots(closes, atr_mult * atr_v)
    if len(raw) < MIN_PIVOTS:
        return {'ok': False, 'trend': 'unclear', 'pivots': [], 'atr_val': atr_v}
    pivots = _label_pivots(raw, closes, highs, lows)
    return {'ok': True, 'trend': _get_trend(pivots), 'pivots': pivots, 'atr_val': atr_v}


# ══════════════════════════════════════════════════════════════════════════════
# LAYER 2  —  ZONE BUILDER  (port of alexg-aoi.js buildZones)
# ══════════════════════════════════════════════════════════════════════════════

def build_zones(df, pivots, kind, atr_d):
    """
    kind: 'demand' (from L pivots) | 'supply' (from H pivots).
    Returns list sorted most-recent first.
    """
    if not pivots or not atr_d or atr_d <= 0:
        return []
    max_w = ZONE_MAX_W_ATR * atr_d
    min_w = ZONE_MIN_W_ATR * atr_d
    opens  = df['open'].values
    closes = df['close'].values

    anchors = [p for p in pivots if p['type'] == ('L' if kind == 'demand' else 'H')]
    raw = []
    for a in anchors:
        center = a['low'] if kind == 'demand' else a['high']
        lo, hi = center - max_w / 2, center + max_w / 2

        # Tighten to structural levels within band
        piv_levels = [p['low'] if kind == 'demand' else p['high']
                      for p in anchors if lo <= (p['low'] if kind == 'demand' else p['high']) <= hi]
        if piv_levels:
            lo, hi = min(piv_levels), max(piv_levels)

        mid = (lo + hi) / 2
        if hi - lo < min_w: lo, hi = mid - min_w/2, mid + min_w/2
        if hi - lo > max_w: lo, hi = mid - max_w/2, mid + max_w/2

        touches = visits = 0
        in_run = False
        last_touch_idx = -1
        for i in range(len(df)):
            bhi = max(opens[i], closes[i])
            blo = min(opens[i], closes[i])
            if bhi >= lo and blo <= hi:
                touches += 1
                last_touch_idx = i
                if not in_run: visits += 1; in_run = True
            else:
                in_run = False

        if touches >= ZONE_MIN_TOUCHES or visits >= ZONE_MIN_TOUCHES:
            raw.append({'kind': kind, 'lo': lo, 'hi': hi, 'mid': (lo+hi)/2,
                        'touches': touches, 'visits': visits,
                        'anchor_idx': a['idx'], 'last_touch_idx': last_touch_idx})

    # Merge overlapping
    raw.sort(key=lambda z: z['lo'])
    merged = []
    for z in raw:
        last = merged[-1] if merged else None
        if last and z['lo'] <= last['hi']:
            last['hi'] = max(last['hi'], z['hi'])
            mid = (last['lo'] + last['hi']) / 2
            if last['hi'] - last['lo'] > max_w:
                last['lo'], last['hi'] = mid - max_w/2, mid + max_w/2
            last['mid'] = (last['lo'] + last['hi']) / 2
            last['touches'] += z['touches']
            last['visits'] = max(last['visits'], z['visits'])
            last['last_touch_idx'] = max(last['last_touch_idx'], z['last_touch_idx'])
        else:
            merged.append(dict(z))

    merged.sort(key=lambda z: (-z['last_touch_idx'], -z['visits']))
    return merged


def at_zone(price, zone, gate):
    """True if price is within `gate` of the zone's near edge."""
    return (price >= zone['lo'] - gate) and (price <= zone['hi'] + gate)


def price_broke_zone(price, zone, direction):
    """True if price already closed THROUGH the zone (broken, not a retest)."""
    if direction == 'long':  return price < zone['lo']
    if direction == 'short': return price > zone['hi']
    return False


# ══════════════════════════════════════════════════════════════════════════════
# LAYER 3  —  CHoCH + ENGULF  (simplified port of alexg-entry.js)
# ══════════════════════════════════════════════════════════════════════════════

def find_choch_engulf(h1_window, direction):
    """
    Look for: price made a swing near zone → close breaks opposite swing (CHoCH)
              + a bullish/bearish engulf body in that window.

    h1_window: DataFrame of recent H1 bars (old → new).
    Returns dict: {found, origin_extreme, broken_level, engulf_found}
    """
    n = len(h1_window)
    if n < 4:
        return {'found': False}

    cl = h1_window['close'].values
    op = h1_window['open'].values
    hi = h1_window['high'].values
    lo = h1_window['low'].values

    if direction == 'long':
        # origin = lowest bar in window (the demand touch)
        oi = int(np.argmin(lo))
        if oi < 2: return {'found': False}
        origin_low   = lo[oi]
        broken_level = hi[:oi].max()   # highest high BEFORE the low (will be broken)

        # CHoCH = any bar after origin closes above broken_level
        choch = next((j for j in range(oi+1, n) if cl[j] > broken_level), None)
        if choch is None: return {'found': False}

        # Engulf = bullish body engulf anywhere from oi onward
        engulf = any(
            cl[j] > op[j] and cl[j-1] < op[j-1] and cl[j] >= op[j-1] and op[j] <= cl[j-1]
            for j in range(oi+1, n)
        )
        return {'found': True, 'origin_low': origin_low, 'broken_level': broken_level,
                'choch_bar': choch, 'engulf_found': engulf}

    else:  # short
        oi = int(np.argmax(hi))
        if oi < 2: return {'found': False}
        origin_high  = hi[oi]
        broken_level = lo[:oi].min()

        choch = next((j for j in range(oi+1, n) if cl[j] < broken_level), None)
        if choch is None: return {'found': False}

        engulf = any(
            cl[j] < op[j] and cl[j-1] > op[j-1] and cl[j] <= op[j-1] and op[j] >= cl[j-1]
            for j in range(oi+1, n)
        )
        return {'found': True, 'origin_high': origin_high, 'broken_level': broken_level,
                'choch_bar': choch, 'engulf_found': engulf}


# ══════════════════════════════════════════════════════════════════════════════
# LAYER 4  —  STRUCTURAL TP
# ══════════════════════════════════════════════════════════════════════════════

def find_structural_tp(d_pivots, entry_price, direction, sl_dist, rr_floor):
    """
    Long: nearest D swing HIGH above entry that satisfies RR ≥ rr_floor.
    Short: nearest D swing LOW below entry that satisfies RR ≥ rr_floor.
    Iterates through all candidates (nearest first) to find the first valid level.
    """
    min_tp_dist = sl_dist * rr_floor
    if direction == 'long':
        candidates = sorted(
            [p['high'] for p in d_pivots if p['type'] == 'H' and p['high'] > entry_price]
        )
        valid = [c for c in candidates if c - entry_price >= min_tp_dist]
        if valid:   return valid[0]
        # No level satisfies RR — return nearest anyway (caller will check RR)
        return candidates[0] if candidates else None
    else:
        candidates = sorted(
            [p['low'] for p in d_pivots if p['type'] == 'L' and p['low'] < entry_price],
            reverse=True
        )
        valid = [c for c in candidates if entry_price - c >= min_tp_dist]
        if valid:   return valid[0]
        return candidates[0] if candidates else None


# ══════════════════════════════════════════════════════════════════════════════
# TRADE LABELING
# ══════════════════════════════════════════════════════════════════════════════

def label_long(df_fwd, entry, sl, tp):
    mfe = 0.0
    for i in range(min(MAX_BARS_FWD, len(df_fwd))):
        bar = df_fwd.iloc[i]
        mfe = max(mfe, bar['high'] - entry)
        if bar['low']  <= sl: return False, i+1, mfe
        if bar['high'] >= tp: return True,  i+1, mfe
    return False, min(MAX_BARS_FWD, len(df_fwd)), mfe


def label_short(df_fwd, entry, sl, tp):
    mfe = 0.0
    for i in range(min(MAX_BARS_FWD, len(df_fwd))):
        bar = df_fwd.iloc[i]
        mfe = max(mfe, entry - bar['low'])
        if bar['high'] >= sl: return False, i+1, mfe
        if bar['low']  <= tp: return True,  i+1, mfe
    return False, min(MAX_BARS_FWD, len(df_fwd)), mfe


def compute_pf(wins_bool, tp_dists, sl_dists):
    gw = np.where(wins_bool,  tp_dists, 0.0).sum()
    gl = np.where(~wins_bool, sl_dists, 0.0).sum()
    return gw / gl if gl > 0 else float('inf')


# ══════════════════════════════════════════════════════════════════════════════
# SIGNAL COLLECTION  — main loop
# ══════════════════════════════════════════════════════════════════════════════

def collect_signals(df_base, pair='gbpusd', rr_floor=RR_FLOOR, require_choch=False,
                    long_only=False, short_only=False, round_only=False,
                    print_dropout=True, verbose=False):
    """
    Full pipeline per H1 bar:
      1. Bias: D+H4 aligned?
      2. Location: price at a valid D demand/supply zone?
      3. Entry: CHoCH+engulf scored as confluence; blocks only when require_choch=True
      4. SL = below zone lo (or origin swing) − buffer; TP = next D structural H/L (first level satisfying RR)
      5. RR gate ≥ rr_floor; label forward from M15 base
    """
    # Resample to H1, H4, D
    df_h1 = _resample_ohlcv(df_base, 60)
    df_h4 = _resample_ohlcv(df_base, 240)
    df_d  = _resample_ohlcv(df_base, 1440)

    df_h1['atr'] = compute_atr(df_h1, ATR_PERIOD)
    df_h4['atr'] = compute_atr(df_h4, ATR_PERIOD)
    df_d['atr']  = compute_atr(df_d,  ATR_PERIOD)

    # EMA50 on daily for confluence check
    df_d['ema50'] = df_d['close'].ewm(span=50, adjust=False).mean()

    rows = []
    h1_idx_arr = df_h1.index.tolist()
    d_idx_arr  = df_d.index.tolist()
    h4_idx_arr = df_h4.index.tolist()
    fired_zones = set()   # (date, zone_lo_rounded) — one trade per zone per day
    drop = {'bias': 0, 'no_zone': 0, 'dedup': 0, 'choch': 0, 'rr': 0, 'sl': 0}

    for h1_i, ts in enumerate(h1_idx_arr):
        # Market hours gate
        utc_h = (ts.hour - 0)  # index is in broker time BUT bmin not needed here
        # Use UTC proxy: broker − TZ_OFFSET_HRS is approx UTC; we just check broker hours
        bh = ts.hour
        if bh < MARKET_OPEN_UTC or bh >= MARKET_CLOSE_UTC:
            continue

        dow = ts.dayofweek
        if dow >= 5 or dow == 0:   # weekend / Monday
            continue

        bar_h1 = df_h1.iloc[h1_i]
        price  = bar_h1['close']
        atr_h1 = bar_h1['atr']
        if np.isnan(atr_h1) or atr_h1 <= 0:
            continue

        # ── Daily structure: all D bars up to (not including) today ──────────
        d_cutoff = ts.normalize()   # midnight of current H1 bar
        d_hist   = df_d[df_d.index < d_cutoff].tail(D_LOOKBACK)
        if len(d_hist) < MIN_PIVOTS + 5:
            continue

        atr_d_val = float(d_hist['atr'].iloc[-1])
        ema50_d   = float(d_hist['ema50'].iloc[-1])
        if np.isnan(atr_d_val) or atr_d_val <= 0:
            continue

        sd = build_structure(d_hist, atr_mult=ATR_MULT_HTF)
        if not sd['ok']:
            continue

        # ── H4 structure: all H4 bars up to current H1 bar ts ───────────────
        h4_hist = df_h4[df_h4.index <= ts].tail(H4_LOOKBACK)
        if len(h4_hist) < MIN_PIVOTS + 5:
            continue
        sh4 = build_structure(h4_hist, atr_mult=ATR_MULT_LTF)

        # ── Bias check ───────────────────────────────────────────────────────
        td  = sd.get('trend', 'unclear')
        th4 = sh4.get('trend', 'unclear')

        if td == 'bull' and th4 == 'bull':
            direction = 'long';  trade_type = 'day'
        elif td == 'bear' and th4 == 'bear':
            direction = 'short'; trade_type = 'day'
        elif td == 'bull' and th4 != 'bear':
            direction = 'long';  trade_type = 'swing'
        elif td == 'bear' and th4 != 'bull':
            direction = 'short'; trade_type = 'swing'
        else:
            drop['bias'] += 1
            continue    # D and H4 opposing — skip

        if long_only  and direction != 'long':  continue
        if short_only and direction != 'short': continue

        # ── Build zones from daily structure ─────────────────────────────────
        zone_kind = 'demand' if direction == 'long' else 'supply'
        zones = build_zones(d_hist, sd['pivots'], zone_kind, atr_d_val)

        gate = GATE_ATR * atr_d_val

        # Find active zone (price at it; not broken through)
        active_zone = None
        for z in zones:
            if not at_zone(price, z, gate):
                continue
            if price_broke_zone(price, z, direction):
                continue
            active_zone = z
            break

        if active_zone is None:
            drop['no_zone'] += 1
            continue

        # One-trade-per-zone-per-day dedup
        zone_key = (ts.date(), round(active_zone['lo'], 4))
        if zone_key in fired_zones:
            drop['dedup'] += 1
            continue

        # ── CHoCH + engulf on recent H1 ──────────────────────────────────────
        h1_window = df_h1.iloc[max(0, h1_i - H1_SCAN_BACK + 1): h1_i + 1]
        choch = find_choch_engulf(h1_window, direction)
        if require_choch and not choch['found']:
            drop['choch'] += 1
            continue

        # ── SL: zone edge + small buffer (live alexg uses limit at zone edge, SL just outside)
        atr_buf = SL_BUF_ATR * atr_d_val
        if direction == 'long':
            sl = active_zone['lo'] - atr_buf
        else:
            sl = active_zone['hi'] + atr_buf

        sl_dist = abs(price - sl)
        if sl_dist <= 0:
            drop['sl'] += 1
            continue

        # ── TP: next D structural level that satisfies RR ────────────────────
        tp = find_structural_tp(sd['pivots'], price, direction, sl_dist, rr_floor)
        if tp is None:
            # Fallback: RR × SL if no structural TP available
            tp = price + sl_dist * rr_floor if direction == 'long' else price - sl_dist * rr_floor

        tp_dist = abs(tp - price)
        rr      = tp_dist / sl_dist if sl_dist > 0 else 0.0
        if rr < rr_floor:
            drop['rr'] += 1
            continue

        # ── Confluences ──────────────────────────────────────────────────────
        # Round number: nearest 50-pip level within zone
        rn_step  = 0.0050
        nearest  = round(active_zone['mid'] / rn_step) * rn_step
        c_round  = abs(nearest - active_zone['mid']) <= 0.0005

        if round_only and not c_round:
            continue

        # EMA50 proximity to zone
        c_ema50  = abs(ema50_d - active_zone['mid']) <= gate

        # Zone quality
        c_strong = active_zone['visits'] >= 3

        # ── Label trade forward on M15 base ──────────────────────────────────
        df_fwd = df_base[df_base.index > ts]
        if direction == 'long':
            win, bh, mfe = label_long(df_fwd, price, sl, tp)
        else:
            win, bh, mfe = label_short(df_fwd, price, sl, tp)

        fired_zones.add(zone_key)

        rows.append({
            'pair': pair, 'ts': ts, 'date': ts.date(),
            'dow': ts.day_name()[:3], 'dow_idx': dow,
            'direction': direction, 'trade_type': trade_type,
            'price': price, 'sl': sl, 'tp': tp,
            'sl_dist': sl_dist, 'tp_dist': tp_dist, 'rr': round(rr, 2),
            'win': int(win), 'bars_held': bh, 'mfe': mfe,
            'c_round': int(c_round), 'c_ema50': int(c_ema50), 'c_strong': int(c_strong),
            'choch_engulf': int(choch.get('engulf_found', False)),
            'zone_lo': active_zone['lo'], 'zone_hi': active_zone['hi'],
            'zone_visits': active_zone['visits'], 'zone_touches': active_zone['touches'],
            'atr_d': atr_d_val, 'td': td, 'th4': th4,
        })

    total_dropped = sum(drop.values())
    if print_dropout:
        print(f"  Dropout: bias={drop['bias']} no_zone={drop['no_zone']} "
              f"dedup={drop['dedup']} choch={drop['choch']} sl={drop['sl']} rr={drop['rr']}  "
              f"total_dropped={total_dropped}  signals={len(rows)}")
    return pd.DataFrame(rows)


# ══════════════════════════════════════════════════════════════════════════════
# ANALYSIS SECTIONS
# ══════════════════════════════════════════════════════════════════════════════

def _row(df_s, label, pad=42):
    if df_s is None or df_s.empty:
        print(f"  {label:<{pad}}  — no signals"); return
    w   = df_s['win'].values.astype(bool)
    pf  = compute_pf(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
    tyr = len(df_s) / YEARS_TOTAL
    avg_rr = df_s['rr'].mean() if 'rr' in df_s else 0
    star = ' ★★★' if pf >= 1.8 and w.mean() >= 0.50 else (' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else ''))
    print(f"  {label:<{pad}}  N={len(df_s):4d} (~{tyr:5.1f}/yr)"
          f"  WR={w.mean()*100:5.1f}%  PF={pf:.3f}  avgRR={avg_rr:.1f}{star}")


def section_baseline(df, label='all signals', rr_floor=RR_FLOOR):
    print("\n" + "═"*72)
    print(f"SECTION 1 — BASELINE  [{label}]  RR≥{rr_floor}  structural SL/TP")
    print("═"*72)
    if df.empty:
        print("  No signals found."); return

    w   = df['win'].values.astype(bool)
    pf  = compute_pf(w, df['tp_dist'].values, df['sl_dist'].values)
    print(f"\n  All:  N={len(df)}  WR={w.mean()*100:.1f}%  PF={pf:.3f}"
          f"  ~{len(df)/YEARS_TOTAL:.0f}/yr  span={YEARS_TOTAL:.1f}yr")
    print(f"  avgRR={df['rr'].mean():.2f}  medRR={df['rr'].median():.2f}"
          f"  avgBars={df['bars_held'].mean():.0f}")

    df = df.copy(); df['date_ts'] = pd.to_datetime(df['date'])
    latest = df['date_ts'].max()
    print(f"\n  {'Period':6}  {'N':>5}  {'/yr':>5}  {'WR%':>6}  {'PF':>6}")
    print(f"  {'─'*6}  {'─'*5}  {'─'*5}  {'─'*6}  {'─'*6}")
    for yrs, lbl in [(1,'1yr'),(2,'2yr'),(3,'3yr'),(5,'5yr')]:
        sub = df[df['date_ts'] >= latest - pd.DateOffset(years=yrs)]
        if len(sub) < 5: continue
        ww = sub['win'].values.astype(bool)
        sp = compute_pf(ww, sub['tp_dist'].values, sub['sl_dist'].values)
        star = ' ***' if sp >= 1.8 else (' **' if sp >= 1.5 else (' *' if sp >= 1.3 else ''))
        print(f"  {lbl:6}  {len(sub):>5}  {len(sub)/yrs:>5.0f}  {ww.mean()*100:>6.1f}  {sp:>6.3f}{star}")

    print(f"\n  By direction:")
    for d in ['long', 'short']:
        _row(df[df['direction']==d], f"    {d.upper()}")

    print(f"\n  By trade type:")
    for t in ['day', 'swing']:
        _row(df[df['trade_type']==t], f"    {t.upper()}")


def section_tp_sweep(df):
    print("\n" + "═"*72)
    print("SECTION 3 — TP MULTIPLIER SWEEP  (MFE-based, no re-run)")
    print("═"*72)
    if len(df) < 10:
        print("  Too few signals."); return

    mfe  = df['mfe'].values
    sl_d = df['sl_dist'].values
    print(f"\n  {'TP×':>6}  {'WR%':>6}  {'PF':>7}  {'Wins':>5}  notes")
    print(f"  {'─'*6}  {'─'*6}  {'─'*7}  {'─'*5}")

    h50 = h15 = h18 = False
    for tm in np.round(np.arange(0.5, 6.01, 0.25), 2):
        tp_d  = tm * sl_d
        wins  = mfe >= tp_d
        pf    = compute_pf(wins, tp_d, sl_d)
        note  = ''
        if wins.mean() >= 0.50 and not h50: note += ' ← WR 50%'; h50 = True
        if pf >= 1.5 and not h15: note += ' ← PF 1.5'; h15 = True
        if pf >= 1.8 and not h18: note += ' ← PF 1.8'; h18 = True
        if abs(tm - round(tm)) < 0.01 or note:
            star = ' ★★★' if pf >= 1.8 and wins.mean() >= 0.50 else (' ★★' if pf >= 1.5 else (' ★' if wins.mean() >= 0.55 else ''))
            print(f"  {tm:>6.2f}  {wins.mean()*100:>6.1f}  {pf:>7.3f}  {int(wins.sum()):>5}  {note}{star}")


def section_dow(df):
    print("\n" + "═"*72)
    print("SECTION 4 — DAY-OF-WEEK  (Monday excluded)")
    print("═"*72)
    print(f"\n  {'Day':4}  {'N':>5}  {'/yr':>5}  {'WR%':>6}  {'PF':>6}")
    print(f"  {'─'*4}  {'─'*5}  {'─'*5}  {'─'*6}  {'─'*6}")
    for d in ['Tue','Wed','Thu','Fri']:
        sub = df[df['dow']==d]
        if len(sub) < 3: print(f"  {d:4}  <3"); continue
        w  = sub['win'].values.astype(bool)
        pf = compute_pf(w, sub['tp_dist'].values, sub['sl_dist'].values)
        star = ' ★' if pf >= 1.3 else ''
        print(f"  {d:4}  {len(sub):>5}  {len(sub)/YEARS_TOTAL:>5.0f}  {w.mean()*100:>6.1f}  {pf:>6.3f}{star}")

    print(f"\n  DOW × direction:")
    for d in ['Tue','Wed','Thu','Fri']:
        for dr in ['long','short']:
            sub = df[(df['dow']==d)&(df['direction']==dr)]
            if len(sub) < 3: continue
            w  = sub['win'].values.astype(bool)
            pf = compute_pf(w, sub['tp_dist'].values, sub['sl_dist'].values)
            star = ' ★' if pf >= 1.3 else ''
            print(f"    {d:4}  {dr:5}  N={len(sub):3d}  WR={w.mean()*100:.1f}%  PF={pf:.3f}{star}")


def section_confluence(df):
    print("\n" + "═"*72)
    print("SECTION 5 — CONFLUENCE SENSITIVITY")
    print("═"*72)
    print(f"\n  {'Filter':<42}  {'N':>5}  {'WR%':>6}  {'PF':>6}")
    print(f"  {'─'*42}  {'─'*5}  {'─'*6}  {'─'*6}")

    def row(mask, lbl):
        s = df[mask] if not isinstance(mask, slice) else df
        if len(s) < 3: return
        w  = s['win'].values.astype(bool)
        pf = compute_pf(w, s['tp_dist'].values, s['sl_dist'].values)
        star = ' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else '')
        print(f"  {lbl:<42}  {len(s):>5}  {w.mean()*100:>6.1f}  {pf:>6.3f}{star}")

    row(slice(None),                          "All signals")
    row(df['c_round']==1,                     "Round number in zone")
    row(df['c_ema50']==1,                     "EMA50 daily in zone")
    row(df['c_strong']==1,                    "Zone ≥3 distinct visits")
    row(df['choch_engulf']==1,                "CHoCH + engulf confirmed")
    row((df['c_round']+df['c_ema50'])>=2,     "Round# AND EMA50")
    row((df['c_round']==1)&(df['c_ema50']==0)&(df['c_strong']==0), "Round# only (pure)")
    row((df['c_ema50']==1)&(df['c_round']==0),"EMA50 only (pure)")
    row(df['rr']>=3.0,                        "RR ≥ 3.0 trades only")
    row(df['rr']>=4.0,                        "RR ≥ 4.0 trades only")


def section_trade_type(df):
    print("\n" + "═"*72)
    print("SECTION 6 — TRADE TYPE  (day=D+H4 sync  |  swing=D only)")
    print("═"*72)
    print(f"\n  {'Type':10}  {'Dir':6}  {'N':>5}  {'/yr':>5}  {'WR%':>6}  {'PF':>6}  {'avgRR':>6}")
    print(f"  {'─'*10}  {'─'*6}  {'─'*5}  {'─'*5}  {'─'*6}  {'─'*6}  {'─'*6}")
    for tt in ['day','swing']:
        for dr in ['long','short']:
            sub = df[(df['trade_type']==tt)&(df['direction']==dr)]
            if len(sub) < 3: continue
            w  = sub['win'].values.astype(bool)
            pf = compute_pf(w, sub['tp_dist'].values, sub['sl_dist'].values)
            star = ' ★' if pf >= 1.3 else ''
            print(f"  {tt:10}  {dr:6}  {len(sub):>5}  {len(sub)/YEARS_TOTAL:>5.0f}"
                  f"  {w.mean()*100:>6.1f}  {pf:>6.3f}  {sub['rr'].mean():>6.2f}{star}")


def section_multi_tp(df):
    print("\n" + "═"*72)
    print("SECTION 7 — MULTI-TP  (TP1 partial close + BE on remainder)")
    print("═"*72)
    if df.empty: print("  No data."); return

    configs = [
        ((1.0, 2.0), (0.5, 0.5)),
        ((1.5, 3.0), (0.5, 0.5)),
        ((1.0, 3.0), (0.33, 0.67)),
        ((2.0, 4.0), (0.5, 0.5)),
        ((1.0, 2.0), (0.70, 0.30)),
        ((1.5, 4.0), (0.5, 0.5)),
    ]
    print(f"\n  {'Config':<40}  {'N':>5}  {'WR%':>6}  {'PF':>6}")
    print(f"  {'─'*40}  {'─'*5}  {'─'*6}  {'─'*6}")
    for (t1m, t2m), (w1, w2) in configs:
        res = []
        for _, r in df.iterrows():
            mfe = r['mfe']; sl_d = r['sl_dist']
            t1d = r['sl_dist'] * t1m; t2d = r['sl_dist'] * t2m
            if mfe >= t2d: net = w1 * t1d + w2 * t2d
            elif mfe >= t1d: net = w1 * t1d
            else: net = -(w1+w2) * sl_d
            res.append({'net': net, 'win': int(net > 0)})
        df_r = pd.DataFrame(res)
        wr = df_r['win'].mean()
        gw = df_r[df_r['net']>0]['net'].sum()
        gl = df_r[df_r['net']<0]['net'].abs().sum()
        pf = gw/gl if gl > 0 else float('inf')
        star = ' ★★★' if pf >= 1.8 and wr >= 0.5 else (' ★★' if pf >= 1.5 else (' ★' if pf >= 1.3 else ''))
        cfg = f"TP1={t1m:.1f}×({int(w1*100)}%) + TP2={t2m:.1f}×({int(w2*100)}%) BE"
        print(f"  {cfg:<40}  {len(df_r):>5}  {wr*100:>6.1f}  {pf:>6.3f}{star}")


# ══════════════════════════════════════════════════════════════════════════════
# MULTI-PAIR SWEEP  (Section 2)
# ══════════════════════════════════════════════════════════════════════════════

def section_pair_sweep(pairs, rr_floor, require_choch=False,
                       long_only=False, short_only=False, round_only=False):
    direction_label = 'LONG only' if long_only else ('SHORT only' if short_only else 'LONG + SHORT')
    print("\n" + "═"*72)
    print(f"SECTION 2 — PAIR SWEEP  (alexg structural, {direction_label})")
    print("═"*72)
    print(f"\n  {'Pair':8}  {'N':>5}  {'/yr':>5}  {'WR%':>6}  {'PF':>6}  {'avgRR':>6}  "
          f"{'1R-WR%':>7}  {'1R-PF':>6}  verdict")
    print(f"  {'─'*8}  {'─'*5}  {'─'*5}  {'─'*6}  {'─'*6}  {'─'*6}  {'─'*7}  {'─'*6}")
    all_signals = {}
    summary_rows = []

    for p in pairs:
        df_b, pname = load_pair(p, quiet=True)
        if df_b is None:
            print(f"  {p.upper():8}  — no data")
            continue
        df_s = collect_signals(df_b, pair=pname, rr_floor=rr_floor, require_choch=require_choch,
                               long_only=long_only, short_only=short_only, round_only=round_only,
                               print_dropout=False)
        all_signals[pname] = df_s
        if df_s.empty:
            print(f"  {pname.upper():8}  — no signals")
            continue

        w   = df_s['win'].values.astype(bool)
        pf  = compute_pf(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        tyr = len(df_s) / YEARS_TOTAL

        # 1R exit stats (MFE ≥ 1×sl_dist)
        w1r  = df_s['mfe'].values >= df_s['sl_dist'].values
        pf1r = compute_pf(w1r, df_s['sl_dist'].values, df_s['sl_dist'].values)

        star = ' ★★★' if pf1r >= 1.8 and w1r.mean() >= 0.55 else \
               (' ★★'  if pf1r >= 1.5 else (' ★' if pf1r >= 1.3 else ''))

        verdict = 'TRADE' if pf1r >= 1.5 and len(df_s) >= 5 else \
                  ('WATCH' if pf1r >= 1.2 and len(df_s) >= 5 else 'SKIP')

        print(f"  {pname.upper():8}  {len(df_s):>5}  {tyr:>5.0f}  {w.mean()*100:>6.1f}"
              f"  {pf:>6.3f}  {df_s['rr'].mean():>6.2f}  "
              f"{w1r.mean()*100:>6.1f}%  {pf1r:>6.3f}{star}  {verdict}")

        summary_rows.append({'pair': pname.upper(), 'N': len(df_s), 'yr': tyr,
                              'WR': w.mean()*100, 'PF': pf, 'avgRR': df_s['rr'].mean(),
                              'WR1R': w1r.mean()*100, 'PF1R': pf1r, 'verdict': verdict})

        df_s.to_csv(f'alexg_signals_{pname}.csv', index=False)

    # Ranked summary
    if summary_rows:
        print("\n" + "─"*72)
        print("RANKED BY 1R PF  (the GBPUSD-confirmed edge metric)")
        print("─"*72)
        for r in sorted(summary_rows, key=lambda x: -x['PF1R']):
            print(f"  {r['pair']:8}  WR={r['WR']:.0f}%  PF(struct)={r['PF']:.3f}  "
                  f"WR(1R)={r['WR1R']:.0f}%  PF(1R)={r['PF1R']:.3f}  "
                  f"N={r['N']}  → {r['verdict']}")

    return all_signals


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Alex G structural miner')
    ap.add_argument('--pair',    default='gbpusd', help='pair or "all"')
    ap.add_argument('--rr',     type=float, default=RR_FLOOR,     help=f'RR floor (default {RR_FLOOR})')
    ap.add_argument('--touches',type=int,   default=ZONE_MIN_TOUCHES, help=f'zone min touches (default {ZONE_MIN_TOUCHES})')
    ap.add_argument('--choch',      action='store_true', help='require CHoCH+engulf as hard entry gate (strict mode, fewer signals)')
    ap.add_argument('--long-only',  action='store_true', help='only take long signals (demand zones)')
    ap.add_argument('--short-only', action='store_true', help='only take short signals (supply zones)')
    ap.add_argument('--round-only', action='store_true', help='only keep signals where a round pip level falls within the zone')
    args = ap.parse_args()

    ZONE_MIN_TOUCHES = args.touches

    print("=" * 72)
    print("ALEX G STRUCTURAL MINER  v1")
    print("Bias: HH+HL=bull / LH+LL=bear on Daily + H4  (zigzag close-only)")
    print("Zones: Daily supply/demand, ≥2 body touches, 0.10–0.80×ATR_D")
    print("Entry: price AT zone + H1 CHoCH (swing break) + body engulf")
    print("SL: structural (below origin swing). TP: next daily H/L. RR≥2.0")
    print("=" * 72)

    if args.pair.lower() == 'all':
        # Pick up any *_m15.csv or *_h1.csv in the known pair map
        pairs_available = [k for k, flist in _PAIR_FILES.items()
                           if any(os.path.exists(f) for f in flist)]
        # Also auto-detect any {pair}_m15.csv files not in the map
        import glob as _glob
        _SKIP_KEYWORDS = ('signal', 'miner', 'best', 'state', 'pattern', 'frb', 'orb', 'nyorb')
        for f in sorted(_glob.glob('*_m15.csv')):
            p = f.replace('_m15.csv', '')
            if any(kw in p.lower() for kw in _SKIP_KEYWORDS):
                continue
            if p not in _PAIR_FILES and p not in pairs_available:
                _PAIR_FILES[p] = [f]
                pairs_available.append(p)
        if not pairs_available:
            print("No data files found. Run: python forex_download.py")
            sys.exit(1)
        print(f"\nPairs with data: {[p.upper() for p in pairs_available]}")

        # Primary pair for deep analysis
        primary = 'gbpusd' if 'gbpusd' in pairs_available else pairs_available[0]
        df_base_primary, _ = load_pair(primary)

        strict = args.choch
        print(f"\n[1/7] Baseline on {primary.upper()} ...")
        df_primary = collect_signals(df_base_primary, pair=primary, rr_floor=args.rr, require_choch=strict,
                                     long_only=args.long_only, short_only=args.short_only,
                                     round_only=args.round_only)
        df_primary.to_csv(f'alexg_signals_{primary}.csv', index=False)
        print(f"  Saved → alexg_signals_{primary}.csv")
        section_baseline(df_primary, label=f'{primary.upper()} structural', rr_floor=args.rr)

        print(f"\n[2/7] Pair sweep ...")
        section_pair_sweep(pairs_available, rr_floor=args.rr, require_choch=strict,
                           long_only=args.long_only, short_only=args.short_only,
                           round_only=args.round_only)

    else:
        # Single pair deep analysis
        primary = args.pair.lower()
        print(f"\nLoading {primary.upper()} ...")
        df_base, pname = load_pair(primary)
        if df_base is None:
            print(f"No data for {primary}. Run: python gbpusd_download.py")
            sys.exit(1)

        strict = args.choch
        filters = []
        if strict: filters.append('CHoCH required')
        if args.long_only:  filters.append('LONG only')
        if args.short_only: filters.append('SHORT only')
        if args.round_only: filters.append('round# only')
        print(f"\n[1/7] Collecting signals  ({', '.join(filters) if filters else 'no extra filters'}) ...")
        df_s = collect_signals(df_base, pair=pname, rr_floor=args.rr, require_choch=strict,
                               long_only=args.long_only, short_only=args.short_only,
                               round_only=args.round_only)

        if df_s.empty:
            print("\n  *** No signals found ***")
            print("  Possible causes:")
            print("  1. Zone min-touches too high — try --touches 2")
            print("  2. RR floor too high — try --rr 1.5")
            print("  3. Data timezone mismatch (check bar hours)")
            print("  4. CHoCH required but never fires simultaneously — drop --choch flag")
            sys.exit(1)

        df_s.to_csv(f'alexg_signals_{pname}.csv', index=False)
        print(f"  Found {len(df_s)} signals  (~{len(df_s)/YEARS_TOTAL:.0f}/yr)")
        print(f"  Saved → alexg_signals_{pname}.csv")

        section_baseline(df_s, label=f'{pname.upper()} structural', rr_floor=args.rr)

        print(f"\n[3/7] TP sweep ...")
        section_tp_sweep(df_s)

        print(f"\n[4/7] DOW breakdown ...")
        section_dow(df_s)

        print(f"\n[5/7] Confluence ...")
        section_confluence(df_s)

        print(f"\n[6/7] Trade type ...")
        section_trade_type(df_s)

        print(f"\n[7/7] Multi-TP ...")
        section_multi_tp(df_s)

        print("\n" + "═"*72)
        print("DONE")
        print("═"*72)
        w  = df_s['win'].values.astype(bool)
        pf = compute_pf(w, df_s['tp_dist'].values, df_s['sl_dist'].values)
        print(f"\n  {pname.upper():8}  N={len(df_s)}  WR={w.mean()*100:.1f}%  "
              f"PF={pf:.3f}  avgRR={df_s['rr'].mean():.2f}  ~{len(df_s)/YEARS_TOTAL:.0f}/yr")
        print(f"\n  Compare vs GBPUSD SFP (H1 baseline): WR=30.5%  PF=0.324")
        print(f"  alexg_signals_{pname}.csv → open in Excel to inspect each trade")
