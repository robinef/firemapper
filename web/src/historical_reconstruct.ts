/**
 * Reconstructs a Track (web/src/types.ts) from raw FIRMS hotspot CSV rows —
 * the client-side half of the historical fire lookup feature. Ports three
 * already-proven pipeline algorithms rather than reinventing them, verified
 * against the actual source at each step (not re-derived from memory):
 *  - CSV parsing + confidence filtering: pipeline/fetch_firms.py's
 *    parse_firms_csv/_LOW_CONF.
 *  - Static heat-source detection: pipeline/events.py's static_cells.
 *  - 6h binning: pipeline/events.py's bin_start + pipeline/metrics.py's
 *    bins_series + pipeline/export.py's _cell_bins.
 */

export interface HistoricalRow {
  lat: number;
  lon: number;
  time: Date;
  frp: number;
}

function parseCsvLines(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/** VIIRS confidence is a letter (l/n/h); MODIS confidence is numeric 0-100.
 *  The row's own shape says which filter applies — no separate tier flag
 *  needed. Matches pipeline/fetch_firms.py's _LOW_CONF exactly. */
function isLowConfidence(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "l") return true; // VIIRS low
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric < 30; // MODIS
  return false;
}

export function parseFirmsCsv(text: string): HistoricalRow[] {
  const rows: HistoricalRow[] = [];
  for (const rec of parseCsvLines(text)) {
    const confidence = rec.confidence ?? "";
    if (isLowConfidence(confidence)) continue;
    const date = rec.acq_date;
    const time = (rec.acq_time ?? "").padStart(4, "0");
    if (!date || !time) continue;
    const hh = time.slice(0, 2);
    const mm = time.slice(2, 4);
    const parsed = new Date(`${date}T${hh}:${mm}:00Z`);
    if (Number.isNaN(parsed.getTime())) continue;
    const lat = Number(rec.latitude);
    const lon = Number(rec.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const frp = Number(rec.frp);
    rows.push({ lat, lon, time: parsed, frp: Number.isFinite(frp) ? frp : 0 });
  }
  return rows;
}
