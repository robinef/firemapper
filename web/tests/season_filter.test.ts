// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cellArea, cellToParent, gridDisk, latLngToCell, UNITS } from "h3-js";
import {
  SIZE_EDGES,
  NWCG_TICKS,
  aggregate,
  binIndex,
  createSeasonFilter,
  dedupNested,
  filterLabel,
  fireSizes,
  histogram,
  isEuFire,
  thresholdFor,
  tickPos,
} from "../src/season_filter";
import type { FiresSummary, SeasonCells } from "../src/types";

const km2 = (c: string) => cellArea(c, UNITS.km2);
const r1 = (v: number) => Math.round(v * 10) / 10;

const a = latLngToCell(45.0, 5.0, 8);
const b = latLngToCell(45.0, 5.02, 8);
const far = latLngToCell(52.0, 13.0, 8);
const entry = (cells: string[], first = "2026-07-01") => ({ digest: "d", first, cells });

/** Stands in for the control's debounce: holds the pending aggregation so a
 * test decides when it runs, with no real timer anywhere near the suite. */
function manualScheduler() {
  let pending: (() => void) | null = null;
  return {
    schedule: (fn: () => void) => { pending = fn; },
    flush: () => { const f = pending; pending = null; f?.(); },
  };
}

describe("fireSizes", () => {
  it("sums the real area of each fire's unique cells", () => {
    const sizes = fireSizes({ f1: entry([a, b]), f2: entry([far]) });
    expect(sizes.get("f1")).toBeCloseTo(km2(a) + km2(b), 6);
    expect(sizes.get("f2")).toBeCloseTo(km2(far), 6);
  });
  it("counts a cell listed twice in one fire once", () => {
    const sizes = fireSizes({ f1: entry([a, a]) });
    expect(sizes.get("f1")).toBeCloseTo(km2(a), 6);
  });
});

describe("bins", () => {
  it("has the spec's 16 edges", () => {
    expect(SIZE_EDGES).toEqual([0.5, 0.7, 1, 1.5, 2, 3, 4, 6, 10, 15, 20, 30, 50, 100, 200, 600]);
  });
  it("binIndex places values on the edge in the upper bin and caps at the last bin", () => {
    expect(binIndex(0.4)).toBe(-1);
    expect(binIndex(0.5)).toBe(0);
    expect(binIndex(0.69)).toBe(0);
    expect(binIndex(0.7)).toBe(1);
    expect(binIndex(4)).toBe(6);
    expect(binIndex(599)).toBe(14);
    expect(binIndex(600)).toBe(14);
    expect(binIndex(5000)).toBe(14);
  });
  it("histogram counts fires per bin and ignores sub-0.5 fires", () => {
    const h = histogram(new Map([["x", 0.4], ["y", 0.5], ["z", 3.5], ["w", 700]]));
    expect(h).toHaveLength(15);
    expect(h[0]).toBe(1);
    expect(h[5]).toBe(1);
    expect(h[14]).toBe(1);
    expect(h.reduce((s, n) => s + n, 0)).toBe(3);
  });
  it("thresholdFor maps index 0 to everything and index i to edge i", () => {
    expect(thresholdFor(0)).toBe(0);
    expect(thresholdFor(1)).toBe(0.7);
    expect(thresholdFor(6)).toBe(4);
    expect(thresholdFor(15)).toBe(600);
  });
});

describe("dedupNested", () => {
  it("drops a parent whose child is present and keeps unrelated cells", () => {
    const parent = cellToParent(a, 7);
    const out = dedupNested(new Set([parent, a, far]));
    expect([...out].sort()).toEqual([a, far].sort());
  });
  it("keeps a coarser cell that is not an ancestor of any present cell", () => {
    const lone = latLngToCell(20.0, 20.0, 7);
    const out = dedupNested(new Set([lone, far]));
    expect([...out].sort()).toEqual([lone, far].sort());
  });
});

