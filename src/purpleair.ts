import { calcAqi, levelIndexForAqi } from "./aqi";
import { updateLocationReading } from "./db";
import type { LocationRow } from "./types";

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
// fetch-then-persist behavior.
export async function refreshLocationReading(db: D1Database, location: LocationRow, apiKey: string) {
  const reading = await fetchSensorReading(location.sensor_index, apiKey);
  const levelIdx = levelIndexForAqi(reading.aqi);
  await updateLocationReading(db, location.id, reading.aqi, levelIdx);
  return { reading, levelIdx };
}
