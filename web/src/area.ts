/**
 * Saying what we measured, and no more.
 *
 * `area_km2` is `cells x SENSOR cell size` — 0.7 km² for a VIIRS cell (H3 res
 * 8), 5.2 km² for a Meteosat one (H3 res 7). So a single Meteosat pixel reports
 * 5.2 km² when all it establishes is that the fire is somewhere inside that
 * pixel: the burned area could be a hectare or the whole cell.
 *
 * The pipeline already refuses to size those — `size_class` returns `minor`
 * whenever `cells <= 1`, whatever the area — so the map classified a fire as
 * unsized while the text printed a confident number for the same fire.
 *
 * Not needed by the label layer: it filters `minor` out, and every one-cell
 * fire is `minor`, so a label can never carry an unresolved area.
 */

/** True when the footprint is a single cell, i.e. detected but not measured.
 *
 * `cells == null` catches null AND undefined deliberately. A JSON null passes
 * `cells !== undefined` and then `null <= 1` is TRUE in JS, so a 40-cell fire
 * whose count arrived as null would be described as one unresolved pixel —
 * a confident, plausible, false claim, and a worse one than the bug this
 * module exists to fix. `NaN` fails every comparison and so reads as sized,
 * which is the safe direction.
 */
function unsized(cells: number | null | undefined): boolean {
  return cells != null && cells <= 1;
}

/** Area as text, marked as an upper bound when the footprint is a single cell. */
export function areaText(areaKm2: number, cells: number | null | undefined): string {
  return `${unsized(cells) ? "≤" : ""}${areaKm2} km²`;
}

/** How the footprint is made up, and why one cell is not a size. Includes its
 *  own parentheses so a missing count leaves no dangling "()" behind. */
export function cellsText(cells: number | null | undefined): string {
  if (cells == null || !Number.isFinite(cells)) return "";
  if (cells <= 1) return " (1 cell — size not resolved)";
  return ` (${cells} cells)`;
}

/** Short "why is there a ≤" note for surfaces with room for one. Empty when the
 *  extent is resolved and no explanation is owed. */
export function footprintNote(cells: number | null | undefined): string {
  return unsized(cells) ? "1 sensor pixel — size not resolved" : "";
}
