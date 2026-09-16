/**
 * Proxy for NASA FIRMS' Standard Processing (SP) archive
 * (firms.modaps.eosdis.nasa.gov/api/area/csv), keeping the map key server-side
 * — same reasoning as worker/index.ts's /hd Sentinel Hub proxy: exposing the
 * key client-side would hand every visitor its transaction quota.
 *
 * This module owns validation, source selection, and request chunking; only
 * this file changes when FIRMS' own limits or source lineup change.
 */

export const MAX_SPAN_DAYS = 90;
export const MAX_BBOX_DEG = 0.5;

export function parseBbox(
  raw: string | null,
): { west: number; south: number; east: number; north: number } | null {
  if (!raw) return null;
  const parts = raw.split(",");
  if (parts.length !== 4) return null;
  const [west, south, east, north] = parts.map(Number);
  if ([west, south, east, north].some((n) => !Number.isFinite(n))) return null;
  if (west >= east || south >= north) return null;
  if (east - west > MAX_BBOX_DEG || north - south > MAX_BBOX_DEG) return null;
  return { west, south, east, north };
}

function parseDate(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Verify the date round-trips back to the same input (catches calendar-invalid dates like Feb 30)
  if (d.toISOString().slice(0, 10) !== raw) return null;
  return d;
}

export function validateRange(
  startRaw: string | null,
  endRaw: string | null,
): { start: Date; end: Date } | { error: string } {
  if (!startRaw) return { error: "start is required (YYYY-MM-DD)" };
  if (!endRaw) return { error: "end is required (YYYY-MM-DD)" };
  const start = parseDate(startRaw);
  if (!start) return { error: "start is not a valid date" };
  const end = parseDate(endRaw);
  if (!end) return { error: "end is not a valid date" };
  if (start > end) return { error: "start must not be after end" };
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (spanDays > MAX_SPAN_DAYS) return { error: `date span must not exceed ${MAX_SPAN_DAYS} days` };
  return { start, end };
}
