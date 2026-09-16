/**
 * The historical-fire-lookup panel: place search (explicit submit only —
 * see this plan's Global Constraints, Nominatim forbids autocomplete),
 * date-range picking, and the orchestration that ties /api/geocode,
 * /api/historical-hotspots, reconstructHistoricalFire, and
 * FireCard.openHistoricalLookup together.
 */

export const DEFAULT_RADIUS_KM = 15;
export const MAX_SPAN_DAYS = 90;

export function deriveBbox(lon: number, lat: number, radiusKm: number = DEFAULT_RADIUS_KM): string {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const west = lon - dLon;
  const south = lat - dLat;
  const east = lon + dLon;
  const north = lat + dLat;
  return `${west},${south},${east},${north}`;
}

export function validateDateRange(before: string, after: string): { ok: true } | { ok: false; error: string } {
  if (!before) return { ok: false, error: "pick a start date" };
  if (!after) return { ok: false, error: "pick an end date" };
  const b = new Date(before);
  const a = new Date(after);
  if (Number.isNaN(b.getTime()) || Number.isNaN(a.getTime())) {
    return { ok: false, error: "invalid date" };
  }
  if (b > a) return { ok: false, error: "start date must be before end date" };
  const spanDays = Math.round((a.getTime() - b.getTime()) / 86_400_000);
  if (spanDays > MAX_SPAN_DAYS) {
    return { ok: false, error: `date range must be ${MAX_SPAN_DAYS} days or fewer` };
  }
  return { ok: true };
}
