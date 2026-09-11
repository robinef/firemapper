/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import { emitUi } from "../src/ui_events";
import { deactivateScaleBlob, isScaleBlobActive } from "../src/layer_scale_blob";
import type { ScaleBlobCell } from "../src/layer_scale_blob";

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
