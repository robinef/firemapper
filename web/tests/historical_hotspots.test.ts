import { describe, expect, it, vi } from "vitest";
import { parseBbox, validateRange, MAX_SPAN_DAYS, MAX_BBOX_DEG, firmsSourceFor, chunkWindows, isAllowedOrigin } from "../../worker/historical_hotspots";
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

  function lastDayOf(window: { date: string; dayRange: number }): Date {
    return new Date(new Date(`${window.date}T00:00:00Z`).getTime() + (window.dayRange - 1) * 86_400_000);
  }

  it("never lets a single window straddle the S-NPP retirement boundary (2026-11-01)", () => {
    const windows = chunkWindows(new Date("2026-10-29T00:00:00Z"), new Date("2026-11-05T00:00:00Z"));
    // Sanity: the range does span the boundary, and windows still cover it end to end.
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      const startSource = firmsSourceFor(new Date(`${w.date}T00:00:00Z`));
      const endSource = firmsSourceFor(lastDayOf(w));
      expect(endSource).toBe(startSource);
    }
  });

  it("never lets a single window straddle the VIIRS coverage-start boundary (2012-01-19)", () => {
    const windows = chunkWindows(new Date("2012-01-16T00:00:00Z"), new Date("2012-01-23T00:00:00Z"));
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      const startSource = firmsSourceFor(new Date(`${w.date}T00:00:00Z`));
      const endSource = firmsSourceFor(lastDayOf(w));
      expect(endSource).toBe(startSource);
    }
  });
});

