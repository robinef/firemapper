from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from pipeline.season import normalize_country, season_totals, _LOOKUP, _fold
from pipeline.store import _naive_utc, write_polygons

POLY = "POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))"
AFRICA = "POLYGON((3 36.7, 3 36.8, 3.1 36.8, 3.1 36.7, 3 36.7))"  # Algiers


def row(fid, area_ha, country, firedate=date(2026, 7, 1), wkt=POLY, place=None):
    return {"id": fid, "area_ha": area_ha, "country": country,
            "firedate": firedate, "place": place, "geometry_wkt": wkt}


def snapshot(tmp_path: Path, rows) -> Path:
    path = tmp_path / "effis_ba.parquet"
    write_polygons(rows, path)
    return path


def test_totals_and_country_ranking(tmp_path):
    path = snapshot(tmp_path, [
        row("1", 100000.0, "ES"), row("2", 40000.0, "ES"),
        row("3", 60000.0, "GR"),
    ])
    got = season_totals(path, 2026)
    assert got["total_km2"] == 2000.0
    assert got["area_count"] == 3
    assert got["unassigned_count"] == 0
    assert got["undated_count"] == 0
    assert got["countries"][0] == {"name": "Spain", "km2": 1400.0, "areas": 2}
    assert got["countries"][1] == {"name": "Greece", "km2": 600.0, "areas": 1}


def test_top_n_limits_the_list(tmp_path):
    rows = [row(str(i), 1000.0 * (i + 1), c)
            for i, c in enumerate(["ES", "GR", "PT", "IT", "FR", "HR"])]
    got = season_totals(snapshot(tmp_path, rows), 2026, top_n=5)
    assert len(got["countries"]) == 5
    # Verify that the smallest country (ES with 1000 ha = 10 km2) is excluded.
    assert got["countries"][-1]["name"] == "Greece"
    assert [c["name"] for c in got["countries"]] == ["Croatia", "France", "Italy", "Portugal", "Greece"]


def test_prior_year_rows_are_excluded(tmp_path):
    path = snapshot(tmp_path, [
        row("1", 10000.0, "ES", firedate=date(2025, 8, 1)),
        row("2", 20000.0, "ES", firedate=date(2026, 8, 1)),
    ])
    got = season_totals(path, 2026)
    assert got["total_km2"] == 200.0
    assert got["area_count"] == 1


def test_undated_rows_are_excluded_and_counted(tmp_path):
    path = snapshot(tmp_path, [
        row("1", 10000.0, "ES"), row("2", 50000.0, "ES", firedate=None),
    ])
    got = season_totals(path, 2026)
    assert got["total_km2"] == 100.0
    assert got["undated_count"] == 1


def test_non_european_country_is_dropped(tmp_path):
    path = snapshot(tmp_path, [row("1", 10000.0, "ES"), row("2", 90000.0, "MA")])
    got = season_totals(path, 2026)
    assert got["total_km2"] == 100.0
    assert [c["name"] for c in got["countries"]] == ["Spain"]


def test_north_african_geometry_never_reaches_the_total(tmp_path):
    # Inside EUROPE_BBOX by latitude. There is no geographic fallback, so the
    # unrecognised country is what decides — not the coordinates.
    path = snapshot(tmp_path, [row("1", 90000.0, None, wkt=AFRICA)])
    got = season_totals(path, 2026)
    assert got["total_km2"] == 0.0
    assert got["unassigned_count"] == 1


def test_null_country_is_unassigned_not_included(tmp_path):
    path = snapshot(tmp_path, [row("1", 10000.0, "ES"), row("2", 90000.0, None)])
    got = season_totals(path, 2026)
    assert got["total_km2"] == 100.0
    assert got["unassigned_count"] == 1


def test_unrecognised_country_is_unassigned(tmp_path):
    path = snapshot(tmp_path, [row("1", 90000.0, "Wakanda")])
    got = season_totals(path, 2026)
    assert got["total_km2"] == 0.0
    assert got["unassigned_count"] == 1


def test_missing_snapshot_returns_none(tmp_path):
    assert season_totals(tmp_path / "nope.parquet", 2026) is None


