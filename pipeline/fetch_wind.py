"""Real surface wind near active fires (Open-Meteo, free, no API key).

Kept deliberately separate from the fire-spread bearing in metrics.py: spread
is observed from detection ages, wind is a forecast field. They often disagree
(terrain, fuel, slope), and conflating them on a safety map would be wrong.
"""
from __future__ import annotations

import json
from typing import Callable

API = "https://api.open-meteo.com/v1/forecast"
BATCH = 100
GRID_DEG = 0.5


def wind_sample_points(pixels: list[dict], max_points: int = 200) -> list[tuple[float, float]]:
    """Snap fire pixels onto a coarse grid so wind is sampled where fires are."""
    seen: dict[tuple[int, int], tuple[float, float]] = {}
    for p in pixels:
        key = (round(p["lat"] / GRID_DEG), round(p["lon"] / GRID_DEG))
        if key not in seen:
            seen[key] = (round(key[0] * GRID_DEG, 3), round(key[1] * GRID_DEG, 3))
    pts = sorted(seen.values())
    if len(pts) <= max_points:
        return pts
    step = len(pts) / max_points
    return [pts[int(i * step)] for i in range(max_points)]


def fetch_wind(
    points: list[tuple[float, float]], http_text: Callable[[str], str] | None = None
) -> list[dict]:
    """Current wind/temp/humidity for each (lat, lon). Empty list on failure."""
    if not points:
        return []
    if http_text is None:
        import requests

        def http_text(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=90)
            r.raise_for_status()
            return r.text

    out: list[dict] = []
    for i in range(0, len(points), BATCH):
        chunk = points[i : i + BATCH]
        lats = ",".join(str(p[0]) for p in chunk)
        lons = ",".join(str(p[1]) for p in chunk)
        url = (
            f"{API}?latitude={lats}&longitude={lons}"
            "&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,"
            "temperature_2m,relative_humidity_2m&wind_speed_unit=kmh"
        )
        try:
            payload = json.loads(http_text(url))
        except Exception:  # noqa: BLE001 - wind is an overlay, never fatal
            continue
        entries = payload if isinstance(payload, list) else [payload]
        for e in entries:
            cur = e.get("current") or {}
            if cur.get("wind_direction_10m") is None:
                continue
            out.append(
                {
                    "lat": round(float(e["latitude"]), 3),
                    "lon": round(float(e["longitude"]), 3),
                    "dir": float(cur["wind_direction_10m"]),
                    "kmh": float(cur.get("wind_speed_10m") or 0.0),
                    "gust_kmh": float(cur.get("wind_gusts_10m") or 0.0),
                    "temp_c": cur.get("temperature_2m"),
                    "rh": cur.get("relative_humidity_2m"),
                    "time": cur.get("time"),
                }
            )
    return out
