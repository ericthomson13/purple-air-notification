import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addLocation, getLocationBySlug } from "../src/db";
import { fetchSensorReading, findNearestSensor, getFreshReading, refreshLocationReading, SensorDivergenceError } from "../src/purpleair";

function mockSensorResponse(
  overrides: Partial<{ pm25A: number; pm25B: number; humidity: number; temperature: number; lastSeenSecondsAgo: number; lat: number; lon: number }> = {},
) {
  const { pm25A = 10, pm25B = 10, humidity = 40, temperature = 20, lastSeenSecondsAgo = 60, lat, lon } = overrides;
  return new Response(
    JSON.stringify({
      sensor: {
        name: "Mock Sensor",
        "pm2.5_cf_1_a": pm25A,
        "pm2.5_cf_1_b": pm25B,
        humidity,
        temperature,
        last_seen: Math.floor(Date.now() / 1000) - lastSeenSecondsAgo,
        latitude: lat,
        longitude: lon,
      },
    }),
    { status: 200 },
  );
}

async function makeTestLocation(slug: string) {
  await addLocation(env.DB, { slug, name: `${slug} name`, sensorIndex: 1, lat: null, lon: null, addedByChatId: null });
  const location = await getLocationBySlug(env.DB, slug);
  if (!location) throw new Error("failed to create test location");
  return location;
}

describe("fetchSensorReading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("averages the two channels and computes AQI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockSensorResponse({ pm25A: 8, pm25B: 12 })));
    const reading = await fetchSensorReading(1, "key");
    expect(reading.pm25CfAtmAvg).toBe(10);
    expect(reading.aqi).toBeGreaterThan(0);
  });

  it("throws when the sensor data is older than an hour", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockSensorResponse({ lastSeenSecondsAgo: 3601 })));
    await expect(fetchSensorReading(1, "key")).rejects.toThrow(/stale/);
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(fetchSensorReading(1, "key")).rejects.toThrow(/500/);
  });

  it("throws SensorDivergenceError when A/B channels wildly disagree", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockSensorResponse({ pm25A: 4593, pm25B: 3, lat: 39.97, lon: -105.13 })));
    const err = await fetchSensorReading(1, "key").catch((e) => e);
    expect(err).toBeInstanceOf(SensorDivergenceError);
    expect(err.lat).toBe(39.97);
    expect(err.lon).toBe(-105.13);
  });

  it("does not flag divergence at low readings even with a big ratio", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockSensorResponse({ pm25A: 8, pm25B: 1 })));
    const reading = await fetchSensorReading(1, "key");
    expect(reading.pm25CfAtmAvg).toBe(4.5);
  });

  it("does not flag divergence when channels roughly agree", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockSensorResponse({ pm25A: 30, pm25B: 40 })));
    const reading = await fetchSensorReading(1, "key");
    expect(reading.pm25CfAtmAvg).toBe(35);
  });
});

describe("refreshLocationReading / getFreshReading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshLocationReading fetches, persists, and returns the new level", async () => {
    const location = await makeTestLocation("pa-refresh-co");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockSensorResponse({ pm25A: 5, pm25B: 5 })));

    const { reading, levelIdx } = await refreshLocationReading(env.DB, location, "key");
    expect(reading.aqi).toBeGreaterThanOrEqual(0);

    const updated = await getLocationBySlug(env.DB, "pa-refresh-co");
    expect(updated?.last_aqi).toBe(reading.aqi);
    expect(updated?.last_level).toBe(levelIdx);
  });

  it("getFreshReading uses the cached value and skips PurpleAir when recently checked", async () => {
    const location = await makeTestLocation("pa-cached-co");
    const fetchMock = vi.fn().mockResolvedValue(mockSensorResponse());
    vi.stubGlobal("fetch", fetchMock);

    await refreshLocationReading(env.DB, location, "key"); // populates last_checked_at = now
    fetchMock.mockClear();

    const fresh = await getLocationBySlug(env.DB, "pa-cached-co");
    if (!fresh) throw new Error("missing location");
    const result = await getFreshReading(env.DB, fresh, "key");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.aqi).toBe(fresh.last_aqi);
  });

  it("getFreshReading hits PurpleAir when there's no prior reading", async () => {
    const location = await makeTestLocation("pa-uncached-co");
    const fetchMock = vi.fn().mockResolvedValue(mockSensorResponse());
    vi.stubGlobal("fetch", fetchMock);

    await getFreshReading(env.DB, location, "key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("findNearestSensor", () => {
  afterEach(() => vi.unstubAllGlobals());

  function sensorsListResponse(rows: Array<{ sensorIndex: number; name: string; lat: number; lon: number; lastSeenSecondsAgo: number }>) {
    const now = Math.floor(Date.now() / 1000);
    return new Response(
      JSON.stringify({
        fields: ["sensor_index", "name", "latitude", "longitude", "last_seen"],
        data: rows.map((r) => [r.sensorIndex, r.name, r.lat, r.lon, now - r.lastSeenSecondsAgo]),
      }),
      { status: 200 },
    );
  }

  it("picks the closest active sensor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sensorsListResponse([
          { sensorIndex: 1, name: "Far", lat: 40.1, lon: -105.1, lastSeenSecondsAgo: 60 },
          { sensorIndex: 2, name: "Near", lat: 40.001, lon: -105.001, lastSeenSecondsAgo: 60 },
        ]),
      ),
    );

    const nearest = await findNearestSensor(40.0, -105.0, "key");
    expect(nearest?.sensorIndex).toBe(2);
    expect(nearest?.name).toBe("Near");
  });

  it("ignores sensors that haven't reported in over an hour", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sensorsListResponse([
          { sensorIndex: 1, name: "Stale but closest", lat: 40.001, lon: -105.001, lastSeenSecondsAgo: 7200 },
          { sensorIndex: 2, name: "Fresh but farther", lat: 40.05, lon: -105.05, lastSeenSecondsAgo: 60 },
        ]),
      ),
    );

    const nearest = await findNearestSensor(40.0, -105.0, "key");
    expect(nearest?.sensorIndex).toBe(2);
  });

  it("returns null when nothing nearby is active", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sensorsListResponse([{ sensorIndex: 1, name: "Stale", lat: 40.001, lon: -105.001, lastSeenSecondsAgo: 7200 }])));
    expect(await findNearestSensor(40.0, -105.0, "key")).toBeNull();
  });

  it("excludes the given sensor index even if it's closest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sensorsListResponse([
          { sensorIndex: 1, name: "Closest but excluded", lat: 40.001, lon: -105.001, lastSeenSecondsAgo: 60 },
          { sensorIndex: 2, name: "Next best", lat: 40.01, lon: -105.01, lastSeenSecondsAgo: 60 },
        ]),
      ),
    );

    const nearest = await findNearestSensor(40.0, -105.0, "key", 1);
    expect(nearest?.sensorIndex).toBe(2);
  });

  it("skips candidates whose A/B channels diverge", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
            data: [
              [1, "Closest but diverging", 40.001, -105.001, now, 4593, 3],
              [2, "Healthy but farther", 40.01, -105.01, now, 10, 12],
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const nearest = await findNearestSensor(40.0, -105.0, "key");
    expect(nearest?.sensorIndex).toBe(2);
  });

  // Regression test: a real "nearest" candidate near a diverging Louisville,
  // CO sensor reported only its A channel (B was entirely absent from the
  // per-sensor endpoint, and null in the list response). Treating a null
  // channel as "not diverging" picked it as the replacement, and the
  // subsequent per-sensor fetch then failed with an unrelated "missing
  // required fields" error instead of the self-heal cleanly falling back to
  // "no healthy sensor nearby".
  it("skips candidates missing a PM2.5 channel entirely, even if closest", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
            data: [
              [1, "Closest but single-channel", 40.001, -105.001, now, 5.9, null],
              [2, "Healthy but farther", 40.01, -105.01, now, 10, 12],
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const nearest = await findNearestSensor(40.0, -105.0, "key");
    expect(nearest?.sensorIndex).toBe(2);
  });
});

