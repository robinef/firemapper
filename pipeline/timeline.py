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


def build_timeline(rows: list[dict], now: datetime, days: int = 30) -> list[dict]:
    """[{date, count, frp}] per UTC day for the last `days`, oldest first."""
    start = (now - timedelta(days=days - 1)).date()
    counts: dict[str, int] = {}
    frp: dict[str, float] = {}
    for r in rows:
        if r["tier"] == "meteosat":
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
