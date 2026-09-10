// Draggable, packed scale-comparison blob — see
// docs/superpowers/specs/2026-09-09-fire-scale-blob-design.md.
// Deliberately NOT a registry.ts LayerModule: this shape has no fixed
// geographic position and is driven by drag, not a visibility toggle. It
// manages its own maplibre source/layer lifecycle and its own pointer
// listeners, independent of the registry system.
//
// Interaction: click once to select (a highlighted outline + bumped
// opacity), then drag while selected. Clicking the shape again, or clicking
// anywhere else on the map, deselects it. This is deliberately two steps —
// a bare click-and-drag on an unselected shape does nothing — so casually
// panning the map near it can never accidentally pick it up.
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
import { hashColor, outlineFor } from "./palette";

export type ScaleBlobCell = {
  fire_id: string;
  cell_id: string;
  res: number;
  vertices_m: [number, number][];
};

const SOURCE_ID = "scale-blob";
const LAYER_ID = "scale-blob-fill";
const OUTLINE_LAYER_ID = "scale-blob-outline";
const DATA_BASE = "/data";

// A pointerdown/pointerup pair whose total movement stays within this many
// CSS px is a click, not a drag attempt — same tolerance maplibre's own
// click-vs-drag distinction uses (map_event.ts's default clickTolerance).
const CLICK_TOLERANCE_PX = 3;

let active = false;
let activating = false;
let cells: ScaleBlobCell[] = [];
let dropLat = 0;
let dropLon = 0;
let grabOffsetLat = 0;
let grabOffsetLon = 0;
// The shape is only draggable once selected — a single click (not a drag)
// toggles selection. This exists so a stray drag on the map, or just
// scanning around, can't move the shape by accident; picking it up is a
// deliberate two-step "select, then drag" action.
let selected = false;
let dragging = false;
let activePointerId: number | null = null;
let pointerDownPoint: [number, number] | null = null;
let pointerDownWasSelected = false;
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
    features: sortedForOverlapTieBreak(cells).map((cell) => {
      const color = hashColor(cell.fire_id);
      return {
        type: "Feature",
        properties: {
          fire_id: cell.fire_id,
          cell_id: cell.cell_id,
          res: cell.res,
          color,
          stroke: outlineFor(color),
          // Selection is a single shared state for the whole shape, not
          // per-fire — baked onto every feature so the paint expressions
          // below can react to it without an imperative setPaintProperty
          // call on every toggle.
          selected,
        },
        geometry: {
          type: "Polygon",
          coordinates: [projectVertices(cell.vertices_m, dropLat, dropLon)],
        },
      };
    }),
  };
}

function render(map: maplibregl.Map): void {
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  source?.setData(toGeoJSON());
}

/** Toggle the shape's selected/draggable state, re-render so the highlight
 * (opacity bump + outline) reflects it immediately, and update the cursor:
 * "pointer" (click to pick up) when unselected, "grab" when selected and
 * ready to drag. */
