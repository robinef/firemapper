import { describe, expect, it } from "vitest";
import { loadEvents, loadManifest, loadTrack } from "../src/data";
import type { Manifest } from "../src/types";

const manifest = {
  schema_version: "1.0.0",
  generated_at: "2026-07-20T12:00:00Z",
  generation: "gen-x",
  tiers: { viirs: true, meteosat: false },
};

function fakeFetch(map: Record<string, unknown>) {
  return async (url: string) => ({ ok: true, json: async () => map[url] }) as Response;
}

describe("data client", () => {
  it("loads manifest", async () => {
    const m = await loadManifest("/data", fakeFetch({ "/data/manifest.json": manifest }));
    expect(m.generation).toBe("gen-x");
  });

  it("rejects newer major schema", async () => {
    const bad = { ...manifest, schema_version: "2.0.0" };
    await expect(loadManifest("/data", fakeFetch({ "/data/manifest.json": bad }))).rejects.toThrow();
  });

  it("resolves events url from generation", async () => {
    const fc = { type: "FeatureCollection", features: [] };
    const events = await loadEvents(manifest, "/data", fakeFetch({ "/data/gen-x/events.geojson": fc }));
    expect(events.features).toEqual([]);
  });
});

describe("addressing the generation that actually holds a track", () => {
  /**
   * publish stopped re-uploading byte-identical tracks: ~98.7% of them are
   * unchanged between runs, so a track now lives in whichever generation last
   * wrote it, and each events.geojson feature carries a `track_gen` pointing
   * there. Without using it, every unchanged fire's card would silently lose
   * its sparkline — loadTrack's failure is caught and the card still renders.
   */
  const liveManifest = { generation: "gen-NEW" } as unknown as Manifest;

  it("fetches from the generation the feature points at", async () => {
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(u);
      return { json: async () => ({ id: "abc", series: [], cells: [] }) };
    }) as unknown as typeof fetch;

    await loadTrack(liveManifest, "abc", "/data", fetchFn, "gen-OLD");
    expect(seen).toEqual(["/data/gen-OLD/tracks/abc.json"]);
  });

  it("falls back to the live generation when a feature carries no pointer", async () => {
    // A manifest published before track_gen existed. Its tracks are all in its
    // own generation, so the old address is the correct one — dropping this
    // fallback would blank every card for exactly one generation.
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(u);
      return { json: async () => ({ id: "abc", series: [], cells: [] }) };
    }) as unknown as typeof fetch;

    await loadTrack(liveManifest, "abc", "/data", fetchFn, undefined);
    expect(seen).toEqual(["/data/gen-NEW/tracks/abc.json"]);
  });
});
