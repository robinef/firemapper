/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { minutesAgo, mountPanel, renderAircraftPanel, renderPanel, sparklinePath } from "../src/panel";
import { emitUi, onUi } from "../src/ui_events";
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

// Regression: main.ts used to wire mountPanel("panel", () => undefined), so
// closing the aircraft panel (the only content mountPanel ever shows — the
// fire card bypasses it entirely) emitted nothing. style.css hides
// #sidebar > #layers and #legend while the mobile sheet's mode is "aircraft",
// and nothing left that mode without a detail:close announcement, so the
// layer list and every legend stayed hidden at every detent until the user
// separately opened and closed a fire card.
describe("mountPanel close wiring", () => {
  it("announces detail:close when the aircraft panel's close button is clicked", () => {
    document.body.innerHTML = `<div id="panel" class="hidden"></div>`;
    const seen: string[] = [];
    const off = onUi("detail:close", () => seen.push("close"));

    // Mirrors main.ts's real wiring exactly: mountPanel("panel", () => emitUi("detail:close")).
    const panel = mountPanel("panel", () => emitUi("detail:close"));
    panel.showHtml(renderAircraftPanel({ role: "tanker", callsign: "TEST01", type: "CL-415" }));

    const closeBtn = document.querySelector(".panel-close") as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();

    expect(seen).toEqual(["close"]);
    off();
  });
});
