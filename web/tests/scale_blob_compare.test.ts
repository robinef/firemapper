/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import { emitUi } from "../src/ui_events";
import { deactivateScaleBlob, isScaleBlobActive } from "../src/layer_scale_blob";
import type { ScaleBlobCell } from "../src/layer_scale_blob";
import type { FiresSummary } from "../src/types";

// Same import-time guards as tests/ui_events_wiring.test.ts: maplibre-gl calls
// URL.createObjectURL on load, and main.ts calls boot() unconditionally at
// import time, which would build a real WebGL map (and a second one inside
// ImagerySwipe) that jsdom cannot provide.
window.URL.createObjectURL ??= () => "";
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () =>
  ({ matches: false }) as MediaQueryList;
vi.mock("../src/map", () => ({
  createMap: () => ({ on: () => {}, getCanvas: () => ({ style: {} }) }),
}));
vi.mock("../src/layer_imagery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/layer_imagery")>();
  return { ...actual, ImagerySwipe: class { destroy() {} } };
});

const sampleBlob: ScaleBlobCell[] = [
  { fire_id: "fire-1", cell_id: "cell-a", res: 8, vertices_m: [[0, 0], [10, 0], [10, 10], [0, 10]] },
];

/** Minimal stand-in for the real map, in the style of
 *  tests/layer_scale_blob.test.ts — a real jsdom <canvas> so the layer's native
 *  pointer listeners are genuinely added and removed. */
function stubMap() {
  const sources: Record<string, unknown> = {};
  const layers: string[] = [];
  const canvas = document.createElement("canvas");
  return {
    getSource: (id: string) => sources[id],
    addSource: (id: string, def: Record<string, unknown>) => {
      sources[id] = { ...def, setData: vi.fn() };
    },
    addLayer: (def: { id: string }) => layers.push(def.id),
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    removeLayer: (id: string) => {
      const i = layers.indexOf(id);
      if (i >= 0) layers.splice(i, 1);
    },
    removeSource: (id: string) => {
      delete sources[id];
    },
    getCanvas: () => canvas,
    getCenter: () => ({ lat: 45, lng: 5 }),
    _layers: layers,
    _sources: sources,
  } as unknown as maplibregl.Map & { _layers: string[]; _sources: Record<string, unknown> };
}

function button(): HTMLButtonElement {
  document.body.innerHTML =
    `<button id="scale-blob-toggle" aria-pressed="false">Compare fire scale</button>` +
    `<div id="scale-blob-breakdown"></div>`;
  return document.getElementById("scale-blob-toggle") as HTMLButtonElement;
}

function breakdownEl(): HTMLElement {
  return document.getElementById("scale-blob-breakdown") as HTMLElement;
}

afterEach(() => {
  deactivateScaleBlob(stubMap());
});

/**
 * style.css hides #scale-blob-control under body.compare-mode, because dragging
 * the shape fights the compare-mode swipe divider for the same gesture. Hiding
 * the BUTTON is not the same thing as turning the LAYER off: CSS reaches
 * neither the fill layer, nor its source, nor the native canvas pointer
 * listeners. Before this wiring existed, entering compare with the blob active
 * left it painting over the two dated images, still draggable, with the only
 * control that could dismiss it now invisible.
 */
