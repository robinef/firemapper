from datetime import datetime, timezone

import h3

from pipeline.day_slices import build_day_slices
from pipeline.store import append_hotspots


def _hot(lat, lon, day, src, tier="viirs"):
    return {
        "lat": lat, "lon": lon,
        "acq_time": datetime(2026, 7, day, 12, 0, tzinfo=timezone.utc),
        "tier": tier, "satellite": "N", "confidence": "h", "frp": 5.0, "src_id": src,
    }


def test_day_slices_group_by_day_and_res5_cell(tmp_path):
    store = tmp_path / "hotspots.parquet"
    # Two detections in the same res-5 cell on 07-20, one elsewhere on 07-21,
    # and a meteosat row that must be ignored.
    append_hotspots(
        [
            _hot(44.80, -0.50, 20, "a"),
            _hot(44.805, -0.505, 20, "b"),
            _hot(48.00, 2.00, 21, "c"),
            _hot(44.80, -0.50, 20, "m", tier="meteosat"),
        ],
        store,
    )
    now = datetime(2026, 7, 22, tzinfo=timezone.utc)
    ds = build_day_slices(store, now, days=10, res=5)

    assert set(ds) == {"2026-07-20", "2026-07-21"}
    # 07-20: the two nearby polar detections share one res-5 cell, count 2.
    cell20 = h3.latlng_to_cell(44.80, -0.50, 5)
    assert ds["2026-07-20"] == [[cell20, 2]]
    # meteosat excluded → no extra count
    assert sum(c[1] for c in ds["2026-07-20"]) == 2
    assert sum(c[1] for c in ds["2026-07-21"]) == 1


def test_day_slices_empty_without_store(tmp_path):
    assert build_day_slices(tmp_path / "missing.parquet", datetime(2026, 7, 22, tzinfo=timezone.utc)) == {}
