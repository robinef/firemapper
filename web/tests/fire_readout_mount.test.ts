/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import type { Switcher } from "../src/registry";
import type { Readout } from "../src/fire_readout";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it. Every import of ../src/firecard below is dynamic for
// the same reason (a static one is hoisted above this line).
window.URL.createObjectURL ??= () => "";

const READOUT: Readout = {
  intensity: { mw: 378, ageMinutes: 22 * 60 },
  wind: { bearingDeg: 225, kmh: 18, distanceKm: 6, ageMinutes: 40 },
};

describe("mountReadout", () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = `<div id="view"></div>`;
    root = document.body;
  });

  it("creates #fire-readout as a SIBLING of #view, never a child", async () => {
    const { mountReadout } = await import("../src/fire_readout_mount");
    mountReadout(root, READOUT);
    const el = document.getElementById("fire-readout")!;
    const view = document.getElementById("view")!;
    expect(el).not.toBeNull();
    // #view shows exactly one of its children at a time, keyed on data-view.
    // Parented inside it, the readout would vanish the instant the reader
    // tapped the layers icon — the very failure that made the level-2 layer
    // list feel missing and prompted this feature.
    expect(view.contains(el)).toBe(false);
    expect(el.parentElement).toBe(view.parentElement);
  });

  it("renders the full block, not the peek pair", async () => {
    const { mountReadout } = await import("../src/fire_readout_mount");
    mountReadout(root, READOUT);
    const el = document.getElementById("fire-readout")!;
    expect(el.querySelector(".ro-body")).not.toBeNull();
    expect(el.querySelector(".ro-peek")).toBeNull();
    expect(el.textContent).toContain("378 MW");
    expect(el.textContent).toContain("SW");
  });

  it("mounts nothing at all for a null model", async () => {
    const { mountReadout } = await import("../src/fire_readout_mount");
    mountReadout(root, null);
    expect(document.getElementById("fire-readout")).toBeNull();
  });

  it("mounts nothing for a model with no reading in it", async () => {
    // An empty bordered box in the corner of the map is worse than no box:
    // it claims there is a reading and then declines to give one.
    const { mountReadout } = await import("../src/fire_readout_mount");
    mountReadout(root, { intensity: null, wind: null });
    expect(document.getElementById("fire-readout")).toBeNull();
  });

  it("replaces rather than stacks on a repeat mount", async () => {
    const { mountReadout } = await import("../src/fire_readout_mount");
    mountReadout(root, READOUT);
    mountReadout(root, { ...READOUT, intensity: { mw: 12, ageMinutes: 30 } });
    expect(document.querySelectorAll("#fire-readout").length).toBe(1);
    expect(document.getElementById("fire-readout")!.textContent).toContain("12 MW");
    expect(document.getElementById("fire-readout")!.textContent).not.toContain("378 MW");
  });

  it("clears completely, leaving no empty chrome", async () => {
    const { clearReadout, mountReadout } = await import("../src/fire_readout_mount");
    mountReadout(root, READOUT);
    clearReadout(root);
    expect(document.getElementById("fire-readout")).toBeNull();
  });

  it("clearing an already-clear root is harmless", async () => {
    // The breakpoint handler calls this on every narrow-ward crossing,
    // including ones where no overlay was ever mounted.
    const { clearReadout } = await import("../src/fire_readout_mount");
    expect(() => clearReadout(root)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wiring, through the real setupFireCard.
//
// The unit tests above exercise mountReadout in isolation. Which mount gets
// populated, whether the card's controls survive a breakpoint crossing, and
// whether a second card clears the first are all properties of the wiring —
// and the wiring is where every defect this plan's review turned up actually
// lived. No isolated test would have failed on any of them.
//
// The harness is the one tests/fire_readout_card.test.ts already builds for
// setupFireCard (same stub map, same JSON-stringified property bag, same
// mocked loadTrack), plus a driveable matchMedia.
// ---------------------------------------------------------------------------

let nextTrack: unknown = null;
vi.mock("../src/data", () => ({
  loadTrack: () => Promise.resolve(nextTrack),
}));

/** A matchMedia the test drives by hand, so a breakpoint crossing can be made
 *  to happen. jsdom implements no matchMedia at all, so there is nothing to
 *  spy on — it has to be supplied. */
function fakeMatchMedia(initial: boolean) {
  const listeners: Array<() => void> = [];
  const mq = {
    matches: initial,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: () => {},
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = () => mq;
  return {
    cross(to: boolean) {
      mq.matches = to;
      for (const fn of [...listeners]) fn();
    },
  };
}

describe("readout mount wiring", () => {
  const stubMap = () =>
    ({
      getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
      getPaintProperty: () => 1, on: () => {}, off: () => {}, flyTo: () => {},
      getCanvas: () => ({ style: {} }),
    }) as unknown as maplibregl.Map;

  /** Nested objects arrive JSON-stringified on the real GeoJSON properties bag
   *  (see firecard.ts's `reparse`). */
  const fireProps = (id: string, name: string) => ({
    id, status: "active", lifecycle_age_h: 1,
    started: "2026-07-01T00:00:00Z", area_km2: 1, cum_cells: 1, movement: null,
    freshness: JSON.stringify({ viirs: "2026-07-01T00:00:00Z" }),
    place: JSON.stringify({ name, distance_km: 1 }),
  });

  const fireClick = (id = "fire-a", name = "Test Ridge"): maplibregl.MapLayerMouseEvent =>
    ({
      features: [{ properties: fireProps(id, name), geometry: { type: "Point", coordinates: [1, 2] } }],
      lngLat: { lng: 1, lat: 2 },
    }) as unknown as maplibregl.MapLayerMouseEvent;

  const scarClick = (): maplibregl.MapLayerMouseEvent =>
    ({
      features: [{
        properties: {
          id: "scar-1", label: "Test Scar", place: "Test Basin", kind: "past",
          lat: 10, lon: 20, started: "2020-01-01",
          before: "2020-01-01", after: "2020-01-05",
        },
        geometry: { type: "Point", coordinates: [20, 10] },
      }],
      lngLat: { lng: 20, lat: 10 },
    }) as unknown as maplibregl.MapLayerMouseEvent;

  /** A live reading 30 min old, expressed relative to now so the age never
   *  drifts past a formatting boundary as the calendar moves. */
  const recentTrack = () => ({
    series: [], cell_bins: null,
    frp_live: [[new Date(Date.now() - 30 * 60_000).toISOString(), 510]],
  });

  /** One wind sample sitting on the clicked fire, fresh enough to survive
   *  fire_readout's staleness cutoff. Synthetic, per AGENTS.md. */
  const windPoints = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: { from_deg: 225, kmh: 18, t: new Date(Date.now() - 40 * 60_000).toISOString() },
    }],
  });

  const originalMatchMedia = window.matchMedia;
  afterEach(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = originalMatchMedia;
  });

  async function mount(desktop: boolean, wind: GeoJSON.FeatureCollection | null = null) {
    const media = fakeMatchMedia(desktop); // installed BEFORE setup reads it
    const { setupFireCard } = await import("../src/firecard");
    // Faithful to index.html: #panel lives INSIDE #view, #timeline outside it.
    document.body.innerHTML =
      `<div id="view" data-view="detail"><div id="panel" class="hidden"></div></div>` +
      `<div id="timeline"></div>`;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      stubMap(), { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {}, wind,
    );
    return { card, media };
  }

  const panelHtml = () => document.getElementById("panel")!.innerHTML;
  const overlay = () => document.getElementById("fire-readout");

  it("populates exactly one mount, chosen by the breakpoint", async () => {
    nextTrack = recentTrack();

    const desk = await mount(true);
    await desk.card.openFire(fireClick());
    // Desktop: the overlay carries the reading and the card carries none —
    // both at once would double-report one number, and neither is a silent
    // regression to the state before this feature existed.
    expect(overlay()).not.toBeNull();
    expect(overlay()!.textContent).toContain("510 MW");
    expect(panelHtml()).not.toContain("ro-peek");
    expect(panelHtml()).not.toContain("ro-body");

    const phone = await mount(false);
    await phone.card.openFire(fireClick());
    expect(overlay()).toBeNull();
    expect(document.querySelector(".fc-peek")!.textContent).toContain("510 MW");
    expect(panelHtml()).toContain("ro-body");
  });

  it("mounts the overlay beside #view, not inside it", async () => {
    nextTrack = recentTrack();
    const { card } = await mount(true);
    await card.openFire(fireClick());
    const view = document.getElementById("view")!;
    expect(view.contains(overlay()!)).toBe(false);
    expect(overlay()!.parentElement).toBe(document.body);
  });

  it("moves the readout when the breakpoint is crossed mid-card", async () => {
    nextTrack = recentTrack();
    const { card, media } = await mount(true);
    await card.openFire(fireClick());
    expect(overlay()).not.toBeNull();
    expect(panelHtml()).not.toContain("ro-body");

    media.cross(false); // window dragged narrow / phone rotated
    expect(overlay()).toBeNull();
    expect(panelHtml()).toContain("ro-body");
    expect(document.querySelector(".fc-peek")!.textContent).toContain("510 MW");

    media.cross(true); // and back again
    expect(overlay()).not.toBeNull();
    expect(overlay()!.textContent).toContain("510 MW");
    expect(panelHtml()).not.toContain("ro-body");
  });

  it("keeps the close button working after a breakpoint crossing", async () => {
    nextTrack = recentTrack();
    const { card, media } = await mount(true);
    await card.openFire(fireClick());
    media.cross(false); // re-renders the card, replacing every node in it

    // The re-render rewrote panel.innerHTML. Unless painting and binding are
    // one operation, this click does nothing and the card stays open — with
    // nothing about the card LOOKING wrong.
    document.querySelector<HTMLButtonElement>(".fc-close")!.click();
    expect(document.getElementById("panel")!.classList.contains("hidden")).toBe(true);
    expect(panelHtml()).toBe("");
    expect(overlay()).toBeNull();
  });

  it("keeps the before/after button working after a breakpoint crossing", async () => {
    nextTrack = recentTrack();
    const media = fakeMatchMedia(true);
    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML =
      `<div id="view" data-view="detail"><div id="panel" class="hidden"></div></div>` +
      `<div id="timeline"></div>`;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    let entered = 0;
    const card = setupFireCard(
      stubMap(), { generation: "gen-1", layers: {} } as never,
      { fromFire: () => { entered++; }, fromScar: () => {}, exit: () => {} },
      document.getElementById("timeline")!, switcher, () => {}, () => {}, null,
    );
    await card.openFire(fireClick());
    media.cross(false);

    document.querySelector<HTMLButtonElement>(".fc-ba")!.click();
    expect(entered).toBe(1);
  });

  it("clears the previous fire's overlay when another card opens", async () => {
    nextTrack = recentTrack();
    const { card } = await mount(true);
    await card.openFire(fireClick("fire-a", "Fire A"));
    expect(overlay()).not.toBeNull();

    // A scar never goes through close(), so an overlay cleared only there
    // would sit beside a card that is not the fire it belongs to.
    await card.openScar(scarClick());
    expect(panelHtml()).toContain("Test Basin");
    expect(overlay()).toBeNull();
  });

  it("clears the overlay when the card is closed", async () => {
    nextTrack = recentTrack();
    const { card } = await mount(true);
    await card.openFire(fireClick());
    expect(overlay()).not.toBeNull();
    card.close();
    expect(overlay()).toBeNull();
  });

  it("leaves a scar card's breakpoint crossing alone", async () => {
    nextTrack = recentTrack();
    const { card, media } = await mount(true);
    await card.openScar(scarClick());
    expect(overlay()).toBeNull();
    media.cross(false);
    expect(overlay()).toBeNull();
    expect(panelHtml()).toContain("Test Basin");
    media.cross(true);
    expect(overlay()).toBeNull();
  });

  it("reads the wind collection handed to setupFireCard", async () => {
    // Proves the new final argument reaches readoutModel — main.ts passes the
    // already-loaded collection, and a dropped argument would look exactly
    // like a fire with no wind sample near it.
    nextTrack = recentTrack();
    const { card } = await mount(true, windPoints());
    await card.openFire(fireClick());
    expect(overlay()!.textContent).toContain("SW");
    expect(overlay()!.textContent).toContain("18 km/h");
  });

  it("survives a browser with no matchMedia and keeps the card's copy", async () => {
    // jsdom has none, and the safe direction when the breakpoint is unknowable
    // is the card: it lives inside #panel and cannot be orphaned.
    nextTrack = recentTrack();
    const { setupFireCard } = await import("../src/firecard");
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    document.body.innerHTML =
      `<div id="view" data-view="detail"><div id="panel" class="hidden"></div></div>` +
      `<div id="timeline"></div>`;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {}, refresh: () => {} };
    const card = setupFireCard(
      stubMap(), { generation: "gen-1", layers: {} } as never, null,
      document.getElementById("timeline")!, switcher, () => {}, () => {},
    );
    await card.openFire(fireClick());
    expect(overlay()).toBeNull();
    expect(panelHtml()).toContain("ro-body");
  });
});
