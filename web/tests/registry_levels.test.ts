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
});
