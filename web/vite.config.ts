import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// Two HTML entries, so the build emits scale.html as a real asset. It has to be
// a real asset: wrangler.jsonc sets not_found_handling to "single-page-app" and
// never sets html_handling, so anything that failed to resolve would be served
// index.html — the map — with a 200. A missing page would look like a working
// one. Links must therefore point at /scale.html, never /scale.
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
