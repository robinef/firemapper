import * as maplibregl from "maplibre-gl";
import type { Scar } from "./layer_imagery";

/**
 * Burn scars = PAST fires (green forest before → black scar after). Unlike the
 * live "Active fires" layer, these are settled scars you can actually SEE the
 * damage of: a fire burning right now has no scar yet in any satellite image,
 * so the before/after story only works for fires that already burned.
 *
 * Rendered as charcoal markers with an ember ring, clickable to enter the
 * before/after compare mode. Kept deliberately few (curated real megafires plus
 * any recent quiet fires) so the Europe view stays legible.
 */
export const SCAR_LAYER_IDS = ["scars-glow", "scars-dot", "scars-label"];
const SCAR_HUE = "#2e211b"; // burnt charcoal
const SCAR_RING = "#d1874f"; // ember

/** Build the clickable past-scar markers from the manifest's scar list. */
export function addScars(map: maplibregl.Map, scars: Scar[]) {
  const past = scars.filter((s) => s.kind === "past");
  const fc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: past.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { ...s },
    })),
  };
  const existing = map.getSource("scars") as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(fc);
    return;
  }
  map.addSource("scars", { type: "geojson", data: fc });
  // A soft dark halo so a scar reads even over dark terrain, an ember-ringed
  // charcoal dot, and a label — all visible Europe-wide since past megafires
  // are the whole point of this layer.
  map.addLayer({
    id: "scars-glow",
    type: "circle",
    source: "scars",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 9, 9, 20],
      "circle-color": "#000000",
      "circle-opacity": 0.4,
      "circle-blur": 0.7,
    },
  });
  map.addLayer({
    id: "scars-dot",
    type: "circle",
    source: "scars",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 5, 9, 10],
      "circle-color": SCAR_HUE,
      "circle-stroke-color": SCAR_RING,
      "circle-stroke-width": 1.6,
    },
  });
  map.addLayer({
    id: "scars-label",
    type: "symbol",
    source: "scars",
    minzoom: 4.5,
    layout: {
      "text-field": ["get", "label"],
      "text-size": 11,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
    },
    paint: {
      "text-color": "#e6c9a8",
      "text-halo-color": "#000000",
      "text-halo-width": 1.3,
    },
  });
}

export const SCAR_LEGEND = {
  title: "Burn scars · past fires",
  entries: [
    { color: SCAR_HUE, size: 12, shape: "dot" as const, label: "past megafire — click to compare" },
  ],
  note: "Real burned areas from recent European megafires. Click one to swipe green forest (before) vs black scar (after) — the damage a still-burning fire cannot yet show.",
};
