# Phase 2 — Pine Script Migration Checklist

## How to update each template

1. Paste the full `session-context-v17.pine` block at the top of the indicator (after your existing variables)
2. Update the alert message to include the new fields using the `_scSuffix()` helper
3. Only change `_gapDirLong` → `_gapDirShort` between the two alert directions

All 8 new fields are safe to send from every template on every instrument.
The server ignores fields that don't apply (e.g. `ibSide` on forex, `nearKeyTime` on BTC).

---

## Template-by-template notes

| Template | Chart TF | Instrument(s) | IB available? | Notes |
|---|---|---|---|---|
| silver-bullet | 5m / 15m | gold, us500, nas100 | ✅ (fires 14:00+ UTC) | Standard integration |
| am-ifvg | 5m / 15m | gold, us500, nas100 | ✅ | Standard integration |
| orb | 1m / 5m | us500, nas100 | ⚠️ fires AT 13:30 UTC | IB not yet built — `ibSide="null"`, `ibPosition=-1`, `first15mDir=0` |
| orb-pro | 5m | us500, nas100 | ⚠️ fires at 13:30–13:45 UTC | IB partial — ibPosition will be -1 until 14:30 |
| unicorn | 15m / 1h | gold, forex | ❌ not applicable | ibSide/ibPosition/first15mDir always default (server ignores) |
| turtle-soup | 5m / 15m | gold, forex | ❌ not applicable | Standard integration |
| judas-swing | 15m | gold, forex | ❌ not applicable | Standard integration |
| ote-continuation | 1h | gold, forex | ❌ not applicable | Fires on 1h — `_rthOpenPrice` may not capture 13:30 bar; ibSide won't matter |
| reaction | 5m / 15m | ⛔ blocked on gold/us500/nas100 | — | Now hard-blocked by gating-store seed |
| reaction-fvg | 5m / 15m | ⛔ blocked on gold/us500/nas100 | — | Same |
| reaction-ifvg | 5m / 15m | ⛔ blocked on gold/us500/nas100 | — | Same |

---

## ORB / ORB-PRO special case

ORB fires **at or just after the 13:30 UTC open** — before the IB window closes (14:30 UTC).
The IB variables will read:
- `_ibSideStr = "null"` (IB not complete)
- `_ibPositionV = -1` (sentinel)
- `_first15mDir = 0` (first 15-min bar not closed yet)

The server handles all three correctly (treats them as absent, scores 0 for those checks).
The remaining checks still run: `adrConsumed`, `gapAtr`, `gapDir`, `priorDayPos`.
For ORB at 13:30 UTC with a 0.8x ATR gap in the signal direction, the server would score:
- `large-gap-aligned` → +2 (if gap > 1.2x ATR)
- `prior-day-aligned` → +1 (if opens above prior high for long)
- IB/first15m → 0 (not yet available)
= FAVORABLE or NEUTRAL → does not block ORB, just gives honest context

---

## Timeframe notes for `_rthOpenPrice`

The `_rthOpenPrice` capture (`_minOfDay == _ibStart`) requires a bar that
opens exactly at 13:30 UTC. This works on 1m, 5m, 15m, 30m charts.
On 1h charts, the 13:00–14:00 bar opens at 13:00, not 13:30 — the variable
never captures. For 1h chart templates (ote-continuation), `_first15mDir`
will always be 0. That is acceptable — it scores neutral, no harm.

---

## Fields the server already handles without new Pine (legacy path)

Until a Pine script is updated to send the new fields, the server detects
their absence (`adrConsumed == null && gapAtr == null && priorDayPos == null`)
and falls back to the legacy 4H candle fetch + withPriorSession path.
No signals are blocked or degraded during migration.

---

## Verification after update

After updating a template, trigger a test alert and check the webhook log
for the quality entry. Look for:
```json
"session": {
  "grade": "NEUTRAL",
  "sessionScore": 0,
  "scoreAvailable": true,
  "checks": [...]
}
```
`scoreAvailable: true` confirms the structural path ran (not legacy).
`grade` and `checks` show exactly what scored and why.
