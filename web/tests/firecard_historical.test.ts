/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { Switcher } from "../src/registry";

window.URL.createObjectURL ??= () => "";

// Neither test cares about the track itself — only that setLevel's
// `historical` flag reflects the fire/scar's own status, so a null track is
// fine for both.
vi.mock("../src/data", () => ({
  loadTrack: () => Promise.resolve({ series: [], cell_bins: null }),
}));

function stubMap() {
  return {
    getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
    getPaintProperty: () => 1, on: () => {}, off: () => {},
    flyTo: () => {}, getCanvas: () => ({ style: {} }),
  } as unknown as maplibregl.Map;
}

function fireProps(id: string, status: string) {
  return {
    id, status, lifecycle_age_h: 1, started: "2026-07-01T00:00:00Z",
    area_km2: 1, cum_cells: 1, movement: null,
    freshness: JSON.stringify({ viirs: "2026-07-01T00:00:00Z" }),
    place: null,
  };
}

function fireClick(status: string): maplibregl.MapLayerMouseEvent {
  return {
    features: [{ properties: fireProps("fire-x", status), geometry: { type: "Point", coordinates: [8, 45] } }],
    lngLat: { lng: 8, lat: 45 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

function scarClick(kind: "active" | "past"): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: {
        id: "scar-x", label: "Scar X", kind, lat: 45, lon: 8,
        started: "2026-07-01", before: "2026-06-25", after: "2026-07-14",
      },
      geometry: { type: "Point", coordinates: [8, 45] },
    }],
    lngLat: { lng: 8, lat: 45 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

let setupFireCard: typeof import("../src/firecard").setupFireCard;

async function build() {
  ({ setupFireCard } = await import("../src/firecard"));
  document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
  const setLevel = vi.fn();
  const switcher: Switcher = { isOn: () => true, setLevel, refresh: () => {} };
  const card = setupFireCard(
    stubMap(), { generation: "gen-1", layers: {} } as never, null,
    document.getElementById("timeline")!, switcher, () => {}, () => {},
  );
  return { card, setLevel };
}

describe("historical flag reaches the layer switcher", () => {
  it("a closed fire is historical", async () => {
    const { card, setLevel } = await build();
    await card.openFire(fireClick("closed"));
    expect(setLevel).toHaveBeenCalledWith(2, { historical: true });
  });

  it("an active fire is not historical", async () => {
    const { card, setLevel } = await build();
    await card.openFire(fireClick("active"));
    expect(setLevel).toHaveBeenCalledWith(2, { historical: false });
  });

  it("a stale fire is not historical (recently active, not yet settled)", async () => {
    const { card, setLevel } = await build();
    await card.openFire(fireClick("stale"));
    expect(setLevel).toHaveBeenCalledWith(2, { historical: false });
  });

  it("a past scar is historical", async () => {
    const { card, setLevel } = await build();
    await card.openScar(scarClick("past"));
    expect(setLevel).toHaveBeenCalledWith(2, { historical: true });
  });

  it("an active scar is not historical", async () => {
    const { card, setLevel } = await build();
    await card.openScar(scarClick("active"));
    expect(setLevel).toHaveBeenCalledWith(2, { historical: false });
  });
});