describe("sensor self-healing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshLocationReading swaps to a nearby healthy sensor when the current one diverges", async () => {
    const location = await makeTestLocation("pa-heal-co"); // starts on sensor_index 1

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/v1/sensors/1?")) {
        return Promise.resolve(mockSensorResponse({ pm25A: 4593, pm25B: 3, lat: 40.0, lon: -105.0 }));
      }
      if (url.includes("/v1/sensors?")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
              data: [[2, "Healthy Nearby", 40.001, -105.001, Math.floor(Date.now() / 1000), 10, 12]],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/v1/sensors/2?")) {
        return Promise.resolve(mockSensorResponse({ pm25A: 10, pm25B: 12 }));
      }
      throw new Error(`unexpected url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { reading, swappedTo } = await refreshLocationReading(env.DB, location, "key");
    expect(swappedTo?.sensorIndex).toBe(2);
    expect(reading.pm25CfAtmAvg).toBe(11);

    const updated = await getLocationBySlug(env.DB, "pa-heal-co");
    expect(updated?.sensor_index).toBe(2);
  });

  it("rethrows SensorDivergenceError when no healthy sensor is found nearby, and leaves the location alone", async () => {
    const location = await makeTestLocation("pa-heal-none-co");

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/v1/sensors/1?")) {
        return Promise.resolve(mockSensorResponse({ pm25A: 4593, pm25B: 3, lat: 40.0, lon: -105.0 }));
      }
      if (url.includes("/v1/sensors?")) {
        return Promise.resolve(
          new Response(JSON.stringify({ fields: ["sensor_index", "name", "latitude", "longitude", "last_seen"], data: [] }), { status: 200 }),
        );
      }
      throw new Error(`unexpected url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshLocationReading(env.DB, location, "key")).rejects.toBeInstanceOf(SensorDivergenceError);

    const updated = await getLocationBySlug(env.DB, "pa-heal-none-co");
    expect(updated?.sensor_index).toBe(1);
  });

  // Regression test: findNearestSensor can pick a candidate that looked
  // healthy in the list search but fails when actually fetched (e.g. it went
  // stale in the interim). That must fall back to "no healthy sensor found"
  // (the original SensorDivergenceError), not leak the replacement's
  // unrelated fetch error - callers only know how to handle the former.
  it("falls back to the original SensorDivergenceError if the replacement sensor also fails to fetch", async () => {
    const location = await makeTestLocation("pa-heal-bad-replacement-co");

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/v1/sensors/1?")) {
        return Promise.resolve(mockSensorResponse({ pm25A: 4593, pm25B: 3, lat: 40.0, lon: -105.0 }));
      }
      if (url.includes("/v1/sensors?")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
              data: [[2, "Looked healthy but isn't", 40.001, -105.001, Math.floor(Date.now() / 1000), 10, 12]],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/v1/sensors/2?")) {
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      throw new Error(`unexpected url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshLocationReading(env.DB, location, "key")).rejects.toBeInstanceOf(SensorDivergenceError);

    const updated = await getLocationBySlug(env.DB, "pa-heal-bad-replacement-co");
    expect(updated?.sensor_index).toBe(1);
  });
});
