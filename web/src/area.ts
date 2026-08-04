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
 * unsized while the panel printed a confident "5.2 km² burning area (1 cells)"
 * for the same fire. This makes the words agree with the classification.
 *
 * Only the panel and the fire card need it: the label layer filters `minor`
 * out, and every one-cell fire is `minor`, so a label can never carry an
 * unresolved area.
 */

/** Area as text, marked as an upper bound when the footprint is a single cell. */
export function areaText(areaKm2: number, cells: number | undefined): string {
  // `cells` absent (an older generation, a feature missing the property) means
  // we do not know whether it was resolved — so claim neither a bound nor a
  // measurement, just the number we have.
  const bound = cells !== undefined && cells <= 1 ? "≤" : "";
  return `${bound}${areaKm2} km²`;
}

/** How the footprint is made up, and why one cell is not a size. */
export function cellsText(cells: number | undefined): string {
  if (cells === undefined) return "";
  if (cells <= 1) return "1 cell — size not resolved";
  return `${cells} cells`;
}
