"""Pure functions for normalizing EFFIS WFS GeoJSON features into snapshot rows.

rows_from_features: convert raw features to rows with validated geometry and area.
completeness: extract WFS 2.0 response counters (numberMatched, numberReturned).
"""
from __future__ import annotations

import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .fetch_effis import EFFIS_TYPENAME, EFFIS_WFS, _features_from_text, _first, _parse_date
from .store import _naive_utc, _sql_path, connect, write_polygons

PAGE_SIZE = 1000
MIN_AGE_HOURS = 6.0
MAX_PAGES = 200  # hard stop: a server that never advances must not loop forever

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


def snapshot_path(settings) -> Path:
    return settings.data_dir / "raw" / "effis_ba.parquet"


def _is_feature_collection(text: str) -> bool:
    """True when the body IS a feature collection, however empty it is.

    `_features_from_text` yields [] for a genuinely empty FeatureCollection and
    for an OWS ExceptionReport alike, which makes end-of-data indistinguishable
    from the backend falling over mid-pagination. That difference decides
    whether an empty page completes a season or truncates one, so it has to be
    read off the body itself.

    Deliberately strict: anything we cannot positively identify as a collection
    is a failure. Over-rejecting costs one skipped refresh; over-accepting
    publishes a partial season as the authoritative total.
    """
    text = (text or "").strip()
    if not text:
        return False
    if text[0] in "{[":
        try:
            doc = json.loads(text)
        except ValueError:
            return False
        return isinstance(doc, dict) and isinstance(doc.get("features"), list)
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return False
    # An ExceptionReport parses perfectly well; only the tag tells them apart.
    return "featurecollection" in root.tag.rsplit("}", 1)[-1].lower()


def _page_url(start_index: int) -> str:
    return (
        f"{EFFIS_WFS}?service=WFS&version=2.0.0&request=GetFeature"
        f"&typename={EFFIS_TYPENAME}&outputformat=geojson&srsname=EPSG:4326"
        f"&count={PAGE_SIZE}&startIndex={start_index}"
    )


def should_fetch(path: Path, now: datetime, min_age_hours: float = MIN_AGE_HOURS) -> bool:
    """False while the stored snapshot is younger than the gate. EFFIS
    republishes burned areas roughly daily and its backend is fragile; the
    pipeline runs every 15 minutes, so without this we would hit it ~96x/day
    for a number that moves once.

    Age comes from the snapshot's own `fetched_at` column, NOT the file mtime:
    the file is rewritten by an R2 hydrate on every CI run, so its mtime says
    when we downloaded it, not when EFFIS was last asked. This snapshot only
    feeds fetch_effis_ba (live-map scar imagery) now — /scale's own "as of"
    date comes from fetch_effis_stats.py's independent snapshot instead.

    The path is interpolated into SQL, so it goes through `_sql_path`. Raw, an
    apostrophe in the data directory breaks the query, the `except` below reads
    it as an unreadable snapshot, and the 6-hour gate is silently disabled."""
    if not path.exists():
        return True
    con = None
    try:
        con = connect()
        newest = con.execute(
            f"SELECT max(fetched_at) FROM read_parquet('{_sql_path(path)}')"
        ).fetchone()[0]
    except Exception:  # noqa: BLE001 - an unreadable snapshot is worth refetching
        return True
    finally:
        if con is not None:
            con.close()
    if newest is None:
        return True
    try:
        if newest.tzinfo is None:
            newest = newest.replace(tzinfo=timezone.utc)
        return (now - newest).total_seconds() >= min_age_hours * 3600
    except (TypeError, AttributeError):  # naive now or non-datetime fetched_at
        return True


