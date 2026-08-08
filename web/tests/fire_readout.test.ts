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
    // Newest in middle: [30h], [22h (newest)], [48h]
    const got = readoutModel([[AT(30), 100], [AT(22), 378], [AT(48), 200]], FIRE, null, NOW);
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

  it("rejects NaN intensity values", () => {
    const got = readoutModel([[AT(1), NaN]], FIRE, fc([windPoint(18.35, 42.71)]), NOW);
    expect(got?.intensity).toBeNull();
    expect(got?.wind).not.toBeNull(); // wind is still valid
  });

  it("skips null elements in frpLive", () => {
    // null in middle; newest is AT(0.5) with mw=150, proving timestamp-based selection
    const got = readoutModel([[AT(1), 100], null as any, [AT(0.5), 150], [AT(2), 200]], FIRE, null, NOW);
    expect(got?.intensity?.mw).toBe(150); // selected by recency (0.5h), not position or value
  });

  it("rejects negative ages (future timestamps)", () => {
    const future = new Date(NOW.getTime() + 3600_000).toISOString();
    const got = readoutModel([[future, 100], [AT(1), 200]], FIRE, null, NOW);
    expect(got?.intensity?.mw).toBe(200); // uses past timestamp, ignores future
  });

  it("skips array entries with length < 2", () => {
    const got = readoutModel([[AT(1), 100] as any, [AT(0.5)], [AT(2), 200]], FIRE, null, NOW);
    expect(got?.intensity?.mw).toBe(100); // skips [AT(0.5)] (length 1), uses newer: 100 from AT(1)
  });

  it("skips entries with falsy iso string", () => {
    const got = readoutModel([[AT(1), 100], ["", 150], [AT(2), 200]], FIRE, null, NOW);
    expect(got?.intensity?.mw).toBe(100); // uses first valid, skips empty iso
  });

  it("rejects Invalid Date (NaN age)", () => {
    const invalidNow = new Date("invalid");
    const got = readoutModel([[AT(1), 100]], FIRE, null, invalidNow);
    expect(got).toBeNull(); // both intensity and wind fail with invalid now
  });
});

describe("readoutModel — wind", () => {
  it("picks the genuinely nearest point, not the first", () => {
    // near first, far genuinely within 60 km (~43 km away)
    const near = windPoint(18.36, 42.72, { kmh: 18 });
    const far = windPoint(18.35, 43.10, { kmh: 40 });
    const got = readoutModel(null, FIRE, fc([near, far]), NOW);
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

  it("rejects NaN distance when position is garbage", () => {
    const badPosition: [number, number] = [NaN, 42.71];
    const good = windPoint(18.35, 42.71, { kmh: 18 });
    const got = readoutModel([[AT(1), 100]], badPosition, fc([good]), NOW);
    expect(got?.wind).toBeNull(); // position is caller-supplied
    expect(got?.intensity).not.toBeNull();
  });

  it("skips null features", () => {
    const good = windPoint(18.35, 42.71, { kmh: 18 });
    const got = readoutModel(null, FIRE, fc([null as any, good]), NOW);
    expect(got?.wind?.kmh).toBe(18);
  });

  it("skips features with missing coordinates", () => {
    const noCoords = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: undefined },
      properties: { from_deg: 225, kmh: 18, t: AT(1) },
    };
    const good = windPoint(18.35, 42.71, { kmh: 18 });
    const got = readoutModel(null, FIRE, fc([noCoords, good]), NOW);
    expect(got?.wind?.kmh).toBe(18);
  });

  it("rejects negative ages (future wind timestamps)", () => {
    const future = new Date(NOW.getTime() + 3600_000).toISOString();
    const got = readoutModel([[AT(1), 100]], FIRE, fc([windPoint(18.35, 42.71, { t: future })]), NOW);
    expect(got?.wind).toBeNull(); // future wind is rejected, but intensity is present
  });

  it("keeps wind at exactly 180 minutes and drops beyond", () => {
    const exactly180 = AT(WIND_MAX_AGE_MIN / 60);
    const over180 = AT(WIND_MAX_AGE_MIN / 60 + 0.01);
    expect(readoutModel(null, FIRE, fc([windPoint(18.35, 42.71, { t: exactly180 })]), NOW)?.wind).not.toBeNull();
    expect(readoutModel(null, FIRE, fc([windPoint(18.35, 42.71, { t: over180 })]), NOW)).toBeNull();
  });

  it("rejects NaN bearing", () => {
    const got = readoutModel([[AT(1), 100]], FIRE, fc([windPoint(18.35, 42.71, { from_deg: NaN })]), NOW);
    expect(got?.wind).toBeNull();
    expect(got?.intensity).not.toBeNull();
  });

  it("rejects NaN speed", () => {
    const got = readoutModel([[AT(1), 100]], FIRE, fc([windPoint(18.35, 42.71, { kmh: NaN })]), NOW);
    expect(got?.wind).toBeNull();
    expect(got?.intensity).not.toBeNull();
  });

  it("skips wind points with non-string t", () => {
    const badT = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [18.35, 42.71] },
      properties: { from_deg: 225, kmh: 18, t: 12345 },
    };
    const good = windPoint(18.35, 42.71, { kmh: 18 });
    const got = readoutModel(null, FIRE, fc([badT, good]), NOW);
    expect(got?.wind?.kmh).toBe(18); // uses valid wind point
  });

  it("skips wind points with unparseable t", () => {
    const badT = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [18.35, 42.71] },
      properties: { from_deg: 225, kmh: 18, t: "not-a-date" },
    };
    const good = windPoint(18.35, 42.71, { kmh: 18 });
    const got = readoutModel(null, FIRE, fc([badT, good]), NOW);
    expect(got?.wind?.kmh).toBe(18); // uses valid wind point
  });
});

describe("readoutModel — nothing to say", () => {
  it("returns null when neither reading is available", () => {
    expect(readoutModel(null, FIRE, null, NOW)).toBeNull();
    expect(readoutModel([], FIRE, fc([]), NOW)).toBeNull();
  });
});
