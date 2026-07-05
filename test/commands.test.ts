import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTelegramUpdate } from "../src/commands";
import { addLocation, addSubscription, countSubscriptionsForLocation, getLocationBySlug } from "../src/db";
import type { Env } from "../src/types";

function sensorResponse(overrides: Partial<{ pm25: number; lastSeenSecondsAgo: number }> = {}) {
  const { pm25 = 10, lastSeenSecondsAgo = 60 } = overrides;
  return new Response(
    JSON.stringify({
      sensor: {
        name: "Mock Sensor",
        "pm2.5_cf_1_a": pm25,
        "pm2.5_cf_1_b": pm25,
        humidity: 40,
        temperature: 20,
        last_seen: Math.floor(Date.now() / 1000) - lastSeenSecondsAgo,
      },
    }),
    { status: 200 },
  );
}

function sensorsListResponse(rows: Array<[number, string, number, number]> = [[999, "Mock Sensor", 40.0, -105.0]]) {
  const now = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      fields: ["sensor_index", "name", "latitude", "longitude", "last_seen"],
      data: rows.map(([idx, name, lat, lon]) => [idx, name, lat, lon, now - 60]),
    }),
    { status: 200 },
  );
}

function nominatimResponse(found = true) {
  return new Response(JSON.stringify(found ? [{ lat: "40.0149856", lon: "-105.270545" }] : []), { status: 200 });
}

interface MockFetchOverrides {
  purpleAirSensor?: () => Response;
  purpleAirSensorsList?: () => Response;
  nominatim?: () => Response;
}

function installMockFetch(overrides: MockFetchOverrides = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push(url);

    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (url.includes("nominatim.openstreetmap.org")) {
      return overrides.nominatim ? overrides.nominatim() : nominatimResponse();
    }
    if (url.includes("api.purpleair.com/v1/sensors?")) {
      return overrides.purpleAirSensorsList ? overrides.purpleAirSensorsList() : sensorsListResponse();
    }
    if (url.includes("api.purpleair.com/v1/sensors/")) {
      return overrides.purpleAirSensor ? overrides.purpleAirSensor() : sensorResponse();
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function telegramMessagesTo(fn: ReturnType<typeof vi.fn>, chatId: number): string[] {
  return fn.mock.calls
    .filter((call: any[]) => String(typeof call[0] === "string" ? call[0] : call[0].url ?? call[0]).includes("api.telegram.org"))
    .map((call: any[]) => JSON.parse(call[1].body as string))
    .filter((body) => body.chat_id === chatId)
    .map((body) => body.text as string);
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    PURPLEAIR_API_KEY: "test-key",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
    ADMIN_TOKEN: "test-admin",
    TELEGRAM_BOT_USERNAME: "TestBot",
    ...overrides,
  };
}

function updateFor(chatId: number, text: string) {
  return { update_id: 1, message: { chat: { id: chatId }, text } };
}

async function makeLocation(slug: string, addedByChatId: number | null = null) {
  await addLocation(env.DB, { slug, name: `${slug} name`, sensorIndex: 123, lat: null, lon: null, addedByChatId });
  const location = await getLocationBySlug(env.DB, slug);
  if (!location) throw new Error("failed to create location");
  return location;
}

afterEach(() => vi.unstubAllGlobals());

describe("/start and unknown commands", () => {
  it("/start sends the welcome message", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/start"), testEnv());
    expect(telegramMessagesTo(fn, 1)[0]).toContain("Welcome");
  });

  it("an unrecognized command falls back to the welcome message", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/whatever"), testEnv());
    expect(telegramMessagesTo(fn, 1)[0]).toContain("Welcome");
  });
});

