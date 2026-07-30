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
  aircraft?: number;
  imagery?: import("./layer_imagery").ImageryConfig | null;
  isochrone_bands?: number;
  timeline?: TimelineDay[] | null;
  day_slice_dates?: string[];
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
