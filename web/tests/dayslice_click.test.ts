import { describe, expect, it } from "vitest";
import { latLngToCell } from "h3-js";
import { SLICE_RES, firesInCell, sliceFeatures } from "../src/layer_dayslice";

/**
 * Clicking a histogram day paints res-5 hexes, and until now that was a dead
 * end: `day-slice-fill` had no click handler, and each cell carried only a
 * count. So the one route a reader naturally reaches for to find a fire that
 * has stopped burning — scrub back to the day it was burning, click where it
 * was — did nothing at all.
 *
 * A slice cell is an aggregate of every detection that day, so there is no
 * single event id to thread through the pipeline. Instead we match the cell
 * against the events already loaded in the browser, which also means closed
 * fires resolve exactly as live ones do.
 */
function fireAt(lon: number, lat: number, id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties: { id, area_km2: 1, status: "closed", ...extra },
  };
}

const BORDEAUX: [number, number] = [-0.57, 44.84];

describe("resolving a slice cell to fires", () => {
  it("finds the fire whose centroid falls in the clicked cell", () => {
    const cell = latLngToCell(BORDEAUX[1], BORDEAUX[0], SLICE_RES);
    const fires = [fireAt(BORDEAUX[0], BORDEAUX[1], "bdx"), fireAt(20, 40, "far")];
    expect(firesInCell(fires as never, cell).map((f) => f.properties!.id)).toEqual(["bdx"]);
  });

  it("returns every fire in the cell, biggest first", () => {
    const cell = latLngToCell(BORDEAUX[1], BORDEAUX[0], SLICE_RES);
    const fires = [
      fireAt(BORDEAUX[0], BORDEAUX[1], "small", { area_km2: 2 }),
      fireAt(BORDEAUX[0] + 0.01, BORDEAUX[1] + 0.01, "big", { area_km2: 284.9 }),
    ];
    // A res-5 hex is ~250 km2 and routinely holds several fires; the reader
    // almost always means the big one, so it must not be buried.
    expect(firesInCell(fires as never, cell).map((f) => f.properties!.id)).toEqual(["big", "small"]);
  });

  it("returns nothing when the day predates the events window", () => {
    // Slices go back 30 days but clustering only keeps 14 (events.py
    // WINDOW_DAYS), so older days legitimately have no fire to open. The
    // caller must be able to say so rather than appear broken.
    const cell = latLngToCell(10, 50, SLICE_RES);
    expect(firesInCell([fireAt(BORDEAUX[0], BORDEAUX[1], "bdx")] as never, cell)).toEqual([]);
  });

  it("does not let a non-numeric area_km2 corrupt the biggest-first sort with NaN", () => {
    // Same failure mode firelist.test.ts guards buildFireIndex against: a
    // non-numeric area_km2 fed through Number(x ?? 0) becomes NaN, and a
    // comparator returning NaN is treated as "equal" by the engine (stable
    // sort, no swap) — so the malformed entry must start out of order for a
    // broken comparator to visibly leave it there.
    const cell = latLngToCell(BORDEAUX[1], BORDEAUX[0], SLICE_RES);
    const fires = [
      fireAt(BORDEAUX[0], BORDEAUX[1], "malformed", { area_km2: "not-a-number" }),
      fireAt(BORDEAUX[0] + 0.01, BORDEAUX[1] + 0.01, "big", { area_km2: 284.9 }),
    ];
    expect(firesInCell(fires as never, cell).map((f) => f.properties!.id)).toEqual(["big", "malformed"]);
  });

  it("ignores features that are not points", () => {
    const cell = latLngToCell(BORDEAUX[1], BORDEAUX[0], SLICE_RES);
    const poly = {
      type: "Feature" as const,
      geometry: { type: "Polygon" as const, coordinates: [[[0, 0]]] },
      properties: { id: "poly" },
    };
    expect(firesInCell([poly] as never, cell)).toEqual([]);
  });
});

describe("slice cells carry their own id", () => {
  it("puts the h3 index on every feature so a click can resolve it", () => {
    const cell = latLngToCell(BORDEAUX[1], BORDEAUX[0], SLICE_RES);
    const [f] = sliceFeatures([[cell, 7]]);
    expect(f.properties).toMatchObject({ n: 7, cell });
    expect(f.geometry.type).toBe("Polygon");
  });

  it("closes each hex ring", () => {
    const cell = latLngToCell(BORDEAUX[1], BORDEAUX[0], SLICE_RES);
    const ring = (sliceFeatures([[cell, 1]])[0].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
});
