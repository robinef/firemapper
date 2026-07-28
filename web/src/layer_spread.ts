import type maplibregl from "maplibre-gl";
import { SPEED_STOPS } from "./palette";
import { speedArrowExpression, speedArrowIconName } from "./map";

/**
 * Layer 4 — Fire spread.
 *
 * Question answered: "Which way is the fire moving, and how fast?"
 *
 * Direction is measured from the local age gradient (an arrow points toward
 * fresher detections); speed is the local edge rate in km/h.
 *
 * Visual variables (docs/cartography-rules.md):
 *   ORIENTATION = spread direction — Bertin's variable for direction, so the
 *                 arrow literally points where the fire is going.
 *   VALUE       = speed, a sage → bright-yellow ramp (creeping → running). A
 *                 NEW dimension the arrival bands do not carry.
 *   Pixels with a direction but no measurable rate fall to the slowest band;
 *   pixels with no gradient get no arrow at all (honest absence).
 *
 * Zoom: a fire-scale reading, so hidden below z7; arrows grow with zoom.
 */

export const SPREAD_LAYER_IDS = ["spread-arrows"];

const ICON_SIZE_BY_ZOOM = ["interpolate", ["linear"], ["zoom"], 7, 0.4, 10, 0.7, 14, 1.05];

/** Re-registers the per-speed arrow icons this layer draws with. */
function registerSpeedIcons(map: maplibregl.Map, image: (color: string) => ImageData) {
  SPEED_STOPS.forEach((s, i) => {
    const name = speedArrowIconName(i);
    if (!map.hasImage(name)) map.addImage(name, image(s.color), { pixelRatio: 2 });
  });
}

/** Small filled arrowhead in `color`, drawn to a canvas (CSP-safe, no asset). */
function arrowImage(color: string, size = 26): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const m = size / 2;
  ctx.translate(m, m);
  ctx.beginPath();
  ctx.moveTo(0, -m + 2);
  ctx.lineTo(m - 4, m - 4);
  ctx.lineTo(0, m * 0.35);
  ctx.lineTo(-m + 4, m - 4);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

export function addSpread(map: maplibregl.Map, frp: GeoJSON.FeatureCollection) {
  if (!map.getSource("frp")) map.addSource("frp", { type: "geojson", data: frp });
  if (map.getLayer("spread-arrows")) return;

  registerSpeedIcons(map, arrowImage);
  const before = map.getLayer("fires-major") ? "fires-major" : undefined;

  map.addLayer(
    {
      id: "spread-arrows",
      type: "symbol",
      source: "frp",
      minzoom: 7,
      filter: ["has", "dir"],
      layout: {
        "icon-image": speedArrowExpression() as never,
        "icon-rotate": ["get", "dir"],
        "icon-rotation-alignment": "map",
        "icon-size": ICON_SIZE_BY_ZOOM as never,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    },
    before,
  );
}

export const SPREAD_LEGEND = {
  title: "Spread speed",
  entries: SPEED_STOPS.map((s) => ({ color: s.color, label: s.label })),
  note: "Arrows point where the fire is moving; colour = how fast the edge is advancing.",
};
