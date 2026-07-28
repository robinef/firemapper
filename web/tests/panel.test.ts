import { describe, expect, it } from "vitest";
import { minutesAgo, renderPanel, sparklinePath } from "../src/panel";
import type { EventProps, Track } from "../src/types";

const props: EventProps = {
  id: "abc",
  status: "active",
  lifecycle_age_h: 2,
  started: "2026-07-20T00:00:00Z",
  area_km2: 12.6,
  cum_cells: 18,
  movement: { bearing_deg: 45, distance_24h_m: 2100, path_total_m: 4000 },
  state: "accelerating",
  freshness: { viirs: "2026-07-20T11:48:00Z", meteosat: "2026-07-20T11:58:00Z" },
  place: { name: "Testville", distance_km: 3.2 },
  gdacs: { title: "Wildfire", link: "https://x" },
  reactivation_of: null,
  merged_into: null,
};

const track: Track = {
  id: "abc",
  series: [
    { bin: "2026-07-20T00:00:00Z", centroid: [45, 8], new_cells: 2, cum_cells: 2, frp_sum: 10 },
    { bin: "2026-07-20T06:00:00Z", centroid: [45.02, 8], new_cells: 16, cum_cells: 18, frp_sum: 90 },
  ],
  cells: [],
  frp_live: [],
};

const now = new Date("2026-07-20T12:00:00Z");

describe("panel", () => {
  it("shows ACCELERATING badge, movement, place, safety notice", () => {
    const html = renderPanel(props, track, now);
    expect(html).toContain("ACCELERATING");
    expect(html).toContain("112");
    expect(html).toContain("Testville");
    expect(html).toContain("heading");
  });
  it("hides movement when null", () => {
    const html = renderPanel({ ...props, movement: null }, track, now);
    expect(html).toContain("No clear movement");
  });
  it("minutesAgo computes", () => {
    expect(minutesAgo("2026-07-20T11:48:00Z", now)).toBe(12);
  });
  it("sparkline has points", () => {
    expect(sparklinePath(track, 100, 30)).toMatch(/\d/);
  });
});
