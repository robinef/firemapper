import { describe, expect, it, vi } from "vitest";
import { visitorKey, visitorLimited, type RateLimiterLike } from "../../worker/visitor_limit";

const req = (headers: Record<string, string> = {}) => new Request("https://x/api/geocode?q=abc", { headers });

function limiter(success: boolean): RateLimiterLike & { limit: ReturnType<typeof vi.fn> } {
  return { limit: vi.fn(async () => ({ success })) };
}

describe("visitorKey", () => {
  it("keys on cf-connecting-ip", () => {
    expect(visitorKey(req({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("falls back to a shared key when the header is absent (local dev, tests)", () => {
    expect(visitorKey(req())).toBe("unknown");
  });
});

describe("visitorLimited", () => {
  it("passes when no binding is configured — the layer is optional, never a 503", async () => {
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
    const l: RateLimiterLike = { limit: async () => { throw new Error("boom"); } };
    expect(await visitorLimited(req(), l)).toBeNull();
  });
});
