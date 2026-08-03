import maplibregl from "maplibre-gl";
import { cellToBoundary, latLngToCell } from "h3-js";

/**
 * Overview time-scrubber: click a day on the bottom histogram and this paints
 * that day's fire detections across Europe as res-5 H3 hexes, shaded by how many
 * detections fell in each. Answers "where was fire burning on that day?" at the
 * continental scale — the counterpart to the per-fire bin locator in the card.
 */
export const DAY_SLICE_LAYER = "day-slice-fill";
const DAY_SLICE_LINE = "day-slice-line";
/** Resolution the pipeline rolls detections up to (day_slices.py res=5). */
export const SLICE_RES = 5;

/** Polygons for a day's cells, each carrying its own h3 index.
 *
 * The index is what makes the hex clickable: a slice cell is an aggregate of
 * every detection that day, so there is no single event id to carry, and the
 * click has to resolve the cell against the loaded events instead. */
export function sliceFeatures(cells: [string, number][]): GeoJSON.Feature[] {
  return cells.map(([cell, n]) => {
    const ring = cellToBoundary(cell).map(([lat, lng]) => [lng, lat]);
    ring.push(ring[0]); // close polygon
    return {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { n, cell },
    };
  });
}

/** Fires whose centroid sits in `cell`, biggest first.
 *
 * A res-5 hex is ~250 km2 and routinely holds several fires, so the reader
 * almost always means the largest. Empty is a legitimate answer: slices go back
 * 30 days but clustering keeps 14 (events.py WINDOW_DAYS), so an older day has
 * no fire records left to open. */
export function firesInCell(
  fires: GeoJSON.Feature[],
  cell: string,
  res: number = SLICE_RES,
): GeoJSON.Feature[] {
  return fires
    .filter((f) => {
      if (f.geometry?.type !== "Point") return false;
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      return latLngToCell(lat, lon, res) === cell;
    })
    .sort(
      (a, b) =>
        Number((b.properties as { area_km2?: number })?.area_km2 ?? 0) -
        Number((a.properties as { area_km2?: number })?.area_km2 ?? 0),
    );
}

export function addDaySlice(map: maplibregl.Map): void {
  if (map.getSource("day-slice")) return;
  map.addSource("day-slice", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Added before the fire layers, so live fires always draw on top of the slice.
  map.addLayer({
    id: DAY_SLICE_LAYER,
    type: "fill",
    source: "day-slice",
    layout: { visibility: "none" },
    paint: {
      "fill-color": [
        "interpolate", ["linear"], ["get", "n"],
        1, "#ffd000", 20, "#ff8c00", 80, "#ff5a1f", 200, "#ff2d2d",
      ],
      "fill-opacity": 0.5,
    },
  });
  map.addLayer({
    id: DAY_SLICE_LINE,
    type: "line",
    source: "day-slice",
    layout: { visibility: "none" },
    paint: { "line-color": "#ff6b00", "line-width": 0.4, "line-opacity": 0.25 },
  });
}

/** Paint a day's cells ([h3, count] pairs) and show the layer. */
export function setDaySlice(map: maplibregl.Map, cells: [string, number][]): void {
  (map.getSource("day-slice") as maplibregl.GeoJSONSource).setData({
    type: "FeatureCollection",
    features: sliceFeatures(cells),
  });
  for (const id of [DAY_SLICE_LAYER, DAY_SLICE_LINE]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
  }
}

export function hideDaySlice(map: maplibregl.Map): void {
  for (const id of [DAY_SLICE_LAYER, DAY_SLICE_LINE]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  }
}
