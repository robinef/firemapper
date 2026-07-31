/**
 * The mobile bottom sheet.
 *
 * It owns exactly two things: how tall the sheet is, and which of the three
 * content modes is showing. It holds no application data — which layers are on
 * and which fire is open stay in registry.ts and firecard.ts, which render into
 * the same element ids they always did.
 *
 * The sheet re-parents #sidebar/#panel/#timeline rather than duplicating them,
 * so there is exactly one implementation of every view. #timeline sits in its
 * own stable slot inside the sheet and is never re-parented on a mode change:
 * firecard.ts re-renders that same element per fire, so moving it on every
 * detail:open/close would break its per-fire history.
 *
 * Drag gestures and the breakpoint that decides whether the sheet is active at
 * all are not this module's job — they land in the next task. This module just
 * needs to exist and behave correctly once driven externally (tests, or later,
 * a gesture handler).
 */
import { onUi } from "./ui_events";

export type Detent = "peek" | "half" | "full";
export type SheetMode = "overview" | "detail" | "aircraft";

/** A flick faster than this carries past the nearest detent. px per ms. */
const FLICK_THRESHOLD = 0.5;
/** How far ahead a flick is projected before choosing a detent. ms. */
const PROJECTION_MS = 100;

export interface Sheet {
  mount(): void;
  setContent(m: SheetMode): void;
  snapTo(d: Detent): void;
  destroy(): void;
  readonly detent: Detent;
  readonly mode: SheetMode;
}

export function detentHeights(): Record<Detent, number> {
  const vh = window.innerHeight || 800;
  return { peek: 100, half: Math.round(vh * 0.5), full: Math.round(vh * 0.88) };
}

/**
 * Which detent a drag should land on. Position alone is not enough: a user who
 * flicks hard expects to travel, even if they let go near where they started.
 */
export function projectDetent(
  y: number,
  velocity: number,
  heights: Record<Detent, number>,
): Detent {
  const target = Math.abs(velocity) >= FLICK_THRESHOLD ? y + velocity * PROJECTION_MS : y;
  const entries = Object.entries(heights) as [Detent, number][];
  let best: Detent = entries[0][0];
  let bestGap = Infinity;
  for (const [name, height] of entries) {
    const gap = Math.abs(height - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = name;
    }
  }
  return best;
}

export function createSheet(breakpoint = 640): Sheet {
  let container: HTMLElement | null = null;
  let detent: Detent = "peek";
  let mode: SheetMode = "overview";
  let beforeCompare: Detent = "peek";
  const offs: Array<() => void> = [];
  const origin = new Map<string, HTMLElement>();

  const applyHeight = () => {
    if (container) container.style.height = `${detentHeights()[detent]}px`;
  };

  const api: Sheet = {
    get detent() {
      return detent;
    },
    get mode() {
      return mode;
    },

    mount() {
      if (container) return;
      container = document.createElement("div");
      container.className = "sheet";
      container.innerHTML = `<div class="sheet-handle" aria-hidden="true"></div>`;

      // Remember where each element came from so destroy() is exact.
      for (const id of ["timeline", "sidebar", "panel"]) {
        const el = document.getElementById(id);
        if (!el?.parentElement) continue;
        origin.set(id, el.parentElement);
        container.appendChild(el);
      }
      document.body.appendChild(container);
      applyHeight();

      offs.push(
        onUi("detail:open", () => {
          api.setContent("detail");
          api.snapTo("half");
        }),
        onUi("detail:close", () => {
          api.setContent("overview");
          api.snapTo("peek");
        }),
        // An aircraft tap can arrive while a fire card is already open (it
        // overwrites #panel directly, without emitting detail:close first).
        // There's no illegal state to guard against here — the mode simply
        // becomes "aircraft", same as if it had come from overview.
        onUi("aircraft:open", () => {
          api.setContent("aircraft");
          api.snapTo("half");
        }),
        onUi("compare:enter", () => {
          beforeCompare = detent;
          api.snapTo("peek");
        }),
        onUi("compare:exit", () => api.snapTo(beforeCompare)),
      );
    },

    setContent(m: SheetMode) {
      mode = m;
      container?.setAttribute("data-mode", m);
    },

    snapTo(d: Detent) {
      detent = d;
      container?.setAttribute("data-detent", d);
      applyHeight();
    },

    destroy() {
      for (const off of offs.splice(0)) off();
      for (const [id, parent] of origin) {
        const el = document.getElementById(id);
        if (el) parent.appendChild(el);
      }
      origin.clear();
      container?.remove();
      container = null;
    },
  };

  return api;
}
