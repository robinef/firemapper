import { describe, it, expect } from "vitest";
import configSource from "../vite.config.ts?raw";

/**
 * Dev-server guards. Nothing else in CI can catch these: the pipeline builds
 * and serves the BUILT output, and no test starts a dev server, so `npm run
 * dev` can be completely dead while every check is green — which is exactly
 * what happened between the maplibre 6 upgrade and this file.
 *
 * Read as TEXT rather than imported. `vite.config.ts` sits outside tsconfig's
 * program on purpose (include is src + tests, and types are geojson +
 * vite/client), so importing it for real drags it in and `tsc --noEmit` then
 * fails on `node:fs` and friends. Matching on source is weaker than asserting
 * the resolved config, and it is the honest price of not widening the
 * project's type surface for a test.
 */
describe("vite config", () => {
  it("keeps maplibre out of dep pre-bundling, or the dev worker 404s", () => {
    // maplibre resolves its worker as `new URL("./" + name, import.meta.url)`.
    // Pre-bundled, that points into node_modules/.vite/deps, which holds only
    // maplibre-gl.js — the worker 404s, Vite's SPA fallback answers with
    // index.html, and the worker dies parsing HTML as JavaScript. The map then
    // never finishes loading: no error event, every request 200, and
    // `isStyleLoaded()` false forever behind the splash.
    const exclude = configSource.match(/optimizeDeps:\s*{[^}]*exclude:\s*\[([^\]]*)\]/);
    expect(exclude, "optimizeDeps.exclude is gone from vite.config.ts").not.toBeNull();
    expect(exclude![1]).toContain("maplibre-gl");
  });

  it("still copies maplibre's files for the build, which is a separate path", () => {
    // The exclude above fixes dev only. The build has its own arrangement:
    // maplibre is external and its three files are copied beside the entry
    // chunk. Losing either half breaks a different half of the project.
    expect(configSource).toContain('apply: "build"');
    for (const file of [
      "maplibre-gl.mjs",
      "maplibre-gl-shared.mjs",
      "maplibre-gl-worker.mjs",
    ]) {
      expect(configSource, `${file} is no longer copied`).toContain(file);
    }
  });

  it("keeps maplibre external, or `shared` ships twice", () => {
    // maplibre's entry AND its worker both import ./maplibre-gl-shared.mjs as a
    // relative sibling. Bundling the entry inlines `shared` into the app chunk
    // while the worker still needs it on disk, so it shipped twice — ~100 kB
    // gzip of pure duplication, measured. External keeps the graph intact and
    // one copy is fetched.
    //
    // This is a source match, so it cannot prove the OUTPUT is right. The CI
    // build step asserts the emitted entry actually imports the copied file,
    // which is the check that would catch a silent re-bundling.
    expect(configSource).toMatch(/external:\s*\[\s*"maplibre-gl"\s*\]/);
    expect(configSource).toContain('"maplibre-gl": MAPLIBRE_ENTRY');
  });
});
