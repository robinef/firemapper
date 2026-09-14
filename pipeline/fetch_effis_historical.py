"""Real historical burned-area perimeters for pipeline/notable_scars.json's
curated fires, via EFFIS's per-year WFS at
maps.effis.emergency.copernicus.eu/effis — a separate, live service from the
current-season-only REST API in fetch_effis.py (that one silently ignores any
year/date filter and only ever returns this season's records). Confirmed live
by hand: ms:modis.ba.poly.<year> layers exist for 2016-2025, and a bbox query
near La Teste-de-Buch for 2022 returned real per-detection polygons dated
mid-July 2022.

Each WFS layer holds unclustered per-DETECTION polygons, not one row per named
fire event the way the current REST API's rows are — a real fire the size of
these curated megafires is usually several of them. fetch_historical_footprint
unions every polygon inside the scar's own before/after date window (and a
size-scaled bbox around its curated centroid) into one footprint via DuckDB
spatial's ST_Union_Agg.

Guaranteed non-raising: any failure (network, malformed response, a bad
geometry) degrades to None for that one fire — never breaks the pipeline. A
settled historical fire's perimeter never changes, so pipeline/run.py only
calls this once per fire, ever — see archive_effis_footprints's permanent
index.
"""
from __future__ import annotations

import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from functools import partial
from typing import Callable

from .store import connect

EFFIS_WFS_BASE = "https://maps.effis.emergency.copernicus.eu/effis"
# The curated list is 4 fires, ever (pipeline/notable_scars.json) — capped
# well below that count is pointless, but a pool still turns N independent,
# I/O-bound round trips into overlapping ones rather than N timeouts back to
# back. Same fix fetch_effis_stats.py already applied to its own 27
# sequential per-country calls (COUNTRY_FETCH_WORKERS there).
NOTABLE_FETCH_WORKERS = 4
# Floor for a small curated fire's own search radius, and the margin applied
# to a large one's — a real detection can land several km from the curated
# point centroid (see pipeline/fetch_imagery.py's _dedup_radius_km, same
# reasoning: two independently derived measures of the same fire's extent
# routinely disagree by more than a tight box).
MIN_SEARCH_RADIUS_KM = 3.0
RADIUS_SLACK = 1.5


def _search_radius_km(scar: dict) -> float:
    return max(MIN_SEARCH_RADIUS_KM, math.sqrt(scar["area_km2"] / math.pi) * RADIUS_SLACK)


def _bbox(lon: float, lat: float, radius_km: float) -> tuple[float, float, float, float]:
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(math.cos(math.radians(lat)), 0.01))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def _wfs_url(year: int, bbox: tuple[float, float, float, float]) -> str:
    minx, miny, maxx, maxy = bbox
    return (
        f"{EFFIS_WFS_BASE}?service=WFS&request=GetFeature"
        f"&typename=ms:modis.ba.poly.{year}&version=1.1.0"
        f"&srsName=EPSG:4326&bbox={minx},{miny},{maxx},{maxy}"
        f"&outputformat=geojson"
    )


def _years_spanning(before: str, after: str) -> list[int]:
    y0, y1 = date.fromisoformat(before).year, date.fromisoformat(after).year
    return list(range(y0, y1 + 1))


def _feature_in_window(feature: dict, before: date, after: date) -> bool:
    raw = (feature.get("properties") or {}).get("FIREDATE")
    if not raw:
        return False
    try:
        fdate = date.fromisoformat(str(raw)[:10])
    except ValueError:
        return False
    return before <= fdate <= after


def _union_geometries(geometries: list[dict]) -> dict | None:
    """DuckDB spatial ST_Union_Agg over the fetched polygons -> one GeoJSON
    Polygon/MultiPolygon. None on empty input or any spatial-engine failure —
    a malformed upstream geometry must never break the pipeline."""
    if not geometries:
        return None
    con = None
    try:
        con = connect()
        con.execute("CREATE TABLE _historical_footprint (geom GEOMETRY)")
        for geom in geometries:
            con.execute(
                "INSERT INTO _historical_footprint VALUES (ST_GeomFromGeoJSON(?))",
                [json.dumps(geom)],
            )
        row = con.execute(
            "SELECT ST_AsGeoJSON(ST_Union_Agg(geom)) FROM _historical_footprint"
        ).fetchone()
        return json.loads(row[0]) if row and row[0] else None
    except Exception:  # noqa: BLE001 - a bad geometry must not break the pipeline
        return None
    finally:
        if con is not None:
            con.close()


def fetch_historical_footprint(
    scar: dict, http_get: Callable[[str], str] | None = None,
) -> dict | None:
    """The real union perimeter for one curated fire (a notable_scars.json-
    shaped dict: id/lon/lat/area_km2/before/after), or None on any failure or
    empty result. Guaranteed non-raising."""
    if http_get is None:
        import requests

        def http_get(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            return r.text

    try:
        before = date.fromisoformat(scar["before"])
        after = date.fromisoformat(scar["after"])
        radius_km = _search_radius_km(scar)
        bbox = _bbox(scar["lon"], scar["lat"], radius_km)
        geometries: list[dict] = []
        for year in _years_spanning(scar["before"], scar["after"]):
            payload = json.loads(http_get(_wfs_url(year, bbox)))
            for feature in payload.get("features") or []:
                if _feature_in_window(feature, before, after):
                    geom = feature.get("geometry")
                    if geom:
                        geometries.append(geom)
        return _union_geometries(geometries)
    except Exception:  # noqa: BLE001 - best-effort historical enrichment
        return None


def fetch_historical_footprints(
    scars: list[dict], http_get: Callable[[str], str] | None = None,
    max_workers: int = NOTABLE_FETCH_WORKERS,
) -> dict[str, dict]:
    """{id: geometry} for every scar in `scars` that got a real footprint —
    a scar whose fetch failed or came up empty is simply absent, never
    raises. Runs the independent, I/O-bound per-scar fetches concurrently
    (see NOTABLE_FETCH_WORKERS) rather than one sequential round trip after
    another; each fetch_historical_footprint call is already individually
    guaranteed non-raising, so one fire failing never drops another."""
    if not scars:
        return {}
    fetch_one = partial(fetch_historical_footprint, http_get=http_get)
    with ThreadPoolExecutor(max_workers=min(max_workers, len(scars))) as pool:
        geometries = list(pool.map(fetch_one, scars))
    return {
        str(scar["id"]): geometry
        for scar, geometry in zip(scars, geometries)
        if geometry is not None
    }
