/**
 * Entry point for /scale.html.
 *
 * Deliberately does NOT go through freshness.ts::layerState. That helper is
 * generic over a caller-supplied key list and assumes every layer carries a
 * max_age_s budget; the season entry has none, because an archive that updates
 * over days to weeks has no honest staleness budget to invent (export.py). Ask
 * layerState about "season" and `ageS > undefined` is always false — the layer
 * could never read stale — while a null fetched_at renders the reason string
 * "undefined unavailable" straight into the page. The "as of" date on this page
 * comes from season.json's own fetched_at instead.
 */
import { renderScale, type SeasonData } from "./scale_render";

type SeasonLayer = { fetched_at?: string | null };
type ScaleManifest = { generation: string; layers?: Record<string, SeasonLayer> };

export async function loadSeason(
  base = "/data",
  fetchFn: typeof fetch = fetch,
): Promise<SeasonData | null> {
  try {
    const manifest = (await (await fetchFn(`${base}/manifest.json`)).json()) as ScaleManifest;

    // The pipeline sets this only when a payload was actually written, so it is
    // the flag that says whether there is a season.json to go and fetch. An
    // absent season entry (an older generation) is not a "no" — try anyway.
    const season = manifest.layers?.season;
    if (season && !season.fetched_at) return null;

    const response = await fetchFn(`${base}/${manifest.generation}/season.json`);
    if (!response.ok) return null;
    return (await response.json()) as SeasonData;
  } catch {
    // A missing or malformed archive renders "unavailable" — never a zero.
    return null;
  }
}

const root = document.getElementById("scale");
if (root) void loadSeason().then((data) => renderScale(root, data));
