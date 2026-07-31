import { describe, expect, it } from "vitest";
import { FIRE_CLASSES, addActiveFires, fireHaloIds, fireLayerIds } from "../src/layer_fires";

/** Minimal fake of the subset of maplibregl.Map that addActiveFires touches,
 * recording every addLayer call by id so tests can inspect what was built —
 * no real map, no WebGL, matching the map-independent style of
 * compare_lock.ts's MapLike. */
function fakeMap() {
  const sources: Record<string, unknown> = {};
  const layers: Record<string, Record<string, unknown>> = {};
  const map = {
    getSource: (id: string) => sources[id],
    addSource: (id: string, src: unknown) => {
      sources[id] = src;
    },
    addLayer: (layer: Record<string, unknown>) => {
      layers[layer.id as string] = layer;
    },
  };
  return { map, layers };
}

const emptyFC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

describe("fire halo zoom range", () => {
  // Regression for the CRITICAL finding: a single "fire-halo" layer with no
  // zoom range at all used to sit under every class regardless of whether
  // that class's dot was even drawn at the current zoom — at the map's z4.2
  // boot zoom, only "major" dots render, but every non-closed fire (medium,
  // minor included) still had an invisible 44px click target blanketing the
  // map. One halo per class, gated to that class's own minzoom/maxzoom (same
  // as the dot it backs), fixes that: a halo only exists where its dot does.
  it("gives each halo the same minzoom/maxzoom as the dot layer it backs", () => {
    const { map, layers } = fakeMap();
    addActiveFires(map as never, emptyFC, emptyFC);

    for (const cls of FIRE_CLASSES) {
      const halo = layers[`fire-halo-${cls}`];
      const dot = layers[`fires-${cls}`];
      expect(halo, `fire-halo-${cls} should exist`).toBeDefined();
      expect(dot, `fires-${cls} should exist`).toBeDefined();
      expect(halo.minzoom).toBe(dot.minzoom);
      expect(halo.maxzoom).toBe(dot.maxzoom);
      // Same class filter too — a halo backing the wrong class would just
      // move the "invisible target where nothing is drawn" bug elsewhere.
      expect(halo.filter).toEqual(dot.filter);
    }
  });

  it("exports one halo id per fire class, matching fireLayerIds' naming", () => {
    expect(fireHaloIds).toEqual(FIRE_CLASSES.map((c) => `fire-halo-${c}`));
    expect(fireHaloIds).toHaveLength(fireLayerIds.length);
  });

  it("keeps halos invisible — a target, not a symbol", () => {
    const { map, layers } = fakeMap();
    addActiveFires(map as never, emptyFC, emptyFC);
    for (const id of fireHaloIds) {
      const paint = layers[id].paint as Record<string, unknown>;
      expect(paint["circle-color"]).toBe("rgba(0,0,0,0)");
    }
  });
});