describe("scale blob vs compare mode", () => {
  it("compare:enter deactivates the layer, resets the button, and clears the breakdown panel", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();
    const fetchSpy = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("_fires.json")
          ? { ok: true, json: async () => ({ "fire-1": { country: "FR", area_km2: 3.2 } }) }
          : { ok: true, json: async () => sampleBlob },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const off = wireScaleBlobToggle(map, btn, breakdown);
    btn.click();
    // The click handler is async (fetch → addSource → fetch the breakdown); let it settle.
    await vi.waitFor(() => expect(isScaleBlobActive()).toBe(true));
    await vi.waitFor(() => expect(breakdown.innerHTML).toContain("FR"));
    expect(map._layers).toContain("scale-blob-fill");
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    emitUi("compare:enter");

    expect(isScaleBlobActive()).toBe(false);
    // The source and layer are really gone, not merely flagged inactive — a
    // lingering fill would keep painting over the compared imagery.
    expect(map._layers).not.toContain("scale-blob-fill");
    expect(map._sources["scale-blob"]).toBeUndefined();
    // ...and the button does not come back out of compare mode still offering
    // to exit a shape that no longer exists.
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toBe("Compare fire scale");
    // ...nor does the country breakdown linger for a shape that's gone.
    expect(breakdown.innerHTML).toBe("");

    off();
    vi.unstubAllGlobals();
  });

  it("compare:enter is harmless when the blob was never activated", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();

    const off = wireScaleBlobToggle(map, btn, breakdownEl());
    expect(() => emitUi("compare:enter")).not.toThrow();
    expect(isScaleBlobActive()).toBe(false);

    off();
  });

  it("a slow country-breakdown fetch that resolves after deactivation does not repopulate the panel", async () => {
    // The panel fetch is fire-and-forget (activation doesn't wait on it) —
    // so it can still be in flight when the reader deactivates the blob
    // before it resolves. Without a recheck, the stale resolve would
    // silently write country stats back into a panel for a blob that's no
    // longer shown.
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();

    let resolveFiresFetch!: (v: { ok: boolean; json: () => Promise<unknown> }) => void;
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes("_fires.json")) {
        return new Promise((resolve) => {
          resolveFiresFetch = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: async () => sampleBlob });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const off = wireScaleBlobToggle(map, btn, breakdown);
    btn.click();
    await vi.waitFor(() => expect(isScaleBlobActive()).toBe(true));
    expect(breakdown.innerHTML).toBe(""); // fires.json fetch still pending

    // Deactivate before the pending fetch ever resolves.
    btn.click();
    expect(isScaleBlobActive()).toBe(false);
    expect(breakdown.innerHTML).toBe("");

    // Now let the stale fetch resolve.
    resolveFiresFetch({ ok: true, json: async () => ({ "fire-1": { country: "FR", area_km2: 3.2 } }) });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // A tick for the .then() guard to run after the promise settles.
    await new Promise((r) => setTimeout(r, 0));

    expect(breakdown.innerHTML).toBe("");

    off();
    vi.unstubAllGlobals();
  });

  it("the returned teardown unsubscribes from compare:enter", async () => {
    // A leaked subscriber would keep deactivating against a stale map for every
    // future compare:enter — the same leak tests/scrubber.test.ts guards.
    const { wireScaleBlobToggle } = await import("../src/main");
    const { uiSubscriberCount } = await import("../src/ui_events");
    const before = uiSubscriberCount("compare:enter");

    const btn = button();
    const off = wireScaleBlobToggle(stubMap(), btn, breakdownEl());
    expect(uiSubscriberCount("compare:enter")).toBe(before + 1);
    off();
    expect(uiSubscriberCount("compare:enter")).toBe(before);
  });
});

/**
 * The country breakdown and the season layer's EU-27 scope read the SAME file,
 * archive/blob_{year}_fires.json (~1.1 MB). main.ts starts that load once at
 * boot and hands the promise here, so activating the blob costs no second
 * download and no second parse of a file the page is already holding.
 */
