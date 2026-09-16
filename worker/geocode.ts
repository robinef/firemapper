import { RateGateCore } from "./geocode_rate_gate";
import { isAllowedOrigin } from "./historical_hotspots";

/** Enforces Nominatim's usage policy's global 1 req/sec cap (verified at
 *  operations.osmfoundation.org/policies/nominatim/) — "the sum of traffic
 *  by all your users should not exceed the limits". A Durable Object is what
 *  makes a GLOBAL (not per-visitor) limit enforceable: requests routed to
 *  the same named instance are processed one at a time, so there is no race
 *  between concurrent requests the way a KV read-then-write would have. */
export class GeocodeRateGate {
  private readonly core = new RateGateCore(1000);

  async fetch(_request: Request): Promise<Response> {
    const result = this.core.tryAcquire();
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  }
}

interface DurableObjectStubLike {
  fetch(request: Request | string): Promise<Response>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): string;
  get(id: string): DurableObjectStubLike;
}
interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface GeocodeEnv {
  GEOCODE_RATE_GATE?: DurableObjectNamespaceLike;
  /** Seam for tests; defaults to global fetch. */
  GEOCODE_UPSTREAM?: (request: Request) => Promise<Response>;
  /** Seam for tests; defaults to caches.default. */
  GEOCODE_CACHE?: CacheLike;
}

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
// Nominatim's policy requires "a valid HTTP Referer or User-Agent
// identifying the application (stock User-Agents ... will not do)".
const USER_AGENT = "FireMapper/1.0 (https://firemapper.robinef.workers.dev)";
const MIN_QUERY_LENGTH = 3;
// Results never change meaningfully for a place-name search; caching is a
// POLICY REQUIREMENT here, not just an optimization ("Results must be
// cached on your side").
const CACHE_TTL_S = 604_800; // 7 days

function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function handleGeocode(request: Request, env: GeocodeEnv): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return new Response("forbidden", { status: 403 });
  }

  const rawQuery = new URL(request.url).searchParams.get("q");
  const normalizedQuery = rawQuery ? normalizeQuery(rawQuery) : "";
  if (!rawQuery || normalizedQuery.length < MIN_QUERY_LENGTH) {
    return new Response("q is required (min 3 characters)", { status: 400 });
  }
  // Preserve the caller's original casing/whitespace for the actual
  // upstream call (Nominatim results may differ subtly by casing for some
  // queries), but key the cache on the normalized form so equivalent
  // queries ("Gironde" vs " gironde ") share one cached result.
  const query = rawQuery.trim();

  const cache = env.GEOCODE_CACHE ?? (typeof caches !== "undefined" ? (caches as unknown as { default: CacheLike }).default : undefined);
  const cacheKey = new Request(`https://cache.internal/geocode?q=${encodeURIComponent(normalizedQuery)}`);
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  if (env.GEOCODE_RATE_GATE) {
    try {
      const stub = env.GEOCODE_RATE_GATE.get(env.GEOCODE_RATE_GATE.idFromName("global"));
      const gateRes = await stub.fetch("https://gate.internal/acquire");
      const gate = (await gateRes.json()) as { allowed: boolean; retryAfterMs?: number };
      if (!gate.allowed) {
        return new Response("rate limited — try again shortly", {
          status: 429,
          headers: { "retry-after": String(Math.ceil((gate.retryAfterMs ?? 1000) / 1000)) },
        });
      }
    } catch {
      return new Response("geocoding upstream failure", { status: 502 });
    }
  }

  const upstreamUrl = `${NOMINATIM_BASE}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1`;
  const fetcher = env.GEOCODE_UPSTREAM ?? ((r: Request) => fetch(r));
  const upstreamRequest = new Request(upstreamUrl, { headers: { "user-agent": USER_AGENT } });
  let body: string;
  try {
    const upstreamResponse = await fetcher(upstreamRequest);
    if (!upstreamResponse.ok) {
      return new Response("geocoding upstream failure", { status: 502 });
    }
    body = await upstreamResponse.text();
  } catch {
    return new Response("geocoding upstream failure", { status: 502 });
  }
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_TTL_S}` },
  });
  if (cache) await cache.put(cacheKey, response.clone());
  return response;
}
