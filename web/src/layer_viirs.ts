import type * as maplibregl from "maplibre-gl";
import { viirsTileUrl } from "./map";

/**
 * Layer 6 — VIIRS 375 m hotspots (NASA GIBS).
 *
 * Question answered: "At the finest resolution, where exactly has fire been
 * detected today?"
 *
 * VIIRS resolves ~375 m — roughly 28x the detail of Meteosat's ~2 km — so it
 * is the reference-detail layer. But NASA renders it server-side as a flat-red
 * raster: it carries neither age nor intensity, and its colour cannot be
 * restyled per pixel.
 *
 * Cartographic choice (docs/cartography-rules.md): do NOT let it borrow a
 * meaning it does not have. The raster is desaturated to a neutral grey
 * presence wash — reference texture, not a colour code — kept low-contrast so
 * it never competes with the analytic layers. A fine-detail layer, so it only
 * appears from z8; off by default.
 */

export const VIIRS_LAYER_IDS = ["viirs"];

export function addViirs(map: maplibregl.Map, dayIso: string) {
  if (map.getSource("viirs")) return;
  map.addSource("viirs", { type: "raster", tiles: [viirsTileUrl(dayIso)], tileSize: 256 });
  const before = map.getLayer("fires-major") ? "fires-major" : undefined;
  map.addLayer(
    {
      id: "viirs",
      type: "raster",
      minzoom: 8,
      source: "viirs",
      paint: {
        "raster-saturation": -1, // strip NASA's red → neutral grey
        "raster-brightness-max": 0.9,
        "raster-opacity": 0.6,
      },
    },
    before,
  );
}

export const VIIRS_LEGEND = {
  title: "VIIRS detail (375 m)",
  entries: [{ color: "#b9b9b9", label: "detected today" }],
  note: "Finest-resolution detection footprint (NASA). Presence only — no age or intensity. Use Fire arrival for timing, Fire intensity for power.",
};
