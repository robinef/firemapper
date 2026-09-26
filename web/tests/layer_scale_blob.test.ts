// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateScaleBlob,
  bandLabel,
  blobLabel,
  deactivateScaleBlob,
  isScaleBlobActive,
  onScaleBlobSelection,
  scaleBlobSelection,
  selectScaleBlobBand,
} from "../src/layer_scale_blob";
import type { FiresSummary } from "../src/types";
import type * as maplibregl from "maplibre-gl";

/**
 * Stub map, following the style of tests/registry.test.ts and
 * tests/layer_imagery_drag.test.ts.
 *
 * layer_scale_blob.ts talks to the DOM canvas directly (native
 * pointerdown/pointermove/pointerup/pointercancel via addEventListener +
 * setPointerCapture), not via map.on(...) — see task-9-brief.md's resolved
 * decision. So getCanvas() here returns a REAL <canvas> jsdom element,
 * letting these tests dispatch real PointerEvents and exercise the actual
 * listener wiring instead of re-implementing it against a stand-in.
 */
/** `hit`: false = the press misses the shape; true = it lands on the FR band;
 * a string = it lands on that band. */
type Hit = boolean | string;

function stubMap(opts: { center?: { lat: number; lng: number }; hit?: Hit; parisInView?: boolean } = {}) {
  const sources: Record<string, any> = {};
  const layers: string[] = [];
  const layerDefs: Record<string, any> = {};
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  // jsdom does not implement pointer capture — stub it out like
  // layer_imagery_drag.test.ts does for the swipe divider.
  (canvas as any).setPointerCapture = vi.fn();
  (canvas as any).releasePointerCapture = vi.fn();

  let hit: Hit = opts.hit ?? true;
  const dragPan = {
    _enabled: true,
    enable: vi.fn(function (this: any) {
      this._enabled = true;
    }),
    disable: vi.fn(function (this: any) {
      this._enabled = false;
    }),
    isEnabled: vi.fn(function (this: any) {
      return this._enabled;
    }),
  };

  const map = {
    _sources: sources,
    _layers: layers,
    getSource: (id: string) => sources[id],
    addSource: (id: string, def: any) => {
      sources[id] = { ...def, setData: vi.fn((data: any) => { sources[id].data = data; }) };
    },
    addLayer: (def: any) => {
      layers.push(def.id);
      layerDefs[def.id] = def;
    },
    getLayerDef: (id: string) => layerDefs[id],
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    removeLayer: (id: string) => {
      const i = layers.indexOf(id);
      if (i >= 0) layers.splice(i, 1);
    },
    removeSource: (id: string) => {
      delete sources[id];
    },
    getCanvas: () => canvas,
    getCenter: () => opts.center ?? { lat: 45.0, lng: 5.0 },
    // In view unless the test says otherwise.
    getBounds: () => ({ contains: () => opts.parisInView ?? true }),
    easeTo: vi.fn(),
    // Deterministic, purely-numeric pixel->lngLat mapping (and its exact
    // inverse) — not real geography, but exact and easy to hand-verify in
    // assertions, and round-trips cleanly for commitDrag's project+unproject.
    unproject: (p: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(p) ? p : [p.x, p.y];
      return { lng: x / 1000, lat: y / 1000 };
    },
    project: (lngLat: [number, number] | { lng: number; lat: number }) => {
      const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
      return { x: lng * 1000, y: lat * 1000 };
    },
    setPaintProperty: vi.fn((id: string, prop: string, value: unknown) => {
      layerDefs[id].paint[prop] = value;
    }),
    queryRenderedFeatures: vi.fn(() => (hit === false ? [] : [{ properties: { country: hit === true ? "FR" : hit } }])),
    dragPan,
    _setHit: (v: Hit) => {
      hit = v;
    },
  };
  return map as unknown as maplibregl.Map & { _setHit: (v: Hit) => void; dragPan: typeof dragPan; getCanvas: () => HTMLCanvasElement };
}

