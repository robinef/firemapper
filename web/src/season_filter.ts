import { cellArea, cellToParent, getResolution, UNITS } from "h3-js";
import type { SeasonCells } from "./types";

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

export type SeasonAggregate = { threshold: number; r6: [string, number][]; fires: number; km2: number };

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

/** Bin holding `km2`: −1 below the first edge, else the largest i with
 * SIZE_EDGES[i] <= km2, capped at the last bin (values ≥ 600 included). */
export function binIndex(km2: number): number {
  if (km2 < SIZE_EDGES[0]) return -1;
  let i = 0;
  while (i + 1 < SIZE_EDGES.length && km2 >= SIZE_EDGES[i + 1]) i += 1;
  return Math.min(i, SIZE_EDGES.length - 2);
}

export function histogram(sizes: Map<string, number>): number[] {
  const bins = new Array<number>(SIZE_EDGES.length - 1).fill(0);
  for (const v of sizes.values()) {
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
export function aggregate(cells: SeasonCells, sizes: Map<string, number>, threshold: number): SeasonAggregate {
  const union = new Set<string>();
  let fires = 0;
  for (const [id, entry] of Object.entries(cells)) {
    if ((sizes.get(id) ?? 0) < threshold) continue;
    fires += 1;
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
  return { threshold, r6, fires, km2 };
}

export function filterLabel(index: number, agg: { fires: number; km2: number }): string {
  const n = (v: number) => Math.round(v).toLocaleString("en-GB");
  const head = index <= 0 ? "all sizes" : `≥ ${thresholdFor(index)} km²`;
  return `${head} · ${n(agg.fires)} fires · ${n(agg.km2)} km²`;
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

  const labelText = (): string => {
    if (status === "loading") return "loading sizes…";
    if (status === "unavailable") return "sizes unavailable";
    // `last` is only usable while it describes the threshold now on screen.
    // Between a slider move and the debounced re-aggregation it describes the
    // PREVIOUS one, and pairing the new head with those totals states a
    // number that was never true — worse, aria-valuetext would announce it.
    if (!last || last.threshold !== thresholdFor(index)) {
      // Until the first aggregation lands (scheduled from setCells), show the
      // count alone: the deduped km² is not known yet and must never be
      // approximated by a per-fire sum, which double-counts shared ground.
      if (index <= 0) return `all sizes · ${sizes?.size.toLocaleString("en-GB") ?? 0} fires`;
      const t = thresholdFor(index);
      return `≥ ${t} km² · …`;
    }
    return filterLabel(index, last);
  };

  const paint = (): void => {
    if (!container) return;
    const box = container.querySelector(".season-filter");
    if (!box) return;
    box.className = `season-filter is-${status}`;
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
    last = aggregate(cells, sizes, t);
    opts.onAggregate(last);
    paint();
  };

  const onInput = (e: Event): void => {
    const v = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    index = Math.max(0, Math.min(SIZE_EDGES.length - 1, Math.round(v)));
    paint();
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
        const h = status === "ready" ? Math.round((n / max) * HIST_H) : HIST_H;
        return `<rect x="${(i * BAR_W).toFixed(1)}" y="${HIST_H - h}" width="${(BAR_W - 1).toFixed(1)}" height="${h}"></rect>`;
      })
      .join("");
    const ticks = NWCG_TICKS
      .map((tk) => `<span style="left:${(tickPos(tk.km2) * 100).toFixed(1)}%">${tk.label}</span>`)
      .join("");
    el.innerHTML =
      `<div class="season-filter is-${status}">` +
      `<svg class="season-hist" viewBox="0 0 ${HIST_W} ${HIST_H}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>` +
      `<div class="season-ticks" aria-hidden="true">${ticks}</div>` +
      `<input class="season-range" type="range" min="0" max="${SIZE_EDGES.length - 1}" step="1" ` +
      `aria-label="Minimum fire size">` +
      `<div class="season-filter-label"></div>` +
      `</div>`;
    el.querySelector<HTMLInputElement>(".season-range")!.addEventListener("input", onInput);
    paint();
  };

  return {
    control,
    setCells(c: SeasonCells, s: Map<string, number>): void {
      cells = c;
      sizes = s;
      bins = histogram(s);
      status = "ready";
      // Rebuild into the current container so the bars reflect real counts,
      // then aggregate once at threshold 0 (debounced, off the idle path) so
      // the label and the status line carry the same deduped totals.
      if (container) control(container);
      schedule(runAggregate);
    },
    setUnavailable(): void {
      status = "unavailable";
      paint();
    },
    threshold: () => thresholdFor(index),
    summary: () => (last ? { fires: last.fires, km2: last.km2 } : null),
  };
}
