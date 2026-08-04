import { describe, expect, it } from "vitest";
// ?raw rather than node:fs: the web tsconfig is DOM-only with no @types/node,
// and vite/client already declares "*?raw".
import raw from "../../wrangler.jsonc?raw";

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
function routes(): string[] {
  // Strip whole-line // comments (JSONC) without touching "//" inside strings.
  const json = raw.replace(/^\s*\/\/.*$/gm, "");
  return (JSON.parse(json) as { assets: { run_worker_first: string[] } })
    .assets.run_worker_first;
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
});
