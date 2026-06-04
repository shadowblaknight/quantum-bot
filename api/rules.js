/* eslint-disable */
// api/rules.js  (Pilot Dashboard v1.2 — HTTP wrapper)
//
// Thin HTTP wrapper around rules-store.js. Exposes its functions to the
// dashboard frontend. NO LOGIC OF ITS OWN — all rules logic lives in
// rules-store.js (which is also what webhook.js + manage-trades consume).
//
// ENDPOINTS:
//   GET  /api/rules                                  → full rules object
//   GET  /api/rules?action=activity&limit=50         → activity log
//   GET  /api/rules?action=daily-pnl                 → today's realized P&L
//
//   POST /api/rules?action=set-active-mode
//        body: { mode: "sleep"|"active"|"defensive"|"vacation" }
//
//   POST /api/rules?action=set-trading-mode
//        body: { mode: "auto"|"manual" }
//
//   POST /api/rules?action=update-instrument
//        body: { assetId: "gold", patch: { enabled, lotMode, fixedLot, ... } }
//
//   POST /api/rules?action=update-account-safety
//        body: { patch: { maxDailyLossPct, maxRiskPerTradePct, ... } }
//
//   POST /api/rules?action=update-template
//        body: { template: "am-ifvg", patch: { enabled, lotMultiplier, ... } }
//
//   POST /api/rules?action=emergency-stop
//        body: { enable: true|false }
//
//   POST /api/rules?action=replace
//        body: full rules object
// ----------------------------------------------------------------------------

const {
  getRules,
  setRules,
  updateInstrumentRule,
  updateAccountSafety,
  setActiveMode,
  setTradingMode,
  updateTemplateOverride,
  emergencyStopAll,
  getActivity,
  getTodaysPnL,
} = require('./rules-store');
const { applyCors } = require('./_lib');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  const action = (req.query?.action || '').toLowerCase();

  try {
    // ── READ operations (GET) ─────────────────────────────────────────
    if (req.method === 'GET') {
      if (!action || action === 'read' || action === 'get') {
        const rules = await getRules();
        return res.status(200).json(rules);
      }
      if (action === 'activity') {
        const limit = parseInt(req.query.limit || '50', 10);
        const activity = await getActivity(limit);
        return res.status(200).json({ activity, count: activity.length, updatedAt: Date.now() });
      }
      if (action === 'daily-pnl') {
        const pnl = await getTodaysPnL();
        return res.status(200).json({
          pnl,
          date: new Date().toISOString().slice(0, 10),
          updatedAt: Date.now(),
        });
      }
      return res.status(400).json({ error: `unknown GET action: ${action}` });
    }

    // ── WRITE operations (POST) ───────────────────────────────────────
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method-not-allowed; use POST for writes' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    if (action === 'set-active-mode') {
      if (!body.mode) return res.status(400).json({ error: 'mode required' });
      const r = await setActiveMode(body.mode);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (action === 'set-trading-mode') {
      if (!body.mode) return res.status(400).json({ error: 'mode required' });
      const r = await setTradingMode(body.mode);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (action === 'update-instrument') {
      if (!body.assetId || !body.patch) return res.status(400).json({ error: 'assetId and patch required' });
      const r = await updateInstrumentRule(body.assetId, body.patch);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (action === 'update-account-safety') {
      if (!body.patch) return res.status(400).json({ error: 'patch required' });
      const r = await updateAccountSafety(body.patch);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (action === 'update-template') {
      if (!body.template || !body.patch) return res.status(400).json({ error: 'template and patch required' });
      const r = await updateTemplateOverride(body.template, body.patch);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (action === 'emergency-stop') {
      const enable = body.enable !== false;
      const r = await emergencyStopAll(enable);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (action === 'replace' || action === 'set-all') {
      const r = await setRules(body);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    return res.status(400).json({ error: `unknown POST action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'rules endpoint error' });
  }
};