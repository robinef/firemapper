import { cellArea, cellToParent, getResolution, UNITS } from "h3-js";
import { isEuCountry } from "./eu27";
import type { FiresSummary, SeasonCells, SeasonSizes } from "./types";

/**
 * Size filter for the "Burned this year" layer — the math half.
 *
 * Question answered: "How many fires of each size burned, and which sizes
 * do I want on the map?" The histogram is the legend for size; the slider
 * is the filter. Everything here is pure and works from the cells file
 * (`{fire_id: {digest, first, cells}}`) the layer already fetches: per-fire
 * km², log-binned counts, and a re-aggregation that reproduces the
 * pipeline's numbers (pipeline/export_season.py::aggregate_r6) for any
 * threshold — at threshold 0 it must equal what the pipeline published.
 */

/** Log-spaced km² edges, hand-picked so the labels read cleanly. 15 bins. */
export const SIZE_EDGES: readonly number[] = [0.5, 0.7, 1, 1.5, 2, 3, 4, 6, 10, 15, 20, 30, 50, 100, 200, 600];
/** NWCG fire-size class lower bounds, for the tick marks under the bars. */
export const NWCG_TICKS: { label: string; km2: number }[] = [
  { label: "E", km2: 1.2 },
  { label: "F", km2: 4.05 },
  { label: "G", km2: 20.2 },
];
export const AGG_RES = 6;

/** eu27.ts is the source of truth for the membership — a fact about the world,
 * shared by every EU-only view. Kept as public surface here because the scope
 * is this module's feature and a reader looking for its definition looks here
 * first. Deliberately NOT "Europe": the season layer's box reaches Ukraine,
 * Russia, Turkey and Algeria. */
export { EU27 } from "./eu27";

/** Which side of the EU-27 border a fire burned on. Unknown is not EU: a fire
 * the geocoder could not place (31 of 21,867 in 2026) must not be counted into
 * a total the reader will compare against an EFFIS EU-27 number. */
export function isEuFire(summary: FiresSummary | null, id: string): boolean {
  return isEuCountry(summary?.[id]?.country);
}

/** Which fires the layer is counting: the whole Europe box, or the EU-27. */
export type SeasonScope = "all" | "eu";

export type SeasonAggregate = {
  threshold: number;
  r6: [string, number][];
  fires: number;
  km2: number;
  /** Scope these totals describe — carried so a reader of the aggregate (the
   * label, the status line, the cell filter) can never pair one scope's
   * numbers with another's heading. */
  scope: SeasonScope;
  /** Earliest first-detection date (YYYY-MM-DD) among the KEPT fires — the
   * date the status line prints after "since". Null when nothing is kept:
   * a selection with no fires in it has no season to date. */
  floor: string | null;
};

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Real km² of each fire's unique cells, with nested-cell dedup applied per fire
 * (matching pipeline/geo_local.py::true_area_km2). */
export function fireSizes(cells: SeasonCells): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, entry] of Object.entries(cells)) {
    let sum = 0;
    for (const c of dedupNested(new Set(entry.cells))) sum += cellArea(c, UNITS.km2);
    out.set(id, sum);
  }
  return out;
}

/** Per-fire sizes for `cells`, reusing `known` (the sidecar's) wherever it has
 * the fire and computing only the rest. The sidecar and the cells file are
 * separate uploads, so a cells file one publish newer can hold a fire the
 * sidecar has not heard of yet; without its size that fire would read as 0 km²
 * and vanish at every threshold. Returns `known` itself when it is complete —
 * the common case, and the one that must cost no h3 math at all. */
export function withKnownSizes(cells: SeasonCells, known: Map<string, number>): Map<string, number> {
  let missing: SeasonCells | null = null;
  for (const id of Object.keys(cells)) if (!known.has(id)) (missing ??= {})[id] = cells[id];
  if (!missing) return known;
  const out = new Map(known);
  for (const [id, v] of fireSizes(missing)) out.set(id, v);
  return out;
}