def test_country_normalisation_variants():
    assert normalize_country("ES") == "Spain"
    assert normalize_country("ESP") == "Spain"
    assert normalize_country("spain") == "Spain"
    assert normalize_country("España") == "Spain"
    assert normalize_country("EL") == "Greece"   # EU code for Greece
    assert normalize_country("GR") == "Greece"
    assert normalize_country("UK") == "United Kingdom"
    assert normalize_country("GB") == "United Kingdom"
    assert normalize_country("UA") == "Ukraine"
    assert normalize_country(None) is None
    assert normalize_country("") is None
    assert normalize_country("MA") is None       # Morocco: not in scope
    assert normalize_country("TR") is None       # Turkey: deliberately excluded
    assert normalize_country("RU") is None       # Russia: deliberately excluded


def test_accented_alias_resolves():
    # Under old .lower()-only build, "Österreich" would be keyed as "österreich"
    # but folded query produces "osterreich", so they never match. With _fold-based
    # keys, both sides go through same normalization and it works.
    assert normalize_country("Österreich") == "Austria"
    # Same for other accented locals.
    assert normalize_country("España") == "Spain"
    assert normalize_country("Ísland") == "Iceland"


def test_lookup_keys_are_folded():
    # Invariant: all lookup keys must be folded, so they can never miss an accented
    # query. Under old .lower()-only build, this fails the moment any accented
    # alias is added to the table.
    assert all(key == _fold(key) for key in _LOOKUP)


# The "as of" date. The snapshot carries its own poll time and that is the only
# honest date for the page: the pipeline runs every 15 minutes, so dating the
# archive by the run would tick the published date forward forever over a
# snapshot that had not moved in weeks.

POLLED = datetime(2026, 6, 20, 9, 30, tzinfo=timezone.utc)


def polled_row(fid, area_ha, country, fetched_at=POLLED, **kw):
    """A row as fetch_season_snapshot writes it: stamped with the poll time,
    stored naive-UTC because DuckDB TIMESTAMP carries no zone."""
    return {**row(fid, area_ha, country, **kw), "fetched_at": _naive_utc(fetched_at)}


def test_the_poll_time_is_read_off_the_snapshot(tmp_path):
    """Not the clock, not the file mtime: the column the snapshot was stamped
    with. Without it the caller has nothing to date the page by but `now`."""
    path = snapshot(tmp_path, [polled_row("1", 10000.0, "ES")])
    assert season_totals(path, 2026)["fetched_at"] == POLLED


def test_the_newest_poll_wins_when_rows_disagree(tmp_path):
    """max(), not first-row: a snapshot rewritten in place can hold rows from
    more than one fetch, and the page must date itself by the latest."""
    older = POLLED - timedelta(days=9)
    path = snapshot(tmp_path, [
        polled_row("1", 10000.0, "ES", fetched_at=older),
        polled_row("2", 10000.0, "GR"),
    ])
    assert season_totals(path, 2026)["fetched_at"] == POLLED


def test_the_poll_time_carries_a_utc_offset(tmp_path):
    """Stored naive (store._naive_utc), so the zone has to be re-attached here.
    A bare "2026-06-20T09:30:00" reaching the page is parsed as LOCAL time by
    the browser, which prints the wrong day either side of midnight."""
    path = snapshot(tmp_path, [polled_row("1", 10000.0, "ES")])
    got = season_totals(path, 2026)["fetched_at"]
    assert got.tzinfo is not None
    assert got.utcoffset().total_seconds() == 0
    assert got.isoformat().endswith("+00:00")


def test_a_snapshot_without_a_poll_column_reports_no_date(tmp_path):
    """An older writer left no `fetched_at`. That is a fallback for the caller
    to make, not a reason to fail the whole aggregation — the total is still
    good, only its date is unknown."""
    path = snapshot(tmp_path, [row("1", 10000.0, "ES")])
    got = season_totals(path, 2026)
    assert got["fetched_at"] is None
    assert got["total_km2"] == 100.0


def test_a_quote_in_the_data_dir_does_not_silently_drop_the_poll_time(tmp_path):
    """Both reads here interpolate the path into SQL, so both go through
    store._sql_path. Unescaped, the quote breaks the `fetched_at` query, the
    except swallows it, and the page silently falls back to dating itself by
    the export clock — the exact failure this layer exists to prevent."""
    odd = tmp_path / "o'brien data"
    path = snapshot(odd, [polled_row("1", 10000.0, "ES")])
    got = season_totals(path, 2026)
    assert got["fetched_at"] == POLLED
    assert got["total_km2"] == 100.0
