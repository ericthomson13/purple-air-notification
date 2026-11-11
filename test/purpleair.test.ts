import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calcAqi } from "../src/aqi";
import { addLocation, getLocationBySlug, insertReadingHistory } from "../src/db";
import {
  checkAndHealErratic,
  checkAndHealFlatline,
  fetchSensorReading,
  findNearestSensor,
  findPeerAqiReadings,
  getFreshReading,
  refreshLocationReading,
  SensorDivergenceError,
  type SensorReading,
} from "../src/purpleair";

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

function peerListResponse(
  rows: Array<{ sensorIndex: number; name: string; lat: number; lon: number; pm25A: number | null; pm25B: number | null; humidity?: number | null; temperature?: number | null; lastSeenSecondsAgo?: number }>,
) {
  const now = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b", "humidity", "temperature"],
      data: rows.map((r) => [
        r.sensorIndex,
        r.name,
        r.lat,
        r.lon,
        now - (r.lastSeenSecondsAgo ?? 60),
        r.pm25A,
        r.pm25B,
        r.humidity === undefined ? 40 : r.humidity,
        r.temperature === undefined ? 20 : r.temperature,
      ]),
    }),
    { status: 200 },
  );
}

describe("findPeerAqiReadings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("computes AQI for each qualifying peer and sorts by distance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        peerListResponse([
          { sensorIndex: 2, name: "Far", lat: 40.05, lon: -105.05, pm25A: 10, pm25B: 12 },
          { sensorIndex: 3, name: "Near", lat: 40.001, lon: -105.001, pm25A: 20, pm25B: 22 },
        ]),
      ),
    );

    const peers = await findPeerAqiReadings(40.0, -105.0, "key", 1);
    expect(peers.map((p) => p.sensorIndex)).toEqual([3, 2]);
    expect(peers[0].aqi).toBeGreaterThan(0);
  });

  it("excludes the given sensor index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        peerListResponse([
          { sensorIndex: 1, name: "Self", lat: 40.001, lon: -105.001, pm25A: 20, pm25B: 22 },
          { sensorIndex: 2, name: "Other", lat: 40.002, lon: -105.002, pm25A: 20, pm25B: 22 },
        ]),
      ),
    );

    const peers = await findPeerAqiReadings(40.0, -105.0, "key", 1);
    expect(peers.map((p) => p.sensorIndex)).toEqual([2]);
  });

  it("skips stale, diverging, and missing-humidity/temperature candidates", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            fields: ["sensor_index", "name", "latitude", "longitude", "last_seen", "pm2.5_cf_1_a", "pm2.5_cf_1_b", "humidity", "temperature"],
            data: [
              [2, "Stale", 40.001, -105.001, now - 7200, 10, 12, 40, 20],
              [3, "Diverging", 40.002, -105.002, now, 4593, 3, 40, 20],
              [4, "Missing humidity", 40.003, -105.003, now, 10, 12, null, 20],
              [5, "Healthy", 40.004, -105.004, now, 10, 12, 40, 20],
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const peers = await findPeerAqiReadings(40.0, -105.0, "key", 1);
    expect(peers.map((p) => p.sensorIndex)).toEqual([5]);
  });
});

function flatReading(overrides: Partial<SensorReading> = {}): SensorReading {
  return {
    aqi: 50,
    pm25CfAtmAvg: 20,
    humidity: 40,
    temperature: 20,
    lastSeen: Math.floor(Date.now() / 1000),
    staleSeconds: 60,
    lat: 40.0,
    lon: -105.0,
    ...overrides,
  };
}