describe("handleHistoricalHotspots", () => {
  const url = (qs: string) =>
    new Request(`https://x/api/historical-hotspots?${qs}`, {
      headers: { origin: "https://firemapper.robinef.workers.dev" },
    });
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

  it("keeps the header and the data when the FIRST chunk's body is wholly empty (zero detections)", async () => {
    const upstream = async (r: Request) => {
      if (r.url.includes("/2022-07-01")) {
        return new Response(""); // no header at all — the actual dropped-header scenario
      }
      return new Response("latitude,longitude,acq_date\n1,2,2022-07-06\n");
    };
    const res = await handleHistoricalHotspots(
      url("bbox=-1.3,44.4,-1.0,44.7&start=2022-07-01&end=2022-07-08"),
      { FIRMS_HISTORICAL_MAP_KEY: "k", HISTORICAL_HOTSPOTS_UPSTREAM: upstream },
    );
    const body = await res.text();
    expect(body.match(/latitude,longitude,acq_date/g)?.length).toBe(1); // header not dropped
    expect(body).toContain("1,2,2022-07-06");
  });

  it("does not insert a blank line for an empty chunk in the MIDDLE of a multi-chunk merge", async () => {
    const upstream = async (r: Request) => {
      if (r.url.includes("/2022-07-01")) return new Response("latitude,longitude,acq_date\n1,2,2022-07-01\n");
      if (r.url.includes("/2022-07-06")) return new Response("latitude,longitude,acq_date\n"); // empty middle chunk
      return new Response("latitude,longitude,acq_date\n1,2,2022-07-11\n");
    };
    const res = await handleHistoricalHotspots(
      url("bbox=-1.3,44.4,-1.0,44.7&start=2022-07-01&end=2022-07-13"),
      { FIRMS_HISTORICAL_MAP_KEY: "k", HISTORICAL_HOTSPOTS_UPSTREAM: upstream },
    );
    const body = await res.text();
    expect(body).not.toMatch(/\n\n/); // no blank line
    expect(body.match(/latitude,longitude,acq_date/g)?.length).toBe(1);
    expect(body).toContain("1,2,2022-07-01");
    expect(body).toContain("1,2,2022-07-11");
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

  it("returns 502, without leaking the map key, when reading the upstream response body throws", async () => {
    const upstream = async () => {
      const res = new Response("irrelevant, never read successfully");
      res.text = () => {
        throw new Error("truncated stream");
      };
      return res;
    };
    const res = await handleHistoricalHotspots(url(VALID_QS), {
      FIRMS_HISTORICAL_MAP_KEY: "super-secret", HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
    });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain("super-secret");
    expect(body).not.toContain("truncated stream");
  });

  it("marks a successful response cacheable for a long time — a past date range's data never changes", async () => {
    const upstream = async () => new Response("latitude,longitude\n1,2\n");
    const res = await handleHistoricalHotspots(url(VALID_QS), {
      FIRMS_HISTORICAL_MAP_KEY: "k", HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
    });
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("403s a request from a disallowed origin before checking anything else", async () => {
    const upstream = vi.fn();
    const req = new Request(`https://x/api/historical-hotspots?${VALID_QS}`, {
      headers: { origin: "https://evil.example.com" },
    });
    const res = await handleHistoricalHotspots(req, {
      FIRMS_HISTORICAL_MAP_KEY: "k", HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
    });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("429s an over-budget visitor before spending any FIRMS quota", async () => {
    const upstream = vi.fn();
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const res = await handleHistoricalHotspots(url(VALID_QS), {
      FIRMS_HISTORICAL_MAP_KEY: "k",
      HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
      HISTORICAL_VISITOR_LIMITER: limiter,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the VISITOR_RATE_GATE Durable Object when no override is given, naming the instance by route and IP", async () => {
    const seen: string[] = [];
    const ns = {
      idFromName: (n: string) => n,
      get: (id: unknown) => {
        seen.push(String(id));
        return { fetch: async () => new Response(JSON.stringify({ success: false, retryAfterMs: 1000 })) };
      },
    };
    const upstream = vi.fn();
    const req = new Request(`https://x/api/historical-hotspots?${VALID_QS}`, {
      headers: { origin: "https://firemapper.robinef.workers.dev", "cf-connecting-ip": "203.0.113.7" },
    });
    const res = await handleHistoricalHotspots(req, {
      FIRMS_HISTORICAL_MAP_KEY: "k",
      HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
      VISITOR_RATE_GATE: ns,
    });
    expect(res.status).toBe(429);
    expect(seen).toEqual(["historical:203.0.113.7"]);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not charge the visitor budget for a request that fails validation", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) };
    const res = await handleHistoricalHotspots(url("start=2022-07-01&end=2022-07-05"), {
      FIRMS_HISTORICAL_MAP_KEY: "k",
      HISTORICAL_VISITOR_LIMITER: limiter,
    });
    expect(res.status).toBe(400);
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it("proceeds to upstream when the limiter allows, keyed on the visitor's IP", async () => {
    const upstream = vi.fn(async () => new Response("latitude,longitude\n44.5,-1.1\n"));
    const limiter = { limit: vi.fn(async () => ({ success: true })) };
    const req = new Request(`https://x/api/historical-hotspots?${VALID_QS}`, {
      headers: { origin: "https://firemapper.robinef.workers.dev", "cf-connecting-ip": "203.0.113.7" },
    });
    const res = await handleHistoricalHotspots(req, {
      FIRMS_HISTORICAL_MAP_KEY: "k",
      HISTORICAL_HOTSPOTS_UPSTREAM: upstream,
      HISTORICAL_VISITOR_LIMITER: limiter,
    });
    expect(res.status).toBe(200);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(upstream).toHaveBeenCalled();
  });
});

describe("isAllowedOrigin", () => {
  const req = (headers: Record<string, string>) => new Request("https://x/api/historical-hotspots", { headers });

  it("allows the deployed origin", () => {
    expect(isAllowedOrigin(req({ origin: "https://firemapper.robinef.workers.dev" }))).toBe(true);
  });

  it("allows local dev", () => {
    expect(isAllowedOrigin(req({ origin: "http://localhost:5173" }))).toBe(true);
  });

  it("rejects an unrelated origin", () => {
    expect(isAllowedOrigin(req({ origin: "https://evil.example.com" }))).toBe(false);
  });

  it("rejects a request with neither Origin nor Referer", () => {
    expect(isAllowedOrigin(req({}))).toBe(false);
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(isAllowedOrigin(req({ referer: "https://firemapper.robinef.workers.dev/some/page" }))).toBe(true);
  });

  it("rejects a malformed origin header rather than throwing", () => {
    expect(isAllowedOrigin(req({ origin: "not-a-url" }))).toBe(false);
  });

  it("allows a same-origin fetch signalled only via Sec-Fetch-Site, with no Origin/Referer at all", () => {
    expect(isAllowedOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("still rejects a cross-site request with no Origin/Referer, even with Sec-Fetch-Site present", () => {
    expect(isAllowedOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
  });
});
