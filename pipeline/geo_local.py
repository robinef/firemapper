"""Tangent-plane local-metric projection, shared by the year-blob export.

Area-accurate within ~500km of the origin (see docs/superpowers/specs/
2026-09-09-fire-scale-blob-design.md) — the cos(origin_lat) correction is
what keeps longitude distances honest away from the equator.
"""
import math

import h3

R_EARTH_M = 6371000.0


def latlon_to_local_m(lat: float, lon: float, origin_lat: float, origin_lon: float) -> tuple[float, float]:
    dlat = math.radians(lat - origin_lat)
    dlon = math.radians(lon - origin_lon)
    y_m = dlat * R_EARTH_M
    x_m = dlon * R_EARTH_M * math.cos(math.radians(origin_lat))
    return x_m, y_m


def local_m_to_latlon(x_m: float, y_m: float, origin_lat: float, origin_lon: float) -> tuple[float, float]:
    lat = origin_lat + math.degrees(y_m / R_EARTH_M)
    lon = origin_lon + math.degrees(x_m / (R_EARTH_M * math.cos(math.radians(origin_lat))))
    return lat, lon


def cell_boundary_local_m(cell_id: str, origin_lat: float, origin_lon: float) -> list[tuple[float, float]]:
    """Real H3 cell boundary (not a reconstructed regular hexagon), projected to
    local meters relative to (origin_lat, origin_lon)."""
    return [
        latlon_to_local_m(lat, lng, origin_lat, origin_lon)
        for lat, lng in h3.cell_to_boundary(cell_id)
    ]


def centroid_of_cells(cell_ids: list[str]) -> tuple[float, float]:
    positions = [h3.cell_to_latlng(c) for c in cell_ids]
    lat = sum(p[0] for p in positions) / len(positions)
    lon = sum(p[1] for p in positions) / len(positions)
    return lat, lon
