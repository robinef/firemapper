import { describe, expect, it } from "vitest";
import { areaText, cellsText, footprintNote } from "../src/area";

/**
 * A one-cell footprint is not a measurement. `area_km2` is
 * `cells x SENSOR cell size` — 0.7 km² for VIIRS, 5.2 km² for Meteosat — so a
 * single Meteosat pixel reports 5.2 km² when all it means is "the fire is
 * somewhere inside this pixel". The pipeline already refuses to size those
 * (size_class returns minor for cells <= 1); the text surfaces still printed a
 * confident number for the same fire.
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

  it("never lets a missing count fabricate a one-cell fire", () => {
    // `null <= 1` is TRUE in JS, so a guard of `cells !== undefined` let a null
    // count through into the unsized branch: a 40-cell fire would have been
    // described as one unresolved pixel. That is a confident, plausible, FALSE
    // claim — strictly worse than the overclaim this module exists to fix.
    expect(areaText(140.4, null)).toBe("140.4 km²");
    expect(cellsText(null)).toBe("");
    expect(footprintNote(null)).toBe("");

    expect(areaText(5.2, undefined)).toBe("5.2 km²");
    expect(cellsText(undefined)).toBe("");

    // NaN fails every comparison, so it reads as sized — the safe direction.
    expect(areaText(5.2, NaN)).toBe("5.2 km²");
    expect(cellsText(NaN)).toBe("");
  });

  it("carries its own parentheses so a missing count leaves no empty pair", () => {
    // The call site used to wrap this in literal parens, rendering
    // "burning area ()" whenever the count was absent.
    expect(cellsText(1)).toBe(" (1 cell — size not resolved)");
    expect(cellsText(2)).toBe(" (2 cells)");
    expect(cellsText(27)).toBe(" (27 cells)");
    expect(cellsText(undefined)).toBe("");
  });

  it("explains the bound where a surface has room for it", () => {
    // The fire card is the reachable surface, and shows only the value — a
    // bare "≤" with nothing saying why is not an explanation.
    expect(footprintNote(1)).toBe("1 sensor pixel — size not resolved");
    expect(footprintNote(2)).toBe("");
  });

  it("survives the values MapLibre actually hands over", () => {
    // Relational operators numeric-coerce strings, so a stringified count still
    // classifies correctly.
    expect(areaText(5.2, "1" as unknown as number)).toBe("≤5.2 km²");
    expect(areaText(10.4, "2" as unknown as number)).toBe("10.4 km²");
  });
});
