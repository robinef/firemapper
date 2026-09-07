import random
from collections import defaultdict
from datetime import timedelta

import h3

from pipeline.events import (
    BRIDGE_K,
    BRIDGE_MIN_CELLS,
    CLOSE_AFTER_H,
    METEOSAT_CELL_KM2,
    METEOSAT_RES,
    _UF,
    cell_km2_for,
    cluster,
    event_id_for,
    lifecycle,
    reactivation_links,
)
from pipeline.metrics import CELL_KM2
from tests.synth import T, hs


def _reference_partition(rows, res=8):
    """Pure-Python connected components (the pre-SQL union-find), as a set of
    frozensets of src_ids — the oracle the DuckDB clustering must match.

    Pass 1: same cell time-consecutive, or k-ring-1 neighbours, within
    CLOSE_AFTER_H. Pass 2 (bridging): two pass-1 components join when at
    least one spans BRIDGE_MIN_CELLS cells and any member pair sits within
    BRIDGE_K rings and CLOSE_AFTER_H of each other."""
    nodes = [dict(r) for r in rows]
    for n in nodes:
        n["cell"] = h3.latlng_to_cell(n["lat"], n["lon"], res)
    by_cell = defaultdict(list)
    for i, n in enumerate(nodes):
        by_cell[n["cell"]].append(i)
    uf = _UF()
    for i in range(len(nodes)):
        uf.find(i)
    md = timedelta(hours=CLOSE_AFTER_H)
    def within(a, b):
        return abs((nodes[a]["acq_time"] - nodes[b]["acq_time"]).total_seconds()) <= md.total_seconds()
    for cell, idx in by_cell.items():
        idx.sort(key=lambda i: nodes[i]["acq_time"])
        for a, b in zip(idx, idx[1:]):
            if nodes[b]["acq_time"] - nodes[a]["acq_time"] <= md:
                uf.union(a, b)
        for nb in h3.grid_disk(cell, 1):
            if nb == cell or nb not in by_cell:
                continue
            for a in idx:
                for b in by_cell[nb]:
                    if within(a, b):
                        uf.union(a, b)
    # Pass 2: bridge across BRIDGE_K rings when one side is big enough.
    comp1 = [uf.find(i) for i in range(len(nodes))]
    cells_of = defaultdict(set)
    for i, c in enumerate(comp1):
        cells_of[c].add(nodes[i]["cell"])
    big = {c for c, cs in cells_of.items() if len(cs) >= BRIDGE_MIN_CELLS}
    for cell, idx in by_cell.items():
        for nb in h3.grid_disk(cell, BRIDGE_K):
            if nb not in by_cell:
                continue
            for a in idx:
                for b in by_cell[nb]:
                    if comp1[a] == comp1[b] or (comp1[a] not in big and comp1[b] not in big):
                        continue
                    if within(a, b):
                        uf.union(a, b)
    comps = defaultdict(set)
    for i in range(len(nodes)):
        comps[uf.find(i)].add(rows[i]["src_id"])
    return {frozenset(v) for v in comps.values()}


def _disk_fire(center_cell, k, t):
    """One detection per cell of grid_disk(center, k) at time t — a contiguous
    blob of 1 + 3k(k+1) cells (k=3 → 37 cells, above BRIDGE_MIN_CELLS)."""
    return [hs(*h3.cell_to_latlng(c), t) for c in h3.grid_disk(center_cell, k)]


def _cell_at_distance(from_cells, d):
    """A cell exactly `d` rings from the nearest of `from_cells`."""
    anchor = next(iter(from_cells))
    for radius in range(d, d + 12):
        for c in h3.grid_ring(anchor, radius):
            if min(h3.grid_distance(c, f) for f in from_cells) == d:
                return c
    raise AssertionError("no cell at that distance")


CENTER = h3.latlng_to_cell(45.0, 8.0, 8)


