/** @vitest-env jsdom */
import { describe, expect, it, vi } from "vitest";
import { createNav, type Entry } from "../src/nav";
import { fakeHistory } from "./nav_fixtures";

const entry = (view: Entry["view"], title: string, restore?: () => void): Entry => ({
  view,
  title,
  restore,
});

describe("nav stack", () => {
  it("starts at the base entry with depth 0", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    expect(nav.stack).toEqual([{ view: "map", title: "Map" }]);
    expect(nav.top.view).toBe("map");
  });

  it("push grows the stack and records depth in history state", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    nav.push(entry("detail", "Pedrógão"));
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "detail"]);
    expect(history.state).toEqual({ depth: 1 });
  });

  it("replace swaps the top entry without changing depth", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    nav.push(entry("detail", "Pedrógão"));
    nav.replace(entry("detail", "Monchique"));
    expect(nav.stack.map((e) => e.title)).toEqual(["Map", "Monchique"]);
    expect(history.state).toEqual({ depth: 1 });
  });

  it("back() does not mutate the stack directly — only popstate does", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    nav.push(entry("detail", "Pedrógão"));
    const spy = vi.spyOn(history, "back");
    nav.back();
    expect(spy).toHaveBeenCalledOnce();
    expect(nav.stack).toHaveLength(1); // popstate fired synchronously in the fake
  });

  it("back() at the base is a no-op, so it cannot leave the site", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    const spy = vi.spyOn(history, "back");
    nav.back();
    expect(spy).not.toHaveBeenCalled();
  });

  it("reset() unwinds every level in one go", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    nav.push(entry("search", "Search"));
    nav.push(entry("detail", "Pedrógão"));
    nav.push(entry("compare", "Compare"));
    nav.reset();
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]);
  });

  it("calls onExit for every level it unwinds, deepest first", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    const seen: string[] = [];
    nav.onExit("detail", () => seen.push("detail"));
    nav.onExit("compare", () => seen.push("compare"));
    nav.push(entry("detail", "Pedrógão"));
    nav.push(entry("compare", "Compare"));
    nav.reset();
    expect(seen).toEqual(["compare", "detail"]);
  });

  it("sets unwinding across a pop so a re-entrant back() is dropped", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    const flags: boolean[] = [];
    // Mirrors firecard.close(), which emits detail:close and would otherwise
    // drive a second back() from inside the first one's teardown.
    nav.onExit("detail", () => {
      flags.push(nav.unwinding);
      nav.back();
    });
    nav.push(entry("detail", "Pedrógão"));
    nav.back();
    expect(flags).toEqual([true]);
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]); // one pop, not two
  });

  it("runs restore() on the entry that becomes top again", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    const restore = vi.fn();
    nav.push(entry("search", "Search", restore));
    nav.push(entry("detail", "Pedrógão"));
    expect(restore).not.toHaveBeenCalled();
    nav.back();
    expect(restore).toHaveBeenCalledOnce();
  });

  it("makes browser Forward a no-op rather than restoring a gutted view", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    nav.push(entry("detail", "Pedrógão"));
    nav.back();
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]);
    history.go(1); // browser Forward
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]);
    expect(nav.top.view).toBe("map");
  });

  it("resyncs history after an orphaned Forward, so the next Back still works", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    nav.push(entry("layers", "Layers"));
    nav.push(entry("detail", "Pedrógão"));
    nav.back(); // → layers
    history.go(1); // Forward into the truncated tail; nav undoes it
    // History and stack agree again: one Back leaves layers for the map.
    nav.back();
    expect(nav.stack.map((e) => e.view)).toEqual(["map"]);
  });

  it("truncates the forward tail when a new push follows a back", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    nav.push(entry("detail", "Pedrógão"));
    nav.back();
    nav.push(entry("layers", "Layers"));
    expect(nav.stack.map((e) => e.view)).toEqual(["map", "layers"]);
  });

  it("notifies onChange subscribers on push and on pop", () => {
    const { history, target } = fakeHistory();
    const nav = createNav({ history, target });
    const seen: number[] = [];
    nav.onChange((s) => seen.push(s.length));
    nav.push(entry("detail", "Pedrógão"));
    nav.back();
    expect(seen).toEqual([2, 1]);
  });

  it("rewinds a stale depth left in history state by a reload", () => {
    const { history, target } = fakeHistory();
    history.pushState({ depth: 1 }, "");
    history.pushState({ depth: 2 }, "");
    const spy = vi.spyOn(history, "go");
    createNav({ history, target });
    expect(spy).toHaveBeenCalledWith(-2);
  });
});
