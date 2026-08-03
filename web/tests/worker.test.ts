import { describe, expect, it } from "vitest";

import worker, { type Env } from "../../worker/index";

function env(objects: Record<string, string>): Env {
  return {
    DATA: {
      async get(key: string) {
        return key in objects ? { body: objects[key] } : null;
      },
    },
    ASSETS: { fetch: async () => new Response("shell", { status: 200 }) },
  };
}

describe("worker /data routing", () => {
  it("serves the manifest from R2 with a short cache", async () => {
    const res = await worker.fetch(
      new Request("https://x/data/manifest.json"),
      env({ "data/manifest.json": '{"generation":"gen-1"}' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    expect(await res.text()).toContain("gen-1");
  });

  it("marks generation files immutable", async () => {
    const res = await worker.fetch(
      new Request("https://x/data/gen-1/events.geojson"),
      env({ "data/gen-1/events.geojson": "{}" }),
    );
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 503 on an R2 miss, never an empty 200", async () => {
    const res = await worker.fetch(new Request("https://x/data/manifest.json"), env({}));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves nested generation paths", async () => {
    const res = await worker.fetch(
      new Request("https://x/data/gen-1/tracks/e1.json"),
      env({ "data/gen-1/tracks/e1.json": '{"id":"e1"}' }),
    );
    expect(res.status).toBe(200);
  });

  it("falls through to static assets for everything else", async () => {
    const res = await worker.fetch(new Request("https://x/index.html"), env({}));
    expect(await res.text()).toBe("shell");
  });
});

describe("worker HEAD handling", () => {
  function envWithHead(objects: Record<string, string>): Env {
    return {
      DATA: {
        async get(key: string) {
          return key in objects ? { body: objects[key] } : null;
        },
        async head(key: string) {
          return key in objects ? { size: objects[key].length } : null;
        },
      },
      ASSETS: { fetch: async () => new Response("shell", { status: 200 }) },
    };
  }

  it("answers HEAD for a nested generation file without a body", async () => {
    const res = await worker.fetch(
      new Request("https://x/data/gen-1/tracks/e1.json", { method: "HEAD" }),
      envWithHead({ "data/gen-1/tracks/e1.json": '{"id":"e1"}' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("");
  });

  it("503s a HEAD for a missing object", async () => {
    const res = await worker.fetch(
      new Request("https://x/data/nope.json", { method: "HEAD" }),
      envWithHead({}),
    );
    expect(res.status).toBe(503);
  });

  it("falls back to get() when the bucket exposes no head()", async () => {
    const res = await worker.fetch(
      new Request("https://x/data/manifest.json", { method: "HEAD" }),
      env({ "data/manifest.json": "{}" }),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * HD imagery proxy.
 *
 * A Sentinel Hub OGC instance id IS the bearer token for that configuration —
 * there is no per-request OAuth on /ogc/*. Publishing it in manifest.imagery.hd
 * would hand every visitor read access to the whole configuration across WMS,
 * WMTS, WCS, WFS and FIS (GetCapabilities enumerates the layers, WCS returns
 * raw raster, FIS returns statistics), billed to the account. docs/DEPLOYMENT.md
 * has always said never to expose it to a public deploy. So the browser asks
 * this Worker instead and the id stays server-side.
 */
function hdEnv(instance?: string): Env {
  const seen: Request[] = [];
  const e = {
    DATA: { async get() { return null; } },
    ASSETS: { fetch: async () => new Response("shell") },
    SENTINELHUB_INSTANCE_ID: instance,
    SENTINELHUB_UPSTREAM: async (req: Request) => {
      seen.push(req);
      return new Response("JPEGBYTES", { headers: { "content-type": "image/jpeg" } });
    },
  } as unknown as Env;
  return Object.assign(e, { seen }) as Env & { seen: Request[] };
}

const hdUrl = (qs: string) => new Request(`https://x.dev/hd?${qs}`);
const TILE_QS =
  "service=WMS&request=GetMap&version=1.3.0&layers=TRUE_COLOR&styles=&format=image%2Fjpeg" +
  "&transparent=false&crs=EPSG%3A3857&width=512&height=512&TIME=2026-07-10%2F2026-07-22" +
  "&MAXCC=35&PRIORITY=leastCC&bbox=-155000%2C5590000%2C-140000%2C5605000";

describe("worker HD imagery proxy", () => {
  it("keeps the instance id out of the response entirely", async () => {
    const e = hdEnv("SECRET-INSTANCE-UUID") as Env & { seen: Request[] };
    const res = await worker.fetch(hdUrl(TILE_QS), e);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("SECRET-INSTANCE-UUID");
    // It appears once, upstream, where only Cloudflare sees it.
    expect(e.seen[0].url).toContain("SECRET-INSTANCE-UUID");
    expect(e.seen[0].url.startsWith("https://sh.dataspace.copernicus.eu/ogc/wms/")).toBe(true);
  });

  it("refuses anything but GetMap, so the config cannot be enumerated or mined", async () => {
    // The whole point: a leaked id would allow these. The proxy must not.
    for (const bad of ["request=GetCapabilities", "request=DescribeCoverage", "service=WCS"]) {
      const e = hdEnv("INST") as Env & { seen: Request[] };
      const res = await worker.fetch(hdUrl(`${TILE_QS}&${bad}`), e);
      const upstream = e.seen[0]?.url ?? "";
      expect(upstream).toContain("request=GetMap");
      expect(upstream).toContain("service=WMS");
      expect(upstream).not.toContain("GetCapabilities");
      expect(upstream).not.toContain("DescribeCoverage");
      expect(res.status).toBe(200);
    }
  });

  it("drops parameters it does not recognise rather than forwarding them", async () => {
    const e = hdEnv("INST") as Env & { seen: Request[] };
    await worker.fetch(hdUrl(`${TILE_QS}&evil=1&showLogo=false`), e);
    expect(e.seen[0].url).not.toContain("evil=");
  });

  it("passes the tile parameters through unchanged", async () => {
    const e = hdEnv("INST") as Env & { seen: Request[] };
    await worker.fetch(hdUrl(TILE_QS), e);
    const u = new URL(e.seen[0].url);
    expect(u.searchParams.get("layers")).toBe("TRUE_COLOR");
    expect(u.searchParams.get("bbox")).toBe("-155000,5590000,-140000,5605000");
    expect(u.searchParams.get("TIME")).toBe("2026-07-10/2026-07-22");
  });

  it("503s when no instance is configured, rather than serving a blank tile", async () => {
    // Same rule as /data: a miss must never be indistinguishable from success.
    // MapLibre drops a failed raster tile without firing `error`, so a silent
    // 200-with-nothing would leave the compare mode blank and unexplained.
    const res = await worker.fetch(hdUrl(TILE_QS), hdEnv(undefined));
    expect(res.status).toBe(503);
  });

  it("refuses a write method", async () => {
    const e = hdEnv("INST");
    const res = await worker.fetch(
      new Request(`https://x.dev/hd?${TILE_QS}`, { method: "POST" }), e,
    );
    expect(res.status).toBe(405);
  });

  it("caches tiles hard — they are immutable for a given bbox, time and layer", async () => {
    const e = hdEnv("INST") as Env & { seen: Request[] };
    const res = await worker.fetch(hdUrl(TILE_QS), e);
    expect(res.headers.get("cache-control")).toContain("max-age=");
    // Sentinel Hub bills processing units per request; without this every
    // viewer costs quota for a tile the edge already has.
    expect(Number(res.headers.get("cache-control")!.match(/max-age=(\d+)/)![1]))
      .toBeGreaterThanOrEqual(86400);
  });
});
