// Free geocoding via OpenStreetMap Nominatim - no API key needed. Usage
// policy requires a descriptive User-Agent and caps us at ~1 req/sec:
// https://operations.osmfoundation.org/policies/nominatim/
// Fine for this on-demand, one-at-a-time use case (a user running
// /addlocation); if this ever needs to scale up, swap in a paid geocoder.
const USER_AGENT = "purple-air-notification (https://github.com/ericthomson13/purple-air-notification)";

export interface GeocodedPlace {
  lat: number;
  lon: number;
}

export async function geocodeCityState(city: string, state: string): Promise<GeocodedPlace | null> {
  const url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&countrycodes=us,ca&format=json&limit=1`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

  if (!res.ok) {
    throw new Error(`Nominatim error ${res.status}: ${await res.text()}`);
  }

  const results = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (results.length === 0) return null;

  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}
