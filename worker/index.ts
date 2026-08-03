/**
 * FireMapper edge entry point.
 *
 * Data lives in R2 and is republished every 15 minutes by CI, so it must NOT be
 * bundled with the app: `/data/*` reads the bucket, everything else is the
 * static shell. That split is what makes a data refresh cost zero deploys.
 *
 * A miss returns 503, never an empty 200 — "no fires burning" and "the data is
 * gone" must never be indistinguishable to the client.
 *
 * The R2/Fetcher types are declared locally rather than pulled from
 * @cloudflare/workers-types: this file is typechecked by the web tsconfig
 * (DOM lib), and the surface we use is three methods wide.
 */
export interface R2ObjectBody {
  body: ReadableStream | string | null;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBody | null>;
  head?(key: string): Promise<{ size?: number } | null>;
}

export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DATA: R2BucketLike;
  ASSETS: FetcherLike;
  /** Sentinel Hub OGC instance id. A Worker secret, never published: it IS the
   * bearer token for that configuration (no per-request OAuth on /ogc/*), so
   * putting it in the manifest would hand every visitor read access to the
   * whole configuration — GetCapabilities enumerates its layers, WCS returns
   * raw raster, FIS returns statistics — billed to the account. Absent, HD is
   * simply unavailable and the map stays on the keyless MODIS tier. */
  SENTINELHUB_INSTANCE_ID?: string;
  /** Seam for tests; defaults to global fetch. */
  SENTINELHUB_UPSTREAM?: (request: Request) => Promise<Response>;
}

const DATA_PREFIX = "/data/";
const HD_PATH = "/hd";
const HD_UPSTREAM = "https://sh.dataspace.copernicus.eu/ogc/wms";
/** A tile is fully determined by bbox + time + layer, so it never changes.
 * Sentinel Hub bills processing units per request; caching at the edge is what
 * stops every viewer costing quota for an image we already have. */
const HD_CACHE = "public, max-age=604800, immutable";
/** Only these reach Sentinel Hub. Everything else — including any attempt to
 * switch service or request type — is dropped, so this proxy can serve map
 * tiles and nothing else. Without it, forwarding the query string verbatim
 * would re-expose exactly the access that keeping the id server-side removes. */
const HD_ALLOWED = new Set([
  "version", "layers", "styles", "format", "transparent", "crs", "srs",
  "width", "height", "bbox", "time", "maxcc", "priority", "upsampling",
  "downsampling", "preview", "geometry", "nicename",
]);
/** The manifest is the only mutable object; generations are immutable by
 * construction (each run writes a new gen-<timestamp>/ dir). */
const MANIFEST_CACHE = "public, max-age=30";
const GENERATION_CACHE = "public, max-age=31536000, immutable";

function contentType(key: string): string {
  return key.endsWith(".json") || key.endsWith(".geojson")
    ? "application/json"
    : "application/octet-stream";
}

/** Proxy one Sentinel Hub GetMap, keeping the instance id server-side.
 *
 * service and request are pinned rather than forwarded: a leaked instance id
 * would let anyone run GetCapabilities, WCS or FIS against the configuration,
 * and that is precisely the access this proxy exists to withhold. Only
 * recognised tile parameters are passed on. */
async function hdTile(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const instance = env.SENTINELHUB_INSTANCE_ID;
  if (!instance) {
    // Same rule as /data: a miss is 503, never an empty 200. MapLibre drops a
    // failed raster tile WITHOUT firing `error`, so a blank success would
    // leave the compare mode empty with nothing to explain it.
    return new Response("hd imagery unavailable", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "3600" },
    });
  }
  const incoming = new URL(request.url).searchParams;
  const params = new URLSearchParams({ service: "WMS", request: "GetMap" });
  for (const [key, value] of incoming) {
    if (HD_ALLOWED.has(key.toLowerCase())) params.set(key, value);
  }
  const upstream = new Request(`${HD_UPSTREAM}/${instance}?${params}`, { method: request.method });
  const fetcher = env.SENTINELHUB_UPSTREAM ?? ((r: Request) => fetch(r));
  const response = await fetcher(upstream);
  if (!response.ok) {
    return new Response("hd imagery unavailable", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "300" },
    });
  }
  return new Response(response.body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "image/jpeg",
      "cache-control": HD_CACHE,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === HD_PATH) return hdTile(request, env);
    if (!url.pathname.startsWith(DATA_PREFIX)) {
      return env.ASSETS.fetch(request);
    }

    const key = url.pathname.slice(1); // "/data/x" -> "data/x"
    const immutable = url.pathname.startsWith(`${DATA_PREFIX}gen-`);
    const headers = {
      "content-type": contentType(key),
      "cache-control": immutable ? GENERATION_CACHE : MANIFEST_CACHE,
    };
    const missing = () =>
      new Response("data unavailable", {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "60" },
      });

    // HEAD must not stream a body. Answering it with get() works but wastes the
    // read, and monitors/CDNs probe with HEAD — an unhandled one looks like an
    // outage.
    if (request.method === "HEAD") {
      const meta = env.DATA.head ? await env.DATA.head(key) : await env.DATA.get(key);
      return meta ? new Response(null, { headers }) : missing();
    }

    const object = await env.DATA.get(key);
    if (!object) return missing();

    return new Response(object.body as BodyInit, { headers });
  },
};