describe("/subscribe", () => {
  it("rejects an unknown location", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/subscribe cmd-nope-co"), testEnv());
    expect(telegramMessagesTo(fn, 1)[0]).toContain("Unknown location");
  });

  it("subscribes to an existing location and reports current AQI", async () => {
    await makeLocation("cmd-subscribe-co");
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(2, "/subscribe cmd-subscribe-co"), testEnv());

    const text = telegramMessagesTo(fn, 2)[0];
    expect(text).toContain("Thanks for signing up");
    expect(text).toContain("Current AQI for cmd-subscribe-co name");
    expect(text).toContain("t.me/TestBot");

    const location = await getLocationBySlug(env.DB, "cmd-subscribe-co");
    expect(await countSubscriptionsForLocation(env.DB, location!.id)).toBe(1);
  });

  it("subscribing twice does not error or duplicate", async () => {
    await makeLocation("cmd-subscribe-twice-co");
    installMockFetch();

    await handleTelegramUpdate(updateFor(3, "/subscribe cmd-subscribe-twice-co"), testEnv());
    await handleTelegramUpdate(updateFor(3, "/subscribe cmd-subscribe-twice-co"), testEnv());

    const location = await getLocationBySlug(env.DB, "cmd-subscribe-twice-co");
    expect(await countSubscriptionsForLocation(env.DB, location!.id)).toBe(1);
  });
});

describe("/addlocation", () => {
  it("shows usage when no slug is given", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/addlocation"), testEnv());
    expect(telegramMessagesTo(fn, 1)[0]).toContain("Usage");
  });

  it("rejects a malformed slug", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/addlocation NotASlug"), testEnv());
    expect(telegramMessagesTo(fn, 1)[0]).toContain("city-state format");
  });

  it("auto-discovery: geocodes, finds the nearest sensor, creates and subscribes", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(10, "/addlocation auto-boulder-co"), testEnv());

    const text = telegramMessagesTo(fn, 10)[0];
    expect(text).toContain("Added Auto Boulder, CO");
    expect(text).toContain('using PurpleAir sensor "Mock Sensor"');

    const location = await getLocationBySlug(env.DB, "auto-boulder-co");
    expect(location?.added_by_chat_id).toBe(10);
    expect(location?.sensor_index).toBe(999);
    expect(await countSubscriptionsForLocation(env.DB, location!.id)).toBe(1);
  });

  it("auto-discovery: reports when geocoding finds nothing, without creating a location", async () => {
    const { fn } = installMockFetch({ nominatim: () => nominatimResponse(false) });
    await handleTelegramUpdate(updateFor(11, "/addlocation cmd-nowhere-zz"), testEnv());

    expect(telegramMessagesTo(fn, 11)[0]).toContain("Couldn't find");
    expect(await getLocationBySlug(env.DB, "cmd-nowhere-zz")).toBeNull();
  });

  it("auto-discovery: reports when no active sensor is nearby, without creating a location", async () => {
    const { fn } = installMockFetch({ purpleAirSensorsList: () => sensorsListResponse([]) });
    await handleTelegramUpdate(updateFor(12, "/addlocation cmd-empty-co"), testEnv());

    expect(telegramMessagesTo(fn, 12)[0]).toContain("no active PurpleAir sensors nearby");
    expect(await getLocationBySlug(env.DB, "cmd-empty-co")).toBeNull();
  });

  it("manual fallback: slug + sensor_index + name creates and subscribes without geocoding", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(13, "/addlocation cmd-manual-co 555 Manual, CO"), testEnv());

    const text = telegramMessagesTo(fn, 13)[0];
    expect(text).toContain("Added Manual, CO");
    expect(text).not.toContain("using PurpleAir sensor"); // no discoveredSensorName in manual mode

    const location = await getLocationBySlug(env.DB, "cmd-manual-co");
    expect(location?.sensor_index).toBe(555);
    expect(location?.name).toBe("Manual, CO");
  });

  it("resubscribes instead of erroring when the slug already exists", async () => {
    const owner = await makeLocation("cmd-existing-co", 999);
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(14, "/addlocation cmd-existing-co"), testEnv());

    expect(telegramMessagesTo(fn, 14)[0]).toContain("already tracked");
    expect(await countSubscriptionsForLocation(env.DB, owner.id)).toBe(1);
    // ownership unchanged - the new subscriber didn't become the "owner"
    expect((await getLocationBySlug(env.DB, "cmd-existing-co"))?.added_by_chat_id).toBe(999);
  });

  it("rejects new locations once MAX_LOCATIONS is reached", async () => {
    for (let i = 0; i < 50; i++) {
      await addLocation(env.DB, { slug: `cmd-cap-filler-${i}-co`, name: `Filler ${i}`, sensorIndex: i + 1, lat: null, lon: null, addedByChatId: null });
    }
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(15, "/addlocation cmd-over-cap-co"), testEnv());

    expect(telegramMessagesTo(fn, 15)[0]).toContain("location limit");
    expect(await getLocationBySlug(env.DB, "cmd-over-cap-co")).toBeNull();
  });
});

