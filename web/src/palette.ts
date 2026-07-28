/**
 * Shared colour scales.
 *
 * Deliberately free of any maplibre import: the layer/legend code needs these
 * values but must not pull in the map engine (which needs a real browser), so
 * legends stay unit-testable.
 */
import type { EventProps } from "./types";

export const STATE_COLORS: Record<EventProps["state"], string> = {
  accelerating: "#ff2d2d",
  growing: "#ff8c00",
  steady: "#ffd000",
  declining: "#8a8a8a",
};

// Hue split: each layer owns a distinct colour channel so nothing competes.
//   TIME (isochrones)  → cool ramp, bright cyan (fresh) → deep indigo (old)
//   INTENSITY (heatmap)→ hot reds/orange
//   SPEED (arrows)     → sage → bright yellow
//   VIIRS presence     → neutral grey (raster, desaturated)
//   WIND               → neutral white outline, off by default
export const AGE_STOPS: { max: number; color: string; label: string }[] = [
  { max: 20, color: "#c8f7ff", label: "< 20 min" },
  { max: 60, color: "#6fd8f5", label: "20–60 min" },
  { max: 180, color: "#3aa7e0", label: "1–3 h" },
  { max: 360, color: "#3b6fd4", label: "3–6 h" },
  { max: 720, color: "#4b49b8", label: "6–12 h" },
  { max: 9999, color: "#3a2a78", label: "> 12 h" },
];

// Local edge speed (km/h) for the spread arrows — a dimension the time bands
// do not show. Sage (creeping) → bright yellow (running).
export const SPEED_STOPS: { max: number; color: string; label: string }[] = [
  { max: 0.5, color: "#7da87d", label: "< 0.5 km/h" },
  { max: 1, color: "#a8c95e", label: "0.5–1 km/h" },
  { max: 2, color: "#d6dd3c", label: "1–2 km/h" },
  { max: 4, color: "#f7e01e", label: "2–4 km/h" },
  { max: 99999, color: "#fff8a0", label: "> 4 km/h" },
];

export const SPEED_RAMP: (number | string)[] = SPEED_STOPS.flatMap((s, i) => [
  i === 0 ? 0 : SPEED_STOPS[i - 1].max,
  s.color,
]);

export const AGE_RAMP: (number | string)[] = AGE_STOPS.flatMap((s, i) => [
  i === 0 ? 0 : AGE_STOPS[i - 1].max,
  s.color,
]);

// Wind is a context layer (off by default): neutral greys so it never
// competes with the time ramp, brightening only when it matters to fire.
export const WIND_STOPS: { max: number; color: string; label: string }[] = [
  { max: 10, color: "#8a8a8a", label: "< 10 km/h" },
  { max: 20, color: "#ababab", label: "10–20 km/h" },
  { max: 35, color: "#cdcdcd", label: "20–35 km/h" },
  { max: 50, color: "#eeeeee", label: "35–50 km/h" },
  { max: 9999, color: "#ffffff", label: "> 50 km/h" },
];

export const HEAT_COLORS = [
  0, "rgba(0,0,0,0)",
  0.15, "rgba(60,10,80,0.55)",
  0.35, "rgba(160,30,60,0.75)",
  0.55, "rgba(230,90,20,0.85)",
  0.75, "rgba(255,160,20,0.92)",
  1, "rgba(255,245,180,0.98)",
];

/** Relative luminance of a #rrggbb colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function outlineFor(hex: string): string {
  return luminance(hex) < 0.5 ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.75)";
}

export const markerColor = (s: EventProps["state"]) => STATE_COLORS[s];
