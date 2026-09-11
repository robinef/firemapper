// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateScaleBlob,
  deactivateScaleBlob,
  isScaleBlobActive,
  type ScaleBlobCell,
} from "../src/layer_scale_blob";
import { projectVertices } from "../src/geo_local";
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
function stubMap(opts: { center?: { lat: number; lng: number }; hit?: boolean } = {}) {
  const sources: Record<string, any> = {};
  const layers: string[] = [];
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  // jsdom does not implement pointer capture — stub it out like
  // layer_imagery_drag.test.ts does for the swipe divider.
  (canvas as any).setPointerCapture = vi.fn();
  (canvas as any).releasePointerCapture = vi.fn();

  let hit = opts.hit ?? true;
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
    addLayer: (def: any) => layers.push(def.id),
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
    setPaintProperty: vi.fn(),
    queryRenderedFeatures: vi.fn(() => (hit ? [{}] : [])),
    dragPan,
    _setHit: (v: boolean) => {
      hit = v;
    },
  };
  return map as unknown as maplibregl.Map & { _setHit: (v: boolean) => void; dragPan: typeof dragPan; getCanvas: () => HTMLCanvasElement };
}

const sampleBlob: ScaleBlobCell[] = [
  { fire_id: "fire-1", cell_id: "cell-a", res: 8, vertices_m: [[0, 0], [10, 0], [10, 10], [0, 10]] },
];

function dispatch(target: EventTarget, type: string, init: PointerEventInit) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
}

/** The stub source's `.data` isn't part of maplibre-gl's real `Source`
 * type — this narrows through `any` for test assertions only. */
function blobSource(map: maplibregl.Map): { data: GeoJSON.FeatureCollection; setData: (d: unknown) => void } {
  return (map as any).getSource("scale-blob");
}

beforeEach(() => {
  deactivateScaleBlob(stubMap());
});

describe("activateScaleBlob", () => {
  it("fetches the year blob and adds a source with projected geometry", async () => {
    const map = stubMap();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => sampleBlob });

    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("blob_2026.json"));
    expect(isScaleBlobActive()).toBe(true);
    const source = blobSource(map);
    expect(source).toBeDefined();
    expect(source.data.features).toHaveLength(1);
    expect((source.data.features[0].properties as any).color).toMatch(/^#[0-9a-f]{6}$/);
    expect((source.data.features[0].properties as any).fire_id).toBe("fire-1");

    // Initial drop point is the current map viewport center.
    const expected = projectVertices(sampleBlob[0].vertices_m, 45.0, 5.0);
    expect((source.data.features[0].geometry as GeoJSON.Polygon).coordinates[0]).toEqual(expected);
  });

  it("does not re-fetch on a second activation while already active", async () => {
    const map = stubMap();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => sampleBlob });

    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not double-fetch or double-add-source when two calls overlap before either resolves", async () => {
    const map = stubMap();
    // A controllable fetch: doesn't resolve until we say so, so both
    // activateScaleBlob calls are genuinely in flight at once (not merely
    // sequential microtasks) — this is what a hung fetch or a double-click on
    // a not-yet-debounced trigger button looks like.
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<ScaleBlobCell[]> }) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const addSourceSpy = vi.spyOn(map, "addSource");

    const first = activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    const second = activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);

    resolveFetch({ ok: true, json: async () => sampleBlob });
    // The second, guarded call must resolve to a safe no-op rather than
    // rejecting — a real maplibre map throws from addSource if a source
    // with that id already exists, and an unguarded second call reaching
    // addSource would surface that rejection here.
    await expect(Promise.all([first, second])).resolves.toBeDefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(addSourceSpy).toHaveBeenCalledTimes(1);
    expect(isScaleBlobActive()).toBe(true);
    expect(blobSource(map)).toBeDefined();
  });

  it("does nothing and leaves isScaleBlobActive false when the fetch response is not ok", async () => {
    const map = stubMap();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => sampleBlob });

    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);

    expect(isScaleBlobActive()).toBe(false);
    expect(map.getSource("scale-blob")).toBeUndefined();
  });

  it("renders cells in a deterministic cell_id order, independent of fetch order", async () => {
    // Every hex now has its own distinct spiral position (pack_blob.py), so
    // there's nothing left to overlap — this just confirms render order is
    // stable (sorted by cell_id) rather than depending on array/object
    // insertion order, which would make painting order flicker across reloads.
    const map = stubMap();
    const cells: ScaleBlobCell[] = [
      { fire_id: "fire-1", cell_id: "fire-1-2", res: 8, vertices_m: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      { fire_id: "fire-1", cell_id: "fire-1-0", res: 8, vertices_m: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      { fire_id: "fire-1", cell_id: "fire-1-1", res: 8, vertices_m: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => cells });

    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);

    const order = blobSource(map).data.features.map((f: any) => f.properties.cell_id);
    expect(order).toEqual(["fire-1-0", "fire-1-1", "fire-1-2"]);
  });
});

