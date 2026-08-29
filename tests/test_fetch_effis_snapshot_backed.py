"""fetch_effis_ba reads the stored perimeter snapshot, never the network.

Fixtures are synthetic: square polygons at round coordinates so the centroid is
exact, and made-up ids/places.
"""
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

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
    assert set(scar) >= {
        "id", "label", "kind", "lon", "lat", "started", "before", "after", "area_km2",
    }
    assert scar["kind"] == "past"
    assert scar["label"] == "Aragon · 2026"
    assert scar["place"] == "Aragon"
    assert "_area_ha" not in scar


def test_scar_reports_the_mapped_area_in_km2(tmp_path):
    """EFFIS gives a real perimeter, not a sensor-cell floor — 900 ha = 9 km²,
    exact."""
    settings = seed(tmp_path, [row("a", 900.0)])
    scar = fetch_effis_ba(settings)[0]
    assert scar["area_km2"] == 9.0


def test_scar_carries_no_cell_count(tmp_path):
    """No `cum_cells`: a mapped polygon has no sensor-floor uncertainty, so
    areaText() must never show its "≤" unsized marker for an EFFIS scar."""
    settings = seed(tmp_path, [row("a", 900.0)])
    assert "cum_cells" not in fetch_effis_ba(settings)[0]


def test_a_zero_area_row_still_reports_zero_not_missing(tmp_path):
    settings = seed(tmp_path, [row("a", 0.0)])
    scar = fetch_effis_ba(settings)[0]
    assert scar["area_km2"] == 0.0


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


def test_undated_rows_do_not_consume_a_limit_slot(tmp_path):
    """The undated row is the largest, so without the SQL-level firedate filter
    it would take the single LIMIT slot and the valid row would never be read.
    Pins the WHERE clause rather than the per-row guard, which would swallow the
    same row to a same-looking (but wrong) result at the default limit."""
    settings = seed(tmp_path, [row("a", 900.0, firedate=None), row("b", 10.0)])
    assert [s["id"] for s in fetch_effis_ba(settings, limit=1)] == ["b"]


def test_imagery_window_brackets_the_fire_date(tmp_path):
    settings = seed(tmp_path, [row("a", 900.0)])
    scar = fetch_effis_ba(settings)[0]
    assert scar["started"] == "2026-07-01"
    assert scar["before"] == "2026-06-25"   # firedate - BASELINE_LEAD_DAYS
    assert scar["after"] == "2026-07-15"    # firedate + SCAR_SETTLE_DAYS


# EFFIS covers the CURRENT season, so most live rows are within SCAR_SETTLE_DAYS
# of today and the clamps below — not the settled arithmetic above — are the
# branch that actually runs in production. Dates are relative to today so these
# keep exercising the clamps as the calendar moves.


@pytest.fixture
def today():
    """Read at test time, not import time: fetch_effis_ba reads the clock on
    every call, so a suite crossing UTC midnight would otherwise flake."""
    return datetime.now(timezone.utc).date()


def test_after_is_clamped_to_yesterday_for_a_recent_fire(tmp_path, today):
    """firedate + 14 is still in the future, so `after` is pulled back to the
    newest day imagery can exist for. Without min(..., yesterday) this would
    name a date GIBS has nothing behind yet."""
    fire = today - timedelta(days=5)
    settings = seed(tmp_path, [row("a", 900.0, firedate=fire)])
    scar = fetch_effis_ba(settings)[0]
    assert scar["after"] == (today - timedelta(days=1)).isoformat()
    assert scar["after"] != (fire + timedelta(days=14)).isoformat()


def test_after_is_never_before_ignition_for_a_fire_today(tmp_path, today):
    """A fire that started today: the yesterday ceiling would put `after`
    BEFORE the fire existed, so max(..., fire_date) must win. This is the
    lower clamp, and it is the case a fresh EFFIS row hits."""
    settings = seed(tmp_path, [row("a", 900.0, firedate=today)])
    scar = fetch_effis_ba(settings)[0]
    assert scar["after"] == today.isoformat()
    assert scar["after"] != (today - timedelta(days=1)).isoformat()


def test_after_equals_the_fire_date_for_a_fire_yesterday(tmp_path, today):
    yesterday = today - timedelta(days=1)
    settings = seed(tmp_path, [row("a", 900.0, firedate=yesterday)])
    scar = fetch_effis_ba(settings)[0]
    assert scar["after"] == yesterday.isoformat() == scar["started"]


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


def test_a_quote_in_the_data_dir_does_not_silently_blank_the_scars(tmp_path):
    """A path is interpolated into SQL, so it goes through store._sql_path.
    Unescaped, the quote breaks the query and the map loses every scar with no
    error anywhere."""
    odd = tmp_path / "o'brien data"
    settings = seed(odd, [row("a", 900.0)])
    assert [s["id"] for s in fetch_effis_ba(settings)] == ["a"]


def test_settings_without_a_data_dir_returns_empty(tmp_path):
    class Bare:
        pass

    assert fetch_effis_ba(Bare()) == []


def test_no_network_call_is_made(tmp_path):
    settings = seed(tmp_path, [row("a", 900.0)])

    def boom(url):
        raise AssertionError("fetch_effis_ba must not hit the network")

    assert fetch_effis_ba(settings, http_get=boom)
