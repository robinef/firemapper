import type maplibregl from "maplibre-gl";

/**
 * Layer 5 — Wind (Open-Meteo forecast surface wind).
 *
 * Question answered: "Which way, and how hard, is the wind pushing the fire?"
 *
 * Wind is the single biggest driver of fire spread, but it is NOT the observed
 * fire movement — so it must look unmistakably different from Layer 4:
 *   - spread arrows are solid, hot-coloured triangles;
 *   - wind is a thin, cool, open streamline. Different FORM = different meaning.
 *
 * Visual variables (docs/cartography-rules.md):
 *   ORIENTATION = wind direction, pointing DOWNWIND (where it blows to, i.e.
 *                 where it pushes the fire) — from_deg is the meteorological
 *                 "coming from", so the glyph is rotated from_deg + 180.
 *   VALUE       = wind speed, a cool light→bright ramp; a context variable, so
 *                 muted, never competing with the fire layers.
 *
 * A coarse forecast grid (~0.5°), so it reads as a field at every zoom; a
 * context layer, off by default.
 */

export const WIND_LAYER_IDS = ["wind-arrows"];

const WIND_ICON = "wind-streamline";

/** Thin open streamline arrow — deliberately unlike the solid spread glyph. */
function streamlineImage(size = 30): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const m = size / 2;
  ctx.translate(m, m);
  ctx.strokeStyle = "#cfe8ff";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath(); // shaft
  ctx.moveTo(0, m - 3);
  ctx.lineTo(0, -m + 5);
  ctx.stroke();
  ctx.beginPath(); // open head (two strokes, no fill)
  ctx.moveTo(-4, -m + 10);
  ctx.lineTo(0, -m + 4);
  ctx.lineTo(4, -m + 10);
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

export function addWind(map: maplibregl.Map, wind: GeoJSON.FeatureCollection) {
  const src = map.getSource("wind") as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(wind);
    return;
  }
  map.addSource("wind", { type: "geojson", data: wind });
  if (!map.hasImage(WIND_ICON)) map.addImage(WIND_ICON, streamlineImage(), { pixelRatio: 2 });

  map.addLayer({
    id: "wind-arrows",
    type: "symbol",
    source: "wind",
    layout: {
      "icon-image": WIND_ICON,
      // from_deg is where wind comes FROM; +180 points it downwind.
      "icon-rotate": ["+", ["coalesce", ["get", "from_deg"], 0], 180],
      "icon-rotation-alignment": "map",
      // The wind grid is coarse (~0.5°), so each glyph must read on its own —
      // large, and growing with speed and zoom.
      "icon-size": [
        "interpolate", ["linear"], ["zoom"],
        5, ["interpolate", ["linear"], ["coalesce", ["get", "kmh"], 0], 0, 0.9, 40, 1.6],
        11, ["interpolate", ["linear"], ["coalesce", ["get", "kmh"], 0], 0, 1.6, 40, 2.8],
      ],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      // Speed label so a sparse field is still quantitative.
      "text-field": ["concat", ["to-string", ["round", ["coalesce", ["get", "kmh"], 0]]], " km/h"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.6],
      "text-optional": true,
    },
    paint: {
      "icon-opacity": 0.95,
      "text-color": "#cfe8ff",
      "text-halo-color": "rgba(0,0,0,0.85)",
      "text-halo-width": 1.2,
    },
  });
}

export const WIND_LEGEND = {
  title: "Wind",
  entries: [
    { color: "#cfe8ff", label: "arrow = downwind" },
  ],
  note: "Forecast surface wind — arrows point where it pushes the fire. Longer/brighter = stronger. This is not observed fire movement.",
};
