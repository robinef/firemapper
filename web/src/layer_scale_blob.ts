// Draggable, packed scale-comparison blob — see
// docs/superpowers/specs/2026-09-09-fire-scale-blob-design.md.
// Deliberately NOT a registry.ts LayerModule: this shape has no fixed
// geographic position and is driven by drag, not a visibility toggle. It
// manages its own maplibre source/layer lifecycle and its own pointer
// listeners, independent of the registry system.
//
// Pointer handling note: maplibre-gl's Map.on("mousedown"/"touchstart", ...)
// only exposes maplibre's own wrapped mouse/touch events, not native Pointer
// Events — and the drag here needs real pointerdown/pointermove/pointerup/
// pointercancel with setPointerCapture (to keep tracking a drag even once the
// cursor leaves the shape's hit area, and to unify mouse+touch in one code
// path). So this listens directly on the map's canvas via native
// addEventListener, hit-tests pointerdown itself with
// map.queryRenderedFeatures (map.on's per-layer filtering doesn't apply to
// native canvas events), and converts canvas-pixel coordinates to a map
// lngLat with map.unproject.
// maplibre-gl 6 is ESM-only and has no default export (see
// layer_imagery.ts's own import) — a type-only namespace import is the form
// that actually resolves against the installed package.
import type * as maplibregl from "maplibre-gl";
import { checkExtentBudget, projectVertices } from "./geo_local";
import { hashColor } from "./palette";

export type ScaleBlobCell = {
  fire_id: string;
  cell_id: string;
  res: number;
  vertices_m: [number, number][];
};

const SOURCE_ID = "scale-blob";
const LAYER_ID = "scale-blob-fill";
const DATA_BASE = "/data";

let active = false;
let activating = false;
let cells: ScaleBlobCell[] = [];
let dropLat = 0;
let dropLon = 0;
let grabOffsetLat = 0;
let grabOffsetLon = 0;
let dragging = false;
let activePointerId: number | null = null;
let dragPanWasEnabled = false;
let currentMap: maplibregl.Map | null = null;
let currentCanvas: HTMLCanvasElement | null = null;

/** Same-fire mixed-resolution cells can overlap (a coarse Meteosat res-7
 * cell spatially containing several VIIRS res-8 cells from the same track —
 * see the design doc's "Overlap handling"). Render in a deterministic order
 * so which cell paints on top is stable across reloads, not an unexplained
 * rendering-order bug hunt. This is a same-fire artifact, not a cross-fire
 * union problem — packing already keeps different fires on disjoint canvas
 * regions. */
function sortedForOverlapTieBreak(cellList: ScaleBlobCell[]): ScaleBlobCell[] {
  return [...cellList].sort((a, b) => a.res - b.res || a.cell_id.localeCompare(b.cell_id));
}

function toGeoJSON(): GeoJSON.FeatureCollection {
  // The tangent-plane projection is only guaranteed area-accurate within a
  // 500 km / 2% extent budget (see geo_local.ts). checkExtentBudget logs its
  // own warning when exceeded; rendering proceeds regardless — the shape
  // stays usable, only the accuracy guarantee degrades.
  checkExtentBudget(cells.map((c) => c.vertices_m));
  return {
    type: "FeatureCollection",
    features: sortedForOverlapTieBreak(cells).map((cell) => ({
      type: "Feature",
      properties: {
        fire_id: cell.fire_id,
        cell_id: cell.cell_id,
        res: cell.res,
        color: hashColor(cell.fire_id),
      },
      geometry: {
        type: "Polygon",
        coordinates: [projectVertices(cell.vertices_m, dropLat, dropLon)],
      },
    })),
  };
}

function render(map: maplibregl.Map): void {
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  source?.setData(toGeoJSON());
}

/** Canvas-relative CSS-pixel coordinates for a pointer event, via
 * getBoundingClientRect rather than offsetX/offsetY — jsdom (and some
 * browser edge cases) don't reliably compute the latter, while
 * getBoundingClientRect + clientX/clientY is deterministic and is what
 * map.unproject expects (the same coordinate space as e.point on a
 * maplibre-wrapped mouse event). */
