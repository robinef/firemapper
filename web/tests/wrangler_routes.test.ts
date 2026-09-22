import { describe, expect, it } from "vitest";
// ?raw rather than node:fs: the web tsconfig is DOM-only with no @types/node,
// and vite/client already declares "*?raw".
import raw from "../../wrangler.jsonc?raw";
import * as entry from "../../worker/index";

/**
 * Cloudflare serves static assets BEFORE the Worker. Any path not listed in
 * assets.run_worker_first therefore never reaches worker/index.ts — and with
 * not_found_handling "single-page-app" it silently returns index.html with a
 * 200, so the failure looks like success.
 *
 * That is exactly what happened to /hd on first deploy: the HD imagery proxy
 * answered every tile request with the app shell (text/html, 1080 bytes), which
 * MapLibre discards without firing `error`, leaving a blank compare half.
 */
// Strip whole-line // comments (JSONC) without touching "//" inside strings.
function parsedConfig(): {
  assets: { run_worker_first: string[] };
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes?: string[] }[];
  ratelimits?: unknown[];
} {
  const json = raw.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(json);
}

function routes(): string[] {
  return parsedConfig().assets.run_worker_first;
}

describe("worker routing config", () => {
  it("routes every Worker-handled prefix to the Worker, not the asset layer", () => {
    const configured = routes();
    // Keep in step with the branches in worker/index.ts's fetch().
    for (const path of ["/data/**", "/hd"]) {
      expect(configured, `${path} would be answered by the SPA shell`).toContain(path);
    }
  });

  it("keeps the nested data glob, which needs ** rather than *", () => {
    // A single-segment glob left /data/gen-<ts>/tracks/<id>.json to the asset
    // layer, which answered HEAD probes with 503.
    expect(routes()).toContain("/data/**");
  });

  it("routes /api/historical-hotspots to the Worker too", () => {
    expect(routes()).toContain("/api/historical-hotspots");
  });

  it("routes /api/geocode to the Worker too", () => {
    expect(routes()).toContain("/api/geocode");
  });

  it("declares a durable_objects binding for GeocodeRateGate matching worker/index.ts's export", () => {
    const { durable_objects } = parsedConfig();
    expect(durable_objects.bindings.some((b) => b.class_name === "GeocodeRateGate")).toBe(true);
  });

  it("declares a new_sqlite_classes migration for GeocodeRateGate (config drift has broken this before)", () => {
    const { migrations } = parsedConfig();
    expect(migrations.some((m) => m.new_sqlite_classes?.includes("GeocodeRateGate"))).toBe(true);
  });

  it("binds VISITOR_RATE_GATE to VisitorRateGate — without it both /api handlers silently run uncapped", () => {
    const { durable_objects } = parsedConfig();
    const b = durable_objects.bindings.find((x) => x.name === "VISITOR_RATE_GATE");
    expect(b?.class_name).toBe("VisitorRateGate");
  });

  it("declares a new_sqlite_classes migration for VisitorRateGate (a new DO class without one fails at deploy)", () => {
    const { migrations } = parsedConfig();
    expect(migrations.some((m) => m.new_sqlite_classes?.includes("VisitorRateGate"))).toBe(true);
  });

  it("exports every Durable Object class the config binds — a missing export fails only at deploy", () => {
    const { durable_objects } = parsedConfig();
    for (const b of durable_objects.bindings) {
      expect(
        typeof (entry as Record<string, unknown>)[b.class_name],
        `${b.class_name} (binding ${b.name}) is not exported from worker/index.ts`,
      ).toBe("function");
    }
  });

  it("does not carry a ratelimits binding — it never denied in production here (see worker/visitor_limit.ts)", () => {
    // If someone re-adds it, they must also re-verify against prod, not just
    // `wrangler dev`, where it works. This test is the reminder.
    expect(parsedConfig().ratelimits).toBeUndefined();
  });
});
