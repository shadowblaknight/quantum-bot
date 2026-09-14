"""
FX Specialist backtest — HTF S/R + Fibonacci AOI + candlestick C2 confirmation.

Architecture (mirrors the agreed spec):
  C1 context : Daily/Weekly/H4 bias  = EMA(200) position + market structure
  C2 entry   : price taps an AOI, then a rejection candle confirms
               AOI = swing S/R zone  (x)  Fib golden zone (61.8-78.6%)
  C3 risk    : SL beyond zone/wick, TP at R-multiple or opposing S/R

Everything scales across the 28 pairs by construction:
  - pip size auto-detected (JPY quote = 0.01, else 0.0001)
  - every distance threshold expressed in ATR, never fixed pips, so EURUSD
    (58 pip ADR) and GBPJPY (200 pip ADR) use the same settings
  - sessions derived from the pair's own two currencies

NO-LOOKAHEAD RULES (the thing that silently invalidates MTF backtests):
  1. A pivot needs `right` bars to confirm, so it only becomes visible
     `right` bars after it printed. We shift confirmation forward accordingly.
  2. HTF values attach to LTF bars via merge_asof on the HTF bar's CLOSE time,
     so a 15m bar at 09:05 sees the H4 that closed at 08:00 - never the H4
     still forming around it.
  3. Entry is at the confirmation bar's close; SL/TP resolve on LATER bars only.
"""

import numpy as np
import pandas as pd
from pathlib import Path
from dataclasses import dataclass, field, asdict

DATA = Path(__file__).parent / "data"

CCY = ["USD", "EUR", "GBP", "CHF", "JPY", "NZD", "CAD", "AUD"]
PAIRS = [
    "EURUSD","GBPUSD","USDJPY","USDCHF","USDCAD","AUDUSD","NZDUSD",
    "EURGBP","EURJPY","EURCHF","EURCAD","EURAUD","EURNZD",
    "GBPJPY","GBPCHF","GBPCAD","GBPAUD","GBPNZD",
    "AUDJPY","AUDCHF","AUDCAD","AUDNZD",
    "NZDJPY","NZDCHF","NZDCAD",
    "CADJPY","CADCHF","CHFJPY",
]

# Session windows in UTC, and which currency each session belongs to.
ASIAN_CCY  = {"JPY", "AUD", "NZD"}
LONDON_CCY = {"EUR", "GBP", "CHF"}
NY_CCY     = {"USD", "CAD"}
SESSIONS = {"asian": (0, 9), "london": (7, 16), "ny": (13, 22)}


# ────────────────────────────────────────────────────────────────────────────
# Config — every filter from the spec, all tunable
# ────────────────────────────────────────────────────────────────────────────
@dataclass
class Cfg:
    entry_tf: str = "15m"          # "15m" or "1h"
    confluence: str = "AND"        # "AND" = S/R and Fib, "OR" = either

    # structure / zones
    swing_left: int = 3
    swing_right: int = 3
    zone_tf: str = "4h"            # timeframe S/R zones are built on
    zone_atr_mult: float = 0.5     # zone half-width, in ATR of the zone TF
    zone_max_age_bars: int = 300   # ignore zones older than this (zone TF bars)
    zone_min_touches: int = 1

    # fibonacci
    fib_lo: float = 0.618
    fib_hi: float = 0.786
    fib_impulse_min_atr: float = 1.5   # impulse leg must be a real move

    # bias
    bias_tfs: tuple = ("1d", "4h")     # which TFs must agree
    ema_fast: int = 50
    ema_slow: int = 200
    bias_mode: str = "all"             # "all" | "any" | "majority"
    require_structure: bool = True     # HH/HL vs LH/LL must agree with EMA

    # confirmation candles
    use_engulfing: bool = True
    use_star: bool = True
    use_pinbar: bool = True
    pin_wick_ratio: float = 2.0        # rejection wick >= N x body
    pin_close_pct: float = 0.33        # close within top/bottom third
    pin_min_wick_pct: float = 0.50     # wick must be >= half the candle range
    pin_min_range_atr: float = 0.60    # and the candle itself must be significant
    engulf_min_body_atr: float = 0.25  # ignore doji-sized "engulfings"

    # volatility
    atr_len: int = 14
    min_atr_pips: float = 0.0
    adr_max_consumed: float = 0.90     # skip if >90% of ADR already spent

    # risk
    sl_mode: str = "wick"              # "wick" | "zone" | "atr"
    sl_buf_atr: float = 0.25
    # A 15m wick stop is ~8 pips on EURUSD — noise, and spread eats a tenth of
    # it. The stop must scale with the STRUCTURE being traded, so floor it at a
    # fraction of the zone-TF ATR.
    sl_min_zone_atr: float = 0.75
    tp_r: float = 2.0                  # reward multiple
    max_hold_bars: int = 200
    risk_pct: float = 0.01

    require_rejection_close: bool = False   # wick into level, body closes back out

    # session
    session_filter: bool = True
    sessions_allowed: tuple = ()       # empty = auto-derive from the pair


