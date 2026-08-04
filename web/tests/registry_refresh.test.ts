/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { mountSwitcher, type LayerModule } from "../src/registry";

/**
 * Compare mode hides the overlay layers itself (main.ts hideOverlays) and then
 * flies the camera. The resulting moveend triggers switcher.refresh(), and if
 * that reasserts visibility it puts every fire dot, halo, footprint and label
 * back on top of the before/after swipe — for the whole session, and again on
 * every pan. Nothing may hide a layer behind the switcher's back unless a
 * status-only redraw leaves visibility alone.
 */
function harness(modules: LayerModule[]) {
  const vis: Record<string, string> = {};
  for (const m of modules) for (const id of m.layerIds) vis[id] = "visible";
  const map = {
    getLayer: (id: string) => (id in vis ? {} : null),
    getLayoutProperty: (id: string) => vis[id],
    setLayoutProperty: (id: string, _k: string, v: string) => { vis[id] = v; },
  } as never;
  const s = mountSwitcher(
    document.createElement("div"), document.createElement("div"), modules, map, null as never,
  );
  return { s, vis };
}

const fires: LayerModule = {
  key: "fires", label: "Fires", question: "?", layerIds: ["fires-major"], defaultOn: true,
};

describe("refresh() redraws the panel without touching the map", () => {
  it("leaves a layer hidden by compare mode hidden", () => {
    const { s, vis } = harness([fires]);
    vis["fires-major"] = "none";
    s.refresh();
    expect(vis["fires-major"]).toBe("none");
  });

  it("still updates the status line while leaving visibility alone", () => {
    let n = 0;
    const el = document.createElement("div");
    const vis: Record<string, string> = { "fires-major": "visible" };
    const map = {
      getLayer: (id: string) => (id in vis ? {} : null),
      getLayoutProperty: (id: string) => vis[id],
      setLayoutProperty: (id: string, _k: string, v: string) => { vis[id] = v; },
    } as never;
    const s = mountSwitcher(el, document.createElement("div"),
      [{ ...fires, status: () => `${++n} in view` }], map, null as never);
    vis["fires-major"] = "none";
    s.refresh();
    expect(el.querySelector(".layer-count")?.textContent).toContain("in view");
    expect(vis["fires-major"]).toBe("none");
  });

  it("a real user toggle still reasserts visibility", () => {
    // The clobber fix must not stop the switcher doing its actual job.
    const { s, vis } = harness([fires]);
    vis["fires-major"] = "none";
    s.setLevel(1);
    expect(vis["fires-major"]).toBe("visible");
  });
});
