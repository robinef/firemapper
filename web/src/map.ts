import * as maplibregl from "maplibre-gl";
import { cellToBoundary } from "h3-js";
import type { EventProps, Slice } from "./types";
import {
  AGE_RAMP,
  HEAT_COLORS,
  SPEED_STOPS,
  STATE_COLORS,
  WIND_STOPS,
  outlineFor,
} from "./palette";

export {
  AGE_RAMP,
  AGE_STOPS,
  HEAT_COLORS,
  SPEED_RAMP,
  SPEED_STOPS,
  STATE_COLORS,
  WIND_STOPS,
  luminance,
  markerColor,
  outlineFor,
} from "./palette";
// EventProps is used by buildArrowFeatures below.


export function createMap(container: string): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    // CARTO dark-matter: keyless, CORS-enabled, and reliably fires `load`
    // (OpenFreeMap intermittently stalled the style load in embedded browsers).
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [10, 44],
    zoom: 4.2,
  });
  // The canvas is sized at construction; if the container was still laying out
  // (or the window changes), the map renders into a stale, clipped viewport.
  const el = document.getElementById(container);
  if (el && "ResizeObserver" in window) {
    new ResizeObserver(() => map.resize()).observe(el);
  }
  window.addEventListener("resize", () => map.resize());
  return map;
}

const colorExpr = [
  "match",
  ["get", "state"],
  "accelerating",
  STATE_COLORS.accelerating,
  "growing",
  STATE_COLORS.growing,
  "steady",
  STATE_COLORS.steady,
  STATE_COLORS.declining,
] as unknown as maplibregl.ExpressionSpecification;

export function addEventsLayer(map: maplibregl.Map, fc: GeoJSON.FeatureCollection) {
  map.addSource("fires", { type: "geojson", data: fc });
  map.addLayer({
    id: "fires-glow",
    type: "circle",
    source: "fires",
    paint: {
      "circle-color": colorExpr,
      "circle-radius": ["interpolate", ["linear"], ["get", "area_km2"], 0, 10, 50, 40],
      "circle-blur": 1,
      "circle-opacity": 0.35,
    },
  });
  map.addLayer({
    id: "fires",
    type: "circle",
    source: "fires",
    paint: {
      "circle-color": colorExpr,
      "circle-radius": ["interpolate", ["linear"], ["get", "area_km2"], 0, 4, 50, 20],
      "circle-opacity": ["match", ["get", "status"], "stale", 0.5, "closed", 0.3, 0.95],
      "circle-stroke-width": 1,
      "circle-stroke-color": "#1a0000",
    },
  });
}

export function updateEvents(map: maplibregl.Map, fc: GeoJSON.FeatureCollection) {
  (map.getSource("fires") as maplibregl.GeoJSONSource | undefined)?.setData(fc);
}

// ── movement arrow ───────────────────────────────────────────────
export function showArrow(map: maplibregl.Map, from: [number, number], bearingDeg: number) {
  const km = 8;
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (km / 111) * Math.cos(rad);
  const dLon = (km / (111 * Math.cos((from[1] * Math.PI) / 180))) * Math.sin(rad);
  const to: [number, number] = [from[0] + dLon, from[1] + dLat];
  const data: GeoJSON.Feature = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [from, to] },
    properties: {},
  };
  const src = map.getSource("arrow") as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data);
  else {
    map.addSource("arrow", { type: "geojson", data });
    map.addLayer({
      id: "arrow",
      type: "line",
      source: "arrow",
      paint: { "line-color": "#fff", "line-width": 3, "line-dasharray": [2, 1] },
    });
  }
}

export function hideArrow(map: maplibregl.Map) {
  if (map.getLayer("arrow")) map.setLayoutProperty("arrow", "visibility", "none");
}
export function unhideArrow(map: maplibregl.Map) {
  if (map.getLayer("arrow")) map.setLayoutProperty("arrow", "visibility", "visible");
}

// ── H3 density slice (past playback) ─────────────────────────────
export function showSlice(map: maplibregl.Map, slice: Slice) {
  const features: GeoJSON.Feature[] = slice.cells.map(([h, count]) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [cellToBoundary(h, true)] },
    properties: { count },
  }));
  const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
  const src = map.getSource("slice") as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(fc);
  else {
    map.addSource("slice", { type: "geojson", data: fc });
    map.addLayer({
      id: "slice",
      type: "fill",
      source: "slice",
      paint: { "fill-color": "#ff6b00", "fill-opacity": 0.4 },
    });
  }
  map.setLayoutProperty("slice", "visibility", "visible");
}
export function hideSlice(map: maplibregl.Map) {
  if (map.getLayer("slice")) map.setLayoutProperty("slice", "visibility", "none");
}


