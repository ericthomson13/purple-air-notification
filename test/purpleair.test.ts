import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addLocation, getLocationBySlug } from "../src/db";
import { fetchSensorReading, findNearestSensor, getFreshReading, refreshLocationReading } from "../src/purpleair";

function mockSensorResponse(overrides: Partial<{ pm25A: number; pm25B: number; humidity: number; temperature: number; lastSeenSecondsAgo: number }> = {}) {
  const { pm25A = 10, pm25B = 10, humidity = 40, temperature = 20, lastSeenSecondsAgo = 60 } = overrides;
  return new Response(
    JSON.stringify({
      sensor: {
        name: "Mock Sensor",
        "pm2.5_cf_1_a": pm25A,
        "pm2.5_cf_1_b": pm25B,
        humidity,
        temperature,
        last_seen: Math.floor(Date.now() / 1000) - lastSeenSecondsAgo,
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
});