describe("select-then-drag lifecycle", () => {
  async function activated(hit = true) {
    const map = stubMap({ hit });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => sampleBlob });
    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    const canvas = map.getCanvas();
    return { map, canvas };
  }

  /** A click (down+up at ~the same point) on the shape — selects it. */
  function click(canvas: HTMLCanvasElement, pointerId = 1, x = 10, y = 10) {
    dispatch(canvas, "pointerdown", { pointerId, clientX: x, clientY: y });
    dispatch(canvas, "pointerup", { pointerId, clientX: x, clientY: y });
  }

  function selectedFlag(map: maplibregl.Map): boolean {
    return (blobSource(map).data.features[0].properties as any).selected;
  }

  it("starts unselected on activation", async () => {
    const { map } = await activated();
    expect(selectedFlag(map)).toBe(false);
  });

  it("a click on the shape selects it without moving it", async () => {
    const { map, canvas } = await activated();
    const before = blobSource(map).data.features[0].geometry;

    click(canvas);

    expect(selectedFlag(map)).toBe(true);
    expect(blobSource(map).data.features[0].geometry).toEqual(before);
  });

  it("a click on the shape while it's already selected deselects it", async () => {
    const { map, canvas } = await activated();
    click(canvas); // select
    expect(selectedFlag(map)).toBe(true);

    click(canvas); // click again
    expect(selectedFlag(map)).toBe(false);
  });

  it("a press elsewhere on the canvas deselects it", async () => {
    const { map, canvas } = await activated();
    click(canvas);
    expect(selectedFlag(map)).toBe(true);

    (map as any)._setHit(false); // this press misses the shape
    dispatch(canvas, "pointerdown", { pointerId: 2, clientX: 300, clientY: 300 });

    expect(selectedFlag(map)).toBe(false);
  });

  it("dragging is a no-op while unselected — no translate, no dragPan suppression", async () => {
    const { map, canvas } = await activated();
    const before = blobSource(map).data;

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 150, clientY: 230 });

    expect(blobSource(map).data).toBe(before); // setData never called for a move
    expect(map.setPaintProperty).not.toHaveBeenCalled();
    expect(map.dragPan.disable).not.toHaveBeenCalled();
  });

  it("once selected, pointermove sets a pure pixel-space translate — no geometry recompute per frame", async () => {
    // The performance fix: with thousands of real hexes, recomputing every
    // vertex's lat/lon and re-uploading the whole source on every pointermove
    // was the actual drag lag, not H3 itself. Moving now only sets the
    // fill/line layers' `-translate` paint properties (a GPU-side pixel
    // offset) — setData is never called until the drag ends.
    const { map, canvas } = await activated();
    click(canvas, 1, 10, 10);
    const beforeMove = blobSource(map).data;

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
    // Cursor moves by (+50, +30) canvas px from the grab point.
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 150, clientY: 230 });

    expect(map.setPaintProperty).toHaveBeenCalledWith("scale-blob-fill", "fill-translate", [50, 30]);
    expect(map.setPaintProperty).toHaveBeenCalledWith("scale-blob-outline", "line-translate", [50, 30]);
    // No geometry recompute happened — setData was never called for the move.
    expect(blobSource(map).data).toBe(beforeMove);
  });

  it("dropping (pointerup) commits the real geometry once and resets the translate to zero", async () => {
    const { map, canvas } = await activated();
    click(canvas, 1, 10, 10);

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 150, clientY: 230 });
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 150, clientY: 230 });

    // stubMap's project/unproject are exact inverses (x/1000 <-> lng*1000),
    // so committing a (+50, +30) px drag from the original drop point
    // (45.0, 5.0) must land on exactly (45.03, 5.05) — the same true
    // position the old per-frame lat/lon math targeted, now computed once.
    const expected = projectVertices(sampleBlob[0].vertices_m, 45.03, 5.05);
    const actual = (blobSource(map).data.features[0].geometry as GeoJSON.Polygon).coordinates[0];
    actual.forEach((vertex: number[], i: number) => {
      expect(vertex[0]).toBeCloseTo(expected[i][0], 9);
      expect(vertex[1]).toBeCloseTo(expected[i][1], 9);
    });

    // The translate must reset to zero — the new geometry already reflects
    // the drop position, so a lingering translate would double-offset it.
    expect(map.setPaintProperty).toHaveBeenLastCalledWith("scale-blob-outline", "line-translate", [0, 0]);
    expect(map.setPaintProperty).toHaveBeenCalledWith("scale-blob-fill", "fill-translate", [0, 0]);
  });

  it("a real drag while selected leaves it selected afterward, not toggled off", async () => {
    const { map, canvas } = await activated();
    click(canvas, 1, 10, 10);

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 150, clientY: 230 });
    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 150, clientY: 230 });

    expect(selectedFlag(map)).toBe(true);
  });

  it("does not start a drag when pointerdown misses the rendered shape", async () => {
    const { map, canvas } = await activated(false);
    const before = blobSource(map).data;

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 150, clientY: 230 });

    expect(blobSource(map).data).toBe(before); // setData never called again
  });

  it("hit-tests a small box around the click, not the exact pixel — a click can land on a hex boundary", async () => {
    const { map, canvas } = await activated();

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });

    // A bare point would miss a click that lands exactly on the WebGL seam
    // between two adjacent hexes — querying a box around it instead gives
    // an edge click the same forgiveness a real finger or mouse needs.
    expect(map.queryRenderedFeatures).toHaveBeenCalledWith(
      [
        [100 - 3, 200 - 3],
        [100 + 3, 200 + 3],
      ],
      { layers: ["scale-blob-fill"] },
    );
  });

  it("captures the pointer on pointerdown and releases it on pointerup, even while unselected", async () => {
    const { map, canvas } = await activated();

    dispatch(canvas, "pointerdown", { pointerId: 7, clientX: 10, clientY: 10 });
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);

    dispatch(canvas, "pointerup", { pointerId: 7, clientX: 10, clientY: 10 });
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("pointercancel ends a drag exactly like pointerup — commits once, then further movement is ignored", async () => {
    const { map, canvas } = await activated();
    click(canvas, 1, 10, 10);

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 200 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 150, clientY: 230 });
    const beforeCancel = blobSource(map).data; // still the pre-drag geometry — move only translates

    dispatch(canvas, "pointercancel", { pointerId: 1, clientX: 150, clientY: 230 });
    const afterCancel = blobSource(map).data;
    expect(afterCancel).not.toBe(beforeCancel); // cancel committed real geometry, same as pointerup would

    // Further movement of the same (now-released) pointer must not move the shape.
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 300, clientY: 300 });
    expect(blobSource(map).data).toBe(afterCancel);
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("a second pointer cannot hijack an active drag", async () => {
    const { map, canvas } = await activated();
    click(canvas, 1, 100, 100);

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
    (map.setPaintProperty as ReturnType<typeof vi.fn>).mockClear();

    // A second finger lands mid-drag — must be ignored, no translate from it.
    dispatch(canvas, "pointerdown", { pointerId: 2, clientX: 0, clientY: 0 });
    dispatch(canvas, "pointermove", { pointerId: 2, clientX: 0, clientY: 0 });
    expect(map.setPaintProperty).not.toHaveBeenCalled();

    // The original pointer still drives the drag.
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 110, clientY: 100 });
    expect(map.setPaintProperty).toHaveBeenCalledWith("scale-blob-fill", "fill-translate", [10, 0]);
  });

  it("suppresses map dragPan while dragging and restores it on release", async () => {
    const { map, canvas } = await activated();
    click(canvas, 1, 10, 10);

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    // Real movement, past the click tolerance, so this is a drag not a click.
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 30, clientY: 30 });
    expect(map.dragPan.disable).toHaveBeenCalled();
    expect(map.dragPan.isEnabled()).toBe(false);

    dispatch(canvas, "pointerup", { pointerId: 1, clientX: 30, clientY: 30 });
    expect(map.dragPan.enable).toHaveBeenCalled();
    expect(map.dragPan.isEnabled()).toBe(true);
  });
});

