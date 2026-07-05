import { calcAqi, levelIndexForAqi } from "./aqi";
import { getPastReading, insertReadingHistory, updateLocationReading, updateLocationSensor } from "./db";
import type { LocationRow } from "./types";

// How far back to look for a "was X ~Nm ago" comparison point.
export const TREND_LOOKBACK_MINUTES = 30;

// How recent a cached reading has to be before a user-triggered request
// (e.g. /subscribe) will reuse it instead of hitting PurpleAir again. Keeps
// a burst of subscribes to the same popular location from each costing a
// separate PurpleAir API call - the scheduled poll already refreshes every
// location on its own 10-min cadence regardless.
const SUBSCRIBE_FRESHNESS_MINUTES = 5;

const FIELDS = "pm2.5_cf_1_a,pm2.5_cf_1_b,humidity,temperature,last_seen,name,latitude,longitude";

interface PurpleAirSensorResponse {
  sensor: {
    name?: string;
    last_seen?: number;
    humidity?: number;
    temperature?: number;
    latitude?: number;
    longitude?: number;
    "pm2.5_cf_1_a"?: number;
    "pm2.5_cf_1_b"?: number;
  };
}

// A PurpleAir sensor has two independent PM2.5 channels (A/B) that should
// roughly agree; when one is fouled (dust, bugs, moisture) it can report
// wildly high or low readings while the other channel keeps reading
// normally. Averaging the two then produces a bogus AQI instead of just a
// noisy one - e.g. a real case we hit: channel A read 4593 while channel B
// read 3, averaging out to an AQI over 6000. Ignore divergence below
// CHANNEL_DIVERGENCE_MIN_PM25 since relative differences at low readings are
// just sensor noise, not signal.
const CHANNEL_DIVERGENCE_MIN_PM25 = 10;
const CHANNEL_DIVERGENCE_RATIO = 3;

function channelsDiverge(pm25A: number, pm25B: number): boolean {
  const hi = Math.max(pm25A, pm25B);
  const lo = Math.min(pm25A, pm25B);
  return hi > CHANNEL_DIVERGENCE_MIN_PM25 && hi / Math.max(lo, 0.1) > CHANNEL_DIVERGENCE_RATIO;
}

// Thrown instead of returning a bogus AQI when a sensor's A/B channels
// disagree too much to trust their average. Carries the sensor's own
// coordinates (from PurpleAir, not the location row - which isn't always
// populated) so callers can search for a nearby replacement.
export class SensorDivergenceError extends Error {
  constructor(
    public readonly sensorIndex: number,
    public readonly lat: number | null,
    public readonly lon: number | null,
  ) {
    super(`PurpleAir sensor ${sensorIndex} has diverging A/B channels - reading is unreliable`);
    this.name = "SensorDivergenceError";
  }
}

export interface SensorReading {
  aqi: number;
  pm25CfAtmAvg: number;
  humidity: number;
  temperature: number;
  lastSeen: number;
  staleSeconds: number;
}

const MAX_STALE_SECONDS = 60 * 60; // 1 hour

