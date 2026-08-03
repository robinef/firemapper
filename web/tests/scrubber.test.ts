/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountScrubber, STEP_MS } from "../src/scrubber";

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
    expect(seen).toEqual([1, 2, 3]);
    expect(s.playing).toBe(false);
    expect(s.index).toBe(3);
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