// Regression coverage for a real incident: a Leadville, CO sensor kept
// reporting on schedule (so it never looked stale) with its A/B channels
// agreeing with each other, but its AQI barely moved for an entire day while
// other Leadville sensors nearby showed normal variation.
describe("checkAndHealFlatline", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function seedFlatHistory(locationId: number, aqi: number, count: number) {
    for (let i = 0; i < count; i++) {
      await insertReadingHistory(env.DB, locationId, aqi, 0);
    }
  }

  it("returns insufficient_history and skips the peer search when fewer than 12 readings exist", async () => {
    const location = await makeTestLocation("pa-flat-insufficient-co");
    await seedFlatHistory(location.id, 50, 5);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkAndHealFlatline(env.DB, location, "key", flatReading());
    expect(result.outcome).toBe("insufficient_history");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns not_flat and skips the peer search when recent AQI varies beyond the range threshold", async () => {
    const location = await makeTestLocation("pa-flat-notflat-co");
    for (let i = 0; i < 12; i++) {
      await insertReadingHistory(env.DB, location.id, 40 + i * 5, 0);
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkAndHealFlatline(env.DB, location, "key", flatReading({ aqi: 40 }));
    expect(result.outcome).toBe("not_flat");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no_coordinates and skips the peer search when the reading has no lat/lon", async () => {
    const location = await makeTestLocation("pa-flat-nocoords-co");
    await seedFlatHistory(location.id, 50, 12);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkAndHealFlatline(env.DB, location, "key", flatReading({ lat: null, lon: null }));
    expect(result.outcome).toBe("no_coordinates");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT confirm (or swap) when fewer than 3 healthy peers are found nearby", async () => {
    const location = await makeTestLocation("pa-flat-fewpeers-co");
    await seedFlatHistory(location.id, 20, 12);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        peerListResponse([
          { sensorIndex: 2, name: "Peer A", lat: 40.001, lon: -105.001, pm25A: 60, pm25B: 62 },
          { sensorIndex: 3, name: "Peer B", lat: 40.002, lon: -105.002, pm25A: 60, pm25B: 62 },
        ]),
      ),
    );

    const result = await checkAndHealFlatline(env.DB, location, "key", flatReading({ aqi: 20 }));
    expect(result.outcome).toBe("insufficient_peers");
    const updated = await getLocationBySlug(env.DB, "pa-flat-fewpeers-co");
    expect(updated?.sensor_index).toBe(1);
  });

  it("does NOT self-heal when peers agree with the flat value - genuinely calm weather, not a stuck sensor", async () => {
    const location = await makeTestLocation("pa-flat-agree-co");
    await seedFlatHistory(location.id, 50, 12);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        peerListResponse([
          { sensorIndex: 2, name: "Peer A", lat: 40.001, lon: -105.001, pm25A: 20, pm25B: 20 },
          { sensorIndex: 3, name: "Peer B", lat: 40.002, lon: -105.002, pm25A: 20, pm25B: 20 },
          { sensorIndex: 4, name: "Peer C", lat: 40.003, lon: -105.003, pm25A: 20, pm25B: 20 },
        ]),
      ),
    );

    const result = await checkAndHealFlatline(env.DB, location, "key", flatReading({ aqi: 50 }));
    expect(result.outcome).toBe("peers_agree");
    const updated = await getLocationBySlug(env.DB, "pa-flat-agree-co");
    expect(updated?.sensor_index).toBe(1);
  });

  it("self-heals when 3+ confirming peers disagree with the flat value: swaps sensor_index and returns confirmed", async () => {
    const location = await makeTestLocation("pa-flat-confirmed-co");
    await seedFlatHistory(location.id, 20, 12);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        peerListResponse([
          { sensorIndex: 2, name: "Peer A", lat: 40.001, lon: -105.001, pm25A: 60, pm25B: 62 },
          { sensorIndex: 3, name: "Peer B", lat: 40.002, lon: -105.002, pm25A: 60, pm25B: 62 },
          { sensorIndex: 4, name: "Peer C", lat: 40.003, lon: -105.003, pm25A: 60, pm25B: 62 },
        ]),
      ),
    );

    const result = await checkAndHealFlatline(env.DB, location, "key", flatReading({ aqi: 20 }));
    expect(result.outcome).toBe("confirmed");
    if (result.outcome === "confirmed") {
      expect(result.swappedTo.sensorIndex).toBe(2);
    }
    const updated = await getLocationBySlug(env.DB, "pa-flat-confirmed-co");
    expect(updated?.sensor_index).toBe(2);
  });
});

