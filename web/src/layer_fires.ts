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
/** Exported so fire_count.ts can report what the current zoom actually draws
 * without duplicating this table — a second copy would drift and the counter
 * would then lie in exactly the case it exists to explain. */
export const CLASS_MINZOOM: Record<string, number> = { major: 3, medium: 6, minor: 8.5 };

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

// ── Burned out: fires that have stopped detecting ────────────────
// Every layer above filters status=closed out, which is right for "where is
// fire burning now" but leaves those fires with no clickable mark at all. The
// scar marker used to be the fallback, and it is capped — so a notable fire
// could lose the last route to its card days after burning out. Off by
// default (this is history, not the live picture), clickable when on.
export const CLOSED_LAYER_IDS = [
  ...FIRE_CLASSES.map((c) => `fire-closed-halo-${c}`),
  ...FIRE_CLASSES.map((c) => `fires-closed-${c}`),
];
const CLOSED_HUE = "#8a5a44"; // burnt, desaturated — reads as over, not quiet

export function addClosedFires(map: maplibregl.Map): void {
  if (map.getLayer(CLOSED_LAYER_IDS[0])) return;
  // Per size class at the SAME zooms as the live dots, not one blanket layer.
  // Closed fires are the majority of the archive — 4214 of 7477 in production
  // on 2026-08-03 — so drawing them all at Europe zoom would bury the live
  // picture under three times as many dead ones and hand every pixel of the
  // map a tap target. Big burns still appear from z3; specks wait for z8.5.
  for (const cls of FIRE_CLASSES) {
    const filter = [
      "all", ["==", ["get", "status"], "closed"], ["==", ["get", "size_class"], cls],
    ];
    const minzoom = CLASS_MINZOOM[cls];
    map.addLayer({
      id: `fire-closed-halo-${cls}`,
      type: "circle",
      source: "fires",
      minzoom,
      filter: filter as never,
      layout: { visibility: "none" },
      paint: { "circle-radius": 22, "circle-color": "rgba(0,0,0,0)" },
    });
    map.addLayer({
      id: `fires-closed-${cls}`,
      type: "circle",
      source: "fires",
      minzoom,
      filter: filter as never,
      layout: { visibility: "none" },
      paint: {
        "circle-color": CLOSED_HUE,
        "circle-radius": fireRadiusExpression() as never,
        "circle-opacity": 0.45,
        "circle-stroke-color": CLOSED_HUE,
        "circle-stroke-width": 1,
        "circle-stroke-opacity": 0.8,
      },
    });
  }
}

export const CLOSED_LEGEND = {
  title: "Burned out",
  entries: [
    { color: CLOSED_HUE, size: 12, shape: "dot" as const, label: "no detection for over 48 h" },
  ],
  note:
    "Fires that have stopped burning but are still in the archive. Hidden from " +
    "the live view; turn on to find a recent fire and open its before/after.",
};

/**
 * Drop the per-class zoom gates so every live fire draws at any zoom.
 *
 * The gates exist to stop 44px tap targets blanketing the continental view, and
 * they are right by default. But 1335 of 1344 live fires are `minor`, so at
 * that view the layer draws almost nothing — and a reader who wants "show me
 * everything, I accept the clutter" had no way to say so. This is that way.
 */
export function setShowAllSizes(map: maplibregl.Map, all: boolean): void {
  for (const cls of FIRE_CLASSES) {
    const min = all ? 0 : CLASS_MINZOOM[cls];
    for (const id of [`fires-${cls}`, `fire-halo-${cls}`]) {
      if (map.getLayer(id)) map.setLayerZoomRange(id, min, 9.5);
    }
    // The burned-out layer mirrors the same gates and has no upper bound.
    for (const id of [`fires-closed-${cls}`, `fire-closed-halo-${cls}`]) {
      if (map.getLayer(id)) map.setLayerZoomRange(id, min, 24);
    }
  }
}
