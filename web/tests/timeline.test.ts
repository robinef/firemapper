/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { mountTimeline, binAtX } from "../src/timeline";
import type { TimelineDay } from "../src/types";

function days(counts: number[]): TimelineDay[] {
  return counts.map((count, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    count,
    frp: count * 10,
  }));
}

describe("timeline empty state", () => {
  it("explains an all-zero window instead of drawing empty bars", () => {
    const el = document.createElement("div");
    mountTimeline(el, days(new Array(30).fill(0)), { onSelect: () => {} });
    expect(el.textContent).toContain("No VIIRS detections");
  });

  it("draws bars when there is any activity", () => {
    const el = document.createElement("div");
    mountTimeline(el, days([0, 0, 5, 0]), { onSelect: () => {} });
    expect(el.textContent).not.toContain("No VIIRS detections");
    expect(el.querySelectorAll(".tl-bar").length).toBeGreaterThan(0);
  });

  it("hides itself when there is no timeline at all", () => {
    const el = document.createElement("div");
    mountTimeline(el, [], { onSelect: () => {} });
    expect(el.style.display).toBe("none");
  });
});

describe("binAtX", () => {
  it("maps a pointer position to a day index", () => {
    expect(binAtX(0, 300, 30)).toBe(0);
    expect(binAtX(299, 300, 30)).toBe(29);
    expect(binAtX(150, 300, 30)).toBe(15);
  });

  it("clamps outside the chart", () => {
    expect(binAtX(-40, 300, 30)).toBe(0);
    expect(binAtX(9999, 300, 30)).toBe(29);
  });

  it("handles a single day without dividing by zero", () => {
    expect(binAtX(10, 300, 1)).toBe(0);
  });
});

