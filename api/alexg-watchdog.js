// V16 — DISABLED. Alex G watchdog retired in V20. No-op endpoint.
module.exports = async (req, res) => res.status(410).json({ disabled: true, reason: 'V16-retired' });
