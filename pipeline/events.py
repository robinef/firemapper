from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import h3

from .config import H3_RES, MAX_FIRE_DAYS, STATIC_CELL_DAYS, STATIC_EVENT_FRAC
from .metrics import CELL_KM2
from .store import cell_at

BIN_HOURS = 6
CLOSE_AFTER_H = 48
# Bridging (pass 2 of _cluster_one). Adjacency alone (k-ring 1) splits a real
# fire front the moment it skips one cell — a road, a firebreak, a smoke-masked
# pixel, or simply a front that advanced two cells between 12 h revisits. Live
# 2026-07-25 the Saint-Médard-en-Jalles fire (407 cells) and its southern half
# toward Andernos-les-Bains (124 cells) sat one empty cell apart, detected in
# the SAME overpass, and became two fires. Widening reach globally is wrong:
# on the prod archive k=2 joins 8556 component pairs, mostly clusters of
# small agricultural burns on the same afternoon. Gating on size fixes the
# asymmetry — a 14 km² blob skipping a cell is one fire; two 1-cell specks
# 1.7 km apart are two — and cuts that to 466 pairs. Only polar (VIIRS/MODIS)
# events bridge; Meteosat already clusters at the coarser res 7.
#
# The gate is per PASS-1 component and the pass runs once: two 19-cell halves
# never bridge each other, and a fragment absorbed this pass does not extend
# the reach to its own ring-2 neighbours. Iterating to a fixpoint or gating on
# the union's size would reopen the agricultural-cluster problem measured
# above. Edges are unioned transitively, so one speck two rings from each of
# two big fires welds them — 4 rings (~3.4 km) apart with a hot spot in
# between is a fire complex, which is the right answer. Ids follow the
# existing "earliest detection wins" rule (event_id_for): when the absorbed
# fragment was detected first, the big fire takes the fragment's id — the
# same thing a pass-1 merge has always done.
BRIDGE_K = 2
BRIDGE_MIN_CELLS = 20
# Bridging's OWN time reach, wider than CLOSE_AFTER_H. Live 2026-07-21..08-02 a
# real ~80 km² Var fire (542 detections, peak 480 MW) split into two ~40 km²
# fragments, each too small to crack the past-scars size ranking the merged
# fire easily would. The two halves' nearest members sit 143 h apart (a real
# multi-day lull/rekindle, not a single cloudy overpass) — CLOSE_AFTER_H
# (tuned for "when is a fire done", not "how long can it stay cold and still
# be the same fire") is far too tight to catch it. Measured on the prod
# archive same as BRIDGE_K above: 48h→472 pairs, 96h→770, 120h→878, 168h→1102
# — gradual throughout, no cliff like the spatial k=1→2 jump (466→8556) that
# justified gating bridging on size in the first place; BRIDGE_MIN_CELLS≥20
# is what keeps this safe at any of these values, not the time number itself.
# 168h (7 days) covers the 143h case with a day of headroom. Only
# lifecycle()'s closed/stale status keeps CLOSE_AFTER_H — a fire can be
# reported "closed" well before its own fragments are done bridging.
BRIDGE_TIME_H = 168
# Meteosat pixels sit ~2 km apart; at H3 res 8 (~0.46 km edge) k-ring-1 never
# connects them and every pixel becomes its own "fire". Res 7 cells (~5.2 km²)
# make adjacent MTG pixels neighbours.
METEOSAT_RES = 7
METEOSAT_CELL_KM2 = 5.2
WINDOW_DAYS = 14
ACTIVE_H_VIIRS = 24
ACTIVE_H_METEOSAT = 2


def cell_km2_for(members: list[dict]) -> float:
    """The per-cell area for pricing a fire's footprint: the wider Meteosat
    cell (res 7) when this fire clustered at Meteosat resolution, else the
    VIIRS default. One place for the sensor-tier check so export.py's live
    fire card and fetch_imagery.py's scar cards can't drift apart on it."""
    return METEOSAT_CELL_KM2 if h3.get_resolution(members[0]["cell"]) == METEOSAT_RES else CELL_KM2


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


