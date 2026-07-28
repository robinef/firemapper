import type maplibregl from "maplibre-gl";
import { AGE_STOPS } from "./palette";

/**
 * Layer 2 — Fire arrival isochrones.
 *
 * Question answered: "How did the fire spread — when did it reach each place,
 * and where is the front now?"
 *
 * Visual variables (docs/cartography-rules.md):
 *   VALUE/HUE = arrival time, a COOL sequential ramp (bright cyan = the fire
 *               arrived minutes ago → deep indigo = arrived >12 h ago). Order
 *               data → value ramp; cool so it never reads as "intensity".
 *   SHAPE     = nested filled contours; the newest band sits at the front.
 *   Bright contour LINES mark each threshold so boundaries stay crisp where
 *               translucent fills overlap.
 *
 * Zoom: bands are a fire-scale story. Below ~z7 a whole fire is a few pixels
 * and the Active-fire footprint already carries extent, so isochrones stay
 * hidden until z7 and sharpen through z13.
 */

export const ISO_LAYER_IDS = ["iso-fill", "iso-line"];

const ageRamp = () =>
  AGE_STOPS.flatMap((s, i) => [i === 0 ? 0 : AGE_STOPS[i - 1].max, s.color]);

export function addIsochrones(map: maplibregl.Map, iso: GeoJSON.FeatureCollection) {
  const src = map.getSource("iso") as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(iso);
    return;
  }
  map.addSource("iso", { type: "geojson", data: iso });

  // Draw beneath the fire symbols/labels but above the basemap.
  const before = map.getLayer("fires-major") ? "fires-major" : undefined;

  map.addLayer(
    {
      id: "iso-fill",
      type: "fill",
      source: "iso",
      minzoom: 7,
      paint: {
        "fill-color": ["interpolate", ["linear"], ["get", "max_age"], ...ageRamp()] as never,
        // Translucent so nested bands read as a stack; a touch stronger up
        // close where the contours matter most.
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.22, 12, 0.4],
      },
    },
    before,
  );

  map.addLayer(
    {
      id: "iso-line",
      type: "line",
      source: "iso",
      minzoom: 7,
      paint: {
        "line-color": ["interpolate", ["linear"], ["get", "max_age"], ...ageRamp()] as never,
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.6, 11, 1.6, 13, 2.4],
        "line-opacity": 0.9,
      },
    },
    before,
  );
}

export const ISO_LEGEND = {
  title: "Fire arrival",
  entries: AGE_STOPS.map((s) => ({ color: s.color, label: s.label })),
  note: "When the fire reached each area. Bright = just now, dark = over 12 h ago.",
};
