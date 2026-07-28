import type maplibregl from "maplibre-gl";
import { HEAT_COLORS } from "./palette";

/**
 * Layer 3 — Live fire intensity (Meteosat FRP).
 *
 * Question answered: "How violently is it burning right now?"
 *
 * Fire Radiative Power (megawatts) is the measured heat output — the honest
 * "how bad right now" signal, refreshed every ~10 min.
 *
 * Visual variables (docs/cartography-rules.md):
 *   VALUE = FRP, a HOT sequential ramp (deep red → bright yellow-white). This
 *           is the ONE layer where warm hue is correct: it means heat.
 *   SIZE  = FRP again, at high zoom, as graduated circles — Bertin's only
 *           truly quantitative variable, so a citizen can compare pixel power.
 *
 * Zoom transform: a weighted HEATMAP at Europe/region scale shows where the
 * heat is concentrated (pattern); from z8 it hands to graduated circles so
 * individual pixel power is legible (magnitude). Never both at full strength.
 */

export const INTENSITY_LAYER_IDS = ["frp-heat", "frp-graduated"];

export function addIntensity(map: maplibregl.Map, frp: GeoJSON.FeatureCollection) {
  const src = map.getSource("frp") as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(frp);
    return;
  }
  map.addSource("frp", { type: "geojson", data: frp });
  const before = map.getLayer("fires-major") ? "fires-major" : undefined;

  map.addLayer(
    {
      id: "frp-heat",
      type: "heatmap",
      source: "frp",
      maxzoom: 9.5,
      paint: {
        // Weight by megawatts, capped so one huge fire doesn't flatten the
        // rest; most pixels are < 100 MW.
        "heatmap-weight": [
          "interpolate", ["linear"], ["get", "frp"], 0, 0.02, 50, 0.15, 300, 0.6, 1500, 1,
        ],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 3, 0.9, 9, 1.4],
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], ...HEAT_COLORS] as never,
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 3, 5, 7, 16, 9, 28],
        // Fade out as the graduated circles take over.
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.9, 9.5, 0],
      },
    },
    before,
  );

  map.addLayer(
    {
      id: "frp-graduated",
      type: "circle",
      source: "frp",
      minzoom: 8,
      paint: {
        // Radius ∝ √FRP so circle AREA tracks power.
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          8, ["+", 1.5, ["*", 0.28, ["sqrt", ["coalesce", ["get", "frp"], 0]]]],
          13, ["+", 2.5, ["*", 0.8, ["sqrt", ["coalesce", ["get", "frp"], 0]]]],
        ] as never,
        "circle-color": [
          "interpolate", ["linear"], ["get", "frp"],
          0, "#7a0f2b", 50, "#c8341a", 150, "#f07a12", 400, "#ffc21e", 1200, "#fff6b0",
        ] as never,
        // Semi-transparent so overlapping pixels read as a brightness gradient,
        // not a solid white mass.
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 9, 0.7],
        "circle-blur": 0.3,
        "circle-stroke-width": 0,
      },
    },
    before,
  );
}

export const INTENSITY_LEGEND = {
  title: "Fire intensity (MW)",
  entries: [
    { color: "#7a0f2b", label: "low" },
    { color: "#c8341a", label: "" },
    { color: "#f07a12", label: "moderate" },
    { color: "#ffc21e", label: "" },
    { color: "#fff6b0", label: "extreme" },
  ],
  note: "Radiative power = heat output right now (Meteosat, ~10 min). Bigger, brighter = more intense.",
};
