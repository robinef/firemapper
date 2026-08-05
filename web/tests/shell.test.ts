/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNav } from "../src/nav";
import { createShell } from "../src/shell";
import { renderFrpPanel } from "../src/panel";
import { fakeHistory, mountShellDom } from "./nav_fixtures";
import { emitUi } from "../src/ui_events";

function setup() {
  mountShellDom();
  const { history, target } = fakeHistory();
  const nav = createNav({ history, target });
  const shell = createShell({ nav });
  return { nav, shell, view: document.getElementById("view")! };
}

/** What fireCardHtml actually renders, reduced to the two parts the shell
 *  reads: the `.fc-peek` strip it emits first, and the title it names the
 *  entry from. A fixture WITHOUT the strip is not a fire card — it is an
 *  cell picker or an FRP panel, and the shell must size it differently. */
function fireCardPanel(name: string): void {
  const panel = document.getElementById("panel")!;
  panel.innerHTML =
    `<div class="fc-peek"><b>${name}</b></div><div class="fc-title">${name}</div>`;
  panel.classList.remove("hidden");
}

describe("shell view switching", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("starts on the map with no back bar", () => {
    const { view } = setup();
    expect(view.dataset.view).toBe("map");
    expect(document.getElementById("view-bar")!.innerHTML).toBe("");
  });

  it("reflects the top entry's view in data-view", () => {
    const { nav, view } = setup();
    nav.push({ view: "layers", title: "Layers" });
    expect(view.dataset.view).toBe("layers");
  });

  it("returns to map on back", () => {
    const { nav, view } = setup();
    nav.push({ view: "layers", title: "Layers" });
    nav.back();
    expect(view.dataset.view).toBe("map");
  });

  it("labels the back bar with the entry BENEATH the current one", () => {
    const { nav } = setup();
    nav.push({ view: "detail", title: "Pedrógão" });
    expect(document.querySelector(".view-back")!.textContent).toContain("Map");
  });

  it("shows the fire's name on compare's bar, not 'Map'", () => {
    const { nav } = setup();
    nav.push({ view: "detail", title: "Pedrógão" });
    nav.push({ view: "compare", title: "Compare" });
    const back = document.querySelector(".view-back")!;
    expect(back.textContent).toContain("Pedrógão");
    expect(back.textContent).not.toContain("Map");
  });

  it("back bar navigates one level", () => {
    const { nav, view } = setup();
    nav.push({ view: "detail", title: "Pedrógão" });
    document.querySelector<HTMLButtonElement>(".view-back")!.click();
    expect(view.dataset.view).toBe("map");
  });

  it("compare gets a close control that resets to the map in one action", () => {
    const { nav, view } = setup();
    nav.push({ view: "search", title: "Search" });
    nav.push({ view: "detail", title: "Pedrógão" });
    nav.push({ view: "compare", title: "Compare" });
    document.querySelector<HTMLButtonElement>(".view-close")!.click();
    expect(view.dataset.view).toBe("map");
  });

  it("gives no close control to views other than compare", () => {
    const { nav } = setup();
    nav.push({ view: "detail", title: "Pedrógão" });
    expect(document.querySelector(".view-close")).toBeNull();
  });

  it("reveals the rail once ready() is called, not before", () => {
    const { shell } = setup();
    const rail = document.getElementById("rail")!;
    expect(rail.classList.contains("hidden")).toBe(true);
    shell.ready();
    expect(rail.classList.contains("hidden")).toBe(false);
  });

  it("mirrors the current view onto <body> for out-of-container CSS", () => {
    const { nav } = setup();
    // #rail and #view-chip live OUTSIDE #view: #rail before it, where no
    // sibling combinator can reach it, and #view-chip after it, where one
    // could — but only until the markup is reordered. Rules for both key off
    // body instead, and this is what keeps that contract honest.
    nav.push({ view: "layers", title: "Layers" });
    expect(document.body.dataset.view).toBe("layers");
    nav.back();
    expect(document.body.dataset.view).toBe("map");
  });

  it("renders compare's bar outside #view, which compare hides", () => {
    const { nav } = setup();
    nav.push({ view: "detail", title: "Pedrógão" });
    nav.push({ view: "compare", title: "Compare" });
    expect(document.querySelector("#compare-bar .view-back")).not.toBeNull();
    expect(document.querySelector("#view-bar .view-back")).toBeNull();
  });

  it("clears the compare bar on the way out", () => {
    const { nav } = setup();
    nav.push({ view: "detail", title: "Pedrógão" });
    nav.push({ view: "compare", title: "Compare" });
    nav.back();
    expect(document.getElementById("compare-bar")!.innerHTML).toBe("");
    expect(document.querySelector("#view-bar .view-back")).not.toBeNull();
  });
});

