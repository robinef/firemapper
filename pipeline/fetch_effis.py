"""EFFIS burned areas as a best-effort auto source of historical "past" scars.

EFFIS (the EU's Emergency Management Service fire component) publishes
burned-area perimeters for the current season through a REST API.
fetch_effis_season (pipeline/fetch_effis_season.py) fetches it at most once
per gate window and stores the perimeters as a GeoParquet snapshot;
fetch_effis_ba reads THAT snapshot, turns each burned polygon into a
before/after scar (same shape as build_scars() output), and hands them to
build_imagery() alongside our own FIRMS-derived scars. One fragile backend,
one request.

fetch_effis_ba is guaranteed non-raising: on ANY error — missing snapshot,
unreadable snapshot, malformed row — it returns [] and NEVER raises. EFFIS is
a bonus tier; the map must never depend on it being up.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Callable

# REST burned-area endpoint (DRF-style JSON, keyless, CORS-enabled).
# Replaced the ies-ows.jrc.ec.europa.eu WFS in 2026-09 after EFFIS
# decommissioned it — a 200 OK whose body was an HTML MapServer error, on
# every request. Not a transient outage: effis.jrc.ec.europa.eu now
# redirects to forest-fire.emergency.copernicus.eu. Reverse-engineered from
# the live app's own network calls; see
# docs/superpowers/specs/2026-09-08-effis-rest-api-migration-design.md.
EFFIS_BA_REST = "https://api.effis.emergency.copernicus.eu/rest/2/burntareas/current/"

BASELINE_LEAD_DAYS = 6   # "before" image this many days pre-fire
SCAR_SETTLE_DAYS = 14    # "after" this long post-ignition (settled black scar)
# The largest N burned-area scars kept — both as the basis for
# fetch_effis_season.py's FETCH_LIMIT (buffer-adjusted) and as the read-time
# SQL LIMIT below. 12 was a placeholder from when this was a bonus handful
# of megafires; our own sensors only see 45 days back (SCAR_WINDOW_DAYS), so
# EFFIS is the only path to a real fire older than that, and a modest
# French/Iberian burn was getting crowded out by nothing at all — the cap
# was just too tight to matter.
DEFAULT_BA_LIMIT = 200


def _first(props: dict, keys) -> object | None:
    for k in keys:
        v = props.get(k)
        if v not in (None, ""):
            return v
    return None


def _parse_date(value) -> date | None:
    """Best-effort YYYY-MM-DD out of whatever the date attribute holds."""
    if value is None:
        return None
    s = str(value).strip()
    # Epoch millis/seconds (defensive: kept from the WFS days, harmless if
    # the REST API never sends this shape).
    if s.isdigit() and len(s) >= 10:
        try:
            ts = int(s)
            if len(s) > 10:  # milliseconds
                ts //= 1000
            return datetime.fromtimestamp(ts, tz=timezone.utc).date()
        except (ValueError, OverflowError, OSError):
            return None
    head = s.replace("/", "-")[:10]
    try:
        return datetime.strptime(head, "%Y-%m-%d").date()
    except ValueError:
        return None


def fetch_effis_ba(
    settings, http_get: Callable[[str], str] | None = None,
    limit: int = DEFAULT_BA_LIMIT,
) -> list[dict]:
    """The largest `limit` burned-area scars, read from the stored perimeter
    archive rather than the network.

    EFFIS is fetched once per pipeline run at most (see fetch_effis_season),
    and everything reads that snapshot — one fragile backend, one request.
    `http_get` is accepted for signature compatibility and ignored.

    Guaranteed non-raising: a missing or unreadable snapshot yields []."""
    from .fetch_effis_season import snapshot_path
    from .store import _sql_path, connect

    con = None
    try:
        path = snapshot_path(settings)
        if not path.exists():
            return []
        con = connect()
        # NOTE: `limit` is applied by SQL, i.e. BEFORE the per-row guard below,
        # whereas fetch_effis_season.py's own normalizer already dropped
        # malformed rows before they ever reached the snapshot. So a row the
        # loop below skips shrinks the result below `limit` rather than being
        # backfilled. Only reachable with a foreign-written snapshot, which
        # degrades to [] anyway.
        rows = con.execute(
            f"""SELECT id, firedate, place, area_ha,
                       ST_X(ST_Centroid(geometry)) AS lon,
                       ST_Y(ST_Centroid(geometry)) AS lat
                FROM read_parquet('{_sql_path(path)}')
                WHERE firedate IS NOT NULL AND geometry IS NOT NULL
                ORDER BY area_ha DESC
                LIMIT {int(limit)}"""
        ).fetchall()
    except Exception:  # noqa: BLE001 - a bad snapshot must not break the map
        return []
    finally:
        if con is not None:
            con.close()

    today = datetime.now(timezone.utc).date()
    yesterday = today - timedelta(days=1)
    scars: list[dict] = []
    for fid, fire_date, place, area_ha, lon, lat in rows:
        try:
            before = fire_date - timedelta(days=BASELINE_LEAD_DAYS)
            # Settled black scar, but never a date we cannot have imagery for
            # yet, and never before ignition.
            after = max(min(fire_date + timedelta(days=SCAR_SETTLE_DAYS), yesterday), fire_date)
            scar = {
                "id": str(fid),
                "label": (
                    f"{place} · {fire_date.year}" if place
                    else f"Burn scar · {fire_date.isoformat()}"
                ),
                "kind": "past",
                "lon": round(float(lon), 4),
                "lat": round(float(lat), 4),
                # A mapped polygon, not a sensor-cell floor — no `cum_cells`,
                # so areaText() never puts the "≤" unsized marker on it.
                "area_km2": round(float(area_ha) / 100, 1),
                "started": fire_date.isoformat(),
                "before": before.isoformat(),
                "after": after.isoformat(),
            }
        except Exception:  # noqa: BLE001 - skip a malformed row, keep going
            continue
        if place:
            scar["place"] = str(place)
        scars.append(scar)
    return scars
