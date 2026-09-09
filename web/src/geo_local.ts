// Tangent-plane local-metric projection for the scale-comparison blob.
// Mirrors pipeline/geo_local.py's math exactly — see
// docs/superpowers/specs/2026-09-09-fire-scale-blob-design.md for why a
// flat tangent-plane transform (not a full equal-area projection) is
// sufficient here: packing keeps the blob's extent small by construction.

export const R_EARTH_M = 6371000.0;
export const MAX_EXTENT_M = 500_000; // 500 km
export const MAX_AREA_ERROR = 0.02; // 2%

export function localMToLatLon(
  xM: number,
  yM: number,
  dropLat: number,
  dropLon: number,
): [number, number] {
  const lat = dropLat + (yM / R_EARTH_M) * (180 / Math.PI);
  const lon =
    dropLon +
    (xM / (R_EARTH_M * Math.cos((dropLat * Math.PI) / 180))) *
      (180 / Math.PI);
  return [lat, lon];
}

export function projectVertices(
  verticesM: [number, number][],
  dropLat: number,
  dropLon: number,
): [number, number][] {
  return verticesM.map(([xM, yM]) => {
    const [lat, lon] = localMToLatLon(xM, yM, dropLat, dropLon);
    return [lon, lat] as [number, number]; // GeoJSON is [lon, lat]
  });
}

export function checkExtentBudget(
  allVerticesM: [number, number][][],
): boolean {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const poly of allVerticesM) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  if (extent > MAX_EXTENT_M) {
    console.warn(
      `scale blob extent ${Math.round(extent)}m exceeds the ${MAX_EXTENT_M}m accuracy budget; ` +
        `area may be distorted at the current drop position`,
    );
    return false;
  }
  return true;
}
