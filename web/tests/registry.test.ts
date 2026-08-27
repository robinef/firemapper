// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mountSwitcher, type LayerModule } from "../src/registry";

function stubMap() {
  const vis: Record<string, string> = {};
  return {
    vis,
    getLayer: () => ({}),
    setLayoutProperty: (id: string, _p: string, v: string) => {
      vis[id] = v;
    },
  };
}

const MODULES: LayerModule[] = [
  { key: "fires", label: "Active fires", question: "q", layerIds: ["fires-major"], defaultOn: true, levels: [1, 2] },
  { key: "scars", label: "Burn scars", question: "q", layerIds: ["scars-dot"], defaultOn: true, levels: [1] },
  { key: "arrival", label: "Fire arrival", question: "q", layerIds: ["arrival-x"], defaultOn: false, levels: [2] },
];

function mount() {
  document.body.innerHTML = '<div id="l"></div><div id="lg"></div>';
  const L = document.getElementById("l")!;
  const map = stubMap();
  const sw = mountSwitcher(L, document.getElementById("lg")!, MODULES, map as never);
  const names = () => [...L.querySelectorAll(".layer-name")].map((x) => x.textContent);
  const title = () => L.querySelector(".layers-title")?.textContent;
  return { sw, map, names, title };
}

describe("level-aware layer switcher", () => {
  it("level 1 shows overview toggles and force-hides level-2 layers", () => {
    const { map, names, title } = mount();
    expect(title()).toBe("Layers");
    expect(names()).toEqual(["Active fires", "Burn scars"]);
    expect(map.vis["fires-major"]).toBe("visible"); // on + in level
    expect(map.vis["scars-dot"]).toBe("visible");
    expect(map.vis["arrival-x"]).toBe("none"); // level-2 layer hidden at L1
  });

  it("level 2 swaps to the detail set and hides overview-only layers", () => {
    const { sw, map, names, title } = mount();
    sw.setLevel(2);
    expect(title()).toBe("This fire · detail");
    expect(names()).toEqual(["Active fires", "Fire arrival"]);
    expect(map.vis["scars-dot"]).toBe("none"); // overview-only, hidden at L2
    expect(map.vis["arrival-x"]).toBe("none"); // in level but toggle default off
    expect(map.vis["fires-major"]).toBe("visible"); // shared, still on
  });

  it("returning to level 1 restores the overview set", () => {
    const { sw, map, names } = mount();
    sw.setLevel(2);
    sw.setLevel(1);
    expect(names()).toEqual(["Active fires", "Burn scars"]);
    expect(map.vis["scars-dot"]).toBe("visible");
    expect(map.vis["arrival-x"]).toBe("none");
  });
});

// A historical fire (a settled past scar, or a closed live fire) has no
// current-moment data at its location — no live FRP, no fresh satellite
// pass, no live wind sample tied to it. Layers that only ever show
// current-moment data regardless of which fire is open (liveOnly) must stay
// hidden there, even when their own toggle is on, or they show nothing
// meaningful and the reader can't tell why.
const LIVE_ONLY_MODULES: LayerModule[] = [
  ...MODULES,
  {
    key: "wind", label: "Wind", question: "q", layerIds: ["wind-arrows"],
    defaultOn: true, levels: [2], liveOnly: true,
  },
];

function mountLiveOnly() {
  document.body.innerHTML = '<div id="l"></div><div id="lg"></div>';
  const L = document.getElementById("l")!;
  const map = stubMap();
  const sw = mountSwitcher(L, document.getElementById("lg")!, LIVE_ONLY_MODULES, map as never);
  const names = () => [...L.querySelectorAll(".layer-name")].map((x) => x.textContent);
  return { sw, map, names };
}

describe("liveOnly layers on a historical fire", () => {
  it("stays visible at level 2 for a live (non-historical) fire", () => {
    const { sw, map, names } = mountLiveOnly();
    sw.setLevel(2);
    expect(names()).toContain("Wind");
    expect(map.vis["wind-arrows"]).toBe("visible");
  });

  it("is force-hidden at level 2 for a historical fire, toggle or no", () => {
    const { sw, map, names } = mountLiveOnly();
    sw.setLevel(2, { historical: true });
    expect(names()).not.toContain("Wind");
    expect(map.vis["wind-arrows"]).toBe("none");
  });

  it("reappears once the reader leaves the historical fire for a live one", () => {
    const { sw, map, names } = mountLiveOnly();
    sw.setLevel(2, { historical: true });
    sw.setLevel(2, { historical: false });
    expect(names()).toContain("Wind");
    expect(map.vis["wind-arrows"]).toBe("visible");
  });
});
