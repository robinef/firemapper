import { expect, test, type Route } from "@playwright/test";
import { cellArea, cellToParent, gridDisk, latLngToCell, UNITS } from "h3-js";
import { openRail, waitForBoot } from "./helpers";

/**
 * The season layer's cells file is ~5 MB, and the sizes sidecar exists so a
 * reader who never touches the size filter never downloads it. That is a
 * network-level promise no unit test can see: it depends on main.ts's wiring
 * (no idle prefetch when the sidecar loaded) and on the filter asking for the
 * cells on its first interaction.
 *
 * The CI fixture (scripts/make_sample) has no season files — the season export
 * only runs in the remote full tier — so this spec serves a small synthetic
 * season through page.route, whatever year the fixture's manifest names.
 */

type Fire = { id: string; lat: number; lon: number; rings: number; first: string };
const FIRES: Fire[] = [
  { id: "small", lat: 40.1, lon: -4.0, rings: 0, first: "2026-07-02" },
  { id: "mid", lat: 43.2, lon: 5.1, rings: 1, first: "2026-07-20" },
  // Deliberately BEFORE "big" and on the same ground: a one-cell fire sharing
  // the centre of the big one is the first claimant of that cell, which is
  // what the map tags it with. Clicking there has to open the fire whose size
  // put the cell on screen, not this one.
  { id: "shared", lat: 38.4, lon: 23.5, rings: 0, first: "2026-08-05" },
  { id: "big", lat: 38.4, lon: 23.5, rings: 3, first: "2026-08-03" },
];

function season(year: number) {
  const cells: Record<string, { digest: string; first: string; cells: string[] }> = {};
  const sizes: Record<string, [number, string | null, string]> = {};
  const r6 = new Map<string, number>();
  for (const f of FIRES) {
    const cs = gridDisk(latLngToCell(f.lat, f.lon, 8), f.rings);
    const km2 = cs.reduce((s, c) => s + cellArea(c, UNITS.km2), 0);
    cells[f.id] = { digest: f.id, first: f.first, cells: cs };
    sizes[f.id] = [Math.round(km2 * 1000) / 1000, "ES", f.first];
    for (const c of cs) {
      const p = cellToParent(c, 6);
      r6.set(p, (r6.get(p) ?? 0) + cellArea(c, UNITS.km2));
    }
  }
  const r6List = [...r6.entries()].map(([c, v]) => [c, Math.round(v * 10) / 10]);
  const summary = {
    year, generated_at: `${year}-09-01T00:00:00Z`, floor: "2026-07-02", fires: FIRES.length,
    km2: r6List.reduce((s, [, v]) => s + (v as number), 0), r6: r6List,
  };
  return { summary, cells, sizes: { year, fires: sizes } };
}

test.describe("the season layer's cells file", () => {
  test("is not fetched at boot, and is fetched once on the first slider move", async ({ page }) => {
    const cellsRequests: string[] = [];
    await page.route(/\/data\/archive\/season_(\d{4})(_sizes|_cells)?\.json$/, async (route: Route) => {
      const [, year, kind] = route.request().url().match(/season_(\d{4})(_sizes|_cells)?\.json$/)!;
      const s = season(Number(year));
      if (kind === "_cells") cellsRequests.push(route.request().url());
      const body = kind === "_cells" ? s.cells : kind === "_sizes" ? s.sizes : s.summary;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });

    await page.goto("/");
    await waitForBoot(page);
    await openRail(page, "rail-layers", "layers");
    const filter = page.locator(".season-filter");
    await expect(filter).toHaveClass(/is-ready/);
    // Past the fallback path's idle prefetch (requestIdleCallback, 3 s cap):
    // with the sidecar loaded nothing may fetch the cells on its own.
    await page.waitForTimeout(4000);
    expect(cellsRequests, "no cells request before the reader touches the filter").toEqual([]);

    await page.locator(".season-range").fill("3");

    await expect(page.locator(".season-filter-label")).not.toContainText("…", { timeout: 15_000 });
    await page.waitForTimeout(1000);
    expect(cellsRequests, "exactly one cells request after the first slider move").toHaveLength(1);
  });
});

