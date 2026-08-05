"""True isochrones: contours of a time-since-activity surface.

The previous implementation buffered each detection and unioned the results.
That is a dilation, not a contour — with ~2 km pixels and a 2.6 km buffer the
output shape is dictated by the buffer radius, so everything melts into one
blob and the "bands" carry almost no information.

This follows the approach routing engines use for isochrones (e.g. Valhalla):
build a scalar cost surface on a grid, then extract iso-contours from it.

The cost is **fire arrival time** — minutes since the fire first reached a
location — which is the direct analogue of Valhalla's travel time from an
origin. "Minutes since last active" was tried first and is nearly useless
here: Meteosat re-reports a burning pixel every 10 minutes, so the whole
active area shares one low value (81 of 118 pixels on a real Gironde fire sat
in a single band) and the surface is flat. Arrival time varies across the
scar, so its contours are the fire's actual advance.

Work happens per fire cluster so each grid stays small, and the grid is
metric-aware: longitude spacing is divided by cos(lat), otherwise cells are
~2.5x narrower on the ground in Lapland than in Andalusia.
"""
from __future__ import annotations

import math

import numpy as np
from contourpy import FillType, contour_generator

# Must mirror AGE_STOPS in the frontend so bands and legend agree — including
# the open-ended ">12 h" class. Without that final catch-all the map silently
# omits every pixel the fire reached more than 12 h ago, which on a real fire
# is most of it (90 of 118 pixels at Gironde), leaving bands that look
# offset from the detections rather than nested around them.
OPEN_BAND = 9999
DEFAULT_BANDS = [20, 60, 180, 360, 720, OPEN_BAND]

GRID_M = 500.0  # cell size of the cost surface

# Arrival time is interpolated (inverse distance weighted) over detections
# within SEARCH_M. This is the crux: taking a *hard-cutoff minimum* instead
# makes every level set exactly a union of discs of the cutoff radius — i.e.
# mathematically the same blobs as buffering, just drawn on a grid. Smooth
# interpolation lets the field vary between detections, so a contour runs
# where arrival time actually changes.
SEARCH_M = 7000.0
IDW_POWER = 2.0
# Cells further than this from any detection are outside the fire. Only the
# outermost boundary follows this radius; interior band edges are true contours.
MASK_M = 2400.0

CLUSTER_LINK_M = 12_000.0
PAD_M = 4000.0
UNREACHED = 1e6  # sentinel age for cells no detection informs

_M_PER_DEG_LAT = 110_540.0
_M_PER_DEG_LON = 111_320.0


def _lon_scale(lat: float) -> float:
    return max(math.cos(math.radians(lat)), 0.1)


def arrival_min(p: dict) -> float | None:
    """Minutes since the fire first reached this pixel.

    `first_min` is the oldest observation at the location; `age_min` (most
    recent) only describes whether it is still burning, not when it arrived.
    """
    v = p.get("first_min")
    if v is None:
        v = p.get("age_min")
    return None if v is None else float(v)


