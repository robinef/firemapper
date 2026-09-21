/**
 * EU-27 membership — one set, for the whole app.
 *
 * Who is in the union is a fact about the world, not about a layer: the season
 * layer's "EU-27" scope, the /scale page's EFFIS comparison and any EU-only
 * view added later all have to answer it the same way, and have to change
 * together the day it changes. Hence its own module with no imports: update
 * the list here (only) if membership changes.
 *
 * ISO 3166-1 alpha-2, upper case — the same spelling the per-fire summary
 * (pipeline/export_scale_blob.py, GeoNames-derived) carries.
 */
export const EU27: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

/** Is this country code an EU-27 member state? A missing code is NOT a member:
 * "we could not place this fire" must never be read as "this fire is in the
 * EU", or an unknown would inflate a total the reader compares against an
 * EFFIS EU-27 figure. */
export const isEuCountry = (code: string | null | undefined): boolean =>
  code != null && EU27.has(code);
