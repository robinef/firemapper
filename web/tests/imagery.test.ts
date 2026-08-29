import { describe, expect, it } from "vitest";
import {
  GIBS_MAX_Z,
  GIBS_TILE_PX,
  GIBS_TRUE_COLOR_LAYERS,
  MAX_DAY_RETRIES,
  gibsTiles,
  pickCapture,
  probeUrl,
  rasterFit,
  scarTiles,
  shiftAfter,
  tileScore,
  tileXY,
  type ImageryConfig,
  type ProbeTile,
  type Scar,
  scarFromClick,
} from "../src/layer_imagery";

const scar: Scar = {
  id: "e1",
  label: "Test scar",
  kind: "past",
  lon: -1.16,
  lat: 44.66,
  started: "2026-07-20",
  before: "2026-07-14",
  after: "2026-08-03",
  area_km2: 4.2,
};

// Pinned so the clamp-to-today branch is exercised deliberately, not by
// whatever day the suite happens to run on.
const TODAY = "2026-08-04";

const gibsCfg: ImageryConfig = {
  source: "gibs",
  gibs_layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
  hd: null,
  scars: [],
};

describe("GIBS raster fit", () => {
  // GIBS serves 256 px tiles; declaring 512 makes MapLibre stretch each image
  // over a 512 px slot AND request one matrix too coarse — a 4x blur.
  it("matches the tiles GIBS actually serves", () => {
    expect(GIBS_TILE_PX).toBe(256);
    // GoogleMapsCompatible_Level9 runs 0..9. z10 is an HTTP 400, z9 is native.
    expect(GIBS_MAX_Z).toBe(9);
  });

  it("never flies past the deepest tile the source has", () => {
    const fit = rasterFit(gibsCfg);
    expect(fit.tileSize).toBe(256);
    expect(fit.maxzoom).toBe(9);
    expect(fit.zoom).toBeLessThanOrEqual(fit.maxzoom);
  });

  it("goes deeper on the 10 m HD source", () => {
    const fit = rasterFit({ ...gibsCfg, hd: { wms_base: "x", layer: "y" } });
    expect(fit.tileSize).toBe(512);
    expect(fit.maxzoom).toBeGreaterThan(GIBS_MAX_Z);
    expect(fit.zoom).toBeLessThanOrEqual(fit.maxzoom);
  });

  it("asks for the exact day, as a JPEG, from the Level9 matrix set", () => {
    const [u] = gibsTiles(gibsCfg.gibs_layer, "2026-07-24");
    expect(u).toContain("/2026-07-24/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg");
  });
});

/**
 * A fake tile: alternating columns at 0 and `detail`, with `cloudRows` of the
 * rows painted pure white so the cloud discount has something to bite on.
 */