/** The sidecar's countries in the shape isEuFire reads. Null when it places
 * no fire at all (the pipeline had no fires summary that run): a scope that
 * answers "not EU" for every fire would offer a guaranteed empty map.
 * `area_km2` carries the footprint km², not the scale blob's EFFIS area —
 * only `country` is ever read from this. */
export function sidecarCountries(s: SeasonSizes): FiresSummary | null {
  const out: FiresSummary = {};
  let placed = false;
  for (const [id, [km2, country]] of Object.entries(s.fires)) {
    out[id] = { country, area_km2: km2 };
    if (country) placed = true;
  }
  return placed ? out : null;
}

/** Bin holding `km2`: −1 below the first edge, else the largest i with
 * SIZE_EDGES[i] <= km2, capped at the last bin (values ≥ 600 included). */
export function binIndex(km2: number): number {
  if (km2 < SIZE_EDGES[0]) return -1;
  let i = 0;
  while (i + 1 < SIZE_EDGES.length && km2 >= SIZE_EDGES[i + 1]) i += 1;
  return Math.min(i, SIZE_EDGES.length - 2);
}

/** `keep` scopes the distribution to a subset of fires (the EU-27 toggle):
 * the bars are the legend for what the slider will select, so they have to
 * count the same fires the aggregation will. */
export function histogram(sizes: Map<string, number>, keep?: (id: string) => boolean): number[] {
  const bins = new Array<number>(SIZE_EDGES.length - 1).fill(0);
  for (const [id, v] of sizes) {
    if (keep && !keep(id)) continue;
    const i = binIndex(v);
    if (i >= 0) bins[i] += 1;
  }
  return bins;
}

/** Slider index → km² threshold. Index 0 means "everything". */
export function thresholdFor(index: number): number {
  return index <= 0 ? 0 : SIZE_EDGES[Math.min(index, SIZE_EDGES.length - 1)];
}

/** Same rule as pipeline/geo_local.py::dedup_nested_cells: drop any cell that
 * is the H3 parent of another cell in the set (a coarse Meteosat cell whose
 * finer VIIRS children are present). Cells are grouped by resolution so each
 * cell only checks the coarser resolutions actually present — O(n·R), not
 * O(n²), which matters at ~160k cells. */
export function dedupNested(cells: Set<string>): Set<string> {
  const resolutions = new Set<number>();
  for (const c of cells) resolutions.add(getResolution(c));
  const coarser = [...resolutions].sort((x, y) => x - y);
  if (coarser.length < 2) return new Set(cells);
  const drop = new Set<string>();
  for (const c of cells) {
    const r = getResolution(c);
    for (const q of coarser) {
      if (q >= r) break;
      const p = cellToParent(c, q);
      if (cells.has(p)) drop.add(p);
    }
  }
  const out = new Set<string>();
  for (const c of cells) if (!drop.has(c)) out.add(c);
  return out;
}

/** Re-aggregate the kept fires (km² ≥ threshold) exactly as the pipeline
 * does (pipeline/export_season.py::aggregate_r6): nested dedup runs INSIDE
 * each fire, then the union across fires counts each cell once. A res-7 cell
 * from one fire and its res-8 child from another BOTH survive — that is the
 * pipeline's answer and the published numbers are the contract. Roll-up to res
 * 6, per-hex km² rounded to 0.1, total = rounded sum of the rounded hexes. */
export function aggregate(
  cells: SeasonCells,
  sizes: Map<string, number>,
  threshold: number,
  keep?: (id: string) => boolean,
  scope: SeasonScope = "all",
): SeasonAggregate {
  const union = new Set<string>();
  let fires = 0;
  // The floor rides the SAME loop as the count and the union, for the same
  // reason: a date taken over all fires would outlive the fire it came from
  // and claim the filtered season started earlier than it did. YYYY-MM-DD
  // sorts chronologically as a string, so a plain comparison is the right one.
  let floor: string | null = null;
  for (const [id, entry] of Object.entries(cells)) {
    if ((sizes.get(id) ?? 0) < threshold) continue;
    // A second gate on the same loop, so a rejected fire leaves the count, the
    // union and the km² alike — not merely the map.
    if (keep && !keep(id)) continue;
    fires += 1;
    if (floor === null || entry.first < floor) floor = entry.first;
    for (const c of dedupNested(new Set(entry.cells))) union.add(c);
  }
  const totals = new Map<string, number>();
  for (const c of union) {
    const parent = getResolution(c) > AGG_RES ? cellToParent(c, AGG_RES) : c;
    totals.set(parent, (totals.get(parent) ?? 0) + cellArea(c, UNITS.km2));
  }
  const r6 = [...totals.entries()]
    .map(([cell, v]) => [cell, round1(v)] as [string, number])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const km2 = round1(r6.reduce((s, [, v]) => s + v, 0));
  return { threshold, r6, fires, km2, scope, floor };
}

