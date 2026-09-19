import type * as maplibregl from "maplibre-gl";
import { cellToBoundary, cellToLatLng } from "h3-js";
import { sliceFeatures } from "./layer_dayslice";
import type { SeasonCells, SeasonSummary } from "./types";

/**
 * Overview layer — "Burned this year".
 *
 * Question answered: "Where did <year> burn?"
 *
 * Data: pipeline/export_season.py's two files under archive/. The small
 * summary (res-6 hex km² + totals + floor date) is loaded at boot; the
 * per-fire cells file is fetched lazily by the loader in this module the
 * first time the reader gets close (see createSeasonCellsLoader).
 *
 * Visual variables (docs/cartography-rules.md):
 *   HUE   = the ember/ash family every "past fire" element already uses
 *           (SCAR_RING, CLOSED_HUE) — layer identity, never a number.
 *   VALUE = km² burned per res-6 hex (light = more), on the hex band only.
 *   Real res-8 cells are a uniform fill: every cell is the same 0.7 km²
 *   quantum, there is nothing to rank inside that band.
 *
 * Zoom transform: heatmap (pattern) below z6.5 → res-6 hexes (quantity)
 * 5.5–8.5 → the real burned cells (ground truth) from z8. Bands cross-fade
 * through opacity; the hex layers deliberately carry NO maxzoom so they can
 * stay visible past z8.5 while the cells are still loading or failed to.
 *
 * Distinct from HEAT_COLORS (live intensity, level 2 only) and FIRE_HUE
 * (live fires): lower saturation, capped opacity, so a live fire is always
 * the highest-contrast thing on screen.
 *
 * All sources and layers are added at boot; later work is setData only
 * (a lazily-added layer lands on top of everything, including live fires).
 */

export const SEASON_HEAT_SOURCE = "season-heat-pts";
export const SEASON_HEX_SOURCE = "season-hex";
export const SEASON_CELLS_SOURCE = "season-cells";
export const SEASON_LAYER_IDS = [
  "season-heat", "season-hex-fill", "season-hex-line", "season-cells-fill", "season-cells-line",
];

const EMBER_DARK = "#5a2a14";
const EMBER = "#8a3d1c";
const EMBER_LIGHT = "#d1874f";
const EMBER_PALE = "#f5c98a";

/** km² breaks the hex fill (and the legend) ramp on. Tuned on a 3,000-track
 * sample of the prod archive, whose res-6 hexes run min 0.5 · median 2.1 ·
 * p90 6.6 · p99 27.6 · max 86.5 km². A linear 0→36 ramp put 93 % of hexes in
 * its first segment (all one near-basemap brown) and clipped the top 0.5 %;
 * these breaks put the median at EMBER, p90 halfway to EMBER_LIGHT and p99
 * well into EMBER_PALE, so the spread a reader actually sees is the spread
 * the data has. */
const SEASON_HEX_BREAKS = [0, 2, 12, 60];

/** The density ramp is deliberately bottom-heavy: the first visible stop sits
 * at 0.08 so a lone res-6 hex in Portugal still paints, and the top two are
 * pushed out to 0.75/1 so only the very densest cores reach the pale end.
 * Alphas stay below 1 — a live fire dot must out-contrast this everywhere. */
export const SEASON_HEAT_COLORS = [
  0, "rgba(0,0,0,0)",
  0.08, "rgba(90,42,20,0.5)",
  0.35, "rgba(138,61,28,0.68)",
  0.75, "rgba(209,135,79,0.8)",
  1, "rgba(245,201,138,0.88)",
];

/** Hex opacity while the real cells are not installed (pending or failed):
 * fade in over 5.5–6.5, then hold at 0.5 from z8 up so zooming in never
 * shows a blank season layer. */
