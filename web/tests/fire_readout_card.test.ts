/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { Switcher } from "../src/registry";
import type { Readout } from "../src/fire_readout";
import type { Scar } from "../src/layer_imagery";
import type { EventProps } from "../src/types";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it. A static top-level `import ... from "../src/firecard"`
// is hoisted above this line by ES module semantics, so the load would run
// before the polyfill exists — hence the dynamic import in each test below
// (see firecard_peek.test.ts's note on the same line).
window.URL.createObjectURL ??= () => "";

// firecard.ts's only dependency on ./data is loadTrack. The openFire tests at
// the bottom need to choose what a track contains without a network; the
// fireCardHtml tests above never reach it.
let nextTrack: unknown = null;
vi.mock("../src/data", () => ({
  loadTrack: () => Promise.resolve(nextTrack),
}));

const READOUT: Readout = {
  intensity: { mw: 378, ageMinutes: 22 * 60 },
  wind: { bearingDeg: 225, kmh: 18, distanceKm: 6, ageMinutes: 40 },
};

const FIRE = {
  id: "e1", status: "active", lifecycle_age_h: 12, started: "2026-07-31T00:00:00Z",
  area_km2: 21.7, cum_cells: 31, movement: null, state: "growing",
  freshness: { viirs: "2026-08-08T10:00:00Z", meteosat: null },
  place: { name: "Test Ridge", distance_km: 7.2 }, gdacs: null,
  reactivation_of: null, merged_into: null,
} as unknown as EventProps;

function parse(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("fireCardHtml with a readout", () => {
  it("puts the peek pair INSIDE .fc-peek, where peek state can see it", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const peek = parse(fireCardHtml(FIRE, null, READOUT)).querySelector(".fc-peek");
    expect(peek).not.toBeNull();
    // style.css:295 hides every child of #panel except .fc-peek. A readout
    // outside this element is invisible in peek — the default phone state.
    expect(peek!.textContent).toContain("378 MW");
  });

  it("also renders the full block for the expanded card", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const root = parse(fireCardHtml(FIRE, null, READOUT));
    const full = root.querySelector(".ro-body");
    expect(full).not.toBeNull();
    expect(full!.textContent).toContain("22 h ago");
  });

  it("renders an unchanged card when there is no readout", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const without = fireCardHtml(FIRE, null, null);
    expect(without).not.toContain("ro-body");
    expect(without).toContain("fc-peek");
    expect(without).toBe(fireCardHtml(FIRE, null));
  });

  it("keeps the readout figure away from Peak intensity", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const root = parse(fireCardHtml(FIRE, null, READOUT));
    const stats = root.querySelector(".fc-stats");
    expect(stats?.textContent ?? "").not.toContain("Burning");
  });

  it("puts the full block after the stat group, outside it and outside the peek strip", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const root = parse(fireCardHtml(FIRE, null, READOUT));
    const stats = root.querySelector(".fc-stats")!;
    const body = root.querySelector(".ro-body")!;
    const peek = root.querySelector(".fc-peek")!;
    expect(stats).not.toBeNull();
    expect(body).not.toBeNull();
    // "Burning" is a live reading; "Peak intensity" is this fire's all-time
    // high. Same unit, different quantities — sat in one row group they invite
    // a comparison that is wrong twice over. Position is the requirement, so
    // assert it directly: textContent alone cannot tell "after" from "before",
    // and both mutations keep every other test in this file green.
    expect(stats.contains(body)).toBe(false);
    expect(peek.contains(body)).toBe(false);
    expect(stats.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe("scarCardHtml", () => {
  it("never carries a readout", async () => {
    const { scarCardHtml } = await import("../src/firecard");
    // A past fire has no live intensity, and today's wind over an old burn is
    // decoration with the authority of data.
    const scar: Scar = {
      id: "s1", label: "Test Scar", place: "Test Basin", kind: "past",
      lon: 18.3, lat: 42.7, started: "2026-07-01",
      before: "2026-06-20", after: "2026-07-15", area_km2: 5.1,
    };
    const html = scarCardHtml(scar);
    expect(html).not.toContain("ro-body");
    expect(html).not.toContain("ro-peek");
  });
});

describe("openFire wiring", () => {
  const stubMap = () =>
    ({
      getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
      getPaintProperty: () => 1, on: () => {}, off: () => {}, flyTo: () => {},
      getCanvas: () => ({ style: {} }),
    }) as unknown as maplibregl.Map;

  /** Nested objects arrive JSON-stringified on the real GeoJSON properties bag
   *  (see firecard.ts's `reparse`) — match that rather than handing openFire
   *  pre-parsed objects it would never actually see. */
  const fireProps = () => ({
    id: "fire-a", status: "active", lifecycle_age_h: 1,
    started: "2026-07-01T00:00:00Z", area_km2: 1, cum_cells: 1, movement: null,
    freshness: JSON.stringify({ viirs: "2026-07-01T00:00:00Z" }),
    place: JSON.stringify({ name: "Test Ridge", distance_km: 1 }),
  });

  const clickOn = (geometry: unknown): maplibregl.MapLayerMouseEvent =>
    ({
      features: [{ properties: fireProps(), geometry }],
      lngLat: { lng: 1, lat: 2 },
    }) as unknown as maplibregl.MapLayerMouseEvent;

  async function mount() {
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel" class="hidden"></div><div id="timeline"></div>`;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    return setupFireCard(
      stubMap(), { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );
  }

  // A live reading 30 min old, expressed relative to now so the age never
  // drifts past a formatting boundary as the calendar moves.
  const recentTrack = () => ({
    series: [], cell_bins: null,
    frp_live: [[new Date(Date.now() - 30 * 60_000).toISOString(), 510]],
  });

  it("shows the live intensity when the clicked feature is a point", async () => {
    nextTrack = recentTrack();
    const card = await mount();
    await card.openFire(clickOn({ type: "Point", coordinates: [1, 2] }));
    expect(document.getElementById("panel")!.innerHTML).toContain("510 MW");
  });

  it("shows nothing at all when the feature has no resolvable position", async () => {
    // The footprint-polygon click path carries no event identity, so we cannot
    // say WHICH fire was opened. An intensity figure here would attach a real
    // number to an uncertain fire — worse than showing no reading.
    nextTrack = recentTrack();
    const card = await mount();
    await card.openFire(clickOn({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }));
    const html = document.getElementById("panel")!.innerHTML;
    expect(html).toContain("Test Ridge"); // the card itself still opened
    expect(html).not.toContain("510 MW");
    expect(html).not.toContain("ro-peek");
    expect(html).not.toContain("ro-body");
  });
});