const sample: FiresSummary = {
  "fire-1": { country: "FR", area_km2: 30 },
  "fire-2": { country: "ES", area_km2: 12 },
  // Outside the blob's EU-27 scope: an unplaced fire, and a non-member.
  "fire-3": { country: null, area_km2: 1 },
  "fire-4": { country: "UA", area_km2: 500 },
};

function okFetch(summary: FiresSummary = sample) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => summary });
}

function dispatch(target: EventTarget, type: string, init: PointerEventInit) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
}

/** The stub source's `.data` isn't part of maplibre-gl's real `Source`
 * type — this narrows through `any` for test assertions only. */
function blobSource(map: maplibregl.Map): { data: GeoJSON.FeatureCollection; setData: ReturnType<typeof vi.fn> } {
  return (map as any).getSource("scale-blob");
}

function layerDef(map: maplibregl.Map, id: string): any {
  return (map as any).getLayerDef(id);
}

async function activated(opts: { hit?: Hit } = {}) {
  const map = stubMap(opts);
  await activateScaleBlob(map, 2026, okFetch() as unknown as typeof fetch);
  return { map, canvas: map.getCanvas() };
}

beforeEach(() => {
  deactivateScaleBlob(stubMap());
});

describe("activateScaleBlob", () => {
  it("builds the shape from the year's fires summary — one feature per country band, not per hex", async () => {
    const map = stubMap();
    const fetchImpl = okFetch();

    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("blob_2026_fires.json"));
    expect(isScaleBlobActive()).toBe(true);
    const features = blobSource(map).data.features;
    // EU-27 only: UA (the biggest) and the unplaced fire are left out.
    expect(features.map((f) => f.properties!.country)).toEqual(["FR", "ES"]);
    expect(features.every((f) => f.geometry.type === "MultiPolygon")).toBe(true);
  });

  it("brings Paris into view when the reader is looking elsewhere, and leaves the camera alone when not", async () => {
    const away = stubMap({ parisInView: false });
    await activateScaleBlob(away, 2026, okFetch() as unknown as typeof fetch);
    expect((away as any).easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [2.3522, 48.8566] }));
    deactivateScaleBlob(away);

    const { map } = await activated();
    expect((map as any).easeTo).not.toHaveBeenCalled();
  });

  it("lands the shape and its label on Paris, wherever the viewport is", async () => {
    const { map } = await activated();
    const label = (map as any).getSource("scale-blob-label").data.features[0];
    expect(label.geometry.coordinates).toEqual([2.3522, 48.8566]);
    expect(label.properties.text).toContain("EU-27 fires, 2026 · 42 km² detected");
    // The centre band surrounds the drop point.
    const ring = (blobSource(map).data.features[0].geometry as GeoJSON.MultiPolygon).coordinates[0][0];
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    expect(Math.min(...lons)).toBeLessThan(2.3522);
    expect(Math.max(...lons)).toBeGreaterThan(2.3522);
    expect(Math.min(...lats)).toBeLessThan(48.8566);
    expect(Math.max(...lats)).toBeGreaterThan(48.8566);
  });

  it("uses the summary it is given without fetching", async () => {
    const map = stubMap();
    const fetchImpl = okFetch();
    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch, Promise.resolve(sample));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isScaleBlobActive()).toBe(true);
  });

  it("does not re-fetch on a second activation while already active", async () => {
    const map = stubMap();
    const fetchImpl = okFetch();
    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not double-fetch or double-add-source when two calls overlap before either resolves", async () => {
    const map = stubMap();
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<FiresSummary> }) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const addSourceSpy = vi.spyOn(map, "addSource");

    const first = activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    const second = activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    resolveFetch({ ok: true, json: async () => sample });
    // A real maplibre map throws from addSource on a duplicate id, so an
    // unguarded second call would reject here.
    await expect(Promise.all([first, second])).resolves.toBeDefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(addSourceSpy).toHaveBeenCalledTimes(2); // shape + label, once each
    expect(isScaleBlobActive()).toBe(true);
  });

  it("does nothing and leaves isScaleBlobActive false when the fetch response is not ok", async () => {
    const map = stubMap();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => sample });
    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    expect(isScaleBlobActive()).toBe(false);
    expect(map.getSource("scale-blob")).toBeUndefined();
  });

  it("does nothing for a year with no fires", async () => {
    const map = stubMap();
    await activateScaleBlob(map, 2026, okFetch({}) as unknown as typeof fetch);
    expect(isScaleBlobActive()).toBe(false);
    expect(map.getSource("scale-blob")).toBeUndefined();
  });
});