export const HEX_OPACITY_PENDING = [
  "interpolate", ["linear"], ["zoom"], 5.5, 0, 6.5, 0.7, 8, 0.5, 22, 0.5,
];
/** Hex opacity once the cells are installed: hand over to them across z8–8.5. */
export const HEX_OPACITY_INSTALLED = [
  "interpolate", ["linear"], ["zoom"], 5.5, 0, 6.5, 0.7, 8, 0.7, 8.5, 0,
];

export function heatPointFeatures(r6: [string, number][]): GeoJSON.Feature[] {
  return r6.map(([cell, km2]) => {
    const [lat, lng] = cellToLatLng(cell);
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { km2, cell },
    };
  });
}

/** Every fire's cells as closed hex polygons, tagged with the fire id so a
 * later "click a burned cell → open that past fire" needs no data change. */
export function cellFeatures(cells: SeasonCells): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  for (const [fireId, entry] of Object.entries(cells)) {
    for (const cell of entry.cells) {
      const ring = cellToBoundary(cell).map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      out.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { cell, fire_id: fireId },
      });
    }
  }
  return out;
}

function fc(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** Add (or refresh) the season sources and layers. Call BEFORE the day-slice
 * and fire layers so those draw on top. */
export function addSeason(map: maplibregl.Map, summary: SeasonSummary): void {
  const heat = fc(heatPointFeatures(summary.r6));
  const hex = fc(sliceFeatures(summary.r6));
  const existingHeat = map.getSource(SEASON_HEAT_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (existingHeat) {
    existingHeat.setData(heat);
    (map.getSource(SEASON_HEX_SOURCE) as maplibregl.GeoJSONSource).setData(hex);
    return;
  }
  map.addSource(SEASON_HEAT_SOURCE, { type: "geojson", data: heat });
  map.addSource(SEASON_HEX_SOURCE, { type: "geojson", data: hex });
  map.addSource(SEASON_CELLS_SOURCE, { type: "geojson", data: fc([]) });

  map.addLayer({
    id: "season-heat",
    type: "heatmap",
    source: SEASON_HEAT_SOURCE,
    maxzoom: 6.5,
    paint: {
      // Weighted on the same breaks as the hex fill: a median (~2 km²) hex has
      // to carry real weight on its own, because outside the few hot regions
      // the season is a scatter of single hexes, and a scale that only lights
      // up where hexes pile up shows one blob and calls Europe unburnt.
      "heatmap-weight":
        ["interpolate", ["linear"], ["get", "km2"], 0, 0.05, 2, 0.2, 12, 0.5, 60, 1] as never,
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 6.5, 1.0] as never,
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], ...SEASON_HEAT_COLORS] as never,
      // A res-6 hex is sub-pixel at z4, so the kernel — not the geometry — is
      // what a reader sees; small radii left isolated regions invisible.
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 3, 10, 6.5, 24] as never,
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 5.5, 0.65, 6.5, 0] as never,
    },
  });
  map.addLayer({
    id: "season-hex-fill",
    type: "fill",
    source: SEASON_HEX_SOURCE,
    minzoom: 5.5,
    paint: {
      "fill-color": [
        "interpolate", ["linear"], ["get", "n"],
        SEASON_HEX_BREAKS[0], EMBER_DARK,
        SEASON_HEX_BREAKS[1], EMBER,
        SEASON_HEX_BREAKS[2], EMBER_LIGHT,
        SEASON_HEX_BREAKS[3], EMBER_PALE,
      ] as never,
      "fill-opacity": HEX_OPACITY_PENDING as never,
    },
  });
  map.addLayer({
    id: "season-hex-line",
    type: "line",
    source: SEASON_HEX_SOURCE,
    minzoom: 5.5,
    // Fades in on the same 5.5–6.5 ramp as the fill. A constant opacity here
    // put a honeycomb of empty outlines over the heatmap at z5.5–6, where the
    // fill is still 0 — a grid of rings reads as noise, not as burned ground.
    paint: {
      "line-color": EMBER_LIGHT,
      "line-width": 0.4,
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 5.5, 0, 6.5, 0.25] as never,
    },
  });
  map.addLayer({
    id: "season-cells-fill",
    type: "fill",
    source: SEASON_CELLS_SOURCE,
    minzoom: 8,
    paint: {
      "fill-color": EMBER,
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 8.5, 0.55] as never,
    },
  });
  map.addLayer({
    id: "season-cells-line",
    type: "line",
    source: SEASON_CELLS_SOURCE,
    minzoom: 8,
    paint: {
      "line-color": EMBER_LIGHT,
      "line-width": 0.3,
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 8.5, 0.6] as never,
    },
  });
}

