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

  it("calls a module's onToggle with the new state after the checkbox changes", () => {
    document.body.innerHTML = '<div id="l"></div><div id="lg"></div>';
    const L = document.getElementById("l")!;
    const seen: { on: boolean; vis: string | undefined }[] = [];
    const map = stubMap();
    const modules: LayerModule[] = [
      { key: "season", label: "Burned this year", question: "q", layerIds: ["season-heat"], defaultOn: true, levels: [1],
        onToggle: (on) => seen.push({ on, vis: map.vis["season-heat"] }) },
    ];
    mountSwitcher(L, document.getElementById("lg")!, modules, map as never);
    const cb = L.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    // Visibility is already applied when the hook runs: off → "none", on → "visible".
    expect(seen).toEqual([{ on: false, vis: "none" }, { on: true, vis: "visible" }]);
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

describe("LayerModule.control hook", () => {
  it("renders a module's control under its row on every render while on, never while off", () => {
    document.body.innerHTML = '<div id="l"></div><div id="lg"></div>';
    const L = document.getElementById("l")!;
    const containers: HTMLElement[] = [];
    const modules: LayerModule[] = [
      { key: "season", label: "Burned this year", question: "q", layerIds: ["season-heat"], defaultOn: true, levels: [1],
        control: (el) => { containers.push(el); el.textContent = "ctl"; } },
    ];
    const sw = mountSwitcher(L, document.getElementById("lg")!, modules, stubMap() as never);
    expect(containers).toHaveLength(1);
    expect(containers[0].className).toBe("layer-control");
    expect(L.querySelector(".layer-control")?.textContent).toBe("ctl");
    // The control sits directly after its row.
    expect(L.querySelector(".layer-row")?.nextElementSibling?.className).toBe("layer-control");
    sw.refresh();
    expect(containers).toHaveLength(2);
    const cb = L.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
    sw.refresh();
    expect(L.querySelector(".layer-control")).toBeNull();
    expect(containers).toHaveLength(2);
  });
});

// The season slider triggers an aggregation that wants to update the row's
// count. Doing that with refresh() replaces the panel — and with it the range
// input the reader is holding — so an arrow key lands on <body> and a paused
// drag loses pointer capture. refreshStatus rewrites the count and nothing else.
describe("Switcher.refreshStatus", () => {
  function mountSeason(status: () => string | null) {
    document.body.innerHTML = '<div id="l"></div><div id="lg"></div>';
    const L = document.getElementById("l")!;
    const modules: LayerModule[] = [
      {
        key: "season", label: "Burned this year", question: "q",
        layerIds: ["season-heat"], defaultOn: true, levels: [1],
        status,
        control: (el) => { el.innerHTML = '<input class="season-range" type="range">'; },
      },
    ];
    const sw = mountSwitcher(L, document.getElementById("lg")!, modules, stubMap() as never);
    return { sw, L, count: () => L.querySelector(".layer-count")?.textContent ?? null };
  }

  it("updates the row's count in place when status() starts returning something new", () => {
    let text = "21,822 fires · 60,800 km²";
    const { sw, count } = mountSeason(() => text);
    expect(count()).toBe("21,822 fires · 60,800 km²");
    text = "4,422 fires · 32,533 km²";
    sw.refreshStatus("season");
    expect(count()).toBe("4,422 fires · 32,533 km²");
  });

  it("keeps the control and the input inside it as the SAME nodes", () => {
    let text = "a";
    const { sw, L } = mountSeason(() => text);
    const controlBefore = L.querySelector(".layer-control")!;
    const inputBefore = L.querySelector<HTMLInputElement>(".season-range")!;
    text = "b";
    sw.refreshStatus("season");
    // toBe, not toEqual: node identity is the whole point — a replaced input
    // is a lost focus and a lost drag, however identical it looks.
    expect(L.querySelector(".layer-control")).toBe(controlBefore);
    expect(L.querySelector(".season-range")).toBe(inputBefore);
    expect(document.contains(inputBefore)).toBe(true);
  });

  it("holds keyboard focus on the control across a status update", () => {
    const { sw, L } = mountSeason(() => "a");
    const input = L.querySelector<HTMLInputElement>(".season-range")!;
    input.focus();
    expect(document.activeElement).toBe(input);
    sw.refreshStatus("season");
    expect(document.activeElement).toBe(input);
  });

  it("leaves an off module's row without a count", () => {
    const { sw, L, count } = mountSeason(() => "still counting");
    const cb = L.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
    sw.refreshStatus("season");
    expect(count()).toBeNull();
  });

  it("adds a count to a row that had none when status() was null", () => {
    let text: string | null = null;
    const { sw, count } = mountSeason(() => text);
    expect(count()).toBeNull();
    text = "now there is one";
    sw.refreshStatus("season");
    expect(count()).toBe("now there is one");
  });

  it("is a no-op for an unknown key", () => {
    const { sw, count } = mountSeason(() => "a");
    expect(() => sw.refreshStatus("nope")).not.toThrow();
    expect(count()).toBe("a");
  });
});
