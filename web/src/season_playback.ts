import { cellArea, cellToParent, getResolution, UNITS } from "h3-js";
import { formatFloor } from "./layer_season";
import { AGG_RES, dedupNested, scopePrefix } from "./season_filter";
import type { SeasonScope } from "./season_filter";
import type { SeasonCells } from "./types";
import { onUi } from "./ui_events";

/**
 * Season playback — "How did this season build up, day by day?"
 *
 * A play button under the season histogram sweeps from the selection's floor
 * to today, one step per day, and the heat, the hexes and the real cells grow
 * as fires are first detected. It replays the CURRENT selection (size
 * threshold and scope): the same fires the static layer shows, in the order
 * the satellites found them.
 *
 * The math half: the whole sweep is precomputed once per selection so a
 * frame costs a column read, never h3 math — `aggregate(…, until)` in
 * season_filter.ts is the reference each column must equal exactly. The
 * control half (createSeasonPlayback) owns the day and the timer.
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

/** One day per step. At ~265 days (January to late September) that is a
 * 80-second season: slow enough to watch a region light up, and inside the
 * 300–450 ms window where one step still reads as one day. */
export const PLAY_STEP_MS = 300;

/** What the map is handed for one day. */
export type PlaybackFrame = {
  day: number;
  date: string;
  fires: number;
  km2: number;
  r6: [string, number][];
  threshold: number;
  scope: SeasonScope;
};

export type SeasonPlaybackOpts = {
  /** The filter's current selection, null until its sizes are known (the
   * control is disabled until then). `cells` is null until the cells file
   * lands: play fetches it (ensureCells) and waits for dataChanged(). */
  selection: () => (Omit<PlaybackSelection, "cells"> & { cells: SeasonCells | null }) | null;
  /** Start the cells fetch at any zoom (the loader's ensure({force:true})). */
  ensureCells: () => Promise<void>;
  /** The last day of the sweep (today, YYYY-MM-DD). */
  end: string;
  /** Right after a precompute, before its first frame: re-tag the installed
   * cells so they carry the new `nday` (read back through nday()). */
  onPrepared?: () => void;
  onFrame: (f: PlaybackFrame) => void;
  /** Back to the full aggregate for the current selection — the last day
   * reached, or the playback abandoned by a size or scope change. */
  onRestore: () => void;
  /** The status line changed (the panel's refreshStatus, never a rebuild). */
  onStatus?: () => void;
  /** Runs the precompute. The default yields a frame first so "preparing…"
   * paints before hundreds of ms of work; tests run it inline. */
  defer?: (fn: () => void) => void;
};

const nf = (v: number) => Math.round(v).toLocaleString("en-GB");

/**
 * The play control under the season histogram. It owns the day index and the
 * timer in this closure and renders idempotently into whatever container it
 * is handed: the layer panel rebuilds its DOM on every moveend, and a pan
 * mid-play must neither stop nor restart the season.
 *
 * Deliberately not the bottom-bar scrubber (scrubber.ts): #timeline belongs
 * to the overview timeline and the fire cards swap it, and that control keeps
 * its timer inside the DOM row this panel rebuilds. Its rules are copied:
 * no loop at the end, a hand on the slider pauses, compare mode pauses — and
 * so does opening a fire card, which hides this layer (level 2).
 *
 * Two states beyond playing/paused: "idle" (`day === null`) is the full
 * season on the map, the normal status line; a day index is a frame on the
 * map and a playback status line. Reaching the last day returns to idle — its
 * column IS the full aggregate — so the map ends exactly where it began.
 */