function fakeTile(detail: number, cloudRows = 0): NonNullable<ProbeTile> {
  const width = 4;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = y < cloudRows ? 255 : x % 2 ? detail : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Probe stub: `have` maps "layer@day" to [detail, cloudRows]; absent keys 404. */
function stubProbe(have: Record<string, number | [number, number]>) {
  const calls: string[] = [];
  const probe = async (url: string): Promise<ProbeTile> => {
    const [, layer, day] = url.match(/best\/([^/]+)\/default\/([\d-]+)\//)!;
    const key = `${layer}@${day}`;
    calls.push(key);
    if (!(key in have)) return null;
    const v = have[key];
    return Array.isArray(v) ? fakeTile(v[0], v[1]) : fakeTile(v);
  };
  return { probe, calls };
}

const TERRA = GIBS_TRUE_COLOR_LAYERS[0];
const AQUA = GIBS_TRUE_COLOR_LAYERS[1];

describe("picking what to mount", () => {
  // Three failures, one probe pass. GIBS 404s a day it does not hold (MODIS
  // Terra drops whole days — 2026-07-24 over Basilicata, and the layer
  // capabilities list 2025-08-09 and 2025-11-09), and MapLibre discards a 404
  // raster tile WITHOUT firing `error`, so the half renders empty with nothing
  // to explain it. Separately a pass can be too off-nadir to read, or clouded.
  it("probes the tile that actually covers the scar", () => {
    // The exact tile the browser 404'd on for 2026-07-24 over Basilicata.
    expect(tileXY(16.2219, 40.6231, 9)).toEqual({ x: 279, y: 192 });
    expect(probeUrl(gibsTiles(TERRA, "2026-07-24")[0], 16.2219, 40.6231, 9)).toContain(
      "/GoogleMapsCompatible_Level9/9/192/279.jpg",
    );
  });

  it("scores a crisp tile above a smeared one", () => {
    expect(tileScore(fakeTile(90))).toBeGreaterThan(tileScore(fakeTile(10)));
    expect(tileScore(fakeTile(0))).toBe(0);
  });

  it("discounts cloud, so cloud edges cannot pass for ground detail", () => {
    // Basilicata, 2026-07-22: Aqua out-detailed a clear Terra pass (6.24 vs
    // 5.09) purely on the edges of the quarter-tile of cloud sitting on it.
    expect(tileScore(fakeTile(90, 2))).toBeLessThan(tileScore(fakeTile(60, 0)));
  });

  it("keeps the requested day when it exists, and takes the sharper sensor", async () => {
    const { probe } = stubProbe({ [`${TERRA}@2026-07-14`]: 19, [`${AQUA}@2026-07-14`]: 28 });
    expect(await pickCapture("2026-07-14", 16.2, 40.6, 9, TERRA, -1, probe)).toEqual({
      date: "2026-07-14",
      layer: AQUA,
    });
  });

  it("reaches past a day GIBS does not hold at all", async () => {
    const { probe, calls } = stubProbe({ [`${TERRA}@2026-07-12`]: 20 });
    expect(await pickCapture("2026-07-14", 16.2, 40.6, 9, TERRA, -1, probe)).toEqual({
      date: "2026-07-12",
      layer: TERRA,
    });
    expect(calls.filter((c) => c.startsWith(TERRA))).toContain(`${TERRA}@2026-07-14`);
  });

  it("prefers a clearly better neighbour over a poor day that does answer", async () => {
    const { probe } = stubProbe({
      [`${AQUA}@2026-07-14`]: [90, 3], // answers, but almost all cloud
      [`${TERRA}@2026-07-13`]: 80, // clear
    });
    expect(await pickCapture("2026-07-14", 16.2, 40.6, 9, TERRA, -1, probe)).toEqual({
      date: "2026-07-13",
      layer: TERRA,
    });
  });

  it("keeps the requested day when a neighbour is only marginally better", async () => {
    const { probe } = stubProbe({
      [`${TERRA}@2026-07-14`]: 80,
      [`${TERRA}@2026-07-13`]: 84, // +5%, inside the recency pull
    });
    expect((await pickCapture("2026-07-14", 16.2, 40.6, 9, TERRA, -1, probe)).date).toBe(
      "2026-07-14",
    );
  });

  it("extends the window forward when asked — through cloud, not back into it", async () => {
    const { probe } = stubProbe({ [`${AQUA}@2026-07-16`]: 20 });
    expect(await pickCapture("2026-07-14", 16.2, 40.6, 9, TERRA, 1, probe)).toEqual({
      date: "2026-07-16",
      layer: AQUA,
    });
  });

  it("bounds the probe and mounts what it was asked for when nothing answers", async () => {
    const { probe, calls } = stubProbe({});
    expect(await pickCapture("2026-07-14", 16.2, 40.6, 9, TERRA, -1, probe)).toEqual({
      date: "2026-07-14",
      layer: TERRA,
    });
    expect(calls).toHaveLength((MAX_DAY_RETRIES + 1) * GIBS_TRUE_COLOR_LAYERS.length);
  });

  it("feeds the chosen layer through to the mounted tiles", async () => {
    const t = scarTiles(gibsCfg, scar, { after: { date: scar.after, layer: AQUA } });
    expect(t.after[0]).toContain(AQUA);
    expect(t.before[0]).toContain(gibsCfg.gibs_layer); // unpicked side untouched
  });
});

describe("stepping the after day past cloud", () => {
  it("walks the after capture back and forward a day at a time", () => {
    expect(shiftAfter(scar, -1, TODAY).after).toBe("2026-08-02");
    expect(shiftAfter(shiftAfter(scar, -1, TODAY), 1, TODAY).after).toBe("2026-08-03");
  });

  it("never steps before the fire started — there is no scar yet", () => {
    const s = { ...scar, after: scar.started };
    expect(shiftAfter(s, -1, TODAY).after).toBe(scar.started);
  });

  it("never steps past today — GIBS has no future imagery", () => {
    const s = { ...scar, after: TODAY };
    expect(shiftAfter(s, 1, TODAY).after).toBe(TODAY);
  });

  it("leaves every other field of the scar alone", () => {
    const s = shiftAfter(scar, -1, TODAY);
    expect({ ...s, after: scar.after }).toEqual(scar);
  });
});

describe("dates survive the trip from map click to compare button", () => {
  // MapLibre deletes `event.features` the moment a delegated layer handler
  // returns, so the card's button — clicked much later — used to receive an
  // event with nothing on it. The scar path died silently; the fire path fell
  // back to "ignited yesterday" and dated the baseline off the wrong day.
  it("dates a fire from its own ignition, not from yesterday", () => {
    const s = scarFromClick({
      props: { id: "e9", started: "2026-07-29T04:00:00Z", status: "active", name: "Matera" },
      lon: 16.2219,
      lat: 40.6231,
    });
    expect(s.started).toBe("2026-07-29");
    expect(s.before).toBe("2026-07-23"); // ignition − 6 d, the pre-fire baseline
    expect(s.label).toBe("Matera");
    expect(s.lon).toBeCloseTo(16.2219);
  });

  it("still degrades sanely when a footprint carries no lifecycle props", () => {
    const s = scarFromClick({ props: {}, lon: 1, lat: 2 });
    expect(s.kind).toBe("active");
    expect(s.before < s.started).toBe(true);
  });
});

/** Read the TIME range out of a Sentinel Hub WMS tile template. */
function timeRange(url: string): [string, string] {
  const t = decodeURIComponent(new URL(url, "https://x").searchParams.get("TIME")!);
  return t.split("/") as [string, string];
}

const HD = { ...gibsCfg, hd: { wms_base: "/hd", layer: "TRUE_COLOR" } };

const day = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const span = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** A scar as the pipeline would emit it: before = ignition-6, after =
 * min(ignition+14, yesterday), clamped to >= ignition. Mirrors _scar_dates. */
function scarAged(ageDays: number, kind: "past" | "active" = "past"): Scar {
  const started = day(TODAY, -ageDays);
  const yesterday = day(TODAY, -1);
  const settled = day(started, 14);
  const after = kind === "active" ? yesterday : settled < yesterday ? settled : yesterday;
  return {
    id: "s", label: "s", kind, lon: -1, lat: 44.8, started,
    before: day(started, -6),
    after: after < started ? started : after,
    area_km2: 3.5,
  };
}

describe("HD search windows", () => {
  // Sentinel Hub picks a scene from a TIME range, so where that range sits
  // decides what the comparison shows. Two invariants, both learned the hard
  // way, and an earlier fix broke each while fixing the other.
  const AGES = [0, 1, 2, 5, 13, 14, 15, 16, 19, 20, 30, 400];

  it("never puts a pre-fire scene in the after slot, at any fire age", () => {
    // The hard one. A window reaching before ignition shows unburned ground
    // captioned as the scar.
    for (const kind of ["past", "active"] as const) {
      for (const age of AGES) {
        const scar = scarAged(age, kind);
        const [from] = timeRange(scarTiles(HD, scar, undefined, TODAY).after[0]);
        expect(from >= scar.started, `age ${age} ${kind}: ${from} < ${scar.started}`).toBe(true);
      }
    }
  });

  it("never emits an inverted or future range", () => {
    // An inverted TIME is not an error to Sentinel Hub — it returns an empty
    // tile, which MapLibre renders as a silent blank half. Age 0 produced
    // exactly that before this fix.
    for (const kind of ["past", "active"] as const) {
      for (const age of AGES) {
        const [from, to] = timeRange(scarTiles(HD, scarAged(age, kind), undefined, TODAY).after[0]);
        expect(from <= to, `age ${age} ${kind}: inverted ${from}/${to}`).toBe(true);
        expect(to <= TODAY, `age ${age} ${kind}: future ${to}`).toBe(true);
      }
    }
  });

  it("keeps the window as wide as the fire's own age permits", () => {
    // Sentinel-2 revisits every 2-3 days and cloud removes more, so a narrow
    // window often holds no pass and renders black. It may only be narrow when
    // the fire is too young for a wider one to exist without crossing ignition.
    for (const age of AGES) {
      const scar = scarAged(age);
      const [from, to] = timeRange(scarTiles(HD, scar, undefined, TODAY).after[0]);
      const available = span(scar.started, TODAY);
      expect(span(from, to), `age ${age}`).toBe(Math.min(12, available));
    }
  });

  it("slides the window as late as it can, so an old scar is fully settled", () => {
    // A 30-day-old scar has plenty of post-settle imagery; the window must use
    // it rather than opening near ignition.
    const scar = scarAged(30);
    const [from] = timeRange(scarTiles(HD, scar, undefined, TODAY).after[0]);
    expect(span(scar.started, from)).toBeGreaterThanOrEqual(14); // past SCAR_SETTLE_DAYS
  });

  it("keeps the pre-fire baseline entirely before ignition, at any age", () => {
    for (const age of AGES) {
      const scar = scarAged(age);
      const [, to] = timeRange(scarTiles(HD, scar, undefined, TODAY).before[0]);
      expect(to <= scar.started, `age ${age}: baseline ends ${to}`).toBe(true);
    }
  });

  it("holds every invariant while the reader steps the after date", () => {
    // step() shifts scar.after; an earlier version had a cliff where one click
    // on the next-day button moved the searched interval 11 days backwards.
    let scar = scarAged(30);
    for (let i = 0; i < 12; i++) {
      scar = shiftAfter(scar, -1, TODAY);
      const [from, to] = timeRange(scarTiles(HD, scar, undefined, TODAY).after[0]);
      expect(from >= scar.started).toBe(true);
      expect(from <= to).toBe(true);
      expect(to <= TODAY).toBe(true);
    }
  });

  it("stepping a recently-settled scar actually changes the search window", () => {
    // A fire settled within the last windowDays(12) has `after + 12 >= today`,
    // so the default "slide forward, capped at today" rule pins `end` at
    // `today` regardless of `after` — every step would re-query the
    // byte-identical window otherwise. Reproduced live: Mont-de-Marsan
    // (started 2026-08-23, TODAY 2026-08-28) queried
    // TIME=2026-08-23/2026-08-28 on first load AND after clicking step,
    // byte-identical, so Sentinel Hub returned the same scene both times.
    // The `stepping` flag (scarTiles's last arg) is what main.ts's step()
    // passes to fix this — end the window exactly at the stepped date.
    let scar = scarAged(5); // settled ~5 days ago — squarely in the collapsed zone
    const windows = new Set<string>();
    for (let i = 0; i < 6; i++) {
      windows.add(scarTiles(HD, scar, undefined, TODAY, true).after[0]);
      scar = shiftAfter(scar, -1, TODAY);
    }
    expect(windows.size).toBeGreaterThan(1);
  });

  it("without the stepping flag, still slides late (settle()'s own default behaviour)", () => {
    // Confirms the fix is additive: an ordinary (non-stepping) call for a
    // recently-settled scar keeps sliding the window to today, unchanged.
    const scar = scarAged(5);
    const [, to] = timeRange(scarTiles(HD, scar, undefined, TODAY).after[0]);
    expect(to).toBe(TODAY);
  });

  it("cannot emit an inverted range even from a malformed scar", () => {
    // scarFromProps (main.ts) builds a Scar from marker properties without
    // validating their order, so a bad manifest entry can carry started > after.
    // An inverted TIME is not an error to Sentinel Hub — it returns an empty
    // tile, i.e. another silent blank half.
    const bad: Scar = {
      id: "s", label: "s", kind: "past", lon: -1, lat: 44.8,
      started: "2026-08-01", before: "2026-07-01", after: "2026-07-10",
      area_km2: 1.0,
    };
    const [from, to] = timeRange(scarTiles(HD, bad, undefined, TODAY).after[0]);
    expect(from <= to).toBe(true);
  });

  it("leaves the MODIS tier untouched", () => {
    const scar = scarAged(30);
    const t = scarTiles(gibsCfg, scar, undefined, TODAY);
    expect(t.before[0]).toContain(scar.before);
    expect(t.after[0]).toContain(scar.after);
    expect(t.after[0]).not.toContain("TIME=");
  });
});
