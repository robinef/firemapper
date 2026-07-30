"""Fetch outcomes that distinguish "the source said nothing" from "the source
broke".

Every fetcher here swallows its own errors and returns an empty list (see
fetch_meteosat.py), so an outage and a quiet winter are byte-identical
downstream. Carry-forward cannot be built on that ambiguity: carrying an empty
would freeze last week's fires on the map forever, and refusing to carry a
failure would blank the map on any upstream hiccup.

`observed_at` is the newest OBSERVATION inside the payload, not the time we
fetched it. A successful poll that returns hour-old satellite pixels is fresh
plumbing over stale data, and only the observation time can say so.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable


@dataclass(frozen=True)
class FetchResult:
    status: str  # "ok" | "empty" | "failed"
    data: object
    attempted_at: datetime
    observed_at: datetime | None = None

    @property
    def usable(self) -> bool:
        """True when the source answered, even if the answer was 'nothing'."""
        return self.status != "failed"


def attempt(
    fn: Callable[[], object],
    *,
    label: str,
    now: datetime,
    observed: Callable[[object], datetime | None] | None = None,
    default: object = None,
) -> FetchResult:
    """Run `fn`, classify the outcome, and never raise.

    Prints the same `[warn] <label> failed:` line the old `_safe` printed, so
    CI logs stay greppable.
    """
    try:
        data = fn()
    except Exception as e:  # noqa: BLE001 - degraded mode by design
        print(f"[warn] {label} failed: {e}", file=sys.stderr)
        return FetchResult("failed", default, now)

    empty = data is None or (hasattr(data, "__len__") and len(data) == 0)
    observed_at = None
    if not empty and observed is not None:
        try:
            observed_at = observed(data)
        except Exception:  # noqa: BLE001 - an unreadable timestamp is not a fetch failure
            observed_at = None
    return FetchResult("empty" if empty else "ok", data, now, observed_at)


def newest_timestamp(values) -> datetime | None:
    """Newest parseable ISO timestamp in an iterable, or None.

    Shared by the layers whose payloads carry per-record times (MTG pixels,
    wind samples), so every layer's `observed_at` is derived the same way.

    Naive timestamps are assumed UTC and stamped as such: sources hand us bare
    strings like "2026-07-30T14:15:00", and `Date.parse` in the browser would
    read those as LOCAL time, skewing every age by the viewer's offset.
    """
    best: datetime | None = None
    for value in values:
        if not value:
            continue
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if best is None or parsed > best:
            best = parsed
    return best
