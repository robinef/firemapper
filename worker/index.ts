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
}

export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DATA: R2BucketLike;
  ASSETS: FetcherLike;
}

const DATA_PREFIX = "/data/";
/** The manifest is the only mutable object; generations are immutable by
 * construction (each run writes a new gen-<timestamp>/ dir). */
const MANIFEST_CACHE = "public, max-age=30";
const GENERATION_CACHE = "public, max-age=31536000, immutable";

function contentType(key: string): string {
  return key.endsWith(".json") || key.endsWith(".geojson")
    ? "application/json"
    : "application/octet-stream";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(DATA_PREFIX)) {
      return env.ASSETS.fetch(request);
    }

    const key = url.pathname.slice(1); // "/data/x" -> "data/x"
    const object = await env.DATA.get(key);
    if (!object) {
      return new Response("data unavailable", {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "60" },
      });
    }

    const immutable = url.pathname.startsWith(`${DATA_PREFIX}gen-`);
    return new Response(object.body as BodyInit, {
      headers: {
        "content-type": contentType(key),
        "cache-control": immutable ? GENERATION_CACHE : MANIFEST_CACHE,
      },
    });
  },
};
