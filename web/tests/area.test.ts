import { describe, expect, it } from "vitest";
import { areaText, cellsText } from "../src/area";

/**
 * A one-cell footprint is not a measurement. `area_km2` is
 * `cells x SENSOR cell size` — 0.7 km² for VIIRS, 5.2 km² for Meteosat — so a
 * single Meteosat pixel reports 5.2 km² when all it means is "the fire is
 * somewhere inside this pixel". The pipeline already refuses to size those
 * (size_class returns minor for cells <= 1); the panel and the fire card still
 * printed "5.2 km² burning area (1 cells)", asserting a number nobody measured.
 */
describe("stating an area we actually measured", () => {
  it("marks a one-cell footprint as an upper bound", () => {
    expect(areaText(5.2, 1)).toBe("≤5.2 km²");
    expect(areaText(0.7, 1)).toBe("≤0.7 km²");
  });

  it("states a resolved extent plainly", () => {
    expect(areaText(10.4, 2)).toBe("10.4 km²");
    expect(areaText(4.2, 6)).toBe("4.2 km²");
  });

  it("says how the footprint is made up, and can count to one", () => {
    // "(1 cells)" shipped for months — the grammar was the tell that nothing
    // ever looked at this path.
    expect(cellsText(1)).toBe("1 cell — size not resolved");
    expect(cellsText(2)).toBe("2 cells");
    expect(cellsText(27)).toBe("27 cells");
  });

  it("does not invent precision when the count is missing", () => {
    // Older generations, or a feature that lost the property, must not silently
    // become an upper bound OR a hard number.
    expect(areaText(5.2, undefined)).toBe("5.2 km²");
    expect(cellsText(undefined)).toBe("");
  });

  it("survives the values MapLibre actually hands over", () => {
    expect(areaText(Number("5.2"), Number("1"))).toBe("≤5.2 km²");
    expect(areaText(0, 0)).toBe("≤0 km²");
  });
});
