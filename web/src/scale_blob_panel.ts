// Country breakdown for the scale-comparison blob — fetches
// archive/blob_{year}_fires.json (pipeline/export_scale_blob.py) and renders
// a per-country area/fire-count list into the panel next to the trigger
// button. Kept separate from layer_scale_blob.ts: this is display metadata
// about the fires, unrelated to the blob's geometry/drag lifecycle.
import { escapeHtml } from "./escape";
import { statRow } from "./stat_row";

export type FiresSummary = Record<string, { country: string | null; area_km2: number }>;

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

export function breakdownHtml(rows: CountryBreakdown[]): string {
  if (rows.length === 0) {
    return `<div class="fc-title">Fires by country</div><p class="legend-note">No fires yet this year.</p>`;
  }
  // country is GeoNames-derived (see escape.ts) — not our own pipeline's
  // guaranteed-clean output, so it's escaped at this sink like every other
  // GeoNames-sourced string in the app.
  const body = rows
    .map((r) =>
      statRow(
        escapeHtml(r.country),
        `${r.areaKm2.toFixed(1)} km² · ${r.fireCount} fire${r.fireCount === 1 ? "" : "s"}`,
      ),
    )
    .join("");
  return `<div class="fc-title">Fires by country</div><div class="fc-stats">${body}</div>`;
}

export async function fetchFiresSummary(
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FiresSummary | null> {
  const response = await fetchImpl(`${DATA_BASE}/archive/blob_${year}_fires.json`);
  if (!response.ok) return null;
  return (await response.json()) as FiresSummary;
}

export async function showScaleBlobPanel(
  container: HTMLElement,
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const summary = await fetchFiresSummary(year, fetchImpl);
  container.innerHTML = summary ? breakdownHtml(aggregateByCountry(summary)) : "";
}

export function hideScaleBlobPanel(container: HTMLElement): void {
  container.innerHTML = "";
}
