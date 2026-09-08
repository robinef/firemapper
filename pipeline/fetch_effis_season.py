"""Fetch and normalise EFFIS's current-season burned-area REST API into
snapshot rows.

fetch_season_snapshot fetches at most once per gate window (see
should_fetch) and stores the perimeters as a GeoParquet snapshot via
write_polygons; fetch_effis_ba (pipeline/fetch_effis.py) reads that snapshot
and never touches the network itself — one fragile backend, one request.

The REST API (EFFIS_BA_REST, in pipeline/fetch_effis.py) supports
server-side ordering + limiting, so one request for the FETCH_LIMIT
largest-by-area current-season records replaces what used to be a full WFS
pagination loop. A full-season fetch was measured infeasible (16,815+
records this season, ~34MB/43s for 200 records with full geometry) — see
docs/superpowers/specs/2026-09-08-effis-rest-api-migration-design.md for the
measurement and for why FETCH_BUFFER exists (headroom so records dropped by
_rows_from_records's own validation don't starve the final count below
DEFAULT_BA_LIMIT).
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .fetch_effis import DEFAULT_BA_LIMIT, EFFIS_BA_REST, _first, _parse_date
from .store import _naive_utc, _sql_path, connect, write_polygons

FETCH_BUFFER = 50  # headroom above DEFAULT_BA_LIMIT: invalid rows dropped by
                    # _rows_from_records inside the fetch window must not
                    # starve the final count below what fetch_effis_ba wants.
FETCH_LIMIT = DEFAULT_BA_LIMIT + FETCH_BUFFER
MIN_AGE_HOURS = 6.0


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


def _rows_from_records(records: list[dict]) -> list[dict]:
    """Normalise raw REST burned-area records into snapshot rows, dropping
    anything that cannot be trusted in a quoted total: a missing id,
    non-polygon geometry, absent or non-positive area."""
    rows: list[dict] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        if rid in (None, ""):
            continue
        wkt = _polygon_wkt(rec.get("shape"))
        if wkt is None:
            continue
        try:
            area_ha = float(rec.get("area_ha"))
        except (TypeError, ValueError):
            continue
        if area_ha <= 0:
            continue
        country = rec.get("country")
        place = _first(rec, ("province", "commune"))
        rows.append({
            "id": str(rid),
            "geometry_wkt": wkt,
            "area_ha": area_ha,
            "firedate": _parse_date(rec.get("firedate")),
            "country": str(country) if country is not None else None,
            "place": str(place) if place is not None else None,
        })
    return rows


def snapshot_path(settings) -> Path:
    return settings.data_dir / "raw" / "effis_ba.parquet"


def should_fetch(path: Path, now: datetime, min_age_hours: float = MIN_AGE_HOURS) -> bool:
    """False while the stored snapshot is younger than the gate. EFFIS
    republishes burned areas roughly daily; the pipeline runs every 15
    minutes, so without this we would hit it ~96x/day for a number that
    moves once.

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


def _fetch_url(now: datetime) -> str:
    season_start = f"{now.year}-01-01T00:00:00"
    return (
        f"{EFFIS_BA_REST}?firedate__gte={season_start}"
        f"&ordering=-area_ha&limit={FETCH_LIMIT}"
    )


def _fetch_season(http_get: Callable[[str], str], now: datetime) -> list[dict]:
    """The FETCH_LIMIT largest-by-area current-season records. Raises on
    anything that makes the response untrustworthy — malformed JSON, an
    unexpected shape, or a truncated page — so fetch_season_snapshot's
    existing exception handling (and _fault) reports the specific cause
    instead of a generic failure. A genuinely empty (but valid) result set
    is NOT an error: it returns [] normally.

    Distinguishing these matters most for truncation: if EFFIS ever imposes a
    server-side max_limit below FETCH_LIMIT, every fetch would truncate
    forever, freezing the snapshot permanently while the log said only
    "empty result set" — a silent, self-perpetuating failure the old WFS
    (which at least errored identifiably every time) did not have."""
    text = http_get(_fetch_url(now))
    try:
        payload = json.loads(text)
    except ValueError:
        raise ValueError(f"EFFIS response was not valid JSON: {text[:200]!r}") from None
    if not isinstance(payload, dict):
        raise ValueError(f"EFFIS response was not a JSON object (got {type(payload).__name__})")
    results = payload.get("results")
    if not isinstance(results, list):
        raise ValueError(f"EFFIS response 'results' was not a list (got {type(results).__name__})")
    count = payload.get("count")
    expected = min(count, FETCH_LIMIT) if isinstance(count, int) else len(results)
    if len(results) != expected:
        raise ValueError(
            f"EFFIS response looked truncated: got {len(results)} records, "
            f"expected {expected} (count={count}, FETCH_LIMIT={FETCH_LIMIT})"
        )
    return _rows_from_records(results)


def _fault(exc: Exception) -> str:
    """One-line reason. The REST API errors as plain HTTP + a body (JSON
    `detail` when the backend is up but complaining, HTML/plain text on a
    gateway failure) — unlike the old WFS's OWS ExceptionReport XML embedded
    in a 200 body, so no XML parsing here."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    body = getattr(response, "text", "") or ""
    detail = ""
    if body:
        try:
            doc = json.loads(body)
            if isinstance(doc, dict):
                detail = doc.get("detail") or doc.get("message") or doc.get("error") or ""
        except ValueError:
            detail = body
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
        rows = _fetch_season(http_get, now)
    except Exception as exc:  # noqa: BLE001 - EFFIS is best-effort, never fatal
        rows = None
        reason = _fault(exc)
    if not rows:
        print(
            f"[warn] effis-season: no rows, keeping the previous snapshot — "
            f"{reason or 'EFFIS returned an empty result set'}",
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
