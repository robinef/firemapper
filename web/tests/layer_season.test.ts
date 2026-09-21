// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cellToLatLng, cellToParent, latLngToCell } from "h3-js";
import {
  HEX_OPACITY_PENDING,
  HEX_OPACITY_INSTALLED,
  MAX_CELLS_ATTEMPTS,
  SEASON_CELLS_SOURCE,
  SEASON_HEAT_SOURCE,
  SEASON_HEX_SOURCE,
  SEASON_LAYER_IDS,
  addSeason,
  cellFeatures,
  createSeasonCellsLoader,
  formatFloor,
  heatPointFeatures,
  hexFeaturesCached,
  seasonLegend,
  seasonStatus,
  setCellsThreshold,
  setSeasonAggregate,
} from "../src/layer_season";
import type { SeasonSummary } from "../src/types";

/** Stub map in the style of tests/layer_scale_blob.test.ts: records sources
 * and layer defs so tests can assert on what was added and in what order. */
export function stubMap(zoom = 4) {
  const sources: Record<string, any> = {};
  const layers: string[] = [];
  const layerDefs: Record<string, any> = {};
  const paint: Record<string, Record<string, unknown>> = {};
  const handlers: Record<string, Array<() => void>> = {};
  const filters: Record<string, unknown> = {};
  return {
    _sources: sources, _layers: layers, _paint: paint, _handlers: handlers, _filters: filters,
    zoom,
    getZoom() { return this.zoom; },
    getSource: (id: string) => sources[id],
    addSource: (id: string, def: any) => {
      sources[id] = { ...def, setData: vi.fn((data: any) => { sources[id].data = data; }) };
    },
    addLayer: (def: any) => { layers.push(def.id); layerDefs[def.id] = def; },
    getLayerDef: (id: string) => layerDefs[id],
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    setPaintProperty: (id: string, prop: string, value: unknown) => {
      paint[id] = { ...(paint[id] ?? {}), [prop]: value };
    },
    setFilter: (id: string, f: unknown) => { filters[id] = f; },
    on: (ev: string, fn: () => void) => { (handlers[ev] ??= []).push(fn); },
    fire: (ev: string) => { for (const fn of handlers[ev] ?? []) fn(); },
  };
}

const r6cell = latLngToCell(45.0, 5.0, 6);
export const SUMMARY: SeasonSummary = {
  year: 2026, generated_at: "2026-09-18T10:00:00Z", floor: "2026-07-13",
  fires: 21350, km2: 88904.4, r6: [[r6cell, 12.6]],
};

describe("season feature builders", () => {
  it("heat points sit on the res-6 centroid and carry km2 as weight input", () => {
    const [f] = heatPointFeatures(SUMMARY.r6);
    const [lat, lng] = cellToLatLng(r6cell);
    expect(f.geometry).toEqual({ type: "Point", coordinates: [lng, lat] });
    expect(f.properties).toEqual({ km2: 12.6, cell: r6cell });
  });

  it("cell features flatten every fire's cells into closed hex polygons tagged with the fire id", () => {
    const a = latLngToCell(45.0, 5.0, 8);
    const b = latLngToCell(46.0, 6.0, 8);
    const feats = cellFeatures({
      "fire-1": { digest: "d", first: "2026-07-01", cells: [a] },
      "fire-2": { digest: "e", first: "2026-07-02", cells: [b] },
    });
    expect(feats.map((f) => f.properties)).toEqual([
      { cell: a, fire_id: "fire-1", km2: 0 },
      { cell: b, fire_id: "fire-2", km2: 0 },
    ]);
    const ring = (feats[0].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring.length).toBe(7);
    expect(ring[0]).toEqual(ring[6]);
  });

  it("a cell two fires both burned yields one polygon, tagged with the first fire", () => {
    const shared = latLngToCell(45.0, 5.0, 8);
    const other = latLngToCell(46.0, 6.0, 8);
    const feats = cellFeatures({
      "fire-1": { digest: "d", first: "2026-07-01", cells: [shared] },
      "fire-2": { digest: "e", first: "2026-07-02", cells: [shared, other] },
    });
    expect(feats.map((f) => f.properties)).toEqual([
      { cell: shared, fire_id: "fire-1", km2: 0 },
      { cell: other, fire_id: "fire-2", km2: 0 },
    ]);
  });

  // Same rule as fireSizes/aggregate, applied per fire: a coarse Meteosat
  // cell whose finer VIIRS children the SAME fire also has is not extra
  // ground, it is the same ground twice. Drawing it would paint a res-7
  // blanket the hex band (which dedups) never counted.
  it("a fire's coarse cell is dropped when that fire also holds its finer children", () => {
    const child = latLngToCell(45.0, 5.0, 8);
    const parent = cellToParent(child, 7);
    const feats = cellFeatures({
      "fire-1": { digest: "d", first: "2026-07-01", cells: [parent, child] },
    });
    expect(feats).toHaveLength(1);
    expect(feats[0].properties).toEqual({ cell: child, fire_id: "fire-1", km2: 0 });
  });

  it("another fire's independent coarse cell survives — dedup is per fire, as the pipeline does it", () => {
    const child = latLngToCell(45.0, 5.0, 8);
    const parent = cellToParent(child, 7);
    const feats = cellFeatures({
      "fire-1": { digest: "d", first: "2026-07-01", cells: [child] },
      "fire-2": { digest: "e", first: "2026-07-02", cells: [parent] },
    });
    expect(feats.map((f) => f.properties?.cell)).toEqual([child, parent]);
  });
});

