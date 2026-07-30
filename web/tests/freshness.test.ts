import { describe, expect, it } from "vitest";

import { badgeText, layerState, moduleStale } from "../src/freshness";
import type { Manifest } from "../src/types";

const NOW = new Date("2026-07-30T12:00:00Z");

function manifest(
  layers: Record<string, unknown>,
  generated = "2026-07-30T11:55:00Z",
): Manifest {
  return {
    schema_version: "1.1.0",
    generated_at: generated,
    generation: "gen-1",
    tiers: { viirs: true, meteosat: true },
    layers,
  } as unknown as Manifest;
}

const layer = (observed: string | null, status = "ok", max_age_s = 3600) => ({
  attempted_at: "2026-07-30T12:00:00Z",
  fetched_at: "2026-07-30T12:00:00Z",
  observed_at: observed,
  status,
  source: "mtg-fci",
  max_age_s,
});

describe("badgeText", () => {
  it("reports the newest fire observation", () => {
    const m = manifest({
      events: layer("2026-07-30T11:20:00Z", "ok", 10800),
      frp: layer("2026-07-30T11:48:00Z"),
    });
    expect(badgeText(m, NOW)).toContain("12 min");
    expect(badgeText(m, NOW)).not.toContain("stale");
  });

  it("stays stale when wind succeeds but both fire feeds fail", () => {
    // The live site's badge read live_frp.latest, so a dead fire feed simply
    // removed the badge instead of reporting the outage.
    const m = manifest({
      events: layer(null, "failed", 10800),
      frp: layer(null, "failed"),
      wind: layer("2026-07-30T11:59:00Z"),
    });
    const text = badgeText(m, NOW);
    expect(text).toContain("no live satellite data");
    expect(text).not.toContain("1 min");
  });

  it("marks data past the events budget as stale", () => {
    const m = manifest({ events: layer("2026-07-30T07:00:00Z", "ok", 10800) });
    expect(badgeText(m, NOW)).toContain("⚠ stale");
  });

  it("falls back to build time when no layers map exists (1.0 manifest)", () => {
    const m = manifest({});
    expect(badgeText(m, NOW)).toContain("built");
  });

  it("renders hours and days for older data", () => {
    const m = manifest({ events: layer("2026-07-29T12:00:00Z", "ok", 10800) });
    expect(badgeText(m, NOW)).toContain("24 h");
  });
});

describe("layerState", () => {
  it("greys a layer past its budget and says why", () => {
    const m = manifest({ frp: layer("2026-07-30T09:00:00Z", "ok", 3600) });
    const state = layerState(m, "frp", NOW);
    expect(state.stale).toBe(true);
    expect(state.reason).toContain("old");
  });

  it("keeps a layer inside its budget current", () => {
    const m = manifest({ frp: layer("2026-07-30T11:50:00Z", "ok", 3600) });
    expect(layerState(m, "frp", NOW).stale).toBe(false);
  });

  it("treats a failed layer with no timestamps as unavailable", () => {
    // a failed fetch has no fetched_at — that is what makes it unavailable
    const m = manifest({ frp: { ...layer(null, "failed"), fetched_at: null } });
    const state = layerState(m, "frp", NOW);
    expect(state.stale).toBe(true);
    expect(state.reason).toContain("unavailable");
  });

  it("is silent for a layer the manifest does not describe", () => {
    expect(layerState(manifest({}), "frp", NOW).stale).toBe(false);
  });
});

describe("moduleStale", () => {
  it("a derived module inherits its source's staleness", () => {
    // spread draws arrows from frp pixels; stale pixels make a stale arrow
    const m = manifest({ frp: layer("2026-07-30T09:00:00Z", "ok", 3600) });
    expect(moduleStale(m, { freshnessKeys: ["frp"] }, NOW)).toBe(true);
  });

  it("takes the worst status across several sources", () => {
    const m = manifest({
      events: layer("2026-07-30T11:55:00Z", "ok", 10800),
      frp: layer("2026-07-30T09:00:00Z", "ok", 3600),
    });
    expect(moduleStale(m, { freshnessKeys: ["events", "frp"] }, NOW)).toBe(true);
  });

  it("a module with no declared sources is never stale", () => {
    expect(moduleStale(manifest({}), {}, NOW)).toBe(false);
  });
});