def cluster_points(points: list[dict], link_m: float = CLUSTER_LINK_M) -> list[list[dict]]:
    """Group detections into separate fires so each gets its own local grid."""
    if not points:
        return []
    lat0 = sum(p["lat"] for p in points) / len(points)
    dlat = link_m / _M_PER_DEG_LAT
    dlon = link_m / (_M_PER_DEG_LON * _lon_scale(lat0))

    buckets: dict[tuple[int, int], list[int]] = {}
    for i, p in enumerate(points):
        buckets.setdefault((int(p["lat"] // dlat), int(p["lon"] // dlon)), []).append(i)

    parent = list(range(len(points)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for (gy, gx), idxs in buckets.items():
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for j in buckets.get((gy + dy, gx + dx), ()):
                    union(idxs[0], j)
        for i in idxs:
            union(idxs[0], i)

    groups: dict[int, list[dict]] = {}
    for i, p in enumerate(points):
        groups.setdefault(find(i), []).append(p)
    return list(groups.values())


def _cost_surface(pts: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Grid of minutes-since-last-activity, plus its lon/lat axes."""
    lat0 = sum(p["lat"] for p in pts) / len(pts)
    lon_m = _M_PER_DEG_LON * _lon_scale(lat0)
    dlat, dlon = GRID_M / _M_PER_DEG_LAT, GRID_M / lon_m
    pad_lat, pad_lon = PAD_M / _M_PER_DEG_LAT, PAD_M / lon_m

    lats = np.array([p["lat"] for p in pts])
    lons = np.array([p["lon"] for p in pts])
    ages = np.array([arrival_min(p) for p in pts], dtype=float)

    ys = np.arange(lats.min() - pad_lat, lats.max() + pad_lat + dlat, dlat)
    xs = np.arange(lons.min() - pad_lon, lons.max() + pad_lon + dlon, dlon)
    gx, gy = np.meshgrid(xs, ys)
    num = np.zeros(gx.shape)      # sum of weight * arrival
    den = np.zeros(gx.shape)      # sum of weight
    nearest = np.full(gx.shape, np.inf)

    ry, rx = SEARCH_M / _M_PER_DEG_LAT, SEARCH_M / lon_m
    for lat, lon, age in zip(lats, lons, ages):
        # Only touch the window a detection can influence — keeps this linear
        # in detections rather than detections x grid cells.
        j0, j1 = np.searchsorted(xs, [lon - rx, lon + rx])
        i0, i1 = np.searchsorted(ys, [lat - ry, lat + ry])
        if j0 >= j1 or i0 >= i1:
            continue
        sub_x, sub_y = gx[i0:i1, j0:j1], gy[i0:i1, j0:j1]
        dist = np.hypot((sub_x - lon) * lon_m, (sub_y - lat) * _M_PER_DEG_LAT)
        np.minimum(nearest[i0:i1, j0:j1], dist, out=nearest[i0:i1, j0:j1])
        # Clamp so a cell sitting exactly on a detection does not divide by 0.
        w = np.where(dist <= SEARCH_M, 1.0 / np.maximum(dist, 1.0) ** IDW_POWER, 0.0)
        num[i0:i1, j0:j1] += w * age
        den[i0:i1, j0:j1] += w

    z = np.full(gx.shape, UNREACHED)
    inside = (den > 0) & (nearest <= MASK_M)
    z[inside] = num[inside] / den[inside]
    return z, xs, ys


def _rings_to_polygons(points_arr, offsets, outer_offsets) -> list[list]:
    """contourpy chunk output → GeoJSON polygon coordinate arrays."""
    polys: list[list] = []
    for k in range(len(outer_offsets) - 1):
        rings = []
        for r in range(outer_offsets[k], outer_offsets[k + 1]):
            ring = points_arr[offsets[r] : offsets[r + 1]]
            if len(ring) >= 4:
                rings.append([[float(x), float(y)] for x, y in ring])
        if rings:
            polys.append(rings)
    return polys


def build_isochrones(
    points: list[dict], bands: list[int] | None = None
) -> list[dict]:
    """Return [{'max_age': T, 'geometry': geojson}] ordered oldest band first."""
    bands = sorted(bands or DEFAULT_BANDS)
    usable = [p for p in points if arrival_min(p) is not None]
    if not usable:
        return []

    per_band: dict[int, list[list]] = {b: [] for b in bands}
    for cluster in cluster_points(usable):
        if len(cluster) < 2:
            continue  # a lone pixel has no surface to contour
        z, xs, ys = _cost_surface(cluster)
        gen = contour_generator(
            x=xs, y=ys, z=z, fill_type=FillType.ChunkCombinedOffsetOffset
        )
        for band in bands:
            # Area where the fire was active within the last `band` minutes.
            filled = gen.filled(-1.0, float(band))
            pts_list, off_list, outer_list = filled[0], filled[1], filled[2]
            for chunk_pts, chunk_off, chunk_outer in zip(pts_list, off_list, outer_list):
                if chunk_pts is None:
                    continue
                per_band[band].extend(
                    _rings_to_polygons(chunk_pts, chunk_off, chunk_outer)
                )

    out: list[dict] = []
    for band in bands:
        polys = per_band[band]
        if not polys:
            continue
        out.append(
            {"max_age": band, "geometry": {"type": "MultiPolygon", "coordinates": polys}}
        )
    # Oldest (largest) band first so newer, tighter contours draw on top.
    return sorted(out, key=lambda b: -b["max_age"])


def isochrone_features(points: list[dict], bands: list[int] | None = None) -> list[dict]:
    return [
        {"type": "Feature", "geometry": b["geometry"], "properties": {"max_age": b["max_age"]}}
        for b in build_isochrones(points, bands)
    ]


def _in_ring(lon: float, lat: float, ring: list) -> bool:
    """Ray-casting crossing test for one linear ring."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class FootprintIndex:
    """Point-in-polygon test against the open-ended arrival band.

    The frontend hands the fire dot over to this footprint outline at high
    zoom, so a fire that is NOT inside it has nothing left to draw and simply
    disappears. That is most of them: the band is interpolated from several
    detections, so a fire seen as a single pixel — the dominant case — never
    produces one. Stamping membership here lets the map fade only the dots
    that have an outline to fade INTO.

    Pure Python on purpose: shapely would do this in one call but is not a
    dependency, and adding a compiled one to answer a boolean is a poor trade.
    A bounding box per polygon keeps it cheap — nearly every (fire, polygon)
    pair is rejected on four comparisons.
    """

    def __init__(self, geometry: dict | None) -> None:
        self._polys: list[list] = []
        self._boxes: list[tuple[float, float, float, float]] = []
        if not geometry:
            return
        coords = geometry.get("coordinates") or []
        polys = coords if geometry.get("type") == "MultiPolygon" else [coords]
        for poly in polys:
            if not poly or not poly[0]:
                continue
            xs = [p[0] for p in poly[0]]
            ys = [p[1] for p in poly[0]]
            self._polys.append(poly)
            self._boxes.append((min(xs), min(ys), max(xs), max(ys)))

    def __len__(self) -> int:
        return len(self._polys)

    def contains(self, lon: float, lat: float) -> bool:
        for poly, (x0, y0, x1, y1) in zip(self._polys, self._boxes):
            if lon < x0 or lon > x1 or lat < y0 or lat > y1:
                continue
            if not _in_ring(lon, lat, poly[0]):
                continue
            # Inside the exterior ring — but a hole puts it back outside.
            if any(_in_ring(lon, lat, hole) for hole in poly[1:]):
                continue
            return True
        return False


def open_band_geometry(features: list[dict]) -> dict | None:
    """The open-ended band's geometry, which is what the map draws as the
    footprint. Returns None when this run produced no bands at all."""
    for f in features:
        if (f.get("properties") or {}).get("max_age") == OPEN_BAND:
            return f.get("geometry")
    return None
