'use strict';
/* eslint-disable */
// api/gating-rules.js  v15.8
// GET  /api/gating-rules            → list all gating rules
// POST /api/gating-rules            → toggle a rule (body: { template, session, instrument, on })
// DELETE /api/gating-rules          → remove a rule (body: { template, session, instrument })
//
// G6 GUARDRAIL: this endpoint writes gating FLAGS only.
// It must never place, close, or modify any trade.
// Every state change is recorded in v14:gating:audit.
//
// The panel calls this with an explicit user action only — no auto-toggle,
// no toggle-on-signal, no batch mutations from background jobs.
//
// Reads are always fresh (no cache) so the control panel reflects real state.

const { applyCors, getRedis } = require('./_lib');
const { getAllRules, setRule, deleteRule } = require('./gating-store');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  const r = getRedis();
  if (!r) return res.status(503).json({ ok: false, error: 'no-redis' });

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const rules = await getAllRules(r);
      return res.status(200).json({ ok: true, rules });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── POST — toggle a rule ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }
    const { template, session, instrument, on } = body || {};

    if (!template || typeof template !== 'string') {
      return res.status(400).json({ ok: false, error: 'template is required' });
    }
    if (!instrument || typeof instrument !== 'string') {
      return res.status(400).json({ ok: false, error: 'instrument is required' });
    }
    if (typeof on !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'on (boolean) is required' });
    }
    const sess = (session && typeof session === 'string' && session.trim()) ? session.trim() : '*';

    try {
      const rule = await setRule(r, template.trim(), sess, instrument.trim().toLowerCase(), on, 'user');
      return res.status(200).json({ ok: true, rule });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── DELETE — remove a rule ────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }
    const { template, session, instrument } = body || {};

    if (!template || !instrument) {
      return res.status(400).json({ ok: false, error: 'template and instrument are required' });
    }
    const sess = (session && typeof session === 'string' && session.trim()) ? session.trim() : '*';

    try {
      const existed = await deleteRule(r, template.trim(), sess, instrument.trim().toLowerCase());
      return res.status(200).json({ ok: true, existed });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'method not allowed' });
};
