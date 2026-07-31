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
};

// Pinned so the clamp-to-today branch is exercised deliberately, not by
// whatever day the suite happens to run on.
const TODAY = "2026-08-10";

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
