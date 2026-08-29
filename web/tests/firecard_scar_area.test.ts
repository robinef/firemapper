/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

// See firecard_peek.test.ts's note: maplibre-gl's module load needs this
// jsdom-missing global, and the import below must stay dynamic so the
// polyfill lands first.
window.URL.createObjectURL ??= () => "";

describe("scar card burned area", () => {
  it("shows a plain figure for a FIRMS scar with a resolved footprint", async () => {
    const { scarCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = scarCardHtml({
      id: "s1",
      label: "Monchique",
      kind: "past",
      lon: -8.5,
      lat: 37.3,
      started: "2026-07-01",
      before: "2026-06-20",
      after: "2026-07-15",
      area_km2: 6.3,
      cum_cells: 9,
    } as never);
    const stats = el.textContent!;
    expect(stats).toContain("Burned area");
    expect(stats).toContain("6.3 km²");
    expect(stats).not.toContain("≤");
  });

  it("marks a single-cell FIRMS scar as an upper bound, same as a live fire", async () => {
    const { scarCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = scarCardHtml({
      id: "s2",
      label: "Speck",
      kind: "past",
      lon: 2.0,
      lat: 45.0,
      started: "2026-07-01",
      before: "2026-06-20",
      after: "2026-07-15",
      area_km2: 5.2,
      cum_cells: 1,
    } as never);
    expect(el.textContent).toContain("≤5.2 km²");
  });

  it("shows a plain figure for an EFFIS scar, which carries no cell count", async () => {
    const { scarCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = scarCardHtml({
      id: "effis-1",
      label: "Aragon · 2026",
      place: "Aragon",
      kind: "past",
      lon: -1.0,
      lat: 41.0,
      started: "2026-07-01",
      before: "2026-06-25",
      after: "2026-07-15",
      area_km2: 9.0,
      // no cum_cells — a mapped polygon, not a sensor-cell floor
    } as never);
    const stats = el.textContent!;
    expect(stats).toContain("9 km²");
    expect(stats).not.toContain("≤");
  });
});
