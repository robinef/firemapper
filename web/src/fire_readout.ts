/**
 * Two facts a reader wants while looking at one fire: how hard it is
 * burning, which way the wind is pushing it.
 *
 * Every judgement lives in `readoutModel`. THREE renderers consume it —
 * desktop overlay and two mobile renderings inside the card. If staleness
 * or distance rule leaks into a renderer it would drift between them silently.
 */

import { escapeHtml } from "./escape";
import { compass } from "./panel";

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
  const age = Math.round((now.getTime() - t) / 60_000);
  if (!Number.isFinite(age)) return null;
  return age;
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
    if (
      typeof iso !== "string" || typeof mw !== "number" ||
      !iso || !Number.isFinite(mw)
    ) continue;
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
    if (
      typeof from !== "number" || typeof kmh !== "number" ||
      !Number.isFinite(from) || !Number.isFinite(kmh)
    ) continue;
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

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function fmtAgeShort(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** arrow points where wind GOING: from_deg + 180, same
 * convention layer_wind.ts uses for streamline glyphs.
 * Diverge here and the overlay contradicts the map layer for anyone
 * viewing both on screen. */
function arrow(bearingDeg: number): string {
  let rotation = (bearingDeg + 180) % 360;
  if (!Number.isFinite(rotation)) rotation = 0;
  return `<span class="ro-arrow" style="transform:rotate(${rotation}deg)" aria-hidden="true">↑</span>`;
}

export function renderReadoutFull(model: Readout): string {
  if (!model.intensity && !model.wind) return "";
  const intensity = model.intensity
    ? `<div class="ro-lab">Burning</div>` +
      `<div class="ro-big">${escapeHtml(String(Math.round(model.intensity.mw)))} MW</div>` +
      `<div class="ro-age">${escapeHtml(fmtAge(model.intensity.ageMinutes))}</div>`
    : "";
  const w = model.wind;
  // Age always, distance only when it is far enough to matter. Wind that is
  // still on screen has passed the staleness cutoff but can be hours old, and
  // the reader has no other signal.
  const qualifier = w
    ? `<div class="ro-age">${escapeHtml(fmtAge(w.ageMinutes))}` +
      (w.distanceKm > WIND_FAR_KM ? ` · ${escapeHtml(String(Math.round(w.distanceKm)))} km away` : "") +
      `</div>`
    : "";
  const wind = w
    ? `<div class="ro-lab">Wind</div>` +
      `<div class="ro-wind">${arrow(w.bearingDeg)} ${escapeHtml(compass(w.bearingDeg))} ${escapeHtml(String(Math.round(w.kmh)))} km/h</div>` +
      qualifier
    : "";
  const rule = intensity && wind ? `<div class="ro-rule"></div>` : "";
  return `<div class="ro-body">${intensity}${rule}${wind}</div>`;
}

export function renderReadoutPeek(model: Readout): string {
  if (!model.intensity && !model.wind) return "";
  const intensity = model.intensity
    ? `<span class="ro-peek-mw">${escapeHtml(String(Math.round(model.intensity.mw)))} MW</span>` +
      `<span class="ro-peek-age">${escapeHtml(fmtAgeShort(model.intensity.ageMinutes))}</span>`
    : "";
  const wind = model.wind
    ? `<span class="ro-peek-wind">${arrow(model.wind.bearingDeg)} ${escapeHtml(compass(model.wind.bearingDeg))} ${escapeHtml(String(Math.round(model.wind.kmh)))}</span>` +
      `<span class="ro-peek-age">${escapeHtml(fmtAgeShort(model.wind.ageMinutes))}</span>`
    : "";
  // Spacing between spans is provided by .ro-peek's flex gap CSS.
  return `<span class="ro-peek">${intensity}${wind}</span>`;
}
