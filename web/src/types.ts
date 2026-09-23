import type { LayerFreshness } from "./freshness";

export interface Manifest {
  schema_version: string;
  generated_at: string;
  generation: string;
  tiers: { viirs: boolean; meteosat: boolean };
  /** Per-layer freshness (schema >= 1.1.0). Absent on older manifests. */
  layers?: Record<string, LayerFreshness>;
  slice_bins?: string[];
  live_frp?: { url: string; layer: string; latest: string; step: string } | null;
  frp_points?: number;
  wind_points?: number;
  imagery?: import("./layer_imagery").ImageryConfig | null;
  isochrone_bands?: number;
  timeline?: TimelineDay[] | null;
  day_slice_dates?: string[];
  /** How far back each layer reaches. Absent on manifests published before this field existed. */
  coverage?: {
    live_window_hours: number;
    firms_lookback_days: number;
    scar_window_days: number;
    archive_floor_date: string;
    /** Absent until the Jan–Jun season backfill (scripts/backfill_season.py) is published. */
    backfill_floor_date?: string | null;
    effis_note: string;
  };
}

export interface TimelineDay {
  date: string; // YYYY-MM-DD (UTC)
  count: number; // polar (VIIRS/MODIS) detections that day
  frp: number; // summed FRP (MW)
}

export interface Movement {
  bearing_deg: number;
  distance_24h_m: number;
  path_total_m: number;
}

export interface EventProps {
  id: string;
  /** Generation holding this fire's track file. publish leaves a byte-identical
   *  track where it is, so this is often an older generation than the live one.
   *  Absent on manifests published before incremental publishing. */
  track_gen?: string | null;
  status: "active" | "stale" | "closed";
  lifecycle_age_h: number;
  started: string;
  area_km2: number;
  cum_cells: number;
  movement: Movement | null;
  state: "accelerating" | "growing" | "steady" | "declining";
  freshness: { viirs: string; meteosat: string | null };
  place: { name: string; distance_km: number } | null;
  gdacs: { title: string; link: string } | null;
  reactivation_of: string | null;
  merged_into: string | null;
}

export interface Bin {
  bin: string;
  centroid: [number, number];
  new_cells: number;
  cum_cells: number;
  frp_sum: number;
}

export interface Track {
  id: string;
  series: Bin[];
  cells: string[];
  /** [bin_iso, [new H3 cells that bin]] — accumulate up to a bin for its footprint. */
  cell_bins?: [string, string[]][];
  frp_live: [string, number][];
}

export interface Slice {
  cells: [string, number][];
}

export interface Stats {
  detections: Record<string, number>;
}

/** archive/season_{year}.json — pipeline/export_season.py's boot-time summary. */
export interface SeasonSummary {
  year: number;
  generated_at: string;
  /** Earliest first-detection date across included fires, YYYY-MM-DD. Null
   *  only when the file holds no fires at all. */
  floor: string | null;
  fires: number;
  km2: number;
  /** [res-6 H3 cell, km² burned inside it] */
  r6: [string, number][];
}

/** archive/season_{year}_cells.json — one entry per settled fire. `zone_cells`
 * is pipeline bookkeeping (the cells the static heat-source zone removed, kept
 * so they can return if the zone shrinks); the web never reads it. */
export type SeasonCells = Record<string, { digest: string; first: string; cells: string[]; zone_cells?: string[] }>;

/** archive/season_{year}_sizes.json — pipeline/export_season.py's per-fire
 * [km², country or null, first-detection YYYY-MM-DD]. The size filter's
 * boot-time input: the histogram, the counts and the EU-27 scope, without the
 * multi-MB cells file. Arrays, not objects, to keep ~22k entries small. */
export type SeasonSizes = { year: number; fires: Record<string, [number, string | null, string]> };

/** archive/blob_{year}_fires.json — pipeline/export_scale_blob.py's per-fire
 * country + EFFIS-mapped area. Lives here rather than beside its first reader
 * (scale_blob_panel.ts) because the season layer reads it too, for country
 * scoping, and data.ts must not import a panel module to name its return type. */
export type FiresSummary = Record<string, { country: string | null; area_km2: number }>;
