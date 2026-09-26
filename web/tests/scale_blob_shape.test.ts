import { describe, expect, it } from "vitest";
import {
  HEX_AREA_KM2,
  NAMED_COUNTRIES,
  OTHER_COLOR,
  OTHER_KEY,
  buildBlobShape,
  bandByCountry,
  groupByCountry,
  hexCountForArea,
  euOnly,
  spiralAxial,
} from "../src/scale_blob_shape";
import type { FiresSummary } from "../src/types";

function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/** Net area of a group's MultiPolygon in km²: outers counter-clockwise
 * (positive), holes clockwise (negative), so a plain sum nets the holes out. */
function groupKm2(polys: [number, number][][][]): number {
  return polys.flat().reduce((s, ring) => s + ringArea(ring), 0) / 1e6;
}

function summaryOf(entries: [string | null, number][]): FiresSummary {
  return Object.fromEntries(entries.map(([country, area_km2], i) => [`f${i}`, { country, area_km2 }]));
}

describe("euOnly", () => {
  it("keeps EU-27 fires and drops non-members and unplaced fires", () => {
    const kept = euOnly({
      a: { country: "FR", area_km2: 1 },
      b: { country: "UA", area_km2: 1 },
      c: { country: null, area_km2: 1 },
      d: { country: "MT", area_km2: 1 },
    });
    expect(Object.keys(kept).sort()).toEqual(["a", "d"]);
  });
});

describe("hexCountForArea", () => {
  it("rounds to the 0.7 km² quantum and never drops a fire", () => {
    expect(hexCountForArea(0.01)).toBe(1);
    expect(hexCountForArea(0.7)).toBe(1);
    expect(hexCountForArea(7)).toBe(10);
  });
});

describe("spiralAxial", () => {
  it("fills every position once, centre first, ring by ring", () => {
    const pts = spiralAxial(19); // centre + ring 1 (6) + ring 2 (12)
    expect(pts[0]).toEqual([0, 0]);
    expect(new Set(pts.map((p) => p.join())).size).toBe(19);
    const dist = ([q, r]: [number, number]) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
    expect(pts.slice(1, 7).every((p) => dist(p) === 1)).toBe(true);
    expect(pts.slice(7).every((p) => dist(p) === 2)).toBe(true);
  });

  // pipeline/pack_blob.py's _spiral_axial_coords(8), pinned: the two must lay
  // out the same spiral or the browser blob drifts from the pipeline's.
  it("matches the pipeline's spiral order", () => {
    expect(spiralAxial(8)).toEqual([[0, 0], [-1, 1], [0, 1], [1, 0], [1, -1], [0, -1], [-1, 0], [-2, 2]]);
  });
});

describe("groupByCountry", () => {
  it("ranks countries by hex count and folds the tail and unknowns into Other, last", () => {
    const entries: [string | null, number][] = [];
    for (let i = 0; i < NAMED_COUNTRIES + 2; i++) entries.push([`C${i}`, 70 - i]);
    entries.push([null, 5]);
    const groups = groupByCountry(summaryOf(entries));
    expect(groups.map((g) => g.key)).toEqual([...Array(NAMED_COUNTRIES).keys()].map((i) => `C${i}`).concat(OTHER_KEY));
    const other = groups.at(-1)!;
    expect(other.color).toBe(OTHER_COLOR);
    expect(other.fires).toBe(3);
    expect(new Set(groups.slice(0, -1).map((g) => g.color)).size).toBe(NAMED_COUNTRIES);
  });

  it("has no Other group when every fire is a named country", () => {
    expect(groupByCountry(summaryOf([["FR", 3], ["ES", 1]])).map((g) => g.key)).toEqual(["FR", "ES"]);
  });

  it("maps the panel's countries to their bands, the unnamed ones to Other", () => {
    const groups = groupByCountry(summaryOf([["FR", 3], ["ES", 1]]));
    const band = bandByCountry(groups);
    expect(band("FR")).toEqual({ key: "FR", color: groups[0].color });
    expect(band("ZZ")).toEqual({ key: OTHER_KEY, color: OTHER_COLOR });
  });
});

describe("buildBlobShape", () => {
  it("dissolves each country into rings whose net area is exactly its hexes", () => {
    const summary = summaryOf([["UA", 400], ["RU", 260], ["ES", 90], ["FR", 30], ["IT", 1], [null, 12]]);
    const { groups, polygonsM } = buildBlobShape(summary);
    expect(polygonsM).toHaveLength(groups.length);
    groups.forEach((g, i) => {
      expect(groupKm2(polygonsM[i])).toBeCloseTo(g.hexes * HEX_AREA_KM2, 6);
    });
  });

  it("gives the centre country one solid polygon and the next one a ring around it", () => {
    const { polygonsM } = buildBlobShape(summaryOf([["UA", 100], ["RU", 400]]));
    // RU is larger so it is first — the centre — and is a single outer ring.
    expect(polygonsM[0]).toHaveLength(1);
    expect(polygonsM[0][0]).toHaveLength(1);
    // UA wraps (part of) it: whatever its pieces, none is a hole-only artefact.
    for (const poly of polygonsM[1]) expect(ringArea(poly[0])).toBeGreaterThan(0);
  });

  it("emits a few polygons, not one per hex", () => {
    // ~1,500 hexes across two countries: the old blob drew 1,500 features.
    const { polygonsM } = buildBlobShape(summaryOf([["UA", 700], ["RU", 350]]));
    expect(polygonsM.flat().length).toBeLessThan(10);
  });

  it("is empty for an empty summary", () => {
    expect(buildBlobShape({})).toEqual({ groups: [], polygonsM: [] });
  });
});
