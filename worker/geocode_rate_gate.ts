/**
 * The actual gating logic behind the GeocodeRateGate Durable Object
 * (worker/geocode.ts). Kept separate and Cloudflare-API-free so it can be
 * unit-tested directly with a fake clock — the Durable Object wrapper around
 * it is thin enough to trust once this is proven correct, verified live
 * instead of mocked (see this plan's final task).
 */
export class RateGateCore {
  private lastAcquiredMs: number | null = null;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const nowMs = this.now();
    if (this.lastAcquiredMs === null || nowMs - this.lastAcquiredMs >= this.minIntervalMs) {
      this.lastAcquiredMs = nowMs;
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: this.minIntervalMs - (nowMs - this.lastAcquiredMs) };
  }
}
