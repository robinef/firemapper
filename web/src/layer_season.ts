import type * as maplibregl from "maplibre-gl";
import { cellToBoundary, cellToLatLng } from "h3-js";
import { sliceFeatures } from "./layer_dayslice";
import { dedupNested, fireSizes } from "./season_filter";
import type { SeasonCells, SeasonSummary } from "./types";

/**
 * Overview layer — "Burned this year".
 *
 * Question answered: "Where did <year> burn?"
 *
 * Data: pipeline/export_season.py's two files under archive/. The small
 * summary (res-6 hex km² + totals + floor date) is loaded at boot; the
 * per-fire cells file is fetched on idle after first paint (or on approach
 * to z7.5, whichever first; see createSeasonCellsLoader).
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
 * sample of the prod archive, re-measured once cells stopped being counted
 * once per fire: 3,593 hexes running min 0.5 · median 2.0 · p90 6.1 ·
 * p99 19.5 · max 36.5 km². A linear 0→36 ramp put 93 % of hexes in its first
 * segment (all one near-basemap brown) and clipped the top 0.5 %; these
 * breaks put the median at EMBER, p90 halfway to EMBER_LIGHT and p99 into
 * the EMBER_LIGHT→EMBER_PALE segment, so the spread a reader actually sees
 * is the spread the data has. Note the 60 km² top stop is now unreachable:
 * once ground is counted once, a res-6 hex cannot exceed its own area
 * (~35 km² at 45°N), so a fully burned hex tops out around half of the
 * EMBER_LIGHT→EMBER_PALE segment. Tightening it needs screenshots. */
const SEASON_HEX_BREAKS = [0, 2, 12, 60];

/** The density ramp is deliberately bottom-heavy: the first visible stop sits
 * at 0.08 so a lone res-6 hex in Portugal still paints, and the stops were
 * adjusted (0.45→0.35 inward, 0.7→0.75 outward) so only the very densest cores
 * reach the pale end. Alphas stay below 1 — a live fire dot must out-contrast
 * this everywhere. */
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
 * later "click a burned cell → open that past fire" needs no data change.
 *
 * Fires overlap — the same cell is claimed by several archived fires — so a
 * cell is emitted once, for the first fire that claims it. Stacking duplicate
 * polygons darkened shared ground (semi-transparent fills compound) and paid
 * for the extra geometry twice.
 *
 * `km2` = the LARGEST claiming fire's size, so a cell shared by a small and
 * a big fire stays visible at any threshold the big fire passes — the same
 * rule `aggregate()` applies to the hex band; `fire_id` is the first claimant,
 * for click-to-open.
 *
 * Nested cells are deduped INSIDE each fire (dedupNested, the same rule
 * fireSizes and aggregate use): a fire holding a coarse Meteosat cell and its
 * finer VIIRS children has one patch of ground, not two, and drawing the
 * parent would blanket ground the hex band deliberately never counted.
 * Across fires nothing is dropped — that is the pipeline's rule too. */
export function cellFeatures(cells: SeasonCells, sizes?: Map<string, number>): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  // Compute the largest claiming fire's size for each cell.
  const best = new Map<string, number>();
  for (const [fireId, entry] of Object.entries(cells)) {
    const km2 = sizes?.get(fireId) ?? 0;
    for (const cell of dedupNested(new Set(entry.cells))) {
      best.set(cell, Math.max(best.get(cell) ?? 0, km2));
    }
  }
  // Emit each cell once, tagged with the first claimant fire.
  for (const [fireId, entry] of Object.entries(cells)) {
    for (const cell of dedupNested(new Set(entry.cells))) {
      if (seen.has(cell)) continue;
      seen.add(cell);
      const ring = cellToBoundary(cell).map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      out.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { cell, fire_id: fireId, km2: best.get(cell) ?? 0 },
      });
    }
  }
  return out;
}