describe("shell ↔ ui_events wiring", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const card = fireCardPanel;

  it("pushes detail from the map and takes the title from the rendered card", () => {
    const { nav } = setup();
    card("Pedrógão");
    emitUi("detail:open");
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "detail"]);
    expect(nav.top.title).toBe("Pedrógão");
  });

  it("falls back to a generic title when the card has no name", () => {
    const { nav } = setup();
    emitUi("detail:open");
    expect(nav.top.title).toBe("Fire");
  });

  it("replaces rather than pushes when detail is already top (fire → fire)", () => {
    const { nav } = setup();
    card("Pedrógão");
    emitUi("detail:open");
    card("Monchique");
    emitUi("detail:open");
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "detail"]);
    expect(nav.top.title).toBe("Monchique");
  });

  it("replaces on a second panel over an open card", () => {
    const { nav } = setup();
    card("Pedrógão");
    emitUi("detail:open");
    emitUi("detail:open");
    expect(nav.stack).toHaveLength(2);
  });

  it("replaces when layers is top (desktop: map is clickable beside the panel)", () => {
    const { nav } = setup();
    nav.push({ view: "layers", title: "Layers" });
    card("Pedrógão");
    emitUi("detail:open");
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "detail"]);
  });

  it("pushes when search is top, so back returns to the results", () => {
    const { nav } = setup();
    nav.push({ view: "search", title: "Search" });
    card("Pedrógão");
    emitUi("detail:open");
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "search", "detail"]);
  });

  it("pushes compare on compare:enter", () => {
    const { nav } = setup();
    card("Pedrógão");
    emitUi("detail:open");
    emitUi("compare:enter");
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "detail", "compare"]);
  });

  it("marks the body in compare mode and clears it on exit", () => {
    const { nav } = setup();
    card("Pedrógão");
    emitUi("detail:open");
    emitUi("compare:enter");
    expect(document.body.classList.contains("compare-mode")).toBe(true);
    nav.back();
    expect(document.body.classList.contains("compare-mode")).toBe(false);
  });

  it("detail:close from a view's own teardown pops exactly one level", () => {
    const { nav } = setup();
    card("Pedrógão");
    emitUi("detail:open");
    emitUi("detail:close");
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]);
  });

  it("ignores detail:close raised by nav's own unwinding (no double pop)", () => {
    const { nav } = setup();
    // Assert on the CALL, not the resulting stack: nav.back() itself no-ops
    // while unwinding, so the stack shape is identical whether or not the
    // shell guards. Only the call count can tell the two apart — and the
    // shell's guard exists so the shell does not lean on nav's.
    const backSpy = vi.spyOn(nav, "back");
    nav.onExit("detail", () => emitUi("detail:close")); // what firecard.close does
    nav.push({ view: "search", title: "Search" });
    document.getElementById("panel")!.innerHTML = `<div class="fc-title">Pedrógão</div>`;
    emitUi("detail:open");
    backSpy.mockClear();

    nav.back(); // the one deliberate call

    expect(backSpy).toHaveBeenCalledTimes(1); // the re-entrant emit must add none
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "search"]);
  });

  it("Escape navigates back one level", () => {
    const { nav } = setup();
    nav.push({ view: "layers", title: "Layers" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]);
  });
});

describe("icon rail", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  function setupWithDeps() {
    mountShellDom();
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    const calls: string[] = [];
    const shell = createShell({
      nav,
      showFireList: (q) => calls.push(`list:${q}`),
      lastQuery: () => "porto",
      infoContent: () => "<p>sources</p>",
    });
    return { nav, shell, calls };
  }
  it("⚙ pushes the layers view", () => {
    const { nav } = setupWithDeps();
    document.getElementById("rail-layers")!.click();
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "layers"]);
    expect(nav.top.title).toBe("Layers");
  });
  it("🔍 pushes search and renders an empty list", () => {
    const { nav, calls } = setupWithDeps();
    document.getElementById("rail-search")!.click();
    expect(nav.top.view).toBe("search");
    expect(calls).toEqual(["list:"]);
  });
  it("search restores its last query when it becomes top again", () => {
    const { nav, calls } = setupWithDeps();
    document.getElementById("rail-search")!.click();
    nav.push({ view: "detail", title: "Pedrógão" });
    nav.back();
    expect(calls).toEqual(["list:", "list:porto"]);
  });
  it("ℹ pushes info and fills #info", () => {
    const { nav } = setupWithDeps();
    document.getElementById("rail-info")!.click();
    expect(nav.top.view).toBe("info");
    expect(document.getElementById("info")!.innerHTML).toBe("<p>sources</p>");
  });
  it("tapping ⚙ twice does not stack two layers entries", () => {
    const { nav } = setupWithDeps();
    document.getElementById("rail-layers")!.click();
    document.getElementById("rail-layers")!.click();
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "layers"]);
  });
});

