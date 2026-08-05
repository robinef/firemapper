/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { EventProps } from "../src/types";

// maplibre-gl's module load path calls this in a browser-like global; jsdom
// doesn't implement it. A static top-level `import ... from "../src/firecard"`
// is hoisted above this line by ES module semantics, so the load would run
// before the polyfill exists — hence the dynamic import in each test below
// (see firecard_race.test.ts's note on the same line).
window.URL.createObjectURL ??= () => "";

const props = {
  id: "abc123",
  area_km2: 41,
  started: "2026-08-01T06:00:00Z",
  status: "active",
  state: "accelerating",
  cum_cells: 12,
  freshness: { viirs: "2026-08-04T11:30:00Z", meteosat: null },
  place: { name: "Pedrógão Grande", distance_km: 3 },
} as unknown as EventProps;

describe("peek line", () => {
  it("is the card's first element, so CSS can show it alone", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = fireCardHtml(props, null);
    expect(el.firstElementChild?.className).toBe("fc-peek");
  });

  it("carries the name, the area and the status", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = fireCardHtml(props, null);
    const peek = el.querySelector(".fc-peek")!.textContent!;
    expect(peek).toContain("Pedrógão Grande");
    expect(peek).toContain("41 km²");
    expect(peek).toContain("Active");
  });

  it("escapes a place name rather than trusting it into innerHTML", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const evil = { ...props, place: { name: "<img src=x onerror=1>", distance_km: 1 } };
    expect(fireCardHtml(evil as unknown as EventProps, null)).not.toContain("<img");
  });

  it("scar cards get one too", async () => {
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
    } as never);
    expect(el.firstElementChild?.className).toBe("fc-peek");
  });
});

describe("GDACS alert link", () => {
  // The link comes from gdacs.org's RSS via enrich.py, which copies it without
  // checking the scheme. It lands in an href, so a javascript: value would run
  // in our origin on a tap — the title being escaped does nothing about that.
  const withLink = (link: string) =>
    ({ ...props, gdacs: { title: "Red alert", link } }) as unknown as EventProps;

  it("neutralises a javascript: href from the feed", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = fireCardHtml(withLink("javascript:alert(document.cookie)"), null);
    // Assert on the parsed attribute, not the string: an href surviving as
    // text in the markup is exactly the bug, and substring checks on raw HTML
    // are easy to pass by accident.
    expect(el.querySelector("a.fc-alert")!.getAttribute("href")).toBe("#");
  });

  it("neutralises data: too, and keeps ordinary https links intact", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = fireCardHtml(withLink("data:text/html,<script>1</script>"), null);
    expect(el.querySelector("a.fc-alert")!.getAttribute("href")).toBe("#");

    el.innerHTML = fireCardHtml(withLink("https://www.gdacs.org/report.aspx?eventid=1"), null);
    expect(el.querySelector("a.fc-alert")!.getAttribute("href")).toBe(
      "https://www.gdacs.org/report.aspx?eventid=1",
    );
  });

  it("does not let a quote in the href break out of the attribute", async () => {
    const { fireCardHtml } = await import("../src/firecard");
    const el = document.createElement("div");
    el.innerHTML = fireCardHtml(
      withLink(`https://gdacs.org/" onmouseover="alert(1)`),
      null,
    );
    expect(el.querySelector("a.fc-alert")!.getAttribute("onmouseover")).toBeNull();
  });
});
