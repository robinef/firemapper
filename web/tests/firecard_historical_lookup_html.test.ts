/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

// See firecard_peek.test.ts's note: maplibre-gl's module load needs this
// jsdom-missing global, and the import below must stay dynamic so the
// polyfill lands first.
window.URL.createObjectURL ??= () => "";

const META = { lon: -1.03, lat: 44.84, place: "Near Arès", before: "2022-07-14", after: "2022-07-30" };

function track(cellBins: [string, string[]][] | undefined, cells: string[]) {
  return { id: "lookup-1", series: [], cells, cell_bins: cellBins, frp_live: [] };
}

describe("historicalLookupCardHtml", () => {
  it("shows the place, search window, and detection count", async () => {
    const { historicalLookupCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = historicalLookupCardHtml(META, track([], ["cell-a", "cell-b"]) as never);
    const text = el.textContent!;
    expect(text).toContain("Near Arès");
    expect(text).toContain("2022-07-14");
    expect(text).toContain("2022-07-30");
    expect(text).toContain("2"); // detection cell count
  });

  it("shows the arrival-gradient legend when the track has real cell_bins", async () => {
    const { historicalLookupCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = historicalLookupCardHtml(
      META,
      track([["2022-07-22T06:00:00.000Z", ["cell-a"]]], ["cell-a"]) as never,
    );
    expect(el.querySelector(".fc-arrival")).not.toBeNull();
  });

  it("omits the arrival legend when the track has no cell_bins", async () => {
    const { historicalLookupCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = historicalLookupCardHtml(META, track(undefined, []) as never);
    expect(el.querySelector(".fc-arrival")).toBeNull();
  });

  it("never renders a share button — an ad-hoc lookup has no persisted id to share", async () => {
    const { historicalLookupCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = historicalLookupCardHtml(META, track([], ["cell-a"]) as never);
    expect(el.querySelector(".fc-share")).toBeNull();
  });

  it("still offers before/after imagery, seeded from the user's own search window", async () => {
    const { historicalLookupCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = historicalLookupCardHtml(META, track([], ["cell-a"]) as never);
    expect(el.querySelector(".fc-ba")).not.toBeNull();
  });

  it("escapes the place name — it came from a user-typed search or geocode result, not pipeline data", async () => {
    const { historicalLookupCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = historicalLookupCardHtml(
      { ...META, place: '<img src=x onerror=alert(1)>' },
      track([], ["cell-a"]) as never,
    );
    expect(el.innerHTML).not.toContain("<img");
    expect(el.querySelector("img")).toBeNull();
  });
});
