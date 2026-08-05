/** @vitest-environment jsdom */
/**
 * The scale page renders three states that must never be confused: a normal
 * season, a zero season (real, and reachable every January), and no data at
 * all. Conflating the last two would either claim data is missing when it is
 * present and correct, or print a confident "0 km²" when we simply do not know.
 */
import { describe, expect, it } from "vitest";
// ?raw rather than node:fs: the web tsconfig is DOM-only with no @types/node,
// and vite/client already declares "*?raw" (see tests/wrangler_routes.test.ts).
import shell from "../scale.html?raw";
import mapShell from "../index.html?raw";
// ?raw, not an import of the config module: importing vite.config pulls in vite
// and therefore esbuild, which throws an invariant error under jsdom.
import viteConfig from "../vite.config.ts?raw";
import entrySource from "../src/scale.ts?raw";
import renderSource from "../src/scale_render.ts?raw";

import { loadSeason } from "../src/scale";
import { renderScale, type SeasonData } from "../src/scale_render";

const DATA: SeasonData = {
  season_year: 2026,
  fetched_at: "2026-07-12T04:11:00+00:00",
  observed_at: null,
  status: "fresh",
  total_km2: 10240.3,
  area_count: 1184,
  min_fire_ha: 30,
  unassigned_count: 3,
  undated_count: 0,
  unit: { name: "Greater London", km2: 1572, count: 6.5 },
  countries: [
    { name: "Spain", km2: 2940.1, areas: 402, unit: { name: "Paris", km2: 105.4, count: 27.9 } },
    { name: "Greece", km2: 1470.0, areas: 210, unit: { name: "Paris", km2: 105.4, count: 13.9 } },
  ],
};

function root(): HTMLElement {
  return document.createElement("div");
}

