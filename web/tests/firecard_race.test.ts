/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type maplibregl from "maplibre-gl";
import type { Switcher } from "../src/registry";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it (see ui_events_wiring.test.ts's note on the same line).
window.URL.createObjectURL ??= () => "";

/** A resolver we control by hand, so the test — not the event loop — decides
 * which of two `loadTrack` calls settles first. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const pendingTracks = new Map<string, ReturnType<typeof deferred<unknown>>>();

// firecard.ts's only dependency on ./data is loadTrack; replacing it here
// lets the test hold each fire's response open until it chooses to settle it,
// which a real fetch (or data.test.ts's fakeFetch, which always resolves in
// call order) cannot do.
vi.mock("../src/data", () => ({
  loadTrack: (_m: unknown, id: string) => {
    const d = deferred<unknown>();
    pendingTracks.set(id, d);
    return d.promise;
  },
}));

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
    // bag (see firecard.ts's `reparse`) — match that here rather than handing
    // openFire pre-parsed objects it would never actually see.
    freshness: JSON.stringify({ viirs: "2026-07-01T00:00:00Z" }),
    place: JSON.stringify({ name, distance_km: 1 }),
  };
}

function fireClickEvent(id: string, name: string): maplibregl.MapLayerMouseEvent {
  return {
    features: [{ properties: fireProps(id, name), geometry: { type: "Point", coordinates: [0, 0] } }],
    lngLat: { lng: 1, lat: 2 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

describe("fire card open race", () => {
  it("does not let an earlier fire's stale track overwrite a fire clicked after it", async () => {
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const map = {
      getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
      getPaintProperty: () => 1, on: () => {}, off: () => {}, flyTo: () => {},
      getCanvas: () => ({ style: {} }),
    } as unknown as maplibregl.Map;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };

    const card = setupFireCard(
      map,
      { generation: "gen-1", layers: {} } as never,
      null,
      document.getElementById("timeline")!,
      switcher,
      () => {},
      () => {},
    );

    // Two clicks in quick succession — the second click (fire B) must win
    // regardless of which track request the network hands back first.
    const pA = card.openFire(fireClickEvent("fire-a", "Fire A"));
    const pB = card.openFire(fireClickEvent("fire-b", "Fire B"));

    // Resolve OUT OF ORDER: fire B's (newer) track lands first, then fire A's
    // (now-stale) track finally arrives.
    pendingTracks.get("fire-b")!.resolve({ series: [], cell_bins: null });
    pendingTracks.get("fire-a")!.resolve({ series: [], cell_bins: null });
    await Promise.all([pA, pB]);

    const panel = document.getElementById("panel")!;
    expect(panel.innerHTML).toContain("Fire B");
    expect(panel.innerHTML).not.toContain("Fire A");
  });

  function stubMap() {
    return {
      getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
      getPaintProperty: () => 1, on: () => {}, off: () => {}, flyTo: () => {},
      getCanvas: () => ({ style: {} }),
    } as unknown as maplibregl.Map;
  }

  function scarClickEvent(id: string, label: string): maplibregl.MapLayerMouseEvent {
    return {
      features: [{
        properties: {
          id, label, kind: "past", lat: 10, lon: 20,
          started: "2020-01-01", before: "2020-01-01", after: "2020-01-05",
        },
        geometry: { type: "Point", coordinates: [20, 10] },
      }],
      lngLat: { lng: 20, lat: 10 },
    } as unknown as maplibregl.MapLayerMouseEvent;
  }

  it("does not let a stale fire track overwrite a scar card opened while it was loading", async () => {
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      stubMap(), { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    // Fire A's track is still loading when the user taps a past-scar marker —
    // openScar renders synchronously, with no track to await.
    const pA = card.openFire(fireClickEvent("fire-a", "Fire A"));
    card.openScar(scarClickEvent("scar-1", "Scar One"));

    // Fire A's now-stale response finally lands — it must not win.
    pendingTracks.get("fire-a")!.resolve({ series: [], cell_bins: null });
    await pA;

    const panel = document.getElementById("panel")!;
    expect(panel.innerHTML).toContain("Scar One");
    expect(panel.innerHTML).not.toContain("Fire A");
  });

  it("does not let a stale fire track reopen the card after it was closed", async () => {
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      stubMap(), { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );

    // Open fire A fully first, so the scenario is "a card is open, the user
    // clicks another fire, then dismisses before it resolves" rather than
    // starting from nothing.
    const pA = card.openFire(fireClickEvent("fire-a", "Fire A"));
    pendingTracks.get("fire-a")!.resolve({ series: [], cell_bins: null });
    await pA;
    expect(document.getElementById("panel")!.innerHTML).toContain("Fire A");

    // Fire B's track is in flight when the user hits Escape (or taps the
    // background) before it lands.
    const pB = card.openFire(fireClickEvent("fire-b", "Fire B"));
    card.close();

    pendingTracks.get("fire-b")!.resolve({ series: [], cell_bins: null });
    await pB;

    const panel = document.getElementById("panel")!;
    expect(panel.classList.contains("hidden")).toBe(true);
    expect(panel.innerHTML).toBe("");
  });
});
