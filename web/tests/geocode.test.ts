import { describe, expect, it, vi } from "vitest";
import { handleGeocode, type GeocodeEnv } from "../../worker/geocode";

const ORIGIN = "https://firemapper.robinef.workers.dev";
const req = (qs: string, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`https://x/api/geocode?${qs}`, { headers });

function fakeGate(allowed: boolean, retryAfterMs = 0): GeocodeEnv["GEOCODE_RATE_GATE"] {
  // get() must return the SAME stub object on every call — a real
  // DurableObjectNamespace routes the same idFromName() to the same
  // instance, and a test that wants to spy on the stub's fetch (see the
  // "returns a cached result" test below) needs that same identity to spy
  // on, not a fresh object per call.
  const stub = {
    fetch: async () =>
      new Response(JSON.stringify(allowed ? { allowed: true } : { allowed: false, retryAfterMs })),
  };
  return {
    idFromName: () => "gate",
    get: () => stub,
  } as unknown as GeocodeEnv["GEOCODE_RATE_GATE"];
}

function fakeCache(): NonNullable<GeocodeEnv["GEOCODE_CACHE"]> {
  const store = new Map<string, Response>();
  return {
    async match(request: Request) {
      return store.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      store.set(request.url, response.clone());
    },
  };
}

describe("handleGeocode", () => {
  it("403s a request from a disallowed origin", async () => {
    const res = await handleGeocode(req("q=Gironde", { origin: "https://evil.example.com" }), {
      GEOCODE_RATE_GATE: fakeGate(true),
    });
    expect(res.status).toBe(403);
  });

  it("400s a missing query", async () => {
    const res = await handleGeocode(req(""), { GEOCODE_RATE_GATE: fakeGate(true) });
    expect(res.status).toBe(400);
  });

  it("400s a too-short query (guards against near-empty/noise queries)", async () => {
    const res = await handleGeocode(req("q=a"), { GEOCODE_RATE_GATE: fakeGate(true) });
    expect(res.status).toBe(400);
  });

  it("429s when the rate gate says no, and never calls upstream", async () => {
    const upstream = vi.fn();
    const res = await handleGeocode(req("q=Gironde"), {
      GEOCODE_RATE_GATE: fakeGate(false, 750),
      GEOCODE_UPSTREAM: upstream,
      GEOCODE_CACHE: fakeCache(),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1"); // 750ms rounds up to 1s
    expect(upstream).not.toHaveBeenCalled();
  });

  it("sends a real identifying User-Agent to Nominatim, never a stock/default one", async () => {
    let seenUA = "";
    const upstream = async (r: Request) => {
      seenUA = r.headers.get("user-agent") ?? "";
      return new Response("[]");
    };
    await handleGeocode(req("q=Gironde"), {
      GEOCODE_RATE_GATE: fakeGate(true),
      GEOCODE_UPSTREAM: upstream,
      GEOCODE_CACHE: fakeCache(),
    });
    expect(seenUA).toContain("FireMapper");
    expect(seenUA).toContain("firemapper.robinef.workers.dev");
  });

  it("forwards the query to Nominatim's search endpoint and returns its JSON", async () => {
    let seenUrl = "";
    const upstream = async (r: Request) => {
      seenUrl = r.url;
      return new Response('[{"lat":"44.8","lon":"-1.0","display_name":"Gironde, France"}]');
    };
    const res = await handleGeocode(req("q=Gironde"), {
      GEOCODE_RATE_GATE: fakeGate(true),
      GEOCODE_UPSTREAM: upstream,
      GEOCODE_CACHE: fakeCache(),
    });
    expect(seenUrl).toBe("https://nominatim.openstreetmap.org/search?q=Gironde&format=jsonv2&limit=1");
    expect(await res.text()).toContain("Gironde, France");
  });

  it("returns a cached result on a repeat query without calling upstream or the gate again", async () => {
    const upstream = vi.fn(async () => new Response('[{"lat":"44.8","lon":"-1.0"}]'));
    const gate = fakeGate(true);
    const gateFetch = vi.spyOn(gate!.get(gate!.idFromName("gate")), "fetch");
    const cache = fakeCache();

    await handleGeocode(req("q=Gironde"), { GEOCODE_RATE_GATE: gate, GEOCODE_UPSTREAM: upstream, GEOCODE_CACHE: cache });
    await handleGeocode(req("q=Gironde"), { GEOCODE_RATE_GATE: gate, GEOCODE_UPSTREAM: upstream, GEOCODE_CACHE: cache });

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(gateFetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes the cache key so query casing/whitespace don't bust the cache", async () => {
    const upstream = vi.fn(async () => new Response("[]"));
    const cache = fakeCache();
    const gate = fakeGate(true);

    await handleGeocode(req("q=Gironde"), { GEOCODE_RATE_GATE: gate, GEOCODE_UPSTREAM: upstream, GEOCODE_CACHE: cache });
    await handleGeocode(req("q=%20gironde%20"), { GEOCODE_RATE_GATE: gate, GEOCODE_UPSTREAM: upstream, GEOCODE_CACHE: cache });

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("returns 502 when Nominatim itself fails, never a cached failure", async () => {
    const upstream = async () => new Response("boom", { status: 503 });
    const res = await handleGeocode(req("q=Gironde"), {
      GEOCODE_RATE_GATE: fakeGate(true), GEOCODE_UPSTREAM: upstream, GEOCODE_CACHE: fakeCache(),
    });
    expect(res.status).toBe(502);
  });
});
