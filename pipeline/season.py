"""Aggregate the api2 season snapshot (pipeline/fetch_effis_season.py) into
the totals /scale renders.

No per-fire geometry or country-string normalization here anymore: the
snapshot is already aggregated EU-wide and per (ISO3-keyed, canonically
named) country by the fetcher. This module only picks the season-to-date
numbers back out of it.
"""
from __future__ import annotations

import json
from pathlib import Path


def season_totals(path: Path, year: int, top_n: int = 5) -> dict | None:
    """Season total, per-country ranking, moment the snapshot was last
    polled successfully.

    Returns None when there is no usable snapshot for `year` — caller
    renders "unavailable", a different state from a real zero total. This
    includes a snapshot fetched for a different year than requested: a
    stale snapshot must never be relabeled with a year it was not fetched
    for after a year rollover.
    """
    if not path.exists():
        return None
    try:
        snapshot = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None

    if snapshot.get("season_year") != year:
        return None

    eu = snapshot.get("eu")
    if not eu or eu.get("area_ha") is None:
        return None

    countries_raw = (snapshot.get("countries") or {}).values()
    countries = sorted(
        (
            {"name": c["name"], "km2": round(c["area_ha"] / 100.0, 1), "events": c.get("events")}
            for c in countries_raw
            if c.get("area_ha")  # excludes None and genuinely-zero countries
        ),
        key=lambda c: (-c["km2"], c["name"]),
    )

    return {
        "season_year": year,
        "fetched_at": snapshot.get("fetched_at"),
        "total_km2": round(eu["area_ha"] / 100.0, 1),
        "event_count": eu.get("events"),
        "countries": countries[:top_n],
    }
