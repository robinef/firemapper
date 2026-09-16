/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { Track } from "../src/types";
import { deriveBbox, validateDateRange, DEFAULT_RADIUS_KM, MAX_SPAN_DAYS } from "../src/historical_lookup_ui";
import {
  renderHistoricalLookupForm, renderAmbiguousResult, renderNoDataResult, runHistoricalLookup,
} from "../src/historical_lookup_ui";

describe("deriveBbox", () => {
  it("returns a west,south,east,north string centered on the point", () => {
    const bbox = deriveBbox(-1.03, 44.84, 15);
    const [west, south, east, north] = bbox.split(",").map(Number);
    expect(west).toBeLessThan(-1.03);
    expect(east).toBeGreaterThan(-1.03);
    expect(south).toBeLessThan(44.84);
    expect(north).toBeGreaterThan(44.84);
  });

  it(`defaults to ${DEFAULT_RADIUS_KM}km when no radius is given`, () => {
    const withDefault = deriveBbox(-1.03, 44.84);
    const explicit = deriveBbox(-1.03, 44.84, DEFAULT_RADIUS_KM);
    expect(withDefault).toBe(explicit);
  });

  it("stays well under the server's 0.5deg MAX_BBOX_DEG cap at the default radius", () => {
    const [west, , east] = deriveBbox(-1.03, 44.84).split(",").map(Number);
    expect(east - west).toBeLessThan(0.5);
  });

  it("widens visibly for a larger requested radius", () => {
    const [west15] = deriveBbox(-1.03, 44.84, 15).split(",").map(Number);
    const [west30] = deriveBbox(-1.03, 44.84, 30).split(",").map(Number);
    expect(west30).toBeLessThan(west15);
  });
});

describe("validateDateRange", () => {
  it("accepts a valid short range", () => {
    expect(validateDateRange("2022-07-01", "2022-07-10")).toEqual({ ok: true });
  });

  it("rejects a missing before/after", () => {
    expect(validateDateRange("", "2022-07-10")).toEqual({ ok: false, error: "pick a start date" });
    expect(validateDateRange("2022-07-01", "")).toEqual({ ok: false, error: "pick an end date" });
  });

  it("rejects before after after", () => {
    expect(validateDateRange("2022-07-10", "2022-07-01")).toEqual({
      ok: false, error: "start date must be before end date",
    });
  });

  it(`rejects a span over ${MAX_SPAN_DAYS} days, mirroring the server's own cap`, () => {
    expect(validateDateRange("2022-01-01", "2022-12-31")).toEqual({
      ok: false, error: `date range must be ${MAX_SPAN_DAYS} days or fewer`,
    });
  });
});

