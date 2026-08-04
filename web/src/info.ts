import { escapeHtml } from "./escape";
import { layerState } from "./freshness";
import type { Manifest } from "./types";

const ORDER = ["events", "frp", "wind", "aircraft", "timeline", "imagery"];

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
      return (
        `<div class="fc-stat"><span>${escapeHtml(key)} · ${src}</span>` +
        `<b>${age}</b></div>`
      );
    })
    .join("");

  return (
    `<div class="fc-title">Data &amp; sources</div>` +
    `<div class="fc-sub">Every layer records how old it is.</div>` +
    `<div class="fc-stats">${rows}</div>` +
    SAFETY
  );
}

const SAFETY =
  `<div class="safety">⚠ Satellite data is not an official alert. ` +
  `In danger call <b>112</b> and follow local authorities.</div>`;
