import { describe, expect, it } from "vitest";
import { cellArea, cellToLatLng, cellToParent, gridDisk, latLngToCell, UNITS } from "h3-js";
import { buildCellIndex, cellsClickable, pickClaimant, scarFromArchive } from "../src/season_click";
import type { SeasonCells, Track } from "../src/types";

const a = latLngToCell(45.0, 5.0, 8);
const b = latLngToCell(45.0, 5.02, 8);
const c = latLngToCell(45.0, 5.04, 8);
const entry = (cells: string[], first = "2026-07-01") => ({ digest: "d", first, cells });

describe("buildCellIndex", () => {
  it("lists every fire claiming a cell, not just the first", () => {
    const index = buildCellIndex({ small: entry([a, b]), big: entry([b, c]) });
    expect(index.get(a)).toEqual(["small"]);
    expect(index.get(b)).toEqual(["small", "big"]); // shared ground
    expect(index.get(c)).toEqual(["big"]);
  });

  // The same nested-cell rule cellFeatures applies when it EMITS the polygons:
  // a fire holding a coarse Meteosat cell and its finer VIIRS children is one
  // patch of ground, and the parent is never drawn. Indexing it anyway would
  // let the index answer for a cell that is not on the map.
  it("drops a fire's own parent cell when it also holds a finer child", () => {
    const child = latLngToCell(45.0, 5.0, 8);
    const parent = cellToParent(child, 7);
    const index = buildCellIndex({ f: entry([parent, child]) });
    expect(index.get(child)).toEqual(["f"]);
    expect(index.has(parent)).toBe(false);
  });

  it("returns an empty index for no fires", () => {
    expect(buildCellIndex({}).size).toBe(0);
  });
});

// The cells layer has minzoom 8 and fades in over z8–8.5, and
// queryRenderedFeatures answers for a feature at opacity 0 — so between z8 and
// the fade a click would open a card for ground the reader cannot see, while
// the hex band underneath is still what is actually painted.
describe("cellsClickable", () => {
  it("is off while the cells are still fading in, on once they are the visible band", () => {
    expect(cellsClickable(7)).toBe(false);
    expect(cellsClickable(8)).toBe(false);
    expect(cellsClickable(8.24)).toBe(false);
    expect(cellsClickable(8.25)).toBe(true);
    expect(cellsClickable(10)).toBe(true);
  });
});

describe("pickClaimant", () => {
  // The cell's own `fire_id` property is the FIRST claimant, which is whatever
  // order the file happened to be in — routinely a 0.8 km² fire whose card the
  // reader did not click on, and which the current threshold may have filtered
  // off the map entirely. The claimant that OWNS this ground at the current
  // selection is the largest one that passes both gates.
  const index = new Map<string, string[]>([[a, ["small", "large"]], [b, ["small"]]]);
  const sizes = new Map([["small", 0.8], ["large", 42]]);

  it("picks the largest claimant, not the first", () => {
    expect(pickClaimant(a, index, sizes, 0)).toBe("large");
  });

  it("ignores claimants below the current size threshold", () => {
    expect(pickClaimant(a, index, sizes, 20)).toBe("large");
    expect(pickClaimant(b, index, sizes, 20)).toBeNull(); // only claimant is 0.8 km²
    expect(pickClaimant(b, index, sizes, 0)).toBe("small");
  });

  it("ignores claimants the scope drops", () => {
    const keep = (id: string) => id !== "large"; // e.g. an EU-27 scope
    expect(pickClaimant(a, index, sizes, 0, keep)).toBe("small");
  });

  it("is null for a cell nothing claims, and for a fire with no known size", () => {
    expect(pickClaimant(c, index, sizes, 0)).toBeNull();
    expect(pickClaimant(a, index, new Map(), 0.5)).toBeNull();
  });
});

