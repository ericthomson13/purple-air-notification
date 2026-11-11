# Changelog

All notable changes to this project are documented here, most recent first.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions correspond to `package.json`'s version, bumped via `npm version`
(see "Versioning & deploy notifications" in the README).

## [0.2.1] - 2026-07-29

### Changed

- Successful automatic sensor self-heals (from the scheduled poll or from
  `/reportissue`) no longer DM `ADMIN_CHAT_ID` - routine swapping, especially
  between nearby/co-located sensors (e.g. Leadville's cluster, all a few
  meters apart), doesn't need a human's attention. `ADMIN_CHAT_ID` now only
  gets DM'd when a sensor is confirmed bad and nothing nearby can replace it
  - previously this exact case (a diverging sensor with no healthy
  replacement found during the scheduled poll) was silently logged
  server-side only and never reached the operator at all.

## [0.2.0] - 2026-07-29

### Added

- Automatic detection of a "flatlined" sensor: a sensor can keep reporting on
  schedule (so it never looks stale) while its AQI value has effectively
  stopped moving for hours - a real incident that motivated this release.
  The scheduled poll now checks recent history for this and, if nearby
  healthy sensors confirm it's not just a genuinely calm/stable day, swaps
  the location to a healthy one automatically - the same way it already
  self-heals sensors with disagreeing A/B channels.
- Automatic detection of the inverse failure mode: a sensor whose own AQI
  swings wildly while sensors a few meters away stay calm - a second real
  incident with the same Leadville, CO sensor, found by pulling its actual
  PurpleAir history. Confirmation pulls nearby sensors' own history over the
  same window (not just a live snapshot, which an erratic sensor could pass
  or fail depending on the exact moment it's checked) before swapping.
- `/reportissue <slug>` - any subscriber can flag a location's sensor
  themselves. The bot re-checks it immediately (all of the above) and either
  fixes it on the spot (and says so) or logs it for the operator to look
  into - no code or database changes needed per report.

## [0.1.0]

Initial release: threshold-crossing AQI alerts via Telegram, self-service
`/subscribe`/`/addlocation`/`/unsubscribe`, automatic nearest-sensor
discovery, and self-healing for sensors with disagreeing A/B channels.
