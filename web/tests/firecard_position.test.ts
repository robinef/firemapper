/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { CompareLike } from "../src/firecard";
import type { Switcher } from "../src/registry";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it (see ui_events_wiring.test.ts's note on the same line).
window.URL.createObjectURL ??= () => "";

// firecard.ts's only dependency on ./data is loadTrack. A fire card must be
// able to open without a track (tiny fires have none), so resolving null here
// exercises the same path a real trackless fire takes.
vi.mock("../src/data", () => ({
  loadTrack: () => Promise.resolve({ series: [], cell_bins: null }),
}));

/** The camera calls a card makes, in order. */
function recordingMap() {
  const flights: { center: [number, number]; zoom?: number }[] = [];
  const map = {
    getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
    getPaintProperty: () => 1, on: () => {}, off: () => {},
    flyTo: (o: { center: [number, number]; zoom?: number }) => void flights.push(o),
    getCanvas: () => ({ style: {} }),
  } as unknown as maplibregl.Map;
  return { map, flights };
}

/** The before/after hand-off, captured instead of executed. */
function recordingCompare() {
  const fires: { lon: number; lat: number }[] = [];
  const scars: { lon: number; lat: number }[] = [];
  const compare: CompareLike = {
    fromFire: (s) => void fires.push({ lon: s.lon, lat: s.lat }),
    fromScar: (s) => void scars.push({ lon: s.lon, lat: s.lat }),
    exit: () => {},
  };
  return { compare, fires, scars };
}

function fireProps(id: string, name: string) {
  return {
    id,
    status: "active",
    lifecycle_age_h: 1,
    started: "2026-07-01T00:00:00Z",
    area_km2: 1,
    cum_cells: 1,
    movement: null,
    // Nested objects arrive JSON-stringified on the real GeoJSON properties
    // bag (see firecard.ts's `reparse`).
    freshness: JSON.stringify({ viirs: "2026-07-01T00:00:00Z" }),
    place: JSON.stringify({ name, distance_km: 1 }),
  };
}

/** A click that MISSES: the finger landed at (1, 2), the fire is at (10, 20).
 *  Real clicks always carry an lngLat, and it is never the fire's own centre —
 *  the dot is several pixels wide, its halo wider still. */
function offCentreFireClick(): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: fireProps("fire-a", "Fire A"),
      geometry: { type: "Point", coordinates: [10, 20] },
    }],
    lngLat: { lng: 1, lat: 2 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

function offCentreScarClick(): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: {
        id: "scar-1", label: "Scar One", kind: "past", lat: 20, lon: 10,
        started: "2020-01-01", before: "2020-01-01", after: "2020-01-05",
      },
      geometry: { type: "Point", coordinates: [10, 20] },
    }],
    lngLat: { lng: 1, lat: 2 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

/** A footprint-polygon click: no Point geometry to read a centre from. The
 *  tap point is all there is, and it must still be used — falling through to
 *  [0, 0] would fly the map to Null Island. */
function polygonFireClick(): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: fireProps("fire-poly", "Fire Poly"),
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    }],
    lngLat: { lng: 3, lat: 4 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

function build(map: maplibregl.Map, compare: CompareLike | null) {
  document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
  const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
  return setupFireCard(
    map, { generation: "gen-1", layers: {} } as never, compare,
    document.getElementById("timeline")!, switcher, () => {}, () => {},
  );
}

let setupFireCard: typeof import("../src/firecard").setupFireCard;

describe("fire card camera position", () => {
  it("centres on the fire, not on the point the user tapped", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const { map, flights } = recordingMap();
    await build(map, null).openFire(offCentreFireClick());

    expect(flights).toHaveLength(1);
    expect(flights[0].center).toEqual([10, 20]);
  });

  it("hands before/after the fire's position, not the tap point", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const { map } = recordingMap();
    const { compare, fires } = recordingCompare();
    await build(map, compare).openFire(offCentreFireClick());

    // The card's before/after button is the only way in; click it as a user would.
    document.querySelector<HTMLElement>(".fc-ba")?.click();

    expect(fires).toEqual([{ lon: 10, lat: 20 }]);
  });

  it("centres on the scar, not on the point the user tapped", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const { map, flights } = recordingMap();
    // Now awaits a track load, same as openFire — see firecard_scar_track
    // for coverage of what that track load actually does to the card.
    await build(map, null).openScar(offCentreScarClick());

    expect(flights).toHaveLength(1);
    expect(flights[0].center).toEqual([10, 20]);
  });

  it("falls back to the tap point when the feature has no point geometry", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const { map, flights } = recordingMap();
    await build(map, null).openFire(polygonFireClick());

    // Not [0, 0] — a polygon click still has to land somewhere real.
    expect(flights).toHaveLength(1);
    expect(flights[0].center).toEqual([3, 4]);
  });
});
