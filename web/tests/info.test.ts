/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { infoHtml } from "../src/info";
import type { LayerFreshness } from "../src/freshness";
import type { Manifest } from "../src/types";

const now = new Date("2026-08-04T12:00:00Z");

const events: LayerFreshness = {
  attempted_at: "2026-08-04T11:45:00Z",
  fetched_at: "2026-08-04T11:45:00Z",
  observed_at: "2026-08-04T11:30:00Z",
  status: "ok",
  source: "VIIRS + MTG",
  max_age_s: 10800,
};

const wind: LayerFreshness = {
  attempted_at: "2026-08-04T11:45:00Z",
  fetched_at: null,
  observed_at: null,
  status: "failed",
  source: "ECMWF",
  max_age_s: 1200,
};

const manifest = {
  generated_at: "2026-08-04T11:50:00Z",
  layers: { events, wind },
} as unknown as Manifest;

describe("info view", () => {
  it("lists each layer with its source", () => {
    const html = infoHtml(manifest, now);
    expect(html).toContain("VIIRS + MTG");
    expect(html).toContain("ECMWF");
  });

  it("reports a fresh layer's age", () => {
    expect(infoHtml(manifest, now)).toContain("30 min old");
  });

  it("marks a failed layer as unavailable rather than showing a false age", () => {
    const html = infoHtml(manifest, now);
    expect(html).toContain("ECMWF unavailable");
  });

  it("always carries the emergency line — this is not an official alert", () => {
    expect(infoHtml(manifest, now)).toContain("112");
  });

  it("escapes a source name rather than trusting it into innerHTML", () => {
    const evil = {
      generated_at: "2026-08-04T11:50:00Z",
      layers: {
        events: { ...events, source: "<img src=x onerror=alert(1)>" },
      },
    } as unknown as Manifest;
    expect(infoHtml(evil, now)).not.toContain("<img");
  });

  it("says so plainly when the manifest carries no layers at all", () => {
    const bare = { generated_at: "2026-08-04T11:50:00Z" } as unknown as Manifest;
    expect(infoHtml(bare, now)).toContain("No layer information");
  });
});
