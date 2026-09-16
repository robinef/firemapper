import { RateGateCore } from "./geocode_rate_gate";

/** Enforces Nominatim's usage policy's global 1 req/sec cap (verified at
 *  operations.osmfoundation.org/policies/nominatim/) — "the sum of traffic
 *  by all your users should not exceed the limits". A Durable Object is what
 *  makes a GLOBAL (not per-visitor) limit enforceable: requests routed to
 *  the same named instance are processed one at a time, so there is no race
 *  between concurrent requests the way a KV read-then-write would have. */
export class GeocodeRateGate {
  private readonly core = new RateGateCore(1000);

  async fetch(_request: Request): Promise<Response> {
    const result = this.core.tryAcquire();
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  }
}
