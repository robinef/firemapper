import { describe, expect, it } from "vitest";

// ?raw so the assertions read the wiring itself: importing main.ts would boot
// the map (same reason as season_click_wiring.test.ts).
import mainSource from "../src/main.ts?raw";

describe("season year wiring in main.ts", () => {
  // Through January the pipeline shows the ended season; generated_at already
  // says the new year, whose file does not exist until the first full run.
  it("loads the season the manifest names, generated_at only as a fallback", () => {
    expect(mainSource).toMatch(
      /const seasonYear = manifest\.season_year \?\? Number\(manifest\.generated_at\.slice\(0, 4\)\);/,
    );
    expect(mainSource).toMatch(/loadSeason\(seasonYear, BASE\)/);
    expect(mainSource).toMatch(/loadSeasonSizes\(seasonYear, BASE\)/);
  });

  it("does not call an ended season 'this year'", () => {
    expect(mainSource).toMatch(
      /label: season\.year === Number\(manifest\.generated_at\.slice\(0, 4\)\)\s*\? "Burned this year"\s*: `Burned in \$\{season\.year\}`/,
    );
  });

  it("ends a playback on the shown season's last day, not on generated_at", () => {
    expect(mainSource).toMatch(/end: playbackEnd\(manifest\.generated_at, season\.year\),/);
  });

  // The reader's local clock is the wrong year for an hour or more around
  // 1 Jan outside UTC, and the wrong season all January.
  it("compares fire scale against the shown season, not the reader's clock", () => {
    expect(mainSource).not.toMatch(/new Date\(\)\.getFullYear\(\)/);
    expect(mainSource).toMatch(/const year = fires\?\.year \?\? new Date\(\)\.getUTCFullYear\(\);/);
  });
});

describe("fire-scale compare source in main.ts", () => {
  // blob_{year}_fires.json holds every archived track, static heat sources
  // included (~8% of 2026's area); the season sidecar is the filtered view the
  // "Burned this year" layer paints. The compare blob must read the same.
  it("feeds the compare blob from the season sidecar, the raw blob only as fallback", () => {
    expect(mainSource).toMatch(
      /get promise\(\) \{\s*return sizesP\.then\(\(s\) => \(s && sidecarCountries\(s\)\) \?\? firesSummary\(\)\);\s*\}/,
    );
    expect(mainSource).not.toMatch(/get promise\(\) \{ return firesSummary\(\); \}/);
  });
});
