import { calcAqi, levelIndexForAqi } from "./aqi";
import { getPastReading, getRecentReadings, insertReadingHistory, updateLocationReading, updateLocationSensor } from "./db";
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

// A/B divergence doesn't catch every failure mode - a real case we hit: a
// Leadville, CO sensor kept reporting on schedule (so it never went stale)
// with its A/B channels agreeing with each other, but its AQI barely moved
// for an entire day while other Leadville sensors nearby showed normal
// variation. That's a stuck/flatlined sensor, not a channel disagreement -
// see checkAndHealFlatline.

// ~3h of history at the 10-min poll cadence - the window checked for variance.
const FLATLINE_LOOKBACK_ROWS = 18;
// ~2h of history required before judging a location at all - below this
// (e.g. a location added minutes ago) there isn't enough data to trust, so
// skip rather than risk a false positive on day one.
const MIN_HISTORY_ROWS_FOR_FLATLINE_CHECK = 12;
// Real PM2.5 sensors show measurable instrument noise and diurnal drift;
// sitting inside a 2-point AQI band for 2+ hours is far more consistent with
// a frozen reading pipeline than real air.
const FLATLINE_MAX_AQI_RANGE = 2;
// Require several independent healthy neighbors before trusting a peer
// comparison enough to act on it - this can rewrite a location's
// sensor_index unattended across every registered location, so a single
// possibly-also-miscalibrated neighbor isn't enough to confirm.
const MIN_PEER_COUNT_FOR_FLATLINE_CONFIRMATION = 3;
// Required gap between the flatlined sensor's value and the peer median to
// call it confirmed. Chosen well above normal sensor-to-sensor/correction
// noise, but well below the swings a real pollution event (smoke, dust)
// would produce - which a genuinely stuck sensor would completely miss.
const FLATLINE_PEER_GAP_MIN_AQI = 15;

// The inverse failure mode - a real case we hit: a Leadville, CO sensor
// swung between AQI ~1 and 100+ on a roughly 24h cycle, while two sensors a
// few meters away at the same physical site stayed under an AQI range of 5
// for 48 straight hours. A/B divergence and the flatline check both miss
// this - the sensor's own channels agree and its value is anything but flat.
// See checkAndHealErratic.
const ERRATIC_LOOKBACK_ROWS = FLATLINE_LOOKBACK_ROWS;
const MIN_HISTORY_ROWS_FOR_ERRATIC_CHECK = MIN_HISTORY_ROWS_FOR_FLATLINE_CHECK;
// A swing this big within ~3h is well beyond ordinary sensor noise - but a
// fast-moving real smoke plume could plausibly cause it too, which is
// exactly why this is only a *candidate* threshold, not a verdict:
// confirmation requires nearby sensors' own history over the same window to
// have stayed comparatively calm (see below), not just a live snapshot.
const ERRATIC_MIN_AQI_RANGE = 60;
// Bounds how many nearby peers' full history we fetch - each is a separate
// PurpleAir API call, only spent once our own reading already looks
// erratic, and only for the closest candidates.
const MAX_PEERS_TO_CHECK_HISTORY = 5;
// Require several peers to agree the area was calm, not just one - same
// reasoning as MIN_PEER_COUNT_FOR_FLATLINE_CONFIRMATION: this can rewrite a
// location's sensor_index unattended.
const MIN_STABLE_PEERS_FOR_ERRATIC_CONFIRMATION = 3;
// A peer counts as "stable" if its own history stayed within this AQI range
// over the same lookback window - looser than FLATLINE_MAX_AQI_RANGE since
// this only needs to be "calm relative to us," not perfectly flat.
const PEER_HISTORY_MAX_AQI_RANGE = 15;
// ~3h, matching ERRATIC_LOOKBACK_ROWS at the 10-min poll cadence - the same
// window our own history check looks at, so the comparison is apples-to-apples.
const ERRATIC_HISTORY_LOOKBACK_SECONDS = ERRATIC_LOOKBACK_ROWS * 10 * 60;

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
  // Sensor's own coordinates from PurpleAir, not the location row's (which
  // isn't always populated - see LocationRow.lat/lon). Used by
  // checkAndHealFlatline to search for peer sensors to compare against.
  lat: number | null;
  lon: number | null;
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
    lat: s.latitude ?? null,
    lon: s.longitude ?? null,
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

    let reading: SensorReading;
    try {
      reading = await fetchSensorReading(replacement.sensorIndex, apiKey);
    } catch (replacementErr) {
      // The replacement looked healthy in the sensors-list search, but
      // failed on the individual fetch (e.g. it went stale in the interim,
      // or - as happened with a real "nearest" candidate that reports only
      // one PM2.5 channel - the list response doesn't reveal a field is
      // actually missing). Report this the same as "no replacement found"
      // rather than leaking an unrelated error type the caller doesn't
      // know how to handle.
      console.error(`Replacement sensor ${replacement.sensorIndex} for location ${location.slug} also failed to fetch:`, replacementErr);
      throw err;
    }

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

    const pm25A = row[col["pm2.5_cf_1_a"]] as number | null;
    const pm25B = row[col["pm2.5_cf_1_b"]] as number | null;
    // Single-channel sensors report one of these as null in the list
    // response (and omit it entirely from the per-sensor endpoint) - skip
    // them, since fetchSensorReading requires both channels.
    if (pm25A === null || pm25B === null || channelsDiverge(pm25A, pm25B)) continue;

    const sLat = row[col.latitude] as number;
    const sLon = row[col.longitude] as number;
    const distanceDegrees = Math.hypot(sLat - lat, sLon - lon);

    if (!best || distanceDegrees < best.distanceDegrees) {
      best = { sensorIndex, name: row[col.name] as string, distanceDegrees };
    }
  }

  return best;
}