describe("addSeason", () => {
  it("adds every source and layer at boot, cells source empty, hexes without maxzoom", () => {
    const map = stubMap();
    addSeason(map as never, SUMMARY);
    expect(map._layers).toEqual(SEASON_LAYER_IDS);
    expect(map._sources[SEASON_HEX_SOURCE].data.features).toHaveLength(1);
    expect(map._sources[SEASON_CELLS_SOURCE].data).toEqual({ type: "FeatureCollection", features: [] });
    expect(map._sources[SEASON_HEAT_SOURCE].data.features).toHaveLength(1);
    expect(map.getLayerDef("season-hex-fill").maxzoom).toBeUndefined();
    expect(map.getLayerDef("season-hex-line").maxzoom).toBeUndefined();
    expect(map.getLayerDef("season-heat").maxzoom).toBe(6.5);
    expect(map.getLayerDef("season-hex-fill").paint["fill-opacity"]).toEqual(HEX_OPACITY_PENDING);
  });

  it("is idempotent: a second call only refreshes the hex/heat data", () => {
    const map = stubMap();
    addSeason(map as never, SUMMARY);
    addSeason(map as never, { ...SUMMARY, r6: [] });
    expect(map._layers).toEqual(SEASON_LAYER_IDS);
    expect(map._sources[SEASON_HEX_SOURCE].data.features).toHaveLength(0);
    expect(map._sources[SEASON_HEAT_SOURCE].data.features).toHaveLength(0);
  });
});

