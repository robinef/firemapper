from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import defaultdict
from collections.abc import Callable, Iterator
from email.utils import parsedate_to_datetime
from pathlib import Path

import h3

from .config import EUROPE_BBOX
from .metrics import centroid, haversine_m

# The gazetteer index: H3 res 4 (~22 km edge, metric-uniform unlike a lat/lon
# grid) and a 5-ring disk (91 cells) around a query point. The disk reaches
# ≥ 135 km in every direction, past the 100 km labelling cutoff, so a lookup
# never needs a fallback scan and never misses a nearer town just outside
# its block.
_INDEX_RES = 4
_INDEX_K = 5
MAX_PLACE_KM = 100.0


class Places:
    """The gazetteer, list-like plus a spatial index.

    cities5000 has ~22k European places. nearest_place() as a brute-force
    min() over them cost ~6 ms a call, ~55 s per run for the live events
    alone; the index brings a lookup to a few dozen candidates.
    """

    def __init__(self, places: list[dict]):
        self._all = list(places)
        self._idx: dict[str, list[dict]] = defaultdict(list)
        for p in self._all:
            self._idx[h3.latlng_to_cell(p["lat"], p["lon"], _INDEX_RES)].append(p)

    def __len__(self) -> int:
        return len(self._all)

    def __iter__(self) -> Iterator[dict]:
        return iter(self._all)

    def around(self, lat: float, lon: float) -> list[dict]:
        """Every place within MAX_PLACE_KM of the point (and some beyond)."""
        origin = h3.latlng_to_cell(lat, lon, _INDEX_RES)
        return [p for c in h3.grid_disk(origin, _INDEX_K) for p in self._idx.get(c, ())]

_NS = {"gdacs": "http://www.gdacs.org", "geo": "http://www.w3.org/2003/01/geo/wgs84_pos#"}


# The GeoNames cities5000 extract holds ~22k European settlements. A parse
# yielding fewer than this is a truncated, swapped or half-downloaded file,
# not a real gazetteer. The download is unpinned by necessity — GeoNames
# regenerates the archive daily, so a fixed checksum would take the refresh
# down within a day — which makes a plausibility floor the integrity check
# that actually holds.
MIN_PLACES = 2000


def load_places(path: Path, min_places: int = 0) -> Places:
    """European settlements from a GeoNames cities extract.

    Malformed rows are skipped rather than fatal: this is a multi-megabyte
    third-party download, and one bad line should cost one city, not the whole
    refresh. `min_places` is the opposite guard — pass it at the call site to
    refuse a file too small to be the real thing, LOUDLY, because silently
    returning nothing here just renames every fire to "Fire · <date>" and that
    went unnoticed for weeks.
    """
    lon_min, lat_min, lon_max, lat_max = EUROPE_BBOX
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        cols = line.split("\t")
        if len(cols) < 6:
            continue
        try:
            lat, lon = float(cols[4]), float(cols[5])
        except ValueError:
            continue  # one unparseable row, not a reason to lose the gazetteer
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            country = cols[8] if len(cols) > 8 and cols[8] else None
            out.append({"name": cols[1], "lat": lat, "lon": lon, "country": country})
    if len(out) < min_places:
        raise ValueError(
            f"implausible gazetteer: {len(out)} European places parsed from {path} "
            f"(expected at least {min_places}) — truncated or wrong file"
        )
    return Places(out)


def _pick(
    origin: tuple[float, float], points: list[tuple[float, float]], places: Places, max_km: float
) -> dict | None:
    """The place nearest to any of `points` among those around `origin`;
    None beyond `max_km`. distance_km is to the nearest point."""
    if not places or not points:
        return None
    best, best_m = None, float("inf")
    for p in places.around(*origin):
        d = min(haversine_m(p["lat"], p["lon"], la, lo) for la, lo in points)
        if d < best_m:
            best, best_m = p, d
    if best is None or best_m / 1000 > max_km:
        return None
    return {"name": best["name"], "distance_km": round(best_m / 1000, 1), "country": best.get("country")}


def nearest_place(lat: float, lon: float, places: Places, max_km: float = MAX_PLACE_KM) -> dict | None:
    """Nearest settlement in the gazetteer, or None beyond `max_km`.

    EUROPE_BBOX reaches deep into the Atlantic to cover the western coast, so a
    sensor false-positive out at sea still gets a "nearest" city — just one
    hundreds of km away. Without this cutoff that distance got stamped on the
    fire's display name regardless, which is how an offshore glint ends up
    labelled with a real town it isn't anywhere near.
    """
    return _pick((lat, lon), [(lat, lon)], places, max_km)


def place_for(members: list[dict], places: Places, max_km: float = MAX_PLACE_KM) -> dict | None:
    """The town a fire should be named after: the one nearest to ANY of its
    detections (one per burnt cell), searched around the centroid; None if
    even that is beyond `max_km`. `distance_km` is the distance from the town
    to the nearest detection — ~0 when the town sits inside the burn.

    A big fire's centroid alone is a poor anchor. The 300 km² Gironde fire of
    July 2026 got labelled Gujan-Mestras — across the Bassin d'Arcachon —
    because its centroid happened to be nearer that town than to Arès, where
    the front actually stopped. One rule, no modes: for a one-cell fire this
    is exactly nearest_place(centroid).
    """
    if not members or not places:
        return None
    by_cell = {m.get("cell", i): (m["lat"], m["lon"]) for i, m in enumerate(members)}
    return _pick(centroid(members), list(by_cell.values()), places, max_km)


def fetch_gdacs(http_get: Callable[[str], str] | None = None) -> list[dict]:
    if http_get is None:
        import requests

        def http_get(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            return r.text

    root = ET.fromstring(http_get("https://www.gdacs.org/xml/rss.xml"))
    out = []
    for item in root.iter("item"):
        etype = item.find("gdacs:eventtype", _NS)
        if etype is None or etype.text != "WF":
            continue
        lat_el, lon_el = item.find(".//geo:lat", _NS), item.find(".//geo:long", _NS)
        if lat_el is None or lon_el is None:
            continue
        out.append(
            {
                "title": item.findtext("title", ""), "link": item.findtext("link", ""),
                "lat": float(lat_el.text), "lon": float(lon_el.text),
                "pub": parsedate_to_datetime(item.findtext("pubDate", "")),
            }
        )
    return out


def gdacs_for_event(members: list[dict], alerts: list[dict], max_km: float = 30.0) -> dict | None:
    if not alerts:
        return None
    lat = sum(m["lat"] for m in members) / len(members)
    lon = sum(m["lon"] for m in members) / len(members)
    best = min(alerts, key=lambda a: haversine_m(lat, lon, a["lat"], a["lon"]))
    if haversine_m(lat, lon, best["lat"], best["lon"]) / 1000 > max_km:
        return None
    return {"title": best["title"], "link": best["link"]}
