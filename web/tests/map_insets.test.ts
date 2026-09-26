/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it (see ui_events_wiring.test.ts's note on the same line).
window.URL.createObjectURL ??= () => "";

const { chromeInsets, visibleCentreOffset } = await import("../src/map");

type Rect = { left: number; top: number; width: number; height: number };

/** Lay out the chrome by hand: jsdom computes no boxes of its own. */
function layout(vw: number, vh: number, boxes: Record<string, Rect>) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: vw });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: vh });
  document.body.innerHTML = "";
  for (const [id, r] of Object.entries(boxes)) {
    const el = document.createElement("div");
    el.id = id;
    el.getBoundingClientRect = () =>
      ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height,
        toJSON: () => r }) as DOMRect;
    document.body.appendChild(el);
  }
}

afterEach(() => (document.body.innerHTML = ""));

describe("chromeInsets / visibleCentreOffset", () => {
  it("a phone held sideways: the fire lands above the time bar and right of the card", () => {
    // Measured from an iPhone 13 in landscape (844x390): the time bar starts
    // at y=166, so the canvas centre (y=195) was under it.
    layout(844, 390, {
      header: { left: 212, top: 12, width: 326, height: 36 },
      timeline: { left: 80, top: 166, width: 752, height: 212 },
      rail: { left: 12, top: 12, width: 44, height: 250 },
      view: { left: 80, top: 12, width: 296, height: 140 },
    });
    expect(chromeInsets()).toEqual({ top: 48, bottom: 224, left: 376, right: 0 });
    const [dx, dy] = visibleCentreOffset();
    const x = 844 / 2 + dx;
    const y = 390 / 2 + dy;
    expect(x).toBeGreaterThan(376); // clear of the card
    expect(y).toBeGreaterThan(48); // below the header
    expect(y).toBeLessThan(166); // above the time bar
  });

  it("a portrait phone: only the header and time bar count, so both flights agree", () => {
    // Search flies while the full-page list hides the rail; the card flies
    // again once the peek strip is up and the rail row raised. Counting either
    // would move the second target and hop the camera.
    const base = {
      header: { left: 15, top: 12, width: 345, height: 33 },
      timeline: { left: 12, top: 488, width: 366, height: 164 },
    };
    layout(390, 664, { ...base, view: { left: 0, top: 0, width: 390, height: 664 } });
    const searching = visibleCentreOffset();
    layout(390, 664, {
      ...base,
      rail: { left: 146, top: 376, width: 244, height: 44 },
      view: { left: 12, top: 432, width: 366, height: 56 },
    });
    expect(visibleCentreOffset()).toEqual(searching);
    expect(searching).toEqual([0, (45 - 176) / 2]);
  });

  it("no chrome (jsdom, or before boot) means no offset", () => {
    layout(1280, 800, {});
    expect(visibleCentreOffset()).toEqual([0, 0]);
  });

  it("gives up on an axis the chrome all but fills, rather than aim at a sliver", () => {
    layout(844, 200, {
      header: { left: 0, top: 0, width: 300, height: 60 },
      timeline: { left: 0, top: 80, width: 844, height: 120 },
    });
    const i = chromeInsets();
    expect(i.top).toBe(0);
    expect(i.bottom).toBe(0);
  });
});
