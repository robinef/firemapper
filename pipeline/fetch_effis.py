"""EFFIS burned areas as a best-effort auto source of historical "past" scars.

EFFIS (the EU's Emergency Management Service fire component) publishes a WFS
burned-area layer covering the current season. fetch_effis_season fetches it at
most once per gate window and stores the perimeters as a GeoParquet snapshot;
fetch_effis_ba reads THAT snapshot, turns each burned polygon into a before/after
scar (same shape as build_scars() output), and hands them to build_imagery()
alongside our own FIRMS-derived scars. One fragile backend, one request.

This module also owns the response parsing (_features_from_text and friends),
which fetch_effis_season imports to read the wire format.

IMPORTANT: the endpoint's Oracle Spatial backend is frequently DOWN and answers
a perfectly-formed HTTP 200 whose body is an OWS ExceptionReport
("OracleSpatial error … Connection failure"), not features. So every path here is
guarded: a body that is not a feature collection parses to no features, and on
ANY error — missing snapshot, unreadable snapshot, malformed row — fetch_effis_ba
returns [] and NEVER raises. EFFIS is a bonus tier; the map must never depend on
it being up.
"""
from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from typing import Callable

# WFS GetFeature against the EFFIS burned-area layer. GeoJSON is requested when
# the server offers it; older GML is parsed defensively as a fallback.
EFFIS_WFS = "https://ies-ows.jrc.ec.europa.eu/effis"
EFFIS_TYPENAME = "ercc.ba"

BASELINE_LEAD_DAYS = 6   # "before" image this many days pre-fire
SCAR_SETTLE_DAYS = 14    # "after" this long post-ignition (settled black scar)


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
    # Epoch millis/seconds (some WFS servers emit numeric timestamps).
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


def _features_from_text(text: str) -> list[dict]:
    """Extract a list of GeoJSON-shaped features from the response body, or []
    for anything that is not a feature collection (incl. OWS ExceptionReport)."""
    text = (text or "").strip()
    if not text:
        return []
    # GeoJSON path.
    if text[0] in "{[":
        try:
            doc = json.loads(text)
        except ValueError:
            return []
        if isinstance(doc, dict):
            feats = doc.get("features")
            if isinstance(feats, list):
                return [f for f in feats if isinstance(f, dict)]
        return []
    # XML path: an ExceptionReport is NOT features; a GML FeatureCollection is.
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    tag = root.tag.rsplit("}", 1)[-1].lower()
    if "exception" in tag:  # ExceptionReport / ServiceExceptionReport → down
        return []
    return _features_from_gml(root)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _features_from_gml(root: ET.Element) -> list[dict]:
    """Very defensive GML→GeoJSON-ish shim: pull attribute text and any
    gml:posList/gml:pos/coordinates into a coordinate list per member."""
    features: list[dict] = []
    members = [
        el for el in root.iter()
        if _local(el.tag).lower() in ("featuremember", "member")
    ]
    for member in members:
        props: dict[str, str] = {}
        coords: list[list[float]] = []
        for el in member.iter():
            name = _local(el.tag)
            low = name.lower()
            text = (el.text or "").strip()
            if low in ("poslist", "coordinates") and text:
                coords.extend(_parse_gml_coords(text, swap=low == "poslist"))
            elif low == "pos" and text:
                coords.extend(_parse_gml_coords(text, swap=True))
            elif text and low not in ("featuremember", "member"):
                props.setdefault(name, text)
        if coords:
            features.append({
                "properties": props,
                "geometry": {"type": "MultiPoint", "coordinates": coords},
            })
    return features


def _parse_gml_coords(text: str, swap: bool) -> list[list[float]]:
    """gml:posList is lat lon lat lon…; gml:coordinates is lon,lat lon,lat…."""
    out: list[list[float]] = []
    if "," in text:  # gml:coordinates "lon,lat lon,lat"
        for pair in text.split():
            parts = pair.split(",")
            if len(parts) >= 2:
                try:
                    out.append([float(parts[0]), float(parts[1])])
                except ValueError:
                    continue
        return out
    nums = text.split()
    for i in range(0, len(nums) - 1, 2):
        try:
            a, b = float(nums[i]), float(nums[i + 1])
        except ValueError:
            continue
        out.append([b, a] if swap else [a, b])  # posList is lat lon → lon lat
    return out


def fetch_effis_ba(
    settings, http_get: Callable[[str], str] | None = None, limit: int = 12,
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
        # whereas the old network implementation applied it after dropping
        # malformed features. So a row the loop skips shrinks the result below
        # `limit` rather than being backfilled. Only reachable with a
        # foreign-written snapshot, which degrades to [] anyway.
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
