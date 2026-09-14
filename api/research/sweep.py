"""Parameter sweep + per-pair report for the FX specialist backtest."""
import sys, itertools, warnings
import numpy as np
import pandas as pd
from backtest_fx import Cfg, run_pair, stats, PAIRS, DATA, pair_sessions

warnings.filterwarnings("ignore")


def available():
    return [p for p in PAIRS if (DATA / f"{p}_1d.csv").exists()
            and (DATA / f"{p}_15m.csv").exists() and (DATA / f"{p}_4h.csv").exists()]


def agg(rows):
    """Pool trades across pairs into one line."""
    if not rows:
        return {"trades": 0}
    tr = pd.concat(rows, ignore_index=True).sort_values("time")
    return stats(tr)


def sweep(pairs, grid, base=None, long_only=False):
    out = []
    keys = list(grid)
    for combo in itertools.product(*[grid[k] for k in keys]):
        kw = dict(zip(keys, combo))
        cfg = Cfg(**{**(base or {}), **kw})
        rows = []
        for p in pairs:
            try:
                tr, _ = run_pair(p, cfg)
            except Exception as ex:
                print(f"   ! {p}: {ex}", file=sys.stderr)
                continue
            if tr is None or not len(tr):
                continue
            if long_only:
                tr = tr[tr["dir"] == "long"]
            if len(tr):
                tr = tr.copy(); tr["pair"] = p
                rows.append(tr)
        s = agg(rows)
        s.update(kw)
        out.append(s)
        desc = " ".join(f"{k}={v}" for k, v in kw.items())
        print(f"  {desc:58} -> trades {s.get('trades',0):5} "
              f"WR {s.get('WR',0):5}% PF {s.get('PF',0):6} totR {s.get('totR',0):7}")
    return pd.DataFrame(out)


def per_pair(pairs, cfg, long_only=False):
    rows = []
    for p in pairs:
        try:
            tr, _ = run_pair(p, cfg)
        except Exception as ex:
            print(f"  ! {p}: {ex}", file=sys.stderr); continue
        if tr is None or not len(tr):
            rows.append({"pair": p, "trades": 0}); continue
        if long_only:
            tr = tr[tr["dir"] == "long"]
        s = stats(tr); s["pair"] = p
        s["sessions"] = "+".join(pair_sessions(p))
        rows.append(s)
    df = pd.DataFrame(rows)
    cols = ["pair", "sessions", "trades", "per_yr", "WR", "PF", "totR", "expR", "maxDD_R"]
    return df[[c for c in cols if c in df.columns]].sort_values(
        "PF", ascending=False, na_position="last")