describe("scale blob country breakdown source", () => {
  const firesJson: FiresSummary = { "fire-1": { country: "FR", area_km2: 3.2 } };

  /** Counts requests per URL so "only one load" can be asserted as a fact
   * about the network, not inferred from what rendered. */
  function countingFetch() {
    const urls: string[] = [];
    const spy = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(
        url.includes("_fires.json")
          ? { ok: true, json: async () => firesJson }
          : { ok: true, json: async () => sampleBlob },
      );
    });
    return { spy, urls, firesRequests: () => urls.filter((u) => u.includes("_fires.json")) };
  }

  it("renders from the promise it is given, without a second request", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();
    const { spy, firesRequests } = countingFetch();
    vi.stubGlobal("fetch", spy);

    const off = wireScaleBlobToggle(map, btn, breakdown, {
      year: new Date().getFullYear(),
      promise: Promise.resolve(firesJson),
    });
    btn.click();
    await vi.waitFor(() => expect(isScaleBlobActive()).toBe(true));
    await vi.waitFor(() => expect(breakdown.innerHTML).toContain("FR"));

    // The blob geometry is still fetched — it is a different file. The fires
    // summary is not fetched at all.
    expect(firesRequests()).toEqual([]);

    off();
    vi.unstubAllGlobals();
  });

  // The blob is the season the map shows (manifest.season_year), not the
  // reader's clock: through January that is the ended season, and the blob,
  // its countries and the season layer must all be the same year's.
  it("compares against the shown season's blob, even when the clock says another year", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();
    const { spy, urls, firesRequests } = countingFetch();
    vi.stubGlobal("fetch", spy);

    const shown = new Date().getUTCFullYear() - 1;
    const off = wireScaleBlobToggle(map, btn, breakdown, {
      year: shown,
      promise: Promise.resolve(firesJson),
    });
    btn.click();
    await vi.waitFor(() => expect(isScaleBlobActive()).toBe(true));
    await vi.waitFor(() => expect(breakdown.innerHTML).toContain("FR"));

    const blobs = urls.filter((u) => /blob_\d{4}\.json/.test(u));
    expect(blobs.length).toBeGreaterThan(0);
    expect(blobs.every((u) => u.includes(`blob_${shown}.json`))).toBe(true);
    // The given promise is the shown season's, so it is used as-is.
    expect(firesRequests()).toHaveLength(0);

    off();
    vi.unstubAllGlobals();
  });

  // The enclosing try/catch in the click handler has already returned by the
  // time this promise settles, and the fallback path can genuinely reject:
  // fetchFiresSummary does not swallow a network error the way
  // data.ts::loadFiresSummary does. The blob itself activated fine, so the
  // reader must get the shape, an empty breakdown, and no console noise.
  it("survives a rejected countries fetch", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();
    const unhandled = vi.fn();
    // `process` is the only place an unhandled rejection surfaces under the
    // vitest runner, and @types/node is deliberately not in this tsconfig
    // (the app is browser-only) — hence the local shape, same pattern as
    // main.ts's navigator.connection.
    const proc = (globalThis as unknown as {
      process: {
        on(e: string, fn: () => void): void;
        off(e: string, fn: () => void): void;
      };
    }).process;
    proc.on("unhandledRejection", unhandled);
    const spy = vi.fn((url: string) =>
      url.includes("_fires.json")
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({ ok: true, json: async () => sampleBlob }),
    );
    vi.stubGlobal("fetch", spy);

    const off = wireScaleBlobToggle(map, btn, breakdown);
    btn.click();
    await vi.waitFor(() => expect(isScaleBlobActive()).toBe(true));
    // Let the rejection settle AND give node a turn to report it if nobody
    // caught it — an unhandledRejection fires at the end of the event loop
    // turn, not on the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(btn.textContent).toBe("Exit fire-scale compare");
    expect(breakdown.innerHTML).toBe("");
    expect(unhandled).not.toHaveBeenCalled();

    proc.off("unhandledRejection", unhandled);
    off();
    vi.unstubAllGlobals();
  });

  it("fetches as before when no promise is given", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();
    const { spy, firesRequests } = countingFetch();
    vi.stubGlobal("fetch", spy);

    const off = wireScaleBlobToggle(map, btn, breakdown);
    btn.click();
    await vi.waitFor(() => expect(breakdown.innerHTML).toContain("FR"));
    expect(firesRequests()).toHaveLength(1);

    off();
    vi.unstubAllGlobals();
  });
});

/**
 * Opening a fire's card (fireCardHtml, scarCardHtml, or the historical-lookup
 * card — open() in firecard.ts fires "detail:open" for all three) flies the
 * camera in to that one fire. The scale blob is a REAL geographic shape sized
 * in km², not a screen-space overlay, so left active it keeps painting at its
 * fixed location — and grows to dominate the view — as the map zooms in
 * underneath it. Only compare:enter turned the blob off before this fix;
 * opening a card did not, even though it is exactly the same "the reader is no
 * longer looking at the overview" transition.
 */
describe("scale blob vs opening a fire card", () => {
  it("detail:open deactivates the layer, resets the button, and clears the breakdown panel", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();
    const fetchSpy = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("_fires.json")
          ? { ok: true, json: async () => ({ "fire-1": { country: "FR", area_km2: 3.2 } }) }
          : { ok: true, json: async () => sampleBlob },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const off = wireScaleBlobToggle(map, btn, breakdown);
    btn.click();
    await vi.waitFor(() => expect(isScaleBlobActive()).toBe(true));
    await vi.waitFor(() => expect(breakdown.innerHTML).toContain("FR"));
    expect(map._layers).toContain("scale-blob-fill");

    emitUi("detail:open");

    expect(isScaleBlobActive()).toBe(false);
    expect(map._layers).not.toContain("scale-blob-fill");
    expect(map._sources["scale-blob"]).toBeUndefined();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toBe("Compare fire scale");
    expect(breakdown.innerHTML).toBe("");

    off();
    vi.unstubAllGlobals();
  });

  it("detail:open is harmless when the blob was never activated", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const btn = button();

    const off = wireScaleBlobToggle(stubMap(), btn, breakdownEl());
    expect(() => emitUi("detail:open")).not.toThrow();
    expect(isScaleBlobActive()).toBe(false);

    off();
  });

  it("the returned teardown unsubscribes from detail:open", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const { uiSubscriberCount } = await import("../src/ui_events");
    const before = uiSubscriberCount("detail:open");

    const btn = button();
    const off = wireScaleBlobToggle(stubMap(), btn, breakdownEl());
    expect(uiSubscriberCount("detail:open")).toBe(before + 1);
    off();
    expect(uiSubscriberCount("detail:open")).toBe(before);
  });
});