// ── live Meteosat FRP (EUMETView WMS, ~10 min) ───────────────────
export function frpTileUrl(base: string, layer: string, time: string): string {
  const p = new URLSearchParams({
    service: "WMS",
    request: "GetMap",
    version: "1.3.0",
    layers: layer,
    styles: "",
    format: "image/png",
    transparent: "true",
    crs: "EPSG:3857",
    width: "256",
    height: "256",
    TIME: time,
    bbox: "{bbox-epsg-3857}",
  });
  return `${base}?${p.toString()}`.replace("%7Bbbox-epsg-3857%7D", "{bbox-epsg-3857}");
}

export function showLiveFrp(
  map: maplibregl.Map,
  cfg: { url: string; layer: string; latest: string },
) {
  hideLiveFrp(map);
  map.addSource("livefrp", {
    type: "raster",
    tiles: [frpTileUrl(cfg.url, cfg.layer, cfg.latest)],
    tileSize: 256,
  });
  const before = map.getLayer("fires-glow") ? "fires-glow" : undefined;
  map.addLayer(
    { id: "livefrp", type: "raster", source: "livefrp", paint: { "raster-opacity": 0.85 } },
    before,
  );
}

export function hideLiveFrp(map: maplibregl.Map) {
  if (map.getLayer("livefrp")) map.removeLayer("livefrp");
  if (map.getSource("livefrp")) map.removeSource("livefrp");
}

// ── Spread-direction arrows ──────────────────────────────────────
// Convention borrowed from fire-behaviour products: an arrow from the fire
// toward its head, length scaled by rate of spread, labelled in km/h.

/** Point `meters` away from (lon,lat) along a compass `bearing` (0=N, 90=E). */
export function destinationPoint(
  lon: number,
  lat: number,
  bearing: number,
  meters: number,
): [number, number] {
  const R = 6_371_000;
  const d = meters / R;
  const b = (bearing * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return [(l2 * 180) / Math.PI, (p2 * 180) / Math.PI];
}

export function spreadKmh(distance24hM: number): number {
  return Math.round((distance24hM / 1000 / 24) * 100) / 100;
}

/** Shaft + head features for every event that has a resolved movement. */
export function buildArrowFeatures(events: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const f of events.features) {
    const p = f.properties as unknown as EventProps | null;
    const mv = p?.movement;
    if (!mv || f.geometry.type !== "Point") continue;
    const [lon, lat] = f.geometry.coordinates as [number, number];
    // Shaft length reflects speed but stays legible at any zoom.
    const kmh = spreadKmh(mv.distance_24h_m);
    const shaftM = Math.min(25000, Math.max(4000, mv.distance_24h_m));
    const tip = destinationPoint(lon, lat, mv.bearing_deg, shaftM);
    const props = { id: p!.id, bearing: mv.bearing_deg, kmh, state: p!.state };
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[lon, lat], tip] },
      properties: props,
    });
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: tip }, properties: props });
  }
  return { type: "FeatureCollection", features };
}

/** Triangular arrowhead drawn at runtime — no external asset, CSP-safe. */
function arrowHeadImage(size = 24): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.beginPath();
  ctx.moveTo(size / 2, 1);
  ctx.lineTo(size - 2, size - 3);
  ctx.lineTo(size / 2, size * 0.72);
  ctx.lineTo(2, size - 3);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 1;
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

export function addMovementArrows(map: maplibregl.Map, events: GeoJSON.FeatureCollection) {
  const data = buildArrowFeatures(events);
  if (map.getSource("arrows")) {
    (map.getSource("arrows") as maplibregl.GeoJSONSource).setData(data);
    return;
  }
  if (!map.hasImage("arrowhead")) map.addImage("arrowhead", arrowHeadImage(), { pixelRatio: 2 });
  map.addSource("arrows", { type: "geojson", data });

  map.addLayer({
    id: "arrow-shaft",
    type: "line",
    source: "arrows",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 10, 4.5],
      "line-opacity": 0.95,
      // Dark blur underneath keeps the shaft readable over bright hotspots.
      "line-blur": 0.2,
    },
  });
  map.addLayer({
    id: "arrow-head",
    type: "symbol",
    source: "arrows",
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      "icon-image": "arrowhead",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.85, 10, 1.5],
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "text-field": ["concat", ["to-string", ["get", "kmh"]], " km/h"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.2],
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(0,0,0,0.85)",
      "text-halo-width": 1.4,
    },
  });
}

