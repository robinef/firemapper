/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createNav } from "../src/nav";
import { createShell } from "../src/shell";
import { emitUi } from "../src/ui_events";
import { fakeHistory, mountShellDom } from "./nav_fixtures";

window.URL.createObjectURL ??= () => "";
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () =>
  ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as
    unknown as MediaQueryList;

// SCOPE NOTE — read before trusting this file as a regression gate.
//
// These two tests drive nav and shell directly with a locally-registered
// onExit stub; they never import main.ts or run boot(). So they pin the
// unwind CONTRACT (one teardown per pop, no double-pop, history left in
// step) but NOT main.ts's use of it. Reverting main.ts's background-tap
// `nav.back()` to a direct `fireCard.close()`, or deleting the day-slice
// `emitUi("detail:open")`, would leave every assertion here green.
//
// main.ts wiring is verified by the manual browser checklist in the plan
// (hardware back exiting compare -> card -> map -> site), because boot()
// constructs a real MapLibre map at import time and the click handler
// cannot be driven under jsdom without machinery larger than the code it
// would test. The third describe block below IS a real regression guard:
// it asserts against renderFireList's actual output.
describe("nav/shell unwind contract (not main.ts wiring — see note)", () => {
  it("nav.back() tears the card down and does not bounce past the map", () => {
    mountShellDom();
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    createShell({ nav });
    const close = vi.fn(() => {
      // What firecard.close() really does: hide the panel, then announce.
      document.getElementById("panel")!.classList.add("hidden");
      emitUi("detail:close");
    });
    nav.onExit("detail", close);

    document.getElementById("panel")!.innerHTML = `<div class="fc-title">Pedrógão</div>`;
    document.getElementById("panel")!.classList.remove("hidden");
    emitUi("detail:open");
    expect(nav.stack).toHaveLength(2);

    nav.back(); // the background tap, the ‹ button, Escape, or hardware back
    expect(close).toHaveBeenCalledOnce();
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]);
  });

  it("a card closed by its own ✕ still leaves the history in step", () => {
    mountShellDom();
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    createShell({ nav });
    nav.onExit("detail", () => emitUi("detail:close"));

    document.getElementById("panel")!.innerHTML = `<div class="fc-title">Pedrógão</div>`;
    emitUi("detail:open");
    emitUi("detail:close"); // the card's own close button path
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]);
    // And the next back must not silently leave the site.
    const spy = vi.spyOn(history, "back");
    nav.back();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("search has exactly one way out, and it is the stack", () => {
  it("renders no close button of its own", async () => {
    const { renderFireList } = await import("../src/firelist");
    const html = renderFireList([], "", 0);
    // A .panel-close here would hide #panel and emit detail:close while the
    // stack still says "search" — a full-page view with nothing in it.
    expect(html).not.toContain("panel-close");
  });
});