function fc(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** Res-6 rings, built once per cell and reused across every re-aggregation
 * the size filter triggers — the ~9k-hex FeatureCollection then costs a
 * Map lookup per hex, not a cellToBoundary call. Same feature shape as
 * sliceFeatures (property `n` = km²), so the fill ramp reads it unchanged. */
const RING_CACHE = new Map<string, number[][]>();
export function hexFeaturesCached(r6: [string, number][]): GeoJSON.Feature[] {
  return r6.map(([cell, n]) => {
    let ring = RING_CACHE.get(cell);
    if (!ring) {
      ring = cellToBoundary(cell).map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      RING_CACHE.set(cell, ring);
    }
    return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { n, cell } };
  });
}

/** Replace the heat and hex data with a re-aggregated `r6`. The cells source
 * is deliberately untouched — its filtering is setCellsThreshold's job. */
export function setSeasonAggregate(map: maplibregl.Map, r6: [string, number][]): void {
  (map.getSource(SEASON_HEAT_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(fc(heatPointFeatures(r6)));
  // hexFeaturesCached hands out SHARED ring arrays (same object in every
  // FeatureCollection built for a cell): read them, never mutate them in
  // place — an edit here would silently rewrite every past and future
  // aggregate's geometry for that hex.
  (map.getSource(SEASON_HEX_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(fc(hexFeaturesCached(r6)));
}

/** Hide cells whose owning fire is smaller than `threshold` km², on the GPU.
 * `null` clears the filter (threshold 0 = everything). */
export function setCellsThreshold(map: maplibregl.Map, threshold: number): void {
  const expr = threshold > 0 ? ([">=", ["get", "km2"], threshold] as maplibregl.FilterSpecification) : null;
  for (const id of ["season-cells-fill", "season-cells-line"]) {
    if (map.getLayer(id)) map.setFilter(id, expr);
  }
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
        ["interpolate", ["linear"], ["get", "km2"], SEASON_HEX_BREAKS[0], 0.05, SEASON_HEX_BREAKS[1], 0.2, SEASON_HEX_BREAKS[2], 0.5, SEASON_HEX_BREAKS[3], 1] as never,
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
    // The title names the season being shown, never the floor's year: the
    // earliest archived fire can sit in the previous year (a December start
    // still burning in January), and the layer would then title itself 2025.
    title: `Burned this year · ${year}`,
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

/** How many times a failing cells fetch is retried before the loader gives up
 * for the session. Nothing resets it on success — a success ends the story. */
export const MAX_CELLS_ATTEMPTS = 3;

/** `fetched` = the file is parsed and its per-fire sizes are known (the size
 * histogram is live), but the cell geometry has NOT been handed to the map
 * yet. See createSeasonCellsLoader. */
type CellsState = "idle" | "loading" | "fetched" | "loaded";

export type SeasonCellsHooks = {
  /** Parsed cells + per-fire km², once, on the first successful load. */
  onLoaded?: (cells: SeasonCells, sizes: Map<string, number>) => void;
  /** Once, when the attempt cap is reached. */
  onGaveUp?: () => void;
};

/**
 * Lazy loader for the per-fire cells file. `ensure()` is idempotent and
 * cheap: it returns immediately unless the reader is close enough
 * (zoom ≥ CELLS_PREFETCH_ZOOM, so the band is painted before its opacity
 * starts rising at z8), the layer is on, and nothing is loaded or in flight.
 *
 * `force: true` skips the zoom gate only (still respects idle/loaded/failures/isOn).
 *
 * Wired to zoomend/moveend here, but a zoom event alone misses the common
 * cases — the layer toggled on while already at z10, a `?fire=` deep link
 * booting past the threshold, returning from a fire card at the same zoom —
 * so main.ts also calls ensure() at boot and from the module's onToggle.
 *
 * Failure keeps the hex band at its pending opacity (it has no maxzoom, so
 * it still renders past z8.5) and resets to idle so the next trigger retries —
 * but only up to MAX_CELLS_ATTEMPTS: ensure() is wired to moveend, so an
 * unbounded retry re-requests a multi-MB file on every pan, forever.
 *
 * FETCH AND INSTALL ARE TWO STEPS. The histogram needs the FILE wherever the
 * camera is; the map needs the GEOMETRY only from z8. Building ~160k hex
 * polygons and handing maplibre the resulting tens-of-MB FeatureCollection is
 * hundreds of milliseconds of main-thread work plus a GPU upload, and a reader
 * who never leaves z4 must not pay it. So a forced fetch below
 * CELLS_PREFETCH_ZOOM parks the parsed cells in memory ("fetched") and the
 * first ensure() past the gate — from zoomend/moveend, a toggle, or a
 * deep link — performs the install ("loaded"). Past the gate, fetch and
 * install still happen in one go.
 */
export function createSeasonCellsLoader(
  map: maplibregl.Map,
  year: number,
  isOn: () => boolean,
  fetchImpl: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
  hooks: SeasonCellsHooks = {},
): { ensure(opts?: { force?: boolean }): Promise<void>; state(): CellsState } {
  let state: CellsState = "idle";
  let failures = 0;
  /** Parsed cells waiting for the reader to approach the cells band. */
  let held: { cells: SeasonCells; sizes: Map<string, number> } | null = null;

  /** The install has ONE gate, the camera: `force` waives the gate on the
   * FETCH (the histogram needs the file at any zoom), never on the install.
   * An unforced ensure() is not evidence of being past the gate either — a
   * moveend at z4 is unforced too. */
  const mayInstall = () => map.getZoom() >= CELLS_PREFETCH_ZOOM;

  /** Hand the held geometry to the map and let the hex band fade out. Kept
   * total: a missing source leaves the state at "fetched" (the hex band stays
   * on its pending opacity) so the next trigger can try again — it must never
   * throw out of a zoomend handler as an unhandled rejection. */
  const install = (): void => {
    const source = map.getSource(SEASON_CELLS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!held || !source) return;
    source.setData(fc(cellFeatures(held.cells, held.sizes)));
    if (map.getLayer("season-hex-fill")) {
      map.setPaintProperty("season-hex-fill", "fill-opacity", HEX_OPACITY_INSTALLED as never);
    }
    held = null;
    state = "loaded";
  };

  const ensure = async (opts: { force?: boolean } = {}): Promise<void> => {
    if (!isOn()) return;
    // Fetched but not installed: the only work left is the install, and only
    // once the reader is close enough to see the cells.
    if (state === "fetched") {
      if (mayInstall()) install();
      return;
    }
    if (state !== "idle") return;
    if (failures >= MAX_CELLS_ATTEMPTS) return;
    // `force` (the idle prefetch after boot) skips only the zoom gate: the
    // size histogram needs the cells file regardless of where the camera is.
    if (!opts.force && map.getZoom() < CELLS_PREFETCH_ZOOM) return;
    state = "loading";
    let loaded: { cells: SeasonCells; sizes: Map<string, number> } | null = null;
    let gaveUp = false;
    try {
      const r = await fetchImpl(`/data/archive/season_${year}_cells.json`);
      if (!r.ok) throw new Error(`season cells ${r.ok}`);
      const cells = (await r.json()) as SeasonCells;
      if (!cells || typeof cells !== "object" || Array.isArray(cells)) throw new Error("season cells malformed");
      const sizes = fireSizes(cells);
      if (!map.getSource(SEASON_CELLS_SOURCE)) throw new Error("season cells source missing");
      held = { cells, sizes };
      state = "fetched";
      // Past the zoom gate the reader is about to see the cells: install now,
      // in the same turn, exactly as before this split existed.
      if (mayInstall()) install();
      loaded = { cells, sizes };
    } catch (err) {
      failures += 1;
      console.warn("layer_season: cells load failed, hex band stays", err);
      // Back to idle means back to holding nothing: a half-installed load must
      // not leave geometry parked where the next retry would not replace it.
      held = null;
      state = "idle";
      if (failures >= MAX_CELLS_ATTEMPTS) gaveUp = true;
    }
    // Hooks run OUTSIDE the try: a throwing histogram or DOM refresh must
    // never be laundered into a fetch failure (refetch, repeat onLoaded,
    // a false onGaveUp) nor escape as an unhandled rejection.
    try {
      if (loaded) hooks.onLoaded?.(loaded.cells, loaded.sizes);
      if (gaveUp) hooks.onGaveUp?.();
    } catch (err) {
      console.warn("layer_season: cells hook threw", err);
    }
  };

  map.on("zoomend", () => { void ensure(); });
  map.on("moveend", () => { void ensure(); });
  return { ensure, state: () => state };
}
