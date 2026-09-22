import { describe, expect, it, vi } from "vitest";
import {
  VISITOR_LIMITS,
  VisitorRateGate,
  WindowCounterCore,
  durableLimiter,
  resolveLimiter,
  visitorKey,
  visitorLimited,
  type DurableObjectNamespaceLike,
  type RateLimiterLike,
} from "../../worker/visitor_limit";

const req = (headers: Record<string, string> = {}) => new Request("https://x/api/geocode?q=abc", { headers });

function limiter(success: boolean): RateLimiterLike & { limit: ReturnType<typeof vi.fn> } {
  return { limit: vi.fn(async () => ({ success })) };
}

/** A namespace whose every instance is a real VisitorRateGate, remembered by
 * name — the shape a real DurableObjectNamespace has, minus the network. */
function fakeNamespace(): DurableObjectNamespaceLike & { instances: Map<string, VisitorRateGate> } {
  const instances = new Map<string, VisitorRateGate>();
  return {
    instances,
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      if (!instances.has(name)) instances.set(name, new VisitorRateGate());
      const gate = instances.get(name)!;
      return { fetch: (r: Request | string) => gate.fetch(typeof r === "string" ? new Request(r) : r) };
    },
  };
}

describe("visitorKey", () => {
  it("keys on cf-connecting-ip", () => {
    expect(visitorKey(req({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("falls back to a shared key when the header is absent (local dev, tests)", () => {
    expect(visitorKey(req())).toBe("unknown");
  });
});

describe("WindowCounterCore", () => {
  it("allows exactly `limit` acquisitions in a window, then denies with the time left", () => {
    let now = 0;
    const c = new WindowCounterCore(() => now);
    for (let i = 0; i < 3; i++) expect(c.tryAcquire(3, 60_000)).toEqual({ success: true });
    now = 10_000;
    expect(c.tryAcquire(3, 60_000)).toEqual({ success: false, retryAfterMs: 50_000 });
  });

  it("opens a fresh window once the period has elapsed since the first acquisition", () => {
    let now = 0;
    const c = new WindowCounterCore(() => now);
    c.tryAcquire(1, 60_000);
    now = 59_999;
    expect(c.tryAcquire(1, 60_000).success).toBe(false);
    now = 60_000;
    expect(c.tryAcquire(1, 60_000)).toEqual({ success: true });
  });
});

describe("VisitorRateGate (Durable Object)", () => {
  it("counts per instance and answers JSON the adapter can read", async () => {
    const gate = new VisitorRateGate();
    const ask = () => gate.fetch(new Request("https://gate.internal/acquire?limit=2&period=60"));
    expect(await (await ask()).json()).toEqual({ success: true });
    expect(await (await ask()).json()).toEqual({ success: true });
    const third = (await (await ask()).json()) as { success: boolean; retryAfterMs: number };
    expect(third.success).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("400s a request without a sane limit/period instead of counting it", async () => {
    const gate = new VisitorRateGate();
    expect((await gate.fetch(new Request("https://gate.internal/acquire"))).status).toBe(400);
    expect((await gate.fetch(new Request("https://gate.internal/acquire?limit=0&period=60"))).status).toBe(400);
  });
});

describe("durableLimiter", () => {
  it("names the instance by route AND visitor, so budgets are independent per route and per IP", async () => {
    const ns = fakeNamespace();
    const geo = durableLimiter(ns, "geocode");
    const hist = durableLimiter(ns, "historical");
    await geo.limit({ key: "203.0.113.7" });
    await geo.limit({ key: "198.51.100.9" });
    await hist.limit({ key: "203.0.113.7" });
    expect([...ns.instances.keys()].sort()).toEqual([
      "geocode:198.51.100.9",
      "geocode:203.0.113.7",
      "historical:203.0.113.7",
    ]);
  });

  it("enforces VISITOR_LIMITS for the route end to end through the gate", async () => {
    const ns = fakeNamespace();
    const geo = durableLimiter(ns, "geocode");
    const results: boolean[] = [];
    for (let i = 0; i < VISITOR_LIMITS.geocode.limit + 2; i++) {
      results.push((await geo.limit({ key: "203.0.113.7" })).success);
    }
    expect(results.filter(Boolean).length).toBe(VISITOR_LIMITS.geocode.limit);
    expect(results.slice(-2)).toEqual([false, false]);
  });

  it("throws (so visitorLimited fails open and warns) when the gate answers non-2xx", async () => {
    const ns: DurableObjectNamespaceLike = {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }),
    };
    await expect(durableLimiter(ns, "geocode").limit({ key: "k" })).rejects.toThrow(/500/);
  });
});

describe("resolveLimiter", () => {
  it("prefers an explicit override, then the Durable Object namespace, else nothing", () => {
    const override = limiter(true);
    const ns = fakeNamespace();
    expect(resolveLimiter(override, ns, "geocode")).toBe(override);
    expect(resolveLimiter(undefined, ns, "geocode")).toBeDefined();
    expect(resolveLimiter(undefined, undefined, "geocode")).toBeUndefined();
  });
});

describe("visitorLimited", () => {
  it("passes when no limiter is configured — the layer is optional, never a 503", async () => {
    expect(await visitorLimited(req(), undefined)).toBeNull();
  });

  it("passes when the limiter allows, having asked under the visitor's key", async () => {
    const l = limiter(true);
    expect(await visitorLimited(req({ "cf-connecting-ip": "203.0.113.7" }), l)).toBeNull();
    expect(l.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
  });

  it("429s with retry-after and no-store when the limiter refuses", async () => {
    const res = await visitorLimited(req(), limiter(false));
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBe("60");
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });

  it("fails open when the limiter throws — a limiter outage must not take the feature down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const l: RateLimiterLike = { limit: async () => { throw new Error("boom"); } };
      expect(await visitorLimited(req(), l)).toBeNull();
      // Open, but never silent: the log line is what distinguishes "gate
      // broken" from "nobody over budget" in production.
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.join(" "))).toContain("boom");
    } finally {
      warn.mockRestore();
    }
  });
});
