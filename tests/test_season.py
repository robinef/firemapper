from datetime import date
from pathlib import Path

from pipeline.season import normalize_country, season_totals, _LOOKUP, _fold
from pipeline.store import write_polygons

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
