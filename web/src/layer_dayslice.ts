import maplibregl from "maplibre-gl";
import { cellToBoundary } from "h3-js";

/**
 * Overview time-scrubber: click a day on the bottom histogram and this paints
 * that day's fire detections across Europe as res-5 H3 hexes, shaded by how many
 * detections fell in each. Answers "where was fire burning on that day?" at the
 * continental scale — the counterpart to the per-fire bin locator in the card.
 */
export const DAY_SLICE_LAYER = "day-slice-fill";
const DAY_SLICE_LINE = "day-slice-line";

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
  const features: GeoJSON.Feature[] = cells.map(([cell, n]) => {
    const ring = cellToBoundary(cell).map(([lat, lng]) => [lng, lat]);
    ring.push(ring[0]); // close the polygon
    return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { n } };
  });
  (map.getSource("day-slice") as maplibregl.GeoJSONSource).setData({
    type: "FeatureCollection",
    features,
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
