// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cellToParent, gridDisk, latLngToCell } from "h3-js";
import { aggregate, fireSizes } from "../src/season_filter";
import {
  NO_DAY,
  PLAY_STEP_MS,
  addDays,
  column,
  createSeasonPlayback,
  ndayFor,
  precompute,
  type PlaybackFrame,
} from "../src/season_playback";
import { emitUi, uiSubscriberCount } from "../src/ui_events";
import type { SeasonCells } from "../src/types";

const entry = (cells: string[], first: string) => ({ digest: "d", first, cells });

// Two res-6 neighbourhoods, fires spread over a fortnight, deliberately
// enumerated out of date order. `late` re-burns ground `early` already
// claimed (the union must count it once, from `early`'s day), `nested` holds
// a coarse cell and its own child (dedup inside the fire), and `foreign`
// shares a cell with `eu` so a scope can split a cell's claimants. A cell's
// day is the MIN over its claimants whichever order they are enumerated in.
const a = latLngToCell(45.0, 5.0, 8);
const b = latLngToCell(45.0, 5.02, 8);
const far = latLngToCell(52.0, 13.0, 8);
const other = latLngToCell(40.0, -4.0, 8);
const PLAY_CELLS: SeasonCells = {
  late: entry([a, b], "2026-07-09"),
  early: entry([a], "2026-07-01"),
  big: entry([...gridDisk(far, 1)], "2026-07-05"),
  nested: entry([cellToParent(other, 7), other], "2026-07-03"),
  eu: entry([latLngToCell(40.1, -4.1, 8)], "2026-07-12"),
  foreign: entry([latLngToCell(40.1, -4.1, 8), latLngToCell(40.2, -4.2, 8)], "2026-07-02"),
  // Enumerated AFTER `late` but detected later still: b must keep `late`'s day.
  rekindle: entry([b], "2026-07-13"),
};
const PLAY_SIZES = fireSizes(PLAY_CELLS);
const EU = new Set(["late", "early", "nested", "eu", "rekindle"]);
const keepEu = (id: string) => EU.has(id);

describe("addDays", () => {
  it("steps UTC calendar days across month ends", () => {
    expect(addDays("2026-07-30", 3)).toBe("2026-08-02");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30"); // DST change in Europe, not in UTC
    expect(addDays("2026-07-01", 0)).toBe("2026-07-01");
  });
});

describe("precompute", () => {
  const sel = (threshold = 0, keep?: (id: string) => boolean, scope: "all" | "eu" = "all") => ({
    cells: PLAY_CELLS, sizes: PLAY_SIZES, threshold, keep, scope,
  });

  it("runs one day per step from the selection's floor to the end date", () => {
    const p = precompute(sel(), "2026-07-20")!;
    expect(p.days[0]).toBe("2026-07-01");
    expect(p.days.at(-1)).toBe("2026-07-20");
    expect(p.days).toHaveLength(20);
  });

  it("the floor follows the selection, not the file", () => {
    // `early` (07-01) and `foreign` (07-02) are gone under a scope that drops foreign
    const p = precompute(sel(0, (id) => id !== "early" && id !== "foreign"), "2026-07-20")!;
    expect(p.days[0]).toBe("2026-07-03");
  });

  it("an end date before the last fire is extended to reach it", () => {
    const p = precompute(sel(), "2026-07-05")!;
    expect(p.days.at(-1)).toBe("2026-07-13");
  });

  it("is null when nothing qualifies", () => {
    expect(precompute(sel(1e9), "2026-07-20")).toBeNull();
  });

  // The contract: column d IS the season as it stood that day, byte for byte
  // what aggregate() says with until = that date — for every selection.
  for (const [name, s] of [
    ["all sizes", sel()],
    ["≥ threshold", sel(PLAY_SIZES.get("late")!)],
    ["EU-27", sel(0, keepEu, "eu")],
  ] as const) {
    it(`${name}: every column, count and km² equal aggregate(until = that day)`, () => {
      const p = precompute(s, "2026-07-14")!;
      for (let d = 0; d < p.days.length; d += 1) {
        const ref = aggregate(s.cells, s.sizes, s.threshold, s.keep, s.scope, p.days[d]);
        expect(column(p, d), `r6 on ${p.days[d]}`).toEqual(ref.r6);
        expect(p.fires[d], `fires on ${p.days[d]}`).toBe(ref.fires);
        expect(p.km2[d], `km2 on ${p.days[d]}`).toBe(ref.km2);
      }
    });

    it(`${name}: the last column is the full aggregate`, () => {
      const p = precompute(s, "2026-07-14")!;
      const full = aggregate(s.cells, s.sizes, s.threshold, s.keep, s.scope);
      const last = p.days.length - 1;
      expect(column(p, last)).toEqual(full.r6);
      expect(p.fires[last]).toBe(full.fires);
      expect(p.km2[last]).toBe(full.km2);
    });
  }

  it("the columns really grow (the fixture is not trivially flat)", () => {
    const p = precompute(sel(), "2026-07-14")!;
    expect(column(p, 0)).toHaveLength(1);
    expect(p.fires[0]).toBe(1);
    expect(p.km2[p.days.length - 1]).toBeGreaterThan(p.km2[0]);
  });
});

