import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Emit maplibre's worker next to the bundle.
 *
 * maplibre 6 is ESM-only and loads its worker as a real URL rather than v4's
 * blob, resolving it as `new URL("./" + name, import.meta.url)`. The specifier
 * is built at runtime rather than being a static string literal, so Vite's
 * asset detection cannot see it and never emits the file — the built app then
 * requests `/assets/maplibre-gl-worker.mjs` and gets a 404, leaving a map with
 * no worker. Nothing in the type checker, the unit tests or the build reports
 * this; only loading the built output over HTTP does.
 *
 * `maplibre-gl-shared.mjs` has to come too: both the worker and the main entry
 * import it as a relative sibling, so the worker 404s on it in turn. It is
 * already inlined into the app bundle, so shipping it again here duplicates
 * ~133 kB gzip. That is the price of copying; the alternative is leaving
 * maplibre unbundled so all three files are served as siblings and `shared` is
 * fetched once, which is a larger change than this upgrade.
 *
 * Resolved via `require.resolve` rather than a hardcoded node_modules path, so
 * a hoisted or pnpm-style layout still finds it and a future version that
 * renames these files fails the build here instead of silently shipping a
 * worker that 404s.
 */
function maplibreWorker(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "maplibre-worker-assets",
    apply: "build",
    writeBundle(options, bundle) {
      const src = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));
      // Beside the ENTRY CHUNK, not at the root of options.dir. The worker URL
      // resolves against the importing module, which is assets/index-<hash>.js,
      // so a copy into dist/ is still a 404. Taking the directory from the
      // emitted chunk keeps this correct if assetsDir is ever changed.
      const entry = Object.values(bundle).find(
        (c) => c.type === "chunk" && c.isEntry,
      );
      if (!entry) throw new Error("maplibre-worker-assets: no entry chunk to sit beside");
      const out = join(options.dir ?? "dist", dirname(entry.fileName));
      for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
        copyFileSync(join(src, file), join(out, file));
      }
    },
  };
}

export default defineConfig({
  plugins: [maplibreWorker()],
  server: { port: 5173 },
  test: { environment: "node" },
});
