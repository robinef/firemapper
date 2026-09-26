/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import { emitUi } from "../src/ui_events";
import { deactivateScaleBlob, isScaleBlobActive } from "../src/layer_scale_blob";
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

/** Anything that isn't the fires summary: the blob no longer requests any
 * other file, so a hit here would be a regression, and a 404 makes it loud. */
const notFound = { ok: false, json: async () => null };

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
    getBounds: () => ({ contains: () => true }),
    easeTo: vi.fn(),
    setPaintProperty: vi.fn(),
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
          : notFound,
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const off = wireScaleBlobToggle(map, btn, breakdown);
    btn.click();
    // The click handler is async (fetch the summary → addSource → render the breakdown); let it settle.
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

  it("a slow summary that resolves after compare:enter neither shows the blob nor fills the panel", async () => {
    // The shape and the panel wait on the same summary. If the reader leaves
    // for compare mode while it is still loading, the late resolve must not
    // add the shape over the compared imagery, fill the panel, or relabel the
    // reset button "unavailable".
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
      return Promise.resolve(notFound);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const off = wireScaleBlobToggle(map, btn, breakdown);
    btn.click();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(btn.textContent).toBe("Loading…");

    emitUi("compare:enter");
    resolveFiresFetch({ ok: true, json: async () => ({ "fire-1": { country: "FR", area_km2: 3.2 } }) });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(isScaleBlobActive()).toBe(false);
    expect(map._layers).toEqual([]);
    expect(breakdown.innerHTML).toBe("");
    expect(btn.textContent).toBe("Compare fire scale");
    expect(btn.disabled).toBe(false);

    // ...and the next click still works: the cancelled load left no wedge.
    btn.click();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    resolveFiresFetch({ ok: true, json: async () => ({ "fire-1": { country: "FR", area_km2: 3.2 } }) });
    await vi.waitFor(() => expect(isScaleBlobActive()).toBe(true));

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
          : notFound,
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

    // The shape is built from the same summary: nothing is fetched at all.
    expect(firesRequests()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();

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

    // The shape is labelled with the shown season, built from its summary.
    const label = (map._sources["scale-blob-label"] as { data: GeoJSON.FeatureCollection }).data;
    expect(label.features[0].properties!.text).toContain(`EU-27 fires, ${shown}`);
    // The given promise is the shown season's, so it is used as-is.
    expect(urls).toHaveLength(0);
    expect(firesRequests()).toHaveLength(0);

    off();
    vi.unstubAllGlobals();
  });

  // The shape is built from the summary, so a failed summary load means no
  // shape: the button says so, and the rejection is handled rather than left
  // for the console.
  it("a rejected summary fetch leaves the blob unavailable, with no unhandled rejection", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();
    const unhandled = vi.fn();
    // `process` is the only place an unhandled rejection surfaces under the
    // vitest runner, and @types/node is deliberately not in this tsconfig
    // (the app is browser-only) — hence the local shape.
    const proc = (globalThis as unknown as {
      process: {
        on(e: string, fn: () => void): void;
        off(e: string, fn: () => void): void;
      };
    }).process;
    proc.on("unhandledRejection", unhandled);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));

    const off = wireScaleBlobToggle(map, btn, breakdown);
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("Compare fire scale (unavailable)"));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(isScaleBlobActive()).toBe(false);
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
          : notFound,
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

describe("scale blob legend rows", () => {
  it("a click on a panel row selects its band, and the map's selection marks the row", async () => {
    const { wireScaleBlobToggle } = await import("../src/main");
    const { scaleBlobSelection, selectScaleBlobBand } = await import("../src/layer_scale_blob");
    const map = stubMap();
    const btn = button();
    const breakdown = breakdownEl();
    const off = wireScaleBlobToggle(map, btn, breakdown, {
      year: new Date().getUTCFullYear(),
      promise: Promise.resolve({
        a: { country: "FR", area_km2: 30 },
        b: { country: "ES", area_km2: 12 },
      }),
    });
    btn.click();
    await vi.waitFor(() => expect(breakdown.querySelector('[data-band="ES"]')).not.toBeNull());

    const es = breakdown.querySelector<HTMLElement>('[data-band="ES"]')!;
    es.click();
    expect(scaleBlobSelection()).toBe("ES");
    expect(es.classList.contains("selected")).toBe(true);

    // Keyboard: Enter on the FR row switches the selection.
    const fr = breakdown.querySelector<HTMLElement>('[data-band="FR"]')!;
    fr.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(scaleBlobSelection()).toBe("FR");
    expect(es.classList.contains("selected")).toBe(false);
    expect(fr.getAttribute("aria-pressed")).toBe("true");

    // Selected from the map side: the row follows.
    selectScaleBlobBand("FR");
    expect(fr.classList.contains("selected")).toBe(false);

    off();
  });
});
