/**
 * The view stack.
 *
 * One rule holds this together, and it is asymmetric: going FORWARD is direct
 * — `push()` appends an entry and moves the cursor itself, then tells the
 * browser — but going BACK happens only through `popstate`. `back()` and
 * `reset()` do not touch the cursor; they ask the browser to navigate and
 * return, and the stack shortens when the browser says so. That is what makes
 * a tap on "‹", the Escape key, and Android's back gesture the same operation
 * instead of three implementations that drift apart. A forward push has no
 * such rival entry points, so it has nothing to converge with.
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
 * with `history.go(cursor - depth)`, correcting however far the forward jump
 * reached and leaving the button visibly inert and the history index back in
 * step with the stack. Without that resync the index would sit ahead, and the
 * next Back would appear dead — the exact complaint this module exists to fix.
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

  const goTo = (depth: number) => {
    if (depth > cursor) {
      // Forward into a tail this stack truncated. Nothing to restore, so undo
      // the navigation rather than leaving the history index ahead of the
      // stack — which would make the next Back look dead.
      //
      // go(cursor - depth), not back(): a forward-menu jump can cross several
      // entries at once, and a single back() would return only one of them,
      // leaving history.state.depth disagreeing with the cursor. Every entry
      // we pushed recorded its own index as `depth`, so landing on index
      // `cursor` yields a popstate whose depth EQUALS the cursor — caught by
      // the `wanted === cursor` early return below. That self-cancelling
      // property is why no re-entrancy flag is needed here.
      history.go(cursor - depth);
      return;
    }
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
  // Ensure the base entry has its depth recorded, so when a forward resync
  // lands at index 0, history.state.depth equals the cursor.
  if (cursor === 0 && typeof booted?.depth !== "number") {
    history.replaceState({ depth: 0 }, "");
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
      // `unwinding` first, and NOT merely `cursor === 0`: cursor is not
      // assigned until after goTo has run its exit callbacks, so a teardown
      // that calls back() — which firecard.close() effectively does, by
      // emitting detail:close — still sees the pre-pop depth. Guarding on
      // cursor alone only stops the re-entrant call when the stack happened
      // to be exactly one deep; from [map, search, detail] it lets a nested
      // pop run to completion, and the outer pop then re-grows `entries` over
      // the shorter array, leaving a hole that throws on the next restore().
      if (unwinding || cursor === 0) return; // never navigate off the site
      history.back();
    },
    reset() {
      if (unwinding || cursor === 0) return;
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
