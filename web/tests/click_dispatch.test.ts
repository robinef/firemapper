import { describe, expect, it } from "vitest";
import { dispatchMapClick } from "../src/main_click";
// ?raw so the precedence assertions read main.ts's own CLICK_ORDER rather than
// this file's copy of it. Importing main.ts would boot the map.
import mainSource from "../src/main.ts?raw";

const ORDER = ["fire-halo", "fires", "fire-footprint-fill", "scars", "season-cells-fill", "day-slice-fill"];

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
    expect(dispatchMapClick([{ layer: { id: "hillshade" } }], ORDER)).toBeNull();
  });

  it("returns null for an empty query", () => {
    expect(dispatchMapClick([], ORDER)).toBeNull();
  });

  // A burned season cell is a whole res-8 hex of ground; a fire dot or a scar
  // marker drawn on top of it is the more specific answer to "what did I just
  // tap". The day slice is the other way round: it blankets whole regions, so
  // ground that a past fire actually burned beats it.
  it("loses a burned season cell to a fire and to a scar, and beats the day slice", () => {
    expect(dispatchMapClick(
      [{ layer: { id: "season-cells-fill" } }, { layer: { id: "fires" } }],
      ORDER,
    )).toBe("fires");
    expect(dispatchMapClick(
      [{ layer: { id: "season-cells-fill" } }, { layer: { id: "scars" } }],
      ORDER,
    )).toBe("scars");
    expect(dispatchMapClick(
      [{ layer: { id: "day-slice-fill" } }, { layer: { id: "season-cells-fill" } }],
      ORDER,
    )).toBe("season-cells-fill");
  });
});

describe("main.ts's own click wiring", () => {
  it("orders the season cells after the scars and before the day slice", () => {
    const order = mainSource.match(/const CLICK_ORDER = \[([\s\S]*?)\];/)![1];
    expect(order).toContain("SCAR_LAYER_IDS");
    expect(order).toContain("SEASON_CELLS_LAYER");
    expect(order).toContain("DAY_SLICE_LAYER");
    expect(order.indexOf("SCAR_LAYER_IDS")).toBeLessThan(order.indexOf("SEASON_CELLS_LAYER"));
    expect(order.indexOf("SEASON_CELLS_LAYER")).toBeLessThan(order.indexOf("DAY_SLICE_LAYER"));
  });

  // The gate belongs to the layer LIST, not to the handler: ignoring the click
  // inside the handler would swallow it, and the day slice underneath — the
  // band that is actually painted at those zooms — would never see it.
  it("drops the season cells from the queried layers below the click zoom", () => {
    expect(mainSource).toMatch(
      /CLICK_ORDER\.filter\(\s*\(id\)\s*=>\s*map\.getLayer\(id\)\s*&&\s*\(id !== SEASON_CELLS_LAYER \|\| cellsClickable\(map\.getZoom\(\)\)\)/,
    );
  });

  it("gives the season cells a handler and a pointer cursor", () => {
    expect(mainSource).toMatch(/HANDLERS\[SEASON_CELLS_LAYER\]\s*=/);
    // The cursor loop — the fire-halo layers are deliberately left out of it,
    // so this is a list of the layers that LOOK clickable.
    const cursor = mainSource.match(/for \(const id of \[\s*\n\s*\.\.\.fireLayerIds,[\s\S]*?\]\) \{/)![0];
    expect(cursor).toContain("SEASON_CELLS_LAYER");
  });
});
