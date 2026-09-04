import { describe, expect, it } from "vitest";

// ?raw so the assertion reads the registration itself. Importing main.ts would
// boot the map.
import mainSource from "../src/main.ts?raw";

describe("layer levels", () => {
  it("registers fire intensity for level 2 only", () => {
    // Tempered so the match cannot cross into the NEXT layer object: a plain
    // [\s\S]{0,400} reaches the `spread` layer's own `levels: [2]` and passes
    // even when intensity is registered [1, 2].
    expect(mainSource).toMatch(/key:\s*"intensity"(?:(?!key:)[\s\S])*?levels:\s*\[\s*2\s*\]/);
  });

  it("keeps burn scars on the overview", () => {
    expect(mainSource).toMatch(/key:\s*"scars"(?:(?!key:)[\s\S])*?levels:\s*\[\s*1\s*\]/);
  });

  // These four only ever show current-moment data (live FRP, live wind, a
  // fresh satellite pass) — never data computed for whichever fire is open —
  // so they're marked liveOnly and force-hidden for a historical fire (see
  // registry.ts's Switcher.setLevel `historical` option).
  for (const key of ["intensity", "spread", "wind", "viirs"]) {
    it(`marks "${key}" liveOnly`, () => {
      expect(mainSource).toMatch(new RegExp(`key:\\s*"${key}"(?:(?!key:)[\\s\\S])*?liveOnly:\\s*true`));
    });
  }

  // The wind grid is a coarse ~0.5deg mesh: at level 2's tight per-fire zoom
  // the nearest sample is very often off-screen, so the toggle has nothing
  // to show. ?wind=1 is the escape hatch — unlocks level 1 too and defaults
  // the toggle on, without changing the module for everyone else.
  it("reads ?wind=1 from the query string to gate the wind module's levels/defaultOn", () => {
    expect(mainSource).toMatch(/FORCE_WIND\s*=\s*params\.get\("wind"\)\s*===\s*"1"/);
    expect(mainSource).toMatch(
      /key:\s*"wind"(?:(?!key:)[\s\S])*?levels:\s*\(FORCE_WIND\s*\?\s*\[1,\s*2\]\s*:\s*\[2\]\)/,
    );
    expect(mainSource).toMatch(/key:\s*"wind"(?:(?!key:)[\s\S])*?defaultOn:\s*FORCE_WIND/);
  });

  // Companion to ?wind=1: a URL naming a fire that has a wind sample nearby
  // deep-links straight to its card, same path as clicking a search-list row.
  it("reads ?fire=<id> and opens that fire's card via openFromList", () => {
    expect(mainSource).toMatch(/FORCE_FIRE\s*=\s*params\.get\("fire"\)/);
    expect(mainSource).toMatch(/if\s*\(FORCE_FIRE\)\s*openFromList\(FORCE_FIRE\)/);
  });
});
