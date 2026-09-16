import { describe, expect, it } from "vitest";
import { parseBbox, validateRange, MAX_SPAN_DAYS, MAX_BBOX_DEG } from "../../worker/historical_hotspots";

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
