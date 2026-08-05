from datetime import date
from pipeline.fetch_effis_season import completeness, rows_from_features

POLY = {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]}
MULTI = {"type": "MultiPolygon", "coordinates": [[[[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]]]]}


def feature(**props):
    geom = props.pop("geometry", POLY)
    fid = props.pop("id", None)
    out = {"type": "Feature", "geometry": geom, "properties": props}
    if fid is not None:
        out["id"] = fid
    return out


def test_polygon_survives_ingestion():
    rows = rows_from_features([feature(id="ba.1", area_ha="120.5", firedate="2026-07-01")])
    assert len(rows) == 1
    assert rows[0]["id"] == "ba.1"
    assert rows[0]["area_ha"] == 120.5
    assert rows[0]["firedate"] == date(2026, 7, 1)
    assert rows[0]["geometry_wkt"].startswith("POLYGON")


def test_multipolygon_survives_ingestion():
    rows = rows_from_features([feature(id="ba.2", geometry=MULTI, area_ha="9")])
    assert rows[0]["geometry_wkt"].startswith("MULTIPOLYGON")


def test_missing_feature_id_is_derived_deterministically():
    a = rows_from_features([feature(area_ha="10", firedate="2026-07-01")])
    b = rows_from_features([feature(area_ha="10", firedate="2026-07-01")])
    assert a[0]["id"] == b[0]["id"]
    assert a[0]["id"]


def test_different_geometry_yields_a_different_derived_id():
    a = rows_from_features([feature(area_ha="10", firedate="2026-07-01")])
    b = rows_from_features([feature(geometry=MULTI, area_ha="10", firedate="2026-07-01")])
    assert a[0]["id"] != b[0]["id"]


def test_non_polygon_geometry_is_dropped():
    point = {"type": "Point", "coordinates": [1, 2]}
    assert rows_from_features([feature(geometry=point, area_ha="10")]) == []


def test_zero_and_negative_area_are_dropped():
    assert rows_from_features([feature(id="z", area_ha="0")]) == []
    assert rows_from_features([feature(id="n", area_ha="-4")]) == []


def test_unparseable_area_is_dropped():
    assert rows_from_features([feature(id="u", area_ha="not-a-num")]) == []


def test_null_firedate_is_kept_as_none():
    rows = rows_from_features([feature(id="d", area_ha="10")])
    assert rows[0]["firedate"] is None


def test_country_and_place_are_extracted():
    rows = rows_from_features([feature(id="c", area_ha="10", country="ES", province="Aragon")])
    assert rows[0]["country"] == "ES"
    assert rows[0]["place"] == "Aragon"


def test_completeness_reads_both_counters():
    assert completeness({"numberMatched": 900, "numberReturned": 500}) == (900, 500)


def test_completeness_tolerates_missing_counters():
    assert completeness({}) == (None, None)