describe("ndayFor", () => {
  it("is minus the fire's day index for a qualifying fire, NO_DAY otherwise", () => {
    const p = precompute({ cells: PLAY_CELLS, sizes: PLAY_SIZES, threshold: 0, keep: keepEu, scope: "eu" }, "2026-07-14")!;
    expect(p.days[0]).toBe("2026-07-01");
    expect(ndayFor(p, "early")).toBe(0);
    expect(ndayFor(p, "late")).toBe(-8);
    expect(ndayFor(p, "foreign")).toBe(NO_DAY);
    expect(ndayFor(p, "nope")).toBe(NO_DAY);
    expect(ndayFor(null, "early")).toBe(NO_DAY);
  });
});

// ---------------------------------------------------------------------------
// The controller. Its selection is a plain object the test mutates, standing
// in for the size filter's; the map side is three recorded callbacks.

/** A four-fire season over five days (07-01 … 07-05), end date 07-05. */
const c1 = latLngToCell(45.0, 5.0, 8);
const c2 = latLngToCell(46.0, 6.0, 8);
const c3 = latLngToCell(47.0, 7.0, 8);
const CTRL_CELLS: SeasonCells = {
  f1: entry([c1], "2026-07-01"),
  f2: entry([c2], "2026-07-02"),
  f3: entry([c3], "2026-07-04"),
  f4: entry([c1, c3], "2026-07-05"),
};
const CTRL_SIZES = fireSizes(CTRL_CELLS);
const END = "2026-07-05"; // 5 days → indices 0…4

