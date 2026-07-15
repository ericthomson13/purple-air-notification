import { afterEach, describe, expect, it, vi } from "vitest";
import { geocodeCityState } from "../src/geocode";

describe("geocodeCityState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns lat/lon parsed from the first Nominatim result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ lat: "40.0149856", lon: "-105.270545" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const place = await geocodeCityState("Boulder", "CO");
    expect(place).toEqual({ lat: 40.0149856, lon: -105.270545 });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("city=Boulder");
    expect(String(url)).toContain("state=CO");
    expect(String(url)).toContain("countrycodes=us,ca");
    expect(String(url)).not.toContain("country=US");
    expect(options.headers["User-Agent"]).toContain("purple-air-notification");
  });

  it("scopes the search to US and Canada so Canadian city/province lookups work", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ lat: "43.6532", lon: "-79.3832" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const place = await geocodeCityState("Toronto", "ON");
    expect(place).toEqual({ lat: 43.6532, lon: -79.3832 });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("city=Toronto");
    expect(String(url)).toContain("state=ON");
    expect(String(url)).toContain("countrycodes=us,ca");
  });

  it("returns null when no results are found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })));
    expect(await geocodeCityState("Nowheresville", "ZZ")).toBeNull();
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })));
    await expect(geocodeCityState("Boulder", "CO")).rejects.toThrow(/429/);
  });
});