describe("timeline pointer interactions", () => {
  it("fires onSelect exactly once for touch pointerup on a bar, even with synthetic click", () => {
    const el = document.createElement("div");
    const onSelect = { called: 0, lastDay: -1, lastIndex: -1 };
    mountTimeline(el, days([1, 2, 3]), {
      onSelect: (day, index) => {
        onSelect.called++;
        onSelect.lastDay = day.count;
        onSelect.lastIndex = index;
      },
    });

    const bars = el.querySelector(".tl-bars")!;
    const bar1 = bars.children[1] as HTMLElement;

    // Simulate touch gesture: pointerdown on bars container, pointerup on bar.
    const rect = bar1.getBoundingClientRect();
    const pointerDownEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 42,
      pointerType: "touch",
      clientX: rect.left + 10,
      clientY: rect.top + 10,
    });
    // For pointerup, dispatch on the bar so e.target is the bar.
    const pointerUpEvent = new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 42,
      pointerType: "touch",
      clientX: rect.left + 10,
      clientY: rect.top + 10,
    });

    bars.dispatchEvent(pointerDownEvent);
    bar1.dispatchEvent(pointerUpEvent);

    // Simulate browser's synthetic click (this is what would happen on a real device,
    // but jsdom doesn't do it automatically).
    const syntheticClick = new MouseEvent("click", {
      bubbles: true,
    });
    bar1.dispatchEvent(syntheticClick);

    // Despite both pointerup and synthetic click, onSelect should fire exactly once
    // because our unified handler consumes the gesture after pointerup.
    expect(onSelect.called).toBe(1);
    expect(onSelect.lastDay).toBe(2); // bar index 1 has count 2
    expect(onSelect.lastIndex).toBe(1);
  });

  it("mouse pointerup on a bar selects that exact bar (per-bar precision)", () => {
    const el = document.createElement("div");
    const onSelect = { called: 0, lastIndex: -1 };
    mountTimeline(el, days([1, 2, 3, 4, 5]), {
      onSelect: (day, index) => {
        onSelect.called++;
        onSelect.lastIndex = index;
      },
    });

    const bars = el.querySelector(".tl-bars")!;
    const bar3 = bars.children[3] as HTMLElement;

    const rect = bar3.getBoundingClientRect();
    const pointerDownEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 1,
      pointerType: "mouse",
      clientX: rect.left + 5,
      clientY: rect.top + 5,
    });
    const pointerUpEvent = new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 1,
      pointerType: "mouse",
      clientX: rect.left + 5,
      clientY: rect.top + 5,
    });

    bars.dispatchEvent(pointerDownEvent);
    bar3.dispatchEvent(pointerUpEvent);

    expect(onSelect.called).toBe(1);
    expect(onSelect.lastIndex).toBe(3); // Exact bar index.
  });

  it("touch tap on bars container (gap) resolves via binAtX when getBoundingClientRect has nonzero width", () => {
    const el = document.createElement("div");
    const onSelect = { called: 0, lastIndex: -1 };
    mountTimeline(el, days([1, 2, 3, 4, 5]), {
      onSelect: (day, index) => {
        onSelect.called++;
        onSelect.lastIndex = index;
      },
    });

    const bars = el.querySelector(".tl-bars")!;

    // Mock getBoundingClientRect to return realistic dimensions.
    const originalGetBoundingClientRect = bars.getBoundingClientRect.bind(bars);
    bars.getBoundingClientRect = () => ({
      left: 100,
      top: 10,
      right: 400,
      bottom: 110,
      width: 300,
      height: 100,
      x: 100,
      y: 10,
      toJSON: () => ({}),
    });

    // Dispatch pointerdown+pointerup at 60% across the container (should map to bin 3).
    const containerX = 100 + Math.floor(300 * 0.6); // 100 + 180 = 280
    const pointerDownEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 99,
      pointerType: "touch",
      clientX: containerX,
      clientY: 50,
    });
    const pointerUpEvent = new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 99,
      pointerType: "touch",
      clientX: containerX,
      clientY: 50,
    });

    bars.dispatchEvent(pointerDownEvent);
    bars.dispatchEvent(pointerUpEvent);

    // Handler calculates: binAtX(280 - 100, 300, 5) = binAtX(180, 300, 5) = 3
    expect(onSelect.called).toBe(1);
    expect(onSelect.lastIndex).toBe(3);

    // Restore original.
    Object.defineProperty(bars, "getBoundingClientRect", {
      value: originalGetBoundingClientRect,
    });
  });

  it("guards against drag-selection: significant pointer movement cancels selection", () => {
    const el = document.createElement("div");
    const onSelect = { called: 0 };
    mountTimeline(el, days([1, 2, 3]), {
      onSelect: () => {
        onSelect.called++;
      },
    });

    const bars = el.querySelector(".tl-bars")!;
    const bar1 = bars.children[1] as HTMLElement;
    const rect = bar1.getBoundingClientRect();

    // Simulate a drag: pointerdown at one location, pointerup far away.
    const pointerDownEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 77,
      pointerType: "touch",
      clientX: rect.left + 5,
      clientY: rect.top + 5,
    });
    const pointerUpEvent = new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 77,
      pointerType: "touch",
      clientX: rect.left + 100, // 100px movement > 5px threshold
      clientY: rect.top + 5,
    });

    bars.dispatchEvent(pointerDownEvent);
    bar1.dispatchEvent(pointerUpEvent);

    // Drag should cancel selection; onSelect should not be called.
    expect(onSelect.called).toBe(0);
  });

  it("touch tap on bars container (no bar target) resolves via binAtX", () => {
    const el = document.createElement("div");
    const onSelect = { called: 0, lastIndex: -1 };
    mountTimeline(el, days([1, 2, 3]), {
      onSelect: (day, index) => {
        onSelect.called++;
        onSelect.lastIndex = index;
      },
    });

    const bars = el.querySelector(".tl-bars")!;

    // Dispatch pointerdown+pointerup on the bars container itself (not on a specific bar).
    const pointerDownEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 99,
      pointerType: "touch",
      clientX: 10,
      clientY: 10,
    });
    const pointerUpEvent = new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 99,
      pointerType: "touch",
      clientX: 10,
      clientY: 10,
    });

    bars.dispatchEvent(pointerDownEvent);
    bars.dispatchEvent(pointerUpEvent);

    // In jsdom with zero-width container, binAtX(10, 0, 3) returns 0.
    expect(onSelect.called).toBe(1);
    expect(onSelect.lastIndex).toBe(0);
  });
});
