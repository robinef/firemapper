/**
 * Escaping for values that reach innerHTML.
 *
 * Most of this app's data is our own pipeline output, but two sources are not:
 * the GDACS alert feed and GeoNames place names. Both are interpolated into
 * panel markup, so both are escaped at the SINK. That placement is the point:
 * it holds whatever the pipeline does or does not validate on the way in.
 *
 * There were three sources until the aircraft layer was retired. ADS-B
 * callsigns were the sharpest case — anyone with a transponder chooses what to
 * broadcast — and the pipeline screened them at ingest as well. That ingest
 * check is gone with the fetch; this sink-side escaping is the half that was
 * never allowed to depend on it.
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
