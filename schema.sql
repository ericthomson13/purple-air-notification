CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sensor_index INTEGER NOT NULL,
  lat REAL,
  lon REAL,
  last_aqi INTEGER,
  last_level INTEGER,
  last_checked_at TEXT,
  -- Telegram chat_id of whoever ran /addlocation for this row (NULL for
  -- locations registered via the /admin/locations HTTP endpoint, e.g. the
  -- seeded Leadville, CO). Only this chat - or the admin endpoint - may
  -- remove the location via /removelocation.
  added_by_chat_id INTEGER
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, location_id)
);

-- One row per poll per location. Used to report "was X ~30m ago" alongside
-- threshold-crossing alerts. Purged after 1 day (see purgeOldReadings in
-- db.ts) since we only need recent history for trend context, not a
-- long-term archive.
CREATE TABLE IF NOT EXISTS readings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  aqi INTEGER NOT NULL,
  level INTEGER NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_readings_history_location_checked
  ON readings_history(location_id, checked_at);
