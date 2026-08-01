'use strict';
/* eslint-disable */
// api/ny-session-summary.js  v16.1
//
// GET /api/ny-session-summary
// Returns today's NY Open Specialist status per instrument + recent session history.
// Read-only. No write path. Never imports execute.js or any placement module.

const { applyCors } = require('./_lib');
const { getNYPanelData } = require('./ny-session-journal');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method not allowed' });

  try {
    const data = await getNYPanelData();
    if (!data) return res.status(503).json({ ok: false, error: 'no-redis' });
    return res.status(data.ok === false ? 500 : 200).json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