def test_big_fire_bridges_a_one_cell_gap():
    # A ≥BRIDGE_MIN_CELLS fire and a cluster two rings away (one empty cell
    # between) detected in the same pass: one fire. Live 2026-07-25 the
    # Saint-Médard-en-Jalles front (407 cells) and its southern half toward
    # Andernos (124 cells) were split exactly like this, Δt = 0.
    big = _disk_fire(CENTER, 3, T(20, 0))
    big_cells = {h3.latlng_to_cell(m["lat"], m["lon"], 8) for m in big}
    assert len(big_cells) >= BRIDGE_MIN_CELLS
    far = _cell_at_distance(big_cells, BRIDGE_K)
    south = [hs(*h3.cell_to_latlng(far), T(20, 0)), hs(*h3.cell_to_latlng(far), T(20, 6))]
    assert len(cluster(big, now=T(21, 0))) == 1
    assert len(cluster(south, now=T(21, 0))) == 1
    assert len(cluster(big + south, now=T(21, 0))) == 1


def test_small_fires_do_not_bridge_a_one_cell_gap():
    # Neither side reaches BRIDGE_MIN_CELLS: two agricultural burns 1.7 km
    # apart on the same afternoon stay two fires (pass-1 behaviour).
    a = [hs(*A, T(20, h)) for h in range(3)]
    far = _cell_at_distance({h3.latlng_to_cell(*A, 8)}, BRIDGE_K)
    b = [hs(*h3.cell_to_latlng(far), T(20, h)) for h in range(3)]
    assert len(cluster(a + b, now=T(21, 0))) == 2


def _blob(n_cells, t):
    """A contiguous fire of exactly `n_cells` cells (one detection each)."""
    cells = list(h3.grid_disk(CENTER, 2))  # 19 cells
    for c in h3.grid_ring(CENTER, 3):
        if len(cells) >= n_cells:
            break
        cells.append(c)
    cells = cells[:n_cells]
    assert len(cells) == n_cells
    return [hs(*h3.cell_to_latlng(c), t) for c in cells]


def test_bridge_size_gate_boundary():
    # Exactly BRIDGE_MIN_CELLS bridges; one fewer does not.
    assert BRIDGE_MIN_CELLS == 20
    for n, expected in ((19, 2), (20, 1)):
        blob = _blob(n, T(20, 0))
        blob_cells = {h3.latlng_to_cell(m["lat"], m["lon"], 8) for m in blob}
        assert len(blob_cells) == n
        far = _cell_at_distance(blob_cells, BRIDGE_K)
        speck = [hs(*h3.cell_to_latlng(far), T(20, 0))]
        assert len(cluster(blob + speck, now=T(21, 0))) == expected, n


def test_bridge_window_boundary():
    # Exactly CLOSE_AFTER_H apart bridges; one minute more does not.
    big = _disk_fire(CENTER, 3, T(20, 0))
    big_cells = {h3.latlng_to_cell(m["lat"], m["lon"], 8) for m in big}
    far = _cell_at_distance(big_cells, BRIDGE_K)
    edge = T(20, 0) + timedelta(hours=CLOSE_AFTER_H)
    assert len(cluster(big + [hs(*h3.cell_to_latlng(far), edge)], now=T(23, 0))) == 1
    over = edge + timedelta(minutes=1)
    assert len(cluster(big + [hs(*h3.cell_to_latlng(far), over)], now=T(23, 0))) == 2


def test_bridge_never_reaches_past_two_rings():
    # Literal 3, not BRIDGE_K + 1: the reach is a product decision (one empty
    # cell, ~1.7 km), and widening it must be a deliberate edit here too.
    assert BRIDGE_K == 2
    big = _disk_fire(CENTER, 3, T(20, 0))
    big_cells = {h3.latlng_to_cell(m["lat"], m["lon"], 8) for m in big}
    far = _cell_at_distance(big_cells, 3)
    other = [hs(*h3.cell_to_latlng(far), T(20, 0))]
    assert len(cluster(big + other, now=T(21, 0))) == 2


def test_bridge_respects_the_48h_window():
    big = _disk_fire(CENTER, 3, T(20, 0))
    big_cells = {h3.latlng_to_cell(m["lat"], m["lon"], 8) for m in big}
    far = _cell_at_distance(big_cells, BRIDGE_K)
    late = [hs(*h3.cell_to_latlng(far), T(23, 0))]  # 72 h later
    assert len(cluster(big + late, now=T(24, 0))) == 2


def test_bridged_event_keeps_the_earliest_id():
    big = _disk_fire(CENTER, 3, T(20, 0))
    big_cells = {h3.latlng_to_cell(m["lat"], m["lon"], 8) for m in big}
    far = _cell_at_distance(big_cells, BRIDGE_K)
    south = [hs(*h3.cell_to_latlng(far), T(20, 12))]
    id_big = next(iter(cluster(big, now=T(21, 0))))
    assert next(iter(cluster(big + south, now=T(21, 0)))) == id_big


