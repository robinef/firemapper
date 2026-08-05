"""Turn a burned-area total into a count of a familiar place.

A FIXED trio, used at every magnitude, so a returning reader learns the ladder
instead of meeting a new ref each visit. Rungs are 15.5x and 14.9x apart,
which is what stretches three units across 20 - 70,000 km2.

Coverage is near-total but NOT gapless: each unit spans 15x (band 3-45), so the
15.5x Gibraltar->Paris rung leaves a sliver at 306-316 km2 that falls back. That
is accepted — closing it costs a fourth unit or a wider band, both worse trades.
"""
from __future__ import annotations
from math import log

# (name, km2). Boundaries are the disputed kind and are pinned deliberately:
# Paris is the commune INCLUDING the two Bois (87 km2 without); Greater London
# is the administrative region; Gibraltar is the whole territory.
UNITS: list[tuple[str, float]] = [
    ("Gibraltar", 6.8),
    ("Paris", 105.4),
    ("Greater London", 1572.0),
]

BAND_MIN = 3.0
BAND_MAX = 45.0
TARGET = 12.0


def pick_unit(total_km2: float) -> dict:
    """The unit whose tile count sits nearest TARGET while inside the readable
    band; if none qualifies, the nearest-ratio unit with an honest count.
    Raises ValueError on a non-positive total: log(0) is undefined, and a zero
    season is a distinct page state handled u/, not a grid of no tiles.
    """
    if total_km2 <= 0:
        raise ValueError("pick_unit requires a positive total; zero is a separate state")

    def distance(km2: float) -> float:
        count = total_km2 / km2
        return abs(log(count / TARGET))

    in_band = [
        (name, km2) for name, km2 in UNITS
        if BAND_MIN <= total_km2 / km2 <= BAND_MAX
    ]

    candidates = in_band or UNITS
    name, km2 = min(candidates, key=lambda u: distance(u[1]))

    return {"name": name, "km2": km2, "count": round(total_km2 / km2, 1)}
