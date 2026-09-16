import { describe, expect, it, vi } from "vitest";
import { parseBbox, validateRange, MAX_SPAN_DAYS, MAX_BBOX_DEG, firmsSourceFor, chunkWindows } from "../../worker/historical_hotspots";
import { handleHistoricalHotspots } from "../../worker/historical_hotspots";

describe("parseBbox", () => {
  it("parses a valid west,south,east,north string", () => {
    expect(parseBbox("-1.3,44.4,-1.0,44.7")).toEqual({ west: -1.3, south: 44.4, east: -1.0, north: 44.7 });
  });

  it("rejects null", () => {
    expect(parseBbox(null)).toBeNull();
  });

  it("rejects a string with the wrong number of fields", () => {
    expect(parseBbox("-1.3,44.4,-1.0")).toBeNull();
  });

  it("rejects non-numeric fields", () => {
    expect(parseBbox("a,44.4,-1.0,44.7")).toBeNull();
  });

  it("rejects west >= east", () => {
    expect(parseBbox("-1.0,44.4,-1.3,44.7")).toBeNull();
  });

  it("rejects south >= north", () => {
    expect(parseBbox("-1.3,44.7,-1.0,44.4")).toBeNull();
  });

  it("rejects a bbox wider than MAX_BBOX_DEG in longitude", () => {
    expect(parseBbox(`-1.0,44.4,${-1.0 + MAX_BBOX_DEG + 0.01},44.7`)).toBeNull();
  });

  it("rejects a bbox taller than MAX_BBOX_DEG in latitude", () => {
    expect(parseBbox(`-1.3,44.4,-1.0,${44.4 + MAX_BBOX_DEG + 0.01}`)).toBeNull();
  });

  it("accepts a bbox exactly at the MAX_BBOX_DEG limit", () => {
    expect(parseBbox(`-1.0,44.4,${-1.0 + MAX_BBOX_DEG},${44.4 + MAX_BBOX_DEG}`)).not.toBeNull();
  });
});

describe("validateRange", () => {
  it("parses a valid start/end pair", () => {
    const r = validateRange("2022-07-01", "2022-07-10");
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.start.toISOString().slice(0, 10)).toBe("2022-07-01");
      expect(r.end.toISOString().slice(0, 10)).toBe("2022-07-10");
    }
  });

  it("rejects a missing start", () => {
    expect(validateRange(null, "2022-07-10")).toEqual({ error: "start is required (YYYY-MM-DD)" });
  });

  it("rejects a missing end", () => {
    expect(validateRange("2022-07-01", null)).toEqual({ error: "end is required (YYYY-MM-DD)" });
  });

  it("rejects a malformed date", () => {
    expect(validateRange("not-a-date", "2022-07-10")).toEqual({ error: "start is not a valid date" });
  });

  it("rejects start after end", () => {
    expect(validateRange("2022-07-10", "2022-07-01")).toEqual({ error: "start must not be after end" });
  });

  it(`rejects a span over ${MAX_SPAN_DAYS} days`, () => {
    expect(validateRange("2022-01-01", "2022-12-31")).toEqual({
      error: `date span must not exceed ${MAX_SPAN_DAYS} days`,
    });
  });

  it(`accepts a span exactly ${MAX_SPAN_DAYS} days`, () => {
    const r = validateRange("2022-01-01", "2022-03-31"); // 89 days apart, inclusive span 90
    expect("error" in r).toBe(false);
  });

  it("rejects calendar-invalid dates (Feb 30)", () => {
    expect(validateRange("2022-02-30", "2022-07-10")).toEqual({ error: "start is not a valid date" });
  });

  it("accepts valid dates near month boundaries (Feb 28)", () => {
    const r = validateRange("2022-02-28", "2022-03-15");
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.start.toISOString().slice(0, 10)).toBe("2022-02-28");
    }
  });
});

describe("firmsSourceFor", () => {
  it("uses MODIS_SP before VIIRS S-NPP coverage starts", () => {
    expect(firmsSourceFor(new Date("2010-06-01T00:00:00Z"))).toBe("MODIS_SP");
  });

  it("uses VIIRS_SNPP_SP for the main archive era", () => {
    expect(firmsSourceFor(new Date("2022-07-22T00:00:00Z"))).toBe("VIIRS_SNPP_SP");
  });

  it("uses VIIRS_NOAA20_SP on/after S-NPP retirement (2026-11-01)", () => {
    expect(firmsSourceFor(new Date("2026-11-01T00:00:00Z"))).toBe("VIIRS_NOAA20_SP");
  });

  it("still uses VIIRS_SNPP_SP the day before retirement", () => {
    expect(firmsSourceFor(new Date("2026-10-31T00:00:00Z"))).toBe("VIIRS_SNPP_SP");
  });

  it("uses VIIRS_SNPP_SP right at the coverage start boundary", () => {
    expect(firmsSourceFor(new Date("2012-01-19T00:00:00Z"))).toBe("VIIRS_SNPP_SP");
  });

  it("uses MODIS_SP the day before the coverage start boundary", () => {
    expect(firmsSourceFor(new Date("2012-01-18T00:00:00Z"))).toBe("MODIS_SP");
  });
});

