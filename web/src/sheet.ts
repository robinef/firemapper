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
 * Below the mobile breakpoint (max-width: 640px) the sheet mounts itself via a
 * matchMedia watcher and the handle responds to Pointer Events for drag-to-
 * resize; above it, the sheet does not exist and the three panels sit wherever
 * index.html put them.
 */
import { onUi } from "./ui_events";

export type Detent = "peek" | "half" | "full";
export type SheetMode = "overview" | "detail";

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
  // peek exists to show the histogram — that's the one thing a glance at the
  // map should never earn. Since scrubber row sits in the same block, peek must
  // fit both bars, axis, and the row control. Measured at 375px: handle ~28 +
  // gap 8 + .tl-head (wraps to 2 lines) ~34 + gap 5 + .tl-bars 54 + gap 5 +
  // .tl-axis ~14 + gap 5 + scrubber row's own 2px margin-top + ~44 ≈ 199px of
  // real content. `* { box-sizing: border-box }` plus .sheet's `padding: 0
  // 12px 12px` (style.css) eats 12px of whatever height is set here, so the
  // content box at peek is 12px shorter than this number — 212 is what
  // actually leaves a few px spare, not 200.
  return { peek: 212, half: Math.round(vh * 0.5), full: Math.round(vh * 0.88) };
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
      // Every peek/mode CSS rule is keyed on data-detent/data-mode (see
      // style.css's mobile block), and nothing else ever set them before this
      // point — applyHeight() only sizes the box, it doesn't stamp either
      // attribute. Without this, first load had neither attribute at all
      // (different from every later state, where at least one detail:open
      // or detail:close round trip has run), so #panel/layers/legend were
      // laid out inside a 100px sheet but still reachable by scrolling —
      // only becoming truly hidden once data-detent="peek" existed.
      api.setContent(mode);
      api.snapTo(detent);

      offs.push(
        onUi("detail:open", () => {
          api.setContent("detail");
          api.snapTo("half");
        }),
        onUi("detail:close", () => {
          api.setContent("overview");
          api.snapTo("peek");
        }),
        onUi("compare:enter", () => {
          beforeCompare = detent;
          api.snapTo("peek");
        }),
        onUi("compare:exit", () => api.snapTo(beforeCompare)),
      );
      attachDrag();
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

  // Pointer drag on the handle. Pointer Events cover touch and mouse alike, so
  // there is one code path; see layer_imagery.ts for the same choice.
  const attachDrag = () => {
    const handle = container?.querySelector(".sheet-handle") as HTMLElement | null;
    if (!handle) return;
    // A single tracked pointerId means a second finger landing mid-drag is
    // ignored rather than hijacking (and corrupting) the in-progress gesture.
    let activePointerId: number | null = null;
    let startY = 0;
    let startHeight = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerId) return;
      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (lastY - e.clientY) / dt; // upward = positive
      lastY = e.clientY;
      lastT = e.timeStamp;
      const height = startHeight + (startY - e.clientY);
      if (container) container.style.height = `${Math.max(60, height)}px`;
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointerId) return;
      // The browser can implicitly release capture before pointerup fires
      // (a documented cross-browser Pointer Events quirk, worse on WebKit) —
      // releasePointerCapture then throws NotFoundError. Confirmed live: an
      // uncaught throw here aborts the rest of this handler, so
      // activePointerId never resets to null and the handle stops responding
      // to every future drag for the rest of the page's life. jsdom's tests
      // stub both capture methods as no-ops and can never see this.
      try {
        handle.releasePointerCapture?.(e.pointerId);
      } catch (err) {
        // NotFoundError = already released implicitly; state reset below
        // still runs. Anything else (e.g. SecurityError) is unexpected —
        // surface it instead of going silent, so a new failure mode isn't
        // invisible the way this one originally was.
        if (!(err instanceof DOMException) || err.name !== "NotFoundError") {
          console.warn("sheet: releasePointerCapture failed unexpectedly", err);
        }
      }
      activePointerId = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const height = container ? parseFloat(container.style.height) : 0;
      api.snapTo(projectDetent(height, velocity, detentHeights()));
    };
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (activePointerId !== null) return; // a drag is already in progress
      activePointerId = e.pointerId;
      e.preventDefault();
      // Same guard as onUp's releasePointerCapture: setPointerCapture can
      // throw NotFoundError too (e.g. the pointer already went up between
      // event dispatch and this handler on a slow frame). Without the guard
      // the throw would abort before the listeners below are attached,
      // leaving activePointerId stuck non-null with no way to ever clear it.
      try {
        handle.setPointerCapture?.(e.pointerId);
      } catch (err) {
        // NotFoundError = proceed without native capture; window-level
        // listeners still work. Anything else is unexpected — surface it.
        if (!(err instanceof DOMException) || err.name !== "NotFoundError") {
          console.warn("sheet: setPointerCapture failed unexpectedly", err);
        }
      }
      startY = lastY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      startHeight = container ? container.getBoundingClientRect().height : 0;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      // Without pointercancel the sheet keeps following a finger that the OS
      // took away (incoming call, system gesture) — pointerup never fires.
      window.addEventListener("pointercancel", onUp);
    });
  };

  // The sheet only exists below the mobile breakpoint. Read matchMedia at
  // call time (not module load) so tests can stub it, and guard its absence
  // so callers that don't stub it (desktop-only tests) are unaffected.
  const query = window.matchMedia?.(`(max-width: ${breakpoint}px)`);
  if (query) {
    const sync = (matches: boolean) => (matches ? api.mount() : api.destroy());
    query.addEventListener?.("change", (e) => sync(e.matches));
    // Callers get an already-correct sheet without repeating the check.
    if (query.matches) queueMicrotask(() => api.mount());
  }

  return api;
}