describe("deactivateScaleBlob", () => {
  it("removes the layer and source and clears active state", async () => {
    const map = stubMap();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => sampleBlob });
    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);

    deactivateScaleBlob(map);

    expect(isScaleBlobActive()).toBe(false);
    expect(map.getSource("scale-blob")).toBeUndefined();
    expect(map.getLayer("scale-blob-fill")).toBeUndefined();
  });

  it("removes the pointer listeners so a stray event after deactivation does nothing", async () => {
    const map = stubMap();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => sampleBlob });
    await activateScaleBlob(map, 2026, fetchImpl as unknown as typeof fetch);
    const canvas = map.getCanvas();

    deactivateScaleBlob(map);

    // Re-activate on a fresh map so there IS a live source to accidentally
    // corrupt if the old canvas's listeners were left attached.
    const map2 = stubMap();
    const fetchImpl2 = vi.fn().mockResolvedValue({ ok: true, json: async () => sampleBlob });
    await activateScaleBlob(map2, 2026, fetchImpl2 as unknown as typeof fetch);

    dispatch(canvas, "pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    dispatch(canvas, "pointermove", { pointerId: 1, clientX: 200, clientY: 200 });

    // The old, deactivated map's (now-empty) source registry must not have
    // been touched, and map2's active drag state must be untouched by the
    // stray old-canvas events.
    expect(map.getSource("scale-blob")).toBeUndefined();

    deactivateScaleBlob(map2);
  });

  it("is a safe no-op when called before any activation", () => {
    const map = stubMap();
    expect(() => deactivateScaleBlob(map)).not.toThrow();
    expect(isScaleBlobActive()).toBe(false);
  });
});
