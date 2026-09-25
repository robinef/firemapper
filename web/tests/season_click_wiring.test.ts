import { describe, expect, it } from "vitest";

// ?raw so the assertions read the wiring itself: importing main.ts would boot
// the map (same reason as registry_levels.test.ts).
import mainSource from "../src/main.ts?raw";

describe("season cell click wiring in main.ts", () => {
  // playbackKeep is unit-tested; this pins that the click actually uses it,
  // with the playback's own day and nday, rather than the filter's bare gate.
  it("narrows the claimant choice to the day a playback holds on screen", () => {
    expect(mainSource).toMatch(
      /const keep = playbackKeep\(sel\.keep, pb\?\.day \?\? null, \(fid\) => pb\?\.nday\(fid\) \?\? -Infinity\);/,
    );
    expect(mainSource).toMatch(/pickClaimant\(cell, cellIndex\.index, sel\.sizes, sel\.threshold, keep\)/);
  });

  // The deep link's archived fallback waits for the sizes sidecar. A card the
  // reader opened meanwhile must survive the sidecar landing.
  it("lets a card the reader opened win over a late ?fire= fallback", () => {
    expect(mainSource).toMatch(/onUi\("detail:open", \(\) => \{ readerOpened = true; \}\)/);
    expect(mainSource).toMatch(/if \(!readerOpened\) void fireCard\.openArchived\(FORCE_FIRE/);
  });
});