describe("blobLabel", () => {
  it("quotes the real detected area, rounded, and says the shape can be dragged", () => {
    expect(blobLabel(2026, { a: { country: "FR", area_km2: 162_812.4 } })).toBe(
      "EU-27 fires, 2026 · 162,800 km² detected\nDrag to compare",
    );
    expect(blobLabel(2026, { a: { country: "FR", area_km2: 42.4 } })).toContain("42 km²");
  });
});

/** Label position — the drop point — as [lng, lat]. */
function labelAt(map: maplibregl.Map): [number, number] {
  return (map as any).getSource("scale-blob-label").data.features[0].geometry.coordinates;
}

describe("press-and-drag", () => {
  // Drag frames are rAF-coalesced; run them by hand.
  let frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(0));
  };
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return () => vi.unstubAllGlobals();
  });

  it("a press on the shape starts the drag at once — no select step first", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 40, clientY: 25 });
    flushFrames();
    // The stub's project/unproject are x/1000, y/1000: +30 px → +0.03°, +15 px → +0.015°
    // from Paris, where the blob lands.
    const [lng, lat] = labelAt(map);
    expect(lng).toBeCloseTo(2.3822, 9);
    expect(lat).toBeCloseTo(48.8716, 9);
  });

  it("moves the real geometry, not a paint offset maplibre clips at tile edges", async () => {
    const { map, canvas } = await activated();
    const before = (blobSource(map).data.features[0].geometry as GeoJSON.MultiPolygon).coordinates[0][0][0];
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 110, clientY: 10 });
    flushFrames();
    const after = (blobSource(map).data.features[0].geometry as GeoJSON.MultiPolygon).coordinates[0][0][0];
    expect(after[0] - before[0]).toBeCloseTo(0.1, 9);
    expect(layerDef(map, "scale-blob-fill").paint["fill-translate"]).toBeUndefined();
  });

  it("updates the geometry once per frame, however many pointermoves arrive", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    for (let x = 11; x < 60; x++) dispatch(canvas, "pointermove", { pointerId: 1, clientX: x, clientY: 10 });
    expect(frames).toHaveLength(1);
    flushFrames();
    expect(blobSource(map).setData).toHaveBeenCalledTimes(1);
    expect(labelAt(map)[0]).toBeCloseTo(2.4012, 9);
  });

  it("dropping places the shape at the exact release point", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 60, clientY: 30 });
    flushFrames();
    // Released further on, before another frame ran.
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 110, clientY: 60 });
    const [lng, lat] = labelAt(map);
    expect(lng).toBeCloseTo(2.4522, 9);
    expect(lat).toBeCloseTo(48.9066, 9);
    // ...and a later pointermove moves nothing: the drag is over.
    dispatch(canvas, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 300 });
    flushFrames();
    expect(labelAt(map)[0]).toBeCloseTo(2.4522, 9);
  });

  it("a press without movement does not recompute the geometry", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 11, clientY: 11 });
    flushFrames();
    expect(blobSource(map).setData).not.toHaveBeenCalled();
  });

  it("a press off the shape is left to the map — no drag, no dragPan suppression", async () => {
    const { map, canvas } = await activated({ hit: false });
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 60, clientY: 60 });
    flushFrames();
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 60, clientY: 60 });
    expect(map.dragPan.disable).not.toHaveBeenCalled();
    expect(blobSource(map).setData).not.toHaveBeenCalled();
  });

  it("hit-tests a small box around the press, not the exact pixel — a press can land on a band seam", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    const [box] = (map.queryRenderedFeatures as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(box).toEqual([[7, 7], [13, 13]]);
  });

  it("suppresses map dragPan while dragging and restores it on release", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    expect(map.dragPan.isEnabled()).toBe(false);
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 30, clientY: 30 });
    expect(map.dragPan.isEnabled()).toBe(true);
  });

  it("brightens the shape while it is held", async () => {
    const { map, canvas } = await activated();
    const resting = layerDef(map, "scale-blob-fill").paint["fill-opacity"];
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    expect(layerDef(map, "scale-blob-fill").paint["fill-opacity"]).toBeGreaterThan(resting);
    // Dropped after a real move — a release in place would be a click, which selects.
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 60, clientY: 10 });
    expect(layerDef(map, "scale-blob-fill").paint["fill-opacity"]).toBe(resting);
  });

  it("captures the pointer on press and releases it on drop", async () => {
    const { canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 7, clientX: 10, clientY: 10 });
    expect((canvas as any).setPointerCapture).toHaveBeenCalledWith(7);
    dispatch(canvas, "pointerup", { pointerId: 7, clientX: 10, clientY: 10 });
    expect((canvas as any).releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("pointercancel puts the shape back where the drag started — cancel coordinates aren't trustworthy", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 80, clientY: 80 });
    flushFrames();
    expect(labelAt(map)[0]).not.toBeCloseTo(2.3522, 6);
    dispatch(canvas, "pointercancel", { pointerId: 1, clientX: 80, clientY: 80 });
    expect(labelAt(map)).toEqual([2.3522, 48.8566]);
    expect(map.dragPan.isEnabled()).toBe(true);
  });

  it("a second pointer cannot hijack an active drag", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointerdown", { pointerId: 2, clientX: 100, clientY: 100 });
    dispatch(canvas, "pointermove", { pointerId: 2, clientX: 300, clientY: 300 });
    flushFrames();
    dispatch(canvas, "pointerup", { pointerId: 2, clientX: 300, clientY: 300 });
    expect(blobSource(map).setData).not.toHaveBeenCalled();
  });

  it("shows a grab cursor while hovering the shape, and none off it", async () => {
    const { map, canvas } = await activated();
    dispatch(canvas, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 10 });
    flushFrames();
    expect(canvas.style.cursor).toBe("grab");
    map._setHit(false);
    dispatch(canvas, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 300 });
    flushFrames();
    expect(canvas.style.cursor).toBe("");
  });
});