/** "EU-27 · " when the layer is scoped, nothing when it is not. One place, so
 * the label, its placeholder and the status line cannot drift apart. */
export function scopePrefix(scope: SeasonScope): string {
  return scope === "eu" ? "EU-27 · " : "";
}

/** "footprint", not "burned": every detection claims a whole 0.7 km² cell and
 * agricultural burning is in there too, so this number runs roughly double the
 * mapped burn area EFFIS reports for the same region. Naming it stops a reader
 * treating it as the /scale page's EFFIS figure. */
export function filterLabel(index: number, agg: { fires: number; km2: number }, scope: SeasonScope = "all"): string {
  const n = (v: number) => Math.round(v).toLocaleString("en-GB");
  const head = index <= 0 ? "all sizes" : `≥ ${thresholdFor(index)} km²`;
  return `${scopePrefix(scope)}${head} · ${n(agg.fires)} fires · ${n(agg.km2)} km² footprint`;
}

type FilterStatus = "loading" | "ready" | "unavailable";

const HIST_W = 150;
const HIST_H = 40;
const BAR_W = HIST_W / (SIZE_EDGES.length - 1);

/** 0…1 position of a km² tick on the equal-width histogram, interpolated within bins. */
export function tickPos(km2: number): number {
  const i = Math.max(0, Math.min(binIndex(km2), SIZE_EDGES.length - 2));
  const frac = Math.max(0, Math.min(1, Math.log(km2 / SIZE_EDGES[i]) / Math.log(SIZE_EDGES[i + 1] / SIZE_EDGES[i])));
  return (i + frac) / (SIZE_EDGES.length - 1);
}

/**
 * The control half: owns the threshold, the per-fire sizes and the last
 * aggregate, and renders idempotently into whatever container the layer
 * panel hands it (the panel rebuilds its DOM on every moveend). Label and
 * bar dimming follow the slider instantly; the aggregation — tens of ms of
 * h3 math plus a setData — is debounced through `schedule` (default 100 ms,
 * per-instance timer).
 */
