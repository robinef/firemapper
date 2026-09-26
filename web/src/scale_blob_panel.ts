// Country breakdown for the scale-comparison blob — fetches
// archive/blob_{year}_fires.json (pipeline/export_scale_blob.py) and renders
// a per-country area/fire-count list into the panel next to the trigger
// button. Kept separate from layer_scale_blob.ts: this is display metadata
// about the fires, unrelated to the blob's geometry/drag lifecycle.
import { escapeHtml } from "./escape";
import { bandByCountry, euOnly, groupByCountry, type Band } from "./scale_blob_shape";
import type { FiresSummary } from "./types";

// Moved to types.ts when the season layer became a second reader; re-exported
// here so this module's existing importers keep their one-stop import.
export type { FiresSummary } from "./types";

export type CountryBreakdown = { country: string; areaKm2: number; fireCount: number };

const DATA_BASE = "/data";

export function aggregateByCountry(summary: FiresSummary): CountryBreakdown[] {
  const byCountry = new Map<string, { areaKm2: number; fireCount: number }>();
  for (const { country, area_km2 } of Object.values(summary)) {
    const key = country ?? "Unknown";
    const entry = byCountry.get(key) ?? { areaKm2: 0, fireCount: 0 };
    entry.areaKm2 += area_km2;
    entry.fireCount += 1;
    byCountry.set(key, entry);
  }
  return [...byCountry.entries()]
    .map(([country, v]) => ({ country, areaKm2: v.areaKm2, fireCount: v.fireCount }))
    .sort((a, b) => b.areaKm2 - a.areaKm2);
}

/** `bandOf`: the blob band each country is painted in. Given it, the panel is
 * the blob's legend — a swatch per row — and each row is a button selecting
 * that band (main.ts delegates the clicks; `data-band` names the band). */
export function breakdownHtml(rows: CountryBreakdown[], bandOf?: (country: string) => Band): string {
  if (rows.length === 0) {
    return `<div class="fc-title">EU-27 fires by country</div><p class="legend-note">No EU-27 fires yet this year.</p>`;
  }
  // country is GeoNames-derived (see escape.ts) — not our own pipeline's
  // guaranteed-clean output, so it's escaped at this sink like every other
  // GeoNames-sourced string in the app.
  const body = rows
    .map((r) => {
      const band = bandOf?.(r.country);
      const open = band
        ? `<div class="fc-stat blob-row" role="button" tabindex="0" data-band="${escapeHtml(band.key)}">` +
          `<span><i class="blob-swatch" style="background:${band.color}"></i>`
        : `<div class="fc-stat"><span>`;
      const value = `${r.areaKm2.toFixed(1)} km² · ${r.fireCount} fire${r.fireCount === 1 ? "" : "s"}`;
      return `${open}${escapeHtml(r.country)}</span><b>${value}</b></div>`;
    })
    .join("");
  return `<div class="fc-title">EU-27 fires by country</div><div class="fc-stats">${body}</div>`;
}

export async function fetchFiresSummary(
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FiresSummary | null> {
  const response = await fetchImpl(`${DATA_BASE}/archive/blob_${year}_fires.json`);
  if (!response.ok) return null;
  return (await response.json()) as FiresSummary;
}

/**
 * `summaryP`: the caller's already-running load of the SAME file. The season
 * layer starts one at boot for its EU-27 scope (data.ts::loadFiresSummary), so
 * on a page that has a season this panel would otherwise download and parse
 * ~1.1 MB a second time. Given a promise, it is the answer — including when it
 * resolves null, which means "the file was tried and is not there"; falling
 * back to a fetch then would reinstate the second download on the one path
 * already known to fail. Without it (no season published), the fetch stands.
 */
export async function showScaleBlobPanel(
  container: HTMLElement,
  year: number,
  fetchImpl: typeof fetch = fetch,
  summaryP?: Promise<FiresSummary | null>,
): Promise<void> {
  const fetched = await (summaryP ?? fetchFiresSummary(year, fetchImpl));
  // The blob's scope (scale_blob_shape.ts::euOnly), so the legend lists
  // exactly the bands on the map.
  const summary = fetched ? euOnly(fetched) : null;
  container.innerHTML = summary
    ? breakdownHtml(aggregateByCountry(summary), bandByCountry(groupByCountry(summary)))
    : "";
}

export function hideScaleBlobPanel(container: HTMLElement): void {
  container.innerHTML = "";
}