/** Lets queued promise callbacks (ensureCells, the precompute) run. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function harness(over: Partial<Parameters<typeof createSeasonPlayback>[0]> = {}) {
  const state = {
    ready: true,
    cells: CTRL_CELLS as SeasonCells | null,
    threshold: 0,
    keep: undefined as ((id: string) => boolean) | undefined,
    scope: "all" as "all" | "eu",
  };
  const frames: PlaybackFrame[] = [];
  const restores: number[] = [];
  const log: string[] = [];
  const ensureCells = vi.fn(async () => {});
  const onPrepared = vi.fn(() => { log.push("prepared"); });
  const onStatus = vi.fn();
  const pb = createSeasonPlayback({
    selection: () => (state.ready
      ? { cells: state.cells, sizes: CTRL_SIZES, threshold: state.threshold, keep: state.keep, scope: state.scope }
      : null),
    ensureCells,
    end: END,
    onPrepared,
    onFrame: (f) => { frames.push(f); log.push(`frame ${f.day}`); },
    onRestore: () => { restores.push(frames.length); log.push("restore"); },
    onStatus,
    defer: (fn) => fn(),
    ...over,
  });
  const el = document.createElement("div");
  document.body.appendChild(el);
  pb.control(el);
  const q = (root: HTMLElement = el) => ({
    play: root.querySelector<HTMLButtonElement>(".scrub-play")!,
    range: root.querySelector<HTMLInputElement>(".scrub-range")!,
    label: root.querySelector<HTMLElement>(".scrub-label")!,
  });
  return { pb, el, q, state, frames, restores, log, ensureCells, onPrepared, onStatus };
}

const days = (frames: PlaybackFrame[]) => frames.map((f) => f.day);

describe("createSeasonPlayback", () => {
  let destroy: (() => void) | null = null;
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });
  afterEach(() => {
    destroy?.();
    destroy = null;
    vi.useRealTimers();
  });
  const make = (over?: Parameters<typeof harness>[0]) => {
    const h = harness(over);
    destroy = h.pb.destroy;
    return h;
  };

  it("is disabled until the selection is ready, and paint() picks readiness up", () => {
    const h = make();
    h.state.ready = false;
    h.pb.paint();
    expect(h.q().play.disabled).toBe(true);
    h.q().play.click();
    expect(h.ensureCells).not.toHaveBeenCalled();
    h.state.ready = true;
    h.pb.paint();
    expect(h.q().play.disabled).toBe(false);
  });

  it("play fetches the cells, precomputes, emits day 0 and then one day per step", async () => {
    const h = make();
    h.q().play.click();
    expect(h.ensureCells).toHaveBeenCalledTimes(1);
    await settle();
    expect(days(h.frames)).toEqual([0]);
    expect(h.pb.playing).toBe(true);
    vi.advanceTimersByTime(PLAY_STEP_MS);
    expect(days(h.frames)).toEqual([0, 1]);
    vi.advanceTimersByTime(PLAY_STEP_MS);
    expect(days(h.frames)).toEqual([0, 1, 2]);
    // each frame is that day's column
    const p = precompute({ cells: CTRL_CELLS, sizes: CTRL_SIZES, threshold: 0, scope: "all" }, END)!;
    expect(h.frames[2].r6).toEqual(column(p, 2));
    expect(h.frames[2].date).toBe("2026-07-03");
    expect(h.frames[2].fires).toBe(2);
  });

  it("re-tags the cells once, after the precompute and before the first frame", async () => {
    const h = make();
    h.q().play.click();
    await settle();
    expect(h.log.slice(0, 2)).toEqual(["prepared", "frame 0"]);
    expect(h.pb.nday("f3")).toBe(-3);
    vi.advanceTimersByTime(PLAY_STEP_MS * 2);
    expect(h.onPrepared).toHaveBeenCalledTimes(1);
  });

  it("does not loop: the last day restores the full aggregate and stops", async () => {
    const h = make();
    h.q().play.click();
    await settle();
    vi.advanceTimersByTime(PLAY_STEP_MS * 20);
    // days 0…3 are frames; reaching day 4 (the last) IS the full aggregate
    expect(days(h.frames)).toEqual([0, 1, 2, 3]);
    expect(h.restores).toEqual([4]);
    expect(h.pb.playing).toBe(false);
    expect(h.pb.day).toBeNull();
    expect(h.pb.statusText()).toBeNull();
    expect(h.q().range.value).toBe("4");
  });

  it("played again from the end, it starts over at day 0 without re-precomputing", async () => {
    const h = make();
    h.q().play.click();
    await settle();
    vi.advanceTimersByTime(PLAY_STEP_MS * 20);
    h.q().play.click();
    await settle();
    expect(h.frames.at(-1)!.day).toBe(0);
    expect(h.onPrepared).toHaveBeenCalledTimes(1);
  });

  it("the play button pauses at the current day and resumes from it", async () => {
    const h = make();
    h.q().play.click();
    await settle();
    vi.advanceTimersByTime(PLAY_STEP_MS);
    h.q().play.click(); // pause at day 1
    expect(h.pb.playing).toBe(false);
    vi.advanceTimersByTime(PLAY_STEP_MS * 5);
    expect(days(h.frames)).toEqual([0, 1]);
    expect(h.pb.day).toBe(1);
    h.q().play.click();
    await settle();
    vi.advanceTimersByTime(PLAY_STEP_MS);
    expect(days(h.frames)).toEqual([0, 1, 1, 2]);
  });

  it("a hand on the date slider pauses and shows that day", async () => {
    const h = make();
    h.q().play.click();
    await settle();
    const r = h.q().range;
    r.value = "3";
    r.dispatchEvent(new Event("input", { bubbles: true }));
    expect(h.pb.playing).toBe(false);
    expect(h.frames.at(-1)!.day).toBe(3);
    vi.advanceTimersByTime(PLAY_STEP_MS * 5);
    expect(h.frames.at(-1)!.day).toBe(3);
    // dragged to the last day: that is the full aggregate, so restore
    r.value = "4";
    r.dispatchEvent(new Event("input", { bubbles: true }));
    expect(h.restores).toHaveLength(1);
    expect(h.pb.day).toBeNull();
  });

  for (const ev of ["compare:enter", "detail:open"] as const) {
    it(`${ev} pauses and keeps the day (the layer is hidden, not reset)`, async () => {
      const h = make();
      h.q().play.click();
      await settle();
      vi.advanceTimersByTime(PLAY_STEP_MS * 2);
      emitUi(ev);
      expect(h.pb.playing).toBe(false);
      vi.advanceTimersByTime(PLAY_STEP_MS * 5);
      expect(days(h.frames)).toEqual([0, 1, 2]);
      expect(h.pb.day).toBe(2);
      expect(h.restores).toEqual([]);
      expect(h.pb.statusText()).not.toBeNull();
    });
  }

  it("a pause that lands while preparing cancels the start", async () => {
    let release: () => void = () => {};
    const h = make({ ensureCells: () => new Promise<void>((r) => { release = r; }) });
    h.q().play.click();
    expect(h.q().label.textContent).toBe("preparing…");
    emitUi("detail:open");
    release();
    await settle();
    expect(h.frames).toEqual([]);
    expect(h.pb.playing).toBe(false);
  });

  it("a pause that lands between the cells and the deferred precompute cancels it too", async () => {
    let pending: (() => void) | null = null;
    const h = make({ defer: (fn) => { pending = fn; } });
    h.q().play.click();
    await settle();
    expect(pending).not.toBeNull();
    h.q().play.click(); // pause while the precompute is queued
    pending!();
    expect(h.frames).toEqual([]);
    expect(h.onPrepared).not.toHaveBeenCalled(); // no retag for a play nobody wants
    expect(h.pb.playing).toBe(false);
    expect(h.q().label.textContent).not.toBe("preparing…");
  });

  it("a precompute queued for an older selection never installs its columns", async () => {
    const queue: Array<() => void> = [];
    const h = make({ defer: (fn) => { queue.push(fn); } });
    h.q().play.click();
    await settle(); // queue[0]: all sizes
    h.state.threshold = CTRL_SIZES.get("f4")!;
    h.pb.invalidate();
    h.q().play.click();
    await settle(); // queue[1]: only f4
    queue[0](); // the stale one runs first
    queue[1]();
    expect(h.onPrepared).toHaveBeenCalledTimes(1);
    expect(h.frames.map((f) => f.fires)).toEqual([1]);
  });

  it("a stale enabled button does not start a selection that is not ready", () => {
    // `disabled` is presentation and can lag a rebuild; start() is the contract.
    const h = make();
    h.state.ready = false; // no paint(): the button still reads enabled
    expect(h.q().play.disabled).toBe(false);
    h.q().play.click();
    expect(h.ensureCells).not.toHaveBeenCalled();
    expect(h.q().label.textContent).not.toBe("preparing…");
  });

  it("survives a panel rebuild mid-play: same day, still playing, the new DOM drives it", async () => {
    const h = make();
    h.q().play.click();
    await settle();
    vi.advanceTimersByTime(PLAY_STEP_MS * 2);
    const fresh = document.createElement("div");
    document.body.appendChild(fresh);
    h.el.remove();
    h.pb.control(fresh);
    expect(h.pb.playing).toBe(true);
    expect(h.pb.day).toBe(2);
    expect(h.q(fresh).range.value).toBe("2");
    expect(h.q(fresh).play.getAttribute("aria-label")).toBe("Pause the season");
    vi.advanceTimersByTime(PLAY_STEP_MS);
    expect(h.q(fresh).range.value).toBe("3");
    h.q(fresh).play.click();
    expect(h.pb.playing).toBe(false);
  });

  it("a size or scope change pauses, restores the full aggregate and drops the columns", async () => {
    const h = make();
    h.q().play.click();
    await settle();
    vi.advanceTimersByTime(PLAY_STEP_MS);
    h.state.threshold = CTRL_SIZES.get("f4")!; // only f4 left
    h.pb.invalidate();
    expect(h.pb.playing).toBe(false);
    expect(h.pb.day).toBeNull();
    expect(h.restores).toEqual([2]);
    expect(h.pb.statusText()).toBeNull();
    expect(h.pb.nday("f1")).toBe(NO_DAY);
    vi.advanceTimersByTime(PLAY_STEP_MS * 5);
    expect(h.frames).toHaveLength(2);
    // the next play replays the NEW selection
    h.q().play.click();
    await settle();
    expect(h.onPrepared).toHaveBeenCalledTimes(2);
    expect(h.frames.at(-1)!.fires).toBe(1);
    expect(h.frames.at(-1)!.date).toBe("2026-07-05");
  });

  it("an idle invalidate restores nothing (the map already shows the full season)", () => {
    const h = make();
    h.pb.invalidate();
    expect(h.restores).toEqual([]);
  });

  it("waits for the cells when they are still on their way, then plays", async () => {
    const h = make();
    h.state.cells = null;
    h.q().play.click();
    await settle();
    expect(h.frames).toEqual([]);
    expect(h.q().label.textContent).toBe("preparing…");
    h.state.cells = CTRL_CELLS;
    h.pb.dataChanged();
    await settle();
    expect(days(h.frames)).toEqual([0]);
  });

  it("status line and aria-valuetext describe the day on screen, with the scope prefix", async () => {
    const h = make();
    h.state.keep = (id) => id !== "f2";
    h.state.scope = "eu";
    h.q().play.click();
    await settle();
    vi.advanceTimersByTime(PLAY_STEP_MS * 3); // day 3 = 04 Jul: f1 + f3
    const km2 = Math.round(h.frames.at(-1)!.km2).toLocaleString("en-GB");
    expect(h.pb.statusText()).toBe(`EU-27 · up to 4 Jul · 2 fires · ${km2} km² footprint`);
    expect(h.q().range.getAttribute("aria-valuetext")).toBe("up to 4 Jul · 2 fires");
    expect(h.q().label.textContent).toBe("up to 4 Jul");
    // the status line is refreshed with every frame, not once
    expect(h.onStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("destroy unsubscribes from compare:enter and detail:open", () => {
    const before = [uiSubscriberCount("compare:enter"), uiSubscriberCount("detail:open")];
    const h = harness();
    expect(uiSubscriberCount("compare:enter")).toBe(before[0] + 1);
    h.pb.destroy();
    expect([uiSubscriberCount("compare:enter"), uiSubscriberCount("detail:open")]).toEqual(before);
  });
});