describe("/removelocation", () => {
  it("requires a slug", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/removelocation"), testEnv());
    expect(telegramMessagesTo(fn, 1)[0]).toContain("Usage");
  });

  it("rejects removal by a chat that isn't the owner", async () => {
    await makeLocation("cmd-remove-notowner-co", 42);
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(43, "/removelocation cmd-remove-notowner-co"), testEnv());

    expect(telegramMessagesTo(fn, 43)[0]).toContain("Only whoever added");
    expect(await getLocationBySlug(env.DB, "cmd-remove-notowner-co")).not.toBeNull();
  });

  it("rejects removal of an admin-added (null owner) location", async () => {
    await makeLocation("cmd-remove-admin-co", null);
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(1, "/removelocation cmd-remove-admin-co"), testEnv());

    expect(telegramMessagesTo(fn, 1)[0]).toContain("bot operator");
  });

  it("lets the owner remove their own location, warning about other subscribers", async () => {
    const location = await makeLocation("cmd-remove-owner-co", 77);
    await addSubscription(env.DB, 77, location.id);
    await addSubscription(env.DB, 88, location.id);
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(77, "/removelocation cmd-remove-owner-co"), testEnv());

    const text = telegramMessagesTo(fn, 77)[0];
    expect(text).toContain("Removed");
    expect(text).toContain("1 other subscriber");
    expect(await getLocationBySlug(env.DB, "cmd-remove-owner-co")).toBeNull();
  });
});

describe("/unsubscribe", () => {
  it("removes only the requesting chat's subscription", async () => {
    const location = await makeLocation("cmd-unsub-co");
    await addSubscription(env.DB, 501, location.id);
    await addSubscription(env.DB, 502, location.id);
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(501, "/unsubscribe cmd-unsub-co"), testEnv());

    expect(telegramMessagesTo(fn, 501)[0]).toContain("Unsubscribed");
    expect(await countSubscriptionsForLocation(env.DB, location.id)).toBe(1);
    expect(await getLocationBySlug(env.DB, "cmd-unsub-co")).not.toBeNull();
  });
});

describe("/status", () => {
  it("tells an unsubscribed chat there's nothing to show", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(600, "/status"), testEnv());
    expect(telegramMessagesTo(fn, 600)[0]).toContain("aren't subscribed");
  });

  it("shows every location a chat is subscribed to", async () => {
    const a = await makeLocation("cmd-status-a-co");
    const b = await makeLocation("cmd-status-b-co");
    await addSubscription(env.DB, 601, a.id);
    await addSubscription(env.DB, 601, b.id);
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(601, "/status"), testEnv());

    const text = telegramMessagesTo(fn, 601)[0];
    expect(text).toContain("cmd-status-a-co name");
    expect(text).toContain("cmd-status-b-co name");
  });
});

describe("subscriber safety net", () => {
  it("DMs ADMIN_CHAT_ID (not the location owner) once subscriber count crosses 40", async () => {
    const location = await makeLocation("cmd-safety-net-co", 12345);
    for (let i = 0; i < 39; i++) {
      await addSubscription(env.DB, 10_000 + i, location.id);
    }
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(99999, "/subscribe cmd-safety-net-co"), testEnv({ ADMIN_CHAT_ID: "777" }));

    const adminMessages = telegramMessagesTo(fn, 777);
    expect(adminMessages.some((t) => t.includes("40 subscribers"))).toBe(true);
    // owner (12345) should NOT get the warning when ADMIN_CHAT_ID is configured
    expect(telegramMessagesTo(fn, 12345)).toHaveLength(0);
  });

  it("falls back to the location owner when ADMIN_CHAT_ID isn't set", async () => {
    const location = await makeLocation("cmd-safety-net-fallback-co", 54321);
    for (let i = 0; i < 39; i++) {
      await addSubscription(env.DB, 20_000 + i, location.id);
    }
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(88888, "/subscribe cmd-safety-net-fallback-co"), testEnv());

    expect(telegramMessagesTo(fn, 54321).some((t) => t.includes("40 subscribers"))).toBe(true);
  });
});
