import type { TimelineDay } from "./types";

/**
 * Bottom fire-activity histogram — the archive's time dimension, one bar per
 * day. This is the app's founding question ("are fires accelerating?") made
 * visible: a rising tail of bars is the story. Polar (VIIRS/MODIS) detections
 * only, so day-to-day counts are comparable; the last bar is partial (today's
 * passes are still coming in) and labelled as such.
 *
 * Bar height ∝ detections; colour warms with height (yellow → deep red) so the
 * worst days read at a glance. Hover a bar for the exact count.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  // Take just the date part; a bin may carry a full timestamp (…T12:00:00Z).
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** Warm ramp by normalised height: calm yellow → alarm red. */
function barColor(frac: number): string {
  if (frac >= 0.8) return "#ff2d2d";
  if (frac >= 0.55) return "#ff5a1f";
  if (frac >= 0.3) return "#ff8c00";
  return "#ffd000";
}

export interface TimelineOpts {
  title?: string; // header label
  unit?: string; // what a bar counts (e.g. "detections", "new cells")
  showTrend?: boolean; // week-over-week badge (only meaningful for daily data)
  partialLast?: boolean; // mark the final bar as still-accumulating
  /** Click a bar to inspect that day/bin — the caller reacts (e.g. locate it
   *  on the map). */
  onSelect?: (day: TimelineDay, index: number) => void;
}

export function mountTimeline(
  el: HTMLElement,
  days: TimelineDay[] | null | undefined,
  opts: TimelineOpts = {},
): void {
  if (!days || days.length === 0) {
    el.style.display = "none";
    return;
  }
  // A window of all-zero days is not a chart, it is a message. The live site
  // rendered 30 empty bars and looked merely quiet, when in fact the polar
  // archive had never been filled.
  if (days.every((d) => !d.count)) {
    el.style.display = "";
    el.innerHTML =
      `<div class="timeline-empty">No VIIRS detections in this window — ` +
      `the polar archive is empty or its feed is down.</div>`;
    return;
  }
  const {
    title = "Fire activity · detections / day",
    unit = "detections",
    showTrend = true,
    partialLast = true,
    onSelect,
  } = opts;
  el.style.display = "";
  const max = Math.max(1, ...days.map((d) => d.count));

  // Trend: last 7 days vs the 7 before, so the header states the direction
  // instead of leaving the reader to eyeball it.
  let trend = "";
  if (showTrend) {
    const tail = days.slice(-7).reduce((s, d) => s + d.count, 0);
    const prior = days.slice(-14, -7).reduce((s, d) => s + d.count, 0);
    if (prior > 0) {
      const pct = Math.round(((tail - prior) / prior) * 100);
      if (pct >= 10) trend = `<span class="tl-up">▲ ${pct}% vs prior week</span>`;
      else if (pct <= -10) trend = `<span class="tl-down">▼ ${Math.abs(pct)}% vs prior week</span>`;
      else trend = `<span class="tl-flat">≈ steady vs prior week</span>`;
    }
  }

  const bars = days
    .map((d, i) => {
      const frac = d.count / max;
      const h = Math.max(d.count > 0 ? 6 : 1, Math.round(frac * 100));
      const partial = partialLast && i === days.length - 1;
      return (
        `<div class="tl-bar${partial ? " tl-partial" : ""}" data-i="${i}" ` +
        `style="height:${h}%;background:${barColor(frac)}" ` +
        `data-label="${shortDate(d.date)} · ${d.count.toLocaleString()} ${unit}` +
        `${partial ? " (partial)" : ""}"></div>`
      );
    })
    .join("");

  const first = shortDate(days[0].date);
  const last = shortDate(days[days.length - 1].date);
  const hint = onSelect ? `<span class="tl-readout">click a bar to inspect</span>` : "";
  el.innerHTML =
    `<div class="tl-head">` +
    `<span class="tl-title">${title}</span>${trend}${hint}</div>` +
    `<div class="tl-bars">${bars}</div>` +
    `<div class="tl-axis"><span>${first}</span><span>${last}</span></div>` +
    `<div class="tl-tip" hidden></div>`;

  const tip = el.querySelector<HTMLElement>(".tl-tip")!;
  const readout = el.querySelector<HTMLElement>(".tl-readout");
  const barsWrap = el.querySelector<HTMLElement>(".tl-bars")!;
  barsWrap.addEventListener("pointermove", (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("tl-bar")) {
      tip.hidden = true;
      return;
    }
    tip.textContent = t.dataset.label ?? "";
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(e.clientX - r.left, 60), r.width - 60)}px`;
  });
  barsWrap.addEventListener("pointerleave", () => (tip.hidden = true));

  if (onSelect) {
    barsWrap.style.cursor = "pointer";
    barsWrap.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (!t.classList.contains("tl-bar")) return;
      barsWrap.querySelectorAll(".tl-sel").forEach((x) => x.classList.remove("tl-sel"));
      t.classList.add("tl-sel");
      const i = Number(t.dataset.i);
      if (readout) readout.textContent = t.dataset.label ?? "";
      onSelect(days[i], i);
    });
  }
}