def _collect(http_get: Callable[[str], str]) -> list[dict] | None:
    """Every feature of the current season, or None if the response is unusable
    — down, malformed, or INCOMPLETE. A truncated season is worse than a
    slightly old one, so anything we cannot prove complete is rejected.

    Completeness is judged on features actually RECEIVED, not on the server's
    own numberReturned (which may overstate what it sent) and not on rows KEPT
    (rows_from_features legitimately drops untrusted geometry)."""
    rows: list[dict] = []
    seen = 0
    start = 0
    expected: int | None = None
    for _ in range(MAX_PAGES):
        text = http_get(_page_url(start))
        features = _features_from_text(text)
        try:
            payload = json.loads(text)
        except ValueError:
            payload = {}
        matched, _returned = completeness(payload)
        if matched is not None:
            # MONOTONIC, not last-wins: a later page reporting a SMALLER
            # numberMatched than one already seen would otherwise satisfy the
            # completion check below early and publish a truncated season as
            # authoritative. The largest figure the server ever claimed is the
            # one it has to make good on.
            expected = matched if expected is None else max(expected, matched)

        if not features:
            if not _is_feature_collection(text):
                # No features AND not a collection: an exception report or
                # garbage, not the end of the data. Without this an error page
                # closes the pagination and whatever we happened to have
                # collected so far is published as the complete season.
                return None
            if start == 0:
                return None  # down, exception report, or genuinely nothing
            if expected is not None and seen < expected:
                return None  # server promised more and then stopped: truncated
            return rows  # nothing left to page, and nothing outstanding

        seen += len(features)
        rows.extend(rows_from_features(features))
        start += len(features)  # advance by what ARRIVED, never by numberReturned

        if expected is not None and seen >= expected:
            return rows
        if expected is None and len(features) < PAGE_SIZE:
            return rows  # no counters to verify, but a short page ends the set
    return None  # MAX_PAGES exhausted: the server never finished


def _fault(exc: Exception) -> str:
    """A one-line reason, with the detail OWS hides in the response body.

    `raise_for_status()` gives "400 Client Error: Internal Server Error for url:
    ..." and stops there, but a WFS puts the actual cause in an
    `ows:ExceptionText` inside the body it just returned. The difference is the
    whole diagnosis: the useless version says the request failed, the useful one
    says `msOracleSpatialLayerOpen(): OracleSpatial error. Cannot create OCI
    Handlers` — EFFIS's backing database is down, nothing here is wrong, and no
    amount of retrying will help.

    The URL is dropped rather than echoed. It carries no credential (EFFIS is
    keyless) but it is long, and the status plus the exception text are what a
    reader acts on.
    """
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    body = getattr(response, "text", "") or ""
    detail = ""
    if body:
        try:
            root = ET.fromstring(body)
            texts = [
                (el.text or "").strip()
                for el in root.iter()
                if el.tag.endswith("ExceptionText")
            ]
            detail = next((t for t in texts if t), "")
        except ET.ParseError:
            detail = ""
    if not detail:
        detail = str(exc)
    return f"HTTP {status}: {detail}" if status else detail


def fetch_season_snapshot(
    settings, now: datetime, http_get: Callable[[str], str] | None = None,
) -> str:
    """Refresh the perimeter archive. Returns "fresh", "reused" or "stale".

    Guaranteed non-raising: any failure leaves the previous snapshot exactly as
    it was, so a bad EFFIS week degrades fetch_effis_ba to the same (aging)
    scar list rather than losing it. Scar cards date themselves from each
    perimeter's own firedate, not from this snapshot's fetch time — unlike
    fetch_effis_stats.py's snapshot, nothing here publishes a page-facing "as
    of" date, so a stale return has no visible staleness indicator to keep
    honest."""
    path = snapshot_path(settings)
    try:
        if not should_fetch(path, now):
            return "reused"
    except Exception:  # noqa: BLE001 - malformed snapshot is worth refetching
        pass

    if http_get is None:
        import requests

        def http_get(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=120)
            r.raise_for_status()
            return r.text

    reason: str | None = None
    try:
        rows = _collect(http_get)
    except Exception as exc:  # noqa: BLE001 - EFFIS is best-effort, never fatal
        rows = None
        reason = _fault(exc)
    if not rows:
        # Say WHY, because "stale" alone cannot. It is returned when the service
        # refuses us, when it answers with an empty feature set, and when paging
        # never terminates — three different situations with three different
        # responses, previously indistinguishable in the log and in the
        # manifest. Finding out which took reproducing the request by hand.
        #
        # Not an error line: a dark EFFIS is expected and must not fail a run
        # that is publishing live fire data perfectly well. This is the sentence
        # that answers "is it them or us?" without anyone leaving the log.
        print(
            f"[warn] effis-season: no rows, keeping the previous snapshot — "
            f"{reason or 'EFFIS returned an empty feature set'}",
            file=sys.stderr,
        )
        return "stale"

    try:
        deduped = {r["id"]: r for r in rows if "id" in r}
        stamped = [{**r, "fetched_at": _naive_utc(now)} for r in deduped.values()]
        if not stamped:
            return "stale"
        write_polygons(stamped, path)
    except Exception:  # noqa: BLE001 - write failure should not blank the snapshot
        return "stale"
    return "fresh"
