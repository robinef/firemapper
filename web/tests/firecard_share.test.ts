/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { CompareLike } from "../src/firecard";
import type { Switcher } from "../src/registry";

window.URL.createObjectURL ??= () => "";

vi.mock("../src/data", () => ({
  loadTrack: () => Promise.resolve({ series: [], cell_bins: null }),
}));

function recordingMap() {
  const map = {
    getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
    getPaintProperty: () => 1, on: () => {}, off: () => {},
    flyTo: () => {}, getCanvas: () => ({ style: {} }),
  } as unknown as maplibregl.Map;
  return map;
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
    freshness: JSON.stringify({ viirs: "2026-07-01T00:00:00Z" }),
    place: JSON.stringify({ name, distance_km: 1 }),
  };
}

function fireClick(id: string): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: fireProps(id, "Fire A"),
      geometry: { type: "Point", coordinates: [10, 20] },
    }],
    lngLat: { lng: 10, lat: 20 },
  } as unknown as maplibregl.MapLayerMouseEvent;
}

function scarClick(): maplibregl.MapLayerMouseEvent {
  return {
    features: [{
      properties: {
        id: "scar-1", label: "Scar One", kind: "past", lat: 20, lon: 10,
        started: "2020-01-01", before: "2020-01-01", after: "2020-01-05",
      },
      geometry: { type: "Point", coordinates: [10, 20] },
    }],
  } as unknown as maplibregl.MapLayerMouseEvent;
}

/** Reports the given keys as on, everything else off — a stand-in for the
 *  switcher's live per-module toggle state (not each module's defaultOn). */
function switcherWithLayersOn(...on: string[]): Switcher {
  return { isOn: (k) => on.includes(k), setLevel: () => {}, refresh: () => {} };
}

function build(switcher: Switcher, compare: CompareLike | null = null) {
  document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
  return setupFireCard(
    recordingMap(), { generation: "gen-1", layers: {} } as never, compare,
    document.getElementById("timeline")!, switcher, () => {}, () => {},
  );
}

let setupFireCard: typeof import("../src/firecard").setupFireCard;

describe("fire card share link", () => {
  it("copies ?fire=<id> plus whichever layers are currently toggled on", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await build(switcherWithLayersOn("intensity", "wind")).openFire(fireClick("fire-a"));
    document.querySelector<HTMLButtonElement>(".fc-share")!.click();
    await Promise.resolve(); // flush the async clipboard write

    expect(writeText).toHaveBeenCalledTimes(1);
    const url = new URL(writeText.mock.calls[0][0] as string);
    expect(url.searchParams.get("fire")).toBe("fire-a");
    expect(url.searchParams.get("layers")?.split(",").sort()).toEqual(["intensity", "wind"]);
  });

  it("omits ?layers= when nothing shareable is toggled on", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await build(switcherWithLayersOn()).openFire(fireClick("fire-b"));
    document.querySelector<HTMLButtonElement>(".fc-share")!.click();
    await Promise.resolve();

    const url = new URL(writeText.mock.calls[0][0] as string);
    expect(url.searchParams.get("fire")).toBe("fire-b");
    expect(url.searchParams.has("layers")).toBe(false);
  });

  it("copies ?fire=<scarId> from a scar card's share button too", async () => {
    ({ setupFireCard } = await import("../src/firecard"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await build(switcherWithLayersOn()).openScar(scarClick());
    document.querySelector<HTMLButtonElement>(".fc-share")!.click();
    await Promise.resolve();

    const url = new URL(writeText.mock.calls[0][0] as string);
    expect(url.searchParams.get("fire")).toBe("scar-1");
  });
});
