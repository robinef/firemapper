/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ImagerySwipe's constructor builds a second, real maplibregl.Map for the
// "after" layer (see layer_imagery.ts's own doc comment for why) — that needs
// a WebGL canvas jsdom doesn't have. Mock the whole module with a fake Map
// that has just enough surface for ImagerySwipe to run, same approach
// ui_events_wiring.test.ts uses to avoid booting real maplibre-gl under
// jsdom. This lets these tests exercise the REAL attachDrag/destroy pointer
// lifecycle instead of re-implementing it against a stand-in.
vi.mock("maplibre-gl", () => {
  class FakeMap {
    private handlers: Record<string, Array<() => void>> = {};
    private opts: { container?: HTMLElement };
    constructor(opts: { container?: HTMLElement } = {}) {
      this.opts = opts;
    }
    getStyle() {
      return { layers: [] };
    }
    getContainer() {
      return this.opts.container ?? document.createElement("div");
    }
    getCenter() {
      return { lng: 0, lat: 0 };
    }
    getZoom() {
      return 0;
    }
    getBearing() {
      return 0;
    }
    getPitch() {
      return 0;
    }
    getLayer() {
      return undefined;
    }
    getSource() {
      return undefined;
    }
    addSource() {}
    addLayer() {}
    removeLayer() {}
    removeSource() {}
    jumpTo() {}
    remove() {}
    on(evt: string, cb: () => void) {
      (this.handlers[evt] ??= []).push(cb);
      if (evt === "load") cb(); // "after" source/layer setup runs synchronously
    }
    off() {}
  }
  // A named export, not `{ default: ... }`: maplibre 6 is ESM-only and has no
  // default export, so a default-shaped mock leaves `maplibregl.Map` undefined
  // and the file fails to load before any test runs.
  return { Map: FakeMap };
});

import * as maplibregl from "maplibre-gl";
import { ImagerySwipe } from "../src/layer_imagery";

// A typed constructor view of the mocked Map so callers don't have to fight
// the real maplibregl.Map's much larger MapOptions type for a fake this small.
const MapCtor = maplibregl.Map as unknown as new (opts: {
  container: HTMLElement;
}) => maplibregl.Map;

function dispatch(target: EventTarget, type: string, pointerId: number, clientX = 0) {
  target.dispatchEvent(new PointerEvent(type, { pointerId, clientX, bubbles: true, cancelable: true }));
}

/** Build a swipe over a container with a deterministic, non-zero width —
 * jsdom's real layout always reports 0, which would make every ratio
 * collapse to the same value and hide a broken drag. */
