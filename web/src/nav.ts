/**
 * The view stack.
 *
 * One rule holds this together: `popstate` is the only code that moves the
 * cursor. `back()` and `reset()` ask the browser to navigate and return; the
 * stack changes when the browser says so. That is what makes a tap on "‹", the
 * Escape key, and Android's back gesture the same operation instead of three
 * implementations that drift apart.
 *
 * A pop TRUNCATES. Retaining popped entries so the browser's Forward button
 * could re-enter them was the original design, and it does not survive contact
 * with the views: popping a fire card runs `fireCard.close()`, which empties
 * #panel, un-dims the map and swaps the histogram back to the overview;
 * popping compare runs `compare.exit()`, which destroys the swipe. A retained
 * entry therefore restores to an empty box. Rebuilding the view properly would
 * need either payloads on the event bus (which this design refuses) or a
 * reopen path per panel kind — and only fire cards have one, so aircraft
 * panels, cell pickers and scar cards would restore blank while fires
 * restored fine. Forward that works for some views and blanks for others is
 * worse than Forward that does nothing.
 *
 * So `popstate` reporting a depth above the cursor is an orphan: nav undoes it
 * with a single `history.back()`, leaving the button visibly inert and the
 * history index back in step with the stack. Without that resync the index
 * would sit one ahead, and the next Back would appear dead — the exact
 * complaint this module exists to fix.
 *
 * Deliberately DOM-free and free of ui_events: shell.ts owns both. That keeps
 * the arithmetic here testable without a document.
 */

export type ViewId = "map" | "detail" | "compare" | "layers" | "search" | "info";

export interface Entry {
  view: ViewId;
  /** What THIS view is ("Map", "Layers", a fire's name). A back bar names its
   *  DESTINATION, so it renders the title of the entry BENEATH it — which is
   *  how compare's bar shows the fire's name without any event payload. */
  title: string;
  /** Run when this entry becomes top again, so a view sharing an element with
   *  another (search and detail both own #panel) can repaint itself. */
  restore?: () => void;
}

/** The slice of `window.history` this module uses. Injectable because jsdom
 *  queues back()/go() and does not dispatch popstate for them, which would
 *  make every test a race. */
export interface HistoryLike {
  pushState(state: unknown, title: string): void;
  replaceState(state: unknown, title: string): void;
  back(): void;
  go(delta: number): void;
  readonly state: unknown;
}

export interface Nav {
  push(e: Entry): void;
  replace(e: Entry): void;
  back(): void;
  reset(): void;
  onExit(v: ViewId, fn: () => void): () => void;
  onChange(fn: (stack: readonly Entry[]) => void): () => void;
  readonly stack: readonly Entry[];
  readonly top: Entry;
  /** True while a pop is running its exit callbacks. Callers that translate a
   *  view's own "I closed" announcement into a back() must drop it while this
   *  is set, or the teardown drives a second pop. */
  readonly unwinding: boolean;
}

const BASE: Entry = { view: "map", title: "Map" };

export function createNav(opts: {
  history?: HistoryLike;
  target?: EventTarget;
  base?: Entry;
} = {}): Nav {
  const history = opts.history ?? (window.history as unknown as HistoryLike);
  const target = opts.target ?? window;
  const entries: Entry[] = [opts.base ?? BASE];
  let cursor = 0;
  let unwinding = false;
  const exits = new Map<ViewId, Array<() => void>>();
  const changes: Array<(s: readonly Entry[]) => void> = [];

  const notify = () => {
    const visible = entries.slice(0, cursor + 1);
    for (const fn of changes) fn(visible);
  };

  const fireExits = (view: ViewId) => {
    for (const fn of exits.get(view) ?? []) {
      // One failing teardown must not strand the stack half-unwound.
      try {
        fn();
      } catch (e) {
        console.error(`nav: exit handler for ${view} failed`, e);
      }
    }
  };

  /** Set while undoing an orphaned Forward, so the resync's own popstate is
   *  recognised as ours and does not start a second one. */
  let resyncing = false;

  const goTo = (depth: number) => {
    if (depth > cursor) {
      // Forward into a tail this stack truncated. Nothing to restore, so undo
      // the navigation rather than leaving the history index one ahead of the
      // stack — which would make the next Back look dead.
      if (resyncing) {
        resyncing = false;
        return;
      }
      resyncing = true;
      history.back();
      return;
    }
    resyncing = false;
    const wanted = Math.max(0, depth);
    if (wanted === cursor) return;
    unwinding = true;
    try {
      for (let i = cursor; i > wanted; i--) fireExits(entries[i].view);
    } finally {
      unwinding = false;
    }
    entries.length = wanted + 1; // a pop truncates; see the module comment
    cursor = wanted;
    entries[cursor].restore?.();
    notify();
  };

  target.addEventListener("popstate", (ev) => {
    const state = (ev as PopStateEvent).state as { depth?: number } | null;
    goTo(typeof state?.depth === "number" ? state.depth : 0);
  });

  // A reload (or a bfcache restore) can hand us a history entry from the
  // previous page life, whose in-memory stack is gone. Rewind to the base so
  // the first Back is not a no-op against a depth we cannot honour.
  const booted = history.state as { depth?: number } | null;
  if (typeof booted?.depth === "number" && booted.depth > 0) {
    history.go(-booted.depth);
  }

  return {
    push(e) {
      entries.length = cursor + 1; // drop any forward tail
      entries.push(e);
      cursor = entries.length - 1;
      history.pushState({ depth: cursor }, "");
      notify();
    },
    replace(e) {
      entries[cursor] = e;
      history.replaceState({ depth: cursor }, "");
      notify();
    },
    back() {
      if (cursor === 0) return; // never navigate off the site
      history.back();
    },
    reset() {
      if (cursor === 0) return;
      history.go(-cursor);
    },
    onExit(view, fn) {
      const list = exits.get(view) ?? [];
      list.push(fn);
      exits.set(view, list);
      return () => {
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
    onChange(fn) {
      changes.push(fn);
      return () => {
        const at = changes.indexOf(fn);
        if (at >= 0) changes.splice(at, 1);
      };
    },
    get stack() {
      return entries.slice(0, cursor + 1);
    },
    get top() {
      return entries[cursor];
    },
    get unwinding() {
      return unwinding;
    },
  };
}
