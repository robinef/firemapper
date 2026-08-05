/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type * as maplibregl from "maplibre-gl";
import { onUi } from "../src/ui_events";
import type { Switcher } from "../src/registry";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it, so stub it once before any module in this file that
// pulls the real maplibre-gl package in (firecard.ts, main.ts, layer_imagery.ts).
window.URL.createObjectURL ??= () => "";

// jsdom has no matchMedia at all (see sheet.ts's own note on this), and
// compare mode's touch-only lock gate (main.ts) now depends on one. Default
// to "coarse" (touch) so the pre-existing lock/unlock tests below — written
// before that gate existed, and asserting on the lock mechanics themselves —
// keep exercising the locked path unchanged; the desktop test further down
// overrides this per-call to prove the gate actually excludes a fine pointer.
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (q: string) =>
  ({ matches: q === "(pointer: coarse)" }) as MediaQueryList;

// main.ts calls boot() unconditionally at import time, which would otherwise
// construct a real maplibregl.Map (needs a WebGL canvas jsdom doesn't have)
// and, via compare mode, a second one inside ImagerySwipe. Mock just those two
// so importing main.ts for setupCompareMode is safe under jsdom.
vi.mock("../src/map", () => ({
  createMap: () => ({ on: () => {}, getCanvas: () => ({ style: {} }) }),
}));
vi.mock("../src/layer_imagery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/layer_imagery")>();
  return { ...actual, ImagerySwipe: class { destroy() {} } };
});

// The wiring test asserts the CONTRACT, not the internals: closing a fire card
// must announce itself. It uses the real module through a minimal fake map.
describe("ui event wiring", () => {
  it("firecard close emits detail:close", async () => {
    const seen: string[] = [];
    onUi("detail:close", () => seen.push("close"));

    const { setupFireCard } = await import("../src/firecard");
    // index.html starts #panel with class="hidden"; match that here so
    // isOpen reflects the real initial state instead of a fixture artifact.
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
    expect(card.isOpen).toBe(false); // nothing opened yet
    card.close();
    expect(seen).toEqual(["close"]);
  });
});

// Regression coverage: firecard.close() calls compare?.exit() unconditionally
// (see the test above's `compare: null`, which is the "never entered" case in
// production too — a plain close on a fire with no imagery configured never
// even builds a CompareMode). setupCompareMode's exit() must only announce
// compare:exit when compare mode was actually entered, so the sheet (which
// collapses on enter and restores height on exit) doesn't restore a stale
// height on an ordinary fire-card dismissal.
describe("compare mode enter/exit", () => {
  // fromFire/fromScar take a snapshot of the clicked feature, not the event:
  // MapLibre deletes event.features once a delegated handler returns, and the
  // card's compare button fires long after that.
  const fireClick = { props: {}, lon: 1, lat: 2 };
  // setupCompareMode now locks/unlocks dragPan+dragRotate on enter/exit (see
  // compare_lock.ts), so the fake map needs those handlers stubbed too.
  const handler = () => ({ isEnabled: () => true, enable: () => {}, disable: () => {} });
  const fakeMap = {
    getLayer: () => null, getLayoutProperty: () => "visible", setLayoutProperty: () => {},
    flyTo: () => {}, dragPan: handler(), dragRotate: handler(),
  } as unknown as maplibregl.Map;
  const manifest = { imagery: { source: "gibs", gibs_layer: "x", hd: null, scars: [] } } as never;

  it("emits compare:exit exactly once after entering then exiting", async () => {
    const seen: string[] = [];
    const offEnter = onUi("compare:enter", () => seen.push("enter"));
    const offExit = onUi("compare:exit", () => seen.push("exit"));

    const { setupCompareMode } = await import("../src/main");
    const compare = setupCompareMode(fakeMap, manifest)!;
    compare.fromFire(fireClick);
    compare.exit();

    expect(seen).toEqual(["enter", "exit"]);
    offEnter();
    offExit();
  });

  it("emits nothing when exit() is called without having entered", async () => {
    const seen: string[] = [];
    const off = onUi("compare:exit", () => seen.push("exit"));

    const { setupCompareMode } = await import("../src/main");
    const compare = setupCompareMode(fakeMap, manifest)!;
    compare.exit();

    expect(seen).toEqual([]);
    off();
  });

  // `fakeMap` above hardcodes isEnabled() to true, so it can't tell a correct
  // restore from a corrupted one — a fake with REAL state (same shape as
  // compare_touch.test.ts's) is needed to catch the `enter()` re-entry guard
  // regressing: without `if (!locked) locked = lockMap(map)`, a second
  // fromFire() while already comparing would recapture {false, false} (the
  // already-locked state) and exit() would then restore to disabled instead
  // of the map's true pre-compare state.
  it("restores the original handler state even after switching fires without exiting", async () => {
    const handler = (on: boolean) => ({
      _on: on,
      isEnabled() {
        return this._on;
      },
      enable() {
        this._on = true;
      },
      disable() {
        this._on = false;
      },
    });
    const dragPan = handler(true);
    const dragRotate = handler(true);
    const map = {
      getLayer: () => null, getLayoutProperty: () => "visible", setLayoutProperty: () => {},
      flyTo: () => {}, dragPan, dragRotate,
    } as unknown as maplibregl.Map;

    const { setupCompareMode } = await import("../src/main");
    const compare = setupCompareMode(map, manifest)!;

    compare.fromFire(fireClick); // first entry: locks, captures {true, true}
    expect(dragPan.isEnabled()).toBe(false);
    compare.fromFire(fireClick); // re-entry (switching fires) without exiting first
    compare.exit();

    expect(dragPan.isEnabled()).toBe(true);
    expect(dragRotate.isEnabled()).toBe(true);
  });

  // Regression for capability loss on a live product: the lock existed to
  // arbitrate a touch-drag ambiguity between the swipe divider and the map
  // underneath it (see main.ts's comment at the lockMap call). On desktop
  // the divider is a sibling of MapLibre's own drag-handling subtree, so a
  // mouse-drag on it never reached MapLibre's pan handler even before this
  // gate existed — locking there disabled mouse pan/rotate for nothing.
  it("does not lock the map on desktop (fine pointer)", async () => {
    const original = window.matchMedia;
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () =>
      ({ matches: false }) as MediaQueryList; // no media query matches: desktop
    try {
      const handler = (on: boolean) => ({
        _on: on,
        isEnabled() {
          return this._on;
        },
        enable() {
          this._on = true;
        },
        disable() {
          this._on = false;
        },
      });
      const dragPan = handler(true);
      const dragRotate = handler(true);
      const map = {
        getLayer: () => null, getLayoutProperty: () => "visible", setLayoutProperty: () => {},
        flyTo: () => {}, dragPan, dragRotate,
      } as unknown as maplibregl.Map;

      const { setupCompareMode } = await import("../src/main");
      const compare = setupCompareMode(map, manifest)!;
      compare.fromFire(fireClick);

      expect(dragPan.isEnabled()).toBe(true);
      expect(dragRotate.isEnabled()).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });
});
