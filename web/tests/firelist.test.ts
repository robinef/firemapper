import { describe, expect, it } from "vitest";
import { buildFireIndex, renderFireList, searchFires } from "../src/firelist";

/**
 * The fire list exists because every other route into a card is positional or
 * time-boxed. A reader who remembers "the big one near Bordeaux" and nothing
 * else previously had no way in: the dot disappears 48 h after the last
 * detection, and the scar list is capped.
 */
function fire(
  id: string,
  area: number,
  opts: Partial<{ place: string; status: string; started: string; lon: number; lat: number }> = {},
) {
  const { place, status = "closed", started = "2026-07-22T04:00:00Z", lon = -0.57, lat = 44.84 } =
    opts;
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties: {
      id,
      area_km2: area,
      status,
      started,
      ...(place ? { place: JSON.stringify({ name: place, distance_km: 3 }) } : {}),
    },
  };
}

const fc = (features: unknown[]) =>
  ({ type: "FeatureCollection", features }) as unknown as GeoJSON.FeatureCollection;

describe("building the index", () => {
  it("orders by size, so a named speck cannot outrank a megafire", () => {
    const index = buildFireIndex(fc([fire("small", 0.7), fire("big", 284.9)]));
    expect(index.map((e) => e.id)).toEqual(["big", "small"]);
  });

  it("reads the nearest town out of the stringified place property", () => {
    const [e] = buildFireIndex(fc([fire("a", 10, { place: "Bordeaux" })]));
    expect(e.place).toBe("Bordeaux");
    expect(e.label).toBe("Bordeaux");
  });

  it("survives a malformed place rather than throwing mid-render", () => {
    const f = fire("a", 10);
    (f.properties as Record<string, unknown>).place = "{not json";
    expect(buildFireIndex(fc([f]))[0].place).toBeNull();
  });

  it("falls back to a DATED label, never a wall of identical names", () => {
    // Without the gazetteer every fire has place=null. "Fire" forty times over
    // is not a searchable list, which is exactly what the live past-scar
    // section looked like on 2026-08-03.
    const index = buildFireIndex(fc([
      fire("a", 9, { started: "2026-07-22T00:00:00Z" }),
      fire("b", 8, { started: "2026-07-25T00:00:00Z" }),
    ]));
    expect(index.map((e) => e.label)).toEqual(["Fire · 22 Jul 2026", "Fire · 25 Jul 2026"]);
  });

  it("skips features with no point geometry or no id", () => {
    const noId = fire("x", 1);
    delete (noId.properties as Record<string, unknown>).id;
    expect(buildFireIndex(fc([noId]))).toEqual([]);
  });
});

describe("searching", () => {
  const index = buildFireIndex(fc([
    fire("bdx", 284.9, { place: "Bordeaux", status: "closed", started: "2026-07-22T00:00:00Z" }),
    fire("ath", 12, { place: "Athens", status: "active", started: "2026-08-01T00:00:00Z" }),
  ]));

  it("finds a fire by place, case-insensitively", () => {
    expect(searchFires(index, "bordeaux").map((e) => e.id)).toEqual(["bdx"]);
  });

  it("finds by status and by date", () => {
    expect(searchFires(index, "active").map((e) => e.id)).toEqual(["ath"]);
    expect(searchFires(index, "22 jul").map((e) => e.id)).toEqual(["bdx"]);
  });

  it("shows the biggest recent fires when the box is empty", () => {
    // Opening the panel with no term should answer "what happened lately",
    // not show a blank slate.
    expect(searchFires(index, "  ").map((e) => e.id)).toEqual(["bdx", "ath"]);
  });

  it("returns nothing for a term that matches nothing", () => {
    expect(searchFires(index, "reykjavik")).toEqual([]);
  });

  it("caps how many rows it returns", () => {
    const many = buildFireIndex(fc(Array.from({ length: 100 }, (_, i) => fire(`f${i}`, i))));
    expect(searchFires(many, "", 40)).toHaveLength(40);
  });
});

describe("rendering", () => {
  const index = buildFireIndex(fc([fire("bdx", 284.9, { place: "Bordeaux" })]));

  it("gives every row the id its click needs", () => {
    expect(renderFireList(index, "", 1)).toContain('data-id="bdx"');
  });

  it("says so plainly when nothing matches", () => {
    expect(renderFireList([], "zzz", 12)).toContain("No fire matches that");
  });

  it("escapes a place name rather than trusting the manifest", () => {
    const nasty = buildFireIndex(fc([fire("x", 1, { place: "<img src=x onerror=alert(1)>" })]));
    const html = renderFireList(nasty, "", 1);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("keeps the current query in the box so typing is not reset", () => {
    expect(renderFireList(index, "bord", 1)).toContain('value="bord"');
  });
});
