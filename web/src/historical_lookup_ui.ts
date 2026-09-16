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

export function renderHistoricalLookupForm(): string {
  return `
    <button class="panel-close" aria-label="Close">‹ Map</button>
    <h2>Find a past fire</h2>
    <p>Search a place, or click anywhere on the map, then pick the date range you think it burned.</p>
    <form id="historical-lookup-form">
      <label for="historical-lookup-q">Place name</label>
      <!-- type="search" + a real <form> submit is the ONLY way this ever
           fires a request — no input/keyup listener anywhere near this
           element. Nominatim's usage policy forbids autocomplete outright. -->
      <input id="historical-lookup-q" name="q" type="search" autocomplete="off" placeholder="e.g. Gironde" />
      <button type="button" id="historical-lookup-search">Search</button>
      <div id="historical-lookup-geocode-result" aria-live="polite"></div>
      <label for="historical-lookup-before">Before (earliest it might have started)</label>
      <input id="historical-lookup-before" name="before" type="date" />
      <label for="historical-lookup-after">After (latest it might have settled)</label>
      <input id="historical-lookup-after" name="after" type="date" />
      <div id="historical-lookup-location" aria-live="polite">No location picked yet — search above or click the map.</div>
      <button type="submit">Look up this fire</button>
    </form>
    <div id="historical-lookup-result" aria-live="polite"></div>
  `;
}

export function renderAmbiguousResult(clusters: { cellCount: number; rowCount: number }[]): string {
  return `
    <p><b>${clusters.length} distinct fires found</b> in this area/date window —
    narrow your search (a smaller area or a tighter date range) to pick one.</p>
    <ul>${clusters.map((c) => `<li>${c.rowCount} detections across ${c.cellCount} cells</li>`).join("")}</ul>
  `;
}

export function renderNoDataResult(): string {
  return `<p>No detections found for this area and date range. Try widening the search or the dates.</p>`;
}