describe("legend + status", () => {
  // "footprint", not plain "km²": the number is satellite heat coverage
  // (0.7 km² per detection, agricultural burning included), 2–3× the mapped
  // burn area the /scale page reports from EFFIS for the same fires.
  it("status counts fires and km² of footprint since the floor", () => {
    expect(seasonStatus(SUMMARY)).toBe("21,350 fires · 88,904 km² footprint since 13 Jul");
  });

  it("status omits the floor when there is none", () => {
    expect(seasonStatus({ ...SUMMARY, floor: null, fires: 0, km2: 0 })).toBe("0 fires · 0 km² footprint");
  });

  it("status names the EU-27 scope, and only when it is on", () => {
    expect(seasonStatus({ ...SUMMARY, fires: 1203, km2: 9812 }, "eu"))
      .toBe("EU-27 · 1,203 fires · 9,812 km² footprint since 13 Jul");
    expect(seasonStatus({ ...SUMMARY, fires: 1203, km2: 9812 }, "all"))
      .toBe("1,203 fires · 9,812 km² footprint since 13 Jul");
    expect(seasonStatus({ ...SUMMARY, floor: null, fires: 5, km2: 4 }, "eu")).toBe("EU-27 · 5 fires · 4 km² footprint");
  });

  it("formatFloor renders a UTC day-month", () => {
    expect(formatFloor("2026-07-13")).toBe("13 Jul");
  });

  it("legend note discloses the floor", () => {
    const legend = seasonLegend("2026-07-13", 2026);
    expect(legend.title).toBe("Burned this year · 2026");
    expect(legend.entries).toHaveLength(4);
    expect(legend.note).toContain("since 13 Jul 2026");
    expect(legend.note).toContain("not yet archived");
  });

  // The whole point of the note: a reader comparing this layer's 60.8k km²
  // with /scale's 6.7k km² must be told why they differ before concluding one
  // of them is wrong. The multiplier is "roughly double" and the comparison is
  // per REGION: the app's own EU-27 figure is 12,348 km² against EFFIS's
  // 6,741 (1.8×, and 1.0× once the slider reaches ≥ 4 km²), so "2–3×" would
  // be a number the app itself contradicts on screen.
  it("legend note says what the area actually measures", () => {
    const legend = seasonLegend("2026-07-13", 2026);
    expect(legend.note).toContain("satellite heat footprint");
    expect(legend.note).toContain("0.7 km² cell");
    expect(legend.note).toContain("agricultural burning is included");
    expect(legend.note).toContain("roughly double the mapped burn area EFFIS reports for the same region");
    expect(legend.note).not.toContain("2–3×");
    expect(legend.note).toContain("Zoom in for the real burned ground.");
  });

  it("the title names the season's year, not the floor's — a floor can sit in the year before", () => {
    const legend = seasonLegend("2025-12-30", 2026);
    expect(legend.title).toBe("Burned this year · 2026");
    expect(legend.note).toContain("since 30 Dec 2025");
  });
});

