/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountScrubber, STEP_MS, type ScrubCause } from "../src/scrubber";
import { emitUi, uiSubscriberCount } from "../src/ui_events";

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

const label = (i: number) => `bin ${i}`;

describe("scrubber", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("renders a range, a play button and a label", () => {
    const h = host();
    mountScrubber(h, { count: 10, labelFor: label, onScrub: () => {} });
    const range = h.querySelector<HTMLInputElement>(".scrub-range")!;
    expect(range.type).toBe("range");
    expect(range.min).toBe("0");
    expect(range.max).toBe("9");
    expect(h.querySelector(".scrub-play")).not.toBeNull();
    expect(h.querySelector(".scrub-label")!.textContent).toBe("bin 0");
  });

  it("reports the value the user drags to", () => {
    const h = host();
    const seen: number[] = [];
    mountScrubber(h, { count: 10, labelFor: label, onScrub: (i) => seen.push(i) });
    const range = h.querySelector<HTMLInputElement>(".scrub-range")!;
    range.value = "4";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen).toEqual([4]);
    expect(h.querySelector(".scrub-label")!.textContent).toBe("bin 4");
  });

  it("setIndex moves the slider WITHOUT calling onScrub", () => {
    // The timeline calls this when a bar click moved the selection. Re-entering
    // onScrub here would fire the caller's onSelect twice for one user action.
    const h = host();
    const seen: number[] = [];
    const s = mountScrubber(h, { count: 10, labelFor: label, onScrub: (i) => seen.push(i) });
    s.setIndex(7);
    expect(h.querySelector<HTMLInputElement>(".scrub-range")!.value).toBe("7");
    expect(h.querySelector(".scrub-label")!.textContent).toBe("bin 7");
    expect(seen).toEqual([]);
  });

  it("clamps out-of-range indices", () => {
    const h = host();
    const s = mountScrubber(h, { count: 5, labelFor: label, onScrub: () => {} });
    s.setIndex(99);
    expect(s.index).toBe(4);
    s.setIndex(-3);
    expect(s.index).toBe(0);
  });

  it("plays through the bins and stops at the end without looping", () => {
    vi.useFakeTimers();
    const h = host();
    const seen: number[] = [];
    const s = mountScrubber(h, { count: 4, labelFor: label, onScrub: (i) => seen.push(i) });
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    vi.advanceTimersByTime(STEP_MS * 10); // well past the end
    // Play must emit the bin it starts from (0) as well as every bin it
    // advances through, so a play-from-0 shows the same growth story as the
    // restart-from-end case below, rather than skipping straight to bin 1.
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(s.playing).toBe(false);
    expect(s.index).toBe(3);
  });

  it("starts at the given initialIndex instead of bin 0", () => {
    const h = host();
    const s = mountScrubber(h, { count: 5, labelFor: label, onScrub: () => {}, initialIndex: 4 });
    expect(s.index).toBe(4);
    expect(h.querySelector<HTMLInputElement>(".scrub-range")!.value).toBe("4");
    expect(h.querySelector(".scrub-label")!.textContent).toBe("bin 4");
  });

  it("playing from a non-zero initialIndex emits that bin first", () => {
    vi.useFakeTimers();
    const h = host();
    const seen: number[] = [];
    mountScrubber(h, { count: 5, labelFor: label, onScrub: (i) => seen.push(i), initialIndex: 2 });
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    vi.advanceTimersByTime(STEP_MS * 10);
    expect(seen).toEqual([2, 3, 4]);
  });

  it("restarts from the beginning when played from the last bin", () => {
    vi.useFakeTimers();
    const h = host();
    const seen: number[] = [];
    const s = mountScrubber(h, { count: 3, labelFor: label, onScrub: (i) => seen.push(i) });
    s.setIndex(2);
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    vi.advanceTimersByTime(STEP_MS * 5);
    expect(seen[0]).toBe(0);
  });

  it("always re-emits the bin play starts from, even if a drag already selected it", () => {
    // A prior fix skipped this emit whenever the starting bin had already
    // been handed to onScrub (via a `lastEmitted` cache), on the theory that
    // a toggling consumer would otherwise read the repeat as "click it
    // again" and hide it. That cache was a guess at the CONSUMER's display
    // state, and it went stale the moment a click toggled the bin back off
    // without the scrubber's knowledge — silently skipping the bin instead of
    // flickering it. The scrubber cannot know the consumer's state, so it
    // must always emit and instead tell the truth about the cause: "select"
    // for a drag, "step" for playback. See day_slice_select.ts for the
    // consumer-side half of this fix.
    vi.useFakeTimers();
    const h = host();
    const seen: Array<[number, ScrubCause]> = [];
    mountScrubber(h, { count: 5, labelFor: label, onScrub: (i, cause) => seen.push([i, cause]) });
    const range = h.querySelector<HTMLInputElement>(".scrub-range")!;
    range.value = "2";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen).toEqual([[2, "select"]]);
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    expect(seen).toEqual([
      [2, "select"],
      [2, "step"], // re-emitted, but tagged "step" — not a fresh pick
    ]);
    vi.advanceTimersByTime(STEP_MS);
    expect(seen).toEqual([
      [2, "select"],
      [2, "step"],
      [3, "step"],
    ]);
  });

  it("always re-emits the bin selected via setIndex when play starts from it", () => {
    // Same guarantee via the other entry point: a bar click calls onSelect
    // itself and only syncs the scrubber's position with setIndex — that
    // selection is just as "already current" as a drag, and play must still
    // emit it (tagged "step") rather than assume the caller already handled it.
    vi.useFakeTimers();
    const h = host();
    const seen: Array<[number, ScrubCause]> = [];
    const s = mountScrubber(h, { count: 5, labelFor: label, onScrub: (i, cause) => seen.push([i, cause]) });
    s.setIndex(3);
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    expect(seen).toEqual([[3, "step"]]); // setIndex itself never calls onScrub — this is play's own emit
    vi.advanceTimersByTime(STEP_MS);
    expect(seen).toEqual([
      [3, "step"],
      [4, "step"],
    ]);
  });

  it("a manual drag cancels playback", () => {
    vi.useFakeTimers();
    const h = host();
    const s = mountScrubber(h, { count: 20, labelFor: label, onScrub: () => {} });
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    vi.advanceTimersByTime(STEP_MS * 2);
    expect(s.playing).toBe(true);
    const range = h.querySelector<HTMLInputElement>(".scrub-range")!;
    range.value = "11";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(s.playing).toBe(false);
  });

  it("destroy stops running playback", () => {
    // Otherwise the timer keeps firing against detached DOM after the fire card
    // closes, calling onScrub for a fire that is no longer open.
    vi.useFakeTimers();
    const h = host();
    const seen: number[] = [];
    const s = mountScrubber(h, { count: 50, labelFor: label, onScrub: (i) => seen.push(i) });
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    vi.advanceTimersByTime(STEP_MS * 2);
    const before = seen.length;
    s.destroy();
    vi.advanceTimersByTime(STEP_MS * 10);
    expect(seen.length).toBe(before);
    expect(h.querySelector(".scrub-range")).toBeNull();
  });

  it("announces the label to assistive tech, not the raw number", () => {
    const h = host();
    const s = mountScrubber(h, { count: 5, labelFor: (i) => `Jul ${i + 1} · 0 new cells`, onScrub: () => {} });
    s.setIndex(2);
    const range = h.querySelector<HTMLInputElement>(".scrub-range")!;
    expect(range.getAttribute("aria-label")).toBe("Fire history position");
    expect(range.getAttribute("aria-valuetext")).toBe("Jul 3 · 0 new cells");
  });

  it("clicking play twice pauses without starting a second timer chain", () => {
    vi.useFakeTimers();
    const h = host();
    const seen: number[] = [];
    const s = mountScrubber(h, { count: 20, labelFor: label, onScrub: (i) => seen.push(i) });
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    vi.advanceTimersByTime(STEP_MS);
    expect(s.playing).toBe(true);
    // Second click pauses
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    expect(s.playing).toBe(false);
    const countAtPause = seen.length;
    // Advance timers: if a second chain were running, onScrub would fire again
    vi.advanceTimersByTime(STEP_MS * 10);
    expect(seen.length).toBe(countAtPause);
  });

  it("compare:enter stops a playing scrubber", () => {
    // Compare mode hides every data overlay on purpose; an unattended play
    // timer must not repaint fire-bin-fill/-line back over the imagery once
    // that decision has been made.
    vi.useFakeTimers();
    const h = host();
    const seen: number[] = [];
    const s = mountScrubber(h, { count: 20, labelFor: label, onScrub: (i) => seen.push(i) });
    (h.querySelector(".scrub-play") as HTMLButtonElement).click();
    vi.advanceTimersByTime(STEP_MS * 2);
    expect(s.playing).toBe(true);
    emitUi("compare:enter");
    expect(s.playing).toBe(false);
    const countAtEnter = seen.length;
    vi.advanceTimersByTime(STEP_MS * 10);
    expect(seen.length).toBe(countAtEnter);
  });

  it("destroy unsubscribes from compare:enter", () => {
    // Otherwise a destroyed scrubber's stop() (closed over removed DOM) keeps
    // firing for every future compare:enter, and the subscriber set leaks one
    // entry per fire card opened and closed. `not.toThrow()` alone can't catch
    // that leak: emitUi try/catches every subscriber and a destroyed
    // scrubber's stop() can't throw anyway, so that assertion passes whether
    // or not the unsubscribe actually happens.
    const before = uiSubscriberCount("compare:enter");
    const h = host();
    const s = mountScrubber(h, { count: 20, labelFor: label, onScrub: () => {} });
    expect(uiSubscriberCount("compare:enter")).toBe(before + 1);
    s.destroy();
    expect(uiSubscriberCount("compare:enter")).toBe(before);
  });

  it("destroy after multiple play clicks stops all timer chains", () => {
    vi.useFakeTimers();
    const h = host();
    const seen: number[] = [];
    const s = mountScrubber(h, { count: 50, labelFor: label, onScrub: (i) => seen.push(i) });
    const play = h.querySelector(".scrub-play") as HTMLButtonElement;
    // Simulate rapid clicks that would trigger the bug
    play.click();
    vi.advanceTimersByTime(STEP_MS);
    play.click();
    play.click();
    vi.advanceTimersByTime(STEP_MS);
    const before = seen.length;
    s.destroy();
    vi.advanceTimersByTime(STEP_MS * 10);
    // No additional calls should have fired
    expect(seen.length).toBe(before);
  });
});
