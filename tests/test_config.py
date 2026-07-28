from pathlib import Path

from pipeline.config import EUROPE_BBOX, load_settings


def test_load_settings_from_mapping():
    s = load_settings(env={"FIRMS_MAP_KEY": "k123", "DATA_DIR": "/tmp/x"})
    assert s.firms_map_key == "k123"
    assert s.data_dir == Path("/tmp/x")
    assert s.eumetsat_key is None


def test_firms_history_days_default_and_override():
    assert load_settings(env={"FIRMS_MAP_KEY": "k"}).firms_history_days == 30
    s = load_settings(env={"FIRMS_MAP_KEY": "k", "FIRMS_HISTORY_DAYS": "45"})
    assert s.firms_history_days == 45
    # A garbage value falls back to the default rather than raising.
    assert load_settings(env={"FIRMS_HISTORY_DAYS": "nope"}).firms_history_days == 30


def test_bbox_sane():
    lon_min, lat_min, lon_max, lat_max = EUROPE_BBOX
    assert lon_min < lon_max and lat_min < lat_max
