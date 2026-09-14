"""Final FX-specialist report: per-pair, per-currency-group, and the config matrix."""
import warnings
import numpy as np
import pandas as pd
from backtest_fx import Cfg, run_pair, stats, PAIRS, DATA, pair_sessions
from sweep import available, per_pair

warnings.filterwarnings("ignore")
pd.set_option("display.width", 200)

BEST = dict(entry_tf="15m", confluence="OR", require_rejection_close=True,
            sl_min_zone_atr=1.5, tp_r=2.0)


def collect(pairs, cfg):
    """Run every pair once, return {pair: trades_df}."""
    out = {}
    for p in pairs:
        try:
            tr, _ = run_pair(p, cfg)
        except Exception as ex:
            print(f"  ! {p}: {ex}")
            continue
        if tr is not None and len(tr):
            tr = tr.copy(); tr["pair"] = p
            out[p] = tr
    return out


def pool(trades, pairs):
    rows = [trades[p] for p in pairs if p in trades]
    if not rows:
        return {"trades": 0}
    return stats(pd.concat(rows, ignore_index=True).sort_values("time"))


def group_report(trades, pairs):
    """Test the CHF/JPY hypothesis: group pairs by which currency they contain."""
    groups = {
        "CHF crosses (any CHF)": [p for p in pairs if "CHF" in p],
        "JPY crosses (any JPY)": [p for p in pairs if "JPY" in p],
        "CHF or JPY":            [p for p in pairs if "CHF" in p or "JPY" in p],
        "USD majors":            [p for p in pairs if "USD" in p],
        "Commodity (AUD/NZD/CAD, no CHF/JPY)":
            [p for p in pairs if any(c in p for c in ("AUD", "NZD", "CAD"))
             and "CHF" not in p and "JPY" not in p],
        "ALL 28":                list(pairs),
    }
    rows = []
    for name, ps in groups.items():
        s = pool(trades, ps)
        s["group"] = name
        s["n_pairs"] = len(ps)
        rows.append(s)
    df = pd.DataFrame(rows)
    cols = ["group", "n_pairs", "trades", "per_yr", "WR", "PF", "totR", "expR", "maxDD_R"]
    return df[[c for c in cols if c in df.columns]]


def main():
    pairs = available()
    print(f"pairs with data: {len(pairs)}\n")

    print("=" * 96)
    print("CONFIG MATRIX  (answers: AND vs OR confluence, 15m vs 1h entry)")
    print("=" * 96)
    mrows = []
    for conf in ("AND", "OR"):
        for tf in ("15m", "1h"):
            cfg = Cfg(**{**BEST, "confluence": conf, "entry_tf": tf})
            t = collect(pairs, cfg)
            s = pool(t, pairs); s["confluence"] = conf; s["entry_tf"] = tf
            mrows.append(s)
            print(f"  {conf:3} {tf:4} -> trades {s.get('trades',0):5} "
                  f"per_yr {s.get('per_yr',0):6} WR {s.get('WR',0):6}% "
                  f"PF {s.get('PF',0):6} totR {s.get('totR',0):8}")
    pd.DataFrame(mrows).to_csv(DATA.parent / "matrix.csv", index=False)

    print("\n" + "=" * 96)
    print(f"BEST CONFIG {BEST}")
    print("=" * 96)
    cfg = Cfg(**BEST)
    trades = collect(pairs, cfg)

    print("\n--- CURRENCY GROUPS (is the CHF/JPY edge structural?) ---")
    g = group_report(trades, pairs)
    print(g.to_string(index=False))
    g.to_csv(DATA.parent / "groups.csv", index=False)

    print("\n--- PER PAIR ---")
    pp = per_pair(pairs, cfg)
    print(pp.to_string(index=False))
    pp.to_csv(DATA.parent / "per_pair.csv", index=False)

    win = pp[pp.PF > 1]
    print(f"\nprofitable: {len(win)}/{len(pp)} pairs")
    if len(win):
        print("  ", ", ".join(win.pair.tolist()))

    allt = pd.concat(trades.values(), ignore_index=True) if trades else pd.DataFrame()
    if len(allt):
        allt.to_csv(DATA.parent / "all_trades.csv", index=False)
        print(f"\nwrote {len(allt)} trades -> all_trades.csv")


if __name__ == "__main__":
    main()
