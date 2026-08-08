import { describe, expect, it } from "vitest";

import { readoutModel, WIND_MAX_AGE_MIN } from "../src/fire_readout";

const NOW = new Date("2026-08-08T12:00:00Z");
const AT = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();

/** A wind point. Distances below are from [18.35, 42.71] (the fixture fire). */
function windPoint(lon: number, lat: number, opts: Partial<{ from_deg: number; kmh: number; t: string }> = {}) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties: { from_deg: opts.from_deg ?? 225, kmh: opts.kmh ?? 18, t: opts.t ?? AT(1) },
  };
}
const fc = (features: unknown[]) => ({ type: "FeatureCollection", features }) as never;
const FIRE: [number, number] = [18.35, 42.71];

describe("readoutModel — intensity", () => {
  it("takes the newest observation, not the last array element", () => {
    const got = readoutModel([[AT(22), 378], [AT(30), 900]], FIRE, null, NOW);
    expect(got?.intensity?.mw).toBe(378);
    expect(got?.intensity?.ageMinutes).toBe(22 * 60);
  });

  it("is null for an empty series", () => {
    expect(readoutModel([], FIRE, null, NOW)).toBeNull();
  });

  it("is null when the fire has no track at all, without hiding wind", () => {
    const got = readoutModel(null, FIRE, fc([windPoint(18.35, 42.71)]), NOW);
    expect(got?.intensity).toBeNull();
    expect(got?.wind).not.toBeNull();
  });

  it("never suppresses an old reading", () => {
    const got = readoutModel([[AT(200), 12]], FIRE, null, NOW);
    expect(got?.intensity).toEqual({ mw: 12, ageMinutes: 200 * 60 });
  });
});

describe("readoutModel — wind", () => {
  it("picks the genuinely nearest point, not the first", () => {
    const far = windPoint(19.2, 43.2, { kmh: 40 });
    const near = windPoint(18.36, 42.72, { kmh: 18 });
    const got = readoutModel(null, FIRE, fc([far, near]), NOW);
    expect(got?.wind?.kmh).toBe(18);
  });

  it("keeps a point just inside the range limit and drops one past it", () => {
    // ~0.45 deg latitude ≈ 50 km; ~0.63 deg ≈ 70 km.
    expect(readoutModel(null, FIRE, fc([windPoint(18.35, 43.16)]), NOW)?.wind).not.toBeNull();
    expect(readoutModel(null, FIRE, fc([windPoint(18.35, 43.34)]), NOW)).toBeNull();
  });

  it("reports the distance so the renderer can decide whether to show it", () => {
    const got = readoutModel(null, FIRE, fc([windPoint(18.35, 43.0)]), NOW);
    expect(got?.wind?.distanceKm).toBeGreaterThan(30);
    expect(got?.wind?.distanceKm).toBeLessThan(34);
  });

  it("drops wind older than its budget and keeps it just inside", () => {
    const stale = AT(WIND_MAX_AGE_MIN / 60 + 1);
    const fresh = AT(WIND_MAX_AGE_MIN / 60 - 0.5);
    expect(readoutModel(null, FIRE, fc([windPoint(18.35, 42.71, { t: stale })]), NOW)).toBeNull();
    expect(readoutModel(null, FIRE, fc([windPoint(18.35, 42.71, { t: fresh })]), NOW)?.wind).not.toBeNull();
  });

  it("is null when there is no position to match against", () => {
    const got = readoutModel([[AT(1), 100]], null, fc([windPoint(18.35, 42.71)]), NOW);
    expect(got?.wind).toBeNull();
    expect(got?.intensity).not.toBeNull();
  });

  it("carries the bearing the wind is blowing FROM; rotation is the renderer's job", () => {
    const got = readoutModel(null, FIRE, fc([windPoint(18.35, 42.71, { from_deg: 225 })]), NOW);
    expect(got?.wind?.bearingDeg).toBe(225);
  });
});

describe("readoutModel — nothing to say", () => {
  it("returns null when neither reading is available", () => {
    expect(readoutModel(null, FIRE, null, NOW)).toBeNull();
    expect(readoutModel([], FIRE, fc([]), NOW)).toBeNull();
  });
});
