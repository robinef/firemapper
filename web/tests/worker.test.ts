import { describe, expect, it } from "vitest";

import worker, { dispatchRefresh, type Env } from "../../worker/index";

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
    try {
      await worker.scheduled!({}, { ...env({}), GH_DISPATCH_TOKEN: "x" } as Env);
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
