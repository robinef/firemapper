import { defineConfig } from "@playwright/test";

/**
 * Browser smoke tests, run against the BUILT output rather than the dev
 * server.
 *
 * That choice is the point of the suite. Every defect these tests exist to
 * catch was invisible to `tsc` and to all 300+ unit tests, because jsdom
 * computes no layout and never loads a map:
 *
 *   - maplibre 6 resolved its worker to a path Vite never emitted, so the
 *     built map hung forever. Every request returned 200 and no error fired.
 *   - fire dots carried maxzoom 9.5 and vanished at the zoom a fire card flies
 *     to, taking 62% of fires off the map.
 *   - the icon rail sat on top of the peek strip, and the view chip covered
 *     the freshness badge, at 375px.
 *
 * Testing the dev server would have missed the first of those entirely, since
 * the worker resolves differently there. So: build, serve, drive.
 */
export default defineConfig({
  testDir: "./smoke",
  // A map has to fetch a basemap and its tiles; the default 30s is tight on a
  // cold CI runner and a flaky smoke suite gets ignored, which is worse than
  // not having one.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Serial and single-worker: these tests drive one map through real
  // interactions, and the failure they are most likely to catch is a layout
  // collision, which is not worth racing browsers over.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    // Screenshots only on failure — the point is to see WHICH elements
    // overlapped, which a description in an assertion message cannot show.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    // `vite preview` serves dist/ exactly as the Worker does, including the
    // maplibre sibling files. `npm run build` runs first so the suite can
    // never pass against a stale bundle.
    //
    // --host 127.0.0.1 is not cosmetic: without it preview binds ::1 only, so
    // Playwright polling 127.0.0.1 waits out the full webServer timeout and
    // reports "Timed out waiting for config.webServer" with no clue why.
    command: "npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
