import { describe, expect, it } from "vitest";
import AqiMath from "./public/aqi-math.js";

const { correctPm25, aqiFromPm25 } = AqiMath;

describe("correctPm25", () => {
  it("applies the standard Barkjohn correction below 343 ug/m3", () => {
    const corrected = correctPm25(20, 50, 20);
    expect(corrected).toBeCloseTo(0.541 * 20 - 0.0618 * 50 + 0.00534 * 20 + 3.634, 5);
  });

  it("applies the high-concentration correction at/above 343 ug/m3", () => {
    const raw = 400;
    const corrected = correctPm25(raw, 50, 20);
    expect(corrected).toBeCloseTo(0.46 * raw + 3.93e-4 * raw ** 2 + 2.97, 5);
  });

  it("never goes negative even when the correction would", () => {
    expect(correctPm25(0, 100, 0)).toBeGreaterThanOrEqual(0);
  });
});

// Same table as "calcAqi at exact threshold boundaries" in test/aqi.test.ts
// (src/aqi.ts), at rh=0/temp=0 so the correction is easy to solve exactly.
// This is the actual anti-drift check: the chart on the docs page
// duplicates src/aqi.ts's formula rather than importing it (the page has no
// build step), so nothing else would catch the two silently diverging if
// one changed without the other.
describe("aqi-math.js matches src/aqi.ts at every alert-threshold boundary", () => {
  it.each([
    [9.42, 49],
    [9.76, 50],
    [9.92, 51],
    [57.23, 99],
    [58.23, 100],
    [58.72, 101],
    [94.56, 149],
    [95.32, 150],
    [95.69, 151],
    [221.13, 199],
    [223.76, 200],
    [225.08, 201],
    [365.89, 299],
    [367.24, 300],
    [367.91, 301],
  ])("raw PM2.5 %f -> AQI %i", (pm25, expectedAqi) => {
    expect(aqiFromPm25(correctPm25(pm25, 0, 0))).toBe(expectedAqi);
  });
});
