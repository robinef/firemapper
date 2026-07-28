from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import h3

from .config import H3_RES
from .store import cell_at

BIN_HOURS = 6
CLOSE_AFTER_H = 48
# Meteosat pixels sit ~2 km apart; at H3 res 8 (~0.46 km edge) k-ring-1 never
# connects them and every pixel becomes its own "fire". Res 7 cells (~5.2 km²)
# make adjacent MTG pixels neighbours.
METEOSAT_RES = 7
METEOSAT_CELL_KM2 = 5.2
WINDOW_DAYS = 14
ACTIVE_H_VIIRS = 24
ACTIVE_H_METEOSAT = 2


def bin_start(t: datetime) -> datetime:
    t = t.astimezone(timezone.utc)
    return t.replace(hour=(t.hour // BIN_HOURS) * BIN_HOURS, minute=0, second=0, microsecond=0)


class _UF:
    def __init__(self) -> None:
        self.p: dict[object, object] = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def event_id_for(members: list[dict]) -> str:
    # Seed on the earliest detection ("first detection wins"), tie-break by cell.
    # This keeps the id stable as an event grows, including same-bin growth.
    seed = min(members, key=lambda m: (m["acq_time"], m["cell"]))
    return hashlib.sha1(f"{seed['cell']}:{seed['bin'].isoformat()}".encode()).hexdigest()[:12]


def _edges_sql(rows: list[dict], res: int) -> list[tuple[int, int]]:
    """Adjacency edges (row-index pairs) for clustering, computed in DuckDB with
    the h3 extension: the window is already filtered, cells are grouped by
    h3_latlng_to_cell, and neighbours come from h3_grid_disk. Two rows are an
    edge when they are the SAME cell and time-consecutive within CLOSE_AFTER_H,
    or ADJACENT cells and within CLOSE_AFTER_H of each other — exactly the pairs
    the Python union-find used to form inline. Union-find over these edges then
    yields identical components, with the heavy filter/join done in SQL."""
    import pyarrow as pa

    from .store import _naive_utc, connect_h3

    tbl = pa.table(
        {
            "rid": list(range(len(rows))),
            "lat": [float(r["lat"]) for r in rows],
            "lon": [float(r["lon"]) for r in rows],
            "acq_time": [_naive_utc(r["acq_time"]) for r in rows],
        }
    )
    con = connect_h3()
    con.register("arrow_n", tbl)
    con.execute(
        f"CREATE TEMP TABLE n AS "
        f"SELECT rid, h3_latlng_to_cell(lat, lon, {int(res)}) AS cell, acq_time FROM arrow_n"
    )
    rel = con.execute(
        """
        WITH ord AS (
            SELECT rid, cell, acq_time,
                   row_number() OVER (PARTITION BY cell ORDER BY acq_time, rid) AS rn
            FROM n
        ),
        same AS (  -- same cell, time-consecutive, gap <= 48 h
            SELECT a.rid AS a, b.rid AS b
            FROM ord a JOIN ord b ON a.cell = b.cell AND b.rn = a.rn + 1
            WHERE b.acq_time - a.acq_time <= INTERVAL 48 HOUR
        ),
        disk AS (  -- expand each row to its k-ring-1 cells
            SELECT rid, cell, acq_time, unnest(h3_grid_disk(cell, 1)) AS ncell FROM n
        ),
        nbr AS (   -- adjacent cell, any pair within 48 h (each unordered pair once)
            SELECT d.rid AS a, b.rid AS b
            FROM disk d JOIN n b ON b.cell = d.ncell
            WHERE d.cell <> b.cell AND d.rid < b.rid
              AND abs(epoch(d.acq_time) - epoch(b.acq_time)) <= 48 * 3600
        )
        SELECT a, b FROM same
        UNION
        SELECT a, b FROM nbr
        """
    ).fetchall()
    return [(int(a), int(b)) for a, b in rel]


def _cluster_one(rows: list[dict], res: int) -> dict[str, list[dict]]:
    """One sensor's detections at a single H3 resolution → fire events. Adjacency
    is computed in DuckDB (_edges_sql); the trivial union-find runs here."""
    if not rows:
        return {}
    nodes: list[dict] = []
    for r in rows:
        r = dict(r)
        r["cell"] = cell_at(r, res)  # precomputed H3 key when present, else derived
        r["bin"] = bin_start(r["acq_time"])
        nodes.append(r)

    uf = _UF()
    for i in range(len(nodes)):
        uf.find(i)  # every node is at least its own component
    for a, b in _edges_sql(rows, res):
        uf.union(a, b)

    comps: dict[object, list[dict]] = defaultdict(list)
    for i, n in enumerate(nodes):
        comps[uf.find(i)].append(n)
    return {
        event_id_for(ms): sorted(ms, key=lambda m: m["acq_time"])
        for ms in comps.values()
    }


def cluster(
    rows: list[dict], now: datetime, window_days: int = WINDOW_DAYS
) -> dict[str, list[dict]]:
    """Fuse polar (VIIRS/MODIS) and Meteosat detections into fire events.

    VIIRS/MODIS own event geometry and ignition (clustered fine, at H3_RES): a
    fire VIIRS has watched for days carries its real first-detection date. A
    Meteosat pixel sitting on a polar fire is the SAME fire — it only adds
    low-latency liveness (attached downstream by liveness_for_events), so it is
    not made a separate event here. Meteosat pixels with no polar fire nearby
    ARE their own fires (fresh detections VIIRS has not caught yet) and are kept,
    clustered at METEOSAT_RES so ~2 km pixels join. With no polar data at all
    (no FIRMS key), every event comes from Meteosat.
    """
    cutoff = now - timedelta(days=window_days)
    in_window = [r for r in rows if cutoff <= r["acq_time"] <= now]
    polar = [r for r in in_window if r["tier"] != "meteosat"]
    meteo = [r for r in in_window if r["tier"] == "meteosat"]

    if not polar:
        return _cluster_one(meteo, METEOSAT_RES) if meteo else {}

    events = _cluster_one(polar, H3_RES)
    if not meteo:
        return events

    # Res-7 footprint of every polar event, for the overlap test.
    polar_cells7: set[str] = set()
    for members in events.values():
        for m in members:
            polar_cells7 |= set(h3.grid_disk(cell_at(m, METEOSAT_RES), 1))
    # Keep only Meteosat-only fires (no polar event under them).
    for eid, members in _cluster_one(meteo, METEOSAT_RES).items():
        if any(m["cell"] in polar_cells7 for m in members):
            continue
        events[eid] = members
    return events


def lifecycle(members: list[dict], meteosat_latest: datetime | None, now: datetime) -> str:
    latest = max(m["acq_time"] for m in members)
    if meteosat_latest is not None and now - meteosat_latest <= timedelta(hours=ACTIVE_H_METEOSAT):
        return "active"
    age_h = (now - latest).total_seconds() / 3600
    if age_h < ACTIVE_H_VIIRS:
        return "active"
    if age_h < CLOSE_AFTER_H:
        return "stale"
    return "closed"


def reactivation_links(events: dict[str, list[dict]], now: datetime) -> dict[str, str]:
    links: dict[str, str] = {}
    infos = [
        (
            eid,
            {m["cell"] for m in ms},
            min(m["acq_time"] for m in ms),
            max(m["acq_time"] for m in ms),
        )
        for eid, ms in events.items()
    ]
    for eid, cells, start, _end in infos:
        best: tuple[datetime, str] | None = None
        for oid, ocells, _ostart, oend in infos:
            if oid == eid or not (cells & ocells):
                continue
            if oend < start - timedelta(hours=CLOSE_AFTER_H):
                if best is None or oend > best[0]:
                    best = (oend, oid)
        if best:
            links[eid] = best[1]
    return links
