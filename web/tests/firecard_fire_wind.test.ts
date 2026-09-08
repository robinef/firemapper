/** @vitest-environment jsdom */
import { latLngToCell } from "h3-js";
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { Switcher } from "../src/registry";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it (see ui_events_wiring.test.ts's note on the same line).
window.URL.createObjectURL ??= () => "";

// jsdom has no canvas 2d backend; addFireWind draws its arrow icon on one
// (layer_wind.ts's streamlineImage) purely for maplibre's addImage, which
// this stub map never actually reads pixels from. A minimal no-op context
// is enough to let that draw call complete.
HTMLCanvasElement.prototype.getContext = ((): unknown => ({
  translate: () => {},
  strokeStyle: "",
  lineWidth: 0,
  lineCap: "",
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  stroke: () => {},
  getImageData: () => ({ data: new Uint8ClampedArray(0) }),
})) as typeof HTMLCanvasElement.prototype.getContext;

const FIRE: [number, number] = [18.35, 42.71];
const NEAR_CELL = latLngToCell(FIRE[1], FIRE[0], 8);
// Belgium — far enough from FIRE that footprintWind's 60 km cutoff drops it.
const FAR_CELL = latLngToCell(50.0, 5.0, 8);

const TRACKS: Record<string, unknown> = {
  "fire-with-wind": { series: [], cell_bins: null, cells: [NEAR_CELL] },
  "fire-no-match": { series: [], cell_bins: null, cells: [FAR_CELL] },
  "fire-no-track": null,
  "scar-with-wind": { series: [], cell_bins: null, cells: [NEAR_CELL] },
  // Has BOTH cell_bins (triggers ensureFootprint's lazy fire-bin-fill/
  // fire-bin-line creation) and a footprint-wind match, so opening it is
  // the one scenario where both layers get created in the same open() call.
  "fire-with-wind-and-footprint": {
    series: [{ bin: "2026-08-08T00:00:00Z", centroid: [FIRE[1], FIRE[0]], new_cells: 1, cum_cells: 1, frp_sum: 1 }],
    cell_bins: [["2026-08-08T00:00:00Z", [NEAR_CELL]]],
    cells: [NEAR_CELL],
  },
};

vi.mock("../src/data", () => ({
  loadTrack: (_m: unknown, id: string) => {
    const t = TRACKS[id];
    return t ? Promise.resolve(t) : Promise.reject(new Error("no track"));
  },
}));

const WIND_POINTS: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type: "Point", coordinates: FIRE },
    properties: { from_deg: 240, kmh: 22, t: new Date().toISOString() },
  }],
};

/** A working fake of the maplibre surface layer_wind.ts's addFireWind/
 *  clearFireWind actually touches — real enough that visibility toggles and
 *  source data updates are observable, not just "was this called." */
function stubMap() {
  const images = new Set<string>();
  const sources = new Map<string, { data: GeoJSON.FeatureCollection }>();
  const layers = new Map<string, { layout: Record<string, unknown> }>();
  // Render order: index 0 is bottom, last is top — same as maplibre's own
  // style.layers array, so this catches the exact bug a real map would show.
  const order: string[] = [];
  const map = {
    hasImage: (name: string) => images.has(name),
    addImage: (name: string) => void images.add(name),
    getSource: (id: string) => {
      const s = sources.get(id);
      if (!s) return undefined;
      return { setData: (d: GeoJSON.FeatureCollection) => void (s.data = d) };
    },
    addSource: (id: string, opts: { data: GeoJSON.FeatureCollection }) =>
      void sources.set(id, { data: opts.data }),
    getLayer: (id: string) => layers.get(id) ?? null,
    addLayer: (spec: { id: string; layout?: Record<string, unknown> }) => {
      layers.set(spec.id, { layout: { ...spec.layout } });
      order.push(spec.id);
    },
    setLayoutProperty: (id: string, prop: string, val: unknown) => {
      const l = layers.get(id);
      if (l) l.layout[prop] = val;
    },
    // No beforeId (the only form addFireWind uses): moves id to the very
    // top, same as real maplibre's moveLayer(id).
    moveLayer: (id: string) => {
      const i = order.indexOf(id);
      if (i === -1) return;
      order.splice(i, 1);
      order.push(id);
    },
    setPaintProperty: () => {},
    getPaintProperty: () => 1,
    on: () => {},
    off: () => {},
    flyTo: () => {},
    getCanvas: () => ({ style: {} }),
  } as unknown as maplibregl.Map;
  return {
    map,
    fireWindVisibility: () => layers.get("fire-wind-arrows")?.layout.visibility,
    fireWindFeatureCount: () => sources.get("fire-wind")?.data.features.length,
    layerOrder: () => order.slice(),
  };
}

function fireProps(id: string) {
  return {
    id,
    status: "active",
    lifecycle_age_h: 1,
    started: "2026-07-01T00:00:00Z",
    area_km2: 1,
    cum_cells: 1,
    movement: null,
    freshness: JSON.stringify({ viirs: "2026-07-01T00:00:00Z" }),
    place: null,
  };
}

function fireClick(id: string): maplibregl.MapLayerMouseEvent {
  return {
    features: [{ properties: fireProps(id), geometry: { type: "Point", coordinates: FIRE } }],
    lngLat: { lng: FIRE[0], lat: FIRE[1] },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

function scarClick(id: string): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: {
        id, label: "Scar", kind: "past", lat: FIRE[1], lon: FIRE[0], track_gen: "archive",
        started: "2020-01-01", before: "2020-01-01", after: "2020-01-05",
      },
      geometry: { type: "Point", coordinates: FIRE },
    }],
    lngLat: { lng: FIRE[0], lat: FIRE[1] },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

