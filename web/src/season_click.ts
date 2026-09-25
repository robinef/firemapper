import { cellArea, cellToLatLng, UNITS } from "h3-js";
import { dedupNested } from "./season_filter";
import { addDays } from "./season_playback";
import type { Scar } from "./layer_imagery";
import type { SeasonCells, SeasonSizeEntry, Track } from "./types";

/**
 * Click a burned cell → the archived fire that burned it.
 *
 * The map half of the season layer is ground truth with no identity attached:
 * `cellFeatures` emits each cell ONCE, tagged with the first fire in the file
 * that claimed it. That tag is fine for painting and wrong for opening a card
 * — fires overlap, and the first claimant is routinely a 0.8 km² neighbour the
 * current size threshold has filtered off the map. So the click resolves the
 * cell against a reverse index and re-applies the filter's own two gates.
 *
 * Everything here is pure: the index is data, the pick is arithmetic, and the
 * Scar is built from a track plus the sizes sidecar. main.ts owns the wiring
 * and firecard.ts owns the card.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Mirrors pipeline/fetch_imagery.py's BASELINE_LEAD_DAYS / SCAR_SETTLE_DAYS:
 * the pre-fire baseline sits six days before ignition, the settled scar two
 * weeks after it. Same numbers, so an archived fire's before/after frames land
 * where the pipeline would have put them had it published a scar for it. */
const BASELINE_LEAD_DAYS = 6;
const SCAR_SETTLE_DAYS = 14;

/**
 * From which zoom a burned cell may be clicked.
 *
 * The cells layer has minzoom 8 and fades in over z8–8.5, and
 * queryRenderedFeatures answers for a feature at opacity 0 — so between the
 * two a tap would open a card for ground the reader cannot see yet, while the
 * hex band underneath is what is actually painted. Halfway through the fade
 * is where the cells become the band a reader is reading.
 */
export const CELL_CLICK_ZOOM = 8.25;

export function cellsClickable(zoom: number): boolean {
  return zoom >= CELL_CLICK_ZOOM;
}

/**
 * cell → every fire claiming it, in file order.
 *
 * Nested dedup runs INSIDE each fire, exactly as cellFeatures does when it
 * emits the polygons: a fire holding a coarse Meteosat cell and its finer
 * VIIRS children owns one patch of ground, and the parent is never drawn. An
 * index that kept it would answer for a cell the reader cannot click.
 *
 * Built once per cells file (it is O(all cells) and the file is ~160k of
 * them), lazily, on the first click — a reader who never clicks a cell never
 * pays for it.
 */
export function buildCellIndex(cells: SeasonCells): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(cells)) {
    for (const cell of dedupNested(new Set(entry.cells))) {
      const claimants = index.get(cell);
      if (claimants) claimants.push(id);
      else index.set(cell, [id]);
    }
  }
  return index;
}

/**
 * Which fire a click on `cell` should open: the LARGEST claimant that passes
 * the selection now on screen.
 *
 * The two gates are the filter's own, in its order (season_filter.ts's
 * aggregate): a fire must reach the size threshold and pass the scope. That is
 * what makes the answer agree with the map — a cell is painted when its
 * largest qualifying claimant passes, so the card that opens is that fire's,
 * not whichever one happened to be written first.
 *
 * Null when nothing claims the cell or nothing qualifies (a sizes map that has
 * not landed yet, say): the caller falls back to the cell's own `fire_id`
 * rather than swallow the tap.
 */
export function pickClaimant(
  cell: string,
  index: Map<string, string[]>,
  sizes: Map<string, number>,
  threshold: number,
  keep?: (id: string) => boolean,
): string | null {
  let best: string | null = null;
  let bestKm2 = -1;
  for (const id of index.get(cell) ?? []) {
    const km2 = sizes.get(id) ?? 0;
    if (km2 < threshold) continue;
    if (keep && !keep(id)) continue;
    // Strictly greater, so equal-sized claimants resolve to the first in file
    // order — the same fire every time, whatever the click.
    if (km2 > bestKm2) {
      best = id;
      bestKm2 = km2;
    }
  }
  return best;
}

/**
 * The filter's gate, narrowed to the day a playback holds on screen.
 *
 * A paused sweep leaves the cells filtered to `nday >= -day`: a cell shows
 * once its EARLIEST qualifying claimant has started. pickClaimant ranks by
 * size alone, so without this a click on a cell painted for a small July fire
 * opens the large August fire that later burned the same ground — a card
 * dated weeks after the map it was clicked on. `nday` is the playback's own
 * (minus the fire's day index, far below any day for a non-qualifier), so the
 * card and the painted cell answer the same question.
 *
 * No day held: the filter's gate unchanged.
 */