# ────────────────────────────────────────────────────────────────────────────
# helpers
# ────────────────────────────────────────────────────────────────────────────
def pip_size(pair: str) -> float:
    return 0.01 if pair[3:6] == "JPY" else 0.0001


def pair_sessions(pair: str) -> tuple:
    """A pair is tradeable in a session if either leg belongs to it."""
    b, q = pair[:3], pair[3:6]
    out = []
    for name, ccys in (("asian", ASIAN_CCY), ("london", LONDON_CCY), ("ny", NY_CCY)):
        if b in ccys or q in ccys:
            out.append(name)
    return tuple(out)


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def atr(df: pd.DataFrame, n: int) -> pd.Series:
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"],
                    (df["high"] - pc).abs(),
                    (df["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(span=n, adjust=False).mean()


def load(pair: str, tf: str) -> pd.DataFrame:
    f = DATA / f"{pair}_{tf}.csv"
    if not f.exists():
        return None
    df = pd.read_csv(f, parse_dates=["time"])
    df["time"] = df["time"].dt.tz_convert(None)
    return df.sort_values("time").drop_duplicates("time").reset_index(drop=True)


def derive_weekly(d1: pd.DataFrame) -> pd.DataFrame:
    """Broker weekly bars from dailies. Verified exact against MetaAPI's own 1w."""
    d = d1.copy()
    bt = d["time"] + pd.Timedelta(hours=3)         # broker is GMT+2/+3
    d["wk"] = bt.dt.to_period("W-SAT")             # week starts Sunday
    g = d.groupby("wk").agg(time=("time", "first"), open=("open", "first"),
                            high=("high", "max"), low=("low", "min"),
                            close=("close", "last"), volume=("volume", "sum"))
    return g.reset_index(drop=True)


def pivots(df: pd.DataFrame, left: int, right: int):
    """Confirmed swing points. Marked at the bar where they become KNOWN
    (pivot index + right), never at the pivot itself — that is the lookahead trap."""
    h, l = df["high"].values, df["low"].values
    n = len(df)
    ph = np.full(n, np.nan)
    pl = np.full(n, np.nan)
    for i in range(left, n - right):
        w_h = h[i - left:i + right + 1]
        w_l = l[i - left:i + right + 1]
        if h[i] == w_h.max() and (w_h.argmax() == left):
            ph[i + right] = h[i]        # known only `right` bars later
        if l[i] == w_l.min() and (w_l.argmin() == left):
            pl[i + right] = l[i]
    return ph, pl


def last_two_pivots(pv: np.ndarray):
    """For every bar: the last confirmed pivot and the one DISTINCT pivot before
    it. (Naive ffill().shift(1) returns the previous *bar*, which after a
    forward-fill is the same value — making HH/HL comparisons always false.)"""
    n = len(pv)
    last = np.full(n, np.nan)
    prev = np.full(n, np.nan)
    a = b = np.nan
    for i in range(n):
        if np.isfinite(pv[i]):
            a, b = pv[i], a
        last[i], prev[i] = a, b
    return last, prev


def bias_frame(df: pd.DataFrame, cfg: Cfg) -> pd.DataFrame:
    """Per-bar directional bias for one HTF: EMA position (+ optional structure)."""
    out = pd.DataFrame({"time": df["time"]})
    ef, es = ema(df["close"], cfg.ema_fast), ema(df["close"], cfg.ema_slow)
    ema_bias = np.where(df["close"] > es, 1, np.where(df["close"] < es, -1, 0))
    ema_bias = np.where((ema_bias == 1) & (ef > es), 1,
               np.where((ema_bias == -1) & (ef < es), -1, 0))

    if cfg.require_structure:
        ph, pl = pivots(df, cfg.swing_left, cfg.swing_right)
        last_ph, prev_ph = last_two_pivots(ph)
        last_pl, prev_pl = last_two_pivots(pl)
        hh = last_ph > prev_ph
        hl = last_pl > prev_pl
        lh = last_ph < prev_ph
        ll = last_pl < prev_pl
        struct = np.where(hh & hl, 1, np.where(lh & ll, -1, 0))
        bias = np.where(ema_bias == struct, ema_bias, 0)
    else:
        bias = ema_bias

    out["bias"] = bias
    # attach on CLOSE time so LTF bars never see a still-forming HTF bar
    step = df["time"].diff().median()
    out["avail"] = df["time"] + step
    return out


def build_zones(dfz: pd.DataFrame, cfg: Cfg):
    """Swing-derived S/R zones on the zone TF, each with its discovery time,
    price band and touch count."""
    a = atr(dfz, cfg.atr_len)
    ph, pl = pivots(dfz, cfg.swing_left, cfg.swing_right)
    zones = []
    for i in range(len(dfz)):
        for price, kind in ((ph[i], "res"), (pl[i], "sup")):
            if np.isnan(price):
                continue
            half = a.iloc[i] * cfg.zone_atr_mult
            if not np.isfinite(half) or half <= 0:
                continue
            zones.append({"t": dfz["time"].iloc[i], "idx": i, "price": price,
                          "lo": price - half, "hi": price + half, "kind": kind})
    if not zones:
        return pd.DataFrame(columns=["t", "idx", "price", "lo", "hi", "kind", "touches"])
    z = pd.DataFrame(zones)
    # touch count = how many other zones sit inside this one's band (retests)
    z["touches"] = [
        int(((z["price"] >= r.lo) & (z["price"] <= r.hi)).sum()) for r in z.itertuples()
    ]
    return z


def candle_patterns(df: pd.DataFrame, cfg: Cfg):
    """Vectorised bullish/bearish confirmation masks."""
    o, h, l, c = (df[k].values for k in ("open", "high", "low", "close"))
    a = atr(df, cfg.atr_len).values
    body = np.abs(c - o)
    rng = np.maximum(h - l, 1e-12)
    up = c > o
    dn = c < o

    po, pc = np.roll(o, 1), np.roll(c, 1)
    pbody = np.abs(pc - po)
    bull_eng = up & (pc < po) & (c >= po) & (o <= pc) & (body > pbody) & (body > cfg.engulf_min_body_atr * a)
    bear_eng = dn & (pc > po) & (c <= po) & (o >= pc) & (body > pbody) & (body > cfg.engulf_min_body_atr * a)

    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - l
    # A pin bar is a REJECTION: the wick must dominate the candle AND the candle
    # must be meaningful. Comparing the wick only to the body lets every doji
    # qualify (body ~ 0 makes `wick >= 2*body` trivially true), which turned 18%
    # of all bars into "confirmations".
    sig = rng >= cfg.pin_min_range_atr * a
    bull_pin = (lower >= cfg.pin_wick_ratio * body) & (lower >= cfg.pin_min_wick_pct * rng) & \
               ((c - l) / rng >= (1 - cfg.pin_close_pct)) & (lower > upper) & sig
    bear_pin = (upper >= cfg.pin_wick_ratio * body) & (upper >= cfg.pin_min_wick_pct * rng) & \
               ((h - c) / rng >= (1 - cfg.pin_close_pct)) & (upper > lower) & sig

    # morning / evening star: big bar, small indecision bar, strong reversal bar
    o2, c2 = np.roll(o, 2), np.roll(c, 2)
    body2 = np.abs(c2 - o2)
    mid2 = (o2 + c2) / 2
    small_mid = pbody < 0.5 * body2
    morning = (c2 < o2) & small_mid & up & (c > mid2) & (body2 > cfg.engulf_min_body_atr * a)
    evening = (c2 > o2) & small_mid & dn & (c < mid2) & (body2 > cfg.engulf_min_body_atr * a)

    bull = np.zeros(len(df), bool)
    bear = np.zeros(len(df), bool)
    if cfg.use_engulfing: bull |= bull_eng; bear |= bear_eng
    if cfg.use_pinbar:    bull |= bull_pin; bear |= bear_pin
    if cfg.use_star:      bull |= morning;  bear |= evening
    bull[:3] = False
    bear[:3] = False
    return bull, bear


# ────────────────────────────────────────────────────────────────────────────
# core
# ────────────────────────────────────────────────────────────────────────────
def run_pair(pair: str, cfg: Cfg):
    e = load(pair, cfg.entry_tf)
    dz = load(pair, cfg.zone_tf)
    d1 = load(pair, "1d")
    if e is None or dz is None or d1 is None or len(e) < 500:
        return None, None

    frames = {"1d": d1, "4h": load(pair, "4h"), "1h": load(pair, "1h"), "1w": derive_weekly(d1)}
    ps = pip_size(pair)

    # ---- bias from each requested HTF, aligned without lookahead
    e = e.copy()
    bias_cols = []
    for tf in cfg.bias_tfs:
        src = frames.get(tf)
        if src is None or len(src) < cfg.ema_slow + 10:
            continue
        bf = bias_frame(src, cfg)[["avail", "bias"]].rename(columns={"bias": f"b_{tf}"})
        e = pd.merge_asof(e, bf.sort_values("avail"), left_on="time", right_on="avail",
                          direction="backward").drop(columns=["avail"])
        bias_cols.append(f"b_{tf}")
    if not bias_cols:
        return None, None
    B = e[bias_cols].fillna(0).values
    if cfg.bias_mode == "all":
        bias = np.where((B == 1).all(1), 1, np.where((B == -1).all(1), -1, 0))
    elif cfg.bias_mode == "any":
        bias = np.where((B == 1).any(1), 1, np.where((B == -1).any(1), -1, 0))
    else:
        s = B.sum(1)
        bias = np.where(s > 0, 1, np.where(s < 0, -1, 0))

    # ---- volatility + ADR gate
    e["atr"] = atr(e, cfg.atr_len)
    d1r = d1.copy()
    d1r["adr"] = (d1r["high"] - d1r["low"]).rolling(14).mean()
    d1r["avail"] = d1r["time"] + pd.Timedelta(days=1)
    e = pd.merge_asof(e, d1r[["avail", "adr"]].sort_values("avail"),
                      left_on="time", right_on="avail", direction="backward").drop(columns=["avail"])
    day = e["time"].dt.floor("D")
    e["d_hi"] = e.groupby(day)["high"].cummax()
    e["d_lo"] = e.groupby(day)["low"].cummin()
    consumed = (e["d_hi"] - e["d_lo"]) / e["adr"].replace(0, np.nan)
    adr_ok = (consumed.shift(1) < cfg.adr_max_consumed).fillna(True).values

    # ---- session gate
    if cfg.session_filter:
        allow = cfg.sessions_allowed or pair_sessions(pair)
        hr = e["time"].dt.hour.values
        sess_ok = np.zeros(len(e), bool)
        for s in allow:
            a0, a1 = SESSIONS[s]
            sess_ok |= (hr >= a0) & (hr < a1)
    else:
        sess_ok = np.ones(len(e), bool)

    # ---- S/R zones on the zone TF, made visible only after discovery
    z = build_zones(dz, cfg)
    if len(z) == 0:
        return None, None
    z = z[z["touches"] >= cfg.zone_min_touches]
    if len(z) == 0:
        return None, None
    zt = z["t"].values.astype("datetime64[ns]")
    zlo, zhi, zkind = z["lo"].values, z["hi"].values, z["kind"].values
    zidx = z["idx"].values
    zone_step = dz["time"].diff().median()
    z_avail = zt + zone_step.to_timedelta64()

    # ---- fib on the last confirmed impulse leg of the zone TF
    ph_z, pl_z = pivots(dz, cfg.swing_left, cfg.swing_right)
    last_h, _ = last_two_pivots(ph_z)
    last_l, _ = last_two_pivots(pl_z)
    # Leg DIRECTION matters: a bullish retracement is only meaningful when the
    # swing low printed BEFORE the swing high (an up-impulse now pulling back).
    # Without this the fib is drawn on a down-leg ~half the time.
    n_z = len(dz)
    leg_dir = np.zeros(n_z)
    ih = il = -1
    for i in range(n_z):
        if np.isfinite(ph_z[i]): ih = i
        if np.isfinite(pl_z[i]): il = i
        if ih >= 0 and il >= 0:
            leg_dir[i] = 1 if il < ih else -1
    az = atr(dz, cfg.atr_len).values
    dz_avail = (dz["time"] + zone_step).values.astype("datetime64[ns]")

    fib = pd.DataFrame({"avail": dz_avail, "sw_h": last_h, "sw_l": last_l,
                        "z_atr": az, "leg_dir": leg_dir})
    e = pd.merge_asof(e, fib.sort_values("avail"), left_on="time", right_on="avail",
                      direction="backward").drop(columns=["avail"])

    leg = (e["sw_h"] - e["sw_l"]).values
    leg_ok = np.isfinite(leg) & (leg > cfg.fib_impulse_min_atr * e["z_atr"].values)
    # bullish retrace measured down from the swing high; bearish up from the low
    fib_bull_hi = e["sw_h"].values - cfg.fib_lo * leg
    fib_bull_lo = e["sw_h"].values - cfg.fib_hi * leg
    fib_bear_lo = e["sw_l"].values + cfg.fib_lo * leg
    fib_bear_hi = e["sw_l"].values + cfg.fib_hi * leg

    lo_v, hi_v = e["low"].values, e["high"].values
    ld = e["leg_dir"].values
    in_fib_bull = leg_ok & (ld == 1) & (lo_v <= fib_bull_hi) & (hi_v >= fib_bull_lo)
    in_fib_bear = leg_ok & (ld == -1) & (hi_v >= fib_bear_lo) & (lo_v <= fib_bear_hi)

    # ---- price inside a live S/R zone
    times = e["time"].values.astype("datetime64[ns]")
    in_sup = np.zeros(len(e), bool)
    in_res = np.zeros(len(e), bool)
    zone_lo_hit = np.full(len(e), np.nan)
    zone_hi_hit = np.full(len(e), np.nan)
    sup_hi = np.full(len(e), np.nan)
    res_lo = np.full(len(e), np.nan)
    order = np.argsort(z_avail)
    z_avail_s, zlo_s, zhi_s = z_avail[order], zlo[order], zhi[order]
    zkind_s, zidx_s = zkind[order], zidx[order]
    ptr = np.searchsorted(z_avail_s, times, side="right")
    max_age = cfg.zone_max_age_bars

    for i in range(len(e)):
        k = ptr[i]
        if k == 0:
            continue
        lo_i, hi_i = lo_v[i], hi_v[i]
        start = max(0, k - 400)                       # recent zones only
        for j in range(k - 1, start - 1, -1):
            if zidx_s[k - 1] - zidx_s[j] > max_age:
                break
            if lo_i <= zhi_s[j] and hi_i >= zlo_s[j]:
                if zkind_s[j] == "sup":
                    in_sup[i] = True
                    zone_lo_hit[i] = zlo_s[j]
                    sup_hi[i] = zhi_s[j]      # for the close-back-above test
                else:
                    in_res[i] = True
                    zone_hi_hit[i] = zhi_s[j]
                    res_lo[i] = zlo_s[j]
                if in_sup[i] and in_res[i]:
                    break

    # ---- AOI confluence
    if cfg.confluence == "AND":
        aoi_bull = in_sup & in_fib_bull
        aoi_bear = in_res & in_fib_bear
    else:
        aoi_bull = in_sup | in_fib_bull
        aoi_bear = in_res | in_fib_bear

    # ---- candle confirmation
    bull_c, bear_c = candle_patterns(e, cfg)

    atr_ok = (e["atr"].values / ps) >= cfg.min_atr_pips
    base = sess_ok & adr_ok & atr_ok & np.isfinite(e["atr"].values)

    if cfg.require_rejection_close:
        # A real rejection: the wick pierces INTO the level and the body closes
        # back out on the correct side. Merely printing a pattern while inside
        # the zone is not a rejection - it is often mid-pullback continuation.
        cv = e["close"].values
        rej_bull = (lo_v <= sup_hi) & (cv > sup_hi) & np.isfinite(sup_hi)
        rej_bear = (hi_v >= res_lo) & (cv < res_lo) & np.isfinite(res_lo)
        aoi_bull = aoi_bull & rej_bull
        aoi_bear = aoi_bear & rej_bear

    long_sig  = base & (bias == 1)  & aoi_bull & bull_c
    short_sig = base & (bias == -1) & aoi_bear & bear_c

    # ---- simulate
    trades = _simulate(e, long_sig, short_sig, zone_lo_hit, zone_hi_hit, cfg, ps)
    return trades, e


def _simulate(e, long_sig, short_sig, zlo_hit, zhi_hit, cfg: Cfg, ps: float):
    o, h, l, c = (e[k].values for k in ("open", "high", "low", "close"))
    a = e["atr"].values
    zatr = e["z_atr"].values
    t = e["time"].values
    n = len(e)
    out = []
    i_busy_until = -1

    idxs = np.where(long_sig | short_sig)[0]
    for i in idxs:
        if i <= i_busy_until or i >= n - 2:
            continue
        is_long = bool(long_sig[i])
        entry = c[i]

        if cfg.sl_mode == "wick":
            sl = (l[i] - cfg.sl_buf_atr * a[i]) if is_long else (h[i] + cfg.sl_buf_atr * a[i])
        elif cfg.sl_mode == "zone":
            zb = zlo_hit[i] if is_long else zhi_hit[i]
            if not np.isfinite(zb):
                zb = l[i] if is_long else h[i]
            sl = (zb - cfg.sl_buf_atr * a[i]) if is_long else (zb + cfg.sl_buf_atr * a[i])
        else:
            sl = (entry - 1.5 * a[i]) if is_long else (entry + 1.5 * a[i])

        # floor the stop at a fraction of the zone-TF ATR so it reflects the
        # structure, not a single entry-TF candle's wick
        floor = cfg.sl_min_zone_atr * zatr[i]
        if np.isfinite(floor) and floor > 0:
            if is_long:
                sl = min(sl, entry - floor)
            else:
                sl = max(sl, entry + floor)

        risk = abs(entry - sl)
        if risk <= 0 or not np.isfinite(risk):
            continue
        tp = entry + cfg.tp_r * risk if is_long else entry - cfg.tp_r * risk

        end = min(n, i + 1 + cfg.max_hold_bars)
        res, exit_p, exit_i = None, None, end - 1
        for j in range(i + 1, end):
            hit_sl = (l[j] <= sl) if is_long else (h[j] >= sl)
            hit_tp = (h[j] >= tp) if is_long else (l[j] <= tp)
            if hit_sl and hit_tp:
                res, exit_p, exit_i = "loss", sl, j     # conservative: SL first
                break
            if hit_sl:
                res, exit_p, exit_i = "loss", sl, j
                break
            if hit_tp:
                res, exit_p, exit_i = "win", tp, j
                break
        if res is None:
            res, exit_p = "timeout", c[end - 1]

        pnl_r = ((exit_p - entry) if is_long else (entry - exit_p)) / risk
        out.append({
            "time": t[i], "dir": "long" if is_long else "short",
            "entry": entry, "sl": sl, "tp": tp, "exit": exit_p,
            "result": res, "R": pnl_r, "risk_pips": risk / ps,
            "bars_held": exit_i - i,
        })
        i_busy_until = exit_i          # one position at a time

    return pd.DataFrame(out)


def stats(tr: pd.DataFrame) -> dict:
    if tr is None or len(tr) == 0:
        return {"trades": 0}
    wins = tr[tr["R"] > 0]["R"]
    loss = tr[tr["R"] <= 0]["R"]
    gp, gl = wins.sum(), abs(loss.sum())
    eq = tr["R"].cumsum()
    dd = (eq - eq.cummax()).min()
    yrs = max((pd.Timestamp(tr["time"].iloc[-1]) - pd.Timestamp(tr["time"].iloc[0])).days / 365.25, 1e-9)
    return {
        "trades": len(tr),
        "per_yr": round(len(tr) / yrs, 1),
        "WR": round(100 * (tr["R"] > 0).mean(), 2),
        "PF": round(gp / gl, 3) if gl > 0 else np.inf,
        "totR": round(tr["R"].sum(), 1),
        "expR": round(tr["R"].mean(), 3),
        "maxDD_R": round(dd, 1),
        "timeouts": int((tr["result"] == "timeout").sum()),
    }
