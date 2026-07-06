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
  purpleAirSensor?: () => Response | Promise<Response>;
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

// Regression coverage for a real incident: a sensor's A/B channels can
// diverge so badly the averaged reading is garbage (e.g. one channel fouled
// by dust reads 4593 while the other reads 3, averaging to an AQI over
// 6000). The bot should self-heal by swapping to a nearby healthy sensor
// rather than reporting - or alerting on - a bogus reading. Assumes the
// location under test was created via makeLocation (sensor_index 123).
function divergentSensorResponse() {
  return new Response(
    JSON.stringify({
      sensor: {
        name: "Diverging Sensor",
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

function installDivergingSensorFetch(replacement?: { sensorIndex: number; name: string }) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    if (url.includes("/v1/sensors/123?")) return divergentSensorResponse();
    if (url.includes("/v1/sensors?")) {
      if (!replacement) {
        return new Response(JSON.stringify({ fields: ["sensor_index", "name", "latitude", "longitude", "last_seen"], data: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
          data: [[replacement.sensorIndex, replacement.name, 40.001, -105.001, Math.floor(Date.now() / 1000), 10, 12]],
        }),
        { status: 200 },
      );
    }
    if (replacement && url.includes(`/v1/sensors/${replacement.sensorIndex}?`)) return sensorResponse();
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
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

  // /start is often someone's very first message to the bot, so the docs
  // link needs to be a real tappable link there, not just a mention of the
  // /documentation command name.
  it("/start includes a tappable documentation link when configured", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/start"), testEnv({ DOCUMENTATION_URL: "https://docs.example.com" }));
    expect(telegramMessagesTo(fn, 1)[0]).toContain('<a href="https://docs.example.com">');
  });

  it("/start omits the tappable link (but still mentions the command) when no doc URL is configured", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/start"), testEnv());
    const text = telegramMessagesTo(fn, 1)[0];
    expect(text).not.toContain("<a href");
    expect(text).toContain("/documentation");
  });
});

describe("/locations", () => {
  it("says none are registered when the list is empty", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(1, "/locations"), testEnv());
    expect(telegramMessagesTo(fn, 1)[0]).toContain("No locations");
  });

  it("lists every registered location", async () => {
    await makeLocation("cmd-locations-a-co");
    await makeLocation("cmd-locations-b-co");
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(2, "/locations"), testEnv());

    const text = telegramMessagesTo(fn, 2)[0];
    expect(text).toContain("cmd-locations-a-co");
    expect(text).toContain("cmd-locations-b-co");
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

  // Regression test: TELEGRAM_BOT_USERNAME is documented as a bare username,
  // but it's easy to paste the full t.me link from Telegram's UI when
  // configuring the secret instead - that produced a doubled-up
  // https://t.me/t.me/<username> share link.
  it("doesn't double up the share link when TELEGRAM_BOT_USERNAME already has a t.me prefix", async () => {
    await makeLocation("cmd-subscribe-doubled-co");
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(7, "/subscribe cmd-subscribe-doubled-co"), testEnv({ TELEGRAM_BOT_USERNAME: "t.me/TestBot" }));

    const text = telegramMessagesTo(fn, 7)[0];
    expect(text).toContain("https://t.me/TestBot");
    expect(text).not.toContain("t.me/t.me");
    expect(text).not.toContain("t.me/https://");
  });

  it("subscribing twice does not error or duplicate", async () => {
    await makeLocation("cmd-subscribe-twice-co");
    installMockFetch();

    await handleTelegramUpdate(updateFor(3, "/subscribe cmd-subscribe-twice-co"), testEnv());
    await handleTelegramUpdate(updateFor(3, "/subscribe cmd-subscribe-twice-co"), testEnv());

    const location = await getLocationBySlug(env.DB, "cmd-subscribe-twice-co");
    expect(await countSubscriptionsForLocation(env.DB, location!.id)).toBe(1);
  });

  // Regression test: slugs are stored lowercase, but users don't reliably
  // type them that way - a mismatched case must not read as "unknown".
  it("matches an existing location regardless of the case typed", async () => {
    await makeLocation("cmd-case-co");
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(4, "/subscribe Cmd-Case-CO"), testEnv());

    expect(telegramMessagesTo(fn, 4)[0]).toContain("Thanks for signing up");
  });

  it("swaps to a nearby healthy sensor when the current one diverges, and tells the user", async () => {
    await makeLocation("cmd-heal-co"); // sensor_index 123 (see makeLocation)
    const fn = installDivergingSensorFetch({ sensorIndex: 456, name: "Healthy Nearby" });

    await handleTelegramUpdate(updateFor(5, "/subscribe cmd-heal-co"), testEnv());

    const text = telegramMessagesTo(fn, 5)[0];
    expect(text).toContain("switched it to a nearby one");
    expect(text).toContain("Healthy Nearby");

    const location = await getLocationBySlug(env.DB, "cmd-heal-co");
    expect(location?.sensor_index).toBe(456);
  });

  it("tells the user to reach out to the bot owner when no healthy sensor is nearby", async () => {
    await makeLocation("cmd-heal-none-co");
    const fn = installDivergingSensorFetch();

    await handleTelegramUpdate(updateFor(6, "/subscribe cmd-heal-none-co"), testEnv());

    const text = telegramMessagesTo(fn, 6)[0];
    expect(text).toContain("Reach out to whoever runs this bot");

    const location = await getLocationBySlug(env.DB, "cmd-heal-none-co");
    expect(location?.sensor_index).toBe(123);
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

  it("accepts a validly-shaped slug regardless of case", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(16, "/addlocation Auto-Case-CO"), testEnv());

    expect(telegramMessagesTo(fn, 16)[0]).toContain("Added");
    expect(await getLocationBySlug(env.DB, "auto-case-co")).not.toBeNull();
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

  it("auto-discovery: reports a transient failure when geocoding itself errors, without creating a location", async () => {
    const { fn } = installMockFetch({ nominatim: () => new Response("rate limited", { status: 429 }) });
    await handleTelegramUpdate(updateFor(17, "/addlocation cmd-geocode-fail-co"), testEnv());

    expect(telegramMessagesTo(fn, 17)[0]).toContain("Couldn't look up");
    expect(await getLocationBySlug(env.DB, "cmd-geocode-fail-co")).toBeNull();
  });

  it("auto-discovery: reports a transient failure when the PurpleAir sensor search errors, without creating a location", async () => {
    const { fn } = installMockFetch({ purpleAirSensorsList: () => new Response("nope", { status: 500 }) });
    await handleTelegramUpdate(updateFor(18, "/addlocation cmd-search-fail-co"), testEnv());

    expect(telegramMessagesTo(fn, 18)[0]).toContain("couldn't search PurpleAir for sensors nearby");
    expect(await getLocationBySlug(env.DB, "cmd-search-fail-co")).toBeNull();
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

  it("manual fallback: rejects a non-numeric sensor_index without creating a location", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(19, "/addlocation cmd-bad-sensor-co notanumber Bad, CO"), testEnv());

    expect(telegramMessagesTo(fn, 19)[0]).toContain("Usage");
    expect(await getLocationBySlug(env.DB, "cmd-bad-sensor-co")).toBeNull();
  });

  it("manual fallback: rejects a missing name without creating a location", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(20, "/addlocation cmd-noname-co 555"), testEnv());

    expect(telegramMessagesTo(fn, 20)[0]).toContain("Usage");
    expect(await getLocationBySlug(env.DB, "cmd-noname-co")).toBeNull();
  });

  it("manual fallback: reports when the given sensor can't be read from PurpleAir, without creating a location", async () => {
    const { fn } = installMockFetch({ purpleAirSensor: () => new Response("nope", { status: 500 }) });
    await handleTelegramUpdate(updateFor(21, "/addlocation cmd-offline-sensor-co 555 Offline, CO"), testEnv());

    const text = telegramMessagesTo(fn, 21)[0];
    expect(text).toContain("offline");
    expect(text).not.toContain("disagree"); // a generic fetch failure, not sensor divergence
    expect(await getLocationBySlug(env.DB, "cmd-offline-sensor-co")).toBeNull();
  });

  // Regression test for the insert's catch block: two requests can both pass
  // the "does this slug exist" check before either one inserts. Simulated
  // here by inserting the conflicting row mid-flight, from inside the mocked
  // PurpleAir sensor fetch - which runs after the existing-slug check but
  // before this handler's own insert.
  it("reports a race-condition insert conflict instead of erroring, without duplicating the location", async () => {
    const { fn } = installMockFetch({
      purpleAirSensor: async () => {
        await addLocation(env.DB, { slug: "cmd-race-co", name: "Raced, CO", sensorIndex: 42, lat: null, lon: null, addedByChatId: 777 });
        return sensorResponse();
      },
    });

    await handleTelegramUpdate(updateFor(22, "/addlocation cmd-race-co 555 Raced, CO"), testEnv());

    expect(telegramMessagesTo(fn, 22)[0]).toContain("may have just been added by someone else");
    // the concurrent insert survives untouched - no duplicate, no overwrite
    const location = await getLocationBySlug(env.DB, "cmd-race-co");
    expect(location?.added_by_chat_id).toBe(777);
    expect(location?.sensor_index).toBe(42);
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

  // Regression test: the "other subscribers" count must reflect who's
  // actually still subscribed, not assume the owner is one of them.
  it("counts other subscribers accurately even if the owner already unsubscribed", async () => {
    const location = await makeLocation("cmd-remove-unsubbed-owner-co", 99);
    await addSubscription(env.DB, 201, location.id);
    await addSubscription(env.DB, 202, location.id);
    // owner never subscribed to their own location in this scenario

    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(99, "/removelocation cmd-remove-unsubbed-owner-co"), testEnv());

    expect(telegramMessagesTo(fn, 99)[0]).toContain("2 other subscriber");
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

  // Same self-healing as /subscribe (see the divergence tests above): /status
  // must not just echo back whatever bogus AQI a diverging sensor last wrote
  // to D1 - it should refresh (and self-heal) before reporting.
  it("swaps to a nearby healthy sensor when the current one diverges, and reports the healed reading", async () => {
    const location = await makeLocation("cmd-status-heal-co");
    await addSubscription(env.DB, 602, location.id);
    const fn = installDivergingSensorFetch({ sensorIndex: 456, name: "Healthy Nearby" });

    await handleTelegramUpdate(updateFor(602, "/status"), testEnv());

    const text = telegramMessagesTo(fn, 602)[0];
    expect(text).toContain("cmd-status-heal-co name");
    expect(text).toContain("switched to a nearby sensor");
    expect(text).toContain("Healthy Nearby");
    expect(text).not.toMatch(/AQI \d{4,}/); // no bogus 4+ digit AQI

    const updated = await getLocationBySlug(env.DB, "cmd-status-heal-co");
    expect(updated?.sensor_index).toBe(456);
  });

  it("tells the user to reach out to the bot owner when status-checking a diverging sensor with no healthy replacement nearby", async () => {
    const location = await makeLocation("cmd-status-heal-none-co");
    await addSubscription(env.DB, 603, location.id);
    const fn = installDivergingSensorFetch();

    await handleTelegramUpdate(updateFor(603, "/status"), testEnv());

    const text = telegramMessagesTo(fn, 603)[0];
    expect(text).toContain("Reach out to whoever runs this bot");

    const updated = await getLocationBySlug(env.DB, "cmd-status-heal-none-co");
    expect(updated?.sensor_index).toBe(123);
  });
});

describe("/documentation", () => {
  it("links to the docs site when DOCUMENTATION_URL is configured", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(700, "/documentation"), testEnv({ DOCUMENTATION_URL: "https://docs.example.com" }));
    expect(telegramMessagesTo(fn, 700)[0]).toContain("https://docs.example.com");
  });

  it("says no link is configured when DOCUMENTATION_URL is unset", async () => {
    const { fn } = installMockFetch();
    await handleTelegramUpdate(updateFor(701, "/documentation"), testEnv());
    expect(telegramMessagesTo(fn, 701)[0]).toContain("No documentation link is configured");
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

  // Distinct from the 40-subscriber warning above: at 50, Cloudflare's
  // free-tier fan-out limit is actually reached (not just approaching), so
  // the message wording changes to say so and to suggest upgrading.
  it("warns that the hard cap (50) has actually been reached, with different wording than the 40 warning", async () => {
    const location = await makeLocation("cmd-safety-net-hardcap-co", 13579);
    for (let i = 0; i < 49; i++) {
      await addSubscription(env.DB, 30_000 + i, location.id);
    }
    const { fn } = installMockFetch();

    await handleTelegramUpdate(updateFor(77777, "/subscribe cmd-safety-net-hardcap-co"), testEnv({ ADMIN_CHAT_ID: "777" }));

    const adminMessages = telegramMessagesTo(fn, 777);
    expect(adminMessages.some((t) => t.includes("has reached 50 subscribers"))).toBe(true);
    expect(adminMessages.some((t) => t.includes("Workers Paid"))).toBe(true);
  });
});
