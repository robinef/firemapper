/**
 * The (i) panel on the map only has room for a layer's name and its age
 * (info.ts) — this page is the "read more" it links out to: what each feed
 * actually is, who publishes it, and how far its history reaches.
 */
import { escapeHtml, safeHttpUrl } from "./escape";
import { layerState } from "./freshness";
import type { Manifest } from "./types";

// Same order info.ts renders its rows in, so the two never disagree about
// which layer comes first.
const ORDER = ["events", "frp", "wind", "timeline", "imagery"];

/**
 * Keyed by manifest.layers[key].source — the exact string info.ts already
 * prints next to each layer's age (pipeline/export.py:559-590). A source with
 * no entry here still gets a row built from that raw string; it just has no
 * blurb or link, which is better than hiding a layer the manifest reports.
 */
const CATALOG: Record<string, { name: string; url?: string; blurb: string }> = {
  "viirs+mtg": {
    name: "NASA FIRMS (VIIRS / MODIS) + EUMETSAT MTG-FCI",
    url: "https://firms.modaps.eosdis.nasa.gov/",
    blurb: "Active-fire hotspots, fused from polar-orbiting VIIRS/MODIS passes " +
      "and Meteosat Third Generation's geostationary imager.",
  },
  "mtg-fci": {
    name: "EUMETSAT Meteosat Third Generation (MTG-FCI)",
    url: "https://view.eumetsat.int/",
    blurb: "Geostationary fire radiative power over Europe, refreshed roughly " +
      "every 10 minutes.",
  },
  "open-meteo": {
    name: "Open-Meteo",
    url: "https://open-meteo.com/",
    blurb: "Forecast wind speed and direction, used to draw the spread arrows.",
  },
  archive: {
    name: "FireMapper archive",
    blurb: "Built in-house from the VIIRS/MTG detections above, accumulated " +
      "per fire for as long as it keeps burning.",
  },
  "gibs+effis": {
    name: "NASA GIBS + EFFIS",
    url: "https://effis.jrc.ec.europa.eu/",
    blurb: "Before/after satellite imagery (NASA GIBS) paired with the EU's " +
      "own mapped burned-area perimeters (EFFIS, the Copernicus Emergency " +
      "Management Service).",
  },
  "nasa-gibs": {
    name: "NASA GIBS",
    url: "https://www.earthdata.nasa.gov/data/tools/gibs",
    blurb: "True-colour satellite basemap tiles.",
  },
};

function row(m: Manifest, key: string, now: Date): string {
  const layer = m.layers?.[key];
  if (!layer) return "";
  const state = layerState(m, key, now);
  const age = state.reason
    ? `<span class="info-warn">${escapeHtml(state.reason)}</span>`
    : escapeHtml(state.ageText || "up to date");
  const cat = CATALOG[layer.source];
  const name = cat ? escapeHtml(cat.name) : escapeHtml(layer.source);
  const link = cat?.url
    ? ` <a href="${safeHttpUrl(cat.url)}" target="_blank" rel="noopener">Official site →</a>`
    : "";
  const blurb = cat ? `<p class="src-blurb">${escapeHtml(cat.blurb)}${link}</p>` : "";
  return `<div class="src-row">
    <div class="src-row-head"><b>${escapeHtml(key)}</b><span class="src-age">${age}</span></div>
    <div class="src-row-name">${name}</div>
    ${blurb}
  </div>`;
}

function coverage(m: Manifest): string {
  const c = m.coverage;
  if (!c) return "";
  return `<section class="src-coverage">
    <h2>How far back data goes</h2>
    <div class="src-stats">
      <div class="src-stat"><span>Live tracks</span><b>last ~${escapeHtml(c.live_window_hours)}h</b></div>
      <div class="src-stat"><span>Recent hotspot lookback</span><b>${escapeHtml(c.firms_lookback_days)} days</b></div>
      <div class="src-stat"><span>Past-fire clustering</span><b>${escapeHtml(c.scar_window_days)} days</b></div>
      <div class="src-stat"><span>Full fire-shape archive</span><b>from ${escapeHtml(c.archive_floor_date)}</b></div>
    </div>
    <p class="src-note">${escapeHtml(c.effis_note)}</p>
  </section>`;
}

const SAFETY =
  `<div class="safety">⚠ Satellite data is not an official alert. ` +
  `In danger call <b>112</b> and follow local authorities.</div>`;

export function renderSources(root: HTMLElement, manifest: Manifest | null, now: Date = new Date()): void {
  if (!manifest) {
    root.innerHTML = `<p class="src-empty">Source information is unavailable right now.</p>${SAFETY}`;
    return;
  }
  const layers = manifest.layers ?? {};
  const keys = ORDER.filter((k) => layers[k]).concat(
    Object.keys(layers).filter((k) => !ORDER.includes(k)),
  );
  const rows = keys.map((k) => row(manifest, k, now)).join("");
  root.innerHTML = `
    <p class="src-intro">Every layer on the map is drawn from one of these feeds.
      Ages shown are as of this page load.</p>
    <div class="src-rows">${rows || '<p class="src-empty">No layer information in this build.</p>'}</div>
    ${coverage(manifest)}
    ${SAFETY}
  `;
}