describe("aggregate", () => {
  // Distinct first-detection dates, deliberately NOT in size order: the floor
  // has to follow which fires are kept, and the smallest fire here is also the
  // earliest, so any filter that drops it must move the date.
  const cells: SeasonCells = {
    small: entry([a], "2026-03-04"),
    big: entry([...gridDisk(far, 1)], "2026-08-12"), // 7 cells ≈ 5 km²
    shared: entry([a, b], "2026-05-19"), // shares `a` with `small`
  };
  const sizes = fireSizes(cells);

  it("at threshold 0 counts shared ground once and rolls up to res 6", () => {
    const agg = aggregate(cells, sizes, 0);
    expect(agg.threshold).toBe(0);
    expect(agg.fires).toBe(3);
    const union = new Set([a, b, ...gridDisk(far, 1)]);
    const expected = new Map<string, number>();
    for (const c of union) {
      const p = cellToParent(c, 6);
      expected.set(p, (expected.get(p) ?? 0) + km2(c));
    }
    const want = [...expected.entries()].map(([p, v]) => [p, r1(v)] as [string, number]).sort();
    expect(agg.r6).toEqual(want);
    expect(agg.km2).toBe(r1(want.reduce((s, [, v]) => s + v, 0)));
  });

  it("drops fires below the threshold and keeps the ones on it", () => {
    const t = sizes.get("shared")!;
    const agg = aggregate(cells, sizes, t);
    expect(agg.fires).toBe(2); // shared (== t) and big (> t)
    const flat = agg.r6.map(([c]) => c);
    expect(flat).toContain(cellToParent(far, 6));
  });

  it("applies the nested-parent rule inside one fire", () => {
    const parent = cellToParent(a, 7);
    const one: SeasonCells = { p: entry([parent, a]) };
    const agg = aggregate(one, fireSizes(one), 0);
    expect(agg.r6).toEqual([[cellToParent(a, 6), r1(km2(a))]]);
    expect(fireSizes(one).get("p")).toBeCloseTo(km2(a), 6);
  });

  it("does NOT dedup a parent from one fire against a child from another — pipeline parity", () => {
    const parent = cellToParent(a, 7);
    const two: SeasonCells = { p: entry([parent]), c: entry([a]) };
    const agg = aggregate(two, fireSizes(two), 0);
    // pipeline/export_season.py::aggregate_r6 dedups per fire, then unions:
    // both cells survive, so the hex carries parent + child area.
    expect(agg.r6).toEqual([[cellToParent(a, 6), r1(km2(parent) + km2(a))]]);
  });

  it("empty selection yields no hexes and zero totals", () => {
    const agg = aggregate(cells, sizes, 1e9);
    expect(agg).toEqual({ threshold: 1e9, r6: [], fires: 0, km2: 0, scope: "all", floor: null });
  });

  // The status line reads "… since <floor>". The floor has to describe the
  // fires whose numbers stand beside it: a date from a fire the filter dropped
  // claims a season that started earlier than the one on screen.
  describe("floor", () => {
    it("is the earliest first-detection among the kept fires", () => {
      expect(aggregate(cells, sizes, 0).floor).toBe("2026-03-04");
    });

    it("moves when the threshold drops the earliest fire", () => {
      // `small` (2026-03-04) is under the threshold; `shared` and `big` remain.
      const agg = aggregate(cells, sizes, sizes.get("shared")!);
      expect(agg.fires).toBe(2);
      expect(agg.floor).toBe("2026-05-19");
    });

    it("moves when `keep` drops the earliest fire", () => {
      // Same threshold-0 selection as above minus one fire: the floor follows
      // the scope predicate too, not just the size slider.
      const agg = aggregate(cells, sizes, 0, (id) => id !== "small");
      expect(agg.fires).toBe(2);
      expect(agg.floor).toBe("2026-05-19");
    });

    it("keeps the earliest of the survivors when a LATER fire is dropped", () => {
      expect(aggregate(cells, sizes, 0, (id) => id !== "big").floor).toBe("2026-03-04");
    });

    it("is null when nothing is kept", () => {
      expect(aggregate(cells, sizes, 1e9).floor).toBeNull();
      expect(aggregate(cells, sizes, 0, () => false).floor).toBeNull();
    });
  });

  it("carries the scope it was given, and defaults to 'all'", () => {
    expect(aggregate(cells, sizes, 0).scope).toBe("all");
    expect(aggregate(cells, sizes, 0, undefined, "eu").scope).toBe("eu");
  });

  // The country scope is a second filter on the SAME loop, so a fire the
  // predicate rejects must vanish from the count, the union and the km² —
  // not merely be hidden on the map.
  it("with a keep predicate only the kept fires reach the count, the hexes and the total", () => {
    const all = aggregate(cells, sizes, 0);
    const kept = aggregate(cells, sizes, 0, (id) => id !== "big");
    expect(kept.fires).toBe(2);
    const union = new Set([a, b]);
    const expected = new Map<string, number>();
    for (const c of union) {
      const p = cellToParent(c, 6);
      expected.set(p, (expected.get(p) ?? 0) + km2(c));
    }
    const want = [...expected.entries()].map(([p, v]) => [p, r1(v)] as [string, number]).sort();
    expect(kept.r6).toEqual(want);
    expect(kept.km2).toBe(r1(want.reduce((s, [, v]) => s + v, 0)));
    expect(kept.km2).toBeLessThan(all.km2);
    expect(kept.r6.map(([c]) => c)).not.toContain(cellToParent(far, 6));
  });

  it("keep and threshold compose: a fire must pass both", () => {
    const t = sizes.get("shared")!;
    const kept = aggregate(cells, sizes, t, (id) => id !== "big");
    expect(kept.fires).toBe(1); // `shared` alone: `big` is dropped, `small` is under t
  });
});

