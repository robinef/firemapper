import { expect, test } from "@playwright/test";
import { waitForBoot } from "./helpers";

/**
 * Does the built app actually come up?
 *
 * This is the test that would have caught the maplibre 6 worker regression.
 * That bug shipped a map which never finished loading: the style resolved,
 * every network request returned 200, no error event fired anywhere, and the
 * app sat behind its splash forever. `tsc`, 300 unit tests and a green
 * production build all passed. There was no symptom to search for.
 */
test.describe("the built app boots", () => {
  test("reaches a live map, not a splash screen", async ({ page }) => {
    const failures: string[] = [];
    page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => failures.push(`failed: ${r.url()}`));
    page.on("response", (r) => {
      // The worker is fetched as a real URL, so a 404 here is silent in the
      // console but fatal to the map. It also 404s INTO Vite's SPA fallback in
      // some setups, which answers 200 with HTML — hence the type check.
      if (r.url().includes("maplibre-gl-worker") && !r.ok()) {
        failures.push(`worker HTTP ${r.status()}`);
      }
    });

    await page.goto("/");
    await waitForBoot(page);

    // The layer registry only mounts after the map's load event, so a
    // populated list means the whole boot path ran. ATTACHED, not visible:
    // #layers lives inside #view, which is closed until the reader opens it.
    await expect(page.locator("#layers .layer-row").first()).toBeAttached();
    await expect(page.locator("#timeline")).not.toBeEmpty();

    expect(failures, `console/network failures during boot:\n${failures.join("\n")}`)
      .toEqual([]);
  });

  test("serves maplibre's worker as JavaScript, not as the SPA fallback", async ({
    request,
  }) => {
    // Asserted directly rather than inferred from a working map, because the
    // failure mode is a 200 that returns index.html: the worker then dies
    // parsing HTML as JavaScript, which no status-code check would notice.
    const res = await request.get("/assets/maplibre-gl-worker.mjs");
    expect(res.status(), "the maplibre worker must be emitted beside the bundle")
      .toBe(200);
    expect(
      res.headers()["content-type"] ?? "",
      "a text/html body here is Vite's SPA fallback answering a 404",
    ).toContain("javascript");
  });
});
