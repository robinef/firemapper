/**
 * How many fires are here, and how many can you actually see?
 *
 * The two numbers differ, badly, and the gap is invisible. Fire dots are gated
 * per size class — major from z3, medium from z6, minor only from z8.5 — while
 * `size_class` buckets at 50 and 15 km² (pipeline/export.py). Real fires are
 * mostly small: of 1344 live fires in production on 2026-08-04, 1335 were
 * `minor`. So at the continental view "Active fires" is ticked and draws
 * essentially nothing, which reads as broken rather than as zoomed-out.
 *
 * Counting is the honest fix: say how many are in view and how many the current
 * zoom is drawing, so an empty-looking map is explained rather than mysterious.
 */

/** Zoom at which each size class starts drawing. Mirrors CLASS_MINZOOM in
 * layer_fires.ts — kept here as data so the count can be computed without a
 * map instance, and asserted equal in tests. */
export const CLASS_MINZOOM: Record<string, number> = { major: 3, medium: 6, minor: 8.5 };

export interface FireCount {
  /** Live (non-closed) fires whose centroid is inside the viewport. */
  inView: number;
  /** How many of those the current zoom actually draws. */
  shown: number;
  /** The lowest zoom that would draw every one of them, or null when they are
   * all already visible. */
  zoomToSeeAll: number | null;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

function inBounds(lon: number, lat: number, b: Bounds): boolean {
  if (lat < b.south || lat > b.north) return false;
  // A viewport crossing the antimeridian has west > east.
  return b.west <= b.east ? lon >= b.west && lon <= b.east : lon >= b.west || lon <= b.east;
}

/**
 * Count live fires in view and how many are drawn at `zoom`.
 *
 * `closed` fires are excluded: they are a separate, opt-in layer, so counting
 * them under "Active fires" would trade one misleading number for another.
 */
export function countFires(
  features: GeoJSON.Feature[],
  bounds: Bounds,
  zoom: number,
  /** True when the reader has turned the zoom gates off (setShowAllSizes), in
   * which case everything in view is drawn regardless of class. Without this
   * the counter contradicts the map — "1 of 101" over 101 visible dots — which
   * is the same misleading gap this exists to close, pointing the other way. */
  showAllSizes = false,
): FireCount {
  let inView = 0;
  let shown = 0;
  let deepestHidden = 0;
  for (const f of features) {
    if (f.geometry?.type !== "Point") continue;
    const p = (f.properties ?? {}) as { status?: string; size_class?: string };
    if (p.status === "closed") continue;
    const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    if (!inBounds(lon, lat, bounds)) continue;
    inView++;
    const min = showAllSizes ? 0 : CLASS_MINZOOM[p.size_class ?? "minor"] ?? CLASS_MINZOOM.minor;
    if (zoom >= min) shown++;
    // The DEEPEST gate among the hidden ones: zooming to the shallowest would
    // still leave fires undrawn, which is worse than not advising at all.
    else deepestHidden = Math.max(deepestHidden, min);
  }
  return {
    inView,
    shown,
    zoomToSeeAll: deepestHidden || null,
  };
}

/**
 * One line for the layer row. Silent when everything in view is drawn — a
 * counter that never shuts up becomes furniture and stops being read.
 */
export function countLabel(c: FireCount): string | null {
  if (!c.inView) return null;
  if (c.shown === c.inView) return `${c.inView} in view`;
  return `${c.shown} of ${c.inView} in view · zoom in for the rest`;
}
