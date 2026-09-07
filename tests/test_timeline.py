from pipeline.timeline import build_timeline
from tests.synth import T, hs


def test_daily_counts_exclude_meteosat_and_zero_fill():
    now = T(20, 12)
    rows = [
        hs(45.0, 8.0, T(20, 6)),                 # today
        hs(45.0, 8.0, T(20, 8)),                 # today
        hs(45.0, 8.0, T(18, 6)),                 # 2 days ago
        hs(45.0, 8.0, T(19, 6), tier="meteosat"),  # excluded
    ]
    tl = build_timeline(rows, now, days=5)
    assert len(tl) == 5
    by_date = {d["date"]: d["count"] for d in tl}
    assert by_date["2026-07-20"] == 2
    assert by_date["2026-07-18"] == 1
    assert by_date["2026-07-19"] == 0  # zero-filled, meteosat ignored
    assert [d["date"] for d in tl] == sorted(d["date"] for d in tl)  # oldest first


def test_frp_summed_per_day():
    now = T(20, 12)
    rows = [hs(45.0, 8.0, T(20, 1), frp=30.0), hs(45.0, 8.0, T(20, 2), frp=20.0)]
    tl = build_timeline(rows, now, days=2)
    assert tl[-1]["frp"] == 50.0


def test_excludes_dropped_static_source_detections_by_src_id():
    now = T(20, 12)
    flare = hs(45.0, 8.0, T(20, 6))
    real = hs(46.0, 9.0, T(20, 6))
    tl = build_timeline([flare, real], now, days=1, exclude_ids={flare["src_id"]})
    assert tl[0]["count"] == 1
    assert build_timeline([flare, real], now, days=1)[0]["count"] == 2  # no exclusion -> both


def test_excluding_by_src_id_keeps_a_real_detection_that_shares_a_cell_with_a_dropped_one():
    """A cell can host a real, KEPT event alongside a dropped static one (a
    fire that spread into a flare's cell but stayed under STATIC_EVENT_FRAC).
    Excluding by cell would undercount the real event here even though the
    map still shows it in full; excluding by src_id must not."""
    now = T(20, 12)
    flare = hs(45.0, 8.0, T(20, 1))
    real_same_cell = hs(45.0, 8.0, T(20, 6))  # same cell as the flare, different detection
    tl = build_timeline([flare, real_same_cell], now, days=1, exclude_ids={flare["src_id"]})
    assert tl[0]["count"] == 1