describe("scarFromArchive", () => {
  const cells = gridDisk(a, 1);
  const track: Track = {
    id: "fire-1",
    series: [
      { bin: "2026-07-24T00:00:00Z", centroid: [45, 5], new_cells: 4, cum_cells: 4, frp_sum: 10 },
      { bin: "2026-07-26T12:00:00Z", centroid: [45, 5], new_cells: 3, cum_cells: 7, frp_sum: 8 },
    ],
    cells,
    cell_bins: [["2026-07-24T00:00:00Z", cells]],
    frp_live: [],
  };
  const sizeEntry: [number, string | null, string] = [31.5, "ES", "2026-07-24"];

  it("builds a past scar the card and compare mode can both read", () => {
    const s = scarFromArchive("fire-1", track, sizeEntry, "2026-09-23");
    expect(s.id).toBe("fire-1");
    expect(s.kind).toBe("past");
    expect(s.track_gen).toBe("archive"); // so the card's own reload finds the track
    expect(s.started).toBe("2026-07-24"); // the sidecar's first-detection day
    expect(s.area_km2).toBe(31.5); // the sidecar's footprint km², as the filter counts it
    expect(s.cum_cells).toBe(cells.length);
    expect(s.label).toBe("Burn scar · 24 Jul 2026");
    // scarCardHtml prints `place` as the card's TITLE. The sidecar carries an
    // ISO country code, not a place name, so a card over a fire in Ávila
    // would be titled "ES" — the dated label is the better title.
    expect(s.place).toBeNull();
  });

  it("centres on the mean of the track's cells, not the first one", () => {
    const s = scarFromArchive("fire-1", track, sizeEntry, "2026-09-23");
    const lats = cells.map((x) => cellToLatLng(x)[0]);
    const lngs = cells.map((x) => cellToLatLng(x)[1]);
    expect(s.lat).toBeCloseTo(lats.reduce((x, y) => x + y, 0) / cells.length, 9);
    expect(s.lon).toBeCloseTo(lngs.reduce((x, y) => x + y, 0) / cells.length, 9);
  });

  // Mirrors pipeline/fetch_imagery.py::_scar_dates for a past fire: the
  // baseline sits BASELINE_LEAD_DAYS before ignition, the scar frame
  // SCAR_SETTLE_DAYS after it — but never before the fire's last detection,
  // or a two-month burn gets an "after" image taken mid-burn.
  it("dates the before/after frames the way the imagery pipeline does", () => {
    const s = scarFromArchive("fire-1", track, sizeEntry, "2026-09-23");
    expect(s.before).toBe("2026-07-18"); // 24 Jul − 6 d
    expect(s.after).toBe("2026-08-07"); // 24 Jul + 14 d, past the 26 Jul last bin
  });

  it("never dates the after frame before the fire's last detection", () => {
    const long: Track = {
      ...track,
      series: [track.series[0], { ...track.series[1], bin: "2026-09-02T00:00:00Z" }],
    };
    const s = scarFromArchive("fire-1", long, sizeEntry, "2026-09-23");
    expect(s.after).toBe("2026-09-02"); // the last bin outruns first + 14 d
  });

  // GIBS has no imagery for today, so the pipeline clamps to yesterday; a fire
  // still detecting two days ago would otherwise ask for a frame that 404s.
  it("clamps the after frame to yesterday", () => {
    const s = scarFromArchive("fire-1", track, sizeEntry, "2026-07-30");
    expect(s.after).toBe("2026-07-29");
  });

  // …but never back past ignition: a "before" and an "after" on the same
  // pre-fire day read as "the fire did nothing".
  it("never dates the after frame before ignition", () => {
    const s = scarFromArchive("fire-1", track, sizeEntry, "2026-07-20");
    expect(s.after).toBe("2026-07-24");
  });

  // The sidecar and the cells file are separate uploads, and a deep link can
  // open a card before the sidecar lands at all. The track alone carries
  // enough: the same dedup-and-sum the sidecar's km² is computed from, and
  // the first bin's day.
  it("falls back to the track when there is no sidecar entry", () => {
    const s = scarFromArchive("fire-1", track, null, "2026-09-23");
    // Rounded to 3 dp, as pipeline/export_season.py rounds the sidecar's own
    // km²: areaText prints this number verbatim onto the card.
    const expected = cells.reduce((sum, x) => sum + cellArea(x, UNITS.km2), 0);
    expect(s.area_km2).toBe(Math.round(expected * 1000) / 1000);
    expect(String(s.area_km2).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
    expect(s.started).toBe("2026-07-24"); // the first bin's day
    expect(s.before).toBe("2026-07-18");
    expect(s.place).toBeNull();
  });

  it("survives a track with no series at all", () => {
    const bare: Track = { ...track, series: [] };
    const s = scarFromArchive("fire-1", bare, sizeEntry, "2026-09-23");
    expect(s.started).toBe("2026-07-24"); // the sidecar still dates it
    expect(s.after).toBe("2026-08-07");
  });

  it("counts a fire's own nested cells once, as the sizes sidecar does", () => {
    const child = a;
    const parent = cellToParent(child, 7);
    const nested: Track = { ...track, cells: [parent, child] };
    const s = scarFromArchive("fire-1", nested, null, "2026-09-23");
    expect(s.area_km2).toBe(Math.round(cellArea(child, UNITS.km2) * 1000) / 1000);
  });
});
