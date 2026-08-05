"""fetch_effis_ba reads the stored perimeter snapshot, never the network.

Fixtures are synthetic: square polygons at round coordinates so the centroid is
exact, and made-up ids/places.
"""
from datetime import date
from pathlib import Path

from pipeline.fetch_effis import fetch_effis_ba
from pipeline.store import write_polygons

POLY = "POLYGON((0 0, 0 2, 2 2, 2 0, 0 0))"       # centroid (1, 1)
FAR = "POLYGON((10 40, 10 42, 12 42, 12 40, 10 40))"  # centroid (11, 41)


class FakeSettings:
    def __init__(self, tmp_path: Path):
        self.data_dir = tmp_path


def row(fid, area_ha, wkt=POLY, place=None, firedate=date(2026, 7, 1)):
    return {"id": fid, "area_ha": area_ha, "geometry_wkt": wkt,
            "firedate": firedate, "country": "ES", "place": place}


def seed(tmp_path, rows):
    path = tmp_path / "raw" / "effis_ba.parquet"
    write_polygons(rows, path)
    return FakeSettings(tmp_path)


def test_returns_the_largest_scars_first(tmp_path):
    settings = seed(tmp_path, [row("a", 100.0), row("b", 900.0), row("c", 500.0)])
    got = fetch_effis_ba(settings, limit=2)
    assert [s["id"] for s in got] == ["b", "c"]


def test_shape_matches_what_build_imagery_consumes(tmp_path):
    settings = seed(tmp_path, [row("a", 900.0, place="Aragon")])
    scar = fetch_effis_ba(settings)[0]
    assert set(scar) >= {"id", "label", "kind", "lon", "lat", "started", "before", "after"}
    assert scar["kind"] == "past"
    assert scar["label"] == "Aragon · 2026"
    assert scar["place"] == "Aragon"
    assert "_area_ha" not in scar


def test_label_without_a_place(tmp_path):
    settings = seed(tmp_path, [row("a", 900.0)])
    assert fetch_effis_ba(settings)[0]["label"] == "Burn scar · 2026-07-01"


def test_centroid_becomes_lon_lat(tmp_path):
    settings = seed(tmp_path, [row("a", 900.0, wkt=FAR)])
    scar = fetch_effis_ba(settings)[0]
    assert scar["lon"] == 11.0
    assert scar["lat"] == 41.0


def test_undated_rows_are_skipped(tmp_path):
    settings = seed(tmp_path, [row("a", 900.0, firedate=None), row("b", 10.0)])
    assert [s["id"] for s in fetch_effis_ba(settings)] == ["b"]


def test_imagery_window_brackets_the_fire_date(tmp_path):
    settings = seed(tmp_path, [row("a", 900.0)])
    scar = fetch_effis_ba(settings)[0]
    assert scar["started"] == "2026-07-01"
    assert scar["before"] == "2026-06-25"   # firedate - BASELINE_LEAD_DAYS
    assert scar["after"] == "2026-07-15"    # firedate + SCAR_SETTLE_DAYS


def test_missing_snapshot_returns_empty_and_never_raises(tmp_path):
    assert fetch_effis_ba(FakeSettings(tmp_path)) == []


def test_unreadable_snapshot_returns_empty_and_never_raises(tmp_path):
    path = tmp_path / "raw" / "effis_ba.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("this is not parquet")
    assert fetch_effis_ba(FakeSettings(tmp_path)) == []


def test_a_malformed_row_is_skipped_not_raised(tmp_path):
    """A snapshot whose firedate is text, not a date (a hydrated file written by
    another version), must degrade to skipping that row, never to an exception:
    run.py hands this straight to build_imagery."""
    settings = seed(tmp_path, [
        {"id": "bad", "area_ha": 900.0, "geometry_wkt": POLY,
         "firedate": "2026-07-01", "country": "ES", "place": None},
    ])
    assert fetch_effis_ba(settings) == []


def test_settings_without_a_data_dir_returns_empty(tmp_path):
    class Bare:
        pass

    assert fetch_effis_ba(Bare()) == []


def test_no_network_call_is_made(tmp_path):
    settings = seed(tmp_path, [row("a", 900.0)])

    def boom(url):
        raise AssertionError("fetch_effis_ba must not hit the network")

    assert fetch_effis_ba(settings, http_get=boom)
