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
