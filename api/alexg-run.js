// V16 — DISABLED. Alex G strategy retired in V20. No-op endpoint.
module.exports = async (req, res) => res.status(410).json({ disabled: true, reason: 'V16-retired' });