export function setArrowsVisible(map: maplibregl.Map, visible: boolean) {
  for (const id of ["arrow-shaft", "arrow-head"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

// ── Isochrone bands ──────────────────────────────────────────────
// Dissolved unions of detections up to each age threshold (built in the
// pipeline). Bands arrive oldest-first so newer, smaller contours draw on top.
export function addIsochrones(map: maplibregl.Map, fc: GeoJSON.FeatureCollection) {
  if (map.getSource("iso")) {
    (map.getSource("iso") as maplibregl.GeoJSONSource).setData(fc);
    return;
  }
  map.addSource("iso", { type: "geojson", data: fc });
  const before = map.getLayer("frp-heat") ? "frp-heat" : undefined;
  map.addLayer(
    {
      id: "iso-fill",
      type: "fill",
      source: "iso",
      paint: {
        "fill-color": [
          "interpolate", ["linear"], ["get", "max_age"], ...AGE_RAMP,
        ] as never,
        "fill-opacity": 0.28,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "iso-line",
      type: "line",
      source: "iso",
      paint: {
        "line-color": [
          "interpolate", ["linear"], ["get", "max_age"], ...AGE_RAMP,
        ] as never,
        "line-width": 1.4,
        "line-opacity": 0.9,
      },
    },
    before,
  );
}

export function setIsoVisible(map: maplibregl.Map, visible: boolean) {
  for (const id of ["iso-fill", "iso-line"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

// ── Wind (Open-Meteo) ────────────────────────────────────────────
// Distinct from spread arrows: this is forecast wind, not observed fire
// movement. They frequently disagree, which is itself informative.

function windArrowImage(color: string, size = 30): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const m = size / 2;
  ctx.translate(m, m);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.beginPath(); // shaft
  ctx.moveTo(0, m - 3);
  ctx.lineTo(0, -m + 5);
  ctx.stroke();
  ctx.beginPath(); // head
  ctx.moveTo(0, -m + 2);
  ctx.lineTo(-4.5, -m + 9);
  ctx.moveTo(0, -m + 2);
  ctx.lineTo(4.5, -m + 9);
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

export function windIconName(i: number): string {
  return `wind-${i}`;
}

export function windIconExpression(): unknown {
  const expr: unknown[] = ["step", ["coalesce", ["get", "kmh"], 0], windIconName(0)];
  WIND_STOPS.forEach((s, i) => {
    if (i < WIND_STOPS.length - 1) expr.push(s.max, windIconName(i + 1));
  });
  return expr;
}

export function addWindLayer(map: maplibregl.Map, fc: GeoJSON.FeatureCollection) {
  if (map.getSource("wind")) {
    (map.getSource("wind") as maplibregl.GeoJSONSource).setData(fc);
    return;
  }
  WIND_STOPS.forEach((s, i) => {
    if (!map.hasImage(windIconName(i))) {
      map.addImage(windIconName(i), windArrowImage(s.color), { pixelRatio: 2 });
    }
  });
  map.addSource("wind", { type: "geojson", data: fc });
  map.addLayer({
    id: "wind-arrows",
    type: "symbol",
    source: "wind",
    layout: {
      "icon-image": windIconExpression() as never,
      // to_deg: where the wind is blowing TO (see export.py).
      "icon-rotate": ["get", "to_deg"],
      "icon-rotation-alignment": "map",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 10, 0.9],
      "icon-allow-overlap": true,
    },
  });
}

export function setWindVisible(map: maplibregl.Map, visible: boolean) {
  if (map.getLayer("wind-arrows")) {
    map.setLayoutProperty("wind-arrows", "visibility", visible ? "visible" : "none");
  }
}

// ── VIIRS 375 m hotspots (NASA GIBS, no API key) ─────────────────
// Meteosat/MTG pixels are ~2 km; VIIRS resolves ~375 m — roughly 28x the
// detail per unit area, which is why other maps look far more granular.
// GIBS serves these server-rendered with a daily TIME dimension.
export const GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi";
export const VIIRS_LAYERS = [
  "VIIRS_NOAA20_Thermal_Anomalies_375m_All",
  "VIIRS_SNPP_Thermal_Anomalies_375m_All",
].join(",");

export function viirsTileUrl(dayIso: string): string {
  const p = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.3.0",
    LAYERS: VIIRS_LAYERS,
    STYLES: "",
    FORMAT: "image/png",
    TRANSPARENT: "true",
    CRS: "EPSG:3857",
    WIDTH: "256",
    HEIGHT: "256",
    TIME: dayIso,
    BBOX: "{bbox-epsg-3857}",
  });
  return `${GIBS_WMS}?${p.toString()}`.replace(
    "%7Bbbox-epsg-3857%7D",
    "{bbox-epsg-3857}",
  );
}

export function showViirs(map: maplibregl.Map, dayIso: string) {
  hideViirs(map);
  map.addSource("viirs", { type: "raster", tiles: [viirsTileUrl(dayIso)], tileSize: 256 });
  const before = map.getLayer("fires-glow") ? "fires-glow" : undefined;
  map.addLayer(
    // NASA renders this layer, so its red cannot be restyled per-dot — but the
    // raster CAN be desaturated wholesale. Neutral grey wash: presence texture
    // that no longer shouts over every colour-coded layer.
    {
      id: "viirs",
      type: "raster",
      source: "viirs",
      paint: {
        "raster-saturation": -1,
        "raster-brightness-max": 0.85,
        "raster-opacity": 0.55,
      },
    },
    before,
  );
}

export function hideViirs(map: maplibregl.Map) {
  if (map.getLayer("viirs")) map.removeLayer("viirs");
  if (map.getSource("viirs")) map.removeSource("viirs");
}

// ── FRP heatmap (continuous, weighted by megawatts) ──────────────
// The WMS renders the same pixels as fixed ~2 km squares, which reads as a
// sparse grid when zoomed in. These are the underlying points, so intensity
// can be blended continuously and weighted by actual fire radiative power.


export function addFrpHeatmap(map: maplibregl.Map, fc: GeoJSON.FeatureCollection) {
  if (map.getSource("frp")) {
    (map.getSource("frp") as maplibregl.GeoJSONSource).setData(fc);
    return;
  }
  map.addSource("frp", { type: "geojson", data: fc });
  const before = map.getLayer("fires-glow") ? "fires-glow" : undefined;

  map.addLayer(
    {
      id: "frp-heat",
      type: "heatmap",
      source: "frp",
      maxzoom: 13,
      paint: {
        // FRP in MW → weight. Most pixels are <100 MW; keep weights low so
        // clustered pixels build a gradient instead of saturating to flat white.
        "heatmap-weight": ["interpolate", ["linear"], ["get", "frp"], 0, 0.01, 50, 0.09, 300, 0.35, 1500, 0.6],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 9, 1.1, 13, 1.5],
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], ...HEAT_COLORS] as never,
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 3, 6, 7, 18, 10, 34, 13, 60],
        // Fade the blend out as the age-coloured points take over.
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.9, 11, 0.5, 13, 0.15],
      },
    },
    before,
  );

  // Detections with a resolved local spread bearing are drawn as small
  // arrows pointing the way the fire moved there; colour encodes the local
  // edge SPEED (hue split: time lives on the isochrone bands instead).
  registerSpeedArrows(map);
  map.addLayer(
    {
      id: "frp-arrows",
      type: "symbol",
      source: "frp",
      minzoom: 6,
      filter: ["has", "dir"],
      layout: {
        "icon-image": speedArrowExpression() as never,
        "icon-rotate": ["get", "dir"],
        "icon-rotation-alignment": "map",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 6, 0.35, 10, 0.6, 14, 0.95],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    },
    before,
  );

  // Detections with no usable gradient stay dots — an arrow there would
  // invent a direction the data does not support. Neutral grey: they carry
  // no speed, and time already lives on the bands beneath.
  map.addLayer(
    {
      id: "frp-points",
      type: "circle",
      source: "frp",
      minzoom: 6,
      filter: ["!", ["has", "dir"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 10, 3, 14, 5],
        "circle-color": "#b9b9b9",
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 9, 0.75],
        "circle-stroke-width": 0,
      },
    },
    before,
  );
}

