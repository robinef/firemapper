import { describe, expect, it } from "vitest";
import { deriveBbox, validateDateRange, DEFAULT_RADIUS_KM, MAX_SPAN_DAYS } from "../src/historical_lookup_ui";

describe("deriveBbox", () => {
  it("returns a west,south,east,north string centered on the point", () => {
    const bbox = deriveBbox(-1.03, 44.84, 15);
    const [west, south, east, north] = bbox.split(",").map(Number);
    expect(west).toBeLessThan(-1.03);
    expect(east).toBeGreaterThan(-1.03);
    expect(south).toBeLessThan(44.84);
    expect(north).toBeGreaterThan(44.84);
  });

  it(`defaults to ${DEFAULT_RADIUS_KM}km when no radius is given`, () => {
    const withDefault = deriveBbox(-1.03, 44.84);
    const explicit = deriveBbox(-1.03, 44.84, DEFAULT_RADIUS_KM);
    expect(withDefault).toBe(explicit);
  });

  it("stays well under the server's 0.5deg MAX_BBOX_DEG cap at the default radius", () => {
    const [west, , east] = deriveBbox(-1.03, 44.84).split(",").map(Number);
    expect(east - west).toBeLessThan(0.5);
  });

  it("widens visibly for a larger requested radius", () => {
    const [west15] = deriveBbox(-1.03, 44.84, 15).split(",").map(Number);
    const [west30] = deriveBbox(-1.03, 44.84, 30).split(",").map(Number);
    expect(west30).toBeLessThan(west15);
  });
});

describe("validateDateRange", () => {
  it("accepts a valid short range", () => {
    expect(validateDateRange("2022-07-01", "2022-07-10")).toEqual({ ok: true });
  });

  it("rejects a missing before/after", () => {
    expect(validateDateRange("", "2022-07-10")).toEqual({ ok: false, error: "pick a start date" });
    expect(validateDateRange("2022-07-01", "")).toEqual({ ok: false, error: "pick an end date" });
  });

  it("rejects before after after", () => {
    expect(validateDateRange("2022-07-10", "2022-07-01")).toEqual({
      ok: false, error: "start date must be before end date",
    });
  });

  it(`rejects a span over ${MAX_SPAN_DAYS} days, mirroring the server's own cap`, () => {
    expect(validateDateRange("2022-01-01", "2022-12-31")).toEqual({
      ok: false, error: `date range must be ${MAX_SPAN_DAYS} days or fewer`,
    });
  });
});
