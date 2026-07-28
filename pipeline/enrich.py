from __future__ import annotations

import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable

from .config import EUROPE_BBOX
from .metrics import haversine_m

_NS = {"gdacs": "http://www.gdacs.org", "geo": "http://www.w3.org/2003/01/geo/wgs84_pos#"}


def load_places(path: Path) -> list[dict]:
    lon_min, lat_min, lon_max, lat_max = EUROPE_BBOX
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        cols = line.split("\t")
        if len(cols) < 6:
            continue
        lat, lon = float(cols[4]), float(cols[5])
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            out.append({"name": cols[1], "lat": lat, "lon": lon})
    return out


def nearest_place(lat: float, lon: float, places: list[dict]) -> dict | None:
    if not places:
        return None
    best = min(places, key=lambda p: haversine_m(lat, lon, p["lat"], p["lon"]))
    return {
        "name": best["name"],
        "distance_km": round(haversine_m(lat, lon, best["lat"], best["lon"]) / 1000, 1),
    }


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
