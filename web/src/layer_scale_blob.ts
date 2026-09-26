// Draggable scale-comparison blob — see
// docs/superpowers/specs/2026-09-09-fire-scale-blob-design.md.
// Deliberately NOT a registry.ts LayerModule: this shape has no fixed
// geographic position and is driven by drag, not a visibility toggle. It
// manages its own maplibre source/layer lifecycle and its own pointer
// listeners, independent of the registry system.
//
// Geometry comes from scale_blob_shape.ts: the year's fires packed on the
// pipeline's spiral, one band per country, dissolved to a few polygons. It is
// built from the per-fire summary the breakdown panel already loads — the
// per-hex archive/blob_{year}.json (57 MB, 163k polygons) is no longer read.
//
// Interaction: press on the shape and drag — one gesture. A click (a press
// that doesn't move) on a band selects that country: its band stays lit, the
// rest dim, and the label quotes it. Clicking it again, or clicking off the
// shape, clears the selection. The breakdown panel's rows select the same way
// (main.ts wires them through selectScaleBlobBand/onScaleBlobSelection).
//
// The cursor ("grab" over the shape) and the label say it can be dragged. It
// used to take two steps (click to select, then drag) so that panning near the
// shape could never pick it up; nothing told the reader about the first step,
// so the shape read as not draggable at all. Panning still works anywhere off
// the shape.
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
//
// Drag performance: the shape is a few polygons (~30k vertices for 2026), so
// a drag re-projects it and calls setData once per animation frame. The old
// 163k-hex shape could not afford that and moved by `fill-translate` instead,
// which maplibre clips at each tile's edge: mid-drag the shape was sliced
// into strips and only reassembled on drop.
// maplibre-gl 6 is ESM-only and has no default export (see
// layer_imagery.ts's own import) — a type-only namespace import is the form
// that actually resolves against the installed package.
import type * as maplibregl from "maplibre-gl";
import { checkExtentBudget, projectVertices } from "./geo_local";
import { fetchFiresSummary } from "./scale_blob_panel";
import { OTHER_KEY, buildBlobShape, euOnly, type BlobGroup, type BlobShape } from "./scale_blob_shape";
import type { FiresSummary } from "./types";

const SOURCE_ID = "scale-blob";
const LABEL_SOURCE_ID = "scale-blob-label";
const LAYER_ID = "scale-blob-fill";
const OUTLINE_LAYER_ID = "scale-blob-outline";
const LABEL_LAYER_ID = "scale-blob-label";

/** Where the blob first lands, [lng, lat]: Paris. An EU-27 total laid over a
 * place most readers can size by eye, rather than wherever the viewport
 * happened to be (often the sea, or a corner of the map). */
export const DEFAULT_DROP: [number, number] = [2.3522, 48.8566];

const FILL_OPACITY = 0.6;
const FILL_OPACITY_DRAGGING = 0.8;
const FILL_OPACITY_SELECTED = 0.9;
const FILL_OPACITY_UNSELECTED = 0.2;

// A pointerdown/pointerup pair whose total movement stays within this many
// CSS px is a click, not a drag — same tolerance maplibre's own click-vs-drag
// distinction uses (map_event.ts's default clickTolerance).
const CLICK_TOLERANCE_PX = 3;

let active = false;
let activating = false;
// Bumped by every deactivation. An activation still waiting on its summary
// when the reader turns the blob off (or compare:enter / detail:open does it
// for them) finds the generation moved on and adds nothing.
let generation = 0;
let shape: BlobShape = { groups: [], polygonsM: [] };
let blobYear = 0;
let totalKm2 = 0;
let defaultLabel = "";
let selectedKey: string | null = null;
let selectionListener: ((key: string | null) => void) | null = null;
// The band a press landed on, so its release can select it if it didn't move.
let pressedBand: string | null = null;
// A press off the shape, tracked only to tell a click-away (clears the
// selection) from the start of a map pan (leaves it alone).
let offShapePress: { pointerId: number; point: [number, number] } | null = null;
let dropLat = 0;
let dropLon = 0;
let dragging = false;
let hovering = false;
let activePointerId: number | null = null;
let pointerDownPoint: [number, number] | null = null;
let dragPanWasEnabled = false;
// Where the drop point was on screen when the drag started, and where it was
// on the map: every frame places the shape at start + pointer delta, and a
// cancelled drag goes back to the start.
let dragStartScreen: { x: number; y: number } | null = null;
let dragStartLngLat: [number, number] = [0, 0];
let pendingDelta: [number, number] | null = null;
let moveFrame: number | null = null;
let currentMap: maplibregl.Map | null = null;
let currentCanvas: HTMLCanvasElement | null = null;