describe("renderHistoricalLookupForm", () => {
  it("wraps the search input in a <form>, not a bare input with no submit path", () => {
    const el = document.createElement("div");
    el.innerHTML = renderHistoricalLookupForm();
    const form = el.querySelector("form");
    expect(form).not.toBeNull();
    expect(form?.querySelector("input[type=search], input[type=text]")).not.toBeNull();
  });

  it("never wires an oninput/onkeyup attribute on the search box — compliance-critical", () => {
    const el = document.createElement("div");
    el.innerHTML = renderHistoricalLookupForm();
    const html = el.innerHTML;
    expect(html).not.toMatch(/oninput/i);
    expect(html).not.toMatch(/onkeyup/i);
    expect(html).not.toContain('autocomplete="on"');
  });

  it("has two date inputs and an explicit submit button", () => {
    const el = document.createElement("div");
    el.innerHTML = renderHistoricalLookupForm();
    expect(el.querySelectorAll('input[type="date"]')).toHaveLength(2);
    expect(el.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it("has a panel-close affordance, same convention every other panel view uses", () => {
    const el = document.createElement("div");
    el.innerHTML = renderHistoricalLookupForm();
    expect(el.querySelector(".panel-close")).not.toBeNull();
  });

  it("instructs the user they can also click the map", () => {
    const el = document.createElement("div");
    el.innerHTML = renderHistoricalLookupForm();
    expect(el.textContent).toMatch(/click.*map/i);
  });
});

describe("renderAmbiguousResult", () => {
  it("names how many distinct fires were found and invites narrowing the search", () => {
    const el = document.createElement("div");
    el.innerHTML = renderAmbiguousResult([{ cellCount: 3, rowCount: 12 }, { cellCount: 2, rowCount: 5 }]);
    expect(el.textContent).toContain("2");
    expect(el.textContent?.toLowerCase()).toMatch(/narrow|smaller|different/);
  });
});

describe("renderNoDataResult", () => {
  it("tells the user nothing was found, not a blank panel", () => {
    const el = document.createElement("div");
    el.innerHTML = renderNoDataResult();
    expect(el.textContent?.toLowerCase()).toMatch(/no|nothing/);
  });
});

const CSV_ONE_FIRE = "latitude,longitude,acq_date,acq_time,confidence,frp\n44.84,-1.03,2022-07-22,1200,n,5\n";

function deps(overrides: Partial<Parameters<typeof runHistoricalLookup>[5]> = {}) {
  return {
    fetchFn: vi.fn(async () => new Response(CSV_ONE_FIRE)),
    openHistoricalLookup: vi.fn(async () => {}),
    onAmbiguous: vi.fn(),
    onNoData: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("runHistoricalLookup", () => {
  it("rejects an invalid date range before ever calling fetch", async () => {
    const d = deps();
    await runHistoricalLookup(-1.03, 44.84, "Near Arès", "2022-07-10", "2022-07-01", d);
    expect(d.fetchFn).not.toHaveBeenCalled();
    expect(d.onError).toHaveBeenCalledWith("start date must be before end date");
  });

  it("calls /api/historical-hotspots with a derived bbox and the given dates", async () => {
    const d = deps();
    await runHistoricalLookup(-1.03, 44.84, "Near Arès", "2022-07-01", "2022-07-31", d);
    const calledUrl = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/historical-hotspots?");
    expect(calledUrl).toContain("start=2022-07-01");
    expect(calledUrl).toContain("end=2022-07-31");
    expect(calledUrl).toMatch(/bbox=-?\d+\.?\d*,-?\d+\.?\d*,-?\d+\.?\d*,-?\d+\.?\d*/);
  });

  it("opens the card on a successful single-cluster reconstruction", async () => {
    const d = deps();
    await runHistoricalLookup(-1.03, 44.84, "Near Arès", "2022-07-01", "2022-07-31", d);
    expect(d.openHistoricalLookup).toHaveBeenCalledTimes(1);
    const [track, meta] = (d.openHistoricalLookup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(track.cells.length).toBeGreaterThan(0);
    expect(meta).toEqual({ lon: -1.03, lat: 44.84, place: "Near Arès", before: "2022-07-01", after: "2022-07-31" });
  });

  it("calls onNoData for an empty result, never opening a card", async () => {
    const d = deps({ fetchFn: vi.fn(async () => new Response("latitude,longitude,acq_date,acq_time,confidence,frp\n")) });
    await runHistoricalLookup(-1.03, 44.84, "Near Arès", "2022-07-01", "2022-07-31", d);
    expect(d.onNoData).toHaveBeenCalled();
    expect(d.openHistoricalLookup).not.toHaveBeenCalled();
  });

  it("calls onAmbiguous with cluster summaries for a disjoint multi-fire result, never opening a card", async () => {
    const csv =
      "latitude,longitude,acq_date,acq_time,confidence,frp\n" +
      "44.84,-1.03,2022-07-22,1200,n,5\n" +
      "48.0,2.0,2022-07-22,1200,n,5\n"; // Bordeaux area vs Paris area — disjoint
    const d = deps({ fetchFn: vi.fn(async () => new Response(csv)) });
    await runHistoricalLookup(-1.03, 44.84, "Near Arès", "2022-07-01", "2022-07-31", d);
    expect(d.onAmbiguous).toHaveBeenCalled();
    expect(d.openHistoricalLookup).not.toHaveBeenCalled();
  });

  it("calls onError, not a silent failure, when the Worker route itself fails", async () => {
    const d = deps({ fetchFn: vi.fn(async () => new Response("nope", { status: 503 })) });
    await runHistoricalLookup(-1.03, 44.84, "Near Arès", "2022-07-01", "2022-07-31", d);
    expect(d.onError).toHaveBeenCalled();
    expect(d.openHistoricalLookup).not.toHaveBeenCalled();
  });
});
