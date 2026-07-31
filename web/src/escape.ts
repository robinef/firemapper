/**
 * Escaping for values that reach innerHTML.
 *
 * Most of this app's data is our own pipeline output, but three sources are
 * not: ADS-B callsigns (anyone with a transponder chooses what to broadcast),
 * the GDACS alert feed, and GeoNames place names. All three are interpolated
 * into panel markup, so they are escaped at the sink — the pipeline also
 * refuses malformed callsigns at ingest, and defence in depth means the sink
 * does not depend on that having happened.
 */

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/**
 * A URL safe to put in an href. Anything that is not http(s) — most
 * importantly `javascript:` — becomes "#", because the GDACS feed is a third
 * party and a link target is a script execution sink, not just text.
 */
export function safeHttpUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "#";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "#";
    return escapeHtml(url.href);
  } catch {
    return "#";
  }
}
