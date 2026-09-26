/**
 * The historical-fire-lookup panel: place search (explicit submit only —
 * see this plan's Global Constraints, Nominatim forbids autocomplete),
 * date-range picking, and the orchestration that ties /api/geocode,
 * /api/historical-hotspots, reconstructHistoricalFire, and
 * FireCard.openHistoricalLookup together.
 */

import { reconstructHistoricalFire } from "./historical_reconstruct";
import type { Track } from "./types";
import type { HistoricalLookupMeta } from "./firecard";

export const DEFAULT_RADIUS_KM = 15;
export const MAX_SPAN_DAYS = 90;
// Must match worker/historical_hotspots.ts's own MAX_BBOX_DEG exactly -- that
// Worker rejects any bbox wider than this with a 400, and this constant is
// what keeps deriveBbox() from ever producing one. Not shared via import:
// web/ and worker/ are separate build targets in this repo, so this is
// deliberately a duplicated, commented constant rather than a cross-import.
const MAX_BBOX_DEG = 0.5;
// Stay comfortably under the server's exact cap, not flush against it --
// float rounding on either side of a `>` boundary check must never be the
// difference between success and a 400.
const BBOX_SAFETY_MARGIN = 0.98;

export function deriveBbox(lon: number, lat: number, radiusKm: number = DEFAULT_RADIUS_KM): string {
  const maxHalfSpan = (MAX_BBOX_DEG * BBOX_SAFETY_MARGIN) / 2;
  // Height (dLat) is latitude-independent, but a large enough radiusKm alone
  // can still exceed the cap, so it needs the same clamp as width.
  const dLat = Math.min(radiusKm / 111, maxHalfSpan);
  // Width (dLon) grows unboundedly as latitude approaches the poles --
  // cos(lat) shrinks toward 0, and the old `Math.max(cos, 0.01)` floor only
  // prevented a divide-by-zero, it never bounded the resulting degrees. A
  // 15km-radius lookup near Fairbanks or Kiruna silently produced a bbox
  // over 4x the server's cap and always 400'd. Clamp directly against the
  // cap instead of just the denominator.
  const dLon = Math.min(
    radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01)),
    maxHalfSpan,
  );
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

/** Local calendar date as YYYY-MM-DD — toISOString() is UTC, which in
 *  Europe is still "yesterday" for the first hours after local midnight. */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function renderHistoricalLookupForm(today: string = localToday()): string {
  // No .panel-close of its own — see web/tests/nav_integration.test.ts's
  // "search has exactly one way out" precedent: a .panel-close here would
  // hide #panel and emit detail:close while nav's stack still says
  // "historical", not "detail", so shell.ts's detail:close subscriber
  // (which only calls nav.back() when top === "detail") would silently
  // no-op, leaving an unclosable empty overlay. The shell's own back
  // bar (rendered whenever this view is pushed), the rail icon's toggle,
  // and Escape all correctly call nav.back() regardless of which view is
  // on top — that's this view's one, working way out.
  //
  // Two forms, not one: the place search is its own <form> so Enter in the
  // place field runs the search (implicit submission clicks ITS submit
  // button) instead of submitting the whole lookup with no location yet.
  return `
    <h2 class="hl-title">Find a past fire</h2>
    <p class="hl-lede">Rebuild a fire from satellite detections: say where, then roughly when.</p>
    <section class="hl-step">
      <h3 class="hl-step-title"><span class="hl-num">1</span> Where</h3>
      <form id="historical-lookup-geo-form" class="hl-search" role="search">
        <label for="historical-lookup-q" class="hl-sr">Place name</label>
        <!-- type="search" + an explicit submit is the ONLY way this ever
             fires a request — no input/keyup listener anywhere near this
             element. Nominatim's usage policy forbids autocomplete outright. -->
        <input id="historical-lookup-q" name="q" type="search" autocomplete="off" placeholder="Town, region… e.g. Gironde" />
        <button type="submit" id="historical-lookup-search">Search</button>
      </form>
      <div id="historical-lookup-geocode-result" class="hl-hint" aria-live="polite"></div>
      <div id="historical-lookup-location" class="hl-location" aria-live="polite">📍 Search a place, or click anywhere on the map</div>
      <!-- Phones only (CSS): there the form covers the map, so picking needs
           the sheet out of the way first. -->
      <button type="button" id="historical-lookup-pick" class="hl-pick">📍 Pick on the map</button>
    </section>
    <form id="historical-lookup-form">
      <section class="hl-step">
        <h3 class="hl-step-title"><span class="hl-num">2</span> When</h3>
        <div class="hl-dates">
          <label for="historical-lookup-before">From<small>earliest it could start</small></label>
          <label for="historical-lookup-after">To<small>latest it could end</small></label>
          <input id="historical-lookup-before" name="before" type="date" min="2000-11-01" max="${today}" required />
          <input id="historical-lookup-after" name="after" type="date" min="2000-11-01" max="${today}" required />
        </div>
        <div class="hl-hint">Up to ${MAX_SPAN_DAYS} days. Searches ${DEFAULT_RADIUS_KM} km around the location.</div>
      </section>
      <button type="submit" class="hl-go">Look up this fire</button>
    </form>
    <div id="historical-lookup-result" class="hl-result" aria-live="polite"></div>
  `;
}