def _bridge_edges_sql(rows: list[dict], res: int, comp: list[int]) -> list[tuple[int, int]]:
    """Pass-2 edges, as (component, component) pairs: two pass-1 components
    join when at least one spans ≥ BRIDGE_MIN_CELLS distinct cells and any
    pair of their members sits exactly BRIDGE_K rings and ≤ BRIDGE_TIME_H
    apart. Same DuckDB h3 machinery as _edges_sql. The size gate lives HERE,
    in SQL, as the single encoding of "big": the ring fan-out only ever starts
    from big components, and there is no Python short-circuit that could mask
    a broken gate. Ring BRIDGE_K only (not the full disk): any cross-component
    pair closer than that and within the window would already have been
    unioned by pass 1."""
    import pyarrow as pa

    from .store import _naive_utc, connect_h3

    tbl = pa.table(
        {
            "lat": [float(r["lat"]) for r in rows],
            "lon": [float(r["lon"]) for r in rows],
            "acq_time": [_naive_utc(r["acq_time"]) for r in rows],
            "comp": comp,
        }
    )
    con = connect_h3()
    con.register("arrow_n", tbl)
    con.execute(
        f"CREATE TEMP TABLE n AS SELECT h3_latlng_to_cell(lat, lon, {int(res)}) AS cell, "
        f"acq_time, comp FROM arrow_n"
    )
    rel = con.execute(
        f"""
        WITH big AS (
            SELECT comp FROM n GROUP BY comp
            HAVING count(DISTINCT cell) >= {int(BRIDGE_MIN_CELLS)}
        ),
        ring AS (  -- fan out from big components only, one row per (comp, cell, time)
            SELECT n.comp, n.acq_time, unnest(h3_grid_ring_unsafe(n.cell, {int(BRIDGE_K)})) AS ncell
            FROM (SELECT DISTINCT comp, cell, acq_time FROM n) n JOIN big USING (comp)
        )
        SELECT DISTINCT r.comp, b.comp
        FROM ring r JOIN n b ON b.cell = r.ncell
        WHERE r.comp <> b.comp
          AND abs(epoch(r.acq_time) - epoch(b.acq_time)) <= {int(BRIDGE_TIME_H)} * 3600
        """
    ).fetchall()
    return [(int(a), int(b)) for a, b in rel]


def _cluster_one(rows: list[dict], res: int, bridge: bool = False) -> dict[str, list[dict]]:
    """One sensor's detections at a single H3 resolution → fire events. Adjacency
    is computed in DuckDB (_edges_sql); the trivial union-find runs here. With
    `bridge`, a second pass joins big components across a one-cell gap (see
    BRIDGE_K / BRIDGE_MIN_CELLS)."""
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

    if bridge:
        comp = [uf.find(i) for i in range(len(nodes))]
        for a, b in _bridge_edges_sql(rows, res, comp):
            uf.union(a, b)

    comps: dict[object, list[dict]] = defaultdict(list)
    for i, n in enumerate(nodes):
        comps[uf.find(i)].append(n)
    return {
        event_id_for(ms): sorted(ms, key=lambda m: m["acq_time"])
        for ms in comps.values()
    }


def static_cells(rows: list[dict], res: int) -> set[str]:
    """Cells detected on >= STATIC_CELL_DAYS distinct days among `rows` — a
    fixed heat source (flare, refinery, waste site, volcano), not a wildfire.
    FIRMS's NRT area API has no `type` column to tell those apart directly
    (see pipeline/landmask.py's docstring for the sibling offshore case), but
    a real fire's front moves: measured on the prod archive, every wildfire —
    including 21-28 day ones — never redetects one cell on more than 12
    distinct days, while every known industrial source exceeds 25.

    Known residual risk: this counts days across the WHOLE row span, not per
    clustering event, so several genuinely separate fire episodes that reburn
    the exact same ~0.7 km² cell weeks or months apart could in principle sum
    past the threshold. Checked three cheaper discriminants against the prod
    archive's 736 flagged cells before accepting this: detection density
    (days / span) ranges 0.29-1.0 with no gap near a constructed 3-episode
    counterexample's ~0.32; longest same-cell gap in days and distinct-event
    count per cell BOTH range from "one continuous streak" to "many short
    pings" for genuinely static sources, fully overlapping where a rare
    multi-episode reburn would sit. No one-dimensional signal from point
    detections alone separates them; a real fix would need real-world
    burned-area geometry FIRMS doesn't provide. Accepted because: unverified
    in any of the 90 days / 435k detections / 736 flagged cells measured
    (every labelled real fire, up to 28 days, survived); reburns of one
    specific tiny cell within a 90-day window are themselves rare. If ever
    suspected, `scripts/replay_static_sources.py`'s per-event dump shows the
    date list — a genuine reburn shows as widely-gapped multi-day runs, not
    the near-daily pings a persistent source stays classified for."""
    days: dict[str, set] = defaultdict(set)
    for r in rows:
        days[cell_at(r, res)].add(r["acq_time"].date())
    return {c for c, ds in days.items() if len(ds) >= STATIC_CELL_DAYS}


