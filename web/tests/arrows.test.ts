import { describe, expect, it } from "vitest";
import {
  SPEED_STOPS,
  buildArrowFeatures,
  destinationPoint,
  outlineFor,
  speedArrowExpression,
  speedArrowIconName,
  spreadKmh,
} from "../src/map";

function evt(id: string, lon: number, lat: number, movement: unknown) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties: { id, state: "growing", movement },
  };
}

describe("spread direction arrows", () => {
  it("projects due north correctly", () => {
    const [lon, lat] = destinationPoint(8, 45, 0, 10_000);
    expect(lon).toBeCloseTo(8, 3);
    expect(lat).toBeGreaterThan(45);
    expect(lat).toBeCloseTo(45.09, 1);
  });

  it("projects due east correctly", () => {
    const [lon, lat] = destinationPoint(8, 45, 90, 10_000);
    expect(lat).toBeCloseTo(45, 2);
    expect(lon).toBeGreaterThan(8);
  });

  it("converts 24h distance to km/h", () => {
    expect(spreadKmh(24_000)).toBe(1);
    expect(spreadKmh(7885)).toBeCloseTo(0.33, 2);
  });

  it("emits a shaft and a head per moving fire, skipping still ones", () => {
    const fc = {
      type: "FeatureCollection" as const,
      features: [
        evt("a", 8, 45, { bearing_deg: 45, distance_24h_m: 8000, path_total_m: 9000 }),
        evt("b", 9, 46, null),
      ],
    };
    const out = buildArrowFeatures(fc);
    expect(out.features).toHaveLength(2); // only fire "a"
    expect(out.features.map((f) => f.geometry.type)).toEqual(["LineString", "Point"]);
    expect(out.features[0].properties).toMatchObject({ id: "a", bearing: 45 });
  });

  it("flips outline contrast against the fill colour", () => {
    expect(outlineFor("#fffbe6")).toContain("0,0,0"); // pale fill → dark outline
    expect(outlineFor("#4a2170")).toContain("255,255,255"); // dark fill → light outline
  });

  it("maps every speed band to its own arrow icon", () => {
    const expr = speedArrowExpression() as unknown[];
    expect(expr[0]).toBe("step");
    for (let i = 0; i < SPEED_STOPS.length; i++) {
      expect(expr).toContain(speedArrowIconName(i));
    }
    // A direction without a measurable rate falls to the slowest band, never
    // an invented fast one.
    expect(expr[1]).toEqual(["coalesce", ["get", "spd"], 0]);
  });

  it("clamps shaft length so slow and extreme fires stay legible", () => {
    const slow = buildArrowFeatures({
      type: "FeatureCollection",
      features: [evt("s", 8, 45, { bearing_deg: 0, distance_24h_m: 900, path_total_m: 900 })],
    });
    const tip = (slow.features[1].geometry as GeoJSON.Point).coordinates;
    // 900 m would be invisible; clamped up to the 4 km minimum
    expect(tip[1]).toBeGreaterThan(45.03);
  });
});
