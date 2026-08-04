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
    expect(c).toEqual({ inView: 54, shown: 1, zoomToSeeAll: 8.5 });
    expect(countLabel(c)).toBe("1 of 54 in view · zoom in for the rest");
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

  it("reports the LOWEST zoom that reveals everything hidden", () => {
    // medium (z6) and minor (z8.5) both hidden at z5: the honest answer is the
    // deeper of the two, or the reader zooms once and is still missing fires.
    const fires = [fire(0, 44, "medium"), fire(1, 44, "minor")];
    expect(countFires(fires, EUROPE, 5).zoomToSeeAll).toBe(8.5);
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

  it("handles a viewport across the antimeridian", () => {
    const wrapped = { west: 170, south: 35, east: -170, north: 60 };
    expect(countFires([fire(175, 44, "major"), fire(0, 44, "major")], wrapped, 5).inView).toBe(1);
  });

  it("treats an unknown size class as the most-gated one", () => {
    // A future class must not be silently counted as visible.
    const c = countFires([fire(0, 44, "enormous")], EUROPE, 7);
    expect(c.shown).toBe(0);
  });
});