/** Keeps To ≥ From in the native pickers: To's minimum follows From. */
export function wireDateRange(container: HTMLElement): void {
  const before = container.querySelector<HTMLInputElement>("#historical-lookup-before");
  const after = container.querySelector<HTMLInputElement>("#historical-lookup-after");
  if (!before || !after) return;
  before.addEventListener("change", () => {
    if (!before.value) return;
    after.min = before.value;
    if (after.value && after.value < before.value) after.value = before.value;
  });
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

export interface HistoricalLookupDeps {
  fetchFn: typeof fetch;
  openHistoricalLookup: (track: Track, meta: HistoricalLookupMeta) => Promise<void>;
  onAmbiguous: (clusters: { cellCount: number; rowCount: number }[]) => void;
  onNoData: () => void;
  onError: (message: string) => void;
}

export async function runHistoricalLookup(
  lon: number,
  lat: number,
  place: string,
  before: string,
  after: string,
  deps: HistoricalLookupDeps,
): Promise<void> {
  const range = validateDateRange(before, after);
  if (!range.ok) {
    deps.onError(range.error);
    return;
  }

  const bbox = deriveBbox(lon, lat);
  const url = `/api/historical-hotspots?bbox=${bbox}&start=${before}&end=${after}`;
  let response: Response;
  try {
    response = await deps.fetchFn(url);
  } catch {
    deps.onError("could not reach the historical lookup service");
    return;
  }
  if (!response.ok) {
    // Propagate the Worker's own static, non-secret error text (see
    // worker/historical_hotspots.ts: "invalid or missing bbox", "date range
    // ... days or fewer", "upstream failure", etc.) instead of one generic
    // message for every cause -- a bad-bbox 400 and a FIRMS-outage 502 need
    // different user reactions (fix the search vs. try again later), and a
    // generic message hides that distinction.
    const detail = await response.text().catch(() => "");
    deps.onError(detail ? `historical lookup failed: ${detail}` : "historical lookup failed — try again shortly");
    return;
  }

  const csvText = await response.text();
  const id = `lookup-${Date.now()}`;
  const result = reconstructHistoricalFire(csvText, id);
  if (result.status === "no_data") {
    deps.onNoData();
    return;
  }
  if (result.status === "ambiguous") {
    deps.onAmbiguous(result.clusters);
    return;
  }
  await deps.openHistoricalLookup(result.track, { lon, lat, place, before, after });
}

/** Wires the Search BUTTON's click only — deliberately not the input's
 *  input/keyup events. See this plan's Global Constraints: autocomplete is
 *  forbidden by Nominatim's usage policy, not just discouraged. */
export function wireGeocodeSearch(
  container: HTMLElement,
  fetchFn: typeof fetch,
  onResult: (lon: number, lat: number, place: string) => void,
): void {
  const button = container.querySelector<HTMLButtonElement>("#historical-lookup-search");
  const input = container.querySelector<HTMLInputElement>("#historical-lookup-q");
  const resultEl = container.querySelector<HTMLElement>("#historical-lookup-geocode-result");
  if (!button || !input) return;

  // The search's own <form> (Enter in the place field) must never fall
  // through to a real navigation; the button's click is the one trigger.
  input.form?.addEventListener("submit", (ev) => ev.preventDefault());
  button.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    if (resultEl) resultEl.textContent = "Searching…";
    let response: Response;
    try {
      response = await fetchFn(`/api/geocode?q=${encodeURIComponent(q)}`);
    } catch {
      if (resultEl) resultEl.textContent = "Search failed — try again.";
      return;
    }
    if (!response.ok) {
      if (resultEl) resultEl.textContent = "Search failed — try again.";
      return;
    }
    const results = (await response.json()) as { lat: string; lon: string; display_name: string }[];
    if (!results.length) {
      if (resultEl) resultEl.textContent = "No match found — try a different place name.";
      return;
    }
    const [first] = results;
    if (resultEl) resultEl.textContent = `Found: ${first.display_name}`;
    onResult(Number(first.lon), Number(first.lat), first.display_name);
  });
}
