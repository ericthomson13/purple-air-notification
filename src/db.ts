import type { LocationRow, PastReading } from "./types";

export function listLocations(db: D1Database) {
  return db.prepare("SELECT * FROM locations ORDER BY name").all<LocationRow>();
}

export async function countLocations(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as count FROM locations").first<{ count: number }>();
  return row?.count ?? 0;
}

export function getLocationBySlug(db: D1Database, slug: string) {
  return db.prepare("SELECT * FROM locations WHERE slug = ?").bind(slug).first<LocationRow>();
}

export function getLocationById(db: D1Database, id: number) {
  return db.prepare("SELECT * FROM locations WHERE id = ?").bind(id).first<LocationRow>();
}

export function addLocation(
  db: D1Database,
  location: {
    slug: string;
    name: string;
    sensorIndex: number;
    lat: number | null;
    lon: number | null;
    addedByChatId: number | null;
  },
) {
  return db
    .prepare("INSERT INTO locations (slug, name, sensor_index, lat, lon, added_by_chat_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(location.slug, location.name, location.sensorIndex, location.lat, location.lon, location.addedByChatId)
    .run();
}

// Explicit cascade rather than relying on the schema's ON DELETE CASCADE -
// D1/SQLite doesn't enforce foreign keys unless PRAGMA foreign_keys is on,
// so this can't be assumed to fire on its own.
export function deleteLocation(db: D1Database, locationId: number) {
  return db.batch([
    db.prepare("DELETE FROM readings_history WHERE location_id = ?").bind(locationId),
    db.prepare("DELETE FROM subscriptions WHERE location_id = ?").bind(locationId),
    db.prepare("DELETE FROM locations WHERE id = ?").bind(locationId),
  ]);
}

export function updateLocationReading(db: D1Database, locationId: number, aqi: number, level: number) {
  return db
    .prepare("UPDATE locations SET last_aqi = ?, last_level = ?, last_checked_at = datetime('now') WHERE id = ?")
    .bind(aqi, level, locationId)
    .run();
}

export function insertReadingHistory(db: D1Database, locationId: number, aqi: number, level: number) {
  return db
    .prepare("INSERT INTO readings_history (location_id, aqi, level) VALUES (?, ?, ?)")
    .bind(locationId, aqi, level)
    .run();
}

// Most recent reading at least `minutesAgo` old, for "was X ~Nm ago" context.
export function getPastReading(db: D1Database, locationId: number, minutesAgo: number) {
  return db
    .prepare(
      `SELECT aqi, checked_at FROM readings_history
       WHERE location_id = ? AND checked_at <= datetime('now', ?)
       ORDER BY checked_at DESC LIMIT 1`,
    )
    .bind(locationId, `-${minutesAgo} minutes`)
    .first<PastReading>();
}

export function purgeOldReadings(db: D1Database) {
  return db.prepare("DELETE FROM readings_history WHERE checked_at < datetime('now', '-1 day')").run();
}

export function listSubscriptionsForLocation(db: D1Database, locationId: number) {
  return db.prepare("SELECT chat_id FROM subscriptions WHERE location_id = ?").bind(locationId).all<{ chat_id: number }>();
}

export async function countSubscriptionsForLocation(db: D1Database, locationId: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as count FROM subscriptions WHERE location_id = ?").bind(locationId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countAllSubscriptions(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as count FROM subscriptions").first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countDistinctSubscribers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(DISTINCT chat_id) as count FROM subscriptions").first<{ count: number }>();
  return row?.count ?? 0;
}

export function listSubscriptionsForChat(db: D1Database, chatId: number) {
  return db
    .prepare(
      `SELECT l.slug, l.name FROM subscriptions s
       JOIN locations l ON l.id = s.location_id
       WHERE s.chat_id = ?`,
    )
    .bind(chatId)
    .all<{ slug: string; name: string }>();
}

export function addSubscription(db: D1Database, chatId: number, locationId: number) {
  return db
    .prepare("INSERT OR IGNORE INTO subscriptions (chat_id, location_id) VALUES (?, ?)")
    .bind(chatId, locationId)
    .run();
}

export function removeSubscription(db: D1Database, chatId: number, locationId: number) {
  return db
    .prepare("DELETE FROM subscriptions WHERE chat_id = ? AND location_id = ?")
    .bind(chatId, locationId)
    .run();
}
