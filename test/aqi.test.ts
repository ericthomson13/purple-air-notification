import { describe, expect, it } from "vitest";
import { AQI_LEVELS, calcAqi, correctPm25, dangerZoneNote, levelForAqi, levelIndexForAqi } from "../src/aqi";

describe("correctPm25", () => {
  it("applies the standard Barkjohn correction below 343 ug/m3", () => {
    // Values chosen to land well under the high-concentration branch cutoff.
    const corrected = correctPm25(20, 50, 20);
    expect(corrected).toBeCloseTo(0.541 * 20 - 0.0618 * 50 + 0.00534 * 20 + 3.634, 5);
  });

  it("applies the high-concentration correction at/above 343 ug/m3", () => {
    const raw = 400;
    const corrected = correctPm25(raw, 50, 20);
    expect(corrected).toBeCloseTo(0.46 * raw + 3.93e-4 * raw ** 2 + 2.97, 5);
  });
});

describe("calcAqi", () => {
  it("never returns a negative AQI even if correction goes negative", () => {
    // Very low PM2.5 with high humidity can push the correction below zero.
    const aqi = calcAqi(0, 100, 0);
    expect(aqi).toBeGreaterThanOrEqual(0);
  });

  it("maps a clean reading into the Good range", () => {
    const aqi = calcAqi(5, 30, 20);
    expect(aqi).toBeLessThanOrEqual(50);
  });

  it("maps a heavy smoke reading into the upper AQI range", () => {
    const aqi = calcAqi(500, 30, 20);
    expect(aqi).toBeGreaterThan(300);
  });
});

describe("levelForAqi / levelIndexForAqi", () => {
  it.each([
    [0, "Good"],
    [50, "Good"],
    [51, "Moderate"],
    [100, "Moderate"],
    [101, "Unhealthy for Sensitive Groups"],
    [150, "Unhealthy for Sensitive Groups"],
    [151, "Unhealthy"],
    [200, "Unhealthy"],
    [201, "Very Unhealthy"],
    [300, "Very Unhealthy"],
    [301, "Hazardous"],
    [1000, "Hazardous"],
  ])("AQI %i is level %s", (aqi, name) => {
    expect(levelForAqi(aqi).name).toBe(name);
  });

  it("levelIndexForAqi matches the index of levelForAqi's result", () => {
    for (const aqi of [0, 50, 51, 150, 151, 300, 301, 500]) {
      const idx = levelIndexForAqi(aqi);
      expect(AQI_LEVELS[idx]).toBe(levelForAqi(aqi));
    }
  });
});

describe("dangerZoneNote", () => {
  it("is empty below 100", () => {
    expect(dangerZoneNote(99)).toBe("");
  });

  it("includes a link at exactly 100 and above", () => {
    expect(dangerZoneNote(100)).toContain("http");
    expect(dangerZoneNote(150)).toContain("http");
  });
});
