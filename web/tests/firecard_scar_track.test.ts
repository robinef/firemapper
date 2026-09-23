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
    // The one archived id that is NOT archived: a season fire whose track was
    // never written (or has aged out of the bucket), for openArchived's
    // nothing-to-open path.
    if (trackGen === "archive" && id !== "fire-unarchived") {
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
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {}, refreshStatus: () => {} };
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

    // Same arrival-gradient legend fireCardHtml shows for a live fire's
    // painted footprint — an archived scar paints identical hexes, so it
    // should explain the same colours instead of leaving them uncaptioned.
    expect(document.querySelector(".fc-arrival")).not.toBeNull();
    // The static-footprint caption is the OTHER case's explanation (a flat,
    // untimed EFFIS polygon) — must never appear alongside a real arrival
    // gradient this scar actually has.
    expect(document.querySelector(".fc-static-footprint")).toBeNull();
  });

  it("hides the timeline, rather than showing the continental overview, for a scar with no archived track", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map, sourceObjs } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {}, refreshStatus: () => {} };
    const mountOverview = vi.fn();
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, mountOverview, () => {},
    );

    // No track_gen at all — a curated megafire or EFFIS scar, e.g. Landiras
    // 2022, years before any track/archive data existed for it. The Europe-
    // wide "today" histogram is real, but it is not this fire's — showing it
    // under a 2022 card reads as if Landiras were still active.
    await card.openScar(scarClickEvent("scar-curated"));

    expect(sourceObjs.has("fire-bin")).toBe(false);
    expect(mountOverview).not.toHaveBeenCalled();
    expect(document.getElementById("timeline")!.style.display).toBe("none");
    expect(document.getElementById("panel")!.innerHTML).toContain("scar-curated");
    // No archived track means no cell_bins to explain — the legend would be
    // pointing at a footprint the card never painted.
    expect(document.querySelector(".fc-arrival")).toBeNull();
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
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {}, refreshStatus: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openScar(scarClickEvent("scar-no-track-gen"));

    expect(loadTrack).not.toHaveBeenCalled();
  });

  it("never prints the literal word 'undefined' when a marker carries no area_km2", async () => {
    // scarFromClick (layer_imagery.ts) and scarFromProps (main.ts) both guard
    // area_km2/cum_cells with a typeof check before building a Scar — openScar
    // read feat.properties straight into a Scar with no such guard, so a
    // marker missing the field (scarClickEvent's fixture carries none) would
    // print scarCardHtml's "Burned area" row as the literal text "undefined".
    ({ setupFireCard } = await import("../src/firecard"));
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const { map } = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {}, refreshStatus: () => {} };
    const card = setupFireCard(
      map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    await card.openScar(scarClickEvent("scar-no-area"));

    expect(document.getElementById("panel")!.innerHTML).not.toContain("undefined");
  });
});

/** The other route into a past fire's card: a burned season cell, whose fire
 *  is one of ~27,000 archived tracks and almost never one of the 50 scars the
 *  manifest publishes. No marker, no feature properties — just an id and
 *  (when it has landed) the sizes sidecar's row for it. */
describe("openArchived opens a season fire that never made the scar shortlist", () => {
  function build() {
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const fixture = footprintMap();
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {}, refreshStatus: () => {} };
    const card = setupFireCard(
      fixture.map, { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, vi.fn(), () => {},
    );
    return { card, ...fixture };
  }

  it("loads the archived track, paints the arrival footprint and dates the card from the sidecar", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const { card, sourceObjs, layerVis, flights } = build();

    const opened = await card.openArchived("fire-1", [31.5, "ES", "2026-07-24"]);

    expect(opened).toBe(true);
    const panel = document.getElementById("panel")!;
    expect(panel.classList.contains("hidden")).toBe(false);
    // The sidecar's ignition date, through scarFromArchive's label — not the
    // track's first bin, which is the same day here but need not be.
    expect(panel.innerHTML).toContain("Burn scar · 24 Jul 2026");
    expect(panel.innerHTML).toContain("Past fire");
    expect(panel.innerHTML).toContain("31.5 km²"); // the sidecar's footprint km²
    expect(panel.innerHTML).not.toContain("undefined");
    // The same H3 arrival detail an archived scar marker's card shows.
    expect(layerVis.get("fire-bin-fill")).toBe("visible");
    expect((sourceObjs.get("fire-bin")?.data as GeoJSON.FeatureCollection).features).toHaveLength(2);
    expect(document.querySelector(".fc-arrival")).not.toBeNull();
    expect(document.querySelector(".tl-title")?.textContent).toBe("This fire · new burned cells / 6 h");
    // Centred on the track's own cells — nothing else knows where this fire is.
    expect(flights).toHaveLength(1);
    expect(flights[0].center[0]).toBeCloseTo(8.0019609, 5);
    expect(flights[0].center[1]).toBeCloseTo(45.0035094, 5);
  });

  it("dates the card from the track when the sidecar has not landed", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const { card } = build();

    expect(await card.openArchived("fire-2", null)).toBe(true);

    const panel = document.getElementById("panel")!;
    expect(panel.innerHTML).toContain("Burn scar · 1 Jul 2026"); // the first bin's day
    expect(panel.innerHTML).not.toContain("undefined");
    // Area summed from the track's own cells, rounded the way the sidecar
    // rounds it — a raw h3 sum prints 13 decimal places into the card.
    expect(panel.innerHTML).toContain("1.458 km²");
  });

  it("opens nothing when the fire has no archived track", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const { card } = build();

    expect(await card.openArchived("fire-unarchived", null)).toBe(false);

    expect(document.getElementById("panel")!.classList.contains("hidden")).toBe(true);
    expect(document.getElementById("panel")!.innerHTML).toBe("");
  });
});
