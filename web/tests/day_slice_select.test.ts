import { describe, expect, it } from "vitest";
import { createDaySliceSelector } from "../src/day_slice_select";
import type { TimelineDay } from "../src/types";

const day = (date: string): TimelineDay => ({ date, count: 1, frp: 1 });

/** A resolver we control by hand, so a test can decide the exact order two
 * loads settle in — the whole point of the race this module guards against. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("day slice selector", () => {
  it("does not paint a selection superseded before its load resolves", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<[string, number][]>>>();
    const painted: [string, number][][] = [];
    const dates = new Set(["2026-07-01", "2026-07-02"]);
    const sel = createDaySliceSelector(
      dates,
      (date) => {
        const d = deferred<[string, number][]>();
        pending.set(date, d);
        return d.promise;
      },
      (cells) => painted.push(cells),
      () => {},
    );

    // Simulate a drag crossing two bins in a fraction of a second: bin 1
    // fires first (larger payload, slower to resolve) then bin 2 fires before
    // bin 1's fetch has come back.
    const p1 = sel.onSelect(day("2026-07-01"), 0);
    const p2 = sel.onSelect(day("2026-07-02"), 1);

    // Resolve OUT OF ORDER: the older request (bin 1) lands last, exactly the
    // scenario a bare await/paint gets wrong.
    pending.get("2026-07-02")!.resolve([["cellB", 2]]);
    pending.get("2026-07-01")!.resolve([["cellA", 1]]);
    await Promise.all([p1, p2]);

    // Only the latest selection's cells may ever reach the map.
    expect(painted).toEqual([[["cellB", 2]]]);
  });

  it("does not let a stale in-flight load re-show after a later click hides it", async () => {
    // Consequence 2 from the finding: a bin with no slice takes the hide
    // branch, and an older in-flight response must not be able to undo that
    // hide once it finally arrives.
    const pending = new Map<string, ReturnType<typeof deferred<[string, number][]>>>();
    const painted: [string, number][][] = [];
    const hides: number[] = [];
    const dates = new Set(["2026-07-01"]); // 07-02 has no slice
    const sel = createDaySliceSelector(
      dates,
      (date) => {
        const d = deferred<[string, number][]>();
        pending.set(date, d);
        return d.promise;
      },
      (cells) => painted.push(cells),
      () => hides.push(1),
    );

    const p1 = sel.onSelect(day("2026-07-01"), 0); // valid day, load in flight
    const p2 = sel.onSelect(day("2026-07-02"), 1); // no slice: hides synchronously
    expect(hides).toEqual([1]);

    // The older, still-in-flight request for 07-01 now resolves.
    pending.get("2026-07-01")!.resolve([["cellA", 1]]);
    await Promise.all([p1, p2]);

    expect(painted).toEqual([]); // must not repaint over the hide
  });

  it("invalidate() disarms an in-flight load so it cannot paint afterwards", async () => {
    // Mirrors a fire card opening mid-drag: onEnter calls invalidate()
    // directly, without going through onSelect.
    const pending = new Map<string, ReturnType<typeof deferred<[string, number][]>>>();
    const painted: [string, number][][] = [];
    const hides: number[] = [];
    const dates = new Set(["2026-07-01"]);
    const sel = createDaySliceSelector(
      dates,
      (date) => {
        const d = deferred<[string, number][]>();
        pending.set(date, d);
        return d.promise;
      },
      (cells) => painted.push(cells),
      () => hides.push(1),
    );

    const p1 = sel.onSelect(day("2026-07-01"), 0);
    sel.invalidate();
    expect(hides).toEqual([1]);

    pending.get("2026-07-01")!.resolve([["cellA", 1]]);
    await p1;

    expect(painted).toEqual([]);
    expect(sel.shownDay).toBeNull();
  });

  it("clicking the shown day again hides and clears the selection", async () => {
    const sel = createDaySliceSelector(
      new Set(["2026-07-01"]),
      async () => [["cellA", 1]],
      () => {},
      () => {},
    );
    await sel.onSelect(day("2026-07-01"), 0);
    expect(sel.shownDay).toBe("2026-07-01");
    await sel.onSelect(day("2026-07-01"), 0);
    expect(sel.shownDay).toBeNull();
  });
});