function makeSwipe(): { swipe: ImagerySwipe; divider: HTMLElement; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(container, "clientWidth", { value: 400, configurable: true });
  container.getBoundingClientRect = () =>
    ({ left: 0, right: 400, width: 400, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

  const main = new MapCtor({ container });
  const swipe = new ImagerySwipe(main, ["before.jpg"], ["after.jpg"]);
  const divider = container.querySelector(".swipe-divider") as HTMLElement;
  divider.setPointerCapture = () => undefined; // jsdom has no real pointer capture
  divider.releasePointerCapture = () => undefined;
  return { swipe, divider, container };
}

describe("ImagerySwipe divider drag lifecycle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("moves the divider on drag", () => {
    const { divider } = makeSwipe();
    dispatch(divider, "pointerdown", 1, 200);
    dispatch(window, "pointermove", 1, 200); // 200/400 = ratio 0.5 → x = 200
    expect(divider.style.left).toBe("200px");
  });

  it("a second pointer cannot hijack an active drag", () => {
    const { divider } = makeSwipe();
    dispatch(divider, "pointerdown", 1, 200);
    dispatch(window, "pointermove", 1, 200);
    expect(divider.style.left).toBe("200px");

    // A second finger lands mid-drag on the divider itself...
    dispatch(divider, "pointerdown", 2, 40);
    // ...and its own pointermove must be ignored: the ratio does not jump to
    // where finger 2 landed (40/400 = 0.1 → 40px would prove a hijack).
    dispatch(window, "pointermove", 2, 40);
    expect(divider.style.left).toBe("200px");

    // The original finger still drives the divider.
    dispatch(window, "pointermove", 1, 300);
    expect(divider.style.left).toBe("300px");
  });

  it("pointercancel stops the drag exactly like pointerup", () => {
    const { divider } = makeSwipe();
    dispatch(divider, "pointerdown", 1, 100);
    dispatch(window, "pointermove", 1, 100);
    expect(divider.style.left).toBe("100px");

    // Simulates an interrupted gesture (incoming call, OS gesture) instead of
    // a clean release.
    dispatch(window, "pointercancel", 1);
    dispatch(window, "pointermove", 1, 390);
    // Without pointercancel wired to the same teardown as pointerup, this
    // move would still land (the divider would "follow a finger that is no
    // longer there").
    expect(divider.style.left).toBe("100px");
  });

  it("a fresh drag is possible after pointercancel released the previous one", () => {
    const { divider } = makeSwipe();
    dispatch(divider, "pointerdown", 1, 100);
    dispatch(window, "pointermove", 1, 100);
    dispatch(window, "pointercancel", 1);

    // New gesture, new pointerId — must not be rejected as "a drag already in
    // progress" (i.e. pointercancel actually cleared activePointerId).
    dispatch(divider, "pointerdown", 2, 250);
    dispatch(window, "pointermove", 2, 250);
    expect(divider.style.left).toBe("250px");
  });

  it("destroy() mid-drag releases the window listeners instead of leaking them", () => {
    const { swipe, divider } = makeSwipe();
    dispatch(divider, "pointerdown", 1, 50);
    dispatch(window, "pointermove", 1, 50);
    expect(divider.style.left).toBe("50px");

    const removeSpy = vi.spyOn(window, "removeEventListener");
    swipe.destroy();
    const removedTypes = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedTypes).toEqual(
      expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]),
    );
    removeSpy.mockRestore();

    // The pointer that was mid-drag when destroy() ran must no longer be
    // able to move anything — before the fix this dispatch would still
    // update this.divider.style.left because the closure stayed bound to
    // `window` forever (the leak Finding 1 describes).
    dispatch(window, "pointermove", 1, 999);
    expect(divider.style.left).toBe("50px");
  });

  it("destroy() is idempotent", () => {
    const { swipe, divider } = makeSwipe();
    dispatch(divider, "pointerdown", 1, 50);
    dispatch(window, "pointermove", 1, 50);
    expect(() => {
      swipe.destroy();
      swipe.destroy();
    }).not.toThrow();
  });

  // Regression for the real-browser-only lockup: setPointerCapture/
  // releasePointerCapture can throw NotFoundError when the browser's
  // internal pointer-id tracking doesn't recognise the id as currently
  // active (a real, documented cross-browser Pointer Events quirk — see
  // sheet.ts's identical handle-drag pattern for the fuller writeup). The
  // no-op stubs in makeSwipe() never exercise this path, so this test
  // forces exactly one throw from each call, matching a genuine first-drag
  // failure, and asserts a second, independent drag still moves the
  // divider. Before the fix, an uncaught throw left activePointerId stuck
  // non-null and the divider dead for the rest of the page's life.
  it("recovers from a NotFoundError on pointer capture so the next drag still works", () => {
    const { divider } = makeSwipe();
    let setCalls = 0;
    let releaseCalls = 0;
    divider.setPointerCapture = () => {
      setCalls++;
      if (setCalls === 1) throw new DOMException("no active pointer", "NotFoundError");
    };
    divider.releasePointerCapture = () => {
      releaseCalls++;
      if (releaseCalls === 1) throw new DOMException("no active pointer", "NotFoundError");
    };

    // First drag: both capture calls throw. Must not leave the divider stuck.
    dispatch(divider, "pointerdown", 1, 100);
    dispatch(window, "pointermove", 1, 100);
    dispatch(window, "pointerup", 1, 100);
    expect(divider.style.left).toBe("100px");

    // Second, independent drag with fresh pointer capture calls (no longer
    // throwing) — only possible if activePointerId was reset after the first.
    dispatch(divider, "pointerdown", 2, 250);
    dispatch(window, "pointermove", 2, 250);
    dispatch(window, "pointerup", 2, 250);
    expect(divider.style.left).toBe("250px");
    expect(setCalls).toBe(2);
    expect(releaseCalls).toBe(2);
  });
});