function historyResponse(rows: Array<{ pm25A: number; pm25B: number }>) {
  const now = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      // PurpleAir's history endpoint doesn't echo fields back in the order
      // requested - deliberately out of order here to guard against
      // assuming positions instead of reading them from `fields`.
      fields: ["time_stamp", "humidity", "temperature", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
      data: rows.map((r, i) => [now - i * 600, 40, 20, r.pm25A, r.pm25B]),
    }),
    { status: 200 },
  );
}

function stableHistory(count = 12) {
  return Array.from({ length: count }, () => ({ pm25A: 10, pm25B: 10 }));
}

function volatileHistory(count = 12) {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? { pm25A: 5, pm25B: 5 } : { pm25A: 200, pm25B: 200 }));
}

function installErraticFetch(
  peers: Array<{ sensorIndex: number; name: string; lat: number; lon: number; pm25A: number; pm25B: number }>,
  historyBySensor: Record<number, Array<{ pm25A: number; pm25B: number }> | "error">,
) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const historyMatch = url.match(/\/sensors\/(\d+)\/history\?/);
    if (historyMatch) {
      const sensorIndex = Number(historyMatch[1]);
      const rows = historyBySensor[sensorIndex];
      if (rows === "error" || rows === undefined) return new Response("nope", { status: 500 });
      return historyResponse(rows);
    }
    if (url.includes("/v1/sensors?")) return peerListResponse(peers);
    throw new Error(`unexpected url in test: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// Regression coverage for a real incident: a Leadville, CO sensor swung
// between AQI ~1 and 100+ on a ~24h cycle while sensors a few meters away at
// the same physical site stayed under an AQI range of 5 for 48 straight
// hours - the exact inverse of the flatline case, and something the
// flatline check (which only fires when a sensor's own history is
// suspiciously *flat*) completely misses.
describe("checkAndHealErratic", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function seedErraticHistory(locationId: number) {
    // Alternating low/high AQI so the range comfortably clears
    // ERRATIC_MIN_AQI_RANGE without needing to reverse-engineer exact values.
    for (let i = 0; i < 12; i++) {
      await insertReadingHistory(env.DB, locationId, i % 2 === 0 ? 10 : 150, 0);
    }
  }

  it("returns insufficient_history and skips the peer search when fewer than 12 readings exist", async () => {
    const location = await makeTestLocation("pa-erratic-insufficient-co");
    for (let i = 0; i < 5; i++) {
      await insertReadingHistory(env.DB, location.id, i % 2 === 0 ? 10 : 150, 0);
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkAndHealErratic(env.DB, location, "key", flatReading());
    expect(result.outcome).toBe("insufficient_history");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns not_erratic and skips the peer search when the own range is below the erratic threshold", async () => {
    const location = await makeTestLocation("pa-erratic-notso-co");
    for (let i = 0; i < 12; i++) {
      await insertReadingHistory(env.DB, location.id, 40 + i, 0); // range ~11, well under the threshold
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkAndHealErratic(env.DB, location, "key", flatReading());
    expect(result.outcome).toBe("not_erratic");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no_coordinates and skips the peer search when the reading has no lat/lon", async () => {
    const location = await makeTestLocation("pa-erratic-nocoords-co");
    await seedErraticHistory(location.id);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkAndHealErratic(env.DB, location, "key", flatReading({ lat: null, lon: null }));
    expect(result.outcome).toBe("no_coordinates");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms and swaps to the nearest peer when 3+ peers' own history stayed stable over the same window", async () => {
    const location = await makeTestLocation("pa-erratic-confirmed-co");
    await seedErraticHistory(location.id);

    installErraticFetch(
      [
        { sensorIndex: 2, name: "Peer A", lat: 40.001, lon: -105.001, pm25A: 10, pm25B: 10 },
        { sensorIndex: 3, name: "Peer B", lat: 40.002, lon: -105.002, pm25A: 10, pm25B: 10 },
        { sensorIndex: 4, name: "Peer C", lat: 40.003, lon: -105.003, pm25A: 10, pm25B: 10 },
      ],
      { 2: stableHistory(), 3: stableHistory(), 4: stableHistory() },
    );

    const result = await checkAndHealErratic(env.DB, location, "key", flatReading());
    expect(result.outcome).toBe("confirmed");
    if (result.outcome === "confirmed") {
      expect(result.swappedTo.sensorIndex).toBe(2); // nearest of the stable peers
      expect(result.stablePeerCount).toBe(3);
    }
    const updated = await getLocationBySlug(env.DB, "pa-erratic-confirmed-co");
    expect(updated?.sensor_index).toBe(2);
  });

  it("does NOT confirm (or swap) when peers' own history was also volatile over the same window - a real regional event, not a malfunction", async () => {
    const location = await makeTestLocation("pa-erratic-peersvolatile-co");
    await seedErraticHistory(location.id);

    installErraticFetch(
      [
        { sensorIndex: 2, name: "Peer A", lat: 40.001, lon: -105.001, pm25A: 10, pm25B: 10 },
        { sensorIndex: 3, name: "Peer B", lat: 40.002, lon: -105.002, pm25A: 10, pm25B: 10 },
        { sensorIndex: 4, name: "Peer C", lat: 40.003, lon: -105.003, pm25A: 10, pm25B: 10 },
      ],
      { 2: volatileHistory(), 3: volatileHistory(), 4: volatileHistory() },
    );

    const result = await checkAndHealErratic(env.DB, location, "key", flatReading());
    expect(result.outcome).toBe("insufficient_stable_peers");
    if (result.outcome === "insufficient_stable_peers") {
      expect(result.stablePeerCount).toBe(0);
    }
    const updated = await getLocationBySlug(env.DB, "pa-erratic-peersvolatile-co");
    expect(updated?.sensor_index).toBe(1);
  });

  it("does NOT confirm when fewer than 3 peers are found nearby at all, even if all of them are stable", async () => {
    const location = await makeTestLocation("pa-erratic-fewpeers-co");
    await seedErraticHistory(location.id);

    installErraticFetch(
      [
        { sensorIndex: 2, name: "Peer A", lat: 40.001, lon: -105.001, pm25A: 10, pm25B: 10 },
        { sensorIndex: 3, name: "Peer B", lat: 40.002, lon: -105.002, pm25A: 10, pm25B: 10 },
      ],
      { 2: stableHistory(), 3: stableHistory() },
    );

    const result = await checkAndHealErratic(env.DB, location, "key", flatReading());
    expect(result.outcome).toBe("insufficient_stable_peers");
    const updated = await getLocationBySlug(env.DB, "pa-erratic-fewpeers-co");
    expect(updated?.sensor_index).toBe(1);
  });

  it("skips a peer whose history fetch fails and still confirms if enough other peers are stable", async () => {
    const location = await makeTestLocation("pa-erratic-onepeerfails-co");
    await seedErraticHistory(location.id);

    installErraticFetch(
      [
        { sensorIndex: 2, name: "Peer A", lat: 40.001, lon: -105.001, pm25A: 10, pm25B: 10 },
        { sensorIndex: 3, name: "Peer B", lat: 40.002, lon: -105.002, pm25A: 10, pm25B: 10 },
        { sensorIndex: 4, name: "Peer C", lat: 40.003, lon: -105.003, pm25A: 10, pm25B: 10 },
        { sensorIndex: 5, name: "Peer D", lat: 40.004, lon: -105.004, pm25A: 10, pm25B: 10 },
      ],
      { 2: "error", 3: stableHistory(), 4: stableHistory(), 5: stableHistory() },
    );

    const result = await checkAndHealErratic(env.DB, location, "key", flatReading());
    expect(result.outcome).toBe("confirmed");
    if (result.outcome === "confirmed") {
      expect(result.swappedTo.sensorIndex).toBe(3); // nearest of the ones that succeeded and were stable
    }
  });
});

// Replay of the actual incident that motivated this feature: raw pm2.5/
// humidity/temperature pulled directly from PurpleAir's history API on
// 2026-07-29 for the real Leadville, CO sensor (194415) and three real
// sensors a few meters away at the same physical site ("Sloan_flex-f877" /
// 183561, "Sloan_flex-d54e" / 183825) and a nearby one ("Lake fork" /
// 316914) - not synthetic values. Confirms the shipped thresholds actually
// catch the real-world case, not just idealized test fixtures.
describe("checkAndHealErratic replay: real Leadville, CO incident (2026-07-29)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const LEADVILLE_RAW = [
    { pm25A: 42.3, pm25B: 41.3, humidity: 24, temperature: 85 },
    { pm25A: 76.2, pm25B: 74.7, humidity: 25, temperature: 86 },
    { pm25A: 56.0, pm25B: 55.5, humidity: 26, temperature: 86 },
    { pm25A: 76.5, pm25B: 75.2, humidity: 26, temperature: 86 },
    { pm25A: 108.2, pm25B: 105.2, humidity: 26, temperature: 85 },
    { pm25A: 57.4, pm25B: 55.9, humidity: 26, temperature: 85 },
    { pm25A: 28.9, pm25B: 28.2, humidity: 27, temperature: 84 },
    { pm25A: 14.2, pm25B: 13.4, humidity: 27, temperature: 84 },
    { pm25A: 7.2, pm25B: 6.9, humidity: 27, temperature: 83 },
    { pm25A: 3.8, pm25B: 3.7, humidity: 27, temperature: 82 },
    { pm25A: 2.4, pm25B: 2.4, humidity: 27, temperature: 82 },
    { pm25A: 1.9, pm25B: 1.9, humidity: 29, temperature: 82 },
  ];

  const PEER_F877_RAW = [
    { pm25A: 3.6, pm25B: 2.8, humidity: 54, temperature: 65 },
    { pm25A: 4.3, pm25B: 3.2, humidity: 56, temperature: 64 },
    { pm25A: 3.7, pm25B: 3.0, humidity: 57, temperature: 63 },
    { pm25A: 3.4, pm25B: 2.9, humidity: 57, temperature: 63 },
    { pm25A: 4.3, pm25B: 3.5, humidity: 58, temperature: 63 },
    { pm25A: 5.1, pm25B: 4.3, humidity: 61, temperature: 60 },
    { pm25A: 3.4, pm25B: 2.8, humidity: 60, temperature: 58 },
    { pm25A: 3.3, pm25B: 2.6, humidity: 61, temperature: 58 },
    { pm25A: 3.0, pm25B: 2.4, humidity: 53, temperature: 64 },
    { pm25A: 2.7, pm25B: 2.1, humidity: 32, temperature: 81 },
    { pm25A: 3.0, pm25B: 2.4, humidity: 25, temperature: 88 },
    { pm25A: 1.7, pm25B: 1.6, humidity: 22, temperature: 90 },
  ];

  const PEER_D54E_RAW = [
    { pm25A: 3.8, pm25B: 2.9, humidity: 54, temperature: 63 },
    { pm25A: 3.4, pm25B: 2.7, humidity: 56, temperature: 62 },
    { pm25A: 3.4, pm25B: 2.6, humidity: 58, temperature: 61 },
    { pm25A: 3.4, pm25B: 2.6, humidity: 58, temperature: 61 },
    { pm25A: 4.2, pm25B: 3.3, humidity: 60, temperature: 60 },
    { pm25A: 4.9, pm25B: 4.0, humidity: 62, temperature: 59 },
    { pm25A: 3.4, pm25B: 2.7, humidity: 62, temperature: 57 },
    { pm25A: 3.2, pm25B: 2.6, humidity: 60, temperature: 57 },
    { pm25A: 3.0, pm25B: 2.2, humidity: 56, temperature: 60 },
    { pm25A: 3.1, pm25B: 2.5, humidity: 46, temperature: 66 },
    { pm25A: 3.3, pm25B: 2.8, humidity: 38, temperature: 73 },
    { pm25A: 2.3, pm25B: 1.9, humidity: 28, temperature: 79 },
  ];

  const PEER_LAKEFORK_RAW = [
    { pm25A: 2.9, pm25B: 3.1, humidity: 55, temperature: 62 },
    { pm25A: 2.8, pm25B: 3.0, humidity: 58, temperature: 60 },
    { pm25A: 4.0, pm25B: 4.2, humidity: 59, temperature: 59 },
    { pm25A: 5.6, pm25B: 5.4, humidity: 61, temperature: 58 },
    { pm25A: 8.2, pm25B: 7.6, humidity: 62, temperature: 58 },
    { pm25A: 5.8, pm25B: 5.3, humidity: 63, temperature: 57 },
    { pm25A: 6.4, pm25B: 6.0, humidity: 64, temperature: 55 },
    { pm25A: 6.6, pm25B: 6.1, humidity: 66, temperature: 54 },
    { pm25A: 4.4, pm25B: 4.2, humidity: 64, temperature: 57 },
    { pm25A: 5.9, pm25B: 5.4, humidity: 57, temperature: 62 },
    { pm25A: 4.0, pm25B: 3.5, humidity: 41, temperature: 70 },
    { pm25A: 3.1, pm25B: 2.5, humidity: 31, temperature: 76 },
  ];

  // Real coordinates: Leadville's own sensor (194415, "Sloan_zen-2") and the
  // two co-located sensors are ~0.0001-0.0007 degrees apart (a few meters);
  // "Lake fork" (316914) is a real but more distant neighbor (~0.07 degrees).
  const LEADVILLE_LAT = 39.25399;
  const LEADVILLE_LON = -106.28963;

  function realHistoryResponse(rows: typeof LEADVILLE_RAW) {
    const now = Math.floor(Date.now() / 1000);
    return new Response(
      JSON.stringify({
        fields: ["time_stamp", "humidity", "temperature", "pm2.5_cf_1_a", "pm2.5_cf_1_b"],
        data: rows.map((r, i) => [now - i * 3600, r.humidity, r.temperature, r.pm25A, r.pm25B]),
      }),
      { status: 200 },
    );
  }

  it("confirms and swaps to the nearest real stable neighbor, using real PurpleAir history for both the sensor and its peers", async () => {
    const location = await makeTestLocation("pa-replay-leadville-co");
    for (const row of LEADVILLE_RAW) {
      await insertReadingHistory(env.DB, location.id, calcAqi((row.pm25A + row.pm25B) / 2, row.humidity, row.temperature), 0);
    }

    const historyBySensor: Record<number, typeof LEADVILLE_RAW> = {
      183561: PEER_F877_RAW,
      183825: PEER_D54E_RAW,
      316914: PEER_LAKEFORK_RAW,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const historyMatch = url.match(/\/sensors\/(\d+)\/history\?/);
        if (historyMatch) {
          const sensorIndex = Number(historyMatch[1]);
          return realHistoryResponse(historyBySensor[sensorIndex]);
        }
        if (url.includes("/v1/sensors?")) {
          return peerListResponse([
            { sensorIndex: 183561, name: "Sloan_flex-f877", lat: 39.25388, lon: -106.29028, pm25A: 1.7, pm25B: 1.6 },
            { sensorIndex: 183825, name: "Sloan_flex-d54e", lat: 39.253956, lon: -106.289696, pm25A: 2.3, pm25B: 1.9 },
            { sensorIndex: 316914, name: "Lake fork", lat: 39.219322, lon: -106.352066, pm25A: 3.1, pm25B: 2.5 },
          ]);
        }
        throw new Error(`unexpected url in test: ${url}`);
      }),
    );

    const lastRow = LEADVILLE_RAW[LEADVILLE_RAW.length - 1];
    const reading = flatReading({
      aqi: calcAqi((lastRow.pm25A + lastRow.pm25B) / 2, lastRow.humidity, lastRow.temperature),
      lat: LEADVILLE_LAT,
      lon: LEADVILLE_LON,
    });

    const result = await checkAndHealErratic(env.DB, location, "key", reading);
    expect(result.outcome).toBe("confirmed");
    if (result.outcome === "confirmed") {
      expect(result.stablePeerCount).toBe(3);
      expect(result.swappedTo.sensorIndex).toBe(183825); // Sloan_flex-d54e - nearest of the three real stable neighbors
    }

    const updated = await getLocationBySlug(env.DB, "pa-replay-leadville-co");
    expect(updated?.sensor_index).toBe(183825);
  });
});
