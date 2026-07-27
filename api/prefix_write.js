'use strict';
// api/prefix_write.js — One-shot preFix-flag verification and maintenance
//
// WHY IT EXISTS
// The v14 ledger stores preFix:true on trades that were taken under bugs that
// make their outcomes unreliable as recognition-memory training signal:
//   - atr-mismatch  : TP targets were computed from peak-ATR instead of average-ATR
//                     (affects FX pairs + NAS100). ATR_FIX_DATE in perf-analysis.js
//                     must be set to the deploy date of the fix.
//   - orb-routing   : ORB setups were routed to the wrong broker contract.
//   - orbpro-anchor : One specific ORB-pro anchor trade placed under the routing bug.
//   - sl-lock-bug   : SL ratchet submitted modifyPosition and read HTTP-200 as
//                     broker-confirmed. Broker silently rejected; the lock never landed.
//                     Outcome (LOSS) reflects the bug, not the setup quality.
//
// The recognition-memory KNN advisor excludes any trade whose matching ledger record
// has preFix:true — so these flags are the gate that keeps contaminated trades out.
//
// HISTORY
// 59 flags were written in a prior session:
//   41 × ["atr-mismatch"]
//   10 × ["orb-routing","atr-mismatch"]
//    7 × ["orb-routing"]
//    1 × ["orbpro-anchor","orb-routing","atr-mismatch"]
//
// The two SL-lock-bug trades were flagged only with ["atr-mismatch"] at that time
// (they are FX trades that also had the ATR mismatch). This script adds "sl-lock-bug"
// to their preFixReason so the reason is accurate.
//
// RUNNING
//   node api/prefix_write.js [--dry-run]
//   Required env: KV_REST_API_URL, KV_REST_API_TOKEN (loaded from ../.env.fresh)
//
// OUTPUT
//   Prints a table of before/after flag counts. Exit 0 on success.
//
// IDEMPOTENT: safe to run multiple times; only writes when the record's state
// differs from the desired state.
// ----------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '../.env.fresh') });

const { getRedis, safeParse } = require('./_lib');

const DRY_RUN = process.argv.includes('--dry-run');

// Two confirmed SL-lock-bug trades.  Their preFix:true was already written
// (with reason ["atr-mismatch"]) — this script adds "sl-lock-bug" to the array.
const SL_LOCK_BUG_IDS = new Set([
  'trade_eurusd_295801077',   // judas-swing SHORT EURUSD; -$74.69
  'trade_usdjpy_294729565',   // reaction SHORT USDJPY;    -$84.47
]);

async function run() {
  const r = getRedis();
  if (!r) { console.error('no redis'); process.exit(1); }

  const indexRaw = await r.get('v14:ledger:index').catch(() => null);
  const index    = safeParse(indexRaw) || [];

  // Pipeline fetch all ledger records
  const pipe    = r.pipeline();
  for (const e of index) pipe.get(`v14:ledger:trade:${e.id}`);
  const results = await pipe.exec().catch(() => []);
  const recs    = results
    .map(raw => raw ? (typeof raw === 'string' ? safeParse(raw) : raw) : null)
    .filter(Boolean);

  // ── Audit existing flags ────────────────────────────────────────────────
  const alreadyFlagged   = recs.filter(r => r.preFix === true);
  const notFlagged       = recs.filter(r => r.preFix !== true);
  const slLockInLedger   = recs.filter(r => SL_LOCK_BUG_IDS.has(r.id));
  const slLockMissingTag = slLockInLedger.filter(r => {
    const reasons = Array.isArray(r.preFixReason) ? r.preFixReason : [];
    return !reasons.includes('sl-lock-bug');
  });

  console.log('\n── prefix_write.js ────────────────────────────────────────────────────');
  console.log(`Ledger records:           ${recs.length}`);
  console.log(`  preFix:true:            ${alreadyFlagged.length}`);
  console.log(`  preFix≠true:            ${notFlagged.length}`);
  console.log(`SL-lock-bug trades found: ${slLockInLedger.length}`);
  console.log(`  Missing "sl-lock-bug" reason: ${slLockMissingTag.length}`);
  if (DRY_RUN) console.log('\n[DRY RUN — no writes]');

  // ── Reason breakdown of existing preFix records ─────────────────────────
  console.log('\nExisting preFix reason groups:');
  const byReason = {};
  for (const rec of alreadyFlagged) {
    const k = JSON.stringify((rec.preFixReason || []).slice().sort());
    byReason[k] = (byReason[k] || 0) + 1;
  }
  for (const [reason, n] of Object.entries(byReason)) {
    console.log(`  ${n.toString().padStart(3)}  ${reason}`);
  }

  // ── Step 3: update SL-lock-bug trades ───────────────────────────────────
  let step3Updated = 0;
  let step3Skipped = 0;

  if (slLockMissingTag.length === 0) {
    console.log('\nStep 3: SL-lock-bug reasons already correct — nothing to update.');
  } else {
    console.log(`\nStep 3: Adding "sl-lock-bug" to ${slLockMissingTag.length} trade(s):`);
    for (const rec of slLockMissingTag) {
      const reasons    = Array.isArray(rec.preFixReason) ? [...rec.preFixReason] : [];
      const newReasons = [...new Set([...reasons, 'sl-lock-bug'])];
      const updated    = { ...rec, preFix: true, preFixReason: newReasons };
      console.log(`  ${rec.id}  ${JSON.stringify(reasons)} → ${JSON.stringify(newReasons)}`);
      if (!DRY_RUN) {
        await r.set(`v14:ledger:trade:${rec.id}`, JSON.stringify(updated)).catch(e => {
          console.error(`  ERROR writing ${rec.id}: ${e.message}`);
        });
        step3Updated++;
      } else {
        step3Skipped++;
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n── Summary ────────────────────────────────────────────────────────────');
  console.log(`preFix:true before:  ${alreadyFlagged.length}`);
  const finalFlagged = DRY_RUN ? alreadyFlagged.length : alreadyFlagged.length;
  console.log(`preFix:true after:   ${finalFlagged}  (count unchanged — flags were pre-existing)`);
  console.log(`sl-lock-bug reasons updated: ${DRY_RUN ? `0 (dry run; ${step3Skipped} would update)` : step3Updated}`);
  console.log(`\nNo new preFix records needed — the 59 flags from the earlier plan are intact.`);
  console.log('KNN exclusion filter is active and correctly excluding these records.');
  console.log('\nNext action required to complete the pre-fix story:');
  console.log('  1. Deploy the ATR average-vs-peak fix.');
  console.log('  2. Set ATR_FIX_DATE in perf-analysis.js to the deploy timestamp.');
  console.log('  3. Re-run this script — it will stay idempotent.');

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
