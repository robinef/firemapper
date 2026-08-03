import { describe, expect, it } from "vitest";
import {
  CLOSED_LAYER_IDS,
  FIRE_CLASSES,
  addActiveFires,
  addClosedFires,
  fireHaloIds,
  fireLayerIds,
} from "../src/layer_fires";

/** Minimal fake of the subset of maplibregl.Map that addActiveFires touches,
 * recording every addLayer call by id so tests can inspect what was built —
 * no real map, no WebGL, matching the map-independent style of
 * compare_lock.ts's MapLike. */
function fakeMap() {
  const sources: Record<string, unknown> = {};
  const layers: Record<string, Record<string, unknown>> = {};
  const map = {
    getSource: (id: string) => sources[id],
    getLayer: (id: string) => layers[id],
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

describe("burned-out fires stay reachable", () => {
  // A fire quiet >48h becomes status=closed (events.py CLOSE_AFTER_H), and
  // every layer above filters closed OUT. Its scar marker is then the only
  // route to its card — and the scar list is capped, so a notable fire can
  // lose that route entirely a few days after it stops burning. This layer is
  // the durable way back in.
  it("draws closed fires and nothing else", () => {
    const { map, layers } = fakeMap();
    addClosedFires(map as never);
    for (const id of CLOSED_LAYER_IDS) {
      expect(layers[id], `${id} missing`).toBeTruthy();
      expect(JSON.stringify(layers[id].filter)).toContain("closed");
    }
  });

  it("reuses the fires source rather than refetching", () => {
    const { map, layers } = fakeMap();
    addClosedFires(map as never);
    for (const id of CLOSED_LAYER_IDS) expect(layers[id].source).toBe("fires");
  });

  it("backs the dot with a tap target big enough to hit", () => {
    const { map, layers } = fakeMap();
    addClosedFires(map as never);
    const halo = layers[CLOSED_LAYER_IDS[0]];
    expect(halo.type).toBe("circle");
    // Same 44px-ish touch minimum as the active fire halos above.
    expect((halo.paint as Record<string, number>)["circle-radius"]).toBeGreaterThanOrEqual(20);
  });

  it("gates each size class at the same zoom as its live counterpart", () => {
    const { map, layers } = fakeMap();
    addActiveFires(map as never, emptyFC, emptyFC);
    addClosedFires(map as never);
    // Closed fires outnumber live ones ~3:1 in production; without this they
    // would blanket the Europe view and every pixel would be a tap target.
    for (const cls of FIRE_CLASSES) {
      expect(layers[`fires-closed-${cls}`].minzoom).toBe(layers[`fires-${cls}`].minzoom);
    }
  });

  it("renders dimmer than a live fire, so it reads as over", () => {
    const { map, layers } = fakeMap();
    addActiveFires(map as never, emptyFC, emptyFC);
    addClosedFires(map as never);
    const closed = layers["fires-closed-major"].paint as Record<string, unknown>;
    expect(closed["circle-opacity"]).toBeLessThan(0.6);
  });
});
