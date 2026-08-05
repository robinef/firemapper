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

/** Where the dot begins handing over to the footprint outline (layer_fires.ts).
 *
 * It is no longer a cutoff. The dot layers used to carry maxzoom 9.5, so at
 * this zoom every fire stopped being drawn and only the 38% with an outline
 * were still on the map. Now the handover is per fire: a covered one fades to
 * nothing and its outline speaks for it, an uncovered one keeps its dot. Above
 * this zoom every fire in view is therefore represented by something, which is
 * why the count stops subtracting here. */
export const HANDOVER_ZOOM = 9.5;

export interface FireCount {
  /** Live (non-closed) fires whose centroid is inside the viewport. */
  inView: number;
  /** How many of those the current zoom actually draws. */
  shown: number;
  /** Why the undrawn ones are missing. Only one reason remains: the class
   *  gates below. There was a second — past the handover the dots were cut
   *  off entirely and the label had to say "zoom out" instead of "zoom in" —
   *  but that state no longer exists now that uncovered fires keep their dot,
   *  so the union keeps a single case rather than one that can never fire. */
  hidden: "none" | "below-gate";
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
    // Past the handover the class gates no longer decide anything: they all
    // sit below it, so every recognised fire is on the map either as its own
    // dot or as part of the outline that replaced it.
    if (known && (zoom >= HANDOVER_ZOOM || zoom >= (showAllSizes ? 0 : min))) shown++;
  }
  return { inView, shown, hidden: shown === inView ? "none" : "below-gate" };
}

/**
 * One line for the layer row. Silent when everything in view is drawn — a
 * counter that never shuts up becomes furniture and stops being read.
 */
export function countLabel(c: FireCount): string | null {
  if (!c.inView) return null;
  if (c.hidden === "none") return `${c.inView} in view`;
  // Below the gates. Zooming in works, but so does the size filter sitting
  // directly under this line, and most readers never find it: on 2026-08-05,
  // 2860 of 3728 live fires were `minor` and stayed hidden until z8.5.
  return `${c.shown} of ${c.inView} in view · zoom in, or tick “Show every size”`;
}
