/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { Switcher } from "../src/registry";

window.URL.createObjectURL ??= () => "";

// Two adjacent, real H3 res-8 cells (cellToBoundary needs valid indices).
const CELL_A = "881f987809fffff";
const CELL_B = "881f987843fffff";

// loadTrack resolves an archived track only for the "archive" sentinel —
// exactly the contract pipeline/archive_tracks.py + Scar.track_gen establish.
// Anything else (curated megafire / EFFIS scar, no track_gen at all) 404s,
// same as a trackless live fire.
vi.mock("../src/data", () => ({
  loadTrack: vi.fn((_m: unknown, id: string, _base: unknown, _fetch: unknown, trackGen?: string | null) => {
    if (trackGen === "archive") {
      return Promise.resolve({
        id,
        series: [
          { bin: "2026-07-01T00:00:00Z", centroid: [45, 8], new_cells: 1, cum_cells: 1, frp_sum: 5 },
          { bin: "2026-07-01T06:00:00Z", centroid: [45.01, 8], new_cells: 1, cum_cells: 2, frp_sum: 5 },
        ],
        cells: [CELL_A, CELL_B],
        cell_bins: [
          ["2026-07-01T00:00:00Z", [CELL_A]],
          ["2026-07-01T06:00:00Z", [CELL_B]],
        ],
        frp_live: [],
      });
    }
    return Promise.reject(new Error("no archived track"));
  }),
}));

/** A map fake rich enough for the footprint-paint path: addSource/addLayer/
 *  setLayoutProperty, not just flyTo. */
function footprintMap() {
  const flights: { center: [number, number]; zoom?: number }[] = [];
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
    flyTo: (o: { center: [number, number]; zoom?: number }) => void flights.push(o),
    getCanvas: () => ({ style: {} }),
  } as unknown as maplibregl.Map;
  return { map, flights, sourceObjs, layerVis };
}

function scarClickEvent(id: string, trackGen?: string): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: {
        id, label: id, kind: "past", lat: 45, lon: 8,
        started: "2026-07-01", before: "2026-06-25", after: "2026-07-14",
        ...(trackGen ? { track_gen: trackGen } : {}),
      },
      geometry: { type: "Point", coordinates: [8, 45] },
    }],
    lngLat: { lng: 8, lat: 45 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

let setupFireCard: typeof import("../src/firecard").setupFireCard;

describe("openScar loads the same H3 footprint detail as an active fire", () => {
  it("paints the arrival footprint and mounts the timeline scrubber for an archived past scar", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map, sourceObjs, layerVis } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const mountOverview = vi.fn();
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, mountOverview, () => {},
    );

    await card.openScar(scarClickEvent("scar-archived", "archive"));

    expect(layerVis.get("fire-bin-fill")).toBe("visible");
    const features = (sourceObjs.get("fire-bin")?.data as GeoJSON.FeatureCollection).features;
    expect(features.length).toBe(2); // both arrived cells, painted as of the last bin

    const title = document.querySelector(".tl-title")?.textContent;
    expect(title).toBe("This fire · new burned cells / 6 h");
    expect(mountOverview).not.toHaveBeenCalled();
  });

  it("falls back to the overview with no footprint for a scar with no archived track", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map, sourceObjs } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const mountOverview = vi.fn();
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, mountOverview, () => {},
    );

    // No track_gen at all — a curated megafire or EFFIS scar.
    await card.openScar(scarClickEvent("scar-curated"));

    expect(sourceObjs.has("fire-bin")).toBe(false);
    expect(mountOverview).toHaveBeenCalledTimes(1);
    expect(document.getElementById("panel")!.innerHTML).toContain("scar-curated");
  });

  it("never fetches a track for a scar with no track_gen at all", async () => {
    // Curated megafires and EFFIS scars, and a real past fire not yet
    // archived, all carry no track_gen. A guaranteed-404 round trip on every
    // one of those clicks (the majority of scar clicks) is pure waste — skip
    // the fetch entirely rather than let it fail.
    const { loadTrack } = await import("../src/data");
    vi.mocked(loadTrack).mockClear();
    ({ setupFireCard } = await import("../src/firecard"));
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openScar(scarClickEvent("scar-no-track-gen"));

    expect(loadTrack).not.toHaveBeenCalled();
  });
});