describe("EU-27 membership", () => {
  const summary: FiresSummary = {
    es: { country: "ES", area_km2: 3 },
    ua: { country: "UA", area_km2: 9 },
    nowhere: { country: null, area_km2: 1 },
  };

  // The membership itself is tested in tests/eu27.test.ts, where it lives.
  // What belongs here is the fire-shaped question this module answers on top
  // of it.
  it("is true only for a fire whose known country is a member state", () => {
    expect(isEuFire(summary, "es")).toBe(true);
    expect(isEuFire(summary, "ua")).toBe(false);
    expect(isEuFire(summary, "nowhere")).toBe(false); // country unknown ≠ EU
    expect(isEuFire(summary, "not-in-the-file")).toBe(false);
    expect(isEuFire(null, "es")).toBe(false); // no countries file, no EU claim
  });
});

describe("filterLabel", () => {
  it("reads 'all sizes' at index 0 and '≥ t km²' otherwise, and names the km² a footprint", () => {
    expect(filterLabel(0, { fires: 21672, km2: 60471.6 })).toBe("all sizes · 21,672 fires · 60,472 km² footprint");
    expect(filterLabel(6, { fires: 4355, km2: 54229.4 })).toBe("≥ 4 km² · 4,355 fires · 54,229 km² footprint");
    expect(filterLabel(1, { fires: 1, km2: 0.7 })).toBe("≥ 0.7 km² · 1 fires · 1 km² footprint");
  });

  it("prefixes the EU-27 scope, and only that scope", () => {
    expect(filterLabel(0, { fires: 21867, km2: 60891 }, "eu")).toBe("EU-27 · all sizes · 21,867 fires · 60,891 km² footprint");
    expect(filterLabel(6, { fires: 1203, km2: 9812 }, "eu")).toBe("EU-27 · ≥ 4 km² · 1,203 fires · 9,812 km² footprint");
    expect(filterLabel(6, { fires: 1203, km2: 9812 }, "all")).toBe("≥ 4 km² · 1,203 fires · 9,812 km² footprint");
  });
});

describe("histogram with a keep predicate", () => {
  it("counts only the kept fires, leaving the rejected ones' bins empty", () => {
    const sizes = new Map([["x", 0.6], ["y", 3.5], ["z", 3.6]]);
    const all = histogram(sizes);
    expect(all[binIndex(0.6)]).toBe(1);
    expect(all[binIndex(3.5)]).toBe(2);
    const kept = histogram(sizes, (id) => id !== "x" && id !== "z");
    expect(kept[binIndex(0.6)]).toBe(0);
    expect(kept[binIndex(3.5)]).toBe(1);
    expect(kept.reduce((s, n) => s + n, 0)).toBe(1);
  });
});

describe("tickPos", () => {
  it("maps edge and interior km² values to bin-interpolated positions on the histogram", () => {
    expect(tickPos(0.5)).toBe(0);
    expect(tickPos(0.3)).toBe(0);
    expect(tickPos(600)).toBe(1);
    expect(tickPos(20)).toBeCloseTo(10 / 15, 9);
  });
  it("in the rendered control, tick style.left matches tickPos computation", () => {
    const sched = manualScheduler();
    const el = document.createElement("div");
    const filter = createSeasonFilter({ onAggregate: vi.fn(), schedule: sched.schedule });
    filter.control(el);
    const spans = [...el.querySelectorAll<HTMLElement>(".season-ticks span")];
    const g = spans.find((s) => s.textContent === "G")!;
    expect(g.style.left).toBe(`${(tickPos(20.2) * 100).toFixed(1)}%`);
    const e = spans.find((s) => s.textContent === "E")!;
    expect(e.style.left).toBe(`${(tickPos(1.2) * 100).toFixed(1)}%`);
  });
});