describe("renderScale", () => {
  it("renders the headline total and the unit sentence", () => {
    const el = root();
    renderScale(el, DATA);
    expect(el.querySelector("[data-state]")?.getAttribute("data-state")).toBe("normal");
    expect(el.textContent).toContain("10,240 km²");
    expect(el.textContent).toContain("6.5 × Greater London");
  });

  it("draws one tile per whole unit plus a partial for the remainder", () => {
    const el = root();
    renderScale(el, DATA);
    expect(el.querySelectorAll("[data-tile]").length).toBe(7);
    expect(el.querySelectorAll('[data-tile="partial"]').length).toBe(1);
  });

  it("draws a countable grid at a smaller unit's magnitude", () => {
    const el = root();
    renderScale(el, { ...DATA, unit: { name: "Paris", km2: 105.4, count: 27.9 } });
    expect(el.querySelectorAll("[data-tile]").length).toBe(28);
  });

  it("draws single whole tiles for an exact count", () => {
    const el = root();
    renderScale(el, { ...DATA, unit: { name: "Paris", km2: 105.4, count: 4 } });
    expect(el.querySelectorAll("[data-tile]").length).toBe(4);
    expect(el.querySelectorAll('[data-tile="partial"]').length).toBe(0);
  });

  it("names the unit in the grid legend so a tile is never a bare square", () => {
    const el = root();
    renderScale(el, DATA);
    expect(el.querySelector(".scale-legend")?.textContent).toContain("Greater London");
    expect(el.querySelector(".scale-legend")?.textContent).toContain("1,572 km²");
  });

  it("renders countries as bars, not grids", () => {
    const el = root();
    renderScale(el, DATA);
    expect(el.querySelectorAll("[data-country]").length).toBe(2);
    expect(el.querySelector("[data-country] [data-tile]")).toBeNull();
    expect(el.textContent).toContain("27.9 × Paris");
  });

  it("shows the minimum-size caveat from data, not hardcoded copy", () => {
    const el = root();
    renderScale(el, { ...DATA, min_fire_ha: 50 });
    expect(el.textContent).toContain("50 ha");
    expect(el.textContent).not.toContain("30 ha");
  });

  it("renders the as-of date from fetched_at", () => {
    const el = root();
    renderScale(el, DATA);
    expect(el.querySelector("[data-asof]")?.textContent).toContain("12 Jul 2026");
  });

  it("renders a zero season as its own state, with no grid", () => {
    const el = root();
    renderScale(el, { ...DATA, total_km2: 0, area_count: 0, unit: null, countries: [] });
    expect(el.querySelector("[data-state]")?.getAttribute("data-state")).toBe("zero");
    expect(el.querySelectorAll("[data-tile]").length).toBe(0);
    expect(el.textContent).toContain("No mapped burned areas");
    // The caveats explain WHY a zero can be a zero, so they survive this state.
    expect(el.textContent).toContain("30 ha");
  });

  it("never prints a number in the zero state that could be read as a total", () => {
    const el = root();
    renderScale(el, { ...DATA, total_km2: 0, area_count: 0, unit: null, countries: [] });
    expect(el.textContent).not.toContain("0 km²");
    expect(el.textContent).not.toContain("×");
  });

  it("still reports a real total whose unit could not be computed", () => {
    // run.py:170 wraps _attach_units in _safe(..., default=None), so a pick_unit
    // failure leaves `unit` absent under a positive total and export emits null.
    // Routing the zero copy on the unit would deny a season that happened.
    const el = root();
    renderScale(el, { ...DATA, unit: null });
    expect(el.querySelector("[data-state]")?.getAttribute("data-state")).toBe("normal");
    expect(el.textContent).toContain("10,240 km²");
    expect(el.textContent).not.toContain("No mapped burned areas");
    // No unit means no honest grid — but the number still stands.
    expect(el.querySelectorAll("[data-tile]").length).toBe(0);
  });

  it("renders missing data as unavailable, never as a zero", () => {
    const el = root();
    renderScale(el, null);
    expect(el.querySelector("[data-state]")?.getAttribute("data-state")).toBe("unavailable");
    expect(el.querySelectorAll("[data-tile]").length).toBe(0);
    expect(el.textContent).toContain("unavailable");
    expect(el.textContent).not.toContain("0 km²");
  });

  it("still renders a country whose area rounded below its own unit", () => {
    // season_totals rounds each country independently, so a country made of a
    // few small perimeters lands at 0.0 km² and _attach_units leaves its `unit`
    // key ABSENT. The row must degrade, not throw.
    const el = root();
    renderScale(el, {
      ...DATA,
      countries: [
        ...DATA.countries,
        { name: "Malta", km2: 0, areas: 1 } as SeasonData["countries"][number],
      ],
    });
    expect(el.querySelectorAll("[data-country]").length).toBe(3);
    expect(el.textContent).toContain("Malta");
  });

  it("escapes names that reach innerHTML", () => {
    const el = root();
    renderScale(el, {
      ...DATA,
      unit: { name: "<img src=x onerror=alert(1)>", km2: 1572, count: 2 },
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("skips an uncountable grid rather than emitting thousands of tiles", () => {
    const el = root();
    renderScale(el, { ...DATA, unit: { name: "Gibraltar", km2: 6.8, count: 50000 } });
    expect(el.querySelectorAll("[data-tile]").length).toBe(0);
    // The count itself is still stated: the grid is a reading aid, not the fact.
    expect(el.textContent).toContain("50,000 × Gibraltar");
  });

  it("draws a partial tile for a real total too small to fill one", () => {
    // pick_unit rounds count to one decimal, so a 0.1 km² season lands on
    // {Gibraltar, count: 0.0} — a normal state whose grid would otherwise be
    // empty. Something burned; the grid has to show something.
    const el = root();
    renderScale(el, {
      ...DATA,
      total_km2: 0.1,
      unit: { name: "Gibraltar", km2: 6.8, count: 0 },
    });
    expect(el.querySelector("[data-state]")?.getAttribute("data-state")).toBe("normal");
    expect(el.querySelectorAll('[data-tile="partial"]').length).toBe(1);
  });

  it("replaces prior content instead of appending on a re-render", () => {
    const el = root();
    renderScale(el, DATA);
    renderScale(el, DATA);
    expect(el.querySelectorAll("[data-state]").length).toBe(1);
  });
});

/**
 * `status` was declared on SeasonData and read by nothing, so the page had no
 * channel at all for "EFFIS was unreachable". With the as-of date now honest
 * (it is the snapshot's poll time, not the export clock), a failed run shows a
 * date that quietly stops moving and says nothing about why.
 *
 * Both directions are asserted. A test that only checks the stale case passes
 * just as well against a line rendered unconditionally, which would tell every
 * reader of a perfectly healthy page that the data could not be fetched.
 */
describe("reachability", () => {
  it("says so when EFFIS could not be reached", () => {
    const el = root();
    renderScale(el, { ...DATA, status: "stale" });
    expect(el.querySelector("[data-stale]")).not.toBeNull();
    expect(el.querySelector("[data-stale]")?.textContent).toContain("could not be reached");
    expect(el.textContent).toContain("may be incomplete");
  });

  it("stays silent on a healthy run", () => {
    for (const status of ["fresh", "reused"]) {
      const el = root();
      renderScale(el, { ...DATA, status });
      expect(el.querySelector("[data-stale]")).toBeNull();
      expect(el.textContent).not.toContain("could not be reached");
    }
  });

  it("keeps the warning next to the date it qualifies", () => {
    // The date is the thing the warning is about: a stale run's "as of" is
    // precisely the date that stopped advancing. Split apart, a reader can
    // take the date at face value and never meet the caveat.
    const el = root();
    renderScale(el, { ...DATA, status: "stale" });
    const asof = el.querySelector("[data-asof]");
    expect(asof?.textContent).toContain("12 Jul 2026");
    expect(asof?.querySelector("[data-stale]")).not.toBeNull();
  });

  it("still warns over a zero total, where a failed fetch matters most", () => {
    const el = root();
    renderScale(el, {
      ...DATA, status: "stale", total_km2: 0, area_count: 0, unit: null, countries: [],
    });
    expect(el.querySelector("[data-state]")?.getAttribute("data-state")).toBe("zero");
    expect(el.querySelector("[data-stale]")).not.toBeNull();
  });
});

/**
 * The caption has to state the scope the number was actually computed over.
 * season.py's allowlist deliberately omits Russia and Turkey — EFFIS covers
 * both — so their area lands in `unassigned_count`. A caption reading only
 * "Burned in Europe" over that total claims more than the figure supports, and
 * an exclusion line reading "excluded for a missing size or country" reports
 * that deliberate scope as if it were data we had lost.
 */
describe("scope", () => {
  it("states the exclusions in the caption, not just 'Europe'", () => {
    const el = root();
    renderScale(el, DATA);
    const kicker = el.querySelector(".scale-kicker")?.textContent?.replace(/\s+/g, " ");
    expect(kicker).toContain("excluding Russia and Turkey");
    expect(kicker).toContain("2026 season");
  });

  it("captions the zero state with the same scope", () => {
    const el = root();
    renderScale(el, { ...DATA, total_km2: 0, area_count: 0, unit: null, countries: [] });
    expect(el.querySelector(".scale-kicker")?.textContent?.replace(/\s+/g, " "))
      .toContain("excluding Russia and Turkey");
  });

  it("does not report deliberately out-of-scope countries as missing data", () => {
    const el = root();
    renderScale(el, DATA);
    const text = el.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).not.toContain("excluded for a missing size or country");
    // Names them, so a reader can tell chosen scope from a genuine gap.
    expect(text).toContain("Russia, Turkey and North Africa");
    expect(text).toContain("3 mapped areas");
  });

  it("omits the exclusion line entirely when nothing was excluded", () => {
    const el = root();
    renderScale(el, { ...DATA, unassigned_count: 0 });
    const text = el.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).not.toContain("Russia, Turkey and North Africa");
    expect(text).not.toContain("mapped areas sit outside");
  });
});

/**
 * The page only exists if the build emits it and something links to it.
 *
 * wrangler.jsonc sets not_found_handling to "single-page-application", so a
 * scale page that failed to build is not a 404 — the asset layer answers with
 * index.html and a 200, and every test above still passes against a map that is
 * not this page. No URL spelling defends against that (html_handling defaults to
 * auto-trailing-slash, so /scale is canonical and /scale.html merely 307s onto
 * it; both resolve, and both fall through identically when the asset is gone).
 * The defence has to be here, at build time. These guard the three ways the page
 * can silently cease to exist: the entry dropped, the mount point drifting, and
 * the last link to it disappearing.
 */
describe("scale page shell", () => {
  it("declares scale.html as a build entry, so it is emitted at all", () => {
    // Matched on the entry declaration, not the bare filename: the explanatory
    // comment in vite.config.ts also says "scale.html", so a plain substring
    // check would still pass with the entry itself deleted.
    expect(viteConfig).toMatch(/\bscale:\s*entry\(\s*["']\.\/scale\.html["']\s*\)/);
    // The key is "index", not "main": it names the emitted chunk, and CI's
    // maplibre assertion locates the map's entry by globbing index-*.js.
    // Renaming this key renames that chunk and the glob silently matches
    // nothing, so the assertion resolves its directory to "." and reports a
    // missing worker instead of a renamed file.
    expect(viteConfig).toMatch(/\bindex:\s*entry\(\s*["']\.\/index\.html["']\s*\)/);
  });

  it("mounts the root that scale.ts renders into", () => {
    expect(shell).toContain('id="scale"');
    expect(shell).toContain("/src/scale.ts");
  });

  it("is not the map shell", () => {
    expect(shell).not.toContain('id="map"');
  });

  it("never imports maplibre", () => {
    // The build output already shows the split (scale-*.js is ~4 kB against the
    // map's ~1 MB), but that is only checked when someone reads a build log.
    // ?raw rather than the brief's node:fs: the web tsconfig is DOM-only with
    // no @types/node, so readFileSync would not typecheck.
    //
    // DIRECT imports only. A future module imported by these two that pulls
    // maplibre itself would pass this and still bloat the bundle; the build log
    // remains the check for transitive weight.
    expect(renderSource).not.toContain("maplibre");
    expect(entrySource).not.toContain("maplibre");
  });

  it("is linked from the map, or it is unreachable", () => {
    // The page shipped once with nothing pointing at it. A build guard does not
    // help when the asset is fine and simply has no door.
    expect(mapShell).toContain('id="scale-link"');
    expect(mapShell).toMatch(/<a[^>]*id="scale-link"[^>]*href="\/scale"|<a[^>]*href="\/scale"[^>]*id="scale-link"/);
  });
});

/**
 * loadSeason decides which of the three states the page will be in, so its
 * failure modes matter as much as the rendering. Every one of them must resolve
 * to null — "unavailable" — and never to a fabricated zero.
 */
describe("loadSeason", () => {
  const MANIFEST = {
    generation: "gen-1",
    layers: { season: { fetched_at: "2026-07-12T04:11:00+00:00", observed_at: null } },
  };
  const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

  it("fetches season.json from the generation the manifest names", async () => {
    const seen: string[] = [];
    const data = await loadSeason("/data", (async (url: string) => {
      seen.push(url);
      return ok(url.endsWith("manifest.json") ? MANIFEST : DATA);
    }) as unknown as typeof fetch);
    expect(seen).toEqual(["/data/manifest.json", "/data/gen-1/season.json"]);
    expect(data?.total_km2).toBe(10240.3);
  });

  it("does not even ask for a payload the manifest says was not written", async () => {
    // export.py sets season.fetched_at only when season.json was actually
    // written, so a null here is a definite no rather than a guess.
    const seen: string[] = [];
    const data = await loadSeason("/data", (async (url: string) => {
      seen.push(url);
      return ok({ generation: "gen-1", layers: { season: { fetched_at: null } } });
    }) as unknown as typeof fetch);
    expect(data).toBeNull();
    expect(seen).toEqual(["/data/manifest.json"]);
  });

  it("still tries when the manifest predates the season layer", async () => {
    const seen: string[] = [];
    await loadSeason("/data", (async (url: string) => {
      seen.push(url);
      return ok(url.endsWith("manifest.json") ? { generation: "gen-1", layers: {} } : DATA);
    }) as unknown as typeof fetch);
    expect(seen).toContain("/data/gen-1/season.json");
  });

  it("resolves to unavailable, not a zero, when season.json is missing", async () => {
    const data = await loadSeason("/data", (async (url: string) =>
      url.endsWith("manifest.json")
        ? ok(MANIFEST)
        : ({ ok: false, status: 404 } as unknown as Response)) as unknown as typeof fetch);
    expect(data).toBeNull();
  });

  it("resolves to unavailable when the fetch itself throws", async () => {
    const data = await loadSeason("/data", (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(data).toBeNull();
  });
});