export function createSeasonPlayback(opts: SeasonPlaybackOpts) {
  const defer = opts.defer ?? ((fn: () => void) => {
    const raf = globalThis.requestAnimationFrame ?? ((f: () => void) => setTimeout(f, 16));
    raf(() => setTimeout(fn, 0));
  });
  let cols: PlaybackColumns | null = null;
  let day: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The reader asked to play and nothing has cancelled it — true from the
   * click through the cells fetch and the precompute, and while playing. */
  let wantPlay = false;
  let preparing = false;
  /** Bumped by invalidate(): a prepare started for an older selection must
   * not install its columns. */
  let gen = 0;
  /** The generation a precompute is already queued for, -1 for none. One
   * click reaches prepare() twice when the cells land inside ensureCells
   * (the loader's onLoaded → dataChanged, then the resolved promise): two
   * queued precomputes would start two timer chains, and pause() could only
   * ever stop one of them. */
  let queuedGen = -1;
  let container: HTMLElement | null = null;

  const last = (): number => (cols ? cols.days.length - 1 : 0);
  const ready = (): boolean => opts.selection() !== null;

  const stopTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const paint = (): void => {
    const box = container?.querySelector(".season-play");
    if (!box) return;
    const play = box.querySelector<HTMLButtonElement>(".scrub-play")!;
    const range = box.querySelector<HTMLInputElement>(".scrub-range")!;
    const label = box.querySelector<HTMLElement>(".scrub-label")!;
    play.disabled = !ready();
    play.textContent = wantPlay ? "❚❚" : "▶";
    play.setAttribute("aria-label", wantPlay ? "Pause the season" : "Play the season");
    range.disabled = !cols;
    range.max = String(last());
    const shown = day ?? last();
    range.value = String(shown);
    if (cols) {
      const text = `up to ${formatFloor(cols.days[shown])} · ${nf(cols.fires[shown])} fires`;
      range.setAttribute("aria-valuetext", text);
    } else {
      range.removeAttribute("aria-valuetext");
    }
    label.textContent = preparing
      ? "preparing…"
      : day !== null && cols
        ? `up to ${formatFloor(cols.days[day])}`
        : "play the season";
  };

  const frame = (): void => {
    if (!cols || day === null) return;
    opts.onFrame({
      day,
      date: cols.days[day],
      fires: cols.fires[day],
      km2: cols.km2[day],
      r6: column(cols, day),
      threshold: cols.threshold,
      scope: cols.scope,
    });
    opts.onStatus?.();
    paint();
  };

  /** Back to the full season: the timer stops, the map and the status line
   * return to the aggregate. */
  const finish = (): void => {
    stopTimer();
    wantPlay = false;
    day = null;
    opts.onRestore();
    opts.onStatus?.();
    paint();
  };

  const tick = (): void => {
    if (day === null) return;
    day += 1;
    if (day >= last()) {
      finish(); // deliberately no loop: a season restarting reads as a glitch
      return;
    }
    frame();
    timer = setTimeout(tick, PLAY_STEP_MS);
  };

  const begin = (): void => {
    if (!cols || !wantPlay) return;
    // Playing from idle (the full season, which is also where the last day
    // lands) starts over; a paused day resumes.
    if (day === null) day = 0;
    stopTimer(); // one timer chain, ever
    frame();
    timer = setTimeout(tick, PLAY_STEP_MS);
  };

  /** Columns for the current selection, then begin — unless a pause or a
   * selection change got there first. Waits (preparing) while the cells are
   * still on their way; dataChanged() picks it back up. */
  const prepare = (): void => {
    const mine = gen;
    const sel = opts.selection();
    if (!sel) {
      preparing = false;
      wantPlay = false;
      paint();
      return;
    }
    if (!sel.cells) return; // dataChanged() resumes once the cells land
    if (queuedGen === mine) return;
    queuedGen = mine;
    const cells = sel.cells;
    defer(() => {
      if (queuedGen === mine) queuedGen = -1;
      if (mine !== gen) return; // a newer selection owns the state now
      if (!wantPlay) {
        preparing = false;
        paint();
        return;
      }
      cols = precompute({ ...sel, cells }, opts.end);
      preparing = false;
      if (!cols) {
        wantPlay = false; // nothing qualifies: nothing to play
        paint();
        return;
      }
      opts.onPrepared?.();
      begin();
      paint();
    });
  };

  const start = (): void => {
    if (!ready()) return;
    wantPlay = true;
    if (cols) {
      begin();
      paint();
      return;
    }
    preparing = true;
    paint();
    const mine = gen;
    void opts.ensureCells().then(() => {
      if (mine === gen && wantPlay && preparing) prepare();
    });
  };

  const pause = (): void => {
    stopTimer();
    wantPlay = false;
    paint();
  };

  const onPlay = (): void => {
    if (wantPlay) pause();
    else start();
  };

  const onRange = (e: Event): void => {
    // Read before pause(): its repaint writes the CURRENT day back into the
    // very input the reader just moved.
    const raw = Number((e.target as HTMLInputElement).value);
    pause(); // a hand on the slider outranks playback
    if (!cols || !Number.isFinite(raw)) return;
    const v = Math.max(0, Math.min(last(), Math.round(raw)));
    if (v >= last()) {
      if (day !== null) finish();
      return;
    }
    day = v;
    frame();
  };

  const control = (el: HTMLElement): void => {
    container = el;
    el.innerHTML =
      `<div class="scrub-row season-play">` +
      `<button class="scrub-play" type="button" aria-label="Play the season">▶</button>` +
      `<input class="scrub-range" type="range" min="0" max="0" step="1" aria-label="Season playback date">` +
      `<span class="scrub-label"></span>` +
      `</div>`;
    el.querySelector<HTMLButtonElement>(".scrub-play")!.addEventListener("click", onPlay);
    el.querySelector<HTMLInputElement>(".scrub-range")!.addEventListener("input", onRange);
    paint();
  };

  // A fire card hides this layer (level 2) and compare mode hides every
  // overlay: an unattended timer must not keep repainting either.
  const offCompare = onUi("compare:enter", pause);
  const offDetail = onUi("detail:open", pause);

  return {
    control,
    /** Readiness may have changed (the sizes or the cells landed). */
    paint,
    /** The cells landed: a play waiting on them can go on. */
    dataChanged(): void {
      if (wantPlay && preparing && !cols) prepare();
      paint();
    },
    pause,
    /** The size threshold or the scope moved: the columns describe a
     * selection that no longer exists. Stop, drop them, and put the full
     * season back if a frame was on the map. */
    invalidate(): void {
      gen += 1;
      stopTimer();
      wantPlay = false;
      preparing = false;
      cols = null;
      if (day !== null) {
        day = null;
        opts.onRestore();
        opts.onStatus?.();
      }
      paint();
    },
    /** The status line while a frame is on the map, null when idle (the
     * caller's normal line stands). */
    statusText(): string | null {
      if (!cols || day === null) return null;
      return `${scopePrefix(cols.scope)}up to ${formatFloor(cols.days[day])} · ` +
        `${nf(cols.fires[day])} fires · ${nf(cols.km2[day])} km² footprint`;
    },
    /** `nday` for a fire's cells under the current columns (cellProps). */
    nday: (id: string): number => ndayFor(cols, id),
    get playing(): boolean {
      return timer !== null;
    },
    get day(): number | null {
      return day;
    },
    destroy(): void {
      stopTimer();
      offCompare();
      offDetail();
    },
  };
}
