/**
 * The season total, rendered as something you can count.
 *
 * "10,240 km²" is a number most readers cannot picture. "6.5 × Greater London"
 * is one they can, and a grid of 6.5 tiles is one they can check by eye. The
 * arithmetic behind that sentence is NOT done here: `pipeline/scale.py` picks
 * the unit and computes the count, and this module only draws what it was
 * handed. Recomputing the count in the browser would let the page and the
 * artifact disagree about the same season.
 *
 * Three states, deliberately distinct:
 *
 *   normal       total_km2 > 0 and a unit to express it in.
 *   zero         total_km2 === 0 with a valid payload. Reachable every year in
 *                early January, and NOT an error — rendering it "unavailable"
 *                would claim the data is missing when it is present and right.
 *   unavailable  no season.json. Never a zero, never a blank number, because
 *                "we don't know" and "nothing burned" are opposite claims.
 *
 * `unit` is null exactly when the total is zero (run.py:_attach_units refuses
 * to invent one), so no path that dereferences `unit.count` is reachable from
 * the zero state.
 */
import { escapeHtml } from "./escape";

export type ScaleUnit = { name: string; km2: number; count: number };

export type SeasonCountry = {
  name: string;
  km2: number;
  events: number;
  /**
   * Absent, not null, when a country's total rounded to 0.0 km² — pick_unit
   * raises on a non-positive total, so _attach_units simply skips the key.
   * The export copies the country dict through verbatim, so the browser sees
   * the gap too.
   */
  unit?: ScaleUnit;
};

