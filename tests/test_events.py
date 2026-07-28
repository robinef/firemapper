import random
from collections import defaultdict
from datetime import timedelta

import h3

from pipeline.events import CLOSE_AFTER_H, _UF, cluster, event_id_for, lifecycle, reactivation_links
from tests.synth import T, hs


def _reference_partition(rows, res=8):
    """Pure-Python connected components (the pre-SQL union-find), as a set of
    frozensets of src_ids — the oracle the DuckDB clustering must match."""
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
                    if abs((nodes[a]["acq_time"] - nodes[b]["acq_time"]).total_seconds()) <= md.total_seconds():
                        uf.union(a, b)
    comps = defaultdict(set)
    for i in range(len(nodes)):
        comps[uf.find(i)].add(rows[i]["src_id"])
    return {frozenset(v) for v in comps.values()}


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


def test_lifecycle_thresholds():
    members = next(iter(cluster([hs(*A, T(20, 0))], now=T(20, 6)).values()))
    assert lifecycle(members, None, now=T(20, 6)) == "active"      # 6 h
    assert lifecycle(members, None, now=T(21, 6)) == "stale"       # 30 h
    assert lifecycle(members, None, now=T(22, 6)) == "closed"      # 54 h
    assert lifecycle(members, T(22, 5), now=T(22, 6)) == "active"  # meteosat 1 h ago


def test_reactivation_lineage():
    old = [hs(*A, T(10, 0))]
    new = [hs(*A, T(14, 0))]  # 96 h later, same cell
    ev = cluster(old + new, now=T(14, 6))
    assert len(ev) == 2
    links = reactivation_links(ev, now=T(14, 6))
    ids = sorted(ev, key=lambda i: min(m["bin"] for m in ev[i]))
    assert links == {ids[1]: ids[0]}
