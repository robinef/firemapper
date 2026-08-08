import { describe, expect, it } from "vitest";

import { eventPosition } from "../src/fire_readout";

describe("eventPosition", () => {
  it("takes the feature's own point geometry", () => {
    const feat = { type: "Feature", geometry: { type: "Point", coordinates: [18.35, 42.71] }, properties: {} };
    expect(eventPosition(feat as never)).toEqual([18.35, 42.71]);
  });

  it("returns null for a polygon, rather than guessing a centroid", () => {
    const poly = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
      properties: {},
    };
    expect(eventPosition(poly as never)).toBeNull();
  });

  it("returns null for a missing feature", () => {
    expect(eventPosition(null)).toBeNull();
    expect(eventPosition(undefined)).toBeNull();
  });

  it("returns null for malformed coordinates", () => {
    const bad = { type: "Feature", geometry: { type: "Point", coordinates: ["x", 42] }, properties: {} };
    expect(eventPosition(bad as never)).toBeNull();
  });
});
