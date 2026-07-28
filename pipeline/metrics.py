from __future__ import annotations

import math
from datetime import datetime, timedelta

CELL_KM2 = 0.7
NOISE_GATE_M = 870.0


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def bins_series(members: list[dict]) -> list[dict]:
    by_bin: dict = {}
    seen: set = set()
    for m in sorted(members, key=lambda m: m["acq_time"]):
        b = by_bin.setdefault(m["bin"], {"lat": [], "lon": [], "new": 0, "frp": 0.0})
        b["lat"].append(m["lat"])
        b["lon"].append(m["lon"])
        b["frp"] += m["frp"]
        if m["cell"] not in seen:
            seen.add(m["cell"])
            b["new"] += 1
    out, cum = [], 0
    for k in sorted(by_bin):
        b = by_bin[k]
        cum += b["new"]
        out.append(
            {
                "bin": k.isoformat(),
                "centroid": [sum(b["lat"]) / len(b["lat"]), sum(b["lon"]) / len(b["lon"])],
                "new_cells": b["new"], "cum_cells": cum, "frp_sum": round(b["frp"], 1),
            }
        )
    return out


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s)


def movement(series: list[dict], now: datetime) -> dict | None:
    if len(series) < 2:
        return None
    path = sum(
        haversine_m(*series[i]["centroid"], *series[i + 1]["centroid"])
        for i in range(len(series) - 1)
    )
    cut = now - timedelta(hours=24)
    older = [s for s in series if _parse(s["bin"]) < cut]
    start = older[-1] if older else series[0]
    end = series[-1]
    d24 = haversine_m(*start["centroid"], *end["centroid"])
    if d24 < NOISE_GATE_M:
        return None
    return {
        "bearing_deg": round(bearing_deg(*start["centroid"], *end["centroid"]), 1),
        "distance_24h_m": round(d24), "path_total_m": round(path),
    }


def status(series: list[dict], now: datetime) -> str:
    def rate(h_from: int, h_to: int) -> int:
        lo, hi = now - timedelta(hours=h_from), now - timedelta(hours=h_to)
        return sum(s["new_cells"] for s in series if lo <= _parse(s["bin"]) < hi)

    recent, prior = rate(24, 0), rate(48, 24)
    if recent > 0 and prior > 0 and recent > 1.5 * prior:
        return "accelerating"
    if recent > 0:
        return "growing"
    if prior > 0:
        return "declining"
    return "steady"


SPREAD_NEIGHBOUR_M = 6000.0
SPREAD_MIN_NEIGHBOURS = 3
# Rate pairs need a Δage of at least two MTG refresh cycles. Below that the
# age difference is sensor timing noise, and dist/Δage explodes into
# hundreds of km/h for pixels that simply appeared in the same scan.
SPREAD_MIN_DAGE_MIN = 20.0


def local_spread_bearings(
    points: list[dict], radius_m: float = SPREAD_NEIGHBOUR_M
) -> list[float | None]:
    """Back-compat wrapper: bearings only. See local_spread_vectors."""
    return [v[0] if v else None for v in local_spread_vectors(points, radius_m)]


def local_spread_vectors(
    points: list[dict], radius_m: float = SPREAD_NEIGHBOUR_M
) -> list[tuple[float, float | None] | None]:
    """Per-detection (bearing_deg, speed_kmh) from the local age gradient.

    Bearing: sum unit vectors toward neighbours weighted by how much *newer*
    they are — points the way the fire progressed locally. Speed: mean of
    distance/Δage over the same fresher-neighbour pairs, i.e. how fast the
    burning edge moved through here. Points without enough neighbours, or with
    no clear age gradient, get None rather than a misleading value.
    """
    # Bucket into a grid of ~radius size so neighbour lookup stays linear.
    # Longitude cells must be widened by 1/cos(lat): 111 km/deg only holds for
    # latitude, so a degree-sized grid makes northern columns far narrower than
    # the search radius and the 3x3 ring silently misses real neighbours. Above
    # ~69N that dropped every bearing, and "no arrow" means "no measurable
    # movement" in the UI — a coverage gap would read as a finding about the fire.
    if not points:
        return []
    lat0 = sum(p["lat"] for p in points) / len(points)
    deg_lat = radius_m / 110_540.0
    deg_lon = radius_m / (111_320.0 * max(math.cos(math.radians(lat0)), 0.05))
    grid: dict[tuple[int, int], list[int]] = {}
    for i, p in enumerate(points):
        key = (int(p["lat"] // deg_lat), int(p["lon"] // deg_lon))
        grid.setdefault(key, []).append(i)

    out: list[tuple[float, float | None] | None] = []
    for i, p in enumerate(points):
        age = p.get("age_min")
        if age is None:
            out.append(None)
            continue
        gy, gx = int(p["lat"] // deg_lat), int(p["lon"] // deg_lon)
        vx = vy = 0.0
        n_used = 0
        rates: list[float] = []  # m/min toward fresher neighbours
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for j in grid.get((gy + dy, gx + dx), ()):
                    if j == i:
                        continue
                    q = points[j]
                    q_age = q.get("age_min")
                    if q_age is None:
                        continue
                    dist = haversine_m(p["lat"], p["lon"], q["lat"], q["lon"])
                    if dist > radius_m or dist == 0:
                        continue
                    n_used += 1
                    newer_by = age - q_age  # >0 when the neighbour is fresher
                    if newer_by == 0:
                        continue
                    b = math.radians(bearing_deg(p["lat"], p["lon"], q["lat"], q["lon"]))
                    vx += newer_by * math.sin(b)
                    vy += newer_by * math.cos(b)
                    if newer_by >= SPREAD_MIN_DAGE_MIN:
                        rates.append(dist / newer_by)
        if n_used < SPREAD_MIN_NEIGHBOURS or (vx == 0 and vy == 0):
            out.append(None)
            continue
        bearing = round((math.degrees(math.atan2(vx, vy)) + 360) % 360, 1)
        # m/min → km/h. Median resists the huge rates produced by two pixels
        # detected almost simultaneously (tiny Δage, giant dist/Δage).
        speed = None
        if rates:
            rates.sort()
            speed = round(rates[len(rates) // 2] * 0.06, 2)
        out.append((bearing, speed))
    return out


def area_km2(members: list[dict], cell_km2: float = CELL_KM2) -> float:
    return round(len({m["cell"] for m in members}) * cell_km2, 1)
