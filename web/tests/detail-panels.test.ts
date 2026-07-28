import { describe, expect, it } from "vitest";
import { renderFrpPanel, renderWindPanel } from "../src/panel";

const now = new Date("2026-07-24T12:00:00Z");

describe("FRP pixel panel", () => {
  it("shows power, spread direction and the safety notice", () => {
    const html = renderFrpPanel(
      { frp: 120.5, age_min: 30, first_min: 400, n: 22, dir: 90, t: "2026-07-24T11:30:00Z" },
      now,
    );
    expect(html).toContain("120.5 MW");
    expect(html).toContain("E"); // bearing 90 → East
    expect(html).toContain("112");
    expect(html).toContain("22 observations");
  });

  it("does not claim a duration for a pixel seen once", () => {
    const html = renderFrpPanel({ frp: 22.9, age_min: 1440, first_min: 1440, n: 1, dir: null }, now);
    expect(html).toContain("Seen once");
    expect(html).not.toContain("observations");
  });

  it("says so plainly when there is no spread direction", () => {
    const html = renderFrpPanel({ frp: 10, age_min: 10, first_min: 10, n: 1, dir: null }, now);
    expect(html).toContain("No clear local spread direction");
  });
});

describe("wind panel", () => {
  it("reports the direction the wind comes FROM and flags dry air", () => {
    const html = renderWindPanel(
      { from_deg: 180, to_deg: 0, kmh: 9.8, gust_kmh: 21.6, temp_c: 31.2, rh: 24 },
      now,
    );
    expect(html).toContain("9.8 km/h");
    expect(html).toContain("S"); // from 180° = southerly
    expect(html).toContain("very dry");
    expect(html).toContain("not observed fire movement");
  });

  it("omits the dry flag in humid air", () => {
    const html = renderWindPanel(
      { from_deg: 0, to_deg: 180, kmh: 5, gust_kmh: 8, temp_c: 15, rh: 80 },
      now,
    );
    expect(html).not.toContain("very dry");
  });
});
