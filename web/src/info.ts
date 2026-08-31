import { escapeHtml } from "./escape";
import { layerState } from "./freshness";
import { statRow } from "./stat_row";
import type { Manifest } from "./types";

const ORDER = ["events", "frp", "wind", "timeline", "imagery"];

export function infoHtml(m: Manifest, now: Date = new Date()): string {
  const layers = m.layers ?? {};
  const keys = ORDER.filter((k) => layers[k]).concat(
    Object.keys(layers).filter((k) => !ORDER.includes(k)),
  );

  if (!keys.length) {
    return (
      `<div class="fc-title">Data &amp; sources</div>` +
      `<p class="legend-note">No layer information in this build.</p>` +
      SAFETY
    );
  }

  const rows = keys
    .map((key) => {
      const state = layerState(m, key, now);
      const src = escapeHtml(String(layers[key]?.source ?? "unknown"));
      const age = state.reason
        ? `<span class="info-warn">${escapeHtml(state.reason)}</span>`
        : escapeHtml(state.ageText || "up to date");
      return statRow(`${escapeHtml(key)} · ${src}`, age);
    })
    .join("");

  return (
    `<div class="fc-title">Data &amp; sources</div>` +
    `<div class="fc-sub">Every layer records how old it is.</div>` +
    `<div class="fc-stats">${rows}</div>` +
    coverageHtml(m) +
    SAFETY
  );
}

function coverageHtml(m: Manifest): string {
  const c = m.coverage;
  if (!c) return "";
  return (
    `<div class="fc-title">How far back data goes</div>` +
    `<div class="fc-stats">` +
    statRow("Live tracks", `last ~${c.live_window_hours}h`) +
    statRow("Recent hotspot lookback", `${c.firms_lookback_days} days`) +
    statRow("Past-fire clustering", `${c.scar_window_days} days`) +
    statRow("Full fire-shape archive", `from ${c.archive_floor_date}`) +
    `</div>` +
    `<p class="legend-note">${escapeHtml(c.effis_note)}</p>`
  );
}

const SAFETY =
  `<div class="safety">⚠ Satellite data is not an official alert. ` +
  `In danger call <b>112</b> and follow local authorities.</div>`;
