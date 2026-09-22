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