export function createSeasonFilter(opts: {
  onAggregate: (agg: SeasonAggregate) => void;
  /** Every slider move or scope change, before any aggregation. The caller
   * uses it to fetch the cells (the aggregate needs them) and to refresh the
   * status line from preview() while they are on their way. */
  onSelect?: () => void;
  schedule?: (fn: () => void) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = opts.schedule ?? ((fn: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, 100);
  });
  let status: FilterStatus = "loading";
  let cells: SeasonCells | null = null;
  let sizes: Map<string, number> | null = null;
  let bins: number[] = new Array<number>(SIZE_EDGES.length - 1).fill(0);
  let index = 0;
  let last: SeasonAggregate | null = null;
  let container: HTMLElement | null = null;
  let scope: SeasonScope = "all";
  /** Per-fire countries, null until the summary lands (or forever, if it
   * never does — then the EU-27 button stays disabled and nothing else here
   * changes behaviour). */
  let countries: FiresSummary | null = null;
  /** Per-fire first-detection dates from the sidecar — null without one. With
   * the sizes, they make the fire count and the floor of any selection
   * computable before the cells file (and its geometry) arrives. */
  let firstById: Map<string, string> | null = null;
  /** The sizes came from the sidecar: they stay the one source of sizes when
   * the cells land, so the bars and the aggregate cannot disagree. */
  let fromSidecar = false;

  /** Is there a usable countries file? An EMPTY summary is not one: it parses,
   * but it answers "not EU" for every fire, so offering the scope would offer
   * a guaranteed empty map. One predicate, used by both the renderer and the
   * painter, so the button's markup and its live state cannot disagree. */
  const hasCountries = (): boolean => countries !== null && Object.keys(countries).length > 0;

  /** The predicate the current scope implies. `undefined` for "all", so the
   * unscoped path costs no call per fire. */
  const keepFn = (): ((id: string) => boolean) | undefined =>
    scope === "eu" ? (id: string) => isEuFire(countries, id) : undefined;

  /** The current selection's fire count and floor from the sidecar alone. The
   * same two gates, in the same order, as aggregate(): a fire must reach the
   * threshold and pass the scope. */
  const selection = (): { fires: number; floor: string | null } => {
    const t = thresholdFor(index);
    const keep = keepFn();
    let fires = 0;
    let floor: string | null = null;
    for (const [id, v] of sizes ?? []) {
      if (v < t) continue;
      if (keep && !keep(id)) continue;
      fires += 1;
      const f = firstById?.get(id);
      if (f !== undefined && (floor === null || f < floor)) floor = f;
    }
    return { fires, floor };
  };

  const isDefault = (): boolean => index <= 0 && scope === "all";

  const labelText = (): string => {
    if (status === "loading") return "loading sizes…";
    if (status === "unavailable") return "sizes unavailable";
    // Sidecar only, and the reader has chosen something: the count is known,
    // the deduped km² needs the union of the kept fires' cells. Say which is
    // which rather than approximating the km² by a per-fire sum.
    if (!cells && firstById && !isDefault()) {
      const head = index <= 0 ? "all sizes" : `≥ ${thresholdFor(index)} km²`;
      return `${scopePrefix(scope)}${head} · ${selection().fires.toLocaleString("en-GB")} fires · … km² footprint`;
    }
    // `last` is only usable while it describes the threshold now on screen.
    // Between a slider move and the debounced re-aggregation it describes the
    // PREVIOUS one, and pairing the new head with those totals states a
    // number that was never true — worse, aria-valuetext would announce it.
    // …and the same is true of the SCOPE: after a scope click `last` still
    // holds the other scope's totals, and pairing them with an "EU-27 ·"
    // heading would state a number that was never true.
    if (!last || last.threshold !== thresholdFor(index) || last.scope !== scope) {
      // Until the first aggregation lands (scheduled from setCells), show the
      // count alone: the deduped km² is not known yet and must never be
      // approximated by a per-fire sum, which double-counts shared ground.
      if (index <= 0) return `${scopePrefix(scope)}all sizes · ${keptFires().toLocaleString("en-GB")} fires`;
      const t = thresholdFor(index);
      return `${scopePrefix(scope)}≥ ${t} km² · …`;
    }
    return filterLabel(index, last, scope);
  };

  /** How many fires the current scope holds — the one number available before
   * an aggregation runs (a count needs no geometry). */
  const keptFires = (): number => {
    if (!sizes) return 0;
    const keep = keepFn();
    if (!keep) return sizes.size;
    let n = 0;
    for (const id of sizes.keys()) if (keep(id)) n += 1;
    return n;
  };

  const paint = (): void => {
    if (!container) return;
    const box = container.querySelector(".season-filter");
    if (!box) return;
    box.className = `season-filter is-${status}`;
    // Scope buttons read state, never their own markup: the panel rebuilds
    // this DOM on every moveend and setCountries can land at any point.
    box.querySelectorAll<HTMLButtonElement>(".season-scope button").forEach((b) => {
      const s = b.dataset.scope as SeasonScope | undefined;
      if (!s) return;
      const on = s === scope;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      // BOTH buttons follow the filter's ready state, not just the EU one.
      // Re-scoping means re-aggregating, and runAggregate returns early
      // without the cells file — so a click while loading or unavailable
      // would leave a pressed "EU-27" beside all-Europe numbers, on a map
      // that never changed. The EU button additionally needs the countries.
      const noCountries = s === "eu" && !hasCountries();
      b.disabled = status !== "ready" || noCountries;
      // The title names the countries reason only: a filter that is loading
      // or unavailable already says so in its label, and borrowing the
      // countries wording there would blame the wrong missing file.
      if (noCountries) b.title = "countries unavailable";
      else b.removeAttribute("title");
    });
    const t = thresholdFor(index);
    box.querySelectorAll<SVGRectElement>(".season-hist rect").forEach((r, i) => {
      r.classList.toggle("dim", index > 0 && SIZE_EDGES[i] < t);
      r.classList.toggle("hi", index > 0 && SIZE_EDGES[i] >= t);
    });
    const range = box.querySelector<HTMLInputElement>(".season-range");
    if (range) {
      range.disabled = status !== "ready";
      range.value = String(index);
      range.setAttribute("aria-valuetext", labelText());
    }
    const label = box.querySelector(".season-filter-label");
    if (label) label.textContent = labelText();
  };

  const runAggregate = (): void => {
    if (!cells || !sizes) return;
    const t = thresholdFor(index);
    last = aggregate(cells, sizes, t, keepFn(), scope);
    opts.onAggregate(last);
    paint();
  };

  const onInput = (e: Event): void => {
    const v = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    index = Math.max(0, Math.min(SIZE_EDGES.length - 1, Math.round(v)));
    paint();
    opts.onSelect?.();
    schedule(runAggregate);
  };

  /** A scope click changes WHICH fires exist, so unlike a slider move it
   * re-bins the histogram — hence a full re-render, not a paint. The
   * aggregation rides the same debounce as the slider's. */
  const onScope = (e: Event): void => {
    const b = e.currentTarget as HTMLButtonElement;
    const s = b.dataset.scope as SeasonScope | undefined;
    if (!s || s === scope) return;
    // The same two gates paint() disables the buttons on, enforced here as
    // well: `disabled` is presentation (and can be stale after a rebuild),
    // these are the contract.
    if (status !== "ready") return; // nothing to re-scope, and no aggregation would run
    if (s === "eu" && !hasCountries()) return; // no countries file, no EU claim
    scope = s;
    if (sizes) bins = histogram(sizes, keepFn());
    // control() ends in paint(), so the new scope reaches the buttons, the
    // bars and the label through that one call — a second paint() here would
    // be a duplicate rule for the same fact.
    if (container) control(container);
    // The re-render above replaced the button that was clicked, so focus is
    // on <body> now. Put it back on the new button: a keyboard reader must
    // not be dumped out of the control for using it, and a screen reader
    // announces the new aria-pressed state only if focus lands there.
    container?.querySelector<HTMLButtonElement>(`.season-scope button[data-scope="${s}"]`)?.focus();
    opts.onSelect?.();
    schedule(runAggregate);
  };

  const control = (el: HTMLElement): void => {
    container = el;
    const max = Math.max(1, ...bins);
    const rects = bins
      .map((n, i) => {
        // Loading and unavailable have no counts yet, so a height-proportional
        // bar is a zero-height bar: nothing paints and the row reads as an
        // empty box under three orphan tick letters. Draw full-height bars and
        // let the CSS grey them — a skeleton, which is what those states mean.
        //
        // Ready: a non-zero bin gets at least 1 px. The size distribution is a
        // power law — thousands of fires in the first bin, a handful above
        // 100 km² — and rounding the tail to 0 px would claim the big fires
        // the slider exists to isolate do not exist. An empty bin still
        // renders nothing: "rare" and "none" must stay distinguishable.
        const h = status === "ready"
          ? (n > 0 ? Math.max(1, Math.round((n / max) * HIST_H)) : 0)
          : HIST_H;
        return `<rect x="${(i * BAR_W).toFixed(1)}" y="${HIST_H - h}" width="${(BAR_W - 1).toFixed(1)}" height="${h}"></rect>`;
      })
      .join("");
    const ticks = NWCG_TICKS
      .map((tk) => `<span style="left:${(tickPos(tk.km2) * 100).toFixed(1)}%">${tk.label}</span>`)
      .join("");
    // Scope above sizes: the reader picks which fires exist, then which of
    // those are big enough.
    //
    // The buttons render BARE — no `on`, `aria-pressed`, `disabled` or
    // `title` here. paint() runs at the end of this function and owns all
    // four, reading state, so a rebuild into a fresh container restores the
    // choice. Setting them here as well would be two rules for one fact, and
    // the template's copy is unobservable (paint always overwrites it) —
    // exactly the kind of duplicate that drifts unnoticed.
    const scopeHtml =
      `<div class="season-scope" role="group" aria-label="Fire scope">` +
      `<button type="button" data-scope="all">All Europe</button>` +
      `<button type="button" data-scope="eu">EU-27</button>` +
      `</div>`;
    el.innerHTML =
      `<div class="season-filter is-${status}">` +
      scopeHtml +
      `<svg class="season-hist" viewBox="0 0 ${HIST_W} ${HIST_H}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>` +
      `<div class="season-ticks" aria-hidden="true">${ticks}</div>` +
      `<input class="season-range" type="range" min="0" max="${SIZE_EDGES.length - 1}" step="1" ` +
      `aria-label="Minimum fire size">` +
      `<div class="season-filter-label"></div>` +
      `</div>`;
    el.querySelector<HTMLInputElement>(".season-range")!.addEventListener("input", onInput);
    el.querySelectorAll<HTMLButtonElement>(".season-scope button")
      .forEach((b) => b.addEventListener("click", onScope));
    paint();
  };

  return {
    control,
    /** The cells arrived. With a sidecar already set its sizes are kept (only
     * fires it lacks are computed) and `s` is ignored; without one, `s` is the
     * sizes, as before the sidecar existed. */
    setCells(c: SeasonCells, s: Map<string, number>): void {
      cells = c;
      sizes = fromSidecar && sizes ? withKnownSizes(c, sizes) : s;
      bins = histogram(sizes, keepFn());
      status = "ready";
      // Rebuild into the current container so the bars reflect real counts,
      // then aggregate once at threshold 0 (debounced, off the idle path) so
      // the label and the status line carry the same deduped totals.
      if (container) control(container);
      schedule(runAggregate);
    },
    /** The sizes sidecar: the histogram, the counts and the EU-27 scope are
     * ready from it at once. The aggregate still waits for setCells. Landing
     * after the cells (a deep link can fetch them first), it contributes its
     * countries and dates only — the cells' sizes and aggregate stand. */
    setSizes(sc: SeasonSizes): void {
      const placed = sidecarCountries(sc);
      if (placed) countries = placed;
      firstById = new Map(Object.entries(sc.fires).map(([id, e]) => [id, e[2]]));
      if (!cells) {
        sizes = new Map(Object.entries(sc.fires).map(([id, e]) => [id, e[0]]));
        fromSidecar = true;
        bins = histogram(sizes, keepFn());
        if (status === "loading") status = "ready";
      }
      if (container) control(container);
    },
    /** The sidecar's sizes, for the cells loader to reuse — null without one. */
    knownSizes: (): Map<string, number> | null => (fromSidecar ? sizes : null),
    setUnavailable(): void {
      status = "unavailable";
      paint();
    },
    /** Per-fire countries for the EU-27 scope. Null, or an empty summary (a
     * missing, broken or empty file), simply leaves the button disabled —
     * never changes the totals, never switches scope back on its own. */
    setCountries(summary: FiresSummary | null): void {
      countries = summary;
      paint();
    },
    scope: (): SeasonScope => scope,
    threshold: () => thresholdFor(index),
    /** The landed aggregate's headline numbers AND its floor date — the three
     * the panel's status line prints together, so they always describe the
     * same selection of fires. */
    summary: () => (last ? { fires: last.fires, km2: last.km2, floor: last.floor } : null),
    /** Until the first aggregate lands: the chosen selection's count and floor
     * from the sidecar, with the scope they describe. Null at the default
     * selection (the pipeline's totals are exact there), without a sidecar,
     * and once summary() has real numbers. */
    preview: (): { fires: number; floor: string | null; scope: SeasonScope } | null => {
      if (last || !firstById || isDefault()) return null;
      return { ...selection(), scope };
    },
  };
}
