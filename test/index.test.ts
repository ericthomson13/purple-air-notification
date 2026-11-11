import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLocation, addSubscription, getLocationBySlug, insertReadingHistory } from "../src/db";
import worker, { pollLocations, sendWeeklySubscriberDigest } from "../src/index";
import type { Env } from "../src/types";

function sensorResponse(pm25: number, humidity = 40, temperature = 20) {
  return new Response(
    JSON.stringify({
      sensor: {
        name: "Mock Sensor",
        "pm2.5_cf_1_a": pm25,
        "pm2.5_cf_1_b": pm25,
        humidity,
        temperature,
        last_seen: Math.floor(Date.now() / 1000) - 60,
      },
    }),
    { status: 200 },
  );
}

// Like sensorResponse, but with coordinates - needed for checkAndHealFlatline,
// which searches for peer sensors around the sensor's own lat/lon.
function sensorResponseWithCoords(pm25: number, lat = 40.0, lon = -105.0) {
  return new Response(
    JSON.stringify({
      sensor: {
        name: "Mock Sensor",
        "pm2.5_cf_1_a": pm25,
        "pm2.5_cf_1_b": pm25,
        humidity: 40,
        temperature: 20,
        last_seen: Math.floor(Date.now() / 1000) - 60,
        latitude: lat,
        longitude: lon,
      },
    }),
    { status: 200 },
  );
}

function peerListResponse(peers: Array<{ sensorIndex: number; name: string; lat: number; lon: number; pm25: number }>) {
  const now = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b", "humidity", "temperature"],
      data: peers.map((p) => [p.sensorIndex, p.name, p.lat, p.lon, now, p.pm25, p.pm25, 40, 20]),
    }),
    { status: 200 },
  );
}

async function seedFlatHistory(locationId: number, aqi: number, count: number) {
  for (let i = 0; i < count; i++) {
    await insertReadingHistory(env.DB, locationId, aqi, 1);
  }
}

// Alternating low/high AQI so the range comfortably clears
// ERRATIC_MIN_AQI_RANGE without needing to reverse-engineer exact values.
async function seedErraticHistory(locationId: number, count: number) {
  for (let i = 0; i < count; i++) {
    await insertReadingHistory(env.DB, locationId, i % 2 === 0 ? 10 : 150, 0);
  }
}

function stableHistory(count = 12) {
  return Array.from({ length: count }, () => ({ pm25A: 10, pm25B: 10 }));
}

function peerHistoryResponse(rows: Array<{ pm25A: number; pm25B: number }>) {
  const now = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      fields: ["time_stamp", "humidity", "temperature", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
      data: rows.map((r, i) => [now - i * 600, 40, 20, r.pm25A, r.pm25B]),
    }),
    { status: 200 },
  );
}

function telegramSends(fn: ReturnType<typeof vi.fn>): Array<{ chatId: number; text: string }> {
  return fn.mock.calls
    .filter((call: any[]) => String(typeof call[0] === "string" ? call[0] : call[0].url ?? call[0]).includes("api.telegram.org"))
    .map((call: any[]) => JSON.parse(call[1].body as string))
    .map((body) => ({ chatId: body.chat_id, text: body.text }));
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    PURPLEAIR_API_KEY: "test-key",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    ADMIN_TOKEN: "test-admin-token",
    TELEGRAM_BOT_USERNAME: "TestBot",
    ...overrides,
  };
}

let nextSensorIndex = 1;

