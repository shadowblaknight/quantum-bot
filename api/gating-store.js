'use strict';
/* eslint-disable */
// api/gating-store.js  v15.8
// Redis-backed gating rule store.
//
// Rule key format: "{template}|{session}|{instrument}"
//   Use "*" as a wildcard for session (matches all sessions).
//   e.g. "orb|*|btc"   — block ORB on BTC regardless of session
//        "orb|NY_AM|gold" — block ORB on gold in NY_AM only
//
// Store layout:
//   v14:gating:rules  — JSON object: { [key]: { on: bool, updatedAt: ms, updatedBy: str } }
//   v14:gating:audit  — list (newest-first), capped at 200 entries
//
// SAFETY: this module only reads/writes gating flags.
//   It NEVER touches trade records, ledger, order prices, or positions.
//   G6 is enforced at the HTTP layer (gating-rules.js) which rejects non-POST.
//
// Seeding: on first isGated() call, if the store is empty, seeds from
//   HARDCODED_BLOCKS so the existing ORB×BTC and ORB×NAS100 blocks are
//   represented in the store from day one.

const { getRedis, safeParse } = require('./_lib');

const RULES_KEY = 'v14:gating:rules';
const AUDIT_KEY = 'v14:gating:audit';
const AUDIT_CAP = 200;

// Mirrors the hardcoded TEMPLATE_INSTRUMENT_BLOCKS in webhook.js.
// Used only for initial seeding if the store is empty.
const HARDCODED_BLOCKS = [
  { template: 'orb', session: '*', instrument: 'btc',    on: false, reason: 'hardcoded-migration' },
  { template: 'orb', session: '*', instrument: 'nas100', on: false, reason: 'hardcoded-migration' },
];

function ruleKey(template, session, instrument) {
  return `${template}|${session}|${instrument}`;
}

async function seedIfEmpty(r, rules) {
  if (Object.keys(rules).length > 0) return rules;
  const seeded = {};
  for (const b of HARDCODED_BLOCKS) {
    const k = ruleKey(b.template, b.session, b.instrument);
    seeded[k] = { on: b.on, updatedAt: Date.now(), updatedBy: 'seed', reason: b.reason };
  }
  try { await r.set(RULES_KEY, JSON.stringify(seeded)); } catch (_) {}
  return seeded;
}

async function loadRules(r) {
  const raw = await r.get(RULES_KEY).catch(() => null);
  const rules = safeParse(raw) || {};
  return seedIfEmpty(r, rules);
}

// Returns null (allowed) or { blocked:true, ruleKey, updatedBy } (blocked).
// Check order: exact key → wildcard session → null if no matching rule.
// THROWS on Redis failure so the caller can fall back to hardcoded blocks safely.
async function isGated(template, session, instrument) {
  const r = getRedis();
  if (!r) throw new Error('gating-store: no-redis');

  // loadRules may throw — caller (webhook.js) must catch and apply hardcoded fallback.
  const rules = await loadRules(r);

  const exactKey    = ruleKey(template, session,   instrument);
  const wildcardKey = ruleKey(template, '*',        instrument);

  let matchedKey = null;
  let rule       = null;
  if (rules[exactKey] !== undefined) {
    matchedKey = exactKey;
    rule       = rules[exactKey];
  } else if (rules[wildcardKey] !== undefined) {
    matchedKey = wildcardKey;
    rule       = rules[wildcardKey];
  }

  if (!rule || rule.on !== false) return null; // no rule, or rule says allowed
  return { blocked: true, ruleKey: matchedKey, updatedBy: rule.updatedBy || null };
}

// Returns all rules as an array for the API response.
async function getAllRules(r) {
  const rules = await loadRules(r);
  return Object.entries(rules).map(([key, v]) => {
    const [template, session, instrument] = key.split('|');
    return { key, template, session, instrument, on: v.on, updatedAt: v.updatedAt, updatedBy: v.updatedBy || null, reason: v.reason || null };
  });
}

// Set a single rule. on=true means allowed; on=false means blocked.
async function setRule(r, template, session, instrument, on, updatedBy = 'user') {
  const rules = await loadRules(r);
  const key   = ruleKey(template, session, instrument);
  const prev  = rules[key];
  rules[key]  = { on: !!on, updatedAt: Date.now(), updatedBy };
  await r.set(RULES_KEY, JSON.stringify(rules));

  // Audit log
  try {
    const entry = JSON.stringify({
      ts:         Date.now(),
      key,
      template,
      session,
      instrument,
      on:         !!on,
      prev:       prev ? prev.on : null,
      updatedBy,
    });
    await r.lpush(AUDIT_KEY, entry);
    await r.ltrim(AUDIT_KEY, 0, AUDIT_CAP - 1);
  } catch (_) {}

  return rules[key];
}

// Delete a rule (revert to default-allow).
async function deleteRule(r, template, session, instrument) {
  const rules = await loadRules(r);
  const key   = ruleKey(template, session, instrument);
  const existed = key in rules;
  delete rules[key];
  await r.set(RULES_KEY, JSON.stringify(rules));
  return existed;
}

module.exports = { isGated, getAllRules, setRule, deleteRule, loadRules, RULES_KEY, AUDIT_KEY };
