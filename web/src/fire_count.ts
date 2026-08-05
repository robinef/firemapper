/**
 * How many fires are here, and how many can you actually see?
 *
 * The two numbers differ, badly, and the gap is invisible. Fire dots are gated
 * per size class — major from z3, medium from z6, minor only from z8.5 — and
 * they also STOP at z9.5, where the footprint polygon takes over. Real fires
 * are mostly small: even on the NWCG scale, 2630 of 2828 live fires on
 * 2026-08-04 were `minor`. So at the continental view "Active fires" is ticked
 * and draws essentially nothing, which reads as broken rather than zoomed-out.
 *
 * Counting is the honest fix: say how many are in view and how many the current
 * zoom is drawing, so an empty-looking map is explained rather than mysterious.
 */

/** Zoom at which each size class starts drawing. Mirrors CLASS_MINZOOM in
 * layer_fires.ts — kept here as data so the count can be computed without a
 * map instance, and asserted equal in tests. */
export const CLASS_MINZOOM: Record<string, number> = { major: 3, medium: 6, minor: 8.5 };

/** Fire dots stop here and the footprint polygon takes over (layer_fires.ts).
 * MapLibre treats maxzoom as EXCLUSIVE, so at z9.5 nothing is drawn — and a
 * fire card flies to z10.5, where a counter ignoring this reads "20 in view"
 * over an empty map. */
export const CLASS_MAXZOOM = 9.5;

export interface FireCount {
  /** Live (non-closed) fires whose centroid is inside the viewport. */
  inView: number;
  /** How many of those the current zoom actually draws. */
  shown: number;
  /** Why the undrawn ones are missing, so the label can give advice that
   *  actually works. The two cases need OPPOSITE instructions and used to
   *  share one message: below the class gates you zoom IN, but past
   *  CLASS_MAXZOOM the dots have handed over to the footprint and only
   *  zooming OUT brings them back. */
  hidden: "none" | "below-gate" | "past-handover";
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

function inBounds(lon: number, lat: number, b: Bounds): boolean {
  if (lat < b.south || lat > b.north) return false;
  // MapLibre wraps the centre but not the corners, so panning past ±180 yields
  // bounds like {west: 150, east: 190} while feature longitudes stay in
  // [-180,180]. Shift the feature into the bounds' frame rather than branching
  // on west > east, which getBounds() never actually produces.
  for (const shifted of [lon, lon + 360, lon - 360]) {
    if (shifted >= b.west && shifted <= b.east) return true;
  }
  return false;
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
  for (const f of features) {
    if (f.geometry?.type !== "Point") continue;
    const p = (f.properties ?? {}) as { status?: string; size_class?: string };
    if (p.status === "closed") continue;
    const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    if (!inBounds(lon, lat, bounds)) continue;
    inView++;
    // An unrecognised class matches NO layer filter, so it is never drawn at
    // any zoom — Infinity, not minor's gate, or the count claims a dot that
    // does not exist.
    const known = Object.prototype.hasOwnProperty.call(CLASS_MINZOOM, p.size_class ?? "");
    const min = known ? CLASS_MINZOOM[p.size_class as string] : Infinity;
    if (zoom >= (showAllSizes && known ? 0 : min) && zoom < CLASS_MAXZOOM) shown++;
  }
  const hidden =
    shown === inView ? "none" : zoom >= CLASS_MAXZOOM ? "past-handover" : "below-gate";
  return { inView, shown, hidden };
}

/**
 * One line for the layer row. Silent when everything in view is drawn — a
 * counter that never shuts up becomes furniture and stops being read.
 */
export function countLabel(c: FireCount): string | null {
  if (!c.inView) return null;
  if (c.hidden === "none") return `${c.inView} in view`;
  // Past the handover the dots are gone for EVERY class, so `shown` is 0 and
  // "zoom in for the rest" sends the reader further from what they want. It is
  // also not safe to promise outlines instead: the footprint is one merged
  // MultiPolygon built from the isochrones, and on 2026-08-05 only 38% of live
  // fires fell inside it — the other 62% draw nothing at all up here. So the
  // advice is the one thing that always works: go back down.
  if (c.hidden === "past-handover") {
    return `${c.inView} in view · zoomed in past the dots — zoom out to see them`;
  }
  // Below the gates. Zooming in works, but so does the size filter sitting
  // directly under this line, and most readers never find it: on 2026-08-05,
  // 2860 of 3728 live fires were `minor` and stayed hidden until z8.5.
  return `${c.shown} of ${c.inView} in view · zoom in, or tick “Show every size”`;
}
