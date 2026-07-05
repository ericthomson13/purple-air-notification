import { describe, expect, it } from "vitest";
import { DAILY_DIGEST_CRON } from "../src/index";
// @ts-expect-error - raw text import, not a real module
import wranglerConfigRaw from "../wrangler.jsonc?raw";

describe("wrangler.jsonc / index.ts cron consistency", () => {
  // Nothing else catches these two silently drifting apart - the
  // scheduled() handler falls back to the AQI poll for any cron string
  // that isn't an exact match, so a typo here would just make the daily
  // digest silently never fire instead of erroring.
  it("wrangler.jsonc's cron list includes the exact string index.ts checks for", () => {
    expect(wranglerConfigRaw).toContain(`"${DAILY_DIGEST_CRON}"`);
  });
});
