import { calcAqi, levelIndexForAqi } from "./aqi";
import { getPastReading, insertReadingHistory, updateLocationReading } from "./db";
import type { LocationRow } from "./types";

// How far back to look for a "was X ~Nm ago" comparison point.
export const TREND_LOOKBACK_MINUTES = 30;

// How recent a cached reading has to be before a user-triggered request
// (e.g. /subscribe) will reuse it instead of hitting PurpleAir again. Keeps
// a burst of subscribes to the same popular location from each costing a
// separate PurpleAir API call - the scheduled poll already refreshes every
// location on its own 10-min cadence regardless.
const SUBSCRIBE_FRESHNESS_MINUTES = 5;

const FIELDS = "pm2.5_cf_1_a,pm2.5_cf_1_b,humidity,temperature,last_seen,name";

interface PurpleAirSensorResponse {
  sensor: {
    name?: string;
    last_seen?: number;
    humidity?: number;
    temperature?: number;
    "pm2.5_cf_1_a"?: number;
    "pm2.5_cf_1_b"?: number;
  };
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

// Fetches a fresh reading for a location and records it in D1. Shared by the
// scheduled poll and the /subscribe command, which both want the same
// fetch-then-persist behavior. Also returns the closest reading from
// ~TREND_LOOKBACK_MINUTES ago (if any) so callers can report "was X ~Nm ago".
export async function refreshLocationReading(db: D1Database, location: LocationRow, apiKey: string) {
  const reading = await fetchSensorReading(location.sensor_index, apiKey);
  const levelIdx = levelIndexForAqi(reading.aqi);

  const past = await getPastReading(db, location.id, TREND_LOOKBACK_MINUTES);

  await updateLocationReading(db, location.id, reading.aqi, levelIdx);
  await insertReadingHistory(db, location.id, reading.aqi, levelIdx);

  return { reading, levelIdx, past: past ?? null };
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
    return { aqi: location.last_aqi, levelIdx: location.last_level, past: past ?? null };
  }

  const { reading, levelIdx, past } = await refreshLocationReading(db, location, apiKey);
  return { aqi: reading.aqi, levelIdx, past };
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

// Finds the closest active PurpleAir sensor to (lat, lon), for auto-discovery
// when a user runs /addlocation with just a slug (no sensor_index).
export async function findNearestSensor(lat: number, lon: number, apiKey: string): Promise<NearbySensor | null> {
  const url =
    `https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,last_seen` +
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
    const lastSeen = row[col.last_seen] as number;
    if (nowSeconds - lastSeen > MAX_SENSOR_STALE_SECONDS) continue;

    const sLat = row[col.latitude] as number;
    const sLon = row[col.longitude] as number;
    const distanceDegrees = Math.hypot(sLat - lat, sLon - lon);

    if (!best || distanceDegrees < best.distanceDegrees) {
      best = { sensorIndex: row[col.sensor_index] as number, name: row[col.name] as string, distanceDegrees };
    }
  }

  return best;
}
