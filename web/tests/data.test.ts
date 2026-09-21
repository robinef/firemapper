import { describe, expect, it } from "vitest";
import { loadEvents, loadFiresSummary, loadFootprint, loadManifest, loadSeason, loadTrack } from "../src/data";
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

  it("fetches a past-scar's permanent archive when track_gen is the archive sentinel", async () => {
    // Past scars don't live in any numbered generation — their track was
    // written once, permanently, outside the generation-pruning lifecycle
    // (pipeline/archive_tracks.py). "archive" is not a real generation name,
    // so it must never fall through to the `trackGen || m.generation` path.
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(u);
      return { json: async () => ({ id: "scar-1", series: [], cells: [] }) };
    }) as unknown as typeof fetch;

    await loadTrack(liveManifest, "scar-1", "/data", fetchFn, "archive");
    expect(seen).toEqual(["/data/archive/tracks/scar-1.json"]);
  });
});

describe("loadFootprint", () => {
  // An EFFIS scar's real perimeter (pipeline/archive_footprints.py) lives at
  // a fixed, non-generation path — unlike loadTrack, there is no generation
  // or "archive" sentinel to resolve, since the file never moves once written.
  it("fetches the permanent per-scar footprint file", async () => {
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(u);
      return { json: async () => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [] } }) };
    }) as unknown as typeof fetch;

    const footprint = await loadFootprint("562583", "/data", fetchFn);

    expect(seen).toEqual(["/data/archive/footprints/562583.json"]);
    expect(footprint.type).toBe("Feature");
  });
});

describe("loadSeason", () => {
  const good = { year: 2026, generated_at: "2026-09-18T10:00:00Z", floor: "2026-07-13", fires: 2, km2: 3.4, r6: [["861e8d5afffffff", 3.4]] };

  it("returns the summary when the file is well-formed", async () => {
    const fetchFn = async (url: string) => {
      expect(url).toBe("/data/archive/season_2026.json");
      return { ok: true, json: async () => good };
    };
    expect(await loadSeason(2026, "/data", fetchFn as never)).toEqual(good);
  });

  it("returns null on a non-ok response even when the body is well-formed", async () => {
    const fetchFn = async () => ({ ok: false, json: async () => good });
    expect(await loadSeason(2026, "/data", fetchFn as never)).toBeNull();
  });

  it.each([
    ["year", { ...good, year: "2026" }],
    ["r6", { ...good, r6: "nope" }],
    ["fires", { ...good, fires: null }],
  ])("returns null when %s is malformed", async (_field, body) => {
    const fetchFn = async () => ({ ok: true, json: async () => body });
    expect(await loadSeason(2026, "/data", fetchFn as never)).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchFn = async () => { throw new Error("offline"); };
    expect(await loadSeason(2026, "/data", fetchFn as never)).toBeNull();
  });
});

// The per-fire country/area summary the scale blob already publishes
// (pipeline/export_scale_blob.py). The season layer reads it for one thing
// only: is this fire inside the EU-27? Null on anything wrong — the scope
// toggle then stays disabled and the layer behaves exactly as before.
describe("loadFiresSummary", () => {
  const good = { "fire-a": { country: "ES", area_km2: 3.2 }, "fire-b": { country: null, area_km2: 0.7 } };

  it("returns the summary when the file is well-formed", async () => {
    const fetchFn = async (url: string) => {
      expect(url).toBe("/data/archive/blob_2026_fires.json");
      return { ok: true, json: async () => good };
    };
    expect(await loadFiresSummary(2026, "/data", fetchFn as never)).toEqual(good);
  });

  it("returns null on a non-ok response even when the body is well-formed", async () => {
    const fetchFn = async () => ({ ok: false, json: async () => good });
    expect(await loadFiresSummary(2026, "/data", fetchFn as never)).toBeNull();
  });

  it.each([
    ["null", null],
    ["an array", [{ country: "ES", area_km2: 1 }]],
    ["a scalar", 42],
  ])("returns null when the body is %s", async (_what, body) => {
    const fetchFn = async () => ({ ok: true, json: async () => body });
    expect(await loadFiresSummary(2026, "/data", fetchFn as never)).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchFn = async () => { throw new Error("offline"); };
    expect(await loadFiresSummary(2026, "/data", fetchFn as never)).toBeNull();
  });
});
