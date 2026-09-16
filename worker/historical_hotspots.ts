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

const ALLOWED_ORIGINS = new Set([
  "https://firemapper.robinef.workers.dev",
  "http://localhost:5173", // vite dev server
]);

export function isAllowedOrigin(request: Request): boolean {
  const raw = request.headers.get("origin") ?? request.headers.get("referer");
  if (!raw) return false;
  try {
    return ALLOWED_ORIGINS.has(new URL(raw).origin);
  } catch {
    return false;
  }
}

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

// FIRMS' actual source list (firms.modaps.eosdis.nasa.gov/api/area/) has NO
// VIIRS_NOAA21_SP — NOAA-21 only has an NRT product. Do not add it here
// without re-checking that page; a previous design draft assumed it existed.
const VIIRS_SNPP_COVERAGE_START = new Date("2012-01-19T00:00:00Z");
const VIIRS_SNPP_RETIRED = new Date("2026-11-01T00:00:00Z");

export function firmsSourceFor(date: Date): "MODIS_SP" | "VIIRS_SNPP_SP" | "VIIRS_NOAA20_SP" {
  if (date < VIIRS_SNPP_COVERAGE_START) return "MODIS_SP";
  if (date < VIIRS_SNPP_RETIRED) return "VIIRS_SNPP_SP";
  return "VIIRS_NOAA20_SP";
}

const MAX_DAY_RANGE = 5; // FIRMS Area API's own per-request cap

export function chunkWindows(start: Date, end: Date): { date: string; dayRange: number }[] {
  const windows: { date: string; dayRange: number }[] = [];
  let cursor = start;
  while (cursor <= end) {
    const remainingDays = Math.round((end.getTime() - cursor.getTime()) / 86_400_000) + 1;
    const dayRange = Math.min(MAX_DAY_RANGE, remainingDays);
    windows.push({ date: cursor.toISOString().slice(0, 10), dayRange });
    cursor = new Date(cursor.getTime() + dayRange * 86_400_000);
  }
  return windows;
}

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
// A past date range's FIRMS data never changes once published — same
// reasoning as worker/index.ts's HD_CACHE for Sentinel Hub tiles: caching at
// the edge is what stops a repeat viewer costing FIRMS map-key quota.
const RESPONSE_CACHE = "public, max-age=604800, immutable";

export interface HistoricalHotspotsEnv {
  FIRMS_HISTORICAL_MAP_KEY?: string;
  /** Seam for tests; defaults to global fetch. */
  HISTORICAL_HOTSPOTS_UPSTREAM?: (request: Request) => Promise<Response>;
}

function mergeCsv(bodies: string[]): string {
  let merged = "";
  bodies.forEach((body, i) => {
    const lines = body.split("\n").filter((l) => l.length > 0);
    merged += (i === 0 ? lines : lines.slice(1)).join("\n") + "\n";
  });
  return merged;
}

export async function handleHistoricalHotspots(
  request: Request,
  env: HistoricalHotspotsEnv,
): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return new Response("forbidden", { status: 403 });
  }
  const key = env.FIRMS_HISTORICAL_MAP_KEY;
  if (!key) {
    return new Response("historical lookup unavailable", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "3600" },
    });
  }

  const params = new URL(request.url).searchParams;
  const bboxRaw = params.get("bbox");
  const bbox = parseBbox(bboxRaw);
  if (!bbox || !bboxRaw) {
    return new Response("invalid or missing bbox", { status: 400 });
  }
  const range = validateRange(params.get("start"), params.get("end"));
  if ("error" in range) {
    return new Response(range.error, { status: 400 });
  }

  // Forward the raw bbox text (already validated west,south,east,north by
  // parseBbox) rather than reformatting the parsed floats — stringifying a
  // number like -1.0 drops the trailing zero, which FIRMS need not accept.
  const bboxStr = bboxRaw;
  const fetcher = env.HISTORICAL_HOTSPOTS_UPSTREAM ?? ((r: Request) => fetch(r));
  const bodies: string[] = [];
  for (const { date, dayRange } of chunkWindows(range.start, range.end)) {
    const source = firmsSourceFor(new Date(`${date}T00:00:00Z`));
    const upstream = new Request(`${FIRMS_BASE}/${key}/${source}/${bboxStr}/${dayRange}/${date}`);
    let response: Response;
    try {
      response = await fetcher(upstream);
    } catch {
      // Never surface the caught error's own message: it (or the request it
      // was thrown for) can embed the map key via `upstream.url`.
      return new Response("historical lookup upstream failure", { status: 502 });
    }
    if (!response.ok) {
      return new Response("historical lookup upstream failure", { status: 502 });
    }
    bodies.push(await response.text());
  }

  return new Response(mergeCsv(bodies), {
    status: 200,
    headers: { "content-type": "text/csv", "cache-control": RESPONSE_CACHE },
  });
}
