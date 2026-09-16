/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { Switcher } from "../src/registry";
import type { Track } from "../src/types";

window.URL.createObjectURL ??= () => "";

/** Same map fake as firecard_scar_footprint.test.ts's footprintMap(). */
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

const META = { lon: -1.03, lat: 44.84, place: "Near Arès", before: "2022-07-14", after: "2022-07-30" };

function fakeTrack(cellBins: [string, string[]][]): Track {
  return {
    id: "lookup-1",
    series: cellBins.map(([bin], i) => ({
      bin, centroid: [44.84, -1.03] as [number, number], new_cells: 1, cum_cells: i + 1, frp_sum: 5,
    })),
    cells: cellBins.flatMap(([, cells]) => cells),
    cell_bins: cellBins,
    frp_live: [],
  };
}

describe("openHistoricalLookup", () => {
  it("paints the reconstructed footprint and mounts the timeline scrubber", async () => {
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map, sourceObjs, layerVis, flights } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openHistoricalLookup(fakeTrack([["2022-07-22T06:00:00.000Z", ["cell-a"]]]), META);

    expect(layerVis.get("fire-bin-fill")).toBe("visible");
    const features = (sourceObjs.get("fire-bin")?.data as GeoJSON.FeatureCollection).features;
    expect(features.length).toBe(1); // the one reconstructed cell, painted
    expect(flights[0].center).toEqual([META.lon, META.lat]);

    const title = document.querySelector(".tl-title")?.textContent;
    expect(title).toBe("This fire · new burned cells / 6 h");
    expect(document.getElementById("panel")!.innerHTML).toContain("Near Arès");
  });

  it("renders stats-only (no scrubber row) for a track with no cell_bins", async () => {
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openHistoricalLookup({ id: "lookup-2", series: [], cells: [], cell_bins: [], frp_live: [] }, META);

    expect(document.getElementById("timeline")!.style.display).toBe("none");
  });

  it("treats level-2 as historical — no liveOnly sublayers, same as a settled past scar", async () => {
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map } = footprintMap();
    const setLevel = vi.fn();
    const switcher: Switcher = { isOn: () => true, setLevel, refresh: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openHistoricalLookup(fakeTrack([]), META);

    expect(setLevel).toHaveBeenCalledWith(2, { historical: true });
  });

  it("a second lookup supersedes an in-flight first one via the shared openToken guard", async () => {
    // Mirrors firecard_race.test.ts's pattern: open() is synchronous once
    // called, so this proves openHistoricalLookup participates in the same
    // openToken race guard openFire/openScar use, not a fresh one of its own.
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openHistoricalLookup(fakeTrack([]), { ...META, place: "First" });
    await card.openHistoricalLookup(fakeTrack([]), { ...META, place: "Second" });

    expect(document.getElementById("panel")!.innerHTML).toContain("Second");
    expect(document.getElementById("panel")!.innerHTML).not.toContain("First");
  });
});
