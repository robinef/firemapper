from datetime import datetime, timezone

from pipeline.store import append_hotspots
from scripts.purge_offshore_hotspots import offending_src_ids

# Madrid: safely inland, nowhere near a coastline.
LAND = (40.4168, -3.7038)
# Mid-Atlantic, hundreds of km offshore.
WATER = (38.0, -20.0)


def _hot(lat, lon, src):
    return {
        "lat": lat, "lon": lon,
        "acq_time": datetime(2026, 7, 20, 12, 0, tzinfo=timezone.utc),
        "tier": "viirs", "satellite": "N", "confidence": "h", "frp": 5.0, "src_id": src,
    }


def test_offending_src_ids_flags_only_open_water_rows(tmp_path):
    store = tmp_path / "hotspots.parquet"
    append_hotspots([_hot(*LAND, "land"), _hot(*WATER, "water")], store)

    assert offending_src_ids(store) == {"water"}


def test_offending_src_ids_empty_for_an_all_land_store(tmp_path):
    store = tmp_path / "hotspots.parquet"
    append_hotspots([_hot(*LAND, "land")], store)

    assert offending_src_ids(store) == set()
