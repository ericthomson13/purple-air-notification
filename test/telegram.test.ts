import { describe, expect, it } from "vitest";
import { AQI_CORRECTION_NOTE } from "../src/aqi";
import { formatAlert, formatLocationsList, formatPastNote, formatStatus } from "../src/telegram";
import { makeLocation } from "./fixtures";

describe("formatPastNote", () => {
  it("is empty when there's no past reading", () => {
    expect(formatPastNote(null)).toBe("");
    expect(formatPastNote(undefined)).toBe("");
  });

  it("includes the past AQI and an elapsed-minutes estimate", () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString().replace("T", " ").slice(0, 19);
    const note = formatPastNote({ aqi: 150, checked_at: thirtyMinAgo });
    expect(note).toContain("was 150");
    expect(note).toMatch(/~\d+m ago/);
  });
});

describe("formatAlert", () => {
  const location = makeLocation({ name: "Leadville, CO" });

  it("describes a rising crossing using the lower level's threshold", () => {
    // Moderate (idx 1, threshold 100) -> Unhealthy for Sensitive Groups (idx 2)
    const text = formatAlert(location, 105, 1, 2, null);
    expect(text).toContain("risen above");
    expect(text).toContain("100");
    expect(text).toContain("now <b>105</b>");
  });

  it("describes a falling crossing using the lower level's threshold", () => {
    // Unhealthy for Sensitive Groups (idx 2) -> Moderate (idx 1, threshold 100)
    const text = formatAlert(location, 92, 2, 1, { aqi: 150, checked_at: "2026-01-01 00:00:00" });
    expect(text).toContain("dropped below");
    expect(text).toContain("100");
    expect(text).toContain("was 150");
  });

  // Regression coverage: every message reporting an AQI value should carry
  // the correction-methodology note, as the last thing in the message - a
  // ~20pt gap from PurpleAir's own (uncorrected) map display was mistaken
  // for a bug without it.
  it("includes the correction note, after everything else", () => {
    const text = formatAlert(location, 105, 1, 2, null);
    expect(text).toContain(`(${AQI_CORRECTION_NOTE})`);
    expect(text.trimEnd().endsWith(`(${AQI_CORRECTION_NOTE})`)).toBe(true);
  });
});

describe("formatStatus", () => {
  it("reports no reading yet when the location has never been polled", () => {
    const text = formatStatus(makeLocation({ last_aqi: null, last_level: null }));
    expect(text).toContain("no reading yet");
  });

  it("includes a danger-zone link when AQI is 100+", () => {
    const text = formatStatus(makeLocation({ last_aqi: 120, last_level: 2, last_checked_at: "2026-01-01 00:00:00" }));
    expect(text).toContain("120");
    expect(text).toContain("http");
  });

  it("omits the danger-zone link when AQI is under 100", () => {
    const text = formatStatus(makeLocation({ last_aqi: 42, last_level: 0, last_checked_at: "2026-01-01 00:00:00" }));
    expect(text).not.toContain("http");
  });

  it("includes the correction note, after the danger-zone link", () => {
    const text = formatStatus(makeLocation({ last_aqi: 120, last_level: 2, last_checked_at: "2026-01-01 00:00:00" }));
    expect(text).toContain(`(${AQI_CORRECTION_NOTE})`);
    expect(text.indexOf("http")).toBeLessThan(text.indexOf(AQI_CORRECTION_NOTE));
  });
});

describe("formatLocationsList", () => {
  it("says none are registered when the list is empty", () => {
    expect(formatLocationsList([])).toContain("No locations");
  });

  it("lists each location's slug and name", () => {
    const text = formatLocationsList([makeLocation({ slug: "a-co", name: "A, CO" }), makeLocation({ slug: "b-ut", name: "B, UT" })]);
    expect(text).toContain("a-co");
    expect(text).toContain("A, CO");
    expect(text).toContain("b-ut");
    expect(text).toContain("B, UT");
  });
});
