import type { LocationRow } from "../src/types";

export function makeLocation(overrides: Partial<LocationRow> = {}): LocationRow {
  return {
    id: 1,
    slug: "test-co",
    name: "Test, CO",
    sensor_index: 1,
    lat: null,
    lon: null,
    last_aqi: null,
    last_level: null,
    last_checked_at: null,
    added_by_chat_id: null,
    ...overrides,
  };
}
