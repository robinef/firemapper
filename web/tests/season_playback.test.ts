// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cellToParent, gridDisk, latLngToCell } from "h3-js";
import { aggregate, fireSizes } from "../src/season_filter";
import { NO_DAY, addDays, column, ndayFor, precompute } from "../src/season_playback";
import type { SeasonCells } from "../src/types";

const entry = (cells: string[], first: string) => ({ digest: "d", first, cells });

// Two res-6 neighbourhoods, fires spread over a fortnight, deliberately
// enumerated out of date order. `late` re-burns ground `early` already
// claimed (the union must count it once, from `early`'s day), `nested` holds
// a coarse cell and its own child (dedup inside the fire), and `foreign`
// shares a cell with `eu` so a scope can split a cell's claimants. A cell's
// day is the MIN over its claimants whichever order they are enumerated in.
const a = latLngToCell(45.0, 5.0, 8);
const b = latLngToCell(45.0, 5.02, 8);
const far = latLngToCell(52.0, 13.0, 8);
const other = latLngToCell(40.0, -4.0, 8);
const PLAY_CELLS: SeasonCells = {
  late: entry([a, b], "2026-07-09"),
  early: entry([a], "2026-07-01"),
  big: entry([...gridDisk(far, 1)], "2026-07-05"),
  nested: entry([cellToParent(other, 7), other], "2026-07-03"),
  eu: entry([latLngToCell(40.1, -4.1, 8)], "2026-07-12"),
  foreign: entry([latLngToCell(40.1, -4.1, 8), latLngToCell(40.2, -4.2, 8)], "2026-07-02"),
  // Enumerated AFTER `late` but detected later still: b must keep `late`'s day.
  rekindle: entry([b], "2026-07-13"),
};
const PLAY_SIZES = fireSizes(PLAY_CELLS);
const EU = new Set(["late", "early", "nested", "eu", "rekindle"]);
const keepEu = (id: string) => EU.has(id);

describe("addDays", () => {
  it("steps UTC calendar days across month ends", () => {
    expect(addDays("2026-07-30", 3)).toBe("2026-08-02");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30"); // DST change in Europe, not in UTC
    expect(addDays("2026-07-01", 0)).toBe("2026-07-01");
  });
});

describe("precompute", () => {
  const sel = (threshold = 0, keep?: (id: string) => boolean, scope: "all" | "eu" = "all") => ({
    cells: PLAY_CELLS, sizes: PLAY_SIZES, threshold, keep, scope,
  });

  it("runs one day per step from the selection's floor to the end date", () => {
    const p = precompute(sel(), "2026-07-20")!;
    expect(p.days[0]).toBe("2026-07-01");
    expect(p.days.at(-1)).toBe("2026-07-20");
    expect(p.days).toHaveLength(20);
  });

  it("the floor follows the selection, not the file", () => {
    // `early` (07-01) and `foreign` (07-02) are gone under a scope that drops foreign
    const p = precompute(sel(0, (id) => id !== "early" && id !== "foreign"), "2026-07-20")!;
    expect(p.days[0]).toBe("2026-07-03");
  });

  it("an end date before the last fire is extended to reach it", () => {
    const p = precompute(sel(), "2026-07-05")!;
    expect(p.days.at(-1)).toBe("2026-07-13");
  });

  it("is null when nothing qualifies", () => {
    expect(precompute(sel(1e9), "2026-07-20")).toBeNull();
  });

  // The contract: column d IS the season as it stood that day, byte for byte
  // what aggregate() says with until = that date — for every selection.
  for (const [name, s] of [
    ["all sizes", sel()],
    ["≥ threshold", sel(PLAY_SIZES.get("late")!)],
    ["EU-27", sel(0, keepEu, "eu")],
  ] as const) {
    it(`${name}: every column, count and km² equal aggregate(until = that day)`, () => {
      const p = precompute(s, "2026-07-14")!;
      for (let d = 0; d < p.days.length; d += 1) {
        const ref = aggregate(s.cells, s.sizes, s.threshold, s.keep, s.scope, p.days[d]);
        expect(column(p, d), `r6 on ${p.days[d]}`).toEqual(ref.r6);
        expect(p.fires[d], `fires on ${p.days[d]}`).toBe(ref.fires);
        expect(p.km2[d], `km2 on ${p.days[d]}`).toBe(ref.km2);
      }
    });

    it(`${name}: the last column is the full aggregate`, () => {
      const p = precompute(s, "2026-07-14")!;
      const full = aggregate(s.cells, s.sizes, s.threshold, s.keep, s.scope);
      const last = p.days.length - 1;
      expect(column(p, last)).toEqual(full.r6);
      expect(p.fires[last]).toBe(full.fires);
      expect(p.km2[last]).toBe(full.km2);
    });
  }

  it("the columns really grow (the fixture is not trivially flat)", () => {
    const p = precompute(sel(), "2026-07-14")!;
    expect(column(p, 0)).toHaveLength(1);
    expect(p.fires[0]).toBe(1);
    expect(p.km2[p.days.length - 1]).toBeGreaterThan(p.km2[0]);
  });
});

describe("ndayFor", () => {
  it("is minus the fire's day index for a qualifying fire, NO_DAY otherwise", () => {
    const p = precompute({ cells: PLAY_CELLS, sizes: PLAY_SIZES, threshold: 0, keep: keepEu, scope: "eu" }, "2026-07-14")!;
    expect(p.days[0]).toBe("2026-07-01");
    expect(ndayFor(p, "early")).toBe(0);
    expect(ndayFor(p, "late")).toBe(-8);
    expect(ndayFor(p, "foreign")).toBe(NO_DAY);
    expect(ndayFor(p, "nope")).toBe(NO_DAY);
    expect(ndayFor(null, "early")).toBe(NO_DAY);
  });
});
