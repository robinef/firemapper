from pipeline.events import cluster
from pipeline.metrics import (
    area_km2,
    bins_series,
    local_spread_bearings,
    local_spread_vectors,
    movement,
    status,
)
from tests.synth import T, hs


def _members(rows, now):
    ev = cluster(rows, now)
    assert len(ev) == 1
    return next(iter(ev.values()))


def test_bins_and_area():
    rows = [hs(45.0, 8.0, T(20, 1)), hs(45.005, 8.0, T(20, 7))]
    m = _members(rows, T(20, 12))
    s = bins_series(m)
    assert len(s) == 2 and s[0]["cum_cells"] == 1 and s[1]["cum_cells"] == 2
    assert area_km2(m) == 1.4


def test_movement_noise_gate():
    rows = [hs(45.0, 8.0, T(20, 0)), hs(45.0001, 8.0, T(20, 6))]  # ~11 m drift
    s = bins_series(_members(rows, T(20, 12)))
    assert movement(s, T(20, 12)) is None


def test_movement_direction_north():
    rows = [hs(45.000, 8.0, T(20, 0)), hs(45.007, 8.0, T(20, 6)), hs(45.014, 8.0, T(20, 12))]
    s = bins_series(_members(rows, T(20, 18)))
    mv = movement(s, T(20, 18))
    assert mv is not None
    assert mv["distance_24h_m"] > 1200
    assert mv["bearing_deg"] < 15 or mv["bearing_deg"] > 345  # ~north


def _pt(lat, lon, age):
    return {"lat": lat, "lon": lon, "age_min": age}


def test_local_spread_points_toward_newer_detections():
    # A north-running line of detections getting fresher northward.
    pts = [_pt(45.000 + 0.01 * k, 8.0, 300 - 60 * k) for k in range(5)]
    dirs = local_spread_bearings(pts)
    mid = dirs[2]
    assert mid is not None
    assert mid < 20 or mid > 340  # ~north


def test_local_spread_points_east_when_fresher_eastward():
    pts = [_pt(45.0, 8.0 + 0.014 * k, 300 - 60 * k) for k in range(5)]
    mid = local_spread_bearings(pts)[2]
    assert mid is not None
    assert 60 < mid < 120  # ~east


def test_isolated_or_flat_age_gets_no_direction():
    # Too few neighbours → no direction invented.
    assert local_spread_bearings([_pt(45.0, 8.0, 100)]) == [None]
    # Neighbours all the same age → no gradient.
    flat = [_pt(45.0 + 0.005 * k, 8.0, 100) for k in range(4)]
    assert all(d is None for d in local_spread_bearings(flat))


def test_spread_bearings_survive_high_latitude():
    """Regression: a degree-sized grid lost every bearing above ~69N.

    Neighbours 4.5 km apart sit inside the 6 km radius but land two grid
    columns away once longitude cells narrow with cos(lat).
    """
    import math as _m

    for lat in (45.0, 60.0, 69.0, 71.5):
        east = lambda km: km * 1000 / (111_320 * _m.cos(_m.radians(lat)))  # noqa: E731
        pts = [
            _pt(lat, 0.0, 300), _pt(lat, east(4.5), 100),
            _pt(lat, east(4.7), 90), _pt(lat, east(4.9), 80),
        ]
        dirs = local_spread_bearings(pts)
        assert dirs[0] is not None, f"lost bearing at {lat}N"
        assert 60 < dirs[0] < 120, f"expected easterly at {lat}N, got {dirs[0]}"


def test_local_spread_speed_matches_geometry():
    # Neighbours ~780 m apart, each 60 min fresher → edge moved ~0.78 km/h.
    pts = [_pt(45.0 + 0.007 * k, 8.0, 300 - 60 * k) for k in range(5)]
    vec = local_spread_vectors(pts)[2]
    assert vec is not None
    bearing, speed = vec
    assert bearing < 20 or bearing > 340
    assert speed is not None and 0.5 < speed < 1.2, f"speed {speed} km/h off"


def test_speed_median_resists_simultaneous_detections():
    # Two pixels 1 min apart in age but 5 km apart would naively imply
    # 300 km/h; the median over all fresher pairs must stay physical.
    pts = [_pt(45.0 + 0.007 * k, 8.0, 300 - 60 * k) for k in range(5)]
    pts.append(_pt(45.045, 8.0, 300 - 60 * 4 - 1))  # near-simultaneous outlier
    vecs = local_spread_vectors(pts)
    speeds = [v[1] for v in vecs if v and v[1] is not None]
    assert speeds and max(speeds) < 10, f"unphysical speed {max(speeds)}"


def test_missing_age_yields_no_direction():
    pts = [_pt(45.0, 8.0, None), _pt(45.005, 8.0, 10), _pt(45.01, 8.0, 20), _pt(45.015, 8.0, 30)]
    assert local_spread_bearings(pts)[0] is None


def test_status_accelerating_vs_single_bin():
    prior = [hs(45.000, 8.0, T(21, 0))]  # 1 new cell in prior 24-48h window
    recent = [
        hs(45.006, 8.0, T(21, 18)), hs(45.012, 8.0, T(22, 0)),
        hs(45.018, 8.0, T(22, 4)), hs(45.024, 8.0, T(22, 8)),
    ]  # 4 new cells in recent 0-24h window
    s = bins_series(_members(prior + recent, T(22, 12)))
    assert status(s, T(22, 12)) == "accelerating"
    s2 = bins_series(_members([hs(45.0, 8.0, T(20, 0))], T(20, 6)))
    assert status(s2, T(20, 6)) in ("growing", "steady")
