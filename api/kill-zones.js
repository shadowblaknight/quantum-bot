/* eslint-disable */
// V12.2 — api/kill-zones.js
//
// Pure date/time math for ICT kill zones. No I/O, no side effects.
// Used by:
//   - coherence-checker (tag setups with KZ status)
//   - execute (gate trade placement)
//   - cron (detect open/close transitions for telegram)
//
// All 4 ICT kill zones (per ICT/Ayub Rana/2022 Mentorship sources):
//   - LONDON:        02:00 - 05:00 NY local time
//   - NY_AM:         08:00 - 11:00 NY local time  (overlap with London)
//   - LONDON_CLOSE:  10:00 - 12:00 NY local time
//   - NY_PM:         13:00 - 14:00 NY local time  ("Silver Bullet PM")
//
// We use UTC math with a generous DST union — kill zones are 1-2 hours
// each, so a 1-hour DST shift just slightly extends/contracts the window
// rather than missing it entirely.
//
// EDT (summer, UTC-4):
//   LONDON:       06:00 - 09:00 UTC
//   NY_AM:        12:00 - 15:00 UTC
//   LONDON_CLOSE: 14:00 - 16:00 UTC
//   NY_PM:        17:00 - 18:00 UTC
//
// EST (winter, UTC-5):
//   LONDON:       07:00 - 10:00 UTC
//   NY_AM:        13:00 - 16:00 UTC
//   LONDON_CLOSE: 15:00 - 17:00 UTC
//   NY_PM:        18:00 - 19:00 UTC
//
// Generous unions covering both:
//   LONDON:        06:00 - 10:00 UTC
//   NY_AM:         12:00 - 16:00 UTC
//   LONDON_CLOSE:  14:00 - 17:00 UTC
//   NY_PM:         17:00 - 19:00 UTC
//
// Note overlap between NY_AM and LONDON_CLOSE — that's a feature, not a bug
// (LuxAlgo "Silver Bullet" window 14:00-16:00 UTC is the cleanest hour).
// We pick the most-specific KZ name when multiple are active.

const KILL_ZONES = [
  // Order matters — we pick the FIRST match. Most-specific first.
  { name: 'NY_PM',         startUtcMin: 17 * 60,  endUtcMin: 19 * 60 },
  { name: 'LONDON_CLOSE',  startUtcMin: 14 * 60,  endUtcMin: 17 * 60 },
  { name: 'NY_AM',         startUtcMin: 12 * 60,  endUtcMin: 16 * 60 },
  { name: 'LONDON',        startUtcMin: 6  * 60,  endUtcMin: 10 * 60 },
];

// =================================================================
// CHECK: is a given time inside any kill zone?
// =================================================================
// Input: optional Date (defaults to now)
// Output: { inKillZone, name, startUtcMin, endUtcMin, minutesUntilClose? }

function checkKillZone(date) {
  const d = date || new Date();
  const utcMinute = d.getUTCHours() * 60 + d.getUTCMinutes();

  for (const kz of KILL_ZONES) {
    if (utcMinute >= kz.startUtcMin && utcMinute < kz.endUtcMin) {
      return {
        inKillZone: true,
        name: kz.name,
        startUtcMin: kz.startUtcMin,
        endUtcMin: kz.endUtcMin,
        minutesUntilClose: kz.endUtcMin - utcMinute,
      };
    }
  }

  // Find next upcoming KZ (for status display)
  let nextKZ = null;
  let nextDelta = Infinity;
  for (const kz of KILL_ZONES) {
    let delta = kz.startUtcMin - utcMinute;
    if (delta < 0) delta += 24 * 60; // wrap to tomorrow
    if (delta < nextDelta) {
      nextDelta = delta;
      nextKZ = kz;
    }
  }

  return {
    inKillZone: false,
    name: 'OFF_HOURS',
    nextKillZone: nextKZ?.name,
    minutesUntilNext: nextKZ ? nextDelta : null,
  };
}

// =================================================================
// HUMAN-READABLE NAMES (for telegram + commentary)
// =================================================================

const KZ_DISPLAY_NAMES = {
  LONDON:       'London',
  NY_AM:        'New York AM',
  LONDON_CLOSE: 'London Close',
  NY_PM:        'New York PM (Silver Bullet)',
  OFF_HOURS:    'Off-Hours',
};

function killZoneDisplayName(kzName) {
  return KZ_DISPLAY_NAMES[kzName] || kzName;
}

// =================================================================
// EXPORTS
// =================================================================

module.exports = {
  KILL_ZONES,
  checkKillZone,
  killZoneDisplayName,
  KZ_DISPLAY_NAMES,
};