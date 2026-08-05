import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** maplibre's ESM distribution, served as the three sibling files it expects. */
const MAPLIBRE_FILES = [
  "maplibre-gl.mjs",
  "maplibre-gl-shared.mjs",
  "maplibre-gl-worker.mjs",
] as const;

/** Where the emitted app imports maplibre from, and where the copies land. */
const MAPLIBRE_ENTRY = "/assets/maplibre-gl.mjs";

/**
 * Serve maplibre as its own files rather than bundling it.
 *
 * maplibre 6 ships a three-file ESM graph: the entry and the worker BOTH import
 * `./maplibre-gl-shared.mjs` as a relative sibling. Bundling the entry inlines
 * `shared` into the app chunk, but the worker is fetched by URL at runtime and
 * still needs `shared` on disk — so the previous arrangement shipped it twice,
 * once inlined and once standalone. Measured, that cost a map-loading visitor
 * 474 kB gzip against 374 kB here: 100 kB, or 21 %.
 *
 * Marking maplibre external and copying all three files keeps the graph intact:
 * the app imports the entry, the entry and the worker share one `shared`, and
 * nothing is inlined. It also caches better — these files change only when
 * maplibre does, so an app deploy no longer invalidates 500 kB of vendor code.
 *
 * The filenames CANNOT be hashed. maplibre resolves its own worker as
 * `new URL("./" + name, import.meta.url)` with the literal names above, so a
 * content hash would break the lookup. That is also why `MAPLIBRE_ENTRY` is a
 * fixed absolute path: it has to sit in the same directory as its two siblings.
 *
 * Resolved via `require.resolve` rather than a hardcoded node_modules path, so
 * a hoisted or pnpm-style layout still finds it and a future version that
 * renames these files fails the build here instead of silently shipping a
 * worker that 404s.
 */
function maplibreAssets(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "maplibre-assets",
    apply: "build",
    writeBundle(options, bundle) {
      const src = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));
      // Beside the ENTRY CHUNK, not at the root of options.dir: the worker URL
      // resolves against the module that imported it. Taking the directory from
      // the emitted chunk keeps this correct if assetsDir is ever changed —
      // though MAPLIBRE_ENTRY below would need to change with it.
      const entry = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry);
      if (!entry) throw new Error("maplibre-assets: no entry chunk to sit beside");
      const out = join(options.dir ?? "dist", dirname(entry.fileName));
      for (const file of MAPLIBRE_FILES) copyFileSync(join(src, file), join(out, file));
    },
  };
}

export default defineConfig({
  plugins: [maplibreAssets()],
  build: {
    rollupOptions: {
      // Not bundled. `output.paths` rewrites the bare specifier to the copied
      // file, so the browser fetches maplibre itself and resolves `shared` and
      // the worker relative to it. Only the exact id is external — the separate
      // `maplibre-gl/dist/maplibre-gl.css` import is a different specifier and
      // still goes through the normal CSS pipeline.
      external: ["maplibre-gl"],
      output: { paths: { "maplibre-gl": MAPLIBRE_ENTRY } },
    },
  },
  // Dev needs its own answer: the plugin above is apply: "build". Vite
  // pre-bundles dependencies into node_modules/.vite/deps, and maplibre
  // resolves its worker as `new URL("./" + name, import.meta.url)` — which in
  // dev points beside the PRE-BUNDLE, where only maplibre-gl.js exists. The
  // request 404s, Vite's SPA fallback answers it with index.html, and the
  // worker dies parsing HTML as JavaScript.
  //
  // The failure is silent in a way worth spelling out: the style loads, every
  // network request is 200, and no error event fires. The map simply never
  // finishes — `isStyleLoaded()` stays false forever, so `map.on("load")` never
  // runs and the whole app sits behind its splash. `npm run dev` was dead from
  // the maplibre 6 upgrade until this line.
  //
  // Excluding it serves maplibre unbundled from dist/, where the worker and
  // maplibre-gl-shared.mjs sit as real siblings and resolve for free.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: { port: 5173 },
  test: { environment: "node" },
});
