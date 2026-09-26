/**
 * All chrome that is not a view: the icon rail, the #view container's state,
 * the back bars, the one Escape handler, and the map's camera padding.
 *
 * The shell is the ONLY module that both subscribes to ui_events and talks to
 * nav. Views keep announcing what they did on the bus, exactly as they did when
 * the mobile sheet was listening, and never learn that a stack exists.
 */

import { escapeHtml } from "./escape";
import type { Nav, ViewId } from "./nav";
import { onUi } from "./ui_events";

export interface ShellDeps {
  nav: Nav;
  showFireList?: (query: string) => void;
  lastQuery?: () => string;
  infoContent?: () => string;
  showHistoricalLookup?: () => void;
}

export interface Shell {
  /** Boot finished and the layer registry is mounted — the rail may be used. */
  ready(): void;
  destroy(): void;
}

export function createShell(deps: ShellDeps): Shell {
  const { nav } = deps;
  const view = document.getElementById("view");
  const bar = document.getElementById("view-bar");
  const rail = document.getElementById("rail");
  const offs: Array<() => void> = [];

  const compareBar = document.getElementById("compare-bar");

  /** --timebar is what the rail and the peeked card sit above. A constant is
   *  wrong the moment #timeline's content changes height — the fire card swaps
   *  its own series in, with a title that wraps differently from the overview's
   *  — so measure the real element instead of guessing. */
  const timelineEl = document.getElementById("timeline");
  const syncTimebar = () => {
    if (!timelineEl) return;
    const h = Math.round(timelineEl.getBoundingClientRect().height);
    // jsdom reports 0 for every box; leaving the CSS fallback in place there is
    // correct, and writing 12px would be a lie the tests would then encode.
    if (h > 0) document.documentElement.style.setProperty("--timebar", `${h + 12}px`);
  };
  if (typeof ResizeObserver !== "undefined" && timelineEl) {
    const observer = new ResizeObserver(syncTimebar);
    observer.observe(timelineEl);
    offs.push(() => observer.disconnect());
  }
  syncTimebar();

  /** Fire cards open peeked: the map, and the fire's own histogram scrubbing,
   *  stay visible. Tapping the strip commits to the full card.
   *
   *  Closure state, deliberately NOT per-entry: sync() re-applies it on every
   *  stack change, so a card keeps its size across a round trip through the
   *  layers view without any per-entry restore thunk. openDetail recomputes it
   *  per panel, so a newly opened card never inherits the previous card's size.
   *  Declared here (before `sync`, not after `openDetail`) so `sync`'s first
   *  synchronous call below can read it without a temporal-dead-zone crash. */
  let detailSize: "peek" | "full" = "peek";

  /** #view and <body> must agree: rules for #rail and #view-chip key off the
   *  body attribute, because those two sit outside #view — see sync() for why
   *  a sibling combinator is not a safe substitute for either. Anything that
   *  changes the size goes through here so neither half can drift.
   *  Declared here, ahead of `setSize` below, for the same temporal-dead-zone
   *  reason as `detailSize`: `sync`'s first synchronous call (right after its
   *  own definition) already calls this. */
  const applySize = (size: "peek" | "full") => {
    view?.setAttribute("data-size", size);
    document.body.dataset.size = size;
  };

  /* The desktop slide-out used to push the camera 376px right (rail + panel)
     so it sat beside the map rather than on it. It read as the map jumping
     sideways every time a panel opened, which is a bigger cost than the strip
     of map the panel covers — and the panel's right edge (388px) is still
     clear of a centred feature (640px at 1280 wide), so nothing a fly-to
     targets ends up underneath it. The panel now overlays. */

  const renderBar = (stack: readonly (typeof nav.top)[]) => {
    const depth = stack.length - 1;
    const current = stack[depth];
    // Compare hides #view entirely (it is the bare map plus a swipe divider),
    // so its chrome renders into a top-level element instead — a bar inside
    // #view would be hidden along with it, leaving compare with no way out.
    const target = current.view === "compare" ? compareBar : bar;
    // Clear whichever bar is not in use, so a stale one never lingers.
    for (const el of [bar, compareBar]) if (el && el !== target) el.innerHTML = "";
    if (!target) return;
    if (depth === 0) {
      target.innerHTML = "";
      return;
    }
    // A back bar names its DESTINATION, so it takes the title of the entry
    // beneath the current one — which is how compare's bar reads the fire's
    // name while the fire card's own reads "Map".
    const under = stack[depth - 1];
    const close =
      current.view === "compare"
        ? `<button class="view-close" type="button" aria-label="Close, back to the map">✕</button>`
        : "";
    target.innerHTML =
      // Titles come from feature properties (place names) and land in
      // innerHTML, so they are escaped for the same reason panel.ts escapes
      // GeoNames output.
      `<button class="view-back" type="button">‹ ${escapeHtml(under.title)}</button>` +
      close;
    target.querySelector<HTMLButtonElement>(".view-back")?.addEventListener("click", () =>
      nav.back(),
    );
    target.querySelector<HTMLButtonElement>(".view-close")?.addEventListener("click", () =>
      nav.reset(),
    );
  };

  /** A fire stays selected under ⚙ and ℹ — its outline, its histogram and
   *  its level-2 layers are all still on the map — but the panel in front of
   *  it says nothing about that, so the reader can browse level-1 menus
   *  without knowing a fire is still in play. The pill names the fire and
   *  offers the two ways out of that state. Only for a fire DIRECTLY beneath
   *  a rail view: openRail keeps it that way (see there), and compare's own
   *  bar already names the fire. */
  const firePill = document.getElementById("fire-pill");
  const renderFirePill = (stack: readonly (typeof nav.top)[]) => {
    if (!firePill) return;
    const top = stack[stack.length - 1];
    const under = stack[stack.length - 2];
    const show = under?.view === "detail" && (top.view === "layers" || top.view === "info");
    firePill.hidden = !show;
    firePill.innerHTML = show
      ? // The title is a place name from feature properties: escaped, as in renderBar.
        `<span class="fp-text">Selected: <b>${escapeHtml(under.title)}</b></span>` +
        `<button class="fp-show" type="button">Show</button>` +
        `<button class="fp-close" type="button" aria-label="Close this fire">✕</button>`
      : "";
  };
  const onPillClick = (e: Event) => {
    const btn = (e.target as HTMLElement)?.closest("button");
    if (!btn || !firePill) return;
    // Gone at once, not on the next sync: the pop lands on a later popstate,
    // and a second tap before it would compute its target from a stale stack
    // (a double ✕ overshoots, from a shallow stack right off the site).
    firePill.hidden = true;
    firePill.innerHTML = "";
    // Show: the fire is the entry directly beneath. ✕: unwind the fire too,
    // landing on whatever it was opened from (the map, or search results).
    if (btn.classList.contains("fp-show")) nav.back();
    else if (btn.classList.contains("fp-close")) nav.backTo(nav.stack.length - 3);
  };
  firePill?.addEventListener("click", onPillClick);
  offs.push(() => firePill?.removeEventListener("click", onPillClick));

  const sync = (stack: readonly (typeof nav.top)[]) => {
    const current = stack[stack.length - 1];
    view?.setAttribute("data-view", current.view);
    if (current.view === "detail") {
      applySize(detailSize);
    } else {
      view?.removeAttribute("data-size");
      delete document.body.dataset.size;
    }
    // Mirrored onto <body> as well as #view, because the rail and the peek
    // chip live OUTSIDE #view. `~` is not an option for #rail at all: it
    // precedes #view in the document, and a subsequent-sibling combinator only
    // matches what follows. #view-chip does follow #view, so `~` would reach
    // it — but keying one on the body and the other on a combinator would make
    // the two rules fail for different reasons, and the chip's would break
    // silently the day someone reorders index.html. Both key off the body, so
    // neither depends on document order.
    document.body.dataset.view = current.view;
    if (current.view !== "compare") document.body.classList.remove("compare-mode");
    renderBar(stack);
    renderFirePill(stack);
    // Every view change can change what #timeline shows (a fire card swaps in
    // its own title/series), so the measured --timebar can go stale here too.
    syncTimebar();
  };

  offs.push(nav.onChange(sync));
  sync(nav.stack);

  /** Push a detail entry, or replace the top when returning to it would serve
   *  no purpose. `search` is on the push side because backing out of a fire to
   *  the result list you picked it from is worth a stack level — that is what
   *  Entry.restore exists for. `layers` and `info` are on the replace side:
   *  nothing is gained by returning to a toggle list after opening a fire.
   *  `layers` matters only on desktop, where the slide-out leaves the map
   *  clickable beside it. */
  const openDetail = () => {
    const title =
      document.querySelector("#panel .fc-title")?.textContent?.trim() || "Fire";
    // Peek is a contract, not a default: at that size the mobile CSS hides the
    // back bar and every #panel child except `.fc-peek`, so a panel that never
    // renders a strip — the cell picker, an FRP or wind panel — would collapse
    // into an empty 56px band with no back bar, no ✕ and nothing to tap to
    // expand. Only fireCardHtml and scarCardHtml emit one. Ask the DOM rather
    // than assume, so the layout can only be applied to a panel that survives
    // it, and a future renderer cannot silently opt into a broken size.
    detailSize = document.querySelector("#panel .fc-peek") ? "peek" : "full";
    const entry = {
      view: "detail" as const,
      title,
      // No `restore` needed: sync()'s detail branch re-applies applySize(detailSize)
      // unconditionally on every stack change, so a thunk here would only write
      // the same value a moment before sync writes it again. The size survives a
      // round trip through another view because detailSize is closure state, not
      // per-entry state.
    };
    const top = nav.top.view;
    if (top === "map" || top === "search") nav.push(entry);
    else nav.replace(entry);
  };

  const setSize = (size: "peek" | "full") => {
    detailSize = size;
    if (nav.top.view !== "detail") return;
    applySize(size);
  };
  const onPeekClick = (e: Event) => {
    if ((e.target as HTMLElement)?.closest(".fc-peek")) setSize("full");
  };
  document.getElementById("panel")?.addEventListener("click", onPeekClick);
  offs.push(() =>
    document.getElementById("panel")?.removeEventListener("click", onPeekClick),
  );

  offs.push(
    // Every #panel content routes through this one event. There was a second,
    // aircraft:open, for taps that reused #panel without going through the
    // fire card; the aircraft layer was retired and the event went with it.
    // The rule it existed to express still holds — same view, same entry.
    onUi("detail:open", openDetail),
    onUi("detail:close", () => {
      // Dropped while nav is tearing down: firecard.close() emits this from
      // inside nav's own exit callback, and acting on it there would pop a
      // second level. This is the guard that keeps hardware-back landing one
      // level up instead of two.
      if (nav.unwinding) return;
      if (nav.top.view === "detail") nav.back();
    }),
    onUi("compare:enter", () => {
      document.body.classList.add("compare-mode");
      nav.push({ view: "compare", title: "Compare" });
    }),
    onUi("compare:exit", () => {
      document.body.classList.remove("compare-mode");
      if (nav.unwinding) return;
      if (nav.top.view === "compare") nav.back();
    }),
  );

  /** Open a rail view. Re-tapping the icon of the view you are already on is a
   *  no-op rather than a second identical entry, so back does not need two
   *  presses to undo one deliberate action. */
  /** Set while a rail tap waits for the fire's pop to land. Expires, like
   *  nav's own pending window, so a swallowed popstate cannot leave the rail
   *  dead — or a stale listener to open a view on some later, unrelated
   *  stack change. */
  let closingFireUntil = 0;
  const openRail = (view: ViewId, title: string, enter?: () => void) => {
    if (performance.now() < closingFireUntil) return; // the fire's pop is still in flight
    // The icon is a toggle: tapping the one you are already on closes it.
    // It used to be a no-op, which left the icon looking like a dead control
    // and made the back bar the only way out of a panel the same icon had
    // just opened. nav.back() rather than a direct pop, so closing this way
    // is the same single operation as `‹`, Escape and hardware back.
    if (nav.top.view === view) {
      nav.back();
      return;
    }
    // Search and the historical lookup render into #panel, which is the fire
    // card's own element. Stacked over a fire they overwrote its card, and
    // backing out landed on a "detail" entry showing the search list. They
    // are ways to find ANOTHER fire, so they close this one first. The pop is
    // asynchronous (nav only moves on popstate), hence the one-shot listener.
    const fireAt = nav.stack.findIndex((e) => e.view === "detail");
    if (fireAt > 0 && (view === "search" || view === "historical")) {
      closingFireUntil = performance.now() + 1000;
      const off = nav.onChange((stack) => {
        off();
        const late = performance.now() >= closingFireUntil;
        closingFireUntil = 0;
        if (late || stack.some((e) => e.view === "detail")) return;
        // Opened from search: popping the fire already restored the results.
        if (nav.top.view === view) return;
        enter?.();
        nav.push({ view, title, restore: enter });
      });
      nav.backTo(fireAt - 1);
      return;
    }
    enter?.();
    // ⚙ ↔ ℹ over a fire swap in place, so the fire stays directly beneath:
    // the back bar then names it, and the fire pill can reach it in one pop.
    const under = nav.stack[nav.stack.length - 2];
    const railOverFire =
      under?.view === "detail" && (nav.top.view === "layers" || nav.top.view === "info");
    if (railOverFire) nav.replace({ view, title, restore: enter });
    else nav.push({ view, title, restore: enter });
  };
  const bindRail = (id: string, view: ViewId, title: string, enter?: () => void) => {
    const el = document.getElementById(id);
    if (!el) return;
    const handler = () => openRail(view, title, enter);
    el.addEventListener("click", handler);
    offs.push(() => el.removeEventListener("click", handler));
  };
  bindRail("rail-layers", "layers", "Layers");
  // restore repaints the list when search becomes top again after a fire was
  // opened from it — #panel is shared with detail, so without this the list
  // comes back empty and backing out of a fire reads as an overshoot.
  bindRail("rail-search", "search", "Search", () =>
    deps.showFireList?.(nav.top.view === "search" ? (deps.lastQuery?.() ?? "") : ""),
  );
  bindRail("rail-info", "info", "Data & sources", () => {
    const el = document.getElementById("info");
    if (el && deps.infoContent) el.innerHTML = deps.infoContent();
  });
  bindRail("rail-historical", "historical", "Find a past fire", () => deps.showHistoricalLookup?.());

  const chip = document.getElementById("view-chip");
  const onChip = () => nav.reset();
  chip?.addEventListener("click", onChip);
  offs.push(() => chip?.removeEventListener("click", onChip));

  // The one Escape handler. firecard.ts and setupCompareMode each added their
  // own, neither removed it, and compare's fired exit() even when nothing was
  // being compared.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") nav.back();
  };
  window.addEventListener("keydown", onKey);
  offs.push(() => window.removeEventListener("keydown", onKey));

  return {
    ready() {
      rail?.classList.remove("hidden");
    },
    destroy() {
      for (const off of offs.splice(0)) off();
    },
  };
}