export async function fetchSensorReading(sensorIndex: number, apiKey: string): Promise<SensorReading> {
  const url = `https://api.purpleair.com/v1/sensors/${sensorIndex}?fields=${FIELDS}`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });

  if (!res.ok) {
    throw new Error(`PurpleAir API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as PurpleAirSensorResponse;
  const s = data.sensor;

  const pm25A = s["pm2.5_cf_1_a"];
  const pm25B = s["pm2.5_cf_1_b"];
  if (pm25A === undefined || pm25B === undefined || s.humidity === undefined || s.temperature === undefined || s.last_seen === undefined) {
    throw new Error(`PurpleAir sensor ${sensorIndex} is missing required fields`);
  }

  if (channelsDiverge(pm25A, pm25B)) {
    throw new SensorDivergenceError(sensorIndex, s.latitude ?? null, s.longitude ?? null);
  }

  const pm25CfAtmAvg = (pm25A + pm25B) / 2;
  const staleSeconds = Math.floor(Date.now() / 1000) - s.last_seen;

  if (staleSeconds > MAX_STALE_SECONDS) {
    throw new Error(`PurpleAir sensor ${sensorIndex} data is stale (${Math.round(staleSeconds / 60)} min old)`);
  }

  const aqi = calcAqi(pm25CfAtmAvg, s.humidity, s.temperature);

  return {
    aqi,
    pm25CfAtmAvg,
    humidity: s.humidity,
    temperature: s.temperature,
    lastSeen: s.last_seen,
    staleSeconds,
  };
}

// When a location's sensor turns out to have diverging A/B channels (see
// SensorDivergenceError), look for a nearby healthy replacement and, if one
// exists, swap the location over to it and retry. Used by
// refreshLocationReading so both the scheduled poll and user-triggered reads
// self-heal instead of repeating the same bad reading forever. Rethrows the
// original error if no replacement is available (or the replacement also
// fails), so callers can tell the difference between "transient failure" and
// "needs a human to pick a new sensor" - see SensorDivergenceError.
async function fetchReadingWithSensorHealing(
  db: D1Database,
  location: LocationRow,
  apiKey: string,
): Promise<{ reading: SensorReading; swappedTo: NearbySensor | null }> {
  try {
    const reading = await fetchSensorReading(location.sensor_index, apiKey);
    return { reading, swappedTo: null };
  } catch (err) {
    if (!(err instanceof SensorDivergenceError) || err.lat === null || err.lon === null) throw err;

    const replacement = await findNearestSensor(err.lat, err.lon, apiKey, location.sensor_index);
    if (!replacement) throw err;

    const reading = await fetchSensorReading(replacement.sensorIndex, apiKey);
    await updateLocationSensor(db, location.id, replacement.sensorIndex);
    console.warn(
      `Location ${location.slug}: sensor ${location.sensor_index} had diverging A/B channels, switched to nearby sensor ${replacement.sensorIndex} (${replacement.name})`,
    );
    return { reading, swappedTo: replacement };
  }
}

// Fetches a fresh reading for a location and records it in D1. Shared by the
// scheduled poll and the /subscribe command, which both want the same
// fetch-then-persist behavior. Also returns the closest reading from
// ~TREND_LOOKBACK_MINUTES ago (if any) so callers can report "was X ~Nm ago".
export async function refreshLocationReading(db: D1Database, location: LocationRow, apiKey: string) {
  const { reading, swappedTo } = await fetchReadingWithSensorHealing(db, location, apiKey);
  const levelIdx = levelIndexForAqi(reading.aqi);

  const past = await getPastReading(db, location.id, TREND_LOOKBACK_MINUTES);

  await updateLocationReading(db, location.id, reading.aqi, levelIdx);
  await insertReadingHistory(db, location.id, reading.aqi, levelIdx);

  return { reading, levelIdx, past: past ?? null, swappedTo };
}

// Like refreshLocationReading, but reuses the cached D1 value (no PurpleAir
// call) if it was checked within SUBSCRIBE_FRESHNESS_MINUTES. Used by
// user-triggered paths (/subscribe, /addlocation on an existing slug) so a
// burst of activity on one location doesn't turn into a burst of API calls.
export async function getFreshReading(db: D1Database, location: LocationRow, apiKey: string) {
  const cachedAgeMinutes = location.last_checked_at
    ? (Date.now() - new Date(`${location.last_checked_at}Z`).getTime()) / 60_000
    : Infinity;

  if (cachedAgeMinutes < SUBSCRIBE_FRESHNESS_MINUTES && location.last_aqi !== null && location.last_level !== null) {
    const past = await getPastReading(db, location.id, TREND_LOOKBACK_MINUTES);
    return { aqi: location.last_aqi, levelIdx: location.last_level, past: past ?? null, swappedTo: null as NearbySensor | null };
  }

  const { reading, levelIdx, past, swappedTo } = await refreshLocationReading(db, location, apiKey);
  return { aqi: reading.aqi, levelIdx, past, swappedTo };
}

export interface NearbySensor {
  sensorIndex: number;
  name: string;
  distanceDegrees: number;
}

// Roughly ~10 miles at mid-latitudes - tight enough to avoid picking a
// sensor from the wrong town, wide enough to usually find something.
const SEARCH_BOX_DEGREES = 0.15;
const MAX_SENSOR_STALE_SECONDS = 60 * 60;

interface PurpleAirSensorsListResponse {
  fields: string[];
  data: Array<Array<number | string>>;
}

// Finds the closest active, healthy PurpleAir sensor to (lat, lon) - used
// both for auto-discovery when a user runs /addlocation with just a slug,
// and to find a replacement when a location's current sensor turns out to
// have diverging A/B channels (in which case excludeSensorIndex is that
// sensor, so we don't just find it again).
export async function findNearestSensor(lat: number, lon: number, apiKey: string, excludeSensorIndex?: number): Promise<NearbySensor | null> {
  const url =
    `https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,last_seen,pm2.5_cf_1_a,pm2.5_cf_1_b` +
    `&nwlat=${lat + SEARCH_BOX_DEGREES}&nwlng=${lon - SEARCH_BOX_DEGREES}` +
    `&selat=${lat - SEARCH_BOX_DEGREES}&selng=${lon + SEARCH_BOX_DEGREES}`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });

  if (!res.ok) {
    throw new Error(`PurpleAir API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as PurpleAirSensorsListResponse;
  const col = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  const nowSeconds = Math.floor(Date.now() / 1000);

  let best: NearbySensor | null = null;
  for (const row of data.data) {
    const sensorIndex = row[col.sensor_index] as number;
    if (sensorIndex === excludeSensorIndex) continue;

    const lastSeen = row[col.last_seen] as number;
    if (nowSeconds - lastSeen > MAX_SENSOR_STALE_SECONDS) continue;

    const pm25A = row[col["pm2.5_cf_1_a"]] as number;
    const pm25B = row[col["pm2.5_cf_1_b"]] as number;
    if (channelsDiverge(pm25A, pm25B)) continue;

    const sLat = row[col.latitude] as number;
    const sLon = row[col.longitude] as number;
    const distanceDegrees = Math.hypot(sLat - lat, sLon - lon);

    if (!best || distanceDegrees < best.distanceDegrees) {
      best = { sensorIndex, name: row[col.name] as string, distanceDegrees };
    }
  }

  return best;
}
