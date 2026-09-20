// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cellArea, cellToParent, gridDisk, latLngToCell, UNITS } from "h3-js";
import {
  SIZE_EDGES,
  aggregate,
  binIndex,
  dedupNested,
  filterLabel,
  fireSizes,
  histogram,
  thresholdFor,
} from "../src/season_filter";
import type { SeasonCells } from "../src/types";

const km2 = (c: string) => cellArea(c, UNITS.km2);
const r1 = (v: number) => Math.round(v * 10) / 10;

const a = latLngToCell(45.0, 5.0, 8);
const b = latLngToCell(45.0, 5.02, 8);
const far = latLngToCell(52.0, 13.0, 8);
const entry = (cells: string[]) => ({ digest: "d", first: "2026-07-01", cells });

describe("fireSizes", () => {
  it("sums the real area of each fire's unique cells", () => {
    const sizes = fireSizes({ f1: entry([a, b]), f2: entry([far]) });
    expect(sizes.get("f1")).toBeCloseTo(km2(a) + km2(b), 6);
    expect(sizes.get("f2")).toBeCloseTo(km2(far), 6);
  });
  it("counts a cell listed twice in one fire once", () => {
    const sizes = fireSizes({ f1: entry([a, a]) });
    expect(sizes.get("f1")).toBeCloseTo(km2(a), 6);
  });
});

describe("bins", () => {
  it("has the spec's 16 edges", () => {
    expect(SIZE_EDGES).toEqual([0.5, 0.7, 1, 1.5, 2, 3, 4, 6, 10, 15, 20, 30, 50, 100, 200, 600]);
  });
  it("binIndex places values on the edge in the upper bin and caps at the last bin", () => {
    expect(binIndex(0.4)).toBe(-1);
    expect(binIndex(0.5)).toBe(0);
    expect(binIndex(0.69)).toBe(0);
    expect(binIndex(0.7)).toBe(1);
    expect(binIndex(4)).toBe(6);
    expect(binIndex(599)).toBe(14);
    expect(binIndex(600)).toBe(14);
    expect(binIndex(5000)).toBe(14);
  });
  it("histogram counts fires per bin and ignores sub-0.5 fires", () => {
    const h = histogram(new Map([["x", 0.4], ["y", 0.5], ["z", 3.5], ["w", 700]]));
    expect(h).toHaveLength(15);
    expect(h[0]).toBe(1);
    expect(h[5]).toBe(1);
    expect(h[14]).toBe(1);
    expect(h.reduce((s, n) => s + n, 0)).toBe(3);
  });
  it("thresholdFor maps index 0 to everything and index i to edge i", () => {
    expect(thresholdFor(0)).toBe(0);
    expect(thresholdFor(1)).toBe(0.7);
    expect(thresholdFor(6)).toBe(4);
    expect(thresholdFor(15)).toBe(600);
  });
});

describe("dedupNested", () => {
  it("drops a parent whose child is present and keeps unrelated cells", () => {
    const parent = cellToParent(a, 7);
    const out = dedupNested(new Set([parent, a, far]));
    expect([...out].sort()).toEqual([a, far].sort());
  });
  it("keeps a coarser cell that is not an ancestor of any present cell", () => {
    const lone = latLngToCell(20.0, 20.0, 7);
    const out = dedupNested(new Set([lone, far]));
    expect([...out].sort()).toEqual([lone, far].sort());
  });
});

describe("aggregate", () => {
  const cells: SeasonCells = {
    small: entry([a]),
    big: entry([...gridDisk(far, 1)]), // 7 cells ≈ 5 km²
    shared: entry([a, b]), // shares `a` with `small`
  };
  const sizes = fireSizes(cells);

  it("at threshold 0 counts shared ground once and rolls up to res 6", () => {
    const agg = aggregate(cells, sizes, 0);
    expect(agg.threshold).toBe(0);
    expect(agg.fires).toBe(3);
    const union = new Set([a, b, ...gridDisk(far, 1)]);
    const expected = new Map<string, number>();
    for (const c of union) {
      const p = cellToParent(c, 6);
      expected.set(p, (expected.get(p) ?? 0) + km2(c));
    }
    const want = [...expected.entries()].map(([p, v]) => [p, r1(v)] as [string, number]).sort();
    expect(agg.r6).toEqual(want);
    expect(agg.km2).toBe(r1(want.reduce((s, [, v]) => s + v, 0)));
  });

  it("drops fires below the threshold and keeps the ones on it", () => {
    const t = sizes.get("shared")!;
    const agg = aggregate(cells, sizes, t);
    expect(agg.fires).toBe(2); // shared (== t) and big (> t)
    const flat = agg.r6.map(([c]) => c);
    expect(flat).toContain(cellToParent(far, 6));
  });

  it("applies the nested-parent rule inside one fire", () => {
    const parent = cellToParent(a, 7);
    const one: SeasonCells = { p: entry([parent, a]) };
    const agg = aggregate(one, fireSizes(one), 0);
    expect(agg.r6).toEqual([[cellToParent(a, 6), r1(km2(a))]]);
    expect(fireSizes(one).get("p")).toBeCloseTo(km2(a), 6);
  });

  it("does NOT dedup a parent from one fire against a child from another — pipeline parity", () => {
    const parent = cellToParent(a, 7);
    const two: SeasonCells = { p: entry([parent]), c: entry([a]) };
    const agg = aggregate(two, fireSizes(two), 0);
    // pipeline/export_season.py::aggregate_r6 dedups per fire, then unions:
    // both cells survive, so the hex carries parent + child area.
    expect(agg.r6).toEqual([[cellToParent(a, 6), r1(km2(parent) + km2(a))]]);
  });

  it("empty selection yields no hexes and zero totals", () => {
    const agg = aggregate(cells, sizes, 1e9);
    expect(agg).toEqual({ threshold: 1e9, r6: [], fires: 0, km2: 0 });
  });
});

describe("filterLabel", () => {
  it("reads 'all sizes' at index 0 and '≥ t km²' otherwise", () => {
    expect(filterLabel(0, { fires: 21672, km2: 60471.6 })).toBe("all sizes · 21,672 fires · 60,472 km²");
    expect(filterLabel(6, { fires: 4355, km2: 54229.4 })).toBe("≥ 4 km² · 4,355 fires · 54,229 km²");
    expect(filterLabel(1, { fires: 1, km2: 0.7 })).toBe("≥ 0.7 km² · 1 fires · 1 km²");
  });
});
