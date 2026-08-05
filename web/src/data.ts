import type { Manifest, Slice, Stats, Track } from "./types";

export const SCHEMA_MAJOR = 1;
// Minimal shape we depend on — lets tests inject a simple fake.
type Fetch = (url: string) => Promise<{ json(): Promise<unknown> }>;

export async function loadManifest(base = "/data", fetchFn: Fetch = fetch): Promise<Manifest> {
  const r = await fetchFn(`${base}/manifest.json`);
  const m = (await r.json()) as Manifest;
  if (Number(m.schema_version.split(".")[0]) > SCHEMA_MAJOR) {
    throw new Error(`unsupported schema ${m.schema_version}`);
  }
  return m;
}

export async function loadEvents(
  m: Manifest,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<GeoJSON.FeatureCollection> {
  const r = await fetchFn(`${base}/${m.generation}/events.geojson`);
  return (await r.json()) as GeoJSON.FeatureCollection;
}

export async function loadTrack(
  m: Manifest,
  id: string,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<Track> {
  const r = await fetchFn(`${base}/${m.generation}/tracks/${id}.json`);
  return (await r.json()) as Track;
}

/** One day's Europe-wide detection cells: [h3_cell, count] pairs. */
export async function loadDaySlice(
  m: Manifest,
  date: string,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<[string, number][]> {
  const r = await fetchFn(`${base}/${m.generation}/days/${date}.json`);
  return (await r.json()) as [string, number][];
}

export async function loadFrp(
  m: Manifest,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<GeoJSON.FeatureCollection> {
  const r = await fetchFn(`${base}/${m.generation}/frp.geojson`);
  return (await r.json()) as GeoJSON.FeatureCollection;
}


export async function loadIsochrones(
  m: Manifest,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<GeoJSON.FeatureCollection> {
  const r = await fetchFn(`${base}/${m.generation}/isochrones.geojson`);
  return (await r.json()) as GeoJSON.FeatureCollection;
}

export async function loadWind(
  m: Manifest,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<GeoJSON.FeatureCollection> {
  const r = await fetchFn(`${base}/${m.generation}/wind.geojson`);
  return (await r.json()) as GeoJSON.FeatureCollection;
}

export async function loadStats(
  m: Manifest,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<Stats> {
  const r = await fetchFn(`${base}/${m.generation}/stats.json`);
  return (await r.json()) as Stats;
}

export async function loadSlice(
  m: Manifest,
  key: string,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<Slice> {
  const r = await fetchFn(`${base}/${m.generation}/slices/${key}.json`);
  return (await r.json()) as Slice;
}
