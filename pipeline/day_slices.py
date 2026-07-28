"""Per-day Europe-wide detection slices for the overview histogram: click a day
and see where fire was burning that day. Cheap because the H3 keys are already
stored — a GROUP BY the h3_r6 column, rolled up to res 5 (~250 km² hexes, the
right grain for a continental view) via the H3 parent hierarchy. Meteosat is
excluded so the counts match the histogram (polar detections only).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import h3

from .store import connect


def build_day_slices(store: Path, now: datetime, days: int = 30, res: int = 5) -> dict[str, list]:
    """{ 'YYYY-MM-DD': [[h3_cell, count], ...] } for the last `days`."""
    if not store.exists():
        return {}
    cutoff = (now - timedelta(days=days)).date().isoformat()
    con = connect()
    rows = con.execute(
        "SELECT CAST(acq_time AS DATE) d, h3_r6, count(*) n "
        f"FROM read_parquet('{str(store)}') "
        f"WHERE tier <> 'meteosat' AND CAST(acq_time AS DATE) >= DATE '{cutoff}' "
        "GROUP BY 1, 2"
    ).fetchall()
    agg: dict[str, dict[str, int]] = {}
    for d, cell6, n in rows:
        if not cell6:
            continue
        cell = h3.cell_to_parent(cell6, res)  # roll r6 up to the coarser view res
        day = d.isoformat()
        agg.setdefault(day, {})
        agg[day][cell] = agg[day].get(cell, 0) + int(n)
    return {day: [[c, n] for c, n in cells.items()] for day, cells in agg.items()}
