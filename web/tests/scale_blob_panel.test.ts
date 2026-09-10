/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  aggregateByCountry,
  breakdownHtml,
  fetchFiresSummary,
  hideScaleBlobPanel,
  showScaleBlobPanel,
  type FiresSummary,
} from "../src/scale_blob_panel";

describe("aggregateByCountry", () => {
  it("sums area and counts fires per country", () => {
    const summary: FiresSummary = {
      "fire-a": { country: "FR", area_km2: 10 },
      "fire-b": { country: "FR", area_km2: 5 },
      "fire-c": { country: "GR", area_km2: 20 },
    };
    const rows = aggregateByCountry(summary);
    expect(rows).toEqual([
      { country: "GR", areaKm2: 20, fireCount: 1 },
      { country: "FR", areaKm2: 15, fireCount: 2 },
    ]);
  });

  it("groups a null country as Unknown", () => {
    const summary: FiresSummary = { "fire-a": { country: null, area_km2: 3 } };
    expect(aggregateByCountry(summary)).toEqual([{ country: "Unknown", areaKm2: 3, fireCount: 1 }]);
  });

  it("sorts by total area descending", () => {
    const summary: FiresSummary = {
      "fire-a": { country: "IT", area_km2: 1 },
      "fire-b": { country: "ES", area_km2: 99 },
    };
    expect(aggregateByCountry(summary).map((r) => r.country)).toEqual(["ES", "IT"]);
  });
});

describe("breakdownHtml", () => {
  it("renders one row per country with area and fire count", () => {
    const html = breakdownHtml([{ country: "FR", areaKm2: 12.3, fireCount: 2 }]);
    expect(html).toContain("FR");
    expect(html).toContain("12.3");
    expect(html).toContain("2 fires");
  });

  it("uses singular 'fire' for a count of one", () => {
    const html = breakdownHtml([{ country: "FR", areaKm2: 1, fireCount: 1 }]);
    expect(html).toContain("1 fire");
    expect(html).not.toContain("1 fires");
  });

  it("escapes an untrusted country value (GeoNames-derived data)", () => {
    const html = breakdownHtml([{ country: "<img src=x onerror=alert(1)>", areaKm2: 1, fireCount: 1 }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("says so when there are no fires yet", () => {
    expect(breakdownHtml([])).toContain("No fires");
  });
});

describe("fetchFiresSummary", () => {
  it("fetches the year's fires-summary file", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await fetchFiresSummary(2026, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("blob_2026_fires.json"));
  });

  it("returns null on a non-ok response rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(fetchFiresSummary(2026, fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });
});

describe("showScaleBlobPanel / hideScaleBlobPanel", () => {
  it("renders the breakdown into the container", async () => {
    const container = document.createElement("div");
    const summary: FiresSummary = { "fire-a": { country: "FR", area_km2: 5 } };
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => summary });

    await showScaleBlobPanel(container, 2026, fetchImpl as unknown as typeof fetch);

    expect(container.innerHTML).toContain("FR");
  });

  it("leaves the container empty when the fetch fails", async () => {
    const container = document.createElement("div");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });

    await showScaleBlobPanel(container, 2026, fetchImpl as unknown as typeof fetch);

    expect(container.innerHTML).toBe("");
  });

  it("hideScaleBlobPanel clears the container", async () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>stale content</p>";

    hideScaleBlobPanel(container);

    expect(container.innerHTML).toBe("");
  });
});