/** One pre-coloured arrow icon per speed band — avoids SDF tinting entirely. */
function speedArrowImage(color: string, size = 26): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const m = size / 2;
  ctx.translate(m, m);
  ctx.beginPath();
  ctx.moveTo(0, -m + 2); // tip
  ctx.lineTo(m - 4, m - 4); // right barb
  ctx.lineTo(0, m * 0.35); // notch
  ctx.lineTo(-m + 4, m - 4); // left barb
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  // Outline contrast flips with the fill: dark "old" arrows would otherwise
  // vanish against bright hotspots, light "fresh" ones against the basemap.
  ctx.strokeStyle = outlineFor(color);
  ctx.lineWidth = 1.3;
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}


export function speedArrowIconName(i: number): string {
  return `frp-arrow-${i}`;
}

function registerSpeedArrows(map: maplibregl.Map) {
  SPEED_STOPS.forEach((s, i) => {
    const name = speedArrowIconName(i);
    if (!map.hasImage(name)) {
      map.addImage(name, speedArrowImage(s.color), { pixelRatio: 2 });
    }
  });
}

/** step() over spd (km/h) selecting the matching pre-coloured arrow icon.
 * Pixels with a direction but no measurable rate fall into the slowest band —
 * visually "creeping", the honest floor. */
export function speedArrowExpression(): unknown {
  const expr: unknown[] = ["step", ["coalesce", ["get", "spd"], 0], speedArrowIconName(0)];
  SPEED_STOPS.forEach((s, i) => {
    if (i < SPEED_STOPS.length - 1) expr.push(s.max, speedArrowIconName(i + 1));
  });
  return expr;
}

export function setFrpVisible(map: maplibregl.Map, visible: boolean) {
  for (const id of ["frp-heat", "frp-points", "frp-arrows"]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}
