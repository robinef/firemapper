/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { createNav } from "../src/nav";
import { createShell } from "../src/shell";
import { fakeHistory, mountShellDom } from "./nav_fixtures";

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
