// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cellToLatLng, latLngToCell } from "h3-js";
import {
  HEX_OPACITY_PENDING,
  SEASON_CELLS_SOURCE,
  SEASON_HEX_SOURCE,
  SEASON_LAYER_IDS,
  addSeason,
  cellFeatures,
  formatFloor,
  heatPointFeatures,
  seasonLegend,
  seasonStatus,
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
  return {
    _sources: sources, _layers: layers, _paint: paint, _handlers: handlers,
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
      { cell: a, fire_id: "fire-1" },
      { cell: b, fire_id: "fire-2" },
    ]);
    const ring = (feats[0].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring.length).toBe(7);
    expect(ring[0]).toEqual(ring[6]);
  });
});

describe("addSeason", () => {
  it("adds every source and layer at boot, cells source empty, hexes without maxzoom", () => {
    const map = stubMap();
    addSeason(map as never, SUMMARY);
    expect(map._layers).toEqual(SEASON_LAYER_IDS);
    expect(map._sources[SEASON_HEX_SOURCE].data.features).toHaveLength(1);
    expect(map._sources[SEASON_CELLS_SOURCE].data).toEqual({ type: "FeatureCollection", features: [] });
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
  });
});

describe("legend + status", () => {
  it("status counts fires and km² since the floor", () => {
    expect(seasonStatus(SUMMARY)).toBe("21,350 fires · 88,904 km² since 13 Jul");
  });

  it("status omits the floor when there is none", () => {
    expect(seasonStatus({ ...SUMMARY, floor: null, fires: 0, km2: 0 })).toBe("0 fires · 0 km²");
  });

  it("formatFloor renders a UTC day-month", () => {
    expect(formatFloor("2026-07-13")).toBe("13 Jul");
  });

  it("legend note discloses the floor", () => {
    const legend = seasonLegend("2026-07-13");
    expect(legend.title).toBe("Burned this year · 2026");
    expect(legend.entries).toHaveLength(4);
    expect(legend.note).toContain("since 13 Jul 2026");
    expect(legend.note).toContain("not yet archived");
  });
});
