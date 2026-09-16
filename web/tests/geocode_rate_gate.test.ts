import { describe, expect, it } from "vitest";
import { RateGateCore } from "../../worker/geocode_rate_gate";

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
    const gate = new RateGateCore(1000);
    expect(gate.tryAcquire()).toEqual({ allowed: true });
  });
});