export function playbackKeep(
  keep: ((id: string) => boolean) | undefined,
  day: number | null,
  nday: (id: string) => number,
): ((id: string) => boolean) | undefined {
  if (day === null) return keep;
  return (id) => (!keep || keep(id)) && nday(id) >= -day;
}

/** Track ids are the pipeline's hex digests (tests use short words): letters,
 * digits, `_` and `-`. Anything else — `/`, `.`, `?`, `#`, `%` — would steer
 * the archive fetch to another same-origin path. */
export function isTrackId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** The sizes sidecar's own km² rule (season_filter.ts::fireSizes), for a fire
 * the sidecar has not (or not yet) named. Rounded to 3 dp exactly as
 * pipeline/export_season.py rounds the sidecar's: areaText prints this number
 * verbatim, and a raw h3 sum puts thirteen decimal places on the card. */
function trackAreaKm2(cells: string[]): number {
  let sum = 0;
  for (const c of dedupNested(new Set(cells))) sum += cellArea(c, UNITS.km2);
  return Math.round(sum * 1000) / 1000;
}

/** "24 Jul 2026" — the same shape fireCardHtml's own dates use. */
function labelDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * A Scar for an archived season fire — one that never made the manifest's
 * scar shortlist (PAST_MAX_SCARS is 50; the season holds ~27,000).
 *
 * The pipeline computes these fields for the scars it does publish
 * (pipeline/fetch_imagery.py::_scar_from_fire); this reproduces them from what
 * the browser already has, so the card and the before/after compare mode read
 * an archived fire exactly as they read a published scar.
 *
 * `entry` is the sizes sidecar's [km², country, first, place?]. Null is a
 * real case — a `?fire=` deep link can open a card before the sidecar lands,
 * and a cells file one publish newer can hold a fire it has never heard of —
 * so the track alone has to be enough: the same dedup-and-sum the sidecar's
 * km² comes from, and its first bin's day.
 *
 * `place` comes straight from the sidecar's 4th element — absent on sidecars
 * published before pipeline/export_season.py started computing one (d95bcb2),
 * and possibly null even on a current one (no gazetteer hit). Both read as no
 * place, same as no entry at all: scarCardHtml prints `place` as the card's
 * TITLE ahead of `label`, and a null place there is what makes it fall back
 * to the dated label instead of printing "null" or "undefined".
 */
export function scarFromArchive(
  id: string,
  track: Track,
  entry: SeasonSizeEntry | null,
  /** YYYY-MM-DD. The after frame is clamped to the day before this one — GIBS
   * has no imagery for today. */
  today: string,
): Scar {
  const firstBin = track.series[0]?.bin.slice(0, 10);
  const lastBin = track.series[track.series.length - 1]?.bin.slice(0, 10);
  const started = entry?.[2] ?? firstBin ?? today;
  const settled = addDays(started, SCAR_SETTLE_DAYS);
  const end = lastBin && lastBin > settled ? lastBin : settled;
  const yesterday = addDays(today, -1);
  const clamped = end < yesterday ? end : yesterday;
  let lat = 0;
  let lon = 0;
  for (const c of track.cells) {
    const [y, x] = cellToLatLng(c);
    lat += y;
    lon += x;
  }
  const n = track.cells.length || 1;
  return {
    id,
    label: `Burn scar · ${labelDate(started)}`,
    place: entry?.[3] ?? null,
    kind: "past",
    lon: lon / n,
    lat: lat / n,
    started,
    before: addDays(started, -BASELINE_LEAD_DAYS),
    // Never before ignition: a pre-fire frame on both halves of the swipe
    // reads as "the fire did nothing" (the pipeline's own max(after, start)).
    after: clamped > started ? clamped : started,
    // One decimal: areaText prints this verbatim, and the sidecar's 3 dp read on
    // a real fire as "776.121 km²" — false precision for a sum of 0.7 km² cells.
    area_km2: Math.round((entry?.[0] ?? trackAreaKm2(track.cells)) * 10) / 10,
    cum_cells: track.cells.length,
    // The card's own track load, and any later reopen, resolve this sentinel
    // to the fixed archive/tracks/<id>.json path (data.ts::loadTrack).
    track_gen: "archive",
  };
}