function setSelected(value: boolean): void {
  if (selected === value) return;
  selected = value;
  if (currentMap) render(currentMap);
  if (currentCanvas && !dragging) currentCanvas.style.cursor = selected ? "grab" : "pointer";
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

function capturePointer(pointerId: number): void {
  if (!currentCanvas) return;
  try {
    currentCanvas.setPointerCapture(pointerId);
  } catch (err) {
    // setPointerCapture can throw (e.g. a NotFoundError if the browser has
    // already implicitly released capture) — proceed without native capture
    // rather than aborting the gesture.
    console.warn("layer_scale_blob: setPointerCapture failed unexpectedly", err);
  }
}

// A single exact pixel can miss a real click near a hex boundary — WebGL
// polygon rasterization/anti-aliasing leaves a sub-pixel seam between two
// adjacent fills where neither one's hit test claims that pixel. Querying a
// small box around the point instead of the point itself is the standard
// maplibre workaround, and gives clicks near an edge the same forgiveness a
// human finger or a slightly-off mouse click needs anyway.
const HIT_TEST_BUFFER_PX = 3;

function onPointerDown(e: PointerEvent): void {
  if (!currentMap || !currentCanvas || dragging || pointerDownPoint !== null) return;
  const point = canvasPoint(currentCanvas, e);
  // Native canvas events fire for the whole canvas, not just this layer —
  // map.on("mousedown", LAYER_ID, ...) would filter that for us, but here we
  // have to hit-test ourselves.
  const hitBox: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point[0] - HIT_TEST_BUFFER_PX, point[1] - HIT_TEST_BUFFER_PX],
    [point[0] + HIT_TEST_BUFFER_PX, point[1] + HIT_TEST_BUFFER_PX],
  ];
  const hits = currentMap.queryRenderedFeatures(hitBox, { layers: [LAYER_ID] });
  if (hits.length === 0) {
    // A press anywhere else on the map deselects — the same "click away"
    // convention as any selectable UI element. Left to the map's own
    // handlers otherwise; nothing here calls preventDefault/stopPropagation.
    setSelected(false);
    return;
  }

  activePointerId = e.pointerId;
  pointerDownPoint = point;
  pointerDownWasSelected = selected;
  capturePointer(e.pointerId);

  if (!selected) {
    // Not yet selected: this press might turn out to be the click that
    // selects it, but it must not move the shape or fight the map's own
    // pan — decided on pointerup, once we know whether it was a click or a
    // drag attempt.
    return;
  }

  const lngLat = currentMap.unproject(point);
  dragging = true;
  // Preserve the offset between the grab point and the shape's current drop
  // point — grabbing an edge keeps that edge under the cursor throughout the
  // drag, rather than snapping the shape's center to the cursor.
  grabOffsetLat = dropLat - lngLat.lat;
  grabOffsetLon = dropLon - lngLat.lng;

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
  if (e.pointerId !== activePointerId || !currentCanvas || pointerDownPoint === null) return;

  const point = canvasPoint(currentCanvas, e);
  const dx = point[0] - pointerDownPoint[0];
  const dy = point[1] - pointerDownPoint[1];
  const wasClick = Math.hypot(dx, dy) <= CLICK_TOLERANCE_PX;

  if (dragging) endDrag(e.pointerId);
  else releasePointerTracking(e.pointerId);

  // A click (not a drag) on the shape toggles selection: select it if it
  // wasn't, deselect it if it already was. A real drag leaves it selected —
  // the user should be able to drag again without re-clicking first.
  if (wasClick) setSelected(!pointerDownWasSelected);
}

function releasePointerTracking(pointerId: number): void {
  activePointerId = null;
  pointerDownPoint = null;
  if (currentCanvas) {
    try {
      currentCanvas.releasePointerCapture(pointerId);
    } catch (err) {
      console.warn("layer_scale_blob: releasePointerCapture failed unexpectedly", err);
    }
  }
}

function endDrag(pointerId: number): void {
  dragging = false;
  releasePointerTracking(pointerId);
  if (currentCanvas) currentCanvas.style.cursor = selected ? "grab" : "pointer";
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

    selected = false;
    activePointerId = null;
    pointerDownPoint = null;

    map.addSource(SOURCE_ID, { type: "geojson", data: toGeoJSON() });
    map.addLayer({
      id: LAYER_ID,
      type: "fill",
      source: SOURCE_ID,
      paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "selected"], 0.85, 0.6] },
    });
    // A border, dim even when unselected — the click-to-pick-up gesture isn't
    // discoverable if the shape looks like flat, non-interactive fill until
    // the moment it's clicked. Brightens and thickens once selected, so the
    // two states still read clearly apart.
    map.addLayer({
      id: OUTLINE_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      paint: {
        "line-color": ["get", "stroke"],
        "line-width": ["case", ["get", "selected"], 3, 1],
        "line-opacity": ["case", ["get", "selected"], 1, 0.4],
      },
    });

    const canvas = map.getCanvas();
    currentMap = map;
    currentCanvas = canvas;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    // "pointer" (click to select), not "grab" — dragging only works once
    // selected, see the module doc comment.
    canvas.style.cursor = "pointer";
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

  // Layers referencing a source must go before the source itself.
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);

  const canvas = currentCanvas ?? map.getCanvas();
  canvas.removeEventListener("pointerdown", onPointerDown);
  canvas.removeEventListener("pointermove", onPointerMove);
  canvas.removeEventListener("pointerup", onPointerUp);
  canvas.removeEventListener("pointercancel", onPointerUp);
  canvas.style.cursor = "";

  dragging = false;
  selected = false;
  activePointerId = null;
  pointerDownPoint = null;
  active = false;
  cells = [];
  currentMap = null;
  currentCanvas = null;
}