export type SeasonData = {
  season_year: number;
  fetched_at: string;
  /** Always null: EFFIS publishes no currency timestamp (export.py). */
  observed_at: string | null;
  status: string;
  total_km2: number;
  event_count: number;
  min_fire_ha: number;
  unit: ScaleUnit | null;
  countries: SeasonCountry[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Past this many tiles the grid has stopped being countable, and a corrupt
 * count would otherwise ask the browser for arbitrarily many nodes. The
 * headline sentence still states the true figure — the grid is a reading aid,
 * not the fact — so dropping it costs nothing but the illusion of counting.
 */
const MAX_TILES = 400;

/** The "as of" date, from fetched_at — see the note in export.py: observed_at
 * is null by design, so there is nothing else honest to date this by. */
function asOf(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "an unknown date";
  const d = new Date(parsed);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Thousands-separated km². Totals under 10 keep a decimal, because a real
 * 0.4 km² season printed as "0 km²" reads as the zero state it is not. */
function km2(value: number): string {
  const digits = Math.abs(value) < 10 ? 1 : 0;
  return `${value.toLocaleString("en-GB", { maximumFractionDigits: digits })} km²`;
}

/** The tile count as the pipeline rounded it: one decimal, never re-derived. */
function count(value: number): string {
  return value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

/** Whole tiles, plus one partial tile sized to the fractional remainder. */
function grid(unit: ScaleUnit): string {
  const whole = Math.floor(unit.count);
  if (whole > MAX_TILES) return "";

  const fraction = unit.count - whole;
  const tiles = Array.from({ length: whole }, () => '<div data-tile="full"></div>');
  if (fraction > 0.001) {
    tiles.push(`<div data-tile="partial" style="--frac:${fraction.toFixed(3)}"></div>`);
  } else if (!tiles.length) {
    // A positive total that rounds to 0.0 tiles still burned something; an
    // empty grid would say it did not.
    tiles.push('<div data-tile="partial" style="--frac:0.08"></div>');
  }

  return `<div class="scale-grid" role="img" aria-label="${count(unit.count)} times ${escapeHtml(unit.name)}">${tiles.join("")}</div>
    <p class="scale-legend">1 tile = ${escapeHtml(unit.name)} · ${km2(unit.km2)}</p>`;
}

/**
 * Countries get bars, never grids. The headline usually lands on Greater London
 * while a country lands on Paris, so two grids side by side would invite a
 * reader to compare a 6-tile row with a 28-tile row and conclude the wrong
 * thing. A bar is measured against its own row's maximum and makes no such
 * offer.
 */
function countries(data: SeasonData): string {
  if (!data.countries.length) return "";
  const max = Math.max(...data.countries.map((c) => c.km2), 0) || 1;

  const rows = data.countries.map((c) => {
    const width = Math.max(1, Math.round((c.km2 / max) * 100));
    const unit = c.unit ? `${count(c.unit.count)} × ${escapeHtml(c.unit.name)}` : "—";
    return `<li data-country class="scale-row">
      <span class="scale-row-name">${escapeHtml(c.name)}</span>
      <span class="scale-row-bar"><i style="width:${width}%"></i></span>
      <span class="scale-row-value">${km2(c.km2)}</span>
      <span class="scale-row-unit">${unit}</span>
    </li>`;
  });

  return `<section class="scale-countries">
    <h2>Where it burned</h2>
    <ol class="scale-rows">${rows.join("")}</ol>
    <p class="scale-note">Top ${data.countries.length} by mapped area. Rounded
      independently of the total, so they will not sum to it.</p>
  </section>`;
}

/**
 * Why the headline is a floor, and why the count is events not areas. Every
 * figure here comes from the artifact — hardcoding "30 ha" would silently lie
 * the day EFFIS changes its threshold. `event_count` is api2's own distinct
 * fire-event count, not a re-derivation, so it carries no perimeter-vs-fire
 * ambiguity to caveat here.
 */
function caveats(data: SeasonData): string {
  const parts = [
    `EFFIS rapid damage assessment maps burns from
     <strong>${escapeHtml(data.min_fire_ha)} ha</strong> up, so this is a floor,
     not a census.`,
    `${data.event_count.toLocaleString("en-GB")} wildfire events.`,
  ];

  return `<p class="scale-caveat">${parts.join(" ")}</p>
    <p class="scale-asof" data-asof>EFFIS archive as of ${escapeHtml(asOf(data.fetched_at))}${staleNote(data)}</p>`;
}

/**
 * The only channel the page has for "EFFIS was unreachable".
 *
 * `status` is the orchestrator's word (run.py): "fresh" polled successfully,
 * "reused" was inside the 6-hour gate, "stale" means the fetch was attempted
 * and failed and we are serving the snapshot we already had. Only the last of
 * those is worth a reader's attention, and it needs saying: with the as-of
 * date now honest, a stale run shows a date that quietly recedes with no
 * explanation for why it stopped moving.
 *
 * Rendered inside the as-of line rather than as its own block, because the
 * date is exactly the thing it qualifies.
 */
function staleNote(data: SeasonData): string {
  if (data.status !== "stale") return "";
  return ` · <span data-stale>EFFIS could not be reached on the last check, so
    this total may be incomplete.</span>`;
}

/**
 * The scope, stated. api2's EU aoi is the 27 member states by construction —
 * Russia and Turkey are simply not queried, not filtered out of a larger set
 * — so a caption reading only "Burned in Europe" over a total that excludes
 * them is a claim the number does not support.
 */
function kicker(data: SeasonData): string {
  return `<p class="scale-kicker">Burned in Europe, excluding Russia and Turkey
    · ${escapeHtml(data.season_year)} season</p>`;
}

export function renderScale(root: HTMLElement, data: SeasonData | null): void {
  if (!data) {
    // No payload at all. Not a zero, and not a blank: say which it is.
    root.innerHTML = `<section data-state="unavailable" class="scale-empty">
      <p class="scale-kicker">Burned in Europe</p>
      <p class="scale-zero">Season totals are unavailable right now.</p>
      <p class="scale-caveat">The seasonal burned-area archive could not be
        loaded. This says nothing about how much has burned — only that we
        cannot show it.</p>
    </section>`;
    return;
  }

  // Routed on the TOTAL alone. A null unit must never reach this branch: a
  // pick_unit failure is swallowed by _safe(..., default=None) in run.py:170,
  // which leaves `unit` absent under a real, non-zero total. Routing on the
  // unit would then print "no wildfire events" over a season that happened —
  // the page stating the opposite of the truth. Zero is the only thing that
  // licenses that sentence.
  if (data.total_km2 <= 0) {
    root.innerHTML = `<section data-state="zero" class="scale-empty">
      ${kicker(data)}
      <p class="scale-zero">No wildfire events yet this year.</p>
      ${caveats(data)}
    </section>`;
    return;
  }

  // The total is real, so the number and its caveats are unconditional. Only
  // the comparison is conditional, because only the comparison needs a unit.
  const unit = data.unit;
  const sentence = unit
    ? `<p class="scale-sentence">That's
        <strong>${count(unit.count)} × ${escapeHtml(unit.name)}</strong>,
        burned since 1 January.</p>`
    : `<p class="scale-sentence scale-nounit">No scale comparison is available
        for this total.</p>`;

  root.innerHTML = `<section data-state="normal" class="scale-page">
    <div class="scale-hero">
      <div class="scale-hero-text">
        ${kicker(data)}
        <p class="scale-total">${km2(data.total_km2)}</p>
        ${sentence}
        ${caveats(data)}
      </div>
      <div class="scale-hero-grid">${unit ? grid(unit) : ""}</div>
    </div>
    ${countries(data)}
  </section>`;
}