def is_static(members: list[dict], static: set[str]) -> bool:
    """True when >= STATIC_EVENT_FRAC of an event's members sit in static
    cells — event-level, not cell-level, so a flare's non-static jitter cells
    (chained in by 48h adjacency) are dropped with it, while a real fire that
    spreads into a static cell keeps its identity as long as that stays a
    minority of its detections."""
    if not members:
        return False
    hits = sum(1 for m in members if m["cell"] in static)
    return hits / len(members) >= STATIC_EVENT_FRAC


def cluster(
    rows: list[dict], now: datetime, window_days: int = WINDOW_DAYS,
    report: dict | None = None,
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

    `report`, when given, is filled with `{"static_cells": set, "static_events":
    dict}` — the fixed heat sources dropped from the result (see static_cells /
    is_static), for callers that need the same classification elsewhere (the
    timeline histogram and day-slices exclude the same cells).
    """
    # The window is on a fire's LATEST detection, applied to events after
    # clustering — not to rows before it. Cutting rows at the window made a
    # long fire lose its first days one refresh at a time: its id (seeded on
    # the earliest member) changed daily, shared links died within a day, the
    # archive gained a track file per day for the same fire, and the footprint
    # shrank (Gironde 2026: three ids across three refreshes). Rows are bounded
    # at MAX_FIRE_DAYS before `now` — not before the cutoff — so what a fire
    # contains, and hence its id, depends only on (rows, now), never on which
    # window asked.
    oldest = now - timedelta(days=MAX_FIRE_DAYS)
    in_window = [r for r in rows if oldest <= r["acq_time"] <= now]
    polar = [r for r in in_window if r["tier"] != "meteosat"]
    meteo = [r for r in in_window if r["tier"] == "meteosat"]

    # Static heat sources (flares, refineries, oil fields, volcanoes) are
    # classified over the FULL in-window polar set — before the recency
    # filter — and removed from events. They still feed the Meteosat mask
    # below regardless of their own recency: a flare that paused for weeks is
    # still a flare, and an MTG pixel landing on it must not read as a fresh
    # fire the moment its polar event ages out of the live window.
    polar_events = _cluster_one(polar, H3_RES, bridge=True)
    static = static_cells(polar, H3_RES)
    non_static: dict[str, list[dict]] = {}
    static_events: dict[str, list[dict]] = {}
    for eid, members in polar_events.items():
        (static_events if is_static(members, static) else non_static)[eid] = members
    if report is not None:
        report["static_cells"] = static
        report["static_events"] = static_events

    events = recent_events(non_static, now, window_days)
    if meteo:
        # Res-7 footprint of every non-static polar event IN THE WINDOW, plus
        # ALL static polar events regardless of recency, for the overlap test.
        # A stale NON-static event must not take part (over a season those
        # cover most burnable land and a fresh MTG-only fire over one would be
        # suppressed here and then its suppressor dropped — in neither set),
        # but a static one's whole point is that it persists.
        polar_cells7: set[str] = set()
        for members in list(events.values()) + list(static_events.values()):
            for c in {cell_at(m, METEOSAT_RES) for m in members}:
                polar_cells7 |= set(h3.grid_disk(c, 1))
        # Keep only Meteosat-only fires (no polar event under them).
        for eid, members in _cluster_one(meteo, METEOSAT_RES).items():
            if any(m["cell"] in polar_cells7 for m in members):
                continue
            events[eid] = members
    return recent_events(events, now, window_days)


def recent_events(
    events: dict[str, list[dict]], now: datetime, window_days: int
) -> dict[str, list[dict]]:
    """The events whose latest detection falls within `window_days` of `now`.
    The one definition of "in the window" — cluster() applies it, and run.py
    derives the live set from the scar set with it."""
    cutoff = now - timedelta(days=window_days)
    return {eid: ms for eid, ms in events.items() if max(m["acq_time"] for m in ms) >= cutoff}


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
