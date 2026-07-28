import { describe, expect, it } from "vitest";
import { loadEvents, loadManifest } from "../src/data";

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
