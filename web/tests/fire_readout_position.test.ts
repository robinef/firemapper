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

  it("rejects a non-Point geometry even when its coordinates look like a position", () => {
    // A bad upstream source can emit a type/coordinates mismatch. Without the
    // type check this destructures to two finite numbers and is accepted as a
    // fire's location.
    const malformed = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [18.35, 42.71] },
      properties: {},
    };
    expect(eventPosition(malformed as never)).toBeNull();
  });

  it("returns null when longitude is NaN", () => {
    const withNaN = { type: "Feature", geometry: { type: "Point", coordinates: [NaN, 42.71] }, properties: {} };
    expect(eventPosition(withNaN as never)).toBeNull();
  });

  it("returns null when latitude is Infinity", () => {
    const withInfinity = { type: "Feature", geometry: { type: "Point", coordinates: [18.35, Infinity] }, properties: {} };
    expect(eventPosition(withInfinity as never)).toBeNull();
  });
});
