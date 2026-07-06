import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLocation, addSubscription, getLocationBySlug } from "../src/db";
import worker, { pollLocations, sendDailySubscriberDigest } from "../src/index";
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
});

describe("sendDailySubscriberDigest", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM subscriptions"), env.DB.prepare("DELETE FROM locations")]);
  });

  it("DMs ADMIN_CHAT_ID with subscription/location/user counts", async () => {
    const a = await makeLocation("digest-a-co", 0, 0);
    const b = await makeLocation("digest-b-co", 0, 0);
    await addSubscription(env.DB, 701, a.id);
    await addSubscription(env.DB, 701, b.id); // same user, two locations
    await addSubscription(env.DB, 702, a.id);

    const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fn);

    await sendDailySubscriberDigest(testEnv({ ADMIN_CHAT_ID: "999" }));

    const sends = telegramSends(fn);
    expect(sends).toHaveLength(1);
    expect(sends[0].chatId).toBe(999);
    expect(sends[0].text).toContain("3 subscription(s)");
    expect(sends[0].text).toContain("2 location(s)");
    expect(sends[0].text).toContain("2 unique user(s)");
  });

  it("does nothing when ADMIN_CHAT_ID isn't set", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);

    await sendDailySubscriberDigest(testEnv());

    expect(fn).not.toHaveBeenCalled();
  });
});

describe("scheduled() cron branching", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM subscriptions"), env.DB.prepare("DELETE FROM locations")]);
  });

  it("runs the daily digest (not the AQI poll) on the digest cron", async () => {
    await makeLocation("cron-digest-co", 0, 0);
    const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fn);

    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "0 15 * * 1-5" } as ScheduledController, testEnv({ ADMIN_CHAT_ID: "999" }), ctx);
    await waitOnExecutionContext(ctx);

    // Only the digest DM should have gone out - no PurpleAir fetch for the poll.
    expect(fn.mock.calls.every(([input]: any[]) => String(typeof input === "string" ? input : input.url ?? input).includes("api.telegram.org"))).toBe(true);
    expect(telegramSends(fn).some((s) => s.text.includes("subscription(s)"))).toBe(true);
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
    expect(telegramSends(fn).some((s) => s.text.includes("subscription(s)"))).toBe(false);
  });
});