function toGeoJSON(): GeoJSON.FeatureCollection {
  // The tangent-plane projection is only guaranteed area-accurate within a
  // 500 km / 2% extent budget (see geo_local.ts). checkExtentBudget logs its
  // own warning when exceeded; rendering proceeds regardless — the shape
  // stays usable, only the accuracy guarantee degrades.
  checkExtentBudget(shape.polygonsM.flat(2));
  return {
    type: "FeatureCollection",
    features: shape.groups.map((group, i) => ({
      type: "Feature",
      properties: { country: group.key, color: group.color },
      geometry: {
        type: "MultiPolygon",
        coordinates: shape.polygonsM[i].map((poly) =>
          poly.map((ring) => projectVertices(ring, dropLat, dropLon)),
        ),
      },
    })),
  };
}

function labelGeoJSON(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { text: labelText() },
        geometry: { type: "Point", coordinates: [dropLon, dropLat] },
      },
    ],
  };
}

function render(map: maplibregl.Map): void {
  (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(toGeoJSON());
  (map.getSource(LABEL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(labelGeoJSON());
}

function formatKm2(km2: number): string {
  const rounded = km2 >= 1000 ? Math.round(km2 / 100) * 100 : Math.round(km2);
  return `${rounded.toLocaleString("en-GB")} km²`;
}

/** "EU-27 fires, 2026 · 38,400 km² detected" — real detected area, as the
 * panel quotes it. Never "all fires" or "burned" (index.html's
 * #scale-blob-note says why): the shape is the detected footprint of archived
 * fires only. */
export function blobLabel(year: number, summary: FiresSummary): string {
  const km2 = Object.values(summary).reduce((s, f) => s + f.area_km2, 0);
  return `EU-27 fires, ${year} · ${formatKm2(km2)} detected\nDrag to compare`;
}

let regionNames: Intl.DisplayNames | null = null;

/** "France" for "FR"; the code itself if the browser can't name it. */
function countryName(key: string): string {
  if (key === OTHER_KEY) return "Other countries";
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(key) ?? key;
  } catch {
    return key;
  }
}

/** "France · 5,600 km² · 875 fires\n14.6% of the EU-27 total, 2026" */
export function bandLabel(group: BlobGroup, year: number, allKm2: number): string {
  const share = allKm2 > 0 ? (100 * group.areaKm2) / allKm2 : 0;
  const fires = `${group.fires.toLocaleString("en-GB")} fire${group.fires === 1 ? "" : "s"}`;
  return `${countryName(group.key)} · ${formatKm2(group.areaKm2)} · ${fires}\n${share.toFixed(1)}% of the EU-27 total, ${year}`;
}

function labelText(): string {
  const group = shape.groups.find((g) => g.key === selectedKey);
  return group ? bandLabel(group, blobYear, totalKm2) : defaultLabel;
}

/** Paint the selection and the held state: the selected band lit, the others
 * dimmed; with nothing selected, one opacity for all, brighter while held. */
function applyStyle(): void {
  const map = currentMap;
  if (!map?.getLayer(LAYER_ID)) return;
  const base = dragging ? FILL_OPACITY_DRAGGING : FILL_OPACITY;
  const isSelected = ["==", ["get", "country"], selectedKey ?? ""];
  map.setPaintProperty(
    LAYER_ID,
    "fill-opacity",
    selectedKey === null ? base : (["case", isSelected, FILL_OPACITY_SELECTED, FILL_OPACITY_UNSELECTED] as never),
  );
  if (map.getLayer(OUTLINE_LAYER_ID)) {
    map.setPaintProperty(OUTLINE_LAYER_ID, "line-width", ["case", isSelected, 3, 1.2] as never);
  }
}

function setSelection(key: string | null): void {
  const next = key !== null && shape.groups.some((g) => g.key === key) ? key : null;
  if (next === selectedKey) return;
  selectedKey = next;
  applyStyle();
  (currentMap?.getSource(LABEL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(labelGeoJSON());
  selectionListener?.(selectedKey);
}

/** Select a country's band from outside the map (the breakdown panel). A
 * country folded into "Other" selects the Other band; null clears. Selecting
 * the band already selected clears it, like a second click on the map. */
export function selectScaleBlobBand(key: string | null): void {
  if (!active) return;
  setSelection(key !== null && key === selectedKey ? null : key);
}

/** The selected band's key (a country code, or OTHER_KEY), or null. */
export function scaleBlobSelection(): string | null {
  return selectedKey;
}

/** One listener, told every time the selection changes (including to null).
 * Pass null to unsubscribe. */
export function onScaleBlobSelection(listener: ((key: string | null) => void) | null): void {
  selectionListener = listener;
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

// A single exact pixel can miss a press on the seam between two bands — WebGL
// anti-aliasing leaves a sub-pixel gap where neither fill claims the pixel.
// Querying a small box around the point is the standard maplibre workaround.
const HIT_TEST_BUFFER_PX = 3;

function shapeHits(point: [number, number]): maplibregl.MapGeoJSONFeature[] {
  if (!currentMap) return [];
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point[0] - HIT_TEST_BUFFER_PX, point[1] - HIT_TEST_BUFFER_PX],
    [point[0] + HIT_TEST_BUFFER_PX, point[1] + HIT_TEST_BUFFER_PX],
  ];
  return currentMap.queryRenderedFeatures(box, { layers: [LAYER_ID] });
}

function hitsShape(point: [number, number]): boolean {
  return shapeHits(point).length > 0;
}

function onPointerDown(e: PointerEvent): void {
  if (!currentMap || !currentCanvas || dragging || pointerDownPoint !== null) return;
  const point = canvasPoint(currentCanvas, e);
  // A new press by the same pointer means its last one is over, whether or not
  // its release reached us (onDocumentPointerEnd is the usual path).
  if (offShapePress?.pointerId === e.pointerId) offShapePress = null;
  const hits = shapeHits(point);
  // A press off the shape is the map's: it pans as usual. Nothing here calls
  // preventDefault/stopPropagation. It is only remembered so that, if it turns
  // out to be a click, it can clear the selection.
  if (hits.length === 0) {
    offShapePress = { pointerId: e.pointerId, point };
    return;
  }
  // Another finger is already panning or pinching the map: a second finger
  // landing on the shape must not switch that gesture into a blob drag.
  if (offShapePress !== null) return;
  // Two bands can share the hit box on a seam; the topmost answers.
  pressedBand = (hits[0].properties?.country as string | undefined) ?? null;

  activePointerId = e.pointerId;
  pointerDownPoint = point;
  capturePointer(e.pointerId);
  dragging = true;
  dragStartScreen = currentMap.project([dropLon, dropLat]);
  dragStartLngLat = [dropLon, dropLat];

  // Suppress the map's own pan while dragging the shape — the drag would
  // otherwise fight the map's built-in canvas drag-pan for the same pointer
  // gesture. pointerdown fires before the mousedown maplibre's pan listens
  // for, so disabling here wins the gesture. Restored to its prior state on
  // release, not force-enabled, so a map configured with panning off stays off.
  const dragPan = currentMap.dragPan;
  if (dragPan) {
    dragPanWasEnabled = dragPan.isEnabled();
    dragPan.disable();
  }
  applyStyle();
  currentCanvas.style.cursor = "grabbing";
}

// Hover hit-tests are coalesced to one per animation frame: pointermove can
// fire far faster than the screen refreshes.
let hoverFrame: number | null = null;
let hoverPoint: [number, number] | null = null;

function updateHover(): void {
  hoverFrame = null;
  if (!currentCanvas || dragging || !hoverPoint) return;
  const over = hitsShape(hoverPoint);
  if (over !== hovering) {
    hovering = over;
    currentCanvas.style.cursor = over ? "grab" : "";
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!currentMap || !currentCanvas) return;
  const point = canvasPoint(currentCanvas, e);
  if (!dragging) {
    // A touch has no hover, and the press itself does the hit-test.
    if (e.pointerType === "touch") return;
    hoverPoint = point;
    if (hoverFrame === null) hoverFrame = requestAnimationFrame(updateHover);
    return;
  }
  if (e.pointerId !== activePointerId || !pointerDownPoint) return;
  // Coalesced to one geometry update per frame: pointermove can outpace the
  // screen, and only the latest position matters.
  pendingDelta = [point[0] - pointerDownPoint[0], point[1] - pointerDownPoint[1]];
  if (moveFrame === null) moveFrame = requestAnimationFrame(applyPendingMove);
}

function applyPendingMove(): void {
  moveFrame = null;
  if (dragging && pendingDelta) moveBy(pendingDelta[0], pendingDelta[1]);
}

/** Place the shape at the drag's start + (dx, dy) screen pixels. */
function moveBy(dx: number, dy: number): void {
  if (!currentMap || !dragStartScreen) return;
  const lngLat = currentMap.unproject([dragStartScreen.x + dx, dragStartScreen.y + dy]);
  dropLat = lngLat.lat;
  dropLon = lngLat.lng;
  render(currentMap);
}

function cancelPendingMove(): void {
  if (moveFrame !== null) cancelAnimationFrame(moveFrame);
  moveFrame = null;
  pendingDelta = null;
}

function onPointerUp(e: PointerEvent): void {
  if (offShapePress && e.pointerId === offShapePress.pointerId && currentCanvas) {
    const [x, y] = canvasPoint(currentCanvas, e);
    const click =
      e.type !== "pointercancel" &&
      Math.hypot(x - offShapePress.point[0], y - offShapePress.point[1]) <= CLICK_TOLERANCE_PX;
    offShapePress = null;
    if (click) setSelection(null);
    return;
  }
  if (e.pointerId !== activePointerId || !currentCanvas || pointerDownPoint === null) return;

  // pointercancel's coordinates aren't reliable across browsers/situations
  // (OS gesture takeover, palm rejection, a dropped touch) — never trust
  // them for a geometry commit. A cancel keeps the last committed position.
  const isCancel = e.type === "pointercancel";
  const point = canvasPoint(currentCanvas, e);
  const dx = point[0] - pointerDownPoint[0];
  const dy = point[1] - pointerDownPoint[1];
  const moved = !isCancel && Math.hypot(dx, dy) > CLICK_TOLERANCE_PX;

  try {
    cancelPendingMove();
    if (moved) {
      // The exact release point, not the last frame's.
      moveBy(dx, dy);
    } else if (dropLon !== dragStartLngLat[0] || dropLat !== dragStartLngLat[1]) {
      // A cancel, or a press that never left the click tolerance, but whose
      // frames nudged the shape: put it back where it was.
      [dropLon, dropLat] = dragStartLngLat;
      if (currentMap) render(currentMap);
    }
  } finally {
    // Always release drag state, even if moveBy threw — otherwise
    // onPointerDown's re-entrancy guard (dragging || pointerDownPoint !==
    // null) would wedge the shape unresponsive until reload.
    endDrag(e.pointerId);
  }
  // A click on a band toggles its selection; a drag leaves the selection be.
  if (!moved && !isCancel && pressedBand !== null) {
    setSelection(pressedBand === selectedKey ? null : pressedBand);
  }
  pressedBand = null;
}

/** A release anywhere on the page ends an off-shape press. The canvas only
 * hears releases over itself: a pan that ends over a panel would otherwise
 * leave the press standing, and its pointer id (always 1 for a mouse) would
 * then claim the release of the next blob drag. Registered on the document,
 * so it runs after the canvas's own handler has used the press. */
function onDocumentPointerEnd(e: PointerEvent): void {
  if (offShapePress?.pointerId === e.pointerId) offShapePress = null;
}

/** Whether a map click at this canvas point landed on the blob — main.ts's
 * click dispatch skips such a click, so selecting a band never also opens the
 * fire or scar underneath (which would close the blob via detail:open). */
export function scaleBlobHitAt(point: { x: number; y: number }): boolean {
  return active && hitsShape([point.x, point.y]);
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
  dragStartScreen = null;
  cancelPendingMove();
  releasePointerTracking(pointerId);
  // The pointer is still over the shape it just dropped.
  hovering = true;
  if (currentCanvas) currentCanvas.style.cursor = "grab";
  applyStyle();
  if (currentMap?.dragPan && dragPanWasEnabled) {
    currentMap.dragPan.enable();
  }
}

export function isScaleBlobActive(): boolean {
  return active;
}

/**
 * Build the year's blob from its per-fire summary and render it centred on
 * Paris (see DEFAULT_DROP), then wire up drag.
 *
 * `summaryP`: the caller's already-running load of blob_{year}_fires.json (the
 * same one the breakdown panel renders). Given one, it is the answer —
 * including null, "the file was tried and is not there". Without it, the file
 * is fetched here.
 *
 * Re-entrancy: `active` only flips true once the summary resolves and the
 * sources/layers are added, so it cannot guard a second call issued while the
 * first is still in flight. `activating` closes that gap — set synchronously
 * before the first `await`, reset on every exit path — so an overlapping
 * second call is a safe no-op and a failed activation can be retried. A
 * deactivation during that wait cancels it (see `generation`).
 */
export async function activateScaleBlob(
  map: maplibregl.Map,
  year: number,
  fetchImpl: typeof fetch = fetch,
  summaryP?: Promise<FiresSummary | null>,
): Promise<void> {
  if (active || activating) return;
  activating = true;
  const gen = generation;
  try {
    const fetched = await (summaryP ?? fetchFiresSummary(year, fetchImpl));
    if (gen !== generation || !fetched) return;
    const summary = euOnly(fetched);
    shape = buildBlobShape(summary);
    if (shape.groups.length === 0) return;
    blobYear = year;
    totalKm2 = Object.values(summary).reduce((s, f) => s + f.area_km2, 0);
    defaultLabel = blobLabel(year, summary);
    selectedKey = null;
    pressedBand = null;
    offShapePress = null;

    [dropLon, dropLat] = DEFAULT_DROP;
    // Landing off-screen would read as "nothing happened": bring Paris into
    // view, at the reader's zoom, when it isn't already.
    if (!map.getBounds().contains(DEFAULT_DROP)) {
      map.easeTo({ center: DEFAULT_DROP, duration: 600 });
    }
    activePointerId = null;
    pointerDownPoint = null;
    hovering = false;

    map.addSource(SOURCE_ID, { type: "geojson", data: toGeoJSON() });
    map.addSource(LABEL_SOURCE_ID, { type: "geojson", data: labelGeoJSON() });
    map.addLayer({
      id: LAYER_ID,
      type: "fill",
      source: SOURCE_ID,
      paint: {
        "fill-color": ["get", "color"],
        "fill-opacity": FILL_OPACITY,
        // The held-shape brighten is instant; maplibre would ease it over 300 ms.
        "fill-opacity-transition": { duration: 0 },
      },
    });
    // One outline per country band — a few rings, not one per hex. Per-hex
    // outlines were 1–2 px apart at overview zoom and drowned the fill.
    map.addLayer({
      id: OUTLINE_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      paint: {
        "line-color": "#ffffff",
        "line-width": 1.2,
        "line-opacity": 0.7,
      },
    });
    map.addLayer({
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: LABEL_SOURCE_ID,
      layout: {
        "text-field": ["get", "text"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 13,
        // Lines break only where the text says (\n): the default 10 em
        // wrapped "18,400 km²" across two lines.
        "text-max-width": 40,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.85)",
        "text-halo-width": 1.5,
      },
    });

    const canvas = map.getCanvas();
    currentMap = map;
    currentCanvas = canvas;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("pointerup", onDocumentPointerEnd);
    document.addEventListener("pointercancel", onDocumentPointerEnd);
    active = true;
  } finally {
    // A cancelled activation must not clear the flag of one started after it.
    if (gen === generation) activating = false;
  }
}

/** Hide the shape and fully restore normal map interaction — no lingering
 * pointer listeners, and a captured pointer released if a drag happened to
 * be mid-flight. Safe to call even if never activated. */
export function deactivateScaleBlob(map: maplibregl.Map): void {
  generation++;
  activating = false;
  if (dragging && activePointerId !== null) endDrag(activePointerId);
  if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
  hoverFrame = null;
  hoverPoint = null;

  // Layers referencing a source must go before the source itself.
  for (const id of [LABEL_LAYER_ID, OUTLINE_LAYER_ID, LAYER_ID]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [LABEL_SOURCE_ID, SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id);
  }

  const canvas = currentCanvas ?? map.getCanvas();
  canvas.removeEventListener("pointerdown", onPointerDown);
  canvas.removeEventListener("pointermove", onPointerMove);
  canvas.removeEventListener("pointerup", onPointerUp);
  canvas.removeEventListener("pointercancel", onPointerUp);
  document.removeEventListener("pointerup", onDocumentPointerEnd);
  document.removeEventListener("pointercancel", onDocumentPointerEnd);
  canvas.style.cursor = "";

  dragging = false;
  hovering = false;
  activePointerId = null;
  pointerDownPoint = null;
  active = false;
  shape = { groups: [], polygonsM: [] };
  pressedBand = null;
  offShapePress = null;
  if (selectedKey !== null) {
    selectedKey = null;
    selectionListener?.(null);
  }
  currentMap = null;
  currentCanvas = null;
}
