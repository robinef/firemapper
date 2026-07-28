import { describe, expect, it } from "vitest";
import { STATE_COLORS, markerColor } from "../src/map";

describe("marker color", () => {
  it("maps each state", () => {
    expect(markerColor("accelerating")).toBe(STATE_COLORS.accelerating);
    expect(markerColor("declining")).toBe("#8a8a8a");
  });
});
