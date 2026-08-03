import type { ScrubCause } from "./scrubber";
import type { TimelineDay } from "./types";

export interface DaySliceSelector {
  /** Bind directly as the overview timeline's `onSelect`. */
  onSelect: (day: TimelineDay, i: number, cause?: ScrubCause) => Promise<void>;
  /** Clear the current selection and disarm any in-flight load, without going
   *  through onSelect — used when something OTHER than a day click needs the
   *  overview state gone (e.g. a fire card opening over it). */
  invalidate: () => void;
  readonly shownDay: string | null;
}

/**
 * Owns the overview day-slice selection and the token that keeps it correct
 * under the scrubber's call rate. Before the scrubber, `onSelect` fired at
 * most once per deliberate click, so a bare `await load(); paint()` was safe
 * enough — nothing else could still be in flight. Dragging the overview slider
 * now fires it once per bin crossed (tens of requests in a fraction of a
 * second, of differing payload size) and playback fires it every 450 ms, so
 * responses routinely land out of order. A monotonic token captured before
 * each load and checked after it is what makes only the LATEST selection
 * allowed to paint or hide, regardless of which fetch finishes last.
 */
export function createDaySliceSelector(
  dayDates: ReadonlySet<string>,
  load: (date: string) => Promise<[string, number][]>,
  paint: (cells: [string, number][]) => void,
  hide: () => void,
): DaySliceSelector {
  let token = 0;
  let shownDay: string | null = null;

  const invalidate = () => {
    token++; // any load already in flight is now superseded
    hide();
    shownDay = null;
  };

  const onSelect = async (d: TimelineDay, _i: number, cause: ScrubCause = "select"): Promise<void> => {
    // Bump on every call, including the two hide branches below: that is what
    // stops an OLDER in-flight load (from a bin the drag already passed) from
    // resolving after this one and re-painting or re-showing over it.
    const mine = ++token;
    if (shownDay === d.date) {
      // Re-picking the shown day is a toggle-off ONLY when it's a deliberate
      // selection. Playback landing back on this bin (e.g. click it, click it
      // again to hide it, then press Play) must always mean "show this bin" —
      // there's no such thing as the user "clicking" a bin via autoplay, so
      // treating a step as a toggle would silently skip it instead.
      if (cause === "select") {
        hide();
        shownDay = null;
      }
      return;
    }
    if (!dayDates.has(d.date)) {
      hide();
      shownDay = null;
      return;
    }
    shownDay = d.date;
    const cells = await load(d.date);
    if (mine !== token) return; // superseded while the fetch was in flight
    paint(cells);
  };

  return {
    onSelect,
    invalidate,
    get shownDay() {
      return shownDay;
    },
  };
}