/** "13 Jul" for "2026-07-13", in UTC so a date never shifts by timezone. */
export function formatFloor(floor: string): string {
  return new Date(`${floor}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", timeZone: "UTC",
  });
}

export function seasonStatus(summary: SeasonSummary): string {
  const n = (v: number) => Math.round(v).toLocaleString("en-GB");
  const base = `${n(summary.fires)} fires · ${n(summary.km2)} km²`;
  return summary.floor ? `${base} since ${formatFloor(summary.floor)}` : base;
}

export function seasonLegend(floor: string | null, year = new Date().getUTCFullYear()) {
  const since = floor ? `since ${formatFloor(floor)} ${floor.slice(0, 4)}` : "this year";
  return {
    title: `Burned this year · ${floor ? floor.slice(0, 4) : year}`,
    entries: [
      { color: EMBER_DARK, label: "less burned", shape: "square" as const },
      { color: EMBER, label: "", shape: "square" as const },
      { color: EMBER_LIGHT, label: "", shape: "square" as const },
      { color: EMBER_PALE, label: "most burned", shape: "square" as const },
    ],
    note:
      `Every fire the satellites saw settle ${since}. Earlier fires this year ` +
      "are not yet archived. Zoom in for the real burned ground.",
  };
}

export const CELLS_PREFETCH_ZOOM = 7.5;

type CellsState = "idle" | "loading" | "loaded";

/**
 * Lazy loader for the per-fire cells file. `ensure()` is idempotent and
 * cheap: it returns immediately unless the reader is close enough
 * (zoom ≥ CELLS_PREFETCH_ZOOM, so the band is painted before its opacity
 * starts rising at z8), the layer is on, and nothing is loaded or in flight.
 *
 * Wired to zoomend/moveend here, but a zoom event alone misses the common
 * cases — the layer toggled on while already at z10, a `?fire=` deep link
 * booting past the threshold, returning from a fire card at the same zoom —
 * so main.ts also calls ensure() at boot and from the module's onToggle.
 *
 * Failure keeps the hex band at its pending opacity (it has no maxzoom, so
 * it still renders past z8.5) and resets to idle so the next trigger retries.
 */
export function createSeasonCellsLoader(
  map: maplibregl.Map,
  year: number,
  isOn: () => boolean,
  fetchImpl: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
): { ensure(): Promise<void>; state(): CellsState } {
  let state: CellsState = "idle";

  const ensure = async (): Promise<void> => {
    if (state !== "idle") return;
    if (!isOn()) return;
    if (map.getZoom() < CELLS_PREFETCH_ZOOM) return;
    state = "loading";
    try {
      const r = await fetchImpl(`/data/archive/season_${year}_cells.json`);
      if (!r.ok) throw new Error(`season cells ${r.ok}`);
      const cells = (await r.json()) as SeasonCells;
      const source = map.getSource(SEASON_CELLS_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!source) throw new Error("season cells source missing");
      source.setData(fc(cellFeatures(cells)));
      if (map.getLayer("season-hex-fill")) {
        map.setPaintProperty("season-hex-fill", "fill-opacity", HEX_OPACITY_INSTALLED as never);
      }
      state = "loaded";
    } catch (err) {
      console.warn("layer_season: cells load failed, hex band stays", err);
      state = "idle";
    }
  };

  map.on("zoomend", () => { void ensure(); });
  map.on("moveend", () => { void ensure(); });
  return { ensure, state: () => state };
}
