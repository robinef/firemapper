/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type maplibregl from "maplibre-gl";
import { onUi } from "../src/ui_events";
import type { Switcher } from "../src/registry";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it, so stub it once before any module in this file that
// pulls the real maplibre-gl package in (firecard.ts, main.ts, layer_imagery.ts).
window.URL.createObjectURL ??= () => "";

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
    document.body.innerHTML = `<div id="panel"></div><div id="timeline"></div>`;
    const map = {
      getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
      getPaintProperty: () => 1, on: () => {}, off: () => {}, flyTo: () => {},
      getCanvas: () => ({ style: {} }),
    } as unknown as maplibregl.Map;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {} };

    const card = setupFireCard(
      map,
      { generation: "gen-1", layers: {} } as never,
      null,
      document.getElementById("timeline")!,
      switcher,
      () => {},
      () => {},
    );
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
  const fireClick = {
    lngLat: { lng: 1, lat: 2 },
    features: [{ properties: {} }],
  } as unknown as maplibregl.MapLayerMouseEvent;
  const fakeMap = {
    getLayer: () => null, getLayoutProperty: () => "visible", setLayoutProperty: () => {},
    flyTo: () => {},
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
});
