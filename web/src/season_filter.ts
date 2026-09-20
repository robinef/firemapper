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
