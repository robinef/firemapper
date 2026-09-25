import type { FiresSummary, Manifest, SeasonSizes, SeasonSummary, Slice, Stats, Track } from "./types";

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

/** Load one fire's track.
 *
 * `trackGen` is the generation that physically holds the file, taken from the
 * feature's `track_gen`. publish no longer re-uploads byte-identical tracks —
 * ~98.7% are unchanged between runs — so a track usually lives in an older
 * generation than the live one.
 *
 * Falling back to `m.generation` is what carries a manifest published before
 * `track_gen` existed: every one of its tracks IS in its own generation, so the
 * old address is right. Without the fallback, one generation's worth of fire
 * cards would lose their sparkline — and silently, since the caller catches a
 * failed load and still renders the card from props.
 */
export async function loadTrack(
  m: Manifest,
  id: string,
  base = "/data",
  fetchFn: Fetch = fetch,
  trackGen?: string | null,
): Promise<Track> {
  const r = await fetchFn(`${base}/${trackGen || m.generation}/tracks/${id}.json`);
  return (await r.json()) as Track;
}

/** An EFFIS scar's real burned-area perimeter (pipeline/archive_footprints.py).
 * Unlike loadTrack, this path never depends on a generation or the "archive"
 * sentinel — the file lives at one fixed, permanent location from the moment
 * it is first archived. */
export async function loadFootprint(
  id: string,
  base = "/data",
  fetchFn: Fetch = fetch,
): Promise<GeoJSON.Feature> {
  const r = await fetchFn(`${base}/archive/footprints/${id}.json`);
  return (await r.json()) as GeoJSON.Feature;
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

/** The "Burned this year" summary (pipeline/export_season.py). Null on any
 * failure — a missing season file means the module is simply not offered,
 * the same way a missing frp file means no intensity layer. Uses `ok`, so
 * the injected fetch must expose it (unlike loadTrack's minimal shape). */
export async function loadSeason(
  year: number,
  base = "/data",
  fetchFn: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
): Promise<SeasonSummary | null> {
  try {
    const r = await fetchFn(`${base}/archive/season_${year}.json`);
    if (!r.ok) return null;
    const s = (await r.json()) as Partial<SeasonSummary> | null;
    if (!s || typeof s.year !== "number" || !Array.isArray(s.r6) || typeof s.fires !== "number") return null;
    return s as SeasonSummary;
  } catch {
    return null;
  }
}

/** The per-fire country + area summary (pipeline/export_scale_blob.py), the
 * season layer's only source of "which country did this fire burn in?".
 * Permanent, one file per year, published beside the season export.
 *
 * Null on any failure, exactly like loadSeason: the EU-27 scope toggle is an
 * enhancement, and a missing countries file must leave the size filter, the
 * status line and the map working as they did before it existed. */
export async function loadFiresSummary(
  year: number,
  base = "/data",
  fetchFn: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
): Promise<FiresSummary | null> {
  try {
    const r = await fetchFn(`${base}/archive/blob_${year}_fires.json`);
    if (!r.ok) return null;
    const s = (await r.json()) as unknown;
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    return s as FiresSummary;
  } catch {
    return null;
  }
}

/** The season's per-fire sizes sidecar (pipeline/export_season.py). Null on
 * any failure, like loadSeason: the caller then falls back to deriving the
 * sizes from the cells file, exactly as before the sidecar existed. Only a
 * sample entry is shape-checked — the file is ~22k entries and our own
 * output; the check is there to catch a wrong file, not a corrupt entry. */
export async function loadSeasonSizes(
  year: number,
  base = "/data",
  fetchFn: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
): Promise<SeasonSizes | null> {
  try {
    const r = await fetchFn(`${base}/archive/season_${year}_sizes.json`);
    if (!r.ok) return null;
    const s = (await r.json()) as Partial<SeasonSizes> | null;
    if (!s || typeof s !== "object" || typeof s.year !== "number") return null;
    const fires = s.fires as unknown;
    if (!fires || typeof fires !== "object" || Array.isArray(fires)) return null;
    const sample = Object.values(fires)[0] as unknown;
    // 3 elements before pipeline/export_season.py started writing the
    // nearest-town place (d95bcb2), 4 since: both are this file. Rejecting the
    // longer row would throw the whole sidecar away and send every boot back
    // to the 5 MB cells file — the regression the sidecar exists to prevent.
    if (
      sample !== undefined &&
      (!Array.isArray(sample) || (sample.length !== 3 && sample.length !== 4) || typeof sample[0] !== "number")
    ) {
      return null;
    }
    return s as SeasonSizes;
  } catch {
    return null;
  }
}