describe("createSeasonFilter control", () => {
  // `l` is both the biggest fire and the earliest — and (below) the only one
  // outside the EU-27, so every filter that drops it also has to move the
  // floor date the status line prints.
  const cells: SeasonCells = {
    s: entry([a], "2026-06-02"),
    m: entry([a, b, far], "2026-04-21"),
    l: entry([...gridDisk(far, 2)], "2026-02-09"), // 19 cells ≈ 13 km²
  };
  const sizes = fireSizes(cells);

  function mount(schedule?: (fn: () => void) => void) {
    const onAggregate = vi.fn();
    const filter = createSeasonFilter({ onAggregate, schedule });
    const el = document.createElement("div");
    filter.control(el);
    return { filter, el, onAggregate };
  }

  it("renders disabled with 'loading sizes…' before cells arrive", () => {
    const sched = manualScheduler();
    const { el } = mount(sched.schedule);
    expect(el.querySelector(".season-filter")?.classList.contains("is-loading")).toBe(true);
    expect(el.querySelector<HTMLInputElement>(".season-range")?.disabled).toBe(true);
    expect(el.querySelector(".season-filter-label")?.textContent).toBe("loading sizes…");
    expect(el.querySelectorAll(".season-hist rect")).toHaveLength(15);
    expect(el.querySelectorAll(".season-ticks span")).toHaveLength(NWCG_TICKS.length);
    expect(el.querySelector(".season-ticks")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("after setCells the slider enables and a threshold-0 aggregation gives the label its totals", () => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    const box = el.querySelector(".season-filter")!;
    expect(box.classList.contains("is-loading")).toBe(false);
    expect(el.querySelector<HTMLInputElement>(".season-range")?.disabled).toBe(false);
    expect(filter.summary()).toBeNull(); // aggregation is scheduled, not run inline
    sched.flush();
    expect(onAggregate).toHaveBeenCalledTimes(1);
    const agg = aggregate(cells, sizes, 0);
    expect(filter.summary()).toEqual({ fires: agg.fires, km2: agg.km2, floor: agg.floor });
    // Shared cell `a` counted once: the label's km² is the deduped total, the
    // same number the status line shows — never two numbers in the panel.
    expect(el.querySelector(".season-filter-label")?.textContent).toBe(filterLabel(0, agg));
  });

  it("moving the slider updates label and dimming at once, aggregates after the debounce", () => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    const range = el.querySelector<HTMLInputElement>(".season-range")!;
    range.value = "6"; // ≥ 4 km²
    range.dispatchEvent(new Event("input"));
    expect(el.querySelector(".season-filter-label")?.textContent?.startsWith("≥ 4 km² · …")).toBe(true);
    const rects = [...el.querySelectorAll(".season-hist rect")];
    expect(rects.slice(0, 6).every((r) => r.classList.contains("dim"))).toBe(true);
    expect(rects.slice(6).some((r) => r.classList.contains("dim"))).toBe(false);
    expect(rects.slice(0, 6).some((r) => r.classList.contains("hi"))).toBe(false);
    expect(rects.slice(6).every((r) => r.classList.contains("hi"))).toBe(true);
    expect(onAggregate).not.toHaveBeenCalled();
    sched.flush();
    expect(onAggregate).toHaveBeenCalledTimes(1);
    const agg = onAggregate.mock.calls[0][0] as { threshold: number; fires: number };
    expect(agg.threshold).toBe(4);
    expect(agg.fires).toBe(1); // only `l` (~13 km²)
    expect(filter.threshold()).toBe(4);
    expect(filter.summary()?.fires).toBe(1);
    expect(el.querySelector(".season-filter-label")?.textContent).toBe(filterLabel(6, filter.summary()!));
  });

  it("two rapid inputs produce one aggregation", () => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    const range = el.querySelector<HTMLInputElement>(".season-range")!;
    range.value = "3"; range.dispatchEvent(new Event("input"));
    range.value = "6"; range.dispatchEvent(new Event("input"));
    sched.flush();
    expect(onAggregate).toHaveBeenCalledTimes(1);
    expect((onAggregate.mock.calls[0][0] as { threshold: number }).threshold).toBe(4);
  });

  it("re-rendering into a fresh container keeps the threshold and totals", () => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    const range = el.querySelector<HTMLInputElement>(".season-range")!;
    range.value = "6"; range.dispatchEvent(new Event("input"));
    sched.flush();
    const fresh = document.createElement("div");
    filter.control(fresh);
    expect(fresh.querySelector<HTMLInputElement>(".season-range")?.value).toBe("6");
    expect(fresh.querySelector(".season-filter-label")?.textContent).toBe(el.querySelector(".season-filter-label")?.textContent);
    expect(onAggregate).toHaveBeenCalledTimes(1); // a re-render never re-aggregates
  });

  it("setUnavailable disables the slider and says so", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setUnavailable();
    expect(el.querySelector(".season-filter")?.classList.contains("is-unavailable")).toBe(true);
    expect(el.querySelector<HTMLInputElement>(".season-range")?.disabled).toBe(true);
    expect(el.querySelector(".season-filter-label")?.textContent).toBe("sizes unavailable");
  });

  it("bar heights scale to the fullest bin", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    const rects = [...el.querySelectorAll<SVGRectElement>(".season-hist rect")];
    const heights = rects.map((r) => Number(r.getAttribute("height")));
    expect(Math.max(...heights)).toBe(40);
    expect(heights.filter((h) => h > 0)).toHaveLength(3); // three fires in three bins
  });

  // The distribution is a power law: the 0.5–0.7 km² bin holds thousands of
  // fires and the 200 km²+ bin holds a handful. Rounded against that maximum
  // the tail is 0 px — the histogram would tell the reader no fire above
  // 100 km² burned, while the slider's whole point is to isolate those. A
  // non-zero count always gets at least one pixel; an EMPTY bin stays empty,
  // because "rare" and "none" must not look the same either.
  it("a rare bin beside a huge one still paints a pixel, an empty bin still paints nothing", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    const many = new Map<string, number>();
    for (let i = 0; i < 1000; i += 1) many.set(`small-${i}`, 0.6); // bin 0
    many.set("huge", 300); // bin 13 (200–600 km²)
    filter.setCells({}, many);
    const heights = [...el.querySelectorAll<SVGRectElement>(".season-hist rect")]
      .map((r) => Number(r.getAttribute("height")));
    expect(heights[0]).toBe(40);
    expect(heights[binIndex(300)]).toBeGreaterThanOrEqual(1);
    expect(heights[binIndex(3)]).toBe(0); // nothing in 3–4 km²
  });

  // The bug this pins: once a first aggregate exists, labelText() used to fall
  // straight through to filterLabel(index, last) — the NEW threshold beside the
  // PREVIOUS threshold's totals — for the whole debounce window, and
  // aria-valuetext announced that never-true pairing to a screen reader as the
  // settled value of the step.
  it("shows the placeholder, not the previous threshold's totals, while a move is pending", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    sched.flush(); // the threshold-0 aggregate now exists
    const zero = aggregate(cells, sizes, 0);
    expect(el.querySelector(".season-filter-label")?.textContent).toBe(filterLabel(0, zero));

    const range = el.querySelector<HTMLInputElement>(".season-range")!;
    range.value = "6"; // ≥ 4 km²
    range.dispatchEvent(new Event("input"));
    // NOT flushed: the aggregation for 4 km² has not run.
    const pending = el.querySelector(".season-filter-label")?.textContent;
    expect(pending).toBe("≥ 4 km² · …");
    expect(range.getAttribute("aria-valuetext")).toBe(pending);
    // The stale totals must not appear anywhere in the announced string.
    expect(pending).not.toContain(String(zero.fires));

    sched.flush();
    expect(el.querySelector(".season-filter-label")?.textContent).toBe(filterLabel(6, filter.summary()!));
    expect(range.getAttribute("aria-valuetext")).toBe(filterLabel(6, filter.summary()!));
  });

  it("returning to index 0 while pending shows the count placeholder, not the old totals", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    const range = el.querySelector<HTMLInputElement>(".season-range")!;
    range.value = "6"; range.dispatchEvent(new Event("input"));
    sched.flush(); // `last` now describes 4 km²
    range.value = "0"; range.dispatchEvent(new Event("input"));
    expect(el.querySelector(".season-filter-label")?.textContent)
      .toBe(`all sizes · ${sizes.size.toLocaleString("en-GB")} fires`);
  });

  // Every bin is 0 before setCells, so a height-proportional bar is invisible:
  // the control rendered as an empty box under three orphan tick letters.
  it("draws full-height skeleton bars while loading and while unavailable", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    const heights = () =>
      [...el.querySelectorAll<SVGRectElement>(".season-hist rect")].map((r) => Number(r.getAttribute("height")));
    expect(heights()).toHaveLength(15);
    expect(heights().every((h) => h === 40)).toBe(true);

    filter.setCells(cells, sizes);
    const real = heights();
    expect(real.some((h) => h < 40)).toBe(true); // real counts, not a skeleton
    expect(real.filter((h) => h === 0).length).toBeGreaterThan(0);

    // Unavailable, re-rendered into a fresh container the way the layer panel
    // rebuilds it on the next moveend — the branch that actually re-runs the
    // bar maths with a non-ready status.
    const other = createSeasonFilter({ onAggregate: vi.fn(), schedule: sched.schedule });
    other.control(document.createElement("div"));
    other.setUnavailable();
    const fresh = document.createElement("div");
    other.control(fresh);
    expect(fresh.querySelector(".season-filter")?.classList.contains("is-unavailable")).toBe(true);
    const un = [...fresh.querySelectorAll<SVGRectElement>(".season-hist rect")].map((r) => Number(r.getAttribute("height")));
    expect(un.every((h) => h === 40)).toBe(true);
  });

  it("range input has correct attributes", () => {
    const sched = manualScheduler();
    const { el } = mount(sched.schedule);
    const range = el.querySelector<HTMLInputElement>(".season-range");
    expect(range?.getAttribute("min")).toBe("0");
    expect(range?.getAttribute("max")).toBe("15");
    expect(range?.getAttribute("step")).toBe("1");
  });

  // The scope toggle. `l` is the only fire outside the EU-27, and it is the
  // only fire in its size bin — so EU scope must empty that bar, drop the
  // fire count, and shrink the total.
  const countries: FiresSummary = {
    s: { country: "ES", area_km2: 0.4 },
    m: { country: "FR", area_km2: 1.1 },
    l: { country: "UA", area_km2: 9.0 },
  };
  const scopeButtons = (el: HTMLElement) => ({
    all: el.querySelector<HTMLButtonElement>('.season-scope button[data-scope="all"]')!,
    eu: el.querySelector<HTMLButtonElement>('.season-scope button[data-scope="eu"]')!,
  });
  const heights = (el: HTMLElement) =>
    [...el.querySelectorAll<SVGRectElement>(".season-hist rect")].map((r) => Number(r.getAttribute("height")));

  it("the EU-27 button is disabled until the countries file lands", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    expect(scopeButtons(el).eu.disabled).toBe(true);
    expect(scopeButtons(el).eu.title).toBe("countries unavailable");
    expect(scopeButtons(el).all.getAttribute("aria-pressed")).toBe("true");
    expect(filter.scope()).toBe("all");
    const group = el.querySelector(".season-scope")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Fire scope");
    // Above the histogram: scope first, then the sizes inside it.
    const kids = [...el.querySelector(".season-filter")!.children].map((c) => c.getAttribute("class"));
    expect(kids.indexOf("season-scope")).toBeLessThan(kids.indexOf("season-hist"));

    filter.setCountries(countries);
    expect(scopeButtons(el).eu.disabled).toBe(false);
    expect(scopeButtons(el).eu.title).toBe("");
  });

  it("setCountries(null) leaves the EU-27 button disabled", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    filter.setCountries(null);
    expect(scopeButtons(el).eu.disabled).toBe(true);
    expect(filter.scope()).toBe("all");
  });

  // A summary with no fires in it is a file that technically parsed and
  // answers "not EU" for every id. Honouring it would offer a scope whose
  // only possible result is an empty map.
  it("setCountries({}) is treated as no countries at all", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    filter.setCountries({});
    expect(scopeButtons(el).eu.disabled).toBe(true);
    expect(scopeButtons(el).eu.title).toBe("countries unavailable");
    const fresh = document.createElement("div");
    filter.control(fresh); // and a rebuild must not resurrect it either
    expect(scopeButtons(fresh).eu.disabled).toBe(true);
  });

  // The scope decides which fires are counted; the count itself needs the
  // cells file. While that file is loading or has given up there is nothing
  // to re-scope, and a pressed EU-27 button beside all-Europe numbers (which
  // is what an early-returning runAggregate leaves behind) is a lie.
  it("both scope buttons follow the filter's ready state", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCountries(countries); // countries fine, cells not here yet
    expect(scopeButtons(el).all.disabled).toBe(true);
    expect(scopeButtons(el).eu.disabled).toBe(true);

    filter.setCells(cells, sizes);
    expect(scopeButtons(el).all.disabled).toBe(false);
    expect(scopeButtons(el).eu.disabled).toBe(false);

    filter.setUnavailable();
    expect(scopeButtons(el).all.disabled).toBe(true);
    expect(scopeButtons(el).eu.disabled).toBe(true);
    // Not a countries problem, so it must not claim to be one.
    expect(scopeButtons(el).eu.title).toBe("");
  });

  it.each([
    ["while the sizes are still loading", (f: ReturnType<typeof createSeasonFilter>) => f.setCountries(countries)],
    ["after the cells gave up", (f: ReturnType<typeof createSeasonFilter>) => {
      f.setCountries(countries);
      f.setUnavailable();
    }],
  ])("a forced click cannot switch scope %s", (_when, prepare) => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    prepare(filter);
    const eu = scopeButtons(el).eu;
    expect(eu.disabled).toBe(true);
    eu.disabled = false; // as a stale attribute after a rebuild would leave it
    eu.click();
    sched.flush();
    expect(filter.scope()).toBe("all");
    expect(eu.classList.contains("on")).toBe(false);
    expect(eu.getAttribute("aria-pressed")).toBe("false");
    expect(onAggregate).not.toHaveBeenCalled();
  });

  // The click re-renders the control, which destroys the button that was
  // clicked. Without moving focus, a keyboard reader lands back on <body>
  // and a screen reader never hears the new pressed state.
  it("keeps focus on the scope button that was clicked", () => {
    const sched = manualScheduler();
    const host = document.createElement("div");
    document.body.append(host);
    const filter = createSeasonFilter({ onAggregate: vi.fn(), schedule: sched.schedule });
    filter.control(host);
    filter.setCells(cells, sizes);
    filter.setCountries(countries);
    scopeButtons(host).eu.click();
    expect(document.activeElement).toBe(scopeButtons(host).eu);
    expect(scopeButtons(host).eu.classList.contains("on")).toBe(true);
    scopeButtons(host).all.click();
    expect(document.activeElement).toBe(scopeButtons(host).all);
    host.remove();
  });

  it("clicking EU-27 re-bins the histogram, prefixes the label and aggregates the EU fires alone", () => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    filter.setCountries(countries);
    sched.flush(); // the all-Europe threshold-0 aggregate
    const allAgg = aggregate(cells, sizes, 0);
    expect(onAggregate).toHaveBeenCalledTimes(1);
    const lBin = binIndex(sizes.get("l")!);
    expect(heights(el)[lBin]).toBeGreaterThan(0);

    scopeButtons(el).eu.click();
    // Bars first: the histogram is the legend for the filter, so it re-bins
    // before the (debounced) aggregation lands.
    expect(heights(el)[lBin]).toBe(0);
    expect(heights(el)[binIndex(sizes.get("s")!)]).toBeGreaterThan(0);
    expect(filter.scope()).toBe("eu");
    expect(scopeButtons(el).eu.classList.contains("on")).toBe(true);
    expect(scopeButtons(el).eu.getAttribute("aria-pressed")).toBe("true");
    expect(scopeButtons(el).all.classList.contains("on")).toBe(false);
    expect(scopeButtons(el).all.getAttribute("aria-pressed")).toBe("false");
    const pending = el.querySelector(".season-filter-label")!.textContent!;
    expect(pending.startsWith("EU-27 · ")).toBe(true);
    // The all-Europe totals belong to a scope that is no longer on screen.
    expect(pending).not.toContain(String(Math.round(allAgg.km2)));
    expect(onAggregate).toHaveBeenCalledTimes(1); // debounced, exactly like the slider

    sched.flush();
    expect(onAggregate).toHaveBeenCalledTimes(2);
    const agg = onAggregate.mock.calls[1][0] as typeof allAgg;
    expect(agg.scope).toBe("eu");
    expect(agg.fires).toBe(2); // s and m; l is in Ukraine
    const expected = new Map<string, number>();
    for (const c of [a, b, far]) {
      const p = cellToParent(c, 6);
      expected.set(p, (expected.get(p) ?? 0) + km2(c));
    }
    const want = [...expected.entries()].map(([p, v]) => [p, r1(v)] as [string, number]).sort();
    expect(agg.r6).toEqual(want);
    expect(agg.km2).toBeLessThan(allAgg.km2);
    expect(filter.summary()).toEqual({ fires: agg.fires, km2: agg.km2, floor: agg.floor });
    expect(el.querySelector(".season-filter-label")?.textContent).toBe(filterLabel(0, agg, "eu"));
  });

  // The floor is what the panel's status line prints after "since". It has to
  // describe the fires currently counted: `l` is the earliest fire AND the one
  // in Ukraine, so an EU-27 season legitimately starts later than the Europe
  // one — and saying otherwise would date the EU season to a fire outside it.
  it("summary() carries the floor of the fires actually counted, per scope", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    filter.setCountries(countries);
    sched.flush();
    expect(filter.summary()?.floor).toBe("2026-02-09"); // `l`, in Ukraine

    scopeButtons(el).eu.click();
    sched.flush();
    expect(filter.scope()).toBe("eu");
    expect(filter.summary()?.floor).toBe("2026-04-21"); // `m`, the earliest EU fire

    // …and the size slider moves it too: ≥ 4 km² leaves `l` alone, which the
    // EU scope has already excluded — so nothing is left and there is no date.
    scopeButtons(el).all.click();
    sched.flush();
    const range = el.querySelector<HTMLInputElement>(".season-range")!;
    range.value = "6"; range.dispatchEvent(new Event("input"));
    sched.flush();
    expect(filter.summary()?.fires).toBe(1);
    expect(filter.summary()?.floor).toBe("2026-02-09");
  });

  it("summary() is null before the first aggregation, so there is no floor to show", () => {
    const sched = manualScheduler();
    const { filter } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    expect(filter.summary()).toBeNull();
  });

  it("clicking All Europe again restores the full set", () => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    filter.setCountries(countries);
    sched.flush();
    scopeButtons(el).eu.click();
    sched.flush();
    scopeButtons(el).all.click();
    sched.flush();
    expect(filter.scope()).toBe("all");
    const agg = onAggregate.mock.calls.at(-1)![0] as ReturnType<typeof aggregate>;
    expect(agg.scope).toBe("all");
    expect(agg.fires).toBe(3);
    expect(agg.km2).toBe(aggregate(cells, sizes, 0).km2);
    expect(heights(el)[binIndex(sizes.get("l")!)]).toBeGreaterThan(0);
    expect(el.querySelector(".season-filter-label")?.textContent).toBe(filterLabel(0, agg));
  });

  // The `disabled` attribute is presentation; the guard is the contract. A
  // click that reaches the handler without a countries file (a stale attribute
  // after a rebuild, an assistive client, a stray dispatch) must not switch to
  // a scope that would then keep() every fire out and show an empty map.
  it("a click on the EU-27 button without a countries file cannot change the scope", () => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    sched.flush();
    const eu = scopeButtons(el).eu;
    expect(eu.disabled).toBe(true);
    eu.disabled = false; // force the event through, as a stale attribute would
    eu.click();
    sched.flush();
    expect(filter.scope()).toBe("all");
    expect(el.querySelector(".season-filter-label")?.textContent).toBe(filterLabel(0, aggregate(cells, sizes, 0)));
    expect(onAggregate).toHaveBeenCalledTimes(1);
  });

  // The layer panel rebuilds its DOM on every moveend: the scope has to live
  // in the filter's state, not in the markup it last wrote.
  it("re-rendering into a fresh container keeps the scope and the threshold", () => {
    const sched = manualScheduler();
    const { filter, el, onAggregate } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    filter.setCountries(countries);
    sched.flush();
    scopeButtons(el).eu.click();
    const range = el.querySelector<HTMLInputElement>(".season-range")!;
    range.value = "1"; range.dispatchEvent(new Event("input"));
    sched.flush();
    const before = onAggregate.mock.calls.length;

    const fresh = document.createElement("div");
    filter.control(fresh);
    expect(scopeButtons(fresh).eu.classList.contains("on")).toBe(true);
    expect(scopeButtons(fresh).eu.getAttribute("aria-pressed")).toBe("true");
    expect(scopeButtons(fresh).eu.disabled).toBe(false);
    expect(scopeButtons(fresh).all.classList.contains("on")).toBe(false);
    expect(fresh.querySelector<HTMLInputElement>(".season-range")?.value).toBe("1");
    expect(fresh.querySelector(".season-filter-label")?.textContent)
      .toBe(el.querySelector(".season-filter-label")?.textContent);
    expect(onAggregate).toHaveBeenCalledTimes(before); // a re-render never re-aggregates
  });

  it("after aggregation, range aria-valuetext matches label text", () => {
    const sched = manualScheduler();
    const { filter, el } = mount(sched.schedule);
    filter.setCells(cells, sizes);
    const range = el.querySelector<HTMLInputElement>(".season-range")!;
    range.value = "6";
    range.dispatchEvent(new Event("input"));
    sched.flush();
    const label = el.querySelector(".season-filter-label")?.textContent;
    const ariaText = range.getAttribute("aria-valuetext");
    expect(ariaText).toBe(label);
  });
});
