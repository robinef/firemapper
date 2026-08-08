import { describe, expect, it } from "vitest";

import { renderReadoutFull, renderReadoutPeek, type Readout } from "../src/fire_readout";

const FULL: Readout = {
  intensity: { mw: 378, ageMinutes: 22 * 60 },
  wind: { bearingDeg: 225, kmh: 18, distanceKm: 6, ageMinutes: 40 },
};

describe("renderReadoutFull", () => {
  it("always states the age of the intensity reading", () => {
    const html = renderReadoutFull(FULL);
    expect(html).toContain("378 MW");
    expect(html).toContain("22 h ago");
  });

  it("names the wind distance only when it is far", () => {
    expect(renderReadoutFull(FULL)).not.toContain("km away");
    const far = { ...FULL, wind: { ...FULL.wind!, distanceKm: 34 } };
    expect(renderReadoutFull(far)).toContain("34 km away");
  });

  it("states the wind's own age, so a carried forecast cannot read as live", () => {
    // The model already drops wind past its budget; anything still shown can
    // still be hours old, and nothing else on screen would say so.
    expect(renderReadoutFull(FULL)).toContain("40 min ago");
  });

  it("points the arrow where the wind is GOING, not where it is from", () => {
    // layer_wind.ts rotates icons by from_deg + 180; the readout must agree or
    // the overlay and the map layer contradict each other on screen.
    expect(renderReadoutFull(FULL)).toContain("rotate(45deg)");
  });

  it("omits a missing reading entirely rather than showing a zero or a dash", () => {
    const windOnly = renderReadoutFull({ intensity: null, wind: FULL.wind });
    expect(windOnly).not.toContain("MW");
    expect(windOnly).not.toContain("—");
    expect(windOnly).toContain("18 km/h");

    const intensityOnly = renderReadoutFull({ intensity: FULL.intensity, wind: null });
    expect(intensityOnly).not.toContain("km/h");
  });

  it("does not label the figure in a way that invites comparison with Peak intensity", () => {
    expect(renderReadoutFull(FULL)).not.toContain("Peak");
  });
});

describe("renderReadoutPeek", () => {
  it("carries both readings in abbreviated form", () => {
    const html = renderReadoutPeek(FULL);
    expect(html).toContain("378 MW");
    expect(html).toContain("22 h");
    expect(html).toContain("18");
  });

  it("survives a missing reading", () => {
    expect(renderReadoutPeek({ intensity: null, wind: FULL.wind })).not.toContain("MW");
    expect(renderReadoutPeek({ intensity: FULL.intensity, wind: null })).toContain("378 MW");
  });
});

describe("both renderings agree", () => {
  it("show the same figures from one model", () => {
    const full = renderReadoutFull(FULL);
    const peek = renderReadoutPeek(FULL);
    for (const fragment of ["378 MW", "22 h"]) {
      expect(full).toContain(fragment);
      expect(peek).toContain(fragment);
    }
  });
});