describe("camera padding", () => {
  // setupWithMap overwrites window.matchMedia, and three describe blocks run
  // after this one. Capture the original (jsdom leaves it undefined) and put
  // it back, so a later test cannot silently inherit a stubbed breakpoint.
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = realMatchMedia;
  });

  function setupWithMap(width: number) {
    mountShellDom();
    const pads: Array<{ left: number }> = [];
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    const media = {
      matches: width <= 640,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
        media.fire = fn;
      },
      removeEventListener: () => {},
      fire: (_: { matches: boolean }) => {},
    };
    (window as unknown as { matchMedia: () => unknown }).matchMedia = () => media;
    const shell = createShell({
      nav,
      map: { setPadding: (p) => pads.push({ left: p.left }) },
    });
    return { nav, shell, pads, media };
  }

  it("pads left of the slide-out on desktop when a view opens", () => {
    const { nav, pads } = setupWithMap(1280);
    nav.push({ view: "layers", title: "Layers" });
    expect(pads.at(-1)).toEqual({ left: 376 });
  });

  it("clears the padding when the view closes", () => {
    const { nav, pads } = setupWithMap(1280);
    nav.push({ view: "layers", title: "Layers" });
    nav.back();
    expect(pads.at(-1)).toEqual({ left: 0 });
  });

  it("never pads on mobile — the overlay covers the map", () => {
    const { nav, pads } = setupWithMap(375);
    nav.push({ view: "layers", title: "Layers" });
    expect(pads.at(-1)).toEqual({ left: 0 });
  });

  it("never pads for compare, which owns the whole map", () => {
    const { nav, pads } = setupWithMap(1280);
    nav.push({ view: "detail", title: "Pedrógão" });
    nav.push({ view: "compare", title: "Compare" });
    expect(pads.at(-1)).toEqual({ left: 0 });
  });

  it("recomputes when the viewport crosses the breakpoint with a view open", () => {
    const { nav, pads, media } = setupWithMap(1280);
    nav.push({ view: "layers", title: "Layers" });
    expect(pads.at(-1)).toEqual({ left: 376 });
    media.fire({ matches: true }); // dragged down to a phone width
    expect(pads.at(-1)).toEqual({ left: 0 });
    media.fire({ matches: false }); // and back up
    expect(pads.at(-1)).toEqual({ left: 376 });
  });
});

