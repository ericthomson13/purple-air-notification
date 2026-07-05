// EPA AQI breakpoints for PM2.5, effective 2024-05-06 (40 CFR Part 58, Appendix G).
// https://www.epa.gov/system/files/documents/2024-02/pm-naaqs-air-quality-index-fact-sheet.pdf
const PM25_BREAKPOINTS = [
  { cLow: 0.0, cHigh: 9.0, iLow: 0, iHigh: 50 },
  { cLow: 9.1, cHigh: 35.4, iLow: 51, iHigh: 100 },
  { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150 },
  { cLow: 55.5, cHigh: 125.4, iLow: 151, iHigh: 200 },
  { cLow: 125.5, cHigh: 225.4, iLow: 201, iHigh: 300 },
  { cLow: 225.5, cHigh: 325.4, iLow: 301, iHigh: 500 },
] as const;

export interface AqiLevel {
  threshold: number;
  name: string;
  color: string;
  emoji: string;
}

// Alert thresholds requested for this project: 50 / 100 / 150 / 200 / 300.
// These line up exactly with the 2024 EPA breakpoints above.
export const AQI_LEVELS: AqiLevel[] = [
  { threshold: 50, name: "Good", color: "#00e400", emoji: "🟢" },
  { threshold: 100, name: "Moderate", color: "#ffff00", emoji: "🟡" },
  { threshold: 150, name: "Unhealthy for Sensitive Groups", color: "#ff7e00", emoji: "🟠" },
  { threshold: 200, name: "Unhealthy", color: "#ff0000", emoji: "🔴" },
  { threshold: 300, name: "Very Unhealthy", color: "#8f3f97", emoji: "🟣" },
  { threshold: Infinity, name: "Hazardous", color: "#7e0023", emoji: "🟤" },
];

export const AQI_HEALTH_INFO_URL = "https://www.airnow.gov/aqi/aqi-basics/";

// PurpleAir's own map defaults to showing AQI from raw, uncorrected PM2.5,
// which is well documented to overestimate true air quality - especially in
// dry, high-altitude conditions (exactly where we've seen ~20pt gaps from
// what this bot reports). Shown next to every AQI value so that gap doesn't
// read as a bug when someone compares against PurpleAir's site directly.
export const AQI_CORRECTION_NOTE = "EPA-corrected";

// Once AQI hits 100+ it's worth a direct pointer to what that means, not
// just in the threshold-crossing alert.
export function dangerZoneNote(aqi: number): string {
  return aqi >= 100 ? `\nFind more details: ${AQI_HEALTH_INFO_URL}` : "";
}

export function levelForAqi(aqi: number): AqiLevel {
  return AQI_LEVELS.find((level) => aqi <= level.threshold) ?? AQI_LEVELS[AQI_LEVELS.length - 1];
}

export function levelIndexForAqi(aqi: number): number {
  return AQI_LEVELS.findIndex((level) => aqi <= level.threshold);
}

function calcAqiFromPm25(pm25: number): number {
  const bp = PM25_BREAKPOINTS.find((b) => pm25 <= b.cHigh) ?? PM25_BREAKPOINTS[PM25_BREAKPOINTS.length - 1];
  const { cLow, cHigh, iLow, iHigh } = bp;
  return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (pm25 - cLow) + iLow);
}

// US EPA correction for PurpleAir PM2.5 (Barkjohn et al. 2021, AMT 14, 4617-4637).
// https://amt.copernicus.org/articles/14/4617/2021/
// Two-piece fit: standard formula below ~343 ug/m3 (cf_1, avg of channel A/B),
// a separate high-concentration fit above that (relevant during heavy wildfire smoke).
export function correctPm25(pm25CfAtmAvg: number, humidity: number, temperature: number): number {
  if (pm25CfAtmAvg < 343) {
    return 0.541 * pm25CfAtmAvg - 0.0618 * humidity + 0.00534 * temperature + 3.634;
  }
  return 0.46 * pm25CfAtmAvg + 3.93e-4 * pm25CfAtmAvg ** 2 + 2.97;
}

export function calcAqi(pm25CfAtmAvg: number, humidity: number, temperature: number): number {
  const corrected = Math.max(0, correctPm25(pm25CfAtmAvg, humidity, temperature));
  return calcAqiFromPm25(corrected);
}
