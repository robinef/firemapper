/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { Switcher } from "../src/registry";

window.URL.createObjectURL ??= () => "";

const FOOTPRINT_GEOMETRY = { type: "Polygon", coordinates: [[[-1, 44], [-1, 45], [0, 45], [-1, 44]]] };

// EFFIS scars (pipeline/fetch_effis.py, archive_footprints.py) carry a real
// perimeter but never an archived H3 track — the opposite contract from
// firecard_scar_track.test.ts's FIRMS-tracked scars.
vi.mock("../src/data", () => ({
  loadTrack: vi.fn(() => Promise.reject(new Error("no archived track"))),
  loadFootprint: vi.fn((id: string) =>
    Promise.resolve({ type: "Feature", geometry: FOOTPRINT_GEOMETRY, properties: { id } })),
}));

/** Same map fake as firecard_scar_track.test.ts's footprintMap(). */
function footprintMap() {
  const sourceObjs = new Map<string, { data?: unknown; setData: (d: unknown) => void }>();
  const layerVis = new Map<string, string>();
  const layerExists = new Set<string>();
  const map = {
    getLayer: (id: string) => (layerExists.has(id) ? {} : null),
    getSource: (id: string) => sourceObjs.get(id) ?? null,
    addSource: (id: string, def: { data?: unknown }) => {
      const obj = { data: def.data, setData(d: unknown) { obj.data = d; } };
      sourceObjs.set(id, obj);
    },
    addLayer: (def: { id: string; layout?: { visibility?: string } }) => {
      layerExists.add(def.id);
      layerVis.set(def.id, def.layout?.visibility ?? "visible");
    },
    setLayoutProperty: (id: string, _prop: string, value: string) => {
      layerVis.set(id, value);
    },
    setPaintProperty: () => {}, getPaintProperty: () => 1,
    on: () => {}, off: () => {},
    flyTo: () => {},
    getCanvas: () => ({ style: {} }),
  } as unknown as maplibregl.Map;
  return { map, sourceObjs, layerVis };
}

function scarClickEvent(id: string, footprint?: boolean, trackGen?: string): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: {
        id, label: id, kind: "past", lat: 45, lon: -1,
        started: "2026-07-22", before: "2026-07-16", after: "2026-08-05",
        ...(footprint ? { footprint: true } : {}),
        ...(trackGen ? { track_gen: trackGen } : {}),
      },
      geometry: { type: "Point", coordinates: [-1, 45] },
    }],
    lngLat: { lng: -1, lat: 45 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

let setupFireCard: typeof import("../src/firecard").setupFireCard;

describe("openScar paints an EFFIS scar's real perimeter", () => {
  it("fetches and paints the archived footprint for a scar with footprint:true", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map, sourceObjs, layerVis } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openScar(scarClickEvent("562583", true));

    expect(layerVis.get("fire-bin-fill")).toBe("visible");
    const features = (sourceObjs.get("fire-bin")?.data as GeoJSON.FeatureCollection).features;
    expect(features.length).toBe(1);
    expect(features[0].geometry).toEqual(FOOTPRINT_GEOMETRY);
    // Marked distinctly from an arrival-timed hex — the paint expression
    // keys off this to use a fixed, off-ramp colour instead of interpolating
    // ["get", "t"], so a flat "no time data" polygon never reads as sitting
    // at some position on the same blue->red scale a real arrival gradient uses.
    expect(features[0].properties?.static).toBe(true);

    // No cell_bins for an EFFIS scar — the arrival-gradient legend, which
    // would caption a real "earlier -> now" ramp, must not appear next to a
    // colour that carries no time information.
    expect(document.querySelector(".fc-arrival")).toBeNull();
    // Instead, its own caption explains the flat polygon honestly.
    const caption = document.querySelector(".fc-static-footprint");
    expect(caption).not.toBeNull();
    expect(caption?.textContent).toMatch(/mapped perimeter/i);
  });

  it("never fetches a footprint for a scar without the flag", async () => {
    const { loadFootprint } = await import("../src/data");
    vi.mocked(loadFootprint).mockClear();
    ({ setupFireCard } = await import("../src/firecard"));
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openScar(scarClickEvent("scar-no-footprint-flag"));

    expect(loadFootprint).not.toHaveBeenCalled();
    expect(document.querySelector(".fc-static-footprint")).toBeNull();
  });

  it("prefers an archived H3 track over a footprint flag when a scar somehow carries both", async () => {
    const { loadFootprint } = await import("../src/data");
    vi.mocked(loadFootprint).mockClear();
    ({ setupFireCard } = await import("../src/firecard"));
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openScar(scarClickEvent("scar-both", true, "archive"));

    expect(loadFootprint).not.toHaveBeenCalled();
  });
});
