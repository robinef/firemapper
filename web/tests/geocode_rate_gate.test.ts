import { describe, expect, it } from "vitest";
import { RateGateCore } from "../../worker/geocode_rate_gate";
// GeocodeRateGate itself (the Durable Object class) lives in worker/geocode.ts,
// which re-exports it for worker/index.ts; RateGateCore above is its pure core.
import { GeocodeRateGate } from "../../worker/geocode";

describe("RateGateCore", () => {
  it("allows the first request", () => {
    const gate = new RateGateCore(1000, () => 0);
    expect(gate.tryAcquire()).toEqual({ allowed: true });
  });

  it("rejects a second request inside the interval", () => {
    let now = 0;
    const gate = new RateGateCore(1000, () => now);
    gate.tryAcquire();
    now = 500;
    const result = gate.tryAcquire();
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.retryAfterMs).toBe(500);
  });

  it("allows a request exactly at the interval boundary", () => {
    let now = 0;
    const gate = new RateGateCore(1000, () => now);
    gate.tryAcquire();
    now = 1000;
    expect(gate.tryAcquire()).toEqual({ allowed: true });
  });

  it("allows a request well after the interval", () => {
    let now = 0;
    const gate = new RateGateCore(1000, () => now);
    gate.tryAcquire();
    now = 5000;
    expect(gate.tryAcquire()).toEqual({ allowed: true });
  });

  it("tracks the new acquisition time after an allowed request, not the old one", () => {
    let now = 0;
    const gate = new RateGateCore(1000, () => now);
    gate.tryAcquire(); // t=0, allowed
    now = 1000;
    gate.tryAcquire(); // t=1000, allowed, gate should now track 1000
    now = 1500;
    const result = gate.tryAcquire(); // only 500ms since the t=1000 acquisition
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.retryAfterMs).toBe(500);
  });

  it("defaults its clock to Date.now when none is given", () => {
    // First-call-always-allowed is true unconditionally, regardless of which
    // clock is used, so it alone doesn't prove Date.now is wired up. Proving
    // that requires a second call within the same instant to be denied — that
    // only happens if a real, working (non-frozen) clock backs this gate.
    const gate = new RateGateCore(1000);
    expect(gate.tryAcquire()).toEqual({ allowed: true });
    const second = gate.tryAcquire();
    expect(second.allowed).toBe(false);
  });
});

describe("GeocodeRateGate (Durable Object, real class, real clock)", () => {
  it("returns {allowed:true} then {allowed:false, retryAfterMs} in the JSON shape geocode.ts's handler parses", async () => {
    const gate = new GeocodeRateGate();
    const first = await gate.fetch(new Request("https://x"));
    const firstBody = (await first.json()) as { allowed: boolean; retryAfterMs?: number };
    expect(firstBody.allowed).toBe(true);

    const second = await gate.fetch(new Request("https://x"));
    const secondBody = (await second.json()) as { allowed: boolean; retryAfterMs?: number };
    expect(secondBody.allowed).toBe(false);
    expect(typeof secondBody.retryAfterMs).toBe("number");
    expect(secondBody.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(secondBody.retryAfterMs).toBeLessThanOrEqual(1000);
  });
});
