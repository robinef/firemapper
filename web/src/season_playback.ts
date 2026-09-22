import { cellArea, cellToParent, getResolution, UNITS } from "h3-js";
import { AGG_RES, dedupNested } from "./season_filter";
import type { SeasonScope } from "./season_filter";
import type { SeasonCells } from "./types";

/**
 * Season playback — "How did this season build up, day by day?"
 *
 * A play button under the season histogram sweeps from the selection's floor
 * to today, one step per day, and the heat, the hexes and the real cells grow
 * as fires are first detected. It replays the CURRENT selection (size
 * threshold and scope): the same fires the static layer shows, in the order
 * the satellites found them.
 *
 * This half is the math. The whole sweep is precomputed once per selection so
 * a frame costs a column read, never h3 math: `aggregate(…, until)` in
 * season_filter.ts is the reference each column must equal exactly.
 */

/** The `nday` a cell carries when no fire claiming it qualifies: far below
 * any `-day`, so the day clause never admits it. */
export const NO_DAY = -9999;

const DAY_MS = 86_400_000;
const dayMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** `date` + n UTC calendar days, as YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  return new Date(dayMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** What a playback replays: the inputs, and the two gates, the filter hands
 * aggregate(). */
export type PlaybackSelection = {
  cells: SeasonCells;
  sizes: Map<string, number>;
  threshold: number;
  keep?: (id: string) => boolean;
  scope: SeasonScope;
};

export type PlaybackColumns = {
  threshold: number;
  scope: SeasonScope;
  /** YYYY-MM-DD per step, the selection's floor first. */
  days: string[];
  /** Res-6 hexes the selection ever touches, sorted like aggregate()'s r6. */
  hexes: string[];
  /** Cumulative km² × 10, rounded (aggregate()'s round1, kept as an exact
   * integer), day-major: `tenths[d * hexes.length + h]`. */
  tenths: Int32Array;
  /** Day index each hex first holds a counted cell — the column includes it
   * from then on, exactly as aggregate()'s r6 lists every hex with a cell. */
  hexFirst: Int32Array;
  /** Cumulative kept-fire count per day. */
  fires: Int32Array;
  /** Cumulative km² footprint per day (round1 of the rounded hexes, as
   * aggregate() totals it). */
  km2: Float64Array;
  /** Day index of each QUALIFYING fire's first detection. */
  fireDay: Map<string, number>;
};

/**
 * One pass over the selection. A cell counts from the first day any
 * qualifying claimant was detected (MIN `first`) onward, its area added once
 * — the union semantics aggregate() applies, unrolled over time. Nested
 * dedup runs inside each fire, never across fires, as aggregate() does.
 *
 * The sweep ends at `end` (today) or at the last qualifying fire's first day,
 * whichever is later, so the last column is always the full aggregate.
 * Null when nothing qualifies: there is no season to play.
 */
export function precompute(sel: PlaybackSelection, end: string): PlaybackColumns | null {
  const { cells, sizes, threshold, keep } = sel;
  const kept: string[] = [];
  let floor: string | null = null;
  let last: string | null = null;
  // The same two gates, in the same order, as aggregate().
  for (const [id, e] of Object.entries(cells)) {
    if ((sizes.get(id) ?? 0) < threshold) continue;
    if (keep && !keep(id)) continue;
    kept.push(id);
    if (floor === null || e.first < floor) floor = e.first;
    if (last === null || e.first > last) last = e.first;
  }
  if (floor === null || last === null) return null;
  const stop = end > last ? end : last;
  const f0 = dayMs(floor);
  const D = Math.round((dayMs(stop) - f0) / DAY_MS) + 1;
  const days = Array.from({ length: D }, (_, d) => addDays(floor!, d));

  const fireDay = new Map<string, number>();
  const cellDay = new Map<string, number>();
  const firesNew = new Int32Array(D);
  for (const id of kept) {
    const d = Math.round((dayMs(cells[id].first) - f0) / DAY_MS);
    fireDay.set(id, d);
    firesNew[d] += 1;
    for (const c of dedupNested(new Set(cells[id].cells))) {
      const prev = cellDay.get(c);
      if (prev === undefined || d < prev) cellDay.set(c, d);
    }
  }

  // Per hex, the (day, km²) of each cell it gains.
  const perHex = new Map<string, [number, number][]>();
  for (const [c, d] of cellDay) {
    const parent = getResolution(c) > AGG_RES ? cellToParent(c, AGG_RES) : c;
    let list = perHex.get(parent);
    if (!list) perHex.set(parent, (list = []));
    list.push([d, cellArea(c, UNITS.km2)]);
  }
  const hexes = [...perHex.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const H = hexes.length;
  const tenths = new Int32Array(H * D);
  const hexFirst = new Int32Array(H);
  for (let h = 0; h < H; h += 1) {
    const list = perHex.get(hexes[h])!.sort((x, y) => x[0] - y[0]);
    hexFirst[h] = list[0][0];
    let i = 0;
    let sum = 0;
    for (let d = 0; d < D; d += 1) {
      while (i < list.length && list[i][0] <= d) sum += list[i++][1];
      tenths[d * H + h] = Math.round(sum * 10);
    }
  }

  const fires = new Int32Array(D);
  const km2 = new Float64Array(D);
  let running = 0;
  for (let d = 0; d < D; d += 1) {
    running += firesNew[d];
    fires[d] = running;
    let t = 0;
    for (let h = 0; h < H; h += 1) t += tenths[d * H + h];
    km2[d] = Math.round(t) / 10;
  }
  return { threshold, scope: sel.scope, days, hexes, tenths, hexFirst, fires, km2, fireDay };
}

/** Day `d`'s res-6 aggregate, in aggregate()'s `r6` shape and order. */
export function column(p: PlaybackColumns, d: number): [string, number][] {
  const H = p.hexes.length;
  const out: [string, number][] = [];
  const base = d * H;
  for (let h = 0; h < H; h += 1) {
    if (p.hexFirst[h] <= d) out.push([p.hexes[h], p.tenths[base + h] / 10]);
  }
  return out;
}

/** The `nday` property for a fire's cells: minus its day index when it
 * qualifies, NO_DAY when it does not. cellFeatures maxes extra properties
 * across claimants, so a cell ends up with minus its FIRST qualifying day,
 * and `nday >= -d` admits exactly the cells day d's column counts. */
export function ndayFor(p: PlaybackColumns | null, id: string): number {
  const d = p?.fireDay.get(id);
  return d === undefined ? NO_DAY : 0 - d;
}