describe("band selection", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return () => {
      vi.unstubAllGlobals();
      onScaleBlobSelection(null);
    };
  });

  const click = (canvas: HTMLCanvasElement, x = 10, y = 10) => {
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: x, clientY: y });
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: x, clientY: y });
  };

  it("a click on a band selects it: that band lit, the rest dimmed, the label quoting it", async () => {
    const { map, canvas } = await activated({ hit: "ES" });
    const seen: (string | null)[] = [];
    onScaleBlobSelection((k) => seen.push(k));

    click(canvas);

    expect(scaleBlobSelection()).toBe("ES");
    expect(seen).toEqual(["ES"]);
    expect(layerDef(map, "scale-blob-fill").paint["fill-opacity"]).toEqual([
      "case", ["==", ["get", "country"], "ES"], 0.9, 0.2,
    ]);
    expect(layerDef(map, "scale-blob-outline").paint["line-width"]).toEqual(["case", ["==", ["get", "country"], "ES"], 3, 1.2]);
    expect((map as any).getSource("scale-blob-label").data.features[0].properties.text).toMatch(/^Spain · 12 km² · 1 fire\n/);
    // Selecting re-paints; it never re-uploads the shape.
    expect(blobSource(map).setData).not.toHaveBeenCalled();
  });

  it("a second click on the selected band clears it; a click on another band switches", async () => {
    const { map, canvas } = await activated({ hit: "ES" });
    click(canvas);
    map._setHit("FR");
    click(canvas);
    expect(scaleBlobSelection()).toBe("FR");
    click(canvas);
    expect(scaleBlobSelection()).toBeNull();
    expect(layerDef(map, "scale-blob-fill").paint["fill-opacity"]).toBe(0.6);
    expect((map as any).getSource("scale-blob-label").data.features[0].properties.text).toContain("EU-27 fires, 2026");
  });

  it("a drag moves the shape without touching the selection", async () => {
    const { canvas } = await activated({ hit: "ES" });
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 90, clientY: 10 });
    expect(scaleBlobSelection()).toBeNull();
  });

  it("keeps the selection lit while the shape is held", async () => {
    const { map, canvas } = await activated({ hit: "ES" });
    click(canvas);
    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    expect(layerDef(map, "scale-blob-fill").paint["fill-opacity"]).toEqual([
      "case", ["==", ["get", "country"], "ES"], 0.9, 0.2,
    ]);
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 60, clientY: 10 });
  });

  it("a click off the shape clears the selection; a pan off the shape leaves it", async () => {
    const { map, canvas } = await activated({ hit: "ES" });
    click(canvas);
    map._setHit(false);
    dispatch(canvas, "pointerdown", { pointerId: 2, clientX: 300, clientY: 300 });
    dispatch(canvas, "pointerup", { pointerId: 2, clientX: 360, clientY: 300 });
    expect(scaleBlobSelection()).toBe("ES");
    click(canvas, 300, 300);
    expect(scaleBlobSelection()).toBeNull();
  });

  it("selects from outside (the panel): toggles, and ignores a band the shape doesn't have", async () => {
    await activated();
    selectScaleBlobBand("ES");
    expect(scaleBlobSelection()).toBe("ES");
    selectScaleBlobBand("ES");
    expect(scaleBlobSelection()).toBeNull();
    // Not on the shape: UA is outside the EU-27 scope.
    selectScaleBlobBand("UA");
    expect(scaleBlobSelection()).toBeNull();
  });

  it("deactivation clears the selection and says so", async () => {
    const { map, canvas } = await activated({ hit: "ES" });
    click(canvas);
    const seen: (string | null)[] = [];
    onScaleBlobSelection((k) => seen.push(k));
    deactivateScaleBlob(map);
    expect(scaleBlobSelection()).toBeNull();
    expect(seen).toEqual([null]);
  });
});

