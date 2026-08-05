import { describe, expect, it } from "vitest";

import worker, { dispatchRefresh, manifestAgeMin, type Env } from "../../worker/index";

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

describe("worker scheduled refresh trigger", () => {
  /** Stub globalThis.fetch; returns a restore fn for a finally block. */
  function stubFetch(impl: (url: string, init: RequestInit) => Response) {
    const real = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return impl(url, init);
    }) as unknown as typeof fetch;
    return { calls, restore: () => void (globalThis.fetch = real) };
  }

  it("asks GitHub to run the workflow, not to push anything", async () => {
    // workflow_dispatch needs only Actions:write; repository_dispatch would
    // need Contents:write, i.e. a token that can commit to the repo.
    const calls: { url: string; init: RequestInit }[] = [];
    const res = await dispatchRefresh("tok", (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);

    expect(res.status).toBe(204);
    expect(calls[0].url).toContain("/actions/workflows/refresh-fast.yml/dispatches");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ref: "main" });
    // GitHub requires all three; a regression on any fails in prod, not in CI.
    expect(calls[0].init.method).toBe("POST");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer tok");
    expect(h.accept).toBe("application/vnd.github+json");
    expect(h["user-agent"]).toBeTruthy();
  });

  it("throws on a failed dispatch, so the invocation is recorded as failed", async () => {
    // A swallowed failure makes every cron invocation report "Ok", which is the
    // one signal that outlives a live tail. Throwing is the alertable path.
    const f = stubFetch(() => new Response('{"message":"Bad credentials"}', { status: 401 }));
    try {
      await expect(
        worker.scheduled!({ cron: "*/30 * * * *" }, {
          ...env({}),
          GH_DISPATCH_TOKEN: "stale",
        } as Env),
      ).rejects.toThrow(/401.*expired/);
    } finally {
      f.restore();
    }
  });

  it("does not retry an auth failure", async () => {
    // A second 401 only doubles the noise; it will not fix itself.
    const f = stubFetch(() => new Response("nope", { status: 401 }));
    try {
      await worker.scheduled!({}, { ...env({}), GH_DISPATCH_TOKEN: "x" } as Env).catch(() => {});
      expect(f.calls.length).toBe(1);
    } finally {
      f.restore();
    }
  });

  it("retries once on a server error, then succeeds", async () => {
    let n = 0;
    const f = stubFetch(() => new Response(null, { status: ++n === 1 ? 502 : 204 }));
    // A current manifest, so the staleness alarm stays out of a test about
    // retrying. Without one it throws "nothing is publishing" and this reads
    // as a retry failure.
    const fresh = JSON.stringify({
      layers: { events: { attempted_at: new Date().toISOString() } },
    });
    try {
      await worker.scheduled!({}, {
        ...env({ "data/manifest.json": fresh }),
        GH_DISPATCH_TOKEN: "x",
      } as Env);
      expect(f.calls.length).toBe(2);
    } finally {
      f.restore();
    }
  });

  it("skips, without touching the network, when no token is bound", async () => {
    // `wrangler dev` binds no secrets. The previous version of this test asserted
    // only that the promise resolved, which passed even with the guard deleted —
    // and then hit api.github.com for real.
    const logs: string[] = [];
    const spy = console.log;
    const f = stubFetch(() => {
      throw new Error("no network expected");
    });
    console.log = (m: string) => void logs.push(m);
    try {
      await worker.scheduled!({}, env({}));
      expect(f.calls.length).toBe(0);
      expect(logs.join(" ")).toContain("no GH_DISPATCH_TOKEN");
    } finally {
      console.log = spy;
      f.restore();
    }
  });
});

describe("worker staleness alarm", () => {
  const NOW = Date.parse("2026-08-05T12:00:00Z");

  /** A manifest whose layers were all attempted `minsAgo` minutes before NOW. */
  function manifest(minsAgo: number): string {
    const at = new Date(NOW - minsAgo * 60_000).toISOString();
    return JSON.stringify({
      layers: { events: { attempted_at: at }, frp: { attempted_at: at } },
    });
  }

  function scheduledEnv(objects: Record<string, string>): Env {
    return { ...env(objects), GH_DISPATCH_TOKEN: "tok" } as Env;
  }

  /** Accept the dispatch, so only the staleness check can fail the run. */
  function stubOk() {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    return () => void (globalThis.fetch = real);
  }

  it("reads the NEWEST attempted_at across layers, not an arbitrary one", async () => {
    // A single stale layer must not raise the alarm on its own: one feed can
    // fail while the pipeline is publishing perfectly well.
    const mixed = JSON.stringify({
      layers: {
        events: { attempted_at: new Date(NOW - 5 * 60_000).toISOString() },
        frp: { attempted_at: new Date(NOW - 900 * 60_000).toISOString() },
      },
    });
    expect(await manifestAgeMin(env({ "data/manifest.json": mixed }), NOW)).toBeCloseTo(5, 0);
  });

  it("treats a missing or unparseable manifest as broken, never as fresh", async () => {
    // Returning 0 here would make a deleted manifest look like a healthy
    // refresh — the failure would hide behind the alarm meant to catch it.
    expect(await manifestAgeMin(env({}), NOW)).toBeNull();
    expect(await manifestAgeMin(env({ "data/manifest.json": "not json" }), NOW)).toBeNull();
    expect(
      await manifestAgeMin(env({ "data/manifest.json": '{"layers":{}}' }), NOW),
    ).toBeNull();
  });

  it("throws when dispatch succeeds but nothing has published for too long", async () => {
    // The whole point: HTTP 204 only means GitHub ACCEPTED the request. Before
    // this, a job that then failed left every cron invocation reporting "Ok".
    const restore = stubOk();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      await expect(
        worker.scheduled!({}, scheduledEnv({ "data/manifest.json": manifest(200) })),
      ).rejects.toThrow(/200 min old/);
    } finally {
      Date.now = realNow;
      restore();
    }
  });

  it("stays quiet through one missed cycle", async () => {
    // 80 minutes is a single failed half-hourly refresh plus a slow job. Waking
    // someone for that would train them to ignore the alarm.
    const restore = stubOk();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      await expect(
        worker.scheduled!({}, scheduledEnv({ "data/manifest.json": manifest(80) })),
      ).resolves.toBeUndefined();
    } finally {
      Date.now = realNow;
      restore();
    }
  });

  it("still dispatches before it complains", async () => {
    // The refresh is the job; the alarm is a side effect. Skipping the dispatch
    // because data looks stale would suppress the very run that fixes it.
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      await worker
        .scheduled!({}, scheduledEnv({ "data/manifest.json": manifest(500) }))
        .catch(() => {});
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("/dispatches");
    } finally {
      Date.now = realNow;
      globalThis.fetch = real;
    }
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