describe("createSeasonCellsLoader", () => {
  const a = latLngToCell(45.0, 5.0, 8);
  const body = { "fire-1": { digest: "d", first: "2026-07-01", cells: [a] } };
  const okFetch = () => {
    const fn = vi.fn(async () => ({ ok: true, json: async () => body }));
    return fn;
  };

  function mounted(zoom: number) {
    const map = stubMap(zoom);
    addSeason(map as never, SUMMARY);
    return map;
  }

  it("does not fetch below the prefetch zoom", async () => {
    const map = mounted(7);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    await loader.ensure();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(loader.state()).toBe("idle");
  });

  it("does not fetch while the layer is off", async () => {
    const map = mounted(10);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => false, fetchFn as never);
    await loader.ensure();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches once at z10, installs cells, swaps the hex fade in, never refetches", async () => {
    const map = mounted(10);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    await loader.ensure();
    await loader.ensure();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls as unknown as Array<[string]>)[0][0]).toBe("/data/archive/season_2026_cells.json");
    expect(map._sources[SEASON_CELLS_SOURCE].data.features).toHaveLength(1);
    expect(map._paint["season-hex-fill"]["fill-opacity"]).toEqual(HEX_OPACITY_INSTALLED);
    expect(loader.state()).toBe("loaded");
  });

  it("a failed fetch leaves hexes pending and allows a retry", async () => {
    const map = mounted(10);
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => body };
    });
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    await loader.ensure();
    expect(loader.state()).toBe("idle");
    expect(map._paint["season-hex-fill"]).toBeUndefined();
    await loader.ensure();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(loader.state()).toBe("loaded");
  });

  it("gives up after MAX_CELLS_ATTEMPTS failures instead of refetching megabytes on every pan", async () => {
    const map = mounted(10);
    const fetchFn = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    for (let i = 0; i < 5; i += 1) await loader.ensure();
    expect(fetchFn).toHaveBeenCalledTimes(MAX_CELLS_ATTEMPTS);
    expect(MAX_CELLS_ATTEMPTS).toBe(3);
    // The hex band keeps rendering at its pending opacity.
    expect(loader.state()).toBe("idle");
    expect(map._paint["season-hex-fill"]).toBeUndefined();
  });

  it("collapses overlapping calls into one fetch", async () => {
    const map = mounted(10);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    await Promise.all([loader.ensure(), loader.ensure()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("wires zoomend and moveend to ensure()", async () => {
    const map = mounted(10);
    const fetchFn = okFetch();
    createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    map.fire("zoomend");
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(Object.keys(map._handlers).sort()).toEqual(["moveend", "zoomend"]);
  });

  it("a later addSeason refresh leaves installed cells in place", async () => {
    const map = mounted(10);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    await loader.ensure();
    addSeason(map as never, { ...SUMMARY, r6: [] });
    expect(map._sources[SEASON_CELLS_SOURCE].data.features).toHaveLength(1);
    expect(map._layers).toEqual(SEASON_LAYER_IDS);
  });
});

describe("cells carry km2 and filter GPU-side", () => {
  const a = latLngToCell(45.0, 5.0, 8);
  const b = latLngToCell(46.0, 6.0, 8);
  const cells = {
    "fire-1": { digest: "d", first: "2026-07-01", cells: [a] },
    "fire-2": { digest: "e", first: "2026-07-02", cells: [b] },
  };

  it("cellFeatures tags each polygon with its fire's km2 when sizes are given", () => {
    const sizes = new Map([["fire-1", 0.7], ["fire-2", 12.5]]);
    const feats = cellFeatures(cells, sizes);
    expect(feats.map((f) => f.properties)).toEqual([
      { cell: a, fire_id: "fire-1", km2: 0.7 },
      { cell: b, fire_id: "fire-2", km2: 12.5 },
    ]);
  });

  it("cellFeatures defaults km2 to 0 without sizes", () => {
    expect(cellFeatures(cells)[0].properties).toEqual({ cell: a, fire_id: "fire-1", km2: 0 });
  });

  it("cellFeatures carries the largest claimant's km2; fire_id is the first", () => {
    const shared = latLngToCell(45.0, 5.0, 8);
    const sizes = new Map([["fire-1", 0.6], ["fire-2", 50]]);
    const feats = cellFeatures({
      "fire-1": { digest: "d", first: "2026-07-01", cells: [shared] },
      "fire-2": { digest: "e", first: "2026-07-02", cells: [shared] },
    }, sizes);
    expect(feats).toHaveLength(1);
    expect(feats[0].properties).toEqual({ cell: shared, fire_id: "fire-1", km2: 50 });
  });

  it("setCellsThreshold filters both cell layers and clears at 0", () => {
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    setCellsThreshold(map as never, 4);
    expect(map._filters["season-cells-fill"]).toEqual([">=", ["get", "km2"], 4]);
    expect(map._filters["season-cells-line"]).toEqual([">=", ["get", "km2"], 4]);
    setCellsThreshold(map as never, 0);
    expect(map._filters["season-cells-fill"]).toBeNull();
    expect(map._filters["season-cells-line"]).toBeNull();
  });

  // Four combinations. All-Europe filters on `km2` (the largest claimant of
  // any nationality); EU-27 filters on `eu_km2` (the largest EU claimant), so
  // one clause always says everything and the `all` wrapper is never needed.
  it("setCellsThreshold picks the size property the scope is about", () => {
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    const both = ["season-cells-fill", "season-cells-line"];

    setCellsThreshold(map as never, 0, "all");
    for (const id of both) expect(map._filters[id]).toBeNull();

    setCellsThreshold(map as never, 4, "all");
    for (const id of both) expect(map._filters[id]).toEqual([">=", ["get", "km2"], 4]);

    // t = 0 under EU still filters: a cell with no EU claimant at all has
    // eu_km2 = 0 and must not be drawn.
    setCellsThreshold(map as never, 0, "eu");
    for (const id of both) expect(map._filters[id]).toEqual([">", ["get", "eu_km2"], 0]);

    setCellsThreshold(map as never, 4, "eu");
    for (const id of both) expect(map._filters[id]).toEqual([">=", ["get", "eu_km2"], 4]);
  });

  it("setCellsThreshold defaults to the whole Europe box", () => {
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    setCellsThreshold(map as never, 4);
    expect(map._filters["season-cells-fill"]).toEqual([">=", ["get", "km2"], 4]);
  });

  // A cell is EU if ANY claiming fire is — the same rule km2 uses (max across
  // claimants), not "whatever the first claimant happened to be". Tagging by
  // first claimant would blank ground that really did burn inside the EU
  // whenever a foreign fire happened to be enumerated first.
  //
  // But the max has to be taken over the EU claimants ALONE. A boolean `eu`
  // maxed independently of `km2` describes a cell that may not exist: a cell
  // burned by a small EU fire and a large foreign one would carry km2 = 50
  // and eu = 1, pass an "EU-27, ≥ 4 km²" filter, and be drawn under hexes
  // that deliberately excluded it.
  it("cellFeatures maxes each extra property across claiming fires, and eu_km2 over the EU ones", () => {
    const shared = latLngToCell(45.0, 5.0, 8);
    const isEu: Record<string, boolean> = { "fire-es": true, "fire-ua": false };
    const sizes = new Map([["fire-es", 0.6], ["fire-ua", 50]]);
    const feats = cellFeatures(
      {
        "fire-ua": { digest: "e", first: "2026-07-02", cells: [shared] },
        "fire-es": { digest: "d", first: "2026-07-01", cells: [shared] },
      },
      sizes,
      (id, km2) => ({ eu_km2: isEu[id] ? km2 : 0 }),
    );
    expect(feats).toHaveLength(1);
    // km2 is still the biggest claimant of any nationality; eu_km2 is the
    // biggest EU one — 0.6, not 50, and not a bare 1.
    expect(feats[0].properties).toEqual({ cell: shared, fire_id: "fire-ua", km2: 50, eu_km2: 0.6 });
  });

  // The equivalence that matters: a cell survives the GPU filter exactly when
  // the hex aggregate for the same (scope, threshold) counted it. Evaluated
  // here against the real filter expressions setCellsThreshold produces.
  const passes = (expr: unknown, props: Record<string, unknown>): boolean => {
    if (expr === null) return true;
    const [op, get, v] = expr as [string, [string, string], number];
    const value = Number(props[get[1]]);
    return op === ">=" ? value >= v : op === ">" ? value > v : false;
  };

  it("a cell shared by a small EU fire and a big foreign one is dropped by 'EU-27, ≥ 4 km²'", () => {
    const shared = latLngToCell(45.0, 5.0, 8);
    const ownCell = latLngToCell(46.0, 6.0, 8);
    const isEu: Record<string, boolean> = { "fire-es": true, "fire-ua": false };
    const sizes = new Map([["fire-es", 0.6], ["fire-ua", 50]]);
    const feats = cellFeatures(
      {
        "fire-ua": { digest: "e", first: "2026-07-02", cells: [shared, ownCell] },
        "fire-es": { digest: "d", first: "2026-07-01", cells: [shared] },
      },
      sizes,
      (id, km2) => ({ eu_km2: isEu[id] ? km2 : 0 }),
    );
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    const drawn = (t: number, scope: "all" | "eu") => {
      setCellsThreshold(map as never, t, scope);
      const expr = map._filters["season-cells-fill"];
      return feats.filter((f) => passes(expr, f.properties as Record<string, unknown>))
        .map((f) => (f.properties as { cell: string }).cell).sort();
    };
    // All Europe: the 50 km² Ukrainian fire carries both its cells.
    expect(drawn(0, "all")).toEqual([shared, ownCell].sort());
    expect(drawn(4, "all")).toEqual([shared, ownCell].sort());
    // EU-27: only the shared cell has an EU claimant at all…
    expect(drawn(0, "eu")).toEqual([shared]);
    // …and that claimant is 0.6 km², so at ≥ 4 km² nothing is drawn — which
    // is exactly what aggregate(cells, sizes, 4, euOnly) counts: no fires.
    expect(drawn(4, "eu")).toEqual([]);
  });

  it("cellFeatures carries extra properties per fire and omits them when no extra is given", () => {
    const a2 = latLngToCell(45.0, 5.0, 8);
    const b2 = latLngToCell(46.0, 6.0, 8);
    const src = {
      "fire-1": { digest: "d", first: "2026-07-01", cells: [a2] },
      "fire-2": { digest: "e", first: "2026-07-02", cells: [b2] },
    };
    const sizes = new Map([["fire-1", 3], ["fire-2", 9]]);
    const tagged = cellFeatures(src, sizes, (id, km2) => ({ eu_km2: id === "fire-1" ? km2 : 0 }));
    expect(tagged.map((f) => f.properties)).toEqual([
      { cell: a2, fire_id: "fire-1", km2: 3, eu_km2: 3 },
      { cell: b2, fire_id: "fire-2", km2: 9, eu_km2: 0 },
    ]);
    expect(cellFeatures(src)[0].properties).toEqual({ cell: a2, fire_id: "fire-1", km2: 0 });
  });

  it("setSeasonAggregate refreshes heat and hex sources and leaves cells alone", () => {
    const map = stubMap(6);
    addSeason(map as never, SUMMARY);
    const cellsSetData = map._sources[SEASON_CELLS_SOURCE].setData;
    setSeasonAggregate(map as never, SUMMARY.r6);
    const heatFeats = map._sources[SEASON_HEAT_SOURCE].data.features;
    const hexFeats = map._sources[SEASON_HEX_SOURCE].data.features;
    expect(heatFeats).toHaveLength(1);
    expect((heatFeats[0].geometry as GeoJSON.Point).type).toBe("Point");
    expect(hexFeats).toHaveLength(1);
    expect((hexFeats[0].geometry as GeoJSON.Polygon).type).toBe("Polygon");
    expect(cellsSetData).not.toHaveBeenCalled();
  });

  it("hexFeaturesCached builds the same shape as the boot hexes and reuses rings", () => {
    const r6 = SUMMARY.r6;
    const first = hexFeaturesCached(r6);
    const second = hexFeaturesCached(r6);
    expect(first[0].properties).toEqual({ n: 12.6, cell: r6[0][0] });
    expect((first[0].geometry as GeoJSON.Polygon).coordinates[0]).toHaveLength(7);
    // Same ring object reused: the cache hands back the identical array.
    expect((second[0].geometry as GeoJSON.Polygon).coordinates[0]).toBe(
      (first[0].geometry as GeoJSON.Polygon).coordinates[0],
    );
  });
});

describe("loader force + hooks", () => {
  const a = latLngToCell(45.0, 5.0, 8);
  const body = { "fire-1": { digest: "d", first: "2026-07-01", cells: [a] } };
  const okFetch = () => vi.fn(async () => ({ ok: true, json: async () => body }));

  it("ensure({force:true}) fetches below the prefetch zoom and reports cells + sizes once", async () => {
    const map = stubMap(4);
    addSeason(map as never, SUMMARY);
    const fetchFn = okFetch();
    const onLoaded = vi.fn();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never, { onLoaded });
    await loader.ensure();
    expect(fetchFn).not.toHaveBeenCalled();
    await loader.ensure({ force: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    const [cells, sizes] = onLoaded.mock.calls[0] as [unknown, Map<string, number>];
    expect(cells).toEqual(body);
    expect(sizes.get("fire-1")).toBeGreaterThan(0.5);
  });

  // The histogram needs the FILE at any zoom; the map needs the GEOMETRY only
  // from z8. Building ~160k polygons and handing maplibre a 33 MB
  // FeatureCollection is hundreds of ms of main-thread work plus a GPU upload
  // — a reader who stays at z4 must never pay it.
  it("a forced fetch below the prefetch zoom stops at 'fetched': sizes reported, nothing installed", async () => {
    const map = stubMap(4);
    addSeason(map as never, SUMMARY);
    const fetchFn = okFetch();
    const onLoaded = vi.fn();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never, { onLoaded });
    await loader.ensure({ force: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(loader.state()).toBe("fetched");
    expect(map._sources[SEASON_CELLS_SOURCE].data.features).toHaveLength(0);
    expect(map._paint["season-hex-fill"]).toBeUndefined();

    // Approaching the cells band installs what is already in memory — no
    // second request.
    map.zoom = 8;
    map.fire("zoomend");
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(loader.state()).toBe("loaded");
    const sizes = (onLoaded.mock.calls[0] as [unknown, Map<string, number>])[1];
    expect(map._sources[SEASON_CELLS_SOURCE].data.features[0].properties.km2).toBeCloseTo(sizes.get("fire-1")!, 6);
    expect(map._paint["season-hex-fill"]["fill-opacity"]).toEqual(HEX_OPACITY_INSTALLED);
  });

  // Panning at z4 fires moveend → ensure() with no `force`. The zoom gate for
  // a FETCH is below the fetched branch, so "unforced" cannot be read as
  // "past the gate" here: only the zoom itself may release the install.
  it("panning below the prefetch zoom does not install the held cells", async () => {
    const map = stubMap(4);
    addSeason(map as never, SUMMARY);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    await loader.ensure({ force: true });
    map.fire("moveend");
    map.fire("zoomend");
    await Promise.resolve();
    expect(loader.state()).toBe("fetched");
    expect(map._sources[SEASON_CELLS_SOURCE].data.features).toHaveLength(0);
    expect(map._paint["season-hex-fill"]).toBeUndefined();
  });

  it("a deferred install repeats neither the setData nor the fetch", async () => {
    const map = stubMap(4);
    addSeason(map as never, SUMMARY);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    await loader.ensure({ force: true });
    map.zoom = 10;
    await loader.ensure();
    await loader.ensure();
    map.fire("moveend");
    await Promise.resolve();
    expect(map._sources[SEASON_CELLS_SOURCE].setData).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(loader.state()).toBe("loaded");
  });

  // The size slider is usable at z4, long before any cell geometry exists:
  // the threshold is a LAYER filter, so it survives being set first.
  it("a threshold set while the cells are only 'fetched' still applies after the install", async () => {
    const map = stubMap(4);
    addSeason(map as never, SUMMARY);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never);
    await loader.ensure({ force: true });
    setCellsThreshold(map as never, 4);
    map.zoom = 8;
    map.fire("zoomend");
    await Promise.resolve();
    expect(loader.state()).toBe("loaded");
    expect(map._filters["season-cells-fill"]).toEqual([">=", ["get", "km2"], 4]);
    expect(map._filters["season-cells-line"]).toEqual([">=", ["get", "km2"], 4]);
  });

  it("force still respects the layer being off", async () => {
    const map = stubMap(4);
    addSeason(map as never, SUMMARY);
    const fetchFn = okFetch();
    const loader = createSeasonCellsLoader(map as never, 2026, () => false, fetchFn as never);
    await loader.ensure({ force: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("onGaveUp fires exactly once when the attempt cap is reached", async () => {
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    const fetchFn = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    const onGaveUp = vi.fn();
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never, { onGaveUp });
    for (let i = 0; i < 5; i += 1) await loader.ensure();
    expect(fetchFn).toHaveBeenCalledTimes(MAX_CELLS_ATTEMPTS);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
  });

  it("onLoaded throwing does not refetch or fire onGaveUp", async () => {
    const map = stubMap(4);
    addSeason(map as never, SUMMARY);
    const fetchFn = okFetch();
    const onLoaded = vi.fn(() => { throw new Error("hook threw"); });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never, { onLoaded });
    await loader.ensure({ force: true });
    // z4: the data is in memory, the install waits for the approach to z7.5.
    expect(loader.state()).toBe("fetched");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Verify the hook's exception was logged and not treated as a fetch failure.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cells hook threw"), expect.any(Error));
    // A second ensure() should not refetch (state is still loaded).
    await loader.ensure({ force: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("malformed body (array instead of object) fails the load", async () => {
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => [] }));
    const onGaveUp = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never, { onGaveUp });
    // First attempt: fails, state resets to idle.
    await loader.ensure();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(loader.state()).toBe("idle");
    expect(map._sources[SEASON_CELLS_SOURCE].data.features).toHaveLength(0);
    // Retries until cap.
    for (let i = 0; i < 4; i += 1) await loader.ensure();
    expect(fetchFn).toHaveBeenCalledTimes(MAX_CELLS_ATTEMPTS);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// The countries file and the cells file are two independent downloads, in
// either order. Whichever lands second has to be able to re-tag what is
// already on the map, or the EU-27 filter would hide every cell installed
// before the countries arrived.
describe("loader cellProps + retag", () => {
  const a = latLngToCell(45.0, 5.0, 8);
  const body = { "fire-1": { digest: "d", first: "2026-07-01", cells: [a] } };
  const okFetch = () => vi.fn(async () => ({ ok: true, json: async () => body }));
  const props = (map: ReturnType<typeof stubMap>) =>
    map._sources[SEASON_CELLS_SOURCE].data.features[0].properties;

  it("installs cells tagged by cellProps, and retag() re-tags them with the current answer", async () => {
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    let isEu = false;
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, okFetch() as never, {
      cellProps: (_id, km2) => ({ eu_km2: isEu ? km2 : 0 }),
    });
    await loader.ensure();
    expect(loader.state()).toBe("loaded");
    expect(props(map).eu_km2).toBe(0);
    expect(map._sources[SEASON_CELLS_SOURCE].setData).toHaveBeenCalledTimes(1);

    isEu = true; // the countries file just landed
    loader.retag();
    expect(map._sources[SEASON_CELLS_SOURCE].setData).toHaveBeenCalledTimes(2);
    // The fire's own size, handed to cellProps by the loader — not a boolean.
    expect(props(map).eu_km2).toBeCloseTo(props(map).km2, 6);
    expect(props(map).eu_km2).toBeGreaterThan(0.5);
    expect(props(map).fire_id).toBe("fire-1"); // everything else survives the re-tag
  });

  // The loader installs INSIDE the fetch try-block and fires onLoaded after
  // it, so at the first install past the zoom gate onLoaded has not run yet.
  // That is why cellProps is handed the fire's km² rather than reading a
  // caller-side `sizes` captured from onLoaded: such a capture is still null
  // here, and every cell would install tagged 0.
  it("evaluates cellProps at install time, before onLoaded", async () => {
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    const order: string[] = [];
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, okFetch() as never, {
      cellProps: (_id, km2) => { order.push("cellProps"); return { eu_km2: km2 }; },
      onLoaded: () => { order.push("onLoaded"); },
    });
    await loader.ensure();
    expect(order).toEqual(["cellProps", "onLoaded"]);
    expect(props(map).eu_km2).toBeGreaterThan(0.5);
  });

  it("retag() is a no-op before the cells are installed", async () => {
    const map = stubMap(4);
    addSeason(map as never, SUMMARY);
    const fetchFn = okFetch();
    let isEu = false;
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, fetchFn as never, {
      cellProps: (_id, km2) => ({ eu_km2: isEu ? km2 : 0 }),
    });
    loader.retag(); // idle: nothing fetched, nothing to re-tag
    expect(map._sources[SEASON_CELLS_SOURCE].setData).not.toHaveBeenCalled();

    await loader.ensure({ force: true });
    expect(loader.state()).toBe("fetched");
    loader.retag(); // fetched but not installed: still nothing on the map
    expect(map._sources[SEASON_CELLS_SOURCE].setData).not.toHaveBeenCalled();

    // …and the deferred install uses the answer as of install time.
    isEu = true;
    map.zoom = 8;
    map.fire("zoomend");
    await Promise.resolve();
    expect(loader.state()).toBe("loaded");
    expect(props(map).eu_km2).toBeGreaterThan(0.5);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("without cellProps the installed cells carry no eu_km2 tag", async () => {
    const map = stubMap(10);
    addSeason(map as never, SUMMARY);
    const loader = createSeasonCellsLoader(map as never, 2026, () => true, okFetch() as never);
    await loader.ensure();
    expect(props(map).eu_km2).toBeUndefined();
    loader.retag();
    expect(props(map).eu_km2).toBeUndefined();
  });
});
