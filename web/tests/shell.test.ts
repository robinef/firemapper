/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNav } from "../src/nav";
import { createShell } from "../src/shell";
import { fakeHistory, mountShellDom } from "./nav_fixtures";
import { emitUi } from "../src/ui_events";

function setup() {
  mountShellDom();
  const { history, target } = fakeHistory();
  const nav = createNav({ history, target });
  const shell = createShell({ nav });
  return { nav, shell, view: document.getElementById("view")! };
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
    // #rail and #view-chip live OUTSIDE #view and precede it in the document,
    // so no sibling combinator can reach them from #view. Rules for those two
    // key off body instead, and this is what keeps that contract honest.
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

  const card = (name: string) => {
    document.getElementById("panel")!.innerHTML = `<div class="fc-title">${name}</div>`;
    document.getElementById("panel")!.classList.remove("hidden");
  };

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

  it("replaces on aircraft over an open card", () => {
    const { nav } = setup();
    card("Pedrógão");
    emitUi("detail:open");
    emitUi("aircraft:open");
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
