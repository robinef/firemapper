/**
 * FireMapper edge entry point.
 *
 * Data lives in R2 and is republished every 30 minutes (a Cloudflare Cron
 * Trigger drives it; see the scheduled handler below), so it must NOT be
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
  /** Fine-grained GitHub token, Actions: read+write on this repo only. Set with
   * `wrangler secret put GH_DISPATCH_TOKEN`; absent in local dev, where the
   * scheduled handler simply reports that and does nothing. */
  GH_DISPATCH_TOKEN?: string;
}

const REPO = "robinef/firemapper";
const WORKFLOW = "refresh-fast.yml";
const REF = "main";
// GitHub rejects requests without one, and a named agent makes this Worker
// identifiable in audit logs rather than an anonymous caller.
const UA = "firemapper-refresh-trigger";

/**
 * Ask GitHub to run the refresh workflow.
 *
 * Returns the status AND the body on failure. A bare status is not diagnosable:
 * 422 is the common misconfiguration (wrong ref, the workflow_dispatch trigger
 * removed, or the workflow auto-disabled after 60 days of repo inactivity — a
 * real GitHub behaviour that would silently kill this), and GitHub always
 * explains which in the body.
 *
 * Uses workflow_dispatch rather than repository_dispatch deliberately: the
 * former needs only `Actions: read and write`, the latter needs
 * `Contents: read and write`, which is a token that can push commits. Same
 * result, far less to lose if the secret leaks.
 */
export async function dispatchRefresh(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: string }> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": UA,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: REF }),
    },
  );
  // 204 has no body by definition, and reading one costs a round trip.
  const body = response.status === 204 ? "" : await response.text().catch(() => "");
  return { status: response.status, body: body.slice(0, 300) };
}

/** Why a dispatch failed, in the terms whoever reads the alert will need. */
function explain(status: number): string {
  if (status === 401) return " — token invalid or expired";
  if (status === 403) return " — token lacks Actions: write";
  if (status === 404) return " — repo or workflow path wrong, or token cannot see it";
  if (status === 422) return " — bad ref, or the workflow is disabled";
  return "";
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

  /**
   * Drive the refresh from Cloudflare's scheduler instead of GitHub's.
   *
   * GitHub throttles scheduled workflows on public repos, and it is not a small
   * effect: measured 2026-08-04 over 52.8 h, a quarter-hourly cron produced 30
   * runs where 211 were nominal — 14%, with a median gap of 81 min and a worst
   * of 232. Every freshness budget in the pipeline was written for a cadence
   * that was never happening. Cron Triggers here fire reliably, so the schedule
   * in the workflow stays only as a fallback for when this Worker is broken.
   *
   * This does NOT yet meet aircraft's 20-minute budget, and it is worth being
   * precise about why: a layer is inside its budget from publish until budget
   * expiry, so meeting it needs interval + time-to-publish <= 20 min. At a
   * 30-minute interval, aircraft is fresh for roughly 20 minutes in every 60 and
   * stale the rest — better than vanishing, but not fixed. The binding
   * constraint is job DURATION, not trigger cadence: the refresh currently takes
   * ~13 min, nearly all of it the doomed FRP retries (#25), against ~2 min when
   * healthy. Once that lands and the real duration is measured, this interval
   * can tighten and aircraft becomes continuously coverable. Until then, do not
   * describe the plane layer as fixed.
   */
  async scheduled(event: { cron?: string }, env: Env) {
    if (!env.GH_DISPATCH_TOKEN) {
      // Not an error: `wrangler dev` binds no secrets.
      console.log("[refresh] no GH_DISPATCH_TOKEN bound, skipping dispatch");
      return;
    }

    // Deliberately NOT wrapped in ctx.waitUntil, and deliberately not catching:
    // a swallowed failure makes every invocation report "Ok", so Cloudflare's
    // own cron-invocation status — the one signal that survives past a live
    // `wrangler tail` and can raise a notification — would stay green through a
    // 401 storm. An expiring token is the most likely way this dies (fine-
    // grained PATs cap at ~1 year, so it is a when, not an if), and it fails
    // exactly like the throttling this replaced: refreshes simply stop. Throwing
    // is what makes that a recorded, alertable failure rather than a log line
    // nobody reads.
    let last: { status: number; body: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      // One retry: a single transient blip would otherwise forfeit a whole slot.
      // Auth and config faults are not retried — they will not fix themselves,
      // and a second 401 only doubles the noise.
      last = await dispatchRefresh(env.GH_DISPATCH_TOKEN);
      if (last.status === 204) {
        console.log(`[refresh] dispatched refresh-fast (cron ${event?.cron ?? "?"})`);
        return;
      }
      if (last.status < 500) break;
    }
    throw new Error(
      `[refresh] dispatch failed: HTTP ${last!.status}${explain(last!.status)}` +
        (last!.body ? ` — ${last!.body}` : ""),
    );
  },
};
