"""Per-layer freshness policy.

A layer's age budget is how old its data may be before the UI must stop
presenting it as current. Carry-forward exists so one failed poll does not blank
a layer — but a carried layer is still stale data, so it expires at twice its
budget rather than living forever.

Only failures are carried. A confirmed empty is the truth and must replace what
came before, otherwise a quiet winter would render as last week's fires.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from .fetch_result import FetchResult

# Seconds a layer may age before the UI greys it. Matched to how often the
# source itself actually updates, not to how often we poll.
MAX_AGE_S: dict[str, int] = {
    "events": 3 * 3600,       # VIIRS overpasses are ~3 h apart
    "frp": 3600,              # MTG publishes every 10 min
    "wind": 3 * 3600,         # Open-Meteo is hourly
    "aircraft": 20 * 60,      # a plane moves ~6-9 km per minute
    "timeline": 24 * 3600,    # derived from the archive
    "imagery": 7 * 24 * 3600,  # scars change over days, never "live"
    "gibs_tiles": 7 * 24 * 3600,
}

# A stale aircraft position is a wrong claim about where an aircraft is, not
# degraded data. Never carry it.
NEVER_CARRIED = frozenset({"aircraft"})

CARRY_EXPIRY_FACTOR = 2


def layer_entry(key: str, result: FetchResult, *, now: datetime, source: str) -> dict:
    """One manifest `layers` entry.

    Three timestamps, deliberately distinct: when we tried, when data actually
    arrived, and when the newest observation inside it was made. Conflating the
    last two is how a successful poll of an empty feed can look fresh.
    """
    return {
        "attempted_at": now.isoformat(),
        "fetched_at": result.attempted_at.isoformat() if result.usable else None,
        "observed_at": result.observed_at.isoformat() if result.observed_at else None,
        "status": result.status,
        "source": source,
        "max_age_s": MAX_AGE_S.get(key, 3600),
    }


def carried_entry(previous: dict, *, now: datetime) -> dict:
    """Previous entry, re-labelled as carried. Data timestamps stay untouched —
    that is the point: the data really is that old."""
    return {**previous, "status": "carried", "attempted_at": now.isoformat()}


def should_carry(key: str, result: FetchResult, previous: dict | None, now: datetime) -> bool:
    if key in NEVER_CARRIED or previous is None:
        return False
    if result.status != "failed":
        return False
    stamp = previous.get("fetched_at") or previous.get("attempted_at")
    if not stamp:
        return False
    try:
        fetched = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return False
    budget = MAX_AGE_S.get(key, 3600)
    return now - fetched <= timedelta(seconds=CARRY_EXPIRY_FACTOR * budget)
