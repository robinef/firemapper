/**
 * Per-visitor request cap for the /api/* proxies, on top of the protections
 * each handler already has (origin allowlist, the geocode Durable Object's
 * GLOBAL 1 req/s gate, edge caching).
 *
 * docs/DEPLOYMENT.md originally asked for this as a dashboard WAF
 * rate-limiting rule. That is not possible here: the Worker runs on its
 * workers.dev hostname, which is Cloudflare's zone, not ours, so zone-level
 * WAF rules cannot be attached to it.
 *
 * The first attempt (#160) used the Workers Rate Limiting binding
 * (`ratelimits` in wrangler.jsonc). It enforces correctly under `wrangler
 * dev` (workerd) but in production it returned `success: true` for 40
 * consecutive calls from one IP inside 15 s, with no exception, on the live
 * version that `wrangler versions view` showed carrying the binding. The
 * same symptom on workers.dev is on the Cloudflare community, unanswered
 * (topic 953250, 2026-08-28). So the cap is now a Durable Object, one
 * instance per (route, visitor), the same mechanism the geocode global gate
 * already relies on in production.
 *
 * Semantics worth knowing before tuning VISITOR_LIMITS:
 * - fixed window, counted in the instance's memory: an evicted idle instance
 *   starts a fresh window. That only ever loosens the cap, and a visitor
 *   actively hammering keeps its instance alive;
 * - keyed on the client IP, so a NAT or campus can share a budget. The limits
 *   are set for "a human clicking around", not "one request per minute", to
 *   keep that from biting.
 *
 * Fail-open by design: no namespace (local dev, unit tests) or a gate error
 * must never take the feature down. The geocode handler's Durable Object
 * gate is the opposite (fail-closed) because it enforces an upstream usage
 * POLICY; this layer is defense in depth for our own quota.
 */

export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface DurableObjectStubLike {
  fetch(request: Request | string): Promise<Response>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface VisitorGateEnv {
  /** Durable Object namespace bound in wrangler.jsonc; one instance per (route, visitor). */
  VISITOR_RATE_GATE?: DurableObjectNamespaceLike;
}

/** Both handlers make ONE upstream call per user action, so these are "a
 * human clicking around", not a quota. */
export const VISITOR_LIMITS = {
  historical: { limit: 20, periodS: 60 },
  geocode: { limit: 10, periodS: 60 },
} as const;
export type VisitorRoute = keyof typeof VISITOR_LIMITS;

export const VISITOR_LIMIT_RETRY_AFTER_S = 60;

/** The key a visitor's requests are counted under. Cloudflare sets
 * cf-connecting-ip on every request that reaches a Worker; its absence means
 * a local/test harness, where all callers share one bucket. */
export function visitorKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Fixed-window counter: `limit` acquisitions per `periodMs`, then denied
 * until the window that started at the first acquisition has elapsed.
 * Pure and clock-injectable so it is unit-tested directly; the Durable
 * Object below is a thin wrapper around one instance of it. */
export class WindowCounterCore {
  private windowStartMs: number | null = null;
  private count = 0;

  constructor(private readonly now: () => number = Date.now) {}

  tryAcquire(limit: number, periodMs: number): { success: true } | { success: false; retryAfterMs: number } {
    const nowMs = this.now();
    if (this.windowStartMs === null || nowMs - this.windowStartMs >= periodMs) {
      this.windowStartMs = nowMs;
      this.count = 0;
    }
    if (this.count < limit) {
      this.count += 1;
      return { success: true };
    }
    return { success: false, retryAfterMs: periodMs - (nowMs - this.windowStartMs) };
  }
}

const GATE_URL = "https://gate.internal/acquire";

/** Durable Object: one instance per (route, visitor) name, so the counter
 * inside is that visitor's budget on that route. `limit` and `period` come
 * on the request so the class stays generic and the numbers live in one
 * place (VISITOR_LIMITS). */
export class VisitorRateGate {
  private readonly core = new WindowCounterCore();

  async fetch(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit"));
    const periodS = Number(params.get("period"));
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(periodS) || periodS <= 0) {
      return new Response("bad gate request", { status: 400 });
    }
    const result = this.core.tryAcquire(limit, periodS * 1000);
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }
}

/** Adapts the Durable Object namespace to the RateLimiterLike shape the
 * handlers consume, so a handler test can still inject a plain fake. */
export function durableLimiter(ns: DurableObjectNamespaceLike, route: VisitorRoute): RateLimiterLike {
  const { limit, periodS } = VISITOR_LIMITS[route];
  return {
    async limit({ key }) {
      const stub = ns.get(ns.idFromName(`${route}:${key}`));
      const res = await stub.fetch(`${GATE_URL}?limit=${limit}&period=${periodS}`);
      if (!res.ok) throw new Error(`visitor gate answered ${res.status}`);
      const body = (await res.json()) as { success?: unknown };
      return { success: body.success === true };
    },
  };
}

/** Which limiter a handler should use: an explicit override (tests, or a
 * future binding that actually enforces) wins; otherwise the Durable Object
 * gate; otherwise nothing, and visitorLimited passes everyone. */
export function resolveLimiter(
  override: RateLimiterLike | undefined,
  ns: DurableObjectNamespaceLike | undefined,
  route: VisitorRoute,
): RateLimiterLike | undefined {
  if (override) return override;
  if (ns) return durableLimiter(ns, route);
  return undefined;
}

/** Returns a 429 to send back if this visitor is over budget, else null. */
export async function visitorLimited(
  request: Request,
  limiter: RateLimiterLike | undefined,
): Promise<Response | null> {
  if (!limiter) return null;
  let success: boolean;
  try {
    ({ success } = await limiter.limit({ key: visitorKey(request) }));
  } catch (err) {
    // Fail-open, but never silently: with observability on, this line is the
    // only way to tell "the gate let everyone through" from "nobody was over
    // budget". The error comes from the gate, not from any upstream URL, so
    // it cannot carry a map key.
    console.warn("visitor limiter error; failing open", err instanceof Error ? err.message : String(err));
    return null;
  }
  if (success) return null;
  return new Response("too many requests — slow down", {
    status: 429,
    headers: {
      "retry-after": String(VISITOR_LIMIT_RETRY_AFTER_S),
      "cache-control": "no-store",
    },
  });
}