describe("detail sizing", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens a fire card peeked", () => {
    const { nav, view } = setup();
    fireCardPanel("Pedrógão");
    emitUi("detail:open");
    expect(view.dataset.size).toBe("peek");
    expect(document.body.dataset.size).toBe("peek"); // what #rail/#view-chip key off
    expect(nav.top.view).toBe("detail");
  });

  it("expands to full when the peek strip is tapped", () => {
    const { view } = setup();
    fireCardPanel("Pedrógão");
    emitUi("detail:open");
    document.querySelector<HTMLElement>(".fc-peek")!.click();
    expect(view.dataset.size).toBe("full");
    expect(document.body.dataset.size).toBe("full");
  });

  it("restores the size it had when returning from another view", () => {
    const { nav, view } = setup();
    fireCardPanel("Pedrógão");
    emitUi("detail:open");
    document.querySelector<HTMLElement>(".fc-peek")!.click();
    expect(view.dataset.size).toBe("full");
    nav.push({ view: "layers", title: "Layers" });
    nav.back();
    expect(view.dataset.size).toBe("full");
    expect(document.body.dataset.size).toBe("full");
  });

  it("drops data-size entirely for views that have no sizes", () => {
    const { nav, view } = setup();
    fireCardPanel("Pedrógão");
    emitUi("detail:open");
    nav.push({ view: "compare", title: "Compare" });
    expect(view.dataset.size).toBeUndefined();
    expect(document.body.dataset.size).toBeUndefined(); // cleared, not merely stale
  });

  // The peek layout hides the back bar and every #panel child except
  // `.fc-peek`. A panel that renders no strip therefore has NOTHING left to
  // show: on a phone it becomes a blank 56px band with no ✕, no back bar and
  // nothing tappable to expand it — the panel is unreadable and unclosable.
  // Only fireCardHtml and scarCardHtml emit a strip, so every other renderer
  // must open full.
  it("opens an FRP panel full — it renders no peek strip to survive on", () => {
    const { nav, view } = setup();
    const panel = document.getElementById("panel")!;
    // The real renderer, not a fixture: the whole point is that its output
    // has no `.fc-peek`, and a hand-written stand-in could quietly gain one.
    // This was renderAircraftPanel until that layer was retired; renderFrpPanel
    // is the same shape of no-strip panel and keeps the premise honest.
    panel.innerHTML = renderFrpPanel({
      frp_mw: 42,
      satellite: "VIIRS",
      acq_time: null,
    });
    panel.classList.remove("hidden");
    expect(panel.querySelector(".fc-peek")).toBeNull(); // the premise

    emitUi("detail:open");

    expect(nav.top.view).toBe("detail");
    expect(view.dataset.size).toBe("full");
    expect(document.body.dataset.size).toBe("full");
  });

  it("opens a cell picker full — it renders no peek strip either", () => {
    const { view } = setup();
    const panel = document.getElementById("panel")!;
    // renderCellPicker's shape (both its branches): a close button and a
    // title, and no strip.
    panel.innerHTML =
      `<button class="panel-close" aria-label="Close">&times;</button>` +
      `<div class="fc-title">3 fires here</div>` +
      `<div class="cell-picks"></div>`;
    panel.classList.remove("hidden");

    emitUi("detail:open");

    expect(view.dataset.size).toBe("full");
  });

  it("re-sizes per panel, so a plain panel after a fire card does not stay peeked", () => {
    const { view } = setup();
    fireCardPanel("Pedrógão");
    emitUi("detail:open");
    expect(view.dataset.size).toBe("peek");

    // Same #panel, replaced in place — exactly what a tap on a hex with
    // several fires does while a fire card is open.
    document.getElementById("panel")!.innerHTML =
      `<button class="panel-close">×</button><div class="fc-title">3 fires here</div>`;
    emitUi("detail:open");

    expect(view.dataset.size).toBe("full");
    expect(document.body.dataset.size).toBe("full");
  });
});

describe("level-2 toggles from a peeked card", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("⚙ over a peeked card opens layers and back returns to the peeked card", () => {
    const { nav, view } = setup();
    fireCardPanel("Pedrógão");
    emitUi("detail:open");
    expect(view.dataset.size).toBe("peek");
    expect(document.body.dataset.size).toBe("peek"); // what #rail keys off

    document.getElementById("rail-layers")!.click();
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "detail", "layers"]);

    nav.back();
    expect(nav.top.view).toBe("detail");
    expect(view.dataset.size).toBe("peek");
    expect(document.body.dataset.size).toBe("peek"); // what #rail keys off
  });
});

describe("--timebar measurement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // documentElement isn't reset by clearing <body>, and a value written by
    // one test would otherwise leak into the next.
    document.documentElement.style.removeProperty("--timebar");
  });

  it("publishes #timeline's measured height (+12px) onto --timebar on a view change", () => {
    // Construct with the real (0-height) jsdom box first, so the only way
    // 176px can appear below is via the sync() call this test triggers —
    // not the one-off measurement taken during construction.
    const { nav } = setup();
    expect(document.documentElement.style.getPropertyValue("--timebar")).toBe("");

    const timeline = document.getElementById("timeline")!;
    timeline.getBoundingClientRect = () =>
      ({ height: 164, width: 0, top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    nav.push({ view: "layers", title: "Layers" }); // a view change must re-measure

    expect(document.documentElement.style.getPropertyValue("--timebar")).toBe("176px");
  });

  it("leaves the CSS fallback alone when #timeline measures 0 (jsdom's default)", () => {
    const { nav } = setup(); // #timeline's real getBoundingClientRect, unstubbed — jsdom reports 0

    nav.push({ view: "layers", title: "Layers" });

    expect(document.documentElement.style.getPropertyValue("--timebar")).toBe("");
  });
});
