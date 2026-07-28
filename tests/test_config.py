from pathlib import Path

from pipeline.config import EUROPE_BBOX, load_settings


def test_load_settings_from_mapping():
    s = load_settings(env={"FIRMS_MAP_KEY": "k123", "DATA_DIR": "/tmp/x"})
    assert s.firms_map_key == "k123"
    assert s.data_dir == Path("/tmp/x")
    assert s.eumetsat_key is None


def test_bbox_sane():
    lon_min, lat_min, lon_max, lat_max = EUROPE_BBOX
    assert lon_min < lon_max and lat_min < lat_max
