"""Daily fire-activity timeline — the archive's time dimension, for the bottom
histogram. This is the app's core message made visible: are detections trending
up over the window?

Polar (VIIRS/MODIS) detections ONLY: they come from a stable ~2-passes-a-day
cadence, so day-to-day counts are comparable. Meteosat is excluded because its
live snapshot is all stamped "now" and would spike the last bar to meaningless
heights. Days with no data are still emitted (count 0), so a gap reads as a gap,
not a missing bar.
"""
from __future__ import annotations

from datetime import datetime, timedelta

def build_timeline(
    rows: list[dict], now: datetime, days: int = 30, exclude_ids: set[str] | None = None
) -> list[dict]:
    """[{date, count, frp}] per UTC day for the last `days`, oldest first.

    `exclude_ids` (src_id) drops the exact detections belonging to events
    events.cluster() classified as static heat sources (flares, refineries,
    oil fields), so the histogram reads the trend in wildfire activity, not a
    constant industrial floor: measured on the prod archive, such detections
    are 17.7% of the total (10-49% on any given day). By src_id, not by
    cell: a cell can host a real, KEPT event alongside a dropped static one
    (e.g. a fire that spread into a flare's cell but stayed under
    STATIC_EVENT_FRAC) — excluding the whole cell would undercount that real
    event's own detections here while the map still shows it in full."""
    start = (now - timedelta(days=days - 1)).date()
    exclude = exclude_ids or set()
    counts: dict[str, int] = {}
    frp: dict[str, float] = {}
    for r in rows:
        if r["tier"] == "meteosat" or r["src_id"] in exclude:
            continue
        d = r["acq_time"].date()
        if d < start or r["acq_time"] > now:
            continue
        key = d.isoformat()
        counts[key] = counts.get(key, 0) + 1
        frp[key] = frp.get(key, 0.0) + float(r.get("frp") or 0.0)
    out = []
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        out.append({"date": d, "count": counts.get(d, 0), "frp": round(frp.get(d, 0.0), 1)})
    return out
