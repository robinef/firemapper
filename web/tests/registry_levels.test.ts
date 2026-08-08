import { describe, expect, it } from "vitest";

// ?raw so the assertion reads the registration itself. Importing main.ts would
// boot the map.
import mainSource from "../src/main.ts?raw";

describe("layer levels", () => {
  it("registers fire intensity for level 2 only", () => {
    // At overview zoom the heatmap is a smear across a continent; the readout
    // now carries intensity at level 2, and the spatial view stays available
    // behind the layers icon there.
    expect(mainSource).toMatch(/key:\s*"intensity"[\s\S]{0,400}?levels:\s*\[\s*2\s*\]/);
  });

  it("keeps burn scars on the overview", () => {
    expect(mainSource).toMatch(/key:\s*"scars"[\s\S]{0,400}?levels:\s*\[\s*1\s*\]/);
  });
});
