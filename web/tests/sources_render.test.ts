/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import shell from "../sources.html?raw";
import viteConfig from "../vite.config.ts?raw";
import entrySource from "../src/sources.ts?raw";
import renderSource from "../src/sources_render.ts?raw";
import infoSource from "../src/info.ts?raw";

import { renderSources } from "../src/sources_render";
import type { LayerFreshness } from "../src/freshness";
import type { Manifest } from "../src/types";

const now = new Date("2026-08-04T12:00:00Z");

function layer(source: string): LayerFreshness {
  return {
    attempted_at: "2026-08-04T11:45:00Z",
    fetched_at: "2026-08-04T11:45:00Z",
    observed_at: "2026-08-04T11:30:00Z",
    status: "ok",
    source,
    max_age_s: 10800,
  };
}

const MANIFEST: Manifest = {
  schema_version: "1.0",
  generated_at: "2026-08-04T11:50:00Z",
  generation: "gen-1",
  tiers: [],
  layers: {
    events: layer("viirs+mtg"),
    frp: layer("mtg-fci"),
    wind: layer("open-meteo"),
    timeline: layer("archive"),
    imagery: layer("gibs+effis"),
  },
  coverage: {
    live_window_hours: 48,
    firms_lookback_days: 7,
    scar_window_days: 30,
    archive_floor_date: "2024-01-01",
    effis_note: "EFFIS perimeters lag detections by a few days.",
  },
} as unknown as Manifest;

function root(): HTMLElement {
  return document.createElement("div");
}

describe("renderSources", () => {
  it("names the real provider behind each layer, not just the manifest's raw source key", () => {
    const el = root();
    renderSources(el, MANIFEST, now);
    expect(el.textContent).toContain("NASA FIRMS");
    expect(el.textContent).toContain("EUMETSAT Meteosat Third Generation");
    expect(el.textContent).toContain("Open-Meteo");
    expect(el.textContent).toContain("NASA GIBS + EFFIS");
  });

  it("links out to each provider's own site", () => {
    const el = root();
    renderSources(el, MANIFEST, now);
    const hrefs = Array.from(el.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://firms.modaps.eosdis.nasa.gov/");
    expect(hrefs).toContain("https://open-meteo.com/");
  });

  it("has no external link for FireMapper's own archive", () => {
    const el = root();
    renderSources(el, MANIFEST, now);
    const archiveRow = Array.from(el.querySelectorAll(".src-row")).find((r) =>
      r.textContent?.includes("FireMapper archive"),
    );
    expect(archiveRow?.querySelector("a")).toBeNull();
  });

  it("shows each layer's age, reusing the same freshness rules as the info panel", () => {
    const el = root();
    renderSources(el, MANIFEST, now);
    expect(el.textContent).toContain("30 min old");
  });

  it("marks a failed layer as unavailable rather than a false age", () => {
    const el = root();
    renderSources(el, { ...MANIFEST, layers: { events: { ...layer("viirs+mtg"), fetched_at: null, observed_at: null, status: "failed" } } }, now);
    expect(el.textContent).toContain("unavailable");
  });

  it("shows the same 'how far back' coverage numbers as the info panel", () => {
    const el = root();
    renderSources(el, MANIFEST, now);
    const text = el.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("last ~48h");
    expect(text).toContain("7 days");
    expect(text).toContain("from 2024-01-01");
  });

  it("always carries the emergency line — this is not an official alert", () => {
    const el = root();
    renderSources(el, MANIFEST, now);
    expect(el.textContent).toContain("112");
  });

  it("says so plainly, without a fabricated table, when there is no manifest at all", () => {
    const el = root();
    renderSources(el, null, now);
    expect(el.textContent).toContain("unavailable");
    expect(el.querySelector(".src-row")).toBeNull();
    // Still not an alert system even when the data feed itself failed.
    expect(el.textContent).toContain("112");
  });

  it("escapes a raw source string it does not recognise, rather than trusting it into innerHTML", () => {
    const el = root();
    renderSources(el, { ...MANIFEST, layers: { events: layer("<img src=x onerror=alert(1)>") } }, now);
    expect(el.innerHTML).not.toContain("<img");
  });
});

/**
 * Same build-time hazard as /scale (vite.config.ts's own comment on this):
 * wrangler.jsonc's not_found_handling is "single-page-application", so a page
 * that fails to build is not a 404 — it is served as index.html, the map,
 * with a 200. These guard the three ways this page can silently cease to
 * exist: the entry dropped, the mount point drifting, and the last link to it
 * disappearing.
 */
describe("sources page shell", () => {
  it("declares sources.html as a build entry, so it is emitted at all", () => {
    // Matched on the entry declaration, not the bare filename — see the same
    // guard's comment in scale_render.test.ts for why a substring check on the
    // filename alone would still pass with the entry itself deleted.
    expect(viteConfig).toMatch(/\bsources:\s*entry\(\s*["']\.\/sources\.html["']\s*\)/);
  });

  it("mounts the root that sources.ts renders into", () => {
    expect(shell).toContain('id="sources"');
    expect(shell).toContain("/src/sources.ts");
  });

  it("is not the map shell", () => {
    expect(shell).not.toContain('id="map"');
  });

  it("never imports maplibre", () => {
    expect(renderSource).not.toContain("maplibre");
    expect(entrySource).not.toContain("maplibre");
  });

  it("is linked from the info panel, or it is unreachable", () => {
    // Unlike /scale, this page was deliberately NOT given a rail icon — the
    // user asked for the link to live inside the (i) panel's own content.
    // Checking index.html's rail here would pass even if info.ts's link were
    // deleted, so this checks info.ts's source directly.
    expect(infoSource).toMatch(/href="\/sources"/);
  });
});
