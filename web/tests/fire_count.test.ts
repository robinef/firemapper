import { describe, expect, it } from "vitest";
import { CLASS_MINZOOM, countFires, countLabel } from "../src/fire_count";
import { CLASS_MINZOOM as LAYER_MINZOOM } from "../src/layer_fires";

/**
 * Reported 2026-08-04: "Active fires layer does not show anything when
 * checked." It was drawing correctly — 53 of the 54 live fires in that view
 * were `minor`, which is gated to z8.5, so a ticked layer produced an empty
 * map. Indistinguishable from broken, and the reason was nowhere on screen.
 */
function fire(lon: number, lat: number, size_class: string, status = "active") {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties: { size_class, status },
  };
}

const EUROPE = { west: -10, south: 35, east: 30, north: 60 };

describe("counting what is actually drawn", () => {
  it("agrees with the zoom gates the fire layers really use", () => {
    // Two copies of this table would drift, and the count would then lie in
    // exactly the situation it exists to explain.
    expect(CLASS_MINZOOM).toEqual(LAYER_MINZOOM);
  });

  it("reports the gap that made the layer look broken", () => {
    // The reported view, to scale: 53 minor + 1 medium at ~z6.
    const fires = [
      ...Array.from({ length: 53 }, (_, i) => fire(0 + i * 0.01, 44, "minor")),
      fire(2, 44, "medium"),
    ];
    const c = countFires(fires, EUROPE, 6);
    expect(c).toEqual({ inView: 54, shown: 1, hidden: "below-gate" });
    expect(countLabel(c)).toBe('1 of 54 in view · zoom in, or tick “Show every size”');
  });

  it("goes quiet once the zoom draws everything", () => {
    const fires = [fire(0, 44, "minor"), fire(1, 44, "medium")];
    const c = countFires(fires, EUROPE, 9);
    expect(c.shown).toBe(c.inView);
    expect(countLabel(c)).toBe("2 in view");
  });

  it("says nothing at all when the view is genuinely empty", () => {
    expect(countLabel(countFires([], EUROPE, 5))).toBeNull();
  });

  it("counts only what is inside the viewport", () => {
    const fires = [fire(0, 44, "major"), fire(100, 44, "major")];
    expect(countFires(fires, EUROPE, 5).inView).toBe(1);
  });

  it("excludes closed fires — they are a separate, opt-in layer", () => {
    // Counting them under "Active fires" would swap one misleading number for
    // another: 5290 of the 8143 events in production are closed.
    const fires = [fire(0, 44, "minor"), fire(1, 44, "minor", "closed")];
    expect(countFires(fires, EUROPE, 9).inView).toBe(1);
  });

  it("counts quiet fires, which the active layer does draw", () => {
    // "stale" renders faded but present, so it must be in the total.
    const fires = [fire(0, 44, "minor", "stale")];
    expect(countFires(fires, EUROPE, 9).inView).toBe(1);
  });

  it("keeps counting fires above the handover, where each is dot or outline", () => {
    // This asserted 0 while the dot layers carried maxzoom 9.5 — which was
    // accurate then and was the bug: every fire stopped being drawn there, and
    // only the 38% with an outline were still on the map. The handover is now
    // per fire, so nothing in view goes unrepresented and the count says so.
    const fires = [fire(0, 44, "major"), fire(1, 44, "minor")];
    expect(countFires(fires, EUROPE, 9.4).shown).toBe(2);
    expect(countFires(fires, EUROPE, 9.5).shown).toBe(2);
    expect(countFires(fires, EUROPE, 10.5).shown).toBe(2);
    expect(countFires(fires, EUROPE, 10.5).inView).toBe(2);
  });

  it("counts everything as shown once the size gates are turned off", () => {
    // Verified in a browser: with the filter on, 101 dots rendered at z6 while
    // the counter still read "1 of 101". A counter that contradicts the map is
    // the same failure it was written to fix.
    const fires = Array.from({ length: 101 }, (_, i) => fire(i * 0.01, 44, "minor"));
    const c = countFires(fires, EUROPE, 6, true);
    expect(c.shown).toBe(101);
    expect(countLabel(c)).toBe("101 in view");
  });

  it("handles the unwrapped bounds MapLibre really returns past the antimeridian", () => {
    // getBounds() wraps the centre but not the corners, so panning past 180
    // gives {west:150, east:190} while feature longitudes stay in [-180,180].
    // A fire drawn at screen-longitude 185 has data longitude -175.
    const past = { west: 150, south: 35, east: 190, north: 60 };
    const c = countFires([fire(-175, 44, "major"), fire(0, 44, "major")], past, 5);
    expect(c.inView).toBe(1);
  });

  it("counts every copy once when the whole world is on screen", () => {
    const wide = { west: -260, south: -80, east: 260, north: 80 };
    expect(countFires([fire(0, 44, "major")], wide, 1).inView).toBe(1);
  });

  it("never counts an unknown size class as drawn, at any zoom", () => {
    // Layer filters are ["==", size_class, cls] over exactly major/medium/minor,
    // so an unrecognised class matches NO layer and is never rendered. The old
    // fallback to minor's gate claimed it was visible from z8.5 upwards.
    for (const zoom of [3, 7, 9]) {
      expect(countFires([fire(0, 44, "enormous")], EUROPE, zoom).shown, `z${zoom}`).toBe(0);
    }
    expect(countFires([fire(0, 44, "enormous")], EUROPE, 9, true).shown).toBe(0);
  });
  it("counts every fire as shown past the handover, dot or outline", () => {
    // The dots used to be cut off at 9.5 for EVERY fire, so shown fell to 0
    // and the label said "zoom in for the rest" — advice that caused the state
    // it described. Now a covered fire is represented by its outline and an
    // uncovered one keeps its dot, so nothing in view is missing.
    // A fire card flies to z10.5, so this is the normal path, not an edge.
    const fires = [fire(0, 44, "major"), fire(0.1, 44, "minor")];
    const c = countFires(fires, EUROPE, 10.5);
    expect(c.shown).toBe(2);
    expect(c.hidden).toBe("none");
    expect(countLabel(c)).toBe("2 in view");
    expect(countLabel(c)).not.toContain("zoom in");
  });

  it("stops subtracting exactly at the handover, not before it", () => {
    // minor's gate is 8.5, so at 8.4 it is genuinely undrawn and the reader
    // still needs telling. The boundary itself must not regress to a cutoff.
    const fires = [fire(0, 44, "major"), fire(0.1, 44, "minor")];
    expect(countFires(fires, EUROPE, 8.4).hidden).toBe("below-gate");
    expect(countFires(fires, EUROPE, 9.5).shown).toBe(2);
    expect(countFires(fires, EUROPE, 12).shown).toBe(2);
  });

  it("points at the size filter, not just at zooming, below the gates", () => {
    // 2860 of 3728 live fires were `minor` on 2026-08-05 — hidden until z8.5.
    // The filter is the faster way out and sits right under this line.
    const c = countFires([fire(0, 44, "major"), fire(0.1, 44, "minor")], EUROPE, 5);
    expect(countLabel(c)).toContain("Show every size");
  });

  it("says nothing extra when everything in view is drawn", () => {
    const c = countFires([fire(0, 44, "major")], EUROPE, 5);
    expect(c.hidden).toBe("none");
    expect(countLabel(c)).toBe("1 in view");
  });
});
