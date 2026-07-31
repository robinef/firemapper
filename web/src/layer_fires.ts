import type maplibregl from "maplibre-gl";

/**
 * Layer 1 — Active fires.
 *
 * Question answered: "Where is fire burning right now, and how big?"
 *
 * Visual variables (docs/cartography-rules.md):
 *   SIZE       = burned area (quantitative → the only honest size encoding;
 *                radius ∝ √area so symbol AREA is proportional to the value)
 *   VALUE      = activity (active vivid, stale dimmed — order, not hue)
 *   HUE        = one fire orange; hue only says "this is fire"
 *   SHAPE      = circle + white stroke (max contrast on the dark basemap)
 *
 * Zoom transform (not mere shrinking):
 *   z4–6  one proportional symbol per fire event
 *   z7+   name + area labels join
 *   z10+  the symbol hands over to the observed footprint outline — at
 *         street level the edge matters, not an abstract dot.
 */

export const FIRE_HUE = "#ff5a1f";
export const FIRE_CLASSES = ["major", "medium", "minor"] as const;
export const fireLayerIds = FIRE_CLASSES.map((c) => `fires-${c}`);
/** One invisible tap-target halo per size class — see the CLASS_MINZOOM loop
 * below for why there is no single "fire-halo" any more. Exported so every
 * caller that used to hardcode the bare string can spread this instead. */
export const fireHaloIds = FIRE_CLASSES.map((c) => `fire-halo-${c}`);

/** Radius ∝ √area, with a gentle zoom boost. Exported for tests. */
export function fireRadiusExpression(): unknown {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    4,
    ["+", 3, ["*", 1.6, ["sqrt", ["coalesce", ["get", "area_km2"], 0]]]],
    9,
    ["+", 5, ["*", 2.6, ["sqrt", ["coalesce", ["get", "area_km2"], 0]]]],
  ];
}

/** Vivid when burning, dimmed when stale; closed events are filtered out.
 * MapLibre only allows ["zoom"] in a TOP-LEVEL interpolate, so the zoom fade
 * cannot multiply this — instead each zoom stop embeds the status match. */
export function fireOpacityExpression(fade = 1): unknown {
  return ["match", ["get", "status"], "stale", 0.45 * fade, 1.0 * fade];
}

/** Top-level zoom interpolate whose stops carry the status-dependent value:
 * full strength until z9.5, handing over to the footprint by z11. */
export function fireFadeExpression(): unknown {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    9.5,
    fireOpacityExpression(1),
    11,
    fireOpacityExpression(0.15),
  ];
}

// Each size class appears from a different zoom, so no scale is ever
// cluttered: major fires Europe-wide, smaller ones only once you zoom in.
const CLASS_MINZOOM: Record<string, number> = { major: 3, medium: 6, minor: 8.5 };

export function addActiveFires(
  map: maplibregl.Map,
  events: GeoJSON.FeatureCollection,
  footprint: GeoJSON.FeatureCollection,
) {
  const evSrc = map.getSource("fires") as maplibregl.GeoJSONSource | undefined;
  if (evSrc) {
    evSrc.setData(events);
    (map.getSource("fire-footprint") as maplibregl.GeoJSONSource).setData(footprint);
    return;
  }

  map.addSource("fires", { type: "geojson", data: events });
  map.addSource("fire-footprint", { type: "geojson", data: footprint });

  // Observed footprint — the ONLY fire mark above z9, so the symbol and its
  // own outline never overlap. Fades fully in by z9.
  map.addLayer({
    id: "fire-footprint-fill",
    type: "fill",
    source: "fire-footprint",
    minzoom: 8,
    paint: {
      "fill-color": FIRE_HUE,
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 9.5, 0.14],
    },
  });
  map.addLayer({
    id: "fire-footprint-line",
    type: "line",
    source: "fire-footprint",
    minzoom: 8,
    paint: {
      "line-color": FIRE_HUE,
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2.5],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 9.5, 0.95],
    },
  });

  // Proportional symbol per size class, each revealed at its own zoom and all
  // gone by z9 where the footprint takes over. Its invisible 44px tap-target
  // halo is added right before it, one per class with the SAME filter and
  // zoom range as the dot it backs — a single halo covering every class (the
  // original design) would sit under classes not yet revealed at the current
  // zoom (major shows from z3, minor not until z8.5) and blanket the map with
  // click targets for fires nothing on screen represents. MapLibre hit-tests
  // the RENDERED circle, and an 8-16px dot is far below the touch minimum, so
  // the halo is still needed — just scoped like its dot. Same enlarging trick
  // as aircraft-halo (layer_aircraft.ts:79). Deliberately not in any legend:
  // it is a target, not a symbol.
  for (const [cls, minz] of Object.entries(CLASS_MINZOOM)) {
    const filter = ["all", ["!=", ["get", "status"], "closed"], ["==", ["get", "size_class"], cls]];
    map.addLayer({
      id: `fire-halo-${cls}`,
      type: "circle",
      source: "fires",
      minzoom: minz,
      maxzoom: 9.5,
      filter: filter as never,
      paint: { "circle-radius": 22, "circle-color": "rgba(0,0,0,0)" },
    });
    map.addLayer({
      id: `fires-${cls}`,
      type: "circle",
      source: "fires",
      minzoom: minz,
      maxzoom: 9.5,
      filter: filter as never,
      paint: {
        "circle-color": FIRE_HUE,
        "circle-radius": fireRadiusExpression() as never,
        "circle-opacity": fireFadeExpression() as never,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 9, 1.6],
        "circle-stroke-opacity": fireFadeExpression() as never,
      },
    });
  }

  // Labels appear from z7 (regional view — few fires in frame), text-size
  // grows with zoom so it never dominates the Europe scale.
  map.addLayer({
    id: "fire-labels",
    type: "symbol",
    source: "fires",
    minzoom: 7,
    maxzoom: 9.5,
    // Label only fires whose symbol is also present at this zoom — never a
    // label floating without its mark. Minor fires stay unlabelled (too many,
    // too small to name).
    filter: ["all", ["!=", ["get", "status"], "closed"], ["!=", ["get", "size_class"], "minor"]],
    layout: {
      "text-field": [
        "format",
        ["coalesce", ["get", "name"], "Fire"],
        {},
        "\n",
        {},
        ["concat", ["to-string", ["get", "area_km2"]], " km²"],
        { "font-scale": 0.85 },
      ],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(0,0,0,0.85)",
      "text-halo-width": 1.4,
    },
  });
}