describe("chunkWindows", () => {
  it("returns one window for a span of 5 days or fewer", () => {
    const windows = chunkWindows(new Date("2022-07-01T00:00:00Z"), new Date("2022-07-05T00:00:00Z"));
    expect(windows).toEqual([{ date: "2022-07-01", dayRange: 5 }]);
  });

  it("returns one window for a single day", () => {
    const windows = chunkWindows(new Date("2022-07-01T00:00:00Z"), new Date("2022-07-01T00:00:00Z"));
    expect(windows).toEqual([{ date: "2022-07-01", dayRange: 1 }]);
  });

  it("splits an 8-day span into a 5-day window then a 3-day window", () => {
    const windows = chunkWindows(new Date("2022-07-01T00:00:00Z"), new Date("2022-07-08T00:00:00Z"));
    expect(windows).toEqual([
      { date: "2022-07-01", dayRange: 5 },
      { date: "2022-07-06", dayRange: 3 },
    ]);
  });

  it("splits exactly on a 10-day span into two 5-day windows", () => {
    const windows = chunkWindows(new Date("2022-07-01T00:00:00Z"), new Date("2022-07-10T00:00:00Z"));
    expect(windows).toEqual([
      { date: "2022-07-01", dayRange: 5 },
      { date: "2022-07-06", dayRange: 5 },
    ]);
  });
});

describe("handleHistoricalHotspots", () => {
  const url = (qs: string) => new Request(`https://x/api/historical-hotspots?${qs}`);
  const VALID_QS = "bbox=-1.3,44.4,-1.0,44.7&start=2022-07-01&end=2022-07-05";

  it("503s with no map key configured", async () => {
    const res = await handleHistoricalHotspots(url(VALID_QS), {});
    expect(res.status).toBe(503);
  });

  it("400s on a missing bbox", async () => {
    const res = await handleHistoricalHotspots(
      url("start=2022-07-01&end=2022-07-05"),
      { FIRMS_HISTORICAL_MAP_KEY: "k" },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("bbox");
  });

  it("400s on an invalid date range, before ever calling upstream", async () => {
    const upstream = vi.fn();
    const res = await handleHistoricalHotspots(
      url("bbox=-1.3,44.4,-1.0,44.7&start=2022-07-10&end=2022-07-01"),
      { FIRMS_HISTORICAL_MAP_KEY: "k", HISTORICAL_HOTSPOTS_UPSTREAM: upstream },
    );
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("injects the map key and forwards to FIRMS with the right source/day-range/date", async () => {
    const seenUrls: string[] = [];
    const upstream = async (r: Request) => {
      seenUrls.push(r.url);
      return new Response("latitude,longitude,acq_date,acq_time\n44.5,-1.1,2022-07-01,1200\n");
    };
    const res = await handleHistoricalHotspots(
      url(VALID_QS),
      { FIRMS_HISTORICAL_MAP_KEY: "secret-key", HISTORICAL_HOTSPOTS_UPSTREAM: upstream },
    );
    expect(res.status).toBe(200);
    expect(seenUrls).toEqual([
      "https://firms.modaps.eosdis.nasa.gov/api/area/csv/secret-key/VIIRS_SNPP_SP/-1.3,44.4,-1.0,44.7/5/2022-07-01",
    ]);
    expect(await res.text()).toContain("44.5,-1.1,2022-07-01,1200");
  });

  it("never leaks the map key into the response body or headers", async () => {
    const upstream = async () => new Response("latitude,longitude\n1,2\n");
    const res = await handleHistoricalHotspots(
      url(VALID_QS),
      { FIRMS_HISTORICAL_MAP_KEY: "super-secret", HISTORICAL_HOTSPOTS_UPSTREAM: upstream },
    );
    const body = await res.text();
    expect(body).not.toContain("super-secret");
    for (const [, v] of res.headers) expect(v).not.toContain("super-secret");
  });

  it("chunks a >5-day span into multiple upstream calls and merges the CSVs, keeping one header", async () => {
    const upstream = async (r: Request) => {
      const day = r.url.includes("/2022-07-01") ? "2022-07-01" : "2022-07-06";
      return new Response(`latitude,longitude,acq_date\n1,2,${day}\n`);
    };
    const res = await handleHistoricalHotspots(
      url("bbox=-1.3,44.4,-1.0,44.7&start=2022-07-01&end=2022-07-08"),
      { FIRMS_HISTORICAL_MAP_KEY: "k", HISTORICAL_HOTSPOTS_UPSTREAM: upstream },
    );
    const body = await res.text();
    expect(body.match(/latitude,longitude,acq_date/g)?.length).toBe(1); // header once
    expect(body).toContain("1,2,2022-07-01");
    expect(body).toContain("1,2,2022-07-06");
  });

  it("returns 502 when an upstream chunk fails, rather than a partial merged result", async () => {
    const upstream = async () => new Response("boom", { status: 500 });
    const res = await handleHistoricalHotspots(url(VALID_QS), {
      FIRMS_HISTORICAL_MAP_KEY: "k", HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
    });
    expect(res.status).toBe(502);
  });

  it("returns 502, without leaking the map key or error message, when the fetch itself throws", async () => {
    const upstream = async () => {
      throw new Error("ECONNRESET");
    };
    const res = await handleHistoricalHotspots(url(VALID_QS), {
      FIRMS_HISTORICAL_MAP_KEY: "super-secret", HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
    });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain("super-secret");
    expect(body).not.toContain("ECONNRESET");
  });

  it("marks a successful response cacheable for a long time — a past date range's data never changes", async () => {
    const upstream = async () => new Response("latitude,longitude\n1,2\n");
    const res = await handleHistoricalHotspots(url(VALID_QS), {
      FIRMS_HISTORICAL_MAP_KEY: "k", HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
    });
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
});
