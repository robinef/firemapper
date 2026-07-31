/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { createSheet, projectDetent } from "../src/sheet";
import { emitUi } from "../src/ui_events";

const HEIGHTS = { peek: 100, half: 400, full: 700 };

function mobileDom() {
  document.body.innerHTML = `
    <div id="map"></div>
    <aside id="sidebar"><div id="layers"></div><div id="notice"></div><div id="legend"></div></aside>
    <div id="panel" class="hidden"></div>
    <div id="timeline"></div>`;
}

describe("projectDetent", () => {
  it("snaps to the nearest detent when the drag is slow", () => {
    expect(projectDetent(380, 0, HEIGHTS)).toBe("half");
    expect(projectDetent(120, 0.1, HEIGHTS)).toBe("peek");
  });

  it("carries to the next detent on a fast flick", () => {
    // released near peek but flicking upward hard (positive = growing height)
    expect(projectDetent(150, 2.0, HEIGHTS)).toBe("half");
  });

  it("a fast downward flick collapses", () => {
    expect(projectDetent(390, -2.0, HEIGHTS)).toBe("peek");
  });

  it("ignores velocity below the threshold", () => {
    expect(projectDetent(390, 0.4, HEIGHTS)).toBe("half");
  });
});

describe("sheet", () => {
  beforeEach(() => mobileDom());

  it("re-parents the three panels on mount", () => {
    const sheet = createSheet(640);
    sheet.mount();
    const container = document.querySelector(".sheet")!;
    expect(container.contains(document.getElementById("sidebar"))).toBe(true);
    expect(container.contains(document.getElementById("panel"))).toBe(true);
    expect(container.contains(document.getElementById("timeline"))).toBe(true);
  });

  it("restores the original parents on destroy", () => {
    const sheet = createSheet(640);
    sheet.mount();
    sheet.destroy();
    expect(document.querySelector(".sheet")).toBeNull();
    expect(document.getElementById("sidebar")!.parentElement).toBe(document.body);
    expect(document.getElementById("timeline")!.parentElement).toBe(document.body);
    // children survived the round trip
    expect(document.getElementById("layers")).not.toBeNull();
    expect(document.getElementById("legend")).not.toBeNull();
  });

  it("switches to detail mode when a fire opens, and back on close", () => {
    const sheet = createSheet(640);
    sheet.mount();
    emitUi("detail:open");
    expect(sheet.mode).toBe("detail");
    expect(sheet.detent).toBe("half");
    emitUi("detail:close");
    expect(sheet.mode).toBe("overview");
    expect(sheet.detent).toBe("peek");
  });

  it("treats an aircraft tap as its own mode", () => {
    const sheet = createSheet(640);
    sheet.mount();
    emitUi("aircraft:open");
    expect(sheet.mode).toBe("aircraft");
  });

  it("collapses to peek while comparing and restores afterwards", () => {
    const sheet = createSheet(640);
    sheet.mount();
    sheet.snapTo("full");
    emitUi("compare:enter");
    expect(sheet.detent).toBe("peek");
    emitUi("compare:exit");
    expect(sheet.detent).toBe("full");
  });

  it("keeps the timeline out of mode-specific content", () => {
    const sheet = createSheet(640);
    sheet.mount();
    const slot = document.getElementById("timeline")!.parentElement;
    emitUi("detail:open");
    expect(document.getElementById("timeline")!.parentElement).toBe(slot);
  });
});
