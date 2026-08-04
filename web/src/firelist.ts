/**
 * Find a fire by name.
 *
 * Every other route into a fire's card is positional or time-boxed: you must
 * know where it burned, or catch it while a marker still exists. Live fires
 * vanish from the map 48 h after their last detection (events.py
 * CLOSE_AFTER_H), the past-scar list is capped, and the whole event window is
 * 14 days. Someone who remembers "the big one near Bordeaux" and nothing else
 * had no way in at all.
 *
 * This is a plain client-side index over the events already loaded, so it costs
 * no extra request and covers active, quiet and closed fires alike.
 */

export interface FireEntry {
  id: string;
  /** Nearest town, when the gazetteer resolved one. */
  place: string | null;
  /** What the row shows: place name, else a dated fallback. */
  label: string;
  status: string;
  areaKm2: number;
  started: string;
  lon: number;
  lat: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoDay(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 10) : "";
}

/** GeoJSON stringifies nested props, so `place` arrives as JSON text. A bad
 * value must not throw while building the index. */
function placeName(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return (JSON.parse(raw) as { name?: string })?.name ?? null;
  } catch {
    return null;
  }
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Flatten the events collection into searchable rows, biggest first.
 *
 * Size ordering matters more than recency here: the fire someone is trying to
 * recall by name is almost always a large one, and an unnamed speck should
 * never sit above it. */
export function buildFireIndex(events: GeoJSON.FeatureCollection): FireEntry[] {
  const out: FireEntry[] = [];
  for (const f of events.features ?? []) {
    if (f.geometry?.type !== "Point") continue;
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (typeof p.id !== "string") continue;
    const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    const place = placeName(p.place) ?? (typeof p.name === "string" ? p.name : null);
    const started = isoDay(p.started);
    out.push({
      id: p.id,
      place,
      // Without the gazetteer every fire falls back to this, which is why the
      // date is in it: "Fire" repeated forty times is not a searchable list.
      label: place ?? `Fire · ${prettyDate(started)}`,
      status: typeof p.status === "string" ? p.status : "",
      areaKm2: Number(p.area_km2 ?? 0),
      started,
      lon,
      lat,
    });
  }
  return out.sort((a, b) => b.areaKm2 - a.areaKm2);
}

/**
 * Rows matching `query`, biggest first.
 *
 * Matches place name, status and date, so "bordeaux", "closed" and "22 jul"
 * all work. An empty query returns the head of the list rather than nothing —
 * opening the panel should show the largest recent fires, which is the answer
 * to "what happened lately" even when the reader has no search term.
 */
export function searchFires(index: FireEntry[], query: string, limit = 40): FireEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return index.slice(0, limit);
  return index
    .filter((e) => {
      const hay = `${e.label} ${e.place ?? ""} ${e.status} ${e.started} ${prettyDate(e.started)}`;
      return hay.toLowerCase().includes(q);
    })
    .slice(0, limit);
}

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  stale: "Quiet",
  closed: "Burned out",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** The panel body: a search box and the matching rows. */
export function renderFireList(rows: FireEntry[], query: string, total: number): string {
  const items = rows
    .map(
      (e) =>
        `<button class="fl-row" data-id="${esc(e.id)}">` +
        `<b>${esc(e.label)}</b>` +
        `<span>${e.areaKm2} km² · ${esc(STATUS_LABEL[e.status] ?? e.status)} · ` +
        `${esc(prettyDate(e.started))}</span></button>`,
    )
    .join("");
  const empty = `<p class="legend-note">No fire matches that. Only the last 14 days are kept.</p>`;
  return (
    `<div class="fc-title">Find a fire</div>` +
    `<div class="fc-sub">${total} in the last 14 days · biggest first</div>` +
    `<input class="fl-search" type="search" placeholder="Place, status or date…" ` +
    `value="${esc(query)}" autocomplete="off">` +
    `<div class="fl-rows">${items || empty}</div>`
  );
}
