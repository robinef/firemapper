"""Pure functions for normalizing EFFIS WFS GeoJSON features into snapshot rows.

rows_from_features: convert raw features to rows with validated geometry and area.
completeness: extract WFS 2.0 response counters (numberMatched, numberReturned).
"""
from __future__ import annotations

import hashlib

from .fetch_effis import _first, _parse_date

_AREA_KEYS = ("area_ha", "AREA_HA", "area", "AREA")
_DATE_KEYS = ("firedate", "FIREDATE", "lastupdate", "LASTUPDATE",
              "initialdate", "INITIALDATE")
_COUNTRY_KEYS = ("country", "COUNTRY", "em_ctr_code", "EM_CTR_CODE",
                 "iso2", "ISO2", "iso3", "ISO3")
_PLACE_KEYS = ("place_name", "PLACE_NAME", "province", "PROVINCE",
               "commune", "COMMUNE")


def _ring_wkt(ring) -> str | None:
    """GeoJSON ring (linear array) -> WKT. None if empty, malformed, or unclosed."""
    pts = []
    for point in ring or []:
        try:
            lon, lat = float(point[0]), float(point[1])
        except (TypeError, ValueError, IndexError, KeyError):
            return None
        pts.append(f"{lon} {lat}")
    if len(pts) < 4:
        return None
    # Check ring closure: first and last coordinate must be equal
    if ring[0] != ring[-1]:
        return None
    return f"({', '.join(pts)})"


def _polygon_wkt(geometry) -> str | None:
    """GeoJSON Polygon/MultiPolygon -> WKT. Anything else -> None (dropped)."""
    if not isinstance(geometry, dict):
        return None
    kind = geometry.get("type")
    coords = geometry.get("coordinates")
    if kind == "Polygon":
        rings = [_ring_wkt(r) for r in coords or []]
        if not rings or any(r is None for r in rings):
            return None
        return f"POLYGON({', '.join(rings)})"
    if kind == "MultiPolygon":
        polys = []
        for poly in coords or []:
            rings = [_ring_wkt(r) for r in poly or []]
            if not rings or any(r is None for r in rings):
                return None
            polys.append(f"({', '.join(rings)})")
        if not polys:
            return None
        return f"MULTIPOLYGON({', '.join(polys)})"
    return None


def _feature_id(feat: dict, props: dict, wkt: str) -> str:
    """The server's feature id when it gives one; otherwise a deterministic
    hash of the geometry, so the same perimeter keeps its identity across
    fetches and dedup works."""
    for candidate in (feat.get("id"), _first(props, ("id", "ID", "fid", "FID"))):
        if candidate not in (None, ""):
            return str(candidate)
    return "effis-" + hashlib.sha1(wkt.encode()).hexdigest()[:16]


def rows_from_features(features: list[dict]) -> list[dict]:
    """Normalise raw features into snapshot rows, dropping anything that cannot
    be trusted in a quoted total: non-polygon geometry, absent or non-positive
    area."""
    rows: list[dict] = []
    for feat in features or []:
        if not isinstance(feat, dict):
            continue
        props = feat.get("properties") or {}
        if not isinstance(props, dict):
            continue
        wkt = _polygon_wkt(feat.get("geometry"))
        if wkt is None:
            continue
        raw_area = _first(props, _AREA_KEYS)
        try:
            area_ha = float(raw_area)
        except (TypeError, ValueError):
            continue
        if area_ha <= 0:
            continue
        country = _first(props, _COUNTRY_KEYS)
        place = _first(props, _PLACE_KEYS)
        rows.append({
            "id": _feature_id(feat, props, wkt),
            "geometry_wkt": wkt,
            "area_ha": area_ha,
            "firedate": _parse_date(_first(props, _DATE_KEYS)),
            "country": str(country) if country is not None else None,
            "place": str(place) if place is not None else None,
        })
    return rows


def completeness(payload: dict) -> tuple[int | None, int | None]:
    """(numberMatched, numberReturned) from a WFS 2.0 GeoJSON res, or
    (None, None) when the server omits them."""
    def as_int(val):
        try:
            return int(val)
        except (TypeError, ValueError):
            return None
    if not isinstance(payload, dict):
        return (None, None)
    return (as_int(payload.get("numberMatched")), as_int(payload.get("numberReturned")))
