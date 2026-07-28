"""EFFIS burned areas as a best-effort auto source of historical "past" scars.

EFFIS (the EU's Emergency Management Service fire component) publishes a WFS
burned-area layer covering the current season. We query it, turn each burned
polygon into a before/after scar (same shape as build_scars() output), and hand
them to build_imagery() alongside our own FIRMS-derived scars.

IMPORTANT: the endpoint's Oracle Spatial backend is frequently DOWN and answers
a perfectly-formed HTTP 200 whose body is an OWS ExceptionReport
("OracleSpatial error … Connection failure"), not features. So every path here is
guarded: on ANY error — HTTP failure, exception report, malformed body, empty or
non-feature response — fetch_effis_ba returns [] and NEVER raises. EFFIS is a
bonus tier; the map must never depend on it being up.
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

# Attribute names vary by server/version; try these in order (case matters in
# GeoJSON properties, so we list both casings).
_AREA_KEYS = ("area_ha", "AREA_HA", "area", "AREA")
_DATE_KEYS = ("firedate", "FIREDATE", "lastupdate", "LASTUPDATE",
              "initialdate", "INITIALDATE")
_PLACE_KEYS = ("place_name", "PLACE_NAME", "province", "PROVINCE",
               "commune", "COMMUNE", "country", "COUNTRY")


def _build_url() -> str:
    return (
        f"{EFFIS_WFS}?service=WFS&version=2.0.0&request=GetFeature"
        f"&typename={EFFIS_TYPENAME}&outputformat=geojson&srsname=EPSG:4326"
    )


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


def _iter_coords(geom: object):
    """Yield every (lon, lat) pair from an arbitrarily-nested GeoJSON coord tree."""
    if isinstance(geom, (list, tuple)):
        if (
            len(geom) >= 2
            and isinstance(geom[0], (int, float))
            and isinstance(geom[1], (int, float))
        ):
            yield float(geom[0]), float(geom[1])
        else:
            for item in geom:
                yield from _iter_coords(item)


def _centroid(geometry: dict | None) -> tuple[float, float] | None:
    """bbox midpoint of a GeoJSON geometry (good enough to place a scar pin)."""
    if not isinstance(geometry, dict):
        return None
    coords = list(_iter_coords(geometry.get("coordinates")))
    if not coords:
        return None
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2


def _scar_from_feature(feat: dict, today: date) -> dict | None:
    if not isinstance(feat, dict):
        return None
    props = feat.get("properties") or {}
    if not isinstance(props, dict):
        props = {}
    centroid = _centroid(feat.get("geometry"))
    if centroid is None:
        return None
    lon, lat = centroid

    fire_date = _parse_date(_first(props, _DATE_KEYS))
    if fire_date is None:
        return None

    yesterday = today - timedelta(days=1)
    before = fire_date - timedelta(days=BASELINE_LEAD_DAYS)
    after = min(fire_date + timedelta(days=SCAR_SETTLE_DAYS), yesterday)
    after = max(after, fire_date)  # never before ignition

    place = _first(props, _PLACE_KEYS)
    if place:
        label = f"{place} · {fire_date.year}"
    else:
        label = f"Burn scar · {fire_date.isoformat()}"

    area = _first(props, _AREA_KEYS)
    try:
        area_ha = float(area) if area is not None else 0.0
    except (TypeError, ValueError):
        area_ha = 0.0

    scar = {
        "id": f"effis-{fire_date.isoformat()}-{round(lon, 3)}-{round(lat, 3)}",
        "label": label,
        "kind": "past",
        "lon": round(lon, 4),
        "lat": round(lat, 4),
        "started": fire_date.isoformat(),
        "before": before.isoformat(),
        "after": after.isoformat(),
        "_area_ha": area_ha,  # internal, used only for sorting
    }
    if place:
        scar["place"] = str(place)
    return scar


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
    """Best-effort EFFIS burned-area scars (largest `limit`, area desc).

    Guaranteed non-raising: any failure (network, HTTP error, OWS exception
    report, malformed body, no features) yields []. `http_get` mirrors
    fetch_firms so tests can inject a fake; the default does a real GET."""
    if http_get is None:
        import requests

        def http_get(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            return r.text

    try:
        text = http_get(_build_url())
        features = _features_from_text(text)
    except Exception:  # noqa: BLE001 - EFFIS is best-effort, never fatal
        return []

    today = datetime.now(timezone.utc).date()
    scars: list[dict] = []
    for feat in features:
        try:
            scar = _scar_from_feature(feat, today)
        except Exception:  # noqa: BLE001 - skip a malformed feature, keep going
            scar = None
        if scar is not None:
            scars.append(scar)

    scars.sort(key=lambda s: s.get("_area_ha", 0.0), reverse=True)
    top = scars[:limit]
    for s in top:
        s.pop("_area_ha", None)  # strip internal sort key from the output
    return top
