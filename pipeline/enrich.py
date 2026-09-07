from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from collections import defaultdict
from collections.abc import Iterator
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable

import h3

from .config import EUROPE_BBOX
from .metrics import haversine_m

# Footprint labelling (place_for) looks for towns whose res-6 H3 cell is
# within one ring of the burn's res-6 parents: ~3.2 km cell edge, so "within
# roughly 5 km of a burnt cell". Coarse on purpose — it is a candidate filter,
# the pick itself is by exact distance to the nearest burnt cell.
_PLACE_RES = 6


class Places:
    """A gazetteer with two indexes, list-like for callers and tests.

    cities5000 has ~22k European places. nearest_place() as a brute-force
    min() over them cost ~6 ms a call, ~55 s per run for the live events
    alone; a 1° grid brings that to a handful of candidates. The res-6 index
    serves place_for()'s "towns near the footprint" lookup.
    """

    def __init__(self, places: list[dict]):
        self._all = list(places)
        self._grid: dict[tuple[int, int], list[dict]] = defaultdict(list)
        self._by_r6: dict[str, list[dict]] = defaultdict(list)
        for p in self._all:
            self._grid[(math.floor(p["lat"]), math.floor(p["lon"]))].append(p)
            self._by_r6[h3.latlng_to_cell(p["lat"], p["lon"], _PLACE_RES)].append(p)

    def __len__(self) -> int:
        return len(self._all)

    def __iter__(self) -> Iterator[dict]:
        return iter(self._all)

    def __getitem__(self, i):
        return self._all[i]

    def near(self, lat: float, lon: float) -> list[dict]:
        """Places in the 3×3 block of 1° cells around the point — every town
        within ~100 km at European latitudes bar the far corners — or the whole
        gazetteer when that block is empty, so a lone town is never missed."""
        la, lo = math.floor(lat), math.floor(lon)
        out = [p for dy in (-1, 0, 1) for dx in (-1, 0, 1) for p in self._grid.get((la + dy, lo + dx), ())]
        return out or self._all

    def in_cells(self, cells6: set[str]) -> list[dict]:
        return [p for c in cells6 for p in self._by_r6.get(c, ())]

_NS = {"gdacs": "http://www.gdacs.org", "geo": "http://www.w3.org/2003/01/geo/wgs84_pos#"}


# Europe alone has thousands of settlements over 15k people in the GeoNames
# extract. A parse yielding fewer than this is a truncated, swapped or
# half-downloaded file, not a real gazetteer. The download is unpinned by
# necessity — GeoNames regenerates the archive daily, so a fixed checksum would
# take the refresh down within a day — which makes a plausibility floor the
# integrity check that actually holds.
MIN_PLACES = 500


def load_places(path: Path, min_places: int = 0) -> list[dict]:
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
            out.append({"name": cols[1], "lat": lat, "lon": lon})
    if len(out) < min_places:
        raise ValueError(
            f"implausible gazetteer: {len(out)} European places parsed from {path} "
            f"(expected at least {min_places}) — truncated or wrong file"
        )
    return Places(out)


def nearest_place(
    lat: float, lon: float, places: Places | list[dict], max_km: float = 100.0
) -> dict | None:
    """Nearest settlement in the gazetteer, or None beyond `max_km`.

    EUROPE_BBOX reaches deep into the Atlantic to cover the western coast, so a
    sensor false-positive out at sea still gets a "nearest" city — just one
    hundreds of km away. Without this cutoff that distance got stamped on the
    fire's display name regardless, which is how an offshore glint ends up
    labelled with a real town it isn't anywhere near.
    """
    if not places:
        return None
    cand = places.near(lat, lon) if isinstance(places, Places) else places
    best = min(cand, key=lambda p: haversine_m(lat, lon, p["lat"], p["lon"]))
    distance_km = round(haversine_m(lat, lon, best["lat"], best["lon"]) / 1000, 1)
    if distance_km > max_km:
        return None
    return {"name": best["name"], "distance_km": distance_km}


def place_for(members: list[dict], places: Places | list[dict], max_km: float = 100.0) -> dict | None:
    """The town a fire should be named after: the one nearest to ANY burnt
    cell, among towns within ~5 km of the footprint; `distance_km` is that
    distance (0-ish when the town sits inside the burn).

    A big fire's centroid is a poor anchor. The 300 km² Gironde fire of July
    2026 got labelled Gujan-Mestras — across the Bassin d'Arcachon — because
    its centroid happened to be nearer that town than to Andernos-les-Bains,
    where the front actually stopped. With no town near the footprint at all
    (a remote burn) this falls back to the centroid rule, same cutoff.
    """
    if not places:
        return None
    cells = {m["cell"] for m in members if m.get("cell")}
    if cells:
        parents = {h3.cell_to_parent(c, _PLACE_RES) for c in cells}
        near6: set[str] = set()
        for p in parents:
            near6.update(h3.grid_disk(p, 1))
        if isinstance(places, Places):
            cand = places.in_cells(near6)
        else:
            cand = [p for p in places if h3.latlng_to_cell(p["lat"], p["lon"], _PLACE_RES) in near6]
        if cand:
            centres = [h3.cell_to_latlng(c) for c in cells]
            best, best_m = None, math.inf
            for p in cand:
                d = min(haversine_m(p["lat"], p["lon"], la, lo) for la, lo in centres)
                if d < best_m:
                    best, best_m = p, d
            return {"name": best["name"], "distance_km": round(best_m / 1000, 1)}
    lat = sum(m["lat"] for m in members) / len(members)
    lon = sum(m["lon"] for m in members) / len(members)
    return nearest_place(lat, lon, places, max_km)


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