async function makeLocation(slug: string, pm25AtLevel: number, lastLevel: number | null) {
  await addLocation(env.DB, { slug, name: `${slug} name`, sensorIndex: nextSensorIndex++, lat: null, lon: null, addedByChatId: null });
  const location = await getLocationBySlug(env.DB, slug);
  if (!location) throw new Error("failed to create location");
  if (lastLevel !== null) {
    await env.DB.prepare("UPDATE locations SET last_aqi = ?, last_level = ?, last_checked_at = datetime('now') WHERE id = ?")
      .bind(pm25AtLevel, lastLevel, location.id)
      .run();
  }
  return (await getLocationBySlug(env.DB, slug))!;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetch handler", () => {
  it("GET /health returns ok", async () => {
    const request = new Request("https://example.com/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv());
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("unknown routes return 404", async () => {
    const request = new Request("https://example.com/nope");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv());
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  describe("POST /webhook/telegram", () => {
    it("rejects requests without the correct webhook secret", async () => {
      const request = new Request("https://example.com/webhook/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
        body: JSON.stringify({ update_id: 1 }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(403);
    });

    it("accepts requests with the correct secret and processes the update", async () => {
      const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fn);

      const request = new Request("https://example.com/webhook/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
        body: JSON.stringify({ update_id: 1, message: { chat: { id: 42 }, text: "/start" } }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(telegramSends(fn).some((s) => s.chatId === 42 && s.text.includes("Welcome"))).toBe(true);
    });

    it("returns 400 (not an unhandled exception) for malformed JSON", async () => {
      const request = new Request("https://example.com/webhook/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
        body: "{not json",
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(400);
    });

    // Telegram sends more update types than just new messages (edited
    // messages, callback queries, etc.) - handleTelegramUpdate only cares
    // about message.text, so these should be silently accepted, not crash.
    it("accepts non-message updates (e.g. edited_message) without sending anything", async () => {
      const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fn);

      const request = new Request("https://example.com/webhook/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
        body: JSON.stringify({ update_id: 2, edited_message: { chat: { id: 42 }, text: "/start" } }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(telegramSends(fn)).toHaveLength(0);
    });
  });

  describe("POST /admin/locations", () => {
    it("rejects requests without the correct admin token", async () => {
      const request = new Request("https://example.com/admin/locations", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({ slug: "x-co", name: "X", sensorIndex: 1 }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(403);
    });

    it("rejects an incomplete body", async () => {
      const request = new Request("https://example.com/admin/locations", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
        body: JSON.stringify({ slug: "incomplete-co" }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(400);
    });

    it("returns 400 (not an unhandled exception) for malformed JSON", async () => {
      const request = new Request("https://example.com/admin/locations", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
        body: "{not json",
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(400);
    });

    it("normalizes the slug to lowercase, matching the self-service /addlocation path", async () => {
      const request = new Request("https://example.com/admin/locations", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
        body: JSON.stringify({ slug: "Mixed-Case-CO", name: "Mixed Case, CO", sensorIndex: 888 }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(201);
      expect(await getLocationBySlug(env.DB, "mixed-case-co")).not.toBeNull();
    });

    it("creates a location with no owner when authorized", async () => {
      const request = new Request("https://example.com/admin/locations", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
        body: JSON.stringify({ slug: "admin-created-co", name: "Admin Created, CO", sensorIndex: 777 }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv());
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(201);
      const location = await getLocationBySlug(env.DB, "admin-created-co");
      expect(location?.added_by_chat_id).toBeNull();
      expect(location?.sensor_index).toBe(777);
    });
  });
});

describe("pollLocations", () => {
  // pollLocations iterates every row in `locations`, so leftover rows from
  // other tests (D1 storage isn't reset between `it()` blocks in this file)
  // would get re-polled too and interfere with mocked fetch responses.
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM readings_history"),
      env.DB.prepare("DELETE FROM subscriptions"),
      env.DB.prepare("DELETE FROM locations"),
    ]);
  });

  it("fires a threshold-crossing alert to every subscriber when AQI moves to a new level", async () => {
    // last_level 0 (Good); mock reading computes well into a higher level.
    const location = await makeLocation("poll-alert-co", 40, 0);
    await addSubscription(env.DB, 111, location.id);
    await addSubscription(env.DB, 222, location.id);

    const fn = vi.fn().mockImplementation(async () => sensorResponse(120)); // high PM2.5 -> AQI well above 100
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv());

    const sends = telegramSends(fn);
    expect(sends).toHaveLength(2);
    expect(sends.map((s) => s.chatId).sort()).toEqual([111, 222]);
    expect(sends[0].text).toContain("risen above");
    expect(sends[0].text).toContain("Category:");

    const updated = await getLocationBySlug(env.DB, "poll-alert-co");
    expect(updated?.last_level).toBeGreaterThan(0);
  });

  it("does not send an alert on the very first poll (no prior level to compare against)", async () => {
    const location = await makeLocation("poll-first-co", 0, null);
    await addSubscription(env.DB, 333, location.id);

    const fn = vi.fn().mockImplementation(async () => sensorResponse(10));
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv());

    expect(telegramSends(fn)).toHaveLength(0);
    const updated = await getLocationBySlug(env.DB, "poll-first-co");
    expect(updated?.last_level).not.toBeNull(); // still records the reading
  });

  it("does not send an alert when the level is unchanged", async () => {
    const location = await makeLocation("poll-unchanged-co", 5, 0);
    await addSubscription(env.DB, 444, location.id);

    const fn = vi.fn().mockImplementation(async () => sensorResponse(5)); // stays in the Good range
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv());

    expect(telegramSends(fn)).toHaveLength(0);
  });

  // Raw PM2.5 inputs (humidity=0, temperature=0) that land exactly on AQI
  // 99/100/101 - the values from test/aqi.test.ts's boundary table. Confirms
  // pollLocations fires (or correctly doesn't) at the precise edge of a
  // threshold, not just for an arbitrary jump into a different range.
  const PM25_FOR_AQI_99 = 57.23;
  const PM25_FOR_AQI_100 = 58.23;
  const PM25_FOR_AQI_101 = 58.72;

  it("fires when AQI drops from 101 to 99, crossing down through the 100 threshold", async () => {
    const location = await makeLocation("poll-boundary-101-99-co", 101, 2); // 2 = Unhealthy for Sensitive Groups
    await addSubscription(env.DB, 601, location.id);
    const fn = vi.fn().mockImplementation(async () => sensorResponse(PM25_FOR_AQI_99, 0, 0));
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv());

    const sends = telegramSends(fn);
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain("dropped below <b>100</b>");
    expect((await getLocationBySlug(env.DB, "poll-boundary-101-99-co"))?.last_aqi).toBe(99);
  });

  it("fires when AQI drops from 101 to exactly 100, crossing down through the 100 threshold", async () => {
    const location = await makeLocation("poll-boundary-101-100-co", 101, 2);
    await addSubscription(env.DB, 602, location.id);
    const fn = vi.fn().mockImplementation(async () => sensorResponse(PM25_FOR_AQI_100, 0, 0));
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv());

    const sends = telegramSends(fn);
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain("dropped below <b>100</b>");
    expect((await getLocationBySlug(env.DB, "poll-boundary-101-100-co"))?.last_aqi).toBe(100);
  });

  it("fires when AQI rises from 100 to 101, crossing up through the 100 threshold", async () => {
    const location = await makeLocation("poll-boundary-100-101-co", 100, 1); // 1 = Moderate
    await addSubscription(env.DB, 603, location.id);
    const fn = vi.fn().mockImplementation(async () => sensorResponse(PM25_FOR_AQI_101, 0, 0));
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv());

    const sends = telegramSends(fn);
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain("risen above <b>100</b>");
  });

  it("does not fire moving from 99 to 100 - both are still Moderate", async () => {
    const location = await makeLocation("poll-boundary-99-100-co", 99, 1);
    await addSubscription(env.DB, 604, location.id);
    const fn = vi.fn().mockImplementation(async () => sensorResponse(PM25_FOR_AQI_100, 0, 0));
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv());

    expect(telegramSends(fn)).toHaveLength(0);
    expect((await getLocationBySlug(env.DB, "poll-boundary-99-100-co"))?.last_aqi).toBe(100);
  });

  it("keeps polling other locations if one location's fetch fails", async () => {
    const failing = await makeLocation("poll-fail-co", 0, 0);
    const healthy = await makeLocation("poll-healthy-co", 0, 0);
    await addSubscription(env.DB, 555, healthy.id);

    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes(`/v1/sensors/${failing.sensor_index}`)) {
        return new Response("server error", { status: 500 });
      }
      return sensorResponse(120); // pushes healthy's location into a new level
    });
    vi.stubGlobal("fetch", fn);

    await expect(pollLocations(testEnv())).resolves.not.toThrow();

    expect(telegramSends(fn).some((s) => s.chatId === 555)).toBe(true);
    // the failing location's reading should not have been updated
    const failedLocation = await getLocationBySlug(env.DB, "poll-fail-co");
    expect(failedLocation?.last_level).toBe(0);
  });

  // Regression coverage for a real incident: a Leadville, CO sensor kept
  // reporting on schedule (so it never went stale) while its AQI barely
  // moved for an entire day, and other Leadville sensors nearby showed
  // normal variation - the scheduled poll should catch and self-heal this
  // automatically, the same way it already does for diverging A/B channels.
  // Successful auto-heals are deliberately silent (no admin DM) - routine
  // self-maintenance shouldn't page the operator, especially when swapping
  // between nearby/co-located sensors (see notifyAdmin call sites in
  // src/index.ts and src/commands.ts). Only a confirmed-bad sensor with no
  // healthy replacement anywhere nearby is worth a DM - see the
  // SensorDivergenceError test below.
  it("auto-heals a flatlined sensor silently - no admin DM, but the swap still happens", async () => {
    const location = await makeLocation("poll-flatline-co", 57, 1);
    await seedFlatHistory(location.id, 57, 11); // + this poll's own insert reaches the 12-row minimum

    const fn = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes(`/v1/sensors/${location.sensor_index}?`)) return sensorResponseWithCoords(20); // pm25 20 -> AQI ~57, matches seeded history
      if (url.includes("/v1/sensors?")) {
        return peerListResponse([
          { sensorIndex: 900, name: "Peer A", lat: 40.001, lon: -105.001, pm25: 200 },
          { sensorIndex: 901, name: "Peer B", lat: 40.002, lon: -105.002, pm25: 200 },
          { sensorIndex: 902, name: "Peer C", lat: 40.003, lon: -105.003, pm25: 200 },
        ]);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv({ ADMIN_CHAT_ID: "777" }));

    expect(telegramSends(fn)).toHaveLength(0);

    const updated = await getLocationBySlug(env.DB, "poll-flatline-co");
    expect(updated?.sensor_index).toBe(900);
  });

  it("does not run the flatline check in a poll cycle where divergence self-heal already swapped the sensor", async () => {
    const location = await makeLocation("poll-noflatline-after-swap-co", 0, 0);

    const fn = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes(`/v1/sensors/${location.sensor_index}?`)) {
        return new Response(
          JSON.stringify({
            sensor: {
              name: "Diverging",
              "pm2.5_cf_1_a": 4593,
              "pm2.5_cf_1_b": 3,
              humidity: 40,
              temperature: 20,
              last_seen: Math.floor(Date.now() / 1000) - 60,
              latitude: 40.0,
              longitude: -105.0,
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/sensors/900?")) return sensorResponseWithCoords(10);
      if (url.includes("/v1/sensors?")) {
        return new Response(
          JSON.stringify({
            fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
            data: [[900, "Replacement", 40.001, -105.001, Math.floor(Date.now() / 1000), 10, 12]],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv());

    const listSearchCalls = fn.mock.calls.filter((call: any[]) => {
      const url = typeof call[0] === "string" ? call[0] : (call[0] as any).url ?? call[0];
      return String(url).includes("/v1/sensors?");
    });
    expect(listSearchCalls).toHaveLength(1); // only the divergence replacement search - never a separate peer search

    const updated = await getLocationBySlug(env.DB, "poll-noflatline-after-swap-co");
    expect(updated?.sensor_index).toBe(900);
  });

  it("keeps polling other locations if the flatline check itself throws", async () => {
    const flatlineFailing = await makeLocation("poll-flatline-throws-co", 57, 1);
    await seedFlatHistory(flatlineFailing.id, 57, 11);
    const healthy = await makeLocation("poll-flatline-other-healthy-co", 0, 0);
    await addSubscription(env.DB, 999, healthy.id);

    const fn = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes(`/v1/sensors/${flatlineFailing.sensor_index}?`)) return sensorResponseWithCoords(20);
      if (url.includes(`/v1/sensors/${healthy.sensor_index}?`)) return sensorResponse(120); // pushes healthy's location into a new level
      if (url.includes("/v1/sensors?")) return new Response("boom", { status: 500 }); // peer search for flatlineFailing fails
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);

    await expect(pollLocations(testEnv())).resolves.not.toThrow();

    expect(telegramSends(fn).some((s) => s.chatId === 999)).toBe(true);
  });

  // Regression coverage for a real incident: a Leadville, CO sensor swung
  // between AQI ~1 and 100+ on a ~24h cycle while sensors a few meters away
  // stayed calm the whole time - the flatline check alone misses this since
  // it only fires when a sensor's own history is suspiciously flat, not wild.
  it("auto-heals an erratic sensor silently - no admin DM, but the swap still happens", async () => {
    const location = await makeLocation("poll-erratic-co", 57, 1);
    await seedErraticHistory(location.id, 11); // + this poll's own insert reaches the 12-row minimum

    const fn = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes(`/v1/sensors/${location.sensor_index}?`)) return sensorResponseWithCoords(20);
      const historyMatch = url.match(/\/sensors\/(\d+)\/history\?/);
      if (historyMatch) return peerHistoryResponse(stableHistory());
      if (url.includes("/v1/sensors?")) {
        return peerListResponse([
          { sensorIndex: 900, name: "Peer A", lat: 40.001, lon: -105.001, pm25: 10 },
          { sensorIndex: 901, name: "Peer B", lat: 40.002, lon: -105.002, pm25: 10 },
          { sensorIndex: 902, name: "Peer C", lat: 40.003, lon: -105.003, pm25: 10 },
        ]);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv({ ADMIN_CHAT_ID: "777" }));

    expect(telegramSends(fn)).toHaveLength(0);

    const updated = await getLocationBySlug(env.DB, "poll-erratic-co");
    expect(updated?.sensor_index).toBe(900);
  });

  // The one poll-time case that IS worth paging the operator for: a
  // confirmed-bad sensor (diverging A/B channels) with no healthy
  // replacement found anywhere nearby - nothing automatic can fix this.
  it("DMs the admin when a sensor is confirmed bad but no healthy replacement is found nearby", async () => {
    const location = await makeLocation("poll-divergence-none-co", 0, 0);
    const other = await makeLocation("poll-divergence-none-other-co", 0, 0);
    await addSubscription(env.DB, 999, other.id);

    const fn = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes(`/v1/sensors/${location.sensor_index}?`)) {
        return new Response(
          JSON.stringify({
            sensor: {
              name: "Diverging",
              "pm2.5_cf_1_a": 4593,
              "pm2.5_cf_1_b": 3,
              humidity: 40,
              temperature: 20,
              last_seen: Math.floor(Date.now() / 1000) - 60,
              latitude: 40.0,
              longitude: -105.0,
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/v1/sensors/${other.sensor_index}?`)) return sensorResponse(120); // pushes other's location into a new level
      if (url.includes("/v1/sensors?")) {
        return new Response(JSON.stringify({ fields: ["sensor_index", "name", "latitude", "longitude", "last_seen"], data: [] }), { status: 200 }); // no replacement found
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);

    await pollLocations(testEnv({ ADMIN_CHAT_ID: "777" }));

    const sends = telegramSends(fn);
    expect(sends.some((s) => s.chatId === 777 && s.text.includes("poll-divergence-none-co") && s.text.includes("no healthy sensor"))).toBe(true);
    // the other location should still poll normally despite the first one failing
    expect(sends.some((s) => s.chatId === 999)).toBe(true);

    const updated = await getLocationBySlug(env.DB, "poll-divergence-none-co");
    expect(updated?.sensor_index).toBe(location.sensor_index); // left alone
  });
});

describe("sendWeeklySubscriberDigest", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM subscriptions"), env.DB.prepare("DELETE FROM locations")]);
  });

  it("DMs ADMIN_CHAT_ID with subscription/location/user/country counts as a table", async () => {
    const a = await makeLocation("digest-a-co", 0, 0); // US
    const b = await makeLocation("digest-b-on", 0, 0); // Canada
    await addSubscription(env.DB, 701, a.id);
    await addSubscription(env.DB, 701, b.id); // same user, two locations
    await addSubscription(env.DB, 702, a.id);

    const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fn);

    await sendWeeklySubscriberDigest(testEnv({ ADMIN_CHAT_ID: "999" }));

    const sends = telegramSends(fn);
    expect(sends).toHaveLength(1);
    expect(sends[0].chatId).toBe(999);
    expect(sends[0].text).toBe("📊 Weekly update\n\nusers: 2\nsubscriptions: 3\nlocations: 2\ncountries: 2");
  });

  it("does nothing when ADMIN_CHAT_ID isn't set", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);

    await sendWeeklySubscriberDigest(testEnv());

    expect(fn).not.toHaveBeenCalled();
  });
});

describe("scheduled() cron branching", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM subscriptions"), env.DB.prepare("DELETE FROM locations")]);
  });

  it("runs the weekly digest (not the AQI poll) on the digest cron", async () => {
    await makeLocation("cron-digest-co", 0, 0);
    const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fn);

    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "0 15 * * 3" } as ScheduledController, testEnv({ ADMIN_CHAT_ID: "999" }), ctx);
    await waitOnExecutionContext(ctx);

    // Only the digest DM should have gone out - no PurpleAir fetch for the poll.
    expect(fn.mock.calls.every(([input]: any[]) => String(typeof input === "string" ? input : input.url ?? input).includes("api.telegram.org"))).toBe(true);
    expect(telegramSends(fn).some((s) => s.text.includes("subscriptions:"))).toBe(true);
  });

  it("runs the AQI poll (not the digest) on any other cron", async () => {
    const location = await makeLocation("cron-poll-co", 40, 0);
    await addSubscription(env.DB, 801, location.id);
    const fn = vi.fn().mockImplementation(async () => sensorResponse(120));
    vi.stubGlobal("fetch", fn);

    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "*/10 * * * *" } as ScheduledController, testEnv({ ADMIN_CHAT_ID: "999" }), ctx);
    await waitOnExecutionContext(ctx);

    expect(telegramSends(fn).some((s) => s.text.includes("risen above"))).toBe(true);
    expect(telegramSends(fn).some((s) => s.text.includes("subscriptions:"))).toBe(false);
  });
});