def test_sql_clustering_matches_python_reference():
    # Random detections clustered by the DuckDB engine must partition exactly
    # like the pure-Python union-find, so the SQL move is behaviour-preserving.
    random.seed(7)
    now = T(30, 0)
    rows = []
    for _ in range(150):
        lat = 45.0 + random.uniform(-0.06, 0.06)
        lon = 8.0 + random.uniform(-0.06, 0.06)
        t = now - timedelta(hours=random.uniform(0, 200))
        rows.append(hs(lat, lon, t))
    sql = {frozenset(m["src_id"] for m in ms) for ms in cluster(rows, now).values()}
    assert sql == _reference_partition(rows)

A = (45.000, 8.000)
B = (45.005, 8.000)   # neighbor cell of A
C = (45.012, 8.000)   # 2 cells from A, adjacent to B (bridge point)
FAR = (45.500, 8.500)  # far away — independent


def test_adjacent_within_48h_same_event():
    rows = [hs(*A, T(20, 0)), hs(*B, T(21, 12))]  # 36 h apart, adjacent
    assert len(cluster(rows, now=T(22, 0))) == 1


def test_gap_over_48h_splits_into_two_events():
    rows = [hs(*A, T(10, 0)), hs(*A, T(13, 6))]  # same cell, 78 h gap
    assert len(cluster(rows, now=T(14, 0))) == 2


def test_chain_can_exceed_48h_total_duration():
    rows = [hs(*A, T(10, 0)), hs(*A, T(11, 12)), hs(*A, T(13, 0))]  # each gap 36 h
    assert len(cluster(rows, now=T(14, 0))) == 1  # continuous, 72 h total


def test_far_fires_stay_separate():
    rows = [hs(*A, T(20, 0)), hs(*FAR, T(20, 0))]
    assert len(cluster(rows, now=T(21, 0))) == 2


def test_id_stable_across_refresh_and_growth():
    early = [hs(*A, T(20, 0))]
    grown = early + [hs(*B, T(20, 6)), hs(*B, T(20, 12))]
    id1 = next(iter(cluster(early, now=T(20, 3))))
    id2 = next(iter(cluster(grown, now=T(21, 0))))
    assert id1 == id2  # growth never changes id (first detection wins)


def test_merge_keeps_earliest_events_id():
    a = [hs(*A, T(20, 0))]
    c = [hs(*C, T(20, 6))]
    ev0 = cluster(a + c, now=T(20, 12))
    assert len(ev0) == 2
    bridge = [hs(*B, T(20, 12))]  # adjacent to both A and C → merge
    ev1 = cluster(a + c + bridge, now=T(21, 0))
    assert len(ev1) == 1
    # merged id = id of the component with the earliest (bin, cell) → A's original id
    comp_a = next(ev0[i] for i in ev0 if any(abs(m["lat"] - A[0]) < 1e-6 for m in ev0[i]))
    assert next(iter(ev1)) == event_id_for(comp_a)


def test_meteosat_overlapping_polar_does_not_add_a_second_event():
    # Sensor fusion: a Meteosat pixel on top of a VIIRS fire is the SAME fire.
    # VIIRS owns geometry + ignition; the MTG pixel only adds liveness
    # (via liveness_for_events), so it must NOT spawn a second event, and the
    # VIIRS event keeps its earlier ignition.
    rows = [hs(*A, T(20, 0)), hs(*A, T(22, 0)), hs(*B, T(23, 0), tier="meteosat")]
    ev = cluster(rows, now=T(23, 6))
    assert len(ev) == 1
    members = next(iter(ev.values()))
    assert all(m["tier"] != "meteosat" for m in members)
    assert min(m["acq_time"] for m in members) == T(20, 0)  # real ignition kept


def test_meteosat_only_fire_kept_when_no_polar_nearby():
    # A fresh MTG detection far from any VIIRS fire IS its own fire (low-latency
    # detection VIIRS has not caught yet) — it must survive fusion as an event.
    rows = [hs(*A, T(20, 0)), hs(*FAR, T(20, 3), tier="meteosat")]
    ev = cluster(rows, now=T(20, 6))
    assert len(ev) == 2
    tiers = {m["tier"] for ms in ev.values() for m in ms}
    assert tiers == {"viirs", "meteosat"}


