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

  it("mounts below the breakpoint and unmounts above it", () => {
    mobileDom();
    const listeners: Array<(e: { matches: boolean }) => void> = [];
    // jsdom has no matchMedia; provide one whose matches we control
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
      matches: true,
      media: q,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
      removeEventListener: () => {},
    });

    const sheet = createSheet(640);
    sheet.mount();
    expect(document.querySelector(".sheet")).not.toBeNull();

    listeners.forEach((fn) => fn({ matches: false })); // viewport grew past 640
    expect(document.querySelector(".sheet")).toBeNull();
    expect(document.getElementById("sidebar")!.parentElement).toBe(document.body);
  });

  it("drags the handle, ignores a second pointer, and snaps on a fast flick", () => {
    const sheet = createSheet(640);
    sheet.mount();
    const handle = document.querySelector(".sheet-handle") as HTMLElement;
    handle.setPointerCapture = () => undefined;
    handle.releasePointerCapture = () => undefined;

    const dispatch = (target: EventTarget, type: string, id: number, y: number, t: number) => {
      const e = new PointerEvent(type, { pointerId: id, clientY: y, bubbles: true });
      Object.defineProperty(e, "timeStamp", { value: t });
      target.dispatchEvent(e);
    };

    dispatch(handle, "pointerdown", 1, 500, 0);
    // a second finger lands mid-drag; it must not steal the gesture (jsdom
    // getBoundingClientRect() is always 0, so startHeight is 0 and the moved
    // distance becomes the sheet's new height directly)
    dispatch(handle, "pointerdown", 2, 100, 4);
    dispatch(window, "pointermove", 1, 400, 16); // 100px up in 16ms: a hard flick
    dispatch(window, "pointerup", 1, 400, 32);

    // height landed at 100px, but the flick's projected position lands next
    // to "full" — the drag traveled, it did not just snap to where it started
    expect(sheet.detent).toBe("full");
  });

  // Regression for the real-browser-only lockup: setPointerCapture/
  // releasePointerCapture can throw NotFoundError when the browser's
  // internal pointer-id tracking doesn't recognise the id as currently
  // active (a real, documented cross-browser Pointer Events quirk). jsdom's
  // no-op stubs above never exercise this path, so this test forces exactly
  // one throw from each — matching a genuine first-drag failure — and
  // asserts a SECOND, independent drag still completes. Before the fix, an
  // uncaught throw from either call left activePointerId stuck non-null
  // forever, and the `if (activePointerId !== null) return;` guard in
  // pointerdown silently rejected every subsequent drag for the rest of the
  // page's life.
  it("recovers from a NotFoundError on pointer capture so the next drag still works", () => {
    const sheet = createSheet(640);
    sheet.mount();
    const handle = document.querySelector(".sheet-handle") as HTMLElement;

    let setCalls = 0;
    let releaseCalls = 0;
    handle.setPointerCapture = () => {
      setCalls++;
      if (setCalls === 1) throw new DOMException("no active pointer", "NotFoundError");
    };
    handle.releasePointerCapture = () => {
      releaseCalls++;
      if (releaseCalls === 1) throw new DOMException("no active pointer", "NotFoundError");
    };

    const dispatch = (target: EventTarget, type: string, id: number, y: number, t: number) => {
      const e = new PointerEvent(type, { pointerId: id, clientY: y, bubbles: true });
      Object.defineProperty(e, "timeStamp", { value: t });
      target.dispatchEvent(e);
    };

    // First drag: both capture calls throw. Must not leave the handle stuck.
    dispatch(handle, "pointerdown", 1, 500, 0);
    dispatch(window, "pointermove", 1, 400, 16);
    dispatch(window, "pointerup", 1, 400, 32);
    expect(sheet.detent).toBe("full");

    // Second, independent drag with fresh pointer capture calls (no longer
    // throwing) — only possible if activePointerId was reset after the first.
    dispatch(handle, "pointerdown", 2, 700, 100);
    dispatch(window, "pointermove", 2, 750, 116);
    dispatch(window, "pointerup", 2, 750, 132);
    expect(sheet.detent).toBe("peek");
    expect(setCalls).toBe(2);
    expect(releaseCalls).toBe(2);
  });
});
