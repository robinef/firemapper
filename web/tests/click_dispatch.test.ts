import { describe, expect, it } from "vitest";
import { dispatchMapClick } from "../src/main_click";

const ORDER = ["fire-halo", "fires", "fire-footprint-fill", "scars", "aircraft-halo", "aircraft"];

describe("map click dispatch", () => {
  it("picks exactly one layer when a tap hits a dot and its halo", () => {
    const hit = dispatchMapClick(
      [{ layer: { id: "fires" } }, { layer: { id: "fire-halo" } }],
      ORDER,
    );
    expect(hit).toBe("fire-halo");
  });

  it("prefers a fire over an overlapping scar", () => {
    const hit = dispatchMapClick(
      [{ layer: { id: "scars" } }, { layer: { id: "fires" } }],
      ORDER,
    );
    expect(hit).toBe("fires");
  });

  it("returns null when nothing interactive was hit", () => {
    expect(dispatchMapClick([{ layer: { id: "day-slice-fill" } }], ORDER)).toBeNull();
  });

  it("returns null for an empty query", () => {
    expect(dispatchMapClick([], ORDER)).toBeNull();
  });
});
