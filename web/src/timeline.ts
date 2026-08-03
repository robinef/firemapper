import { mountScrubber, type Scrubber, type ScrubCause } from "./scrubber";
import type { TimelineDay } from "./types";

// Keyed on the host element rather than held in a closure so a running
// scrubber can be found and stopped from the TOP of the next mountTimeline
// call — before any early return. Without this, a previous render's
// scrubber.destroy() is never reachable and its play timer keeps firing
// against a stale closure (stale days/onSelect) after the DOM row that
// displayed it is long gone.
const scrubbers = new WeakMap<HTMLElement, Scrubber>();

function teardownScrubber(el: HTMLElement): void {
  scrubbers.get(el)?.destroy();
  scrubbers.delete(el);
}

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

/**
 * Which day a pointer at `x` refers to.
 *
 * Thirty 44px bars do not fit in a 375px phone, so the chart is ONE target at
 * least 44px tall and the day is resolved from the x-coordinate instead. Visual
 * bar width (~11px) and interactive target size are separate concerns.
 */
export function binAtX(x: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0;
  const index = Math.floor((x / width) * count);
  return Math.min(count - 1, Math.max(0, index));
}

export interface TimelineOpts {
  title?: string; // header label
  unit?: string; // what a bar counts (e.g. "detections", "new cells")
  showTrend?: boolean; // week-over-week badge (only meaningful for daily data)
  partialLast?: boolean; // mark the final bar as still-accumulating
  /** Click a bar to inspect that day/bin — the caller reacts (e.g. locate it
   *  on the map). `cause` tells a toggling consumer (e.g. day_slice_select)
   *  whether this is the user's deliberate pick ("select": a bar click or a
   *  drag) or playback landing on this bin ("step") — only the former should
   *  ever hide what it just showed. */
  onSelect?: (day: TimelineDay, index: number, cause: ScrubCause) => void;
  /** Which bin the scrubber starts on. A caller that already painted a bin
   *  other than 0 before mounting (e.g. a fire card opens on the full
   *  footprint) must pass that bin, or the scrubber's label disagrees with
   *  what's already on the map. Defaults to 0. */
  initialIndex?: number;
}

export function mountTimeline(
  el: HTMLElement,
  days: TimelineDay[] | null | undefined,
  opts: TimelineOpts = {},
): void {
  // Must run before every return path, including the early-out ones below:
  // a prior render's play timer outlives the DOM row that displayed it
  // (el.innerHTML wipes the row, not the setTimeout chain closed over it).
  teardownScrubber(el);

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
    initialIndex = 0,
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

    let scrubber: Scrubber | null = null;

    /** The single place a selection happens. Bar clicks and slider input both
     *  land here, which is what keeps the two controls in agreement — rather
     *  than two listeners each trying to mirror the other. `scrubCause` is
     *  present only when the scrubber drove this call (a drag or playback);
     *  a bar click leaves it undefined, which also means the scrubber hasn't
     *  synced its own position yet and needs setIndex. */
    const select = (i: number, scrubCause?: ScrubCause) => {
      const bar = barsWrap.children[i] as HTMLElement | undefined;
      if (bar) {
        barsWrap.querySelectorAll(".tl-sel").forEach((x) => x.classList.remove("tl-sel"));
        bar.classList.add("tl-sel");
        if (readout) readout.textContent = bar.dataset.label ?? "";
      }
      // setIndex moves the control without calling back, so this cannot loop.
      if (!scrubCause) scrubber?.setIndex(i);
      // A bar click is always a deliberate pick, same as a drag.
      onSelect(days[i], i, scrubCause ?? "select");
    };

    if (days.length > 1) {
      scrubber = mountScrubber(el, {
        count: days.length,
        labelFor: (i) => (barsWrap.children[i] as HTMLElement | undefined)?.dataset.label ?? "",
        onScrub: (i, cause) => select(i, cause),
        initialIndex,
      });
      scrubbers.set(el, scrubber);
    }

    // Track pointerdown state to guard against drag-selection. Record which
    // pointer and target started the gesture; only fire onSelect if it ends
    // on the same pointer without significant movement (mimicking click semantics).
    let pointerDownState: {
      pointerId: number;
      target: EventTarget | null;
      x: number;
      y: number;
    } | null = null;

    barsWrap.addEventListener("pointerdown", (e) => {
      pointerDownState = {
        pointerId: e.pointerId,
        target: e.target,
        x: e.clientX,
        y: e.clientY,
      };
    });

    // Single unified handler for both mouse (via per-bar precision) and touch
    // (via x-coordinate binning). Fires onSelect exactly once per press+release,
    // preventing the double-fire that would occur if we used both click and
    // pointerup handlers (pointerup fires, browser synthesizes click, both
    // would call onSelect without this consolidation).
    barsWrap.addEventListener("pointerup", (e) => {
      // pointerup fires for every button, unlike the click it replaced —
      // without this a right-click (context menu) or middle-click would
      // still select the day and trigger onSelect's fetch underneath the menu.
      if (e.button !== 0) return;

      // Validate this is the same pointer gesture (guards against drag-selection).
      if (!pointerDownState || e.pointerId !== pointerDownState.pointerId) return;

      // Guard against significant pointer movement (drag).
      const dx = e.clientX - pointerDownState.x;
      const dy = e.clientY - pointerDownState.y;
      const dragThreshold = 5;
      if (Math.sqrt(dx * dx + dy * dy) > dragThreshold) return;

      const t = e.target as HTMLElement;
      let i: number;

      // If target is a bar, use its exact index (preserves per-bar precision).
      // Otherwise resolve from x-coordinate (makes the whole chart one target,
      // including taps in gaps between bars).
      if (t.classList.contains("tl-bar")) {
        i = Number(t.dataset.i);
      } else {
        const rect = barsWrap.getBoundingClientRect();
        i = binAtX(e.clientX - rect.left, rect.width, days.length);
      }

      select(i);

      pointerDownState = null; // Consumed gesture.
    });

    barsWrap.addEventListener("pointerleave", () => {
      pointerDownState = null; // Cancel gesture if pointer leaves container.
    });
  }
}