test.describe("season playback", () => {
  // main.ts wires the play control to the filter, the loader and the panel's
  // status line; no unit test sees that wiring.
  test("plays from the floor, pauses, and a size move drops it back to the full season", async ({ page }) => {
    await page.route(/\/data\/archive\/season_(\d{4})(_sizes|_cells)?\.json$/, async (route: Route) => {
      const [, year, kind] = route.request().url().match(/season_(\d{4})(_sizes|_cells)?\.json$/)!;
      const s = season(Number(year));
      const body = kind === "_cells" ? s.cells : kind === "_sizes" ? s.sizes : s.summary;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/");
    await waitForBoot(page);
    await openRail(page, "rail-layers", "layers");
    await expect(page.locator(".season-filter")).toHaveClass(/is-ready/);

    const status = page.locator(".layer-row", { hasText: "Burned this year" }).locator(".layer-count");
    const play = page.locator(".season-play .scrub-play");
    await expect(play).toBeVisible();
    await expect(play).toBeEnabled();
    await expect(status).not.toContainText("up to");

    await play.click();
    // Deliberately generic: playback has advanced an unknown number of days by
    // the time this polls, so pinning the floor's own day/count would be flaky.
    // What is pinned is the shape — a day, a fire count and a footprint.
    await expect(status).toContainText(/up to \d+ \w+ · \d+ fires? · [\d,]+ km² footprint/);
    await expect(page.locator(".season-play .scrub-range")).toHaveAttribute("aria-valuetext", /^up to /);
    await play.click(); // pause
    await expect(play).toHaveAttribute("aria-label", "Play the season");
    const paused = await status.textContent();
    await page.waitForTimeout(1000);
    await expect(status).toHaveText(paused!);

    await page.locator(".season-range").fill("3");
    await expect(status).not.toContainText("up to");
  });
});

/**
 * Clicking burned ground.
 *
 * The whole chain is invisible to jsdom: a cell has to be RENDERED for
 * queryRenderedFeatures to return it, the click has to survive the dispatcher's
 * precedence order, and the card is built from a file (the permanent track
 * archive) nothing else on the overview fetches. Both tests drive the built
 * bundle at the zoom a reader would be at.
 */
function routeArchive(page: import("@playwright/test").Page) {
  return page.route(/\/data\/archive\/tracks\/([\w-]+)\.json$/, async (route: Route) => {
    const id = route.request().url().match(/tracks\/([\w-]+)\.json$/)![1];
    const fire = FIRES.find((f) => f.id === id);
    if (!fire) {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    const cs = gridDisk(latLngToCell(fire.lat, fire.lon, 8), fire.rings);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id,
        series: [{
          bin: `${fire.first}T00:00:00Z`, centroid: [fire.lat, fire.lon],
          new_cells: cs.length, cum_cells: cs.length, frp_sum: 120,
        }],
        cells: cs,
        cell_bins: [[`${fire.first}T00:00:00Z`, cs]],
        frp_live: [],
      }),
    });
  });
}

function routeSeason(page: import("@playwright/test").Page) {
  return page.route(/\/data\/archive\/season_(\d{4})(_sizes|_cells)?\.json$/, async (route: Route) => {
    const [, year, kind] = route.request().url().match(/season_(\d{4})(_sizes|_cells)?\.json$/)!;
    const s = season(Number(year));
    const body = kind === "_cells" ? s.cells : kind === "_sizes" ? s.sizes : s.summary;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}

test.describe("a burned cell opens its fire", () => {
  test("?fire=<archived id> opens the card of a fire that has no scar marker", async ({ page }) => {
    await routeSeason(page);
    await routeArchive(page);

    // Neither a live event nor one of the manifest's scars: the third
    // fallback, straight to the permanent archive.
    await page.goto("/?fire=big");
    await waitForBoot(page);

    await expect(page.locator(".fc-title")).toHaveText("Burn scar · 3 Aug 2026");
    await expect(page.locator(".fc-sub")).toContainText("Past fire");
    await expect(page.locator("#view")).toHaveAttribute("data-view", "detail");
  });

  test("clicking shared ground opens the fire the size filter kept, not the first claimant", async ({ page }) => {
    await routeSeason(page);
    await routeArchive(page);

    // Park the camera on the fire the cheap way — the deep link flies to z10.5
    // and there is no map handle in the built bundle.
    await page.goto("/?fire=big");
    await waitForBoot(page);
    await expect(page.locator(".fc-title")).toHaveText("Burn scar · 3 Aug 2026");
    await page.locator(".fc-close").click();
    await expect(page.locator("#view")).toHaveAttribute("data-view", "map");

    // ≥ 20 km²: "shared" (one cell, 0.7 km²) is filtered out, "big" is not —
    // and their common cell stays painted, because the map paints a cell for
    // its LARGEST claimant. A click there must open big.
    await openRail(page, "rail-layers", "layers");
    await expect(page.locator(".season-filter")).toHaveClass(/is-ready/);
    await page.locator(".season-range").fill("10");
    await expect(page.locator(".season-filter-label")).toContainText("≥ 20 km²");
    await expect(page.locator(".season-filter-label")).not.toContainText("…", { timeout: 15_000 });
    await page.locator("#rail-layers").click();
    await expect(page.locator("#view")).toHaveAttribute("data-view", "map");

    const canvas = (await page.locator("canvas").boundingBox())!;
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);

    // 3 Aug is big; the cell's own fire_id tag is "shared", 5 Aug.
    await expect(page.locator(".fc-title")).toHaveText("Burn scar · 3 Aug 2026");
  });
});
