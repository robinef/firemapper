/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { mountTimeline } from "../src/timeline";
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