export interface PeerReading {
  sensorIndex: number;
  name: string;
  aqi: number;
  distanceDegrees: number;
}

// Finds nearby healthy PurpleAir sensors' current AQI, for comparing against
// a location's own possibly-flatlined value (see checkAndHealFlatline).
// Deliberately kept separate from findNearestSensor rather than sharing its
// fetch/filter logic - that function's existing tests use mock list
// responses that omit humidity/temperature entirely, and this needs both to
// compute AQI via calcAqi.
export async function findPeerAqiReadings(lat: number, lon: number, apiKey: string, excludeSensorIndex: number): Promise<PeerReading[]> {
  const url =
    `https://api.purpleair.com/v1/sensors?fields=name,latitude,longitude,last_seen,pm2.5_cf_1_a,pm2.5_cf_1_b,humidity,temperature` +
    `&nwlat=${lat + SEARCH_BOX_DEGREES}&nwlng=${lon - SEARCH_BOX_DEGREES}` +
    `&selat=${lat - SEARCH_BOX_DEGREES}&selng=${lon + SEARCH_BOX_DEGREES}`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });

  if (!res.ok) {
    throw new Error(`PurpleAir API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as PurpleAirSensorsListResponse;
  const col = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  const nowSeconds = Math.floor(Date.now() / 1000);

  const peers: PeerReading[] = [];
  for (const row of data.data) {
    const sensorIndex = row[col.sensor_index] as number;
    if (sensorIndex === excludeSensorIndex) continue;

    const lastSeen = row[col.last_seen] as number;
    if (nowSeconds - lastSeen > MAX_SENSOR_STALE_SECONDS) continue;

    const pm25A = row[col["pm2.5_cf_1_a"]] as number | null;
    const pm25B = row[col["pm2.5_cf_1_b"]] as number | null;
    const humidity = row[col.humidity] as number | null;
    const temperature = row[col.temperature] as number | null;
    if (pm25A === null || pm25B === null || humidity === null || temperature === null || channelsDiverge(pm25A, pm25B)) continue;

    const sLat = row[col.latitude] as number;
    const sLon = row[col.longitude] as number;
    const distanceDegrees = Math.hypot(sLat - lat, sLon - lon);
    const aqi = calcAqi((pm25A + pm25B) / 2, humidity, temperature);

    peers.push({ sensorIndex, name: row[col.name] as string, aqi, distanceDegrees });
  }

  return peers.sort((a, b) => a.distanceDegrees - b.distanceDegrees);
}

export type FlatlineCheckResult =
  | { outcome: "insufficient_history" | "not_flat" | "no_coordinates" }
  | { outcome: "insufficient_peers"; peerCount: number }
  | { outcome: "peers_agree"; peerMedianAqi: number; peerCount: number }
  | { outcome: "confirmed"; swappedTo: PeerReading; peerMedianAqi: number; peerCount: number; range: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Checks whether a location's sensor looks stuck (see the comment above
// FLATLINE_LOOKBACK_ROWS) and, if nearby healthy peers confirm it's actually
// wrong - not just a genuinely calm/stable day - swaps the location to the
// closest one, the same way divergence self-heal does. Called after
// refreshLocationReading persists a new reading, since it needs
// readings_history. Doesn't send any notifications itself (no Env/bot token
// at this layer) - callers decide what to tell users/admins from the
// returned outcome.
export async function checkAndHealFlatline(
  db: D1Database,
  location: LocationRow,
  apiKey: string,
  reading: SensorReading,
): Promise<FlatlineCheckResult> {
  const { results: recent } = await getRecentReadings(db, location.id, FLATLINE_LOOKBACK_ROWS);
  if (recent.length < MIN_HISTORY_ROWS_FOR_FLATLINE_CHECK) return { outcome: "insufficient_history" };

  const aqis = recent.map((r) => r.aqi);
  const range = Math.max(...aqis) - Math.min(...aqis);
  if (range > FLATLINE_MAX_AQI_RANGE) return { outcome: "not_flat" };

  if (reading.lat === null || reading.lon === null) return { outcome: "no_coordinates" };

  const peers = await findPeerAqiReadings(reading.lat, reading.lon, apiKey, location.sensor_index);
  if (peers.length < MIN_PEER_COUNT_FOR_FLATLINE_CONFIRMATION) return { outcome: "insufficient_peers", peerCount: peers.length };

  const peerMedianAqi = median(peers.map((p) => p.aqi));
  if (Math.abs(reading.aqi - peerMedianAqi) < FLATLINE_PEER_GAP_MIN_AQI) {
    return { outcome: "peers_agree", peerMedianAqi, peerCount: peers.length };
  }

  const swappedTo = peers[0];
  await updateLocationSensor(db, location.id, swappedTo.sensorIndex);
  console.warn(
    `Location ${location.slug}: sensor ${location.sensor_index} looked flatlined (AQI range ${range} over ${recent.length} readings) ` +
      `while ${peers.length} nearby sensors averaged ${peerMedianAqi} - switched to sensor ${swappedTo.sensorIndex} (${swappedTo.name})`,
  );
  return { outcome: "confirmed", swappedTo, peerMedianAqi, peerCount: peers.length, range };
}

interface PurpleAirHistoryResponse {
  fields: string[];
  data: Array<Array<number | null>>;
}

// A sensor's own AQI history over the last `lookbackSeconds` - used to check
// whether a candidate peer's readings actually stayed calm over the same
// window a location's own sensor looked erratic (see checkAndHealErratic).
// PurpleAir's history endpoint doesn't echo fields back in the order
// requested (confirmed by hand against the live API), so - same as
// findPeerAqiReadings - field positions are looked up from the response's
// own `fields` array rather than assumed.
async function fetchSensorHistory(sensorIndex: number, apiKey: string, lookbackSeconds: number): Promise<number[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - lookbackSeconds;
  const url =
    `https://api.purpleair.com/v1/sensors/${sensorIndex}/history?start_timestamp=${start}&end_timestamp=${end}` +
    `&average=10&fields=pm2.5_cf_1_a,pm2.5_cf_1_b,humidity,temperature`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });

  if (!res.ok) {
    throw new Error(`PurpleAir API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as PurpleAirHistoryResponse;
  const col = Object.fromEntries(data.fields.map((f, i) => [f, i]));

  const aqis: number[] = [];
  for (const row of data.data) {
    const pm25A = row[col["pm2.5_cf_1_a"]];
    const pm25B = row[col["pm2.5_cf_1_b"]];
    const humidity = row[col.humidity];
    const temperature = row[col.temperature];
    if (pm25A === null || pm25A === undefined || pm25B === null || pm25B === undefined) continue;
    if (humidity === null || humidity === undefined || temperature === null || temperature === undefined) continue;
    if (channelsDiverge(pm25A, pm25B)) continue;
    aqis.push(calcAqi((pm25A + pm25B) / 2, humidity, temperature));
  }
  return aqis;
}

export type ErraticCheckResult =
  | { outcome: "insufficient_history" | "not_erratic" | "no_coordinates" }
  | { outcome: "insufficient_stable_peers"; stablePeerCount: number; checkedPeerCount: number }
  | { outcome: "confirmed"; swappedTo: PeerReading; ownRange: number; stablePeerCount: number };

// Checks whether a location's sensor looks erratic (see the comment above
// ERRATIC_MIN_AQI_RANGE) and, if enough nearby healthy peers' own history
// confirms they stayed calm over the same window - not just a live snapshot,
// which an erratic sensor could pass or fail depending on the moment it
// happens to be checked - swaps the location to the closest stable one.
// Called after refreshLocationReading persists a new reading, since it needs
// readings_history. Doesn't send any notifications itself (no Env/bot token
// at this layer) - callers decide what to tell users/admins from the
// returned outcome.
export async function checkAndHealErratic(
  db: D1Database,
  location: LocationRow,
  apiKey: string,
  reading: SensorReading,
): Promise<ErraticCheckResult> {
  const { results: recent } = await getRecentReadings(db, location.id, ERRATIC_LOOKBACK_ROWS);
  if (recent.length < MIN_HISTORY_ROWS_FOR_ERRATIC_CHECK) return { outcome: "insufficient_history" };

  const aqis = recent.map((r) => r.aqi);
  const ownRange = Math.max(...aqis) - Math.min(...aqis);
  if (ownRange < ERRATIC_MIN_AQI_RANGE) return { outcome: "not_erratic" };

  if (reading.lat === null || reading.lon === null) return { outcome: "no_coordinates" };

  const peers = await findPeerAqiReadings(reading.lat, reading.lon, apiKey, location.sensor_index);
  const candidates = peers.slice(0, MAX_PEERS_TO_CHECK_HISTORY);

  const stablePeers: PeerReading[] = [];
  for (const peer of candidates) {
    let history: number[];
    try {
      history = await fetchSensorHistory(peer.sensorIndex, apiKey, ERRATIC_HISTORY_LOOKBACK_SECONDS);
    } catch (err) {
      console.error(`Failed to fetch history for candidate peer ${peer.sensorIndex}:`, err);
      continue;
    }
    if (history.length < MIN_HISTORY_ROWS_FOR_ERRATIC_CHECK) continue;
    const peerRange = Math.max(...history) - Math.min(...history);
    if (peerRange <= PEER_HISTORY_MAX_AQI_RANGE) stablePeers.push(peer);
  }

  if (stablePeers.length < MIN_STABLE_PEERS_FOR_ERRATIC_CONFIRMATION) {
    return { outcome: "insufficient_stable_peers", stablePeerCount: stablePeers.length, checkedPeerCount: candidates.length };
  }

  const swappedTo = stablePeers[0]; // nearest stable peer - candidates was distance-sorted
  await updateLocationSensor(db, location.id, swappedTo.sensorIndex);
  console.warn(
    `Location ${location.slug}: sensor ${location.sensor_index} looked erratic (AQI range ${ownRange} over ${recent.length} readings) ` +
      `while ${stablePeers.length} nearby sensors stayed stable - switched to sensor ${swappedTo.sensorIndex} (${swappedTo.name})`,
  );
  return { outcome: "confirmed", swappedTo, ownRange, stablePeerCount: stablePeers.length };
}