function canvasPoint(canvas: HTMLCanvasElement, e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function onPointerDown(e: PointerEvent): void {
  if (!currentMap || !currentCanvas || dragging) return;
  const point = canvasPoint(currentCanvas, e);
  // Native canvas events fire for the whole canvas, not just this layer —
  // map.on("mousedown", LAYER_ID, ...) would filter that for us, but here we
  // have to hit-test ourselves.
  const hits = currentMap.queryRenderedFeatures(point, { layers: [LAYER_ID] });
  if (hits.length === 0) return;

  const lngLat = currentMap.unproject(point);
  dragging = true;
  activePointerId = e.pointerId;
  // Preserve the offset between the grab point and the shape's current drop
  // point — grabbing an edge keeps that edge under the cursor throughout the
  // drag, rather than snapping the shape's center to the cursor.
  grabOffsetLat = dropLat - lngLat.lat;
  grabOffsetLon = dropLon - lngLat.lng;

  try {
    currentCanvas.setPointerCapture(e.pointerId);
  } catch (err) {
    // setPointerCapture can throw (e.g. a NotFoundError if the browser has
    // already implicitly released capture) — proceed without native capture
    // rather than aborting the drag.
    console.warn("layer_scale_blob: setPointerCapture failed unexpectedly", err);
  }

  // Suppress the map's own pan while dragging the shape — the drag would
  // otherwise fight the map's built-in canvas drag-pan for the same pointer
  // gesture. Restored to its prior state on release, not force-enabled, so a
  // map configured with panning off stays off afterward.
  const dragPan = currentMap.dragPan;
  if (dragPan) {
    dragPanWasEnabled = dragPan.isEnabled();
    dragPan.disable();
  }

  currentCanvas.style.cursor = "grabbing";
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || !currentMap || !currentCanvas || e.pointerId !== activePointerId) return;
  const point = canvasPoint(currentCanvas, e);
  const lngLat = currentMap.unproject(point);
  dropLat = lngLat.lat + grabOffsetLat;
  dropLon = lngLat.lng + grabOffsetLon;
  render(currentMap);
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging || e.pointerId !== activePointerId) return;
  endDrag(e.pointerId);
}

function endDrag(pointerId: number): void {
  dragging = false;
  activePointerId = null;
  if (currentCanvas) {
    try {
      currentCanvas.releasePointerCapture(pointerId);
    } catch (err) {
      console.warn("layer_scale_blob: releasePointerCapture failed unexpectedly", err);
    }
    currentCanvas.style.cursor = "grab";
  }
  if (currentMap?.dragPan && dragPanWasEnabled) {
    currentMap.dragPan.enable();
  }
}

export function isScaleBlobActive(): boolean {
  return active;
}

/**
 * Fetch the current year's packed blob (once per activation — a second call
 * while already active is a no-op, matching the trigger button's toggle
 * behavior) and render it centered on the current viewport, then wire up
 * drag.
 *
 * Re-entrancy: `active` only flips true once the fetch resolves and the
 * source/layer are added, so it cannot guard a second call issued while the
 * first is still in flight (hung fetch, double-click on an undebounced
 * trigger, etc). `activating` closes that gap — set synchronously before the
 * first `await`, so a second overlapping call sees it immediately and is a
 * safe no-op, matching the already-active behavior. It's reset on every exit
 * path (the not-ok early return, success, and — via `finally` — any thrown
 * error) so a failed activation can be retried.
 */
export async function activateScaleBlob(
  map: maplibregl.Map,
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (active || activating) return;
  activating = true;
  try {
    const response = await fetchImpl(`${DATA_BASE}/archive/blob_${year}.json`);
    if (!response.ok) return;
    cells = (await response.json()) as ScaleBlobCell[];

    const center = map.getCenter();
    dropLat = center.lat;
    dropLon = center.lng;

    map.addSource(SOURCE_ID, { type: "geojson", data: toGeoJSON() });
    map.addLayer({
      id: LAYER_ID,
      type: "fill",
      source: SOURCE_ID,
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.6 },
    });

    const canvas = map.getCanvas();
    currentMap = map;
    currentCanvas = canvas;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.style.cursor = "grab";
    active = true;
  } finally {
    activating = false;
  }
}

/** Hide the shape and fully restore normal map interaction — no lingering
 * pointer listeners, and a captured pointer released if a drag happened to
 * be mid-flight. Safe to call even if never activated. */
export function deactivateScaleBlob(map: maplibregl.Map): void {
  if (dragging && activePointerId !== null) endDrag(activePointerId);

  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);

  const canvas = currentCanvas ?? map.getCanvas();
  canvas.removeEventListener("pointerdown", onPointerDown);
  canvas.removeEventListener("pointermove", onPointerMove);
  canvas.removeEventListener("pointerup", onPointerUp);
  canvas.removeEventListener("pointercancel", onPointerUp);
  canvas.style.cursor = "";

  dragging = false;
  activePointerId = null;
  active = false;
  cells = [];
  currentMap = null;
  currentCanvas = null;
}
