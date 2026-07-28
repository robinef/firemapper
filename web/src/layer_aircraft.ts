import type maplibregl from "maplibre-gl";

/**
 * Layer 7 — Firefighting aircraft (OpenSky ADS-B).
 *
 * Question answered: "Are aircraft fighting this fire, and where are they?"
 *
 * The response dimension none of the fire layers carry. Only aircraft we can
 * identify as firefighting assets by callsign are shown, so the map never
 * implies an airliner is a water bomber.
 *
 * Visual variables (docs/cartography-rules.md):
 *   SHAPE       = a plane silhouette — instantly "aircraft", unlike any fire glyph.
 *   ORIENTATION = heading (icon-rotate), so a moving bomber points its track.
 *   HUE         = role: cyan = water bomber, white = coordination. A category,
 *                 and deliberately OUTSIDE every fire ramp (cool/neutral).
 *   VALUE       = airborne vs on-ground (dimmed on the ground at base).
 *
 * Airspace is not fire-scale, so shown at all zooms; a small halo keeps a lone
 * plane findable over a bright fire.
 */

export const AIRCRAFT_LAYER_IDS = ["aircraft-halo", "aircraft", "aircraft-label"];

const BOMBER = "#26d0ce";
const COORD = "#ffffff";
const HELI = "#b39ddb";
const ICON_BOMBER = "ff-plane-bomber";
const ICON_COORD = "ff-plane-coord";
const ICON_HELI = "ff-plane-heli";

/** Top-down plane silhouette in `color`, drawn to a canvas (CSP-safe). */
function planeImage(color: string, size = 40): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const m = size / 2;
  ctx.translate(m, m);
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  // nose up (north); fuselage + swept wings + tail
  ctx.moveTo(0, -m + 3);
  ctx.lineTo(2, -2);
  ctx.lineTo(m - 4, 6);
  ctx.lineTo(m - 4, 9);
  ctx.lineTo(2, 4);
  ctx.lineTo(2, m - 8);
  ctx.lineTo(6, m - 4);
  ctx.lineTo(6, m - 2);
  ctx.lineTo(0, m - 5);
  ctx.lineTo(-6, m - 2);
  ctx.lineTo(-6, m - 4);
  ctx.lineTo(-2, m - 8);
  ctx.lineTo(-2, 4);
  ctx.lineTo(-(m - 4), 9);
  ctx.lineTo(-(m - 4), 6);
  ctx.lineTo(-2, -2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

export function addAircraft(map: maplibregl.Map, fc: GeoJSON.FeatureCollection) {
  const src = map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(fc);
    return;
  }
  map.addSource("aircraft", { type: "geojson", data: fc });
  if (!map.hasImage(ICON_BOMBER)) map.addImage(ICON_BOMBER, planeImage(BOMBER), { pixelRatio: 2 });
  if (!map.hasImage(ICON_COORD)) map.addImage(ICON_COORD, planeImage(COORD), { pixelRatio: 2 });
  if (!map.hasImage(ICON_HELI)) map.addImage(ICON_HELI, planeImage(HELI), { pixelRatio: 2 });

  // Soft halo so a lone plane is findable over a bright fire.
  map.addLayer({
    id: "aircraft-halo",
    type: "circle",
    source: "aircraft",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 8, 10, 16],
      "circle-color": ["case", ["get", "on_ground"], "rgba(0,0,0,0)", "rgba(38,208,206,0.18)"],
      "circle-blur": 0.6,
    },
  });

  map.addLayer({
    id: "aircraft",
    type: "symbol",
    source: "aircraft",
    layout: {
      // Pre-coloured icons by role: cyan bomber, white coordination, violet
      // rescue helicopter.
      "icon-image": [
        "match", ["get", "role"],
        "air coordination", ICON_COORD,
        "rescue helicopter", ICON_HELI,
        ICON_BOMBER,
      ] as never,
      "icon-rotate": ["coalesce", ["get", "heading"], 0],
      "icon-rotation-alignment": "map",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.45, 10, 0.8, 14, 1.1],
      "icon-allow-overlap": true,
    },
    paint: {
      // Dim on the ground (at base) and dim a stale airborne fix — a plane at
      // ~350 km/h moves ~6 km/min, so an old position should not look certain.
      "icon-opacity": [
        "case",
        ["get", "on_ground"], 0.5,
        [">", ["coalesce", ["get", "age_min"], 0], 5], 0.45,
        1,
      ] as never,
    },
  });

  map.addLayer({
    id: "aircraft-label",
    type: "symbol",
    source: "aircraft",
    minzoom: 7,
    layout: {
      "text-field": ["get", "callsign"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.3],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": BOMBER,
      "text-halo-color": "rgba(0,0,0,0.85)",
      "text-halo-width": 1.3,
    },
  });
}

export const AIRCRAFT_LEGEND = {
  title: "Firefighting aircraft",
  entries: [
    { color: BOMBER, size: 12, shape: "square" as const, label: "water bomber" },
    { color: COORD, size: 12, shape: "square" as const, label: "coordination plane" },
    { color: HELI, size: 12, shape: "square" as const, label: "rescue helicopter" },
    { color: "rgba(38,208,206,0.5)", size: 12, shape: "square" as const, label: "on the ground / stale fix (dim)" },
  ],
  note: "ADS-B, nose = heading. Shows only aircraft AIRBORNE right now — most of the fleet sits parked with its transponder off between missions.",
};