describe("bandLabel", () => {
  it("names the country and quotes its area, fires and share of the year", () => {
    const g = { key: "FR", color: "#000", hexes: 8000, areaKm2: 5629.8, fires: 875 };
    expect(bandLabel(g, 2026, 38_400)).toBe("France · 5,600 km² · 875 fires\n14.7% of the EU-27 total, 2026");
    expect(bandLabel({ ...g, key: "Other", fires: 1 }, 2026, 38_400)).toMatch(/^Other countries · .* · 1 fire\n/);
  });
});

describe("deactivateScaleBlob", () => {
  it("removes the layers and sources and clears active state", async () => {
    const { map } = await activated();
    deactivateScaleBlob(map);
    expect(isScaleBlobActive()).toBe(false);
    for (const id of ["scale-blob", "scale-blob-label"]) expect(map.getSource(id)).toBeUndefined();
    for (const id of ["scale-blob-fill", "scale-blob-outline", "scale-blob-label"]) {
      expect(map.getLayer(id)).toBeUndefined();
    }
  });

  it("removes the pointer listeners so a stray event after deactivation does nothing", async () => {
    const { map, canvas } = await activated();
    deactivateScaleBlob(map);
    const { map: map2 } = await activated();

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 200, clientY: 200 });
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 200, clientY: 200 });

    expect(map.getSource("scale-blob")).toBeUndefined();
    expect(blobSource(map2).setData).not.toHaveBeenCalled();
    deactivateScaleBlob(map2);
  });

  it("is a safe no-op when called before any activation", () => {
    const map = stubMap();
    expect(() => deactivateScaleBlob(map)).not.toThrow();
    expect(isScaleBlobActive()).toBe(false);
  });
});
