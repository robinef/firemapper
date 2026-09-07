import { cellToLatLng, latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";

import { footprintWind, WIND_MAX_AGE_MIN } from "../src/fire_readout";

const NOW = new Date("2026-08-08T12:00:00Z");
const AT = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();

function windPoint(lon: number, lat: number, opts: Partial<{ from_deg: number; kmh: number; t: string }> = {}) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties: { from_deg: opts.from_deg ?? 225, kmh: opts.kmh ?? 18, t: opts.t ?? AT(1) },
  };
}
const fc = (features: unknown[]) => ({ type: "FeatureCollection", features }) as never;

// Two res-8 H3 cells: one near a wind sample, one far from every sample below.
const NEAR_CELL = latLngToCell(42.71, 18.35, 8);
const FAR_CELL = latLngToCell(50.0, 5.0, 8); // Belgium — nowhere near the fixture wind point

describe("footprintWind", () => {
  it("emits an arrow for a cell with an in-range fresh sample", () => {
    const got = footprintWind([NEAR_CELL], fc([windPoint(18.35, 42.71, { from_deg: 240, kmh: 22 })]), NOW);
    expect(got).toHaveLength(1);
    expect(got[0].cell).toBe(NEAR_CELL);
    expect(got[0].bearingDeg).toBe(240);
    expect(got[0].kmh).toBe(22);
    const [expectedLat, expectedLon] = cellToLatLng(NEAR_CELL);
    expect(got[0].lat).toBeCloseTo(expectedLat, 6);
    expect(got[0].lon).toBeCloseTo(expectedLon, 6);
  });

  it("drops a cell with no sample within range", () => {
    const got = footprintWind([FAR_CELL], fc([windPoint(18.35, 42.71)]), NOW);
    expect(got).toEqual([]);
  });

  it("drops a cell whose only nearby sample is stale, keeps one with a fresh sample", () => {
    const stale = AT(WIND_MAX_AGE_MIN / 60 + 1);
    const fresh = AT(WIND_MAX_AGE_MIN / 60 - 0.5);
    const staleOnly = footprintWind([NEAR_CELL], fc([windPoint(18.35, 42.71, { t: stale })]), NOW);
    expect(staleOnly).toEqual([]);
    const freshOnly = footprintWind([NEAR_CELL], fc([windPoint(18.35, 42.71, { t: fresh })]), NOW);
    expect(freshOnly).toHaveLength(1);
  });

  it("handles a mixed footprint: near cell keeps its arrow, far cell is silently omitted", () => {
    const got = footprintWind([NEAR_CELL, FAR_CELL], fc([windPoint(18.35, 42.71)]), NOW);
    expect(got.map((h) => h.cell)).toEqual([NEAR_CELL]);
  });

  it("returns an empty array for null windPoints", () => {
    expect(footprintWind([NEAR_CELL], null, NOW)).toEqual([]);
  });

  it("returns an empty array for an empty cell list", () => {
    expect(footprintWind([], fc([windPoint(18.35, 42.71)]), NOW)).toEqual([]);
  });
});
