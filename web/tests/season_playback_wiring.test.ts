import { describe, expect, it } from "vitest";

// ?raw so the assertions read the wiring itself: importing main.ts would boot
// the map (same reason as registry_levels.test.ts).
import mainSource from "../src/main.ts?raw";

describe("season playback wiring in main.ts", () => {
  // The filter's aggregate is debounced (~100 ms). One scheduled just before a
  // play — or by the same onLoaded that released it — lands AFTER the first
  // frame and repaints the whole season while the status line reads "up to
  // 1 Jan". The next tick corrects the map, but a pause inside that window
  // leaves the contradiction standing.
  it("lets a running playback own the map: onAggregate paints only when no day is held", () => {
    expect(mainSource).toMatch(
      /onAggregate:[\s\S]*?if\s*\(seasonPlayback\?\.day\s*!==\s*null[\s\S]*?refreshStatus\("season"\);\s*\n\s*return;/,
    );
    // The aggregate is still recorded, so the restore path after a stop has it.
    expect(mainSource).toMatch(/onAggregate:\s*\(agg\)\s*=>\s*\{[\s\S]{0,200}?seasonAgg\s*=\s*agg;/);
  });

  // Unticking hides the layers and drops the control from the DOM, but the
  // 300 ms chain would keep pushing ~10k features a tick at nothing and
  // painting into a detached container.
  it("pauses the playback when the season layer is toggled off", () => {
    expect(mainSource).toMatch(/onToggle:\s*\(on:\s*boolean\)\s*=>\s*\{[\s\S]*?else\s+seasonPlayback\?\.pause\(\);/);
  });

  // The loader reports its first two failures by going back to idle, with no
  // onLoaded and no onGaveUp — so only "loading" still owes a dataChanged().
  it("tells the playback when a cells fetch is genuinely still in flight", () => {
    expect(mainSource).toMatch(/cellsPending:\s*\(\)\s*=>\s*seasonLoader\?\.state\(\)\s*===\s*"loading"/);
  });
});
