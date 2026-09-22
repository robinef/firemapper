/**
 * Per-visitor request cap for the /api/* proxies, on top of the protections
 * each handler already has (origin allowlist, the geocode Durable Object's
 * GLOBAL 1 req/s gate, edge caching).
 *
 * docs/DEPLOYMENT.md originally asked for this as a dashboard WAF
 * rate-limiting rule. That is not possible here: the Worker runs on its
 * workers.dev hostname, which is Cloudflare's zone, not ours, so zone-level
 * WAF rules cannot be attached to it. The Workers Rate Limiting binding
 * (`ratelimits` in wrangler.jsonc) is backed by the same infrastructure and
 * works on workers.dev, so the cap lives in code instead.
 *
 * Semantics worth knowing before tuning the numbers in wrangler.jsonc:
 * - counters are per Cloudflare location and eventually consistent — this is
 *   a bound on abuse, not an accounting system;
 * - keyed on the client IP, so a NAT or campus can share a budget. The limits
 *   are set for "a human clicking around", not "one request per minute", to
 *   keep that from biting.
 *
 * Fail-open by design: a missing binding (local dev, unit tests) or a limiter
 * error must never take the feature down. The geocode handler's Durable
 * Object gate is the opposite (fail-closed) because it enforces an upstream
 * usage POLICY; this layer is defense in depth for our own quota.
 */

export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export const VISITOR_LIMIT_RETRY_AFTER_S = 60;

/** The key a visitor's requests are counted under. Cloudflare sets
 * cf-connecting-ip on every request that reaches a Worker; its absence means
 * a local/test harness, where all callers share one bucket. */
export function visitorKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
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
    // only way to tell "the binding let everyone through" from "nobody was
    // over budget". The error comes from the runtime binding, not from any
    // upstream URL, so it cannot carry a map key.
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
