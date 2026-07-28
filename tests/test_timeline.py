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
