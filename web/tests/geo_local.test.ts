// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  MAX_AREA_ERROR,
  MAX_EXTENT_M,
  R_EARTH_M,
  checkExtentBudget,
  localMToLatLon,
  projectVertices,
} from "../src/geo_local";

describe("localMToLatLon", () => {
  it("returns the drop point when offset is zero", () => {
    const [lat, lon] = localMToLatLon(0, 0, 45.0, 5.0);
    expect(lat).toBeCloseTo(45.0, 9);
    expect(lon).toBeCloseTo(5.0, 9);
  });

  it("applies the cos(dropLat) correction, recomputed at the current drop latitude", () => {
    const [, lonAtEquator] = localMToLatLon(10000, 0, 0.0, 0.0);
    const [, lonAtHighLat] = localMToLatLon(10000, 0, 60.0, 0.0);
    // Same x_m offset must produce a LARGER longitude delta at high latitude
    // (fewer meters per degree of longitude there).
    expect(Math.abs(lonAtHighLat)).toBeGreaterThan(Math.abs(lonAtEquator));
  });
});

describe("projectVertices", () => {
  it("returns [lon, lat] pairs in GeoJSON order", () => {
    const result = projectVertices([[0, 0]], 45.0, 5.0);
    expect(result).toEqual([[5.0, 45.0]]);
  });
});

describe("checkExtentBudget", () => {
  it("returns true and does not warn for a small footprint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = checkExtentBudget([[[0, 0], [1000, 1000]]]);
    expect(ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns false and warns when extent exceeds MAX_EXTENT_M", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = checkExtentBudget([[[0, 0], [MAX_EXTENT_M + 1000, 0]]]);
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
