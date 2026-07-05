import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  addLocation,
  addSubscription,
  countLocations,
  countSubscriptionsForLocation,
  deleteLocation,
  getLocationBySlug,
  getPastReading,
  insertReadingHistory,
  listLocations,
  listSubscriptionsForChat,
  listSubscriptionsForLocation,
  purgeOldReadings,
  removeSubscription,
  updateLocationReading,
} from "../src/db";

async function makeTestLocation(slug: string, addedByChatId: number | null = null) {
  await addLocation(env.DB, { slug, name: `${slug} name`, sensorIndex: 1, lat: null, lon: null, addedByChatId });
  const location = await getLocationBySlug(env.DB, slug);
  if (!location) throw new Error("failed to create test location");
  return location;
}

describe("locations", () => {
  it("round-trips through addLocation / getLocationBySlug", async () => {
    const location = await makeTestLocation("db-round-trip-co", 111);
    expect(location.slug).toBe("db-round-trip-co");
    expect(location.added_by_chat_id).toBe(111);
  });

  it("counts all registered locations", async () => {
    const before = await countLocations(env.DB);
    await makeTestLocation("db-count-a-co");
    await makeTestLocation("db-count-b-co");
    expect(await countLocations(env.DB)).toBe(before + 2);
  });

  it("updateLocationReading updates aqi/level/last_checked_at in place", async () => {
    const location = await makeTestLocation("db-update-reading-co");
    expect(location.last_aqi).toBeNull();

    await updateLocationReading(env.DB, location.id, 42, 0);
    const updated = await getLocationBySlug(env.DB, "db-update-reading-co");
    expect(updated?.last_aqi).toBe(42);
    expect(updated?.last_level).toBe(0);
    expect(updated?.last_checked_at).not.toBeNull();
  });

  it("listLocations includes newly added locations", async () => {
    await makeTestLocation("db-list-check-co");
    const { results } = await listLocations(env.DB);
    expect(results.some((l) => l.slug === "db-list-check-co")).toBe(true);
  });
});

describe("subscriptions", () => {
  it("addSubscription is idempotent for the same chat+location (no duplicate rows, no error)", async () => {
    const location = await makeTestLocation("db-idempotent-co");
    await addSubscription(env.DB, 555, location.id);
    await addSubscription(env.DB, 555, location.id); // should silently no-op, not throw
    await addSubscription(env.DB, 555, location.id);

    const { results } = await listSubscriptionsForLocation(env.DB, location.id);
    expect(results.length).toBe(1);
  });

  it("a chat can be subscribed to multiple different locations", async () => {
    const a = await makeTestLocation("db-multi-a-co");
    const b = await makeTestLocation("db-multi-b-co");
    await addSubscription(env.DB, 777, a.id);
    await addSubscription(env.DB, 777, b.id);

    const { results } = await listSubscriptionsForChat(env.DB, 777);
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("db-multi-a-co");
    expect(slugs).toContain("db-multi-b-co");
  });

  // Regression test: verifies /unsubscribe can never remove another user's
  // subscription or affect other subscribers of the same location - this
  // was explicitly double-checked after a user report during manual testing.
  it("removeSubscription only removes the requesting chat's own row, leaving other subscribers untouched", async () => {
    const location = await makeTestLocation("db-scoped-unsub-co");
    await addSubscription(env.DB, 1001, location.id);
    await addSubscription(env.DB, 2002, location.id);
    expect(await countSubscriptionsForLocation(env.DB, location.id)).toBe(2);

    await removeSubscription(env.DB, 1001, location.id);

    expect(await countSubscriptionsForLocation(env.DB, location.id)).toBe(1);
    const { results } = await listSubscriptionsForLocation(env.DB, location.id);
    expect(results.map((r) => r.chat_id)).toEqual([2002]);

    // The location itself must still exist - unsubscribing never deletes it.
    expect(await getLocationBySlug(env.DB, "db-scoped-unsub-co")).not.toBeNull();
  });

  it("removeSubscription for a chat with no subscription is a harmless no-op", async () => {
    const location = await makeTestLocation("db-noop-unsub-co");
    await expect(removeSubscription(env.DB, 9999, location.id)).resolves.not.toThrow();
  });
});

describe("deleteLocation", () => {
  it("removes the location and cascades to its subscriptions and reading history", async () => {
    const location = await makeTestLocation("db-delete-cascade-co");
    await addSubscription(env.DB, 42, location.id);
    await insertReadingHistory(env.DB, location.id, 55, 1);

    await deleteLocation(env.DB, location.id);

    expect(await getLocationBySlug(env.DB, "db-delete-cascade-co")).toBeNull();
    expect(await countSubscriptionsForLocation(env.DB, location.id)).toBe(0);
    expect(await getPastReading(env.DB, location.id, 0)).toBeNull();
  });

  it("does not affect other locations' subscriptions", async () => {
    const target = await makeTestLocation("db-delete-target-co");
    const other = await makeTestLocation("db-delete-other-co");
    await addSubscription(env.DB, 42, target.id);
    await addSubscription(env.DB, 42, other.id);

    await deleteLocation(env.DB, target.id);

    expect(await countSubscriptionsForLocation(env.DB, other.id)).toBe(1);
    expect(await getLocationBySlug(env.DB, "db-delete-other-co")).not.toBeNull();
  });
});

describe("readings_history", () => {
  it("getPastReading finds the closest reading at least N minutes old", async () => {
    const location = await makeTestLocation("db-past-reading-co");
    await env.DB.prepare("INSERT INTO readings_history (location_id, aqi, level, checked_at) VALUES (?, ?, ?, datetime('now', '-45 minutes'))")
      .bind(location.id, 150, 2)
      .run();
    await env.DB.prepare("INSERT INTO readings_history (location_id, aqi, level, checked_at) VALUES (?, ?, ?, datetime('now', '-5 minutes'))")
      .bind(location.id, 90, 1)
      .run();

    const past = await getPastReading(env.DB, location.id, 30);
    expect(past?.aqi).toBe(150);
  });

  it("returns null when no reading is old enough", async () => {
    const location = await makeTestLocation("db-past-reading-none-co");
    await insertReadingHistory(env.DB, location.id, 42, 0);

    const past = await getPastReading(env.DB, location.id, 30);
    expect(past ?? null).toBeNull();
  });

  it("purgeOldReadings deletes only rows older than 1 day", async () => {
    const location = await makeTestLocation("db-purge-co");
    await env.DB.prepare("INSERT INTO readings_history (location_id, aqi, level, checked_at) VALUES (?, ?, ?, datetime('now', '-2 days'))")
      .bind(location.id, 42, 0)
      .run();
    await insertReadingHistory(env.DB, location.id, 55, 1); // fresh, checked_at = now

    await purgeOldReadings(env.DB);

    const remaining = await env.DB.prepare("SELECT COUNT(*) as count FROM readings_history WHERE location_id = ?").bind(location.id).first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });
});
