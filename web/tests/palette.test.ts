import { describe, expect, it } from "vitest";
import { hashColor } from "../src/palette";

describe("hashColor", () => {
  it("returns a hex color", () => {
    expect(hashColor("fire-123")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("is deterministic for the same id", () => {
    expect(hashColor("fire-123")).toBe(hashColor("fire-123"));
  });

  it("differs for different ids (not a constant)", () => {
    const colors = new Set(["a", "b", "c", "d", "e", "f", "g"].map(hashColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});
