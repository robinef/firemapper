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
    const near = { ...FULL, wind: { ...FULL.wind!, distanceKm: 25 } };
    expect(renderReadoutFull(near)).not.toContain("km away");
    const far = { ...FULL, wind: { ...FULL.wind!, distanceKm: 26 } };
    expect(renderReadoutFull(far)).toContain("26 km away");
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

  it("labels the intensity section as Burning, not Peak", () => {
    expect(renderReadoutFull(FULL)).toContain("Burning");
    expect(renderReadoutFull(FULL)).not.toContain("Peak");
  });

  it("wraps the output in ro-body", () => {
    expect(renderReadoutFull(FULL)).toContain('<div class="ro-body">');
    expect(renderReadoutFull(FULL)).toContain("</div>");
  });

  it("includes ro-rule separator when both readings exist", () => {
    expect(renderReadoutFull(FULL)).toContain('<div class="ro-rule"></div>');
  });

  it("omits ro-rule when only one reading exists", () => {
    const intensityOnly = renderReadoutFull({ intensity: FULL.intensity, wind: null });
    expect(intensityOnly).not.toContain("ro-rule");
  });

  it("formats multi-day ages with d suffix", () => {
    const threeDaysAgo = { ...FULL, intensity: { mw: 100, ageMinutes: 3 * 24 * 60 } };
    expect(renderReadoutFull(threeDaysAgo)).toContain("3 d ago");
  });
});

describe("renderReadoutPeek", () => {
  it("carries both readings in abbreviated form", () => {
    const html = renderReadoutPeek(FULL);
    expect(html).toContain("378 MW");
    expect(html).toContain("22 h");
    expect(html).toContain("18");
  });

  it("includes peek-specific spans for styling", () => {
    expect(renderReadoutPeek(FULL)).toContain('<span class="ro-peek">');
    expect(renderReadoutPeek(FULL)).toContain('<span class="ro-peek-mw">');
    expect(renderReadoutPeek(FULL)).toContain('<span class="ro-peek-wind">');
    expect(renderReadoutPeek(FULL)).toContain('<span class="ro-peek-age">');
  });

  it("includes wind age in peek, not just intensity age", () => {
    const html = renderReadoutPeek(FULL);
    expect(html).toContain("40 min");
  });

  it("includes arrow in peek wind", () => {
    expect(renderReadoutPeek(FULL)).toContain("ro-arrow");
  });

  it("uses short age format (no ago suffix)", () => {
    expect(renderReadoutPeek(FULL)).not.toContain("ago");
  });

  it("survives a missing reading", () => {
    expect(renderReadoutPeek({ intensity: null, wind: FULL.wind })).not.toContain("MW");
    expect(renderReadoutPeek({ intensity: FULL.intensity, wind: null })).toContain("378 MW");
  });

  it("formats multi-day ages with d suffix in peek", () => {
    const threeDaysAgo = { ...FULL, intensity: { mw: 100, ageMinutes: 3 * 24 * 60 } };
    expect(renderReadoutPeek(threeDaysAgo)).toContain("3 d");
    expect(renderReadoutPeek(threeDaysAgo)).not.toContain("ago");
  });
});

describe("escaping and robustness", () => {
  it("guards arrow rotation against non-finite bearings", () => {
    // If bearing is NaN, rotation should fall back to 0, not produce NaNdeg
    const badBearing = { intensity: null, wind: { bearingDeg: NaN, kmh: 10, distanceKm: 5, ageMinutes: 30 } };
    const html = renderReadoutFull(badBearing);
    expect(html).toContain("rotate(0deg)");
    expect(html).not.toContain("NaN");
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
