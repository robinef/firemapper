import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// Two HTML entries, so the build emits scale.html as a real asset. It has to be
// a real asset: wrangler.jsonc sets not_found_handling to "single-page-application"
// and never sets html_handling, so anything that fails to resolve is answered
// with index.html — the map — and a 200. A page that failed to build would look
// like a page that works.
//
// No URL spelling defends against that, so the guard is here at build time
// instead: tests/scale_render.test.ts asserts this input map still names both
// entries. (On the serving side, html_handling defaults to auto-trailing-slash,
// which makes the extensionless /scale canonical and 307s /scale.html onto it —
// both resolve, so links use /scale.)
const entry = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main: entry("./index.html"),
        scale: entry("./scale.html"),
      },
    },
  },
  test: { environment: "node" },
});
