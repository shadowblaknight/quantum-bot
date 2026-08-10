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
// Seeding: every loadRules() call runs seedMissingBlocks(), which adds any
//   HARDCODED_BLOCKS entry not yet present in the store. This seeds new blocks
//   on existing installations without disturbing user-configured rules.

const { getRedis, safeParse } = require('./_lib');

const RULES_KEY = 'v14:gating:rules';
const AUDIT_KEY = 'v14:gating:audit';
const AUDIT_CAP = 200;

// Canonical list of known-bad template×instrument pairs.
// seedMissingBlocks() adds any of these that aren't already in the store, so:
//   – New installations get all blocks from day one.
//   – Existing stores only get blocks for keys that have never been set.
//   – Explicit panel overrides (on: true) are preserved — they already exist
//     in the store, so seedMissingBlocks skips them.
const HARDCODED_BLOCKS = [
  { template: 'orb',          session: '*', instrument: 'btc',    on: false, reason: 'hardcoded-migration' },
  { template: 'orb',          session: '*', instrument: 'nas100', on: false, reason: 'hardcoded-migration' },
  // Reaction family: historically negative expectancy on XAU + indices.
  // Signal quality gates (wick/session/CVD) do not compensate for bad template-instrument fit.
  { template: 'reaction',     session: '*', instrument: 'gold',   on: false, reason: 'hardcoded-block:poor-template-fit' },
  { template: 'reaction',     session: '*', instrument: 'us500',  on: false, reason: 'hardcoded-block:poor-template-fit' },
  { template: 'reaction',     session: '*', instrument: 'nas100', on: false, reason: 'hardcoded-block:poor-template-fit' },
  { template: 'reaction-fvg', session: '*', instrument: 'gold',   on: false, reason: 'hardcoded-block:poor-template-fit' },
  { template: 'reaction-fvg', session: '*', instrument: 'us500',  on: false, reason: 'hardcoded-block:poor-template-fit' },
  { template: 'reaction-fvg', session: '*', instrument: 'nas100', on: false, reason: 'hardcoded-block:poor-template-fit' },
  // reaction-ifvg on gold: 5-for-5 WIN (100% WR, +5.31R) — ALLOWED on gold, blocked everywhere else
  { template: 'reaction-ifvg', session: '*', instrument: 'us500',  on: false, reason: 'hardcoded-block:poor-template-fit' },
  { template: 'reaction-ifvg', session: '*', instrument: 'nas100', on: false, reason: 'hardcoded-block:poor-template-fit' },
  // orb-pro on gold: 50% WR, -1.49R across 6 trades — no edge in either scalp or day mode
  { template: 'orb-pro',       session: '*', instrument: 'gold',   on: false, reason: 'hardcoded-block:negative-expectancy' },
];

function ruleKey(template, session, instrument) {
  return `${template}|${session}|${instrument}`;
}

// Seeds HARDCODED_BLOCKS entries that don't yet have any rule in the store.
// Unlike the old seedIfEmpty (which only ran when the store was completely empty),
// this runs every loadRules() call and picks up new blocks added to the list
// without disturbing any rule the user has explicitly set via the panel.
async function seedMissingBlocks(r, rules) {
  const missing = HARDCODED_BLOCKS.filter(b => !(ruleKey(b.template, b.session, b.instrument) in rules));
  if (missing.length === 0) return rules;
  const now = Date.now();
  for (const b of missing) {
    const k = ruleKey(b.template, b.session, b.instrument);
    rules[k] = { on: b.on, updatedAt: now, updatedBy: 'seed', reason: b.reason };
  }
  try { await r.set(RULES_KEY, JSON.stringify(rules)); } catch (_) {}
  return rules;
}

async function loadRules(r) {
  const raw   = await r.get(RULES_KEY).catch(() => null);
  let rules   = safeParse(raw) || {};
  // Migrate: instrument field "all" → "*" for key consistency.
  // Before instrument wildcards were implemented, the panel stored "all" as a
  // literal instrument name. isGated() now uses "*" for instrument wildcards.
  let migrated = false;
  for (const key of Object.keys(rules)) {
    const parts = key.split('|');
    if (parts.length === 3 && parts[2] === 'all') {
      const newKey = `${parts[0]}|${parts[1]}|*`;
      if (!(newKey in rules)) rules[newKey] = rules[key]; // don't clobber explicit *
      delete rules[key];
      migrated = true;
    }
  }
  if (migrated) { await r.set(RULES_KEY, JSON.stringify(rules)).catch(() => {}); }
  return seedMissingBlocks(r, rules);
}

// Returns null (allowed) or { blocked:true, ruleKey, updatedBy } (blocked).
// THROWS on Redis failure so the caller (webhook.js) can fail open and log loudly.
//
// Match precedence — most specific first, first match wins:
//   1. template|session|instrument  — exact
//   2. template|session|*           — this session, ALL instruments
//   3. template|*|instrument        — ANY session, this instrument
//   4. template|*|*                 — ANY session, ALL instruments
//
// "First match wins" means a specific ENABLE overrides a broader DISABLE:
//   orb|NY_AM|* = off  +  orb|NY_AM|gold = on  →  gold ALLOWED, others BLOCKED
//   orb|*|btc   = on   +  orb|NY_AM|*    = off →  btc BLOCKED in NY_AM (session-specific
//                                                   wins over any-session by precedence)
async function isGated(template, session, instrument) {
  const r = getRedis();
  if (!r) throw new Error('gating-store: no-redis');

  // loadRules may throw — caller must catch
  const rules = await loadRules(r);

  const candidates = [
    ruleKey(template, session, instrument), // level 1: exact
    ruleKey(template, session, '*'),         // level 2: session-specific, all instruments
    ruleKey(template, '*',     instrument), // level 3: any session, specific instrument
    ruleKey(template, '*',     '*'),         // level 4: any session, all instruments
  ];

  for (const key of candidates) {
    const rule = rules[key];
    if (rule === undefined) continue;         // no rule at this level → try next
    if (rule.on === false)
      return { blocked: true, ruleKey: key, updatedBy: rule.updatedBy || null };
    return null; // rule.on !== false → explicitly allowed at this level, stop
  }
  return null; // no rule found → allowed by default
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
