import type { LocationRow } from "./types";

export function listLocations(db: D1Database) {
  return db.prepare("SELECT * FROM locations ORDER BY name").all<LocationRow>();
}

export function getLocationBySlug(db: D1Database, slug: string) {
  return db.prepare("SELECT * FROM locations WHERE slug = ?").bind(slug).first<LocationRow>();
}

export function getLocationById(db: D1Database, id: number) {
  return db.prepare("SELECT * FROM locations WHERE id = ?").bind(id).first<LocationRow>();
}

export function addLocation(
  db: D1Database,
  location: { slug: string; name: string; sensorIndex: number; lat: number | null; lon: number | null },
) {
  return db
    .prepare("INSERT INTO locations (slug, name, sensor_index, lat, lon) VALUES (?, ?, ?, ?, ?)")
    .bind(location.slug, location.name, location.sensorIndex, location.lat, location.lon)
    .run();
}

export function updateLocationReading(db: D1Database, locationId: number, aqi: number, level: number) {
  return db
    .prepare("UPDATE locations SET last_aqi = ?, last_level = ?, last_checked_at = datetime('now') WHERE id = ?")
    .bind(aqi, level, locationId)
    .run();
}

export function listSubscriptionsForLocation(db: D1Database, locationId: number) {
  return db.prepare("SELECT chat_id FROM subscriptions WHERE location_id = ?").bind(locationId).all<{ chat_id: number }>();
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