async function buildCard(map: maplibregl.Map, opts?: { windOn?: boolean }) {
  document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
  const windOn = opts?.windOn ?? true;
  const switcher: Switcher = { isOn: (k) => (k === "wind" ? windOn : true), setLevel: () => {}, refresh: () => {} };
  const { setupFireCard } = await import("../src/firecard");
  return setupFireCard(
    map, { generation: "gen-1", layers: {} } as never, null,
    document.getElementById("timeline")!, switcher, () => {}, () => {},
    WIND_POINTS,
  );
}

describe("fire card footprint wind arrows", () => {
  it("adds a visible arrow per footprint cell with a wind sample in range", async () => {
    const { map, fireWindVisibility, fireWindFeatureCount } = stubMap();
    await (await buildCard(map)).openFire(fireClick("fire-with-wind"));

    expect(fireWindVisibility()).toBe("visible");
    expect(fireWindFeatureCount()).toBe(1);
  });

  it("stays hidden on open when the Wind toggle is off", async () => {
    // Live 2026-09: the "Wind" checkbox unchecked still showed these arrows —
    // addFireWind forces itself visible on every open regardless of the
    // toggle, and nothing corrected that afterward. firecard.ts must.
    const { map, fireWindVisibility, fireWindFeatureCount } = stubMap();
    await (await buildCard(map, { windOn: false })).openFire(fireClick("fire-with-wind"));

    expect(fireWindVisibility()).toBe("none");
    // The data is still there — a later toggle-on needs no re-fetch/re-open.
    expect(fireWindFeatureCount()).toBe(1);
  });

  it("shows no arrows when the fire's footprint has no cell in wind range", async () => {
    const { map, fireWindVisibility } = stubMap();
    await (await buildCard(map)).openFire(fireClick("fire-no-match"));

    // No matching cell means addFireWind is never called at all — the
    // layer may not even exist yet, which reads as "not visible", same as
    // an explicit clear would.
    expect(fireWindVisibility()).not.toBe("visible");
  });

  it("never adds fire-wind for a scar, even with a matching cell and available wind", async () => {
    const { map, fireWindVisibility } = stubMap();
    const card = await buildCard(map);
    // Open a real fire first so the layer exists and is visible, then confirm
    // the scar path clears it rather than repopulating it — proves this is
    // not merely "scar never happened to call addFireWind" but an active clear.
    await card.openFire(fireClick("fire-with-wind"));
    expect(fireWindVisibility()).toBe("visible");

    await card.openScar(scarClick("scar-with-wind"));
    expect(fireWindVisibility()).toBe("none");
  });

  it("clears fire A's arrows when fire B opens directly, without an intervening close()", async () => {
    const { map, fireWindVisibility } = stubMap();
    const card = await buildCard(map);
    await card.openFire(fireClick("fire-with-wind"));
    expect(fireWindVisibility()).toBe("visible");

    await card.openFire(fireClick("fire-no-track"));
    expect(fireWindVisibility()).toBe("none");
  });

  it("becomes visible again on a second open after close() hid it", async () => {
    const { map, fireWindVisibility } = stubMap();
    const card = await buildCard(map);
    await card.openFire(fireClick("fire-with-wind"));
    expect(fireWindVisibility()).toBe("visible");

    card.close();
    expect(fireWindVisibility()).toBe("none");

    await card.openFire(fireClick("fire-with-wind"));
    expect(fireWindVisibility()).toBe("visible");
  });

  it("stacks the arrows above the arrival-footprint hexes, even when both are created in the same open()", async () => {
    const { map, layerOrder } = stubMap();
    await (await buildCard(map)).openFire(fireClick("fire-with-wind-and-footprint"));

    const order = layerOrder();
    expect(order).toContain("fire-wind-arrows");
    expect(order).toContain("fire-bin-fill");
    expect(order).toContain("fire-bin-line");
    // Later index = rendered on top.
    expect(order.indexOf("fire-wind-arrows")).toBeGreaterThan(order.indexOf("fire-bin-fill"));
    expect(order.indexOf("fire-wind-arrows")).toBeGreaterThan(order.indexOf("fire-bin-line"));
  });

  it("moves back above fire-bin layers freshly created by a LATER card, once fire-wind-arrows already exists", async () => {
    const { map, layerOrder } = stubMap();
    const card = await buildCard(map);
    // First card: wind match, no cell_bins — creates fire-wind-arrows only.
    await card.openFire(fireClick("fire-with-wind"));
    // Second card: cell_bins AND a wind match — ensureFootprint creates
    // fire-bin-fill/line for the FIRST time here, appended above the
    // already-existing fire-wind-arrows; addFireWind only setData()s (the
    // layer already exists) and relies on its own moveLayer to reclaim the
    // top. Without that moveLayer, this is exactly the case that stays
    // buried, since open()'s call-site ordering alone can't fix an already-
    // existing layer's position.
    await card.openFire(fireClick("fire-with-wind-and-footprint"));

    const order = layerOrder();
    expect(order.indexOf("fire-wind-arrows")).toBeGreaterThan(order.indexOf("fire-bin-fill"));
    expect(order.indexOf("fire-wind-arrows")).toBeGreaterThan(order.indexOf("fire-bin-line"));
  });
});
