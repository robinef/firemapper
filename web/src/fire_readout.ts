/**
 * Two facts a reader wants while looking at one fire: how hard it is
 * burning, which way the wind is pushing it.
 *
 * Every judgement lives in `readoutModel`. THREE renderers consume it —
 * desktop overlay and two mobile renderings inside the card. If staleness
 * or distance rule leaks into a renderer it would drift between them silently.
 */

/** Beyond which a wind sample is far enough a renderer should name the distance. */
export const WIND_FAR_KM = 25;
/** Past which: no honest claim this fire has that wind. The grid is
 * 0.5 deg (~40-55 km here) with a 200-point sampling cap, so a fire may
 * be unsampled entirely; in case the nearest reading belongs elsewhere. */
export const WIND_MAX_KM = 60;
/** `MAX_AGE_S["wind"]` is 3 h in pipeline/freshness.py; a failed layer
 * carried past it. Wind older than its own budget is dropped rather than
 * shown: a carried forecast looks live but is worse than no wind at all. */
export const WIND_MAX_AGE_MIN = 180;

export type Readout = {
  intensity: { mw: number; ageMinutes: number } | null;
  wind: { bearingDeg: number; kmh: number; distanceKm: number; ageMinutes: number } | null;
};

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance. The grid is coarse, but planar approximation would
 * still mis-rank samples at the 60 km cutoff across a 10-degree latitude span. */
function distanceKm(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

function ageMinutes(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round((now.getTime() - t) / 60_000);
}

function newestIntensity(
  frpLive: [string, number][] | null,
  now: Date,
): Readout["intensity"] {
  if (!frpLive || frpLive.length === 0) return null;
  let best: { mw: number; ageMinutes: number } | null = null;
  for (const entry of frpLive) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [iso, mw] = entry;
    if (!iso || !Number.isFinite(mw)) continue;
    const age = ageMinutes(iso, now);
    // Selected by TIMESTAMP, not array position: the series arrives ordered
    // today, and a reading that silently depends on that is one upstream sort
    // away from reporting a stale observation as the current one.
    if (age === null || age < 0) continue;
    if (best === null || age < best.ageMinutes) best = { mw, ageMinutes: age };
  }
  return best;
}

function nearestWind(
  position: [number, number] | null,
  windPoints: GeoJSON.FeatureCollection | null,
  now: Date,
): Readout["wind"] {
  if (!position || !windPoints) return null;
  let best: NonNullable<Readout["wind"]> | null = null;
  for (const f of windPoints.features ?? []) {
    if (!f || f.geometry?.type !== "Point") continue;
    const coords = (f.geometry?.coordinates ?? []) as [number, number];
    if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const from = props.from_deg;
    const kmh = props.kmh;
    if (!Number.isFinite(from) || !Number.isFinite(kmh)) continue;
    const age = typeof props.t === "string" ? ageMinutes(props.t, now) : null;
    if (age === null || age < 0 || age > WIND_MAX_AGE_MIN) continue;
    const km = distanceKm(position, coords);
    if (!Number.isFinite(km) || km > WIND_MAX_KM) continue;
    if (best === null || km < best.distanceKm) {
      best = { bearingDeg: from, kmh, distanceKm: km, ageMinutes: age };
    }
  }
  return best;
}

export function readoutModel(
  frpLive: [string, number][] | null,
  position: [number, number] | null,
  windPoints: GeoJSON.FeatureCollection | null,
  now: Date,
): Readout | null {
  const intensity = newestIntensity(frpLive, now);
  const wind = nearestWind(position, windPoints, now);
  // Nothing to say means nothing on screen — not an empty box with headings.
  if (intensity === null && wind === null) return null;
  return { intensity, wind };
}