def test_meteosat_only_clusters_at_res7():
    # No polar detections at all → events must come from Meteosat pixels,
    # clustered at res 7 so ~2 km-apart pixels join into one fire (else every
    # pixel is its own "fire" and markers never match the footprint).
    import h3

    from pipeline.events import METEOSAT_RES

    # Three pixels ~2 km apart along a line — one MTG fire.
    pts = [
        hs(45.00, 8.00, T(20, 0), tier="meteosat"),
        hs(45.00, 8.025, T(20, 1), tier="meteosat"),
        hs(45.00, 8.050, T(20, 2), tier="meteosat"),
    ]
    ev = cluster(pts, now=T(20, 6))
    assert len(ev) == 1, f"expected one MTG fire, got {len(ev)}"
    members = next(iter(ev.values()))
    assert all(h3.get_resolution(m["cell"]) == METEOSAT_RES for m in members)


def test_cell_km2_for_uses_viirs_default_for_polar_members():
    members = [hs(*A, T(20, 0))]
    members[0]["cell"] = h3.latlng_to_cell(*A, 8)  # VIIRS clustering resolution
    assert cell_km2_for(members) == CELL_KM2


def test_cell_km2_for_uses_the_wider_meteosat_cell():
    members = [hs(*A, T(20, 0))]
    members[0]["cell"] = h3.latlng_to_cell(*A, METEOSAT_RES)
    assert cell_km2_for(members) == METEOSAT_CELL_KM2


def test_lifecycle_thresholds():
    members = next(iter(cluster([hs(*A, T(20, 0))], now=T(20, 6)).values()))
    assert lifecycle(members, None, now=T(20, 6)) == "active"      # 6 h
    assert lifecycle(members, None, now=T(21, 6)) == "stale"       # 30 h
    assert lifecycle(members, None, now=T(22, 6)) == "closed"      # 54 h
    assert lifecycle(members, T(22, 5), now=T(22, 6)) == "active"  # meteosat 1 h ago


def _long_fire(first_day, last_day):
    """One detection every 36 h from first_day to last_day — a single chained
    event (each gap < CLOSE_AFTER_H)."""
    rows, t = [], T(first_day, 0)
    while t <= T(last_day, 0):
        rows.append(hs(*A, t))
        t += timedelta(hours=36)
    return rows


def test_window_is_on_the_latest_detection_so_ids_and_footprints_do_not_erode():
    """A fire is in the window while its LATEST detection is; its earlier
    detections stay part of it however old they are. Cutting ROWS at the
    window instead made a long fire lose its first days one refresh at a
    time: the id (seeded on the earliest member) changed daily, every shared
    link died within a day, the archive gained a new track file per day for
    the same fire, and the footprint shrank. Gironde 2026: 337bec… →
    09336ed7… → 9a402540… between three refreshes."""
    rows = _long_fire(1, 20)  # 20 days of detections
    early = cluster(rows, now=T(21, 0))          # everything in the 14-day window anyway
    late = cluster(rows, now=T(30, 0))           # cutoff day 16: first 15 days are "old"
    assert len(early) == len(late) == 1
    assert next(iter(late)) == next(iter(early)), "id must not change as the window slides"
    assert len(next(iter(late.values()))) == len(rows), "footprint must stay complete"


def test_window_drops_a_fire_whose_latest_detection_is_too_old():
    rows = _long_fire(1, 5)
    assert len(cluster(rows, now=T(10, 0))) == 1
    assert cluster(rows, now=T(25, 0)) == {}  # latest day 5, cutoff day 11


def test_window_ignores_detections_from_the_future():
    rows = [hs(*A, T(20, 0)), hs(*A, T(22, 0))]
    ev = cluster(rows, now=T(21, 0))
    assert [m["acq_time"] for ms in ev.values() for m in ms] == [T(20, 0)]


def test_reactivation_lineage():
    old = [hs(*A, T(10, 0))]
    new = [hs(*A, T(14, 0))]  # 96 h later, same cell
    ev = cluster(old + new, now=T(14, 6))
    assert len(ev) == 2
    links = reactivation_links(ev, now=T(14, 6))
    ids = sorted(ev, key=lambda i: min(m["bin"] for m in ev[i]))
    assert links == {ids[1]: ids[0]}
