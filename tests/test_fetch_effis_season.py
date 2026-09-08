from datetime import date

from pipeline.fetch_effis_season import _rows_from_records

POLY = {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]}
MULTI = {"type": "MultiPolygon", "coordinates": [[[[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]]]]}


def record(**overrides):
    base = {
        "id": 1, "shape": POLY, "area_ha": "10", "firedate": "2026-07-01",
        "country": "ES", "province": None, "commune": None,
    }
    base.update(overrides)
    return base


def test_polygon_survives_ingestion():
    rows = _rows_from_records(
        [record(id=101, area_ha="120.5", firedate="2026-07-01T10:00:00+02:00")]
    )
    assert len(rows) == 1
    assert rows[0]["id"] == "101"
    assert rows[0]["area_ha"] == 120.5
    assert rows[0]["firedate"] == date(2026, 7, 1)
    assert rows[0]["geometry_wkt"] == "POLYGON((0.0 0.0, 0.0 1.0, 1.0 1.0, 1.0 0.0, 0.0 0.0))"


def test_multipolygon_survives_ingestion():
    rows = _rows_from_records([record(id=102, shape=MULTI, area_ha="9")])
    assert rows[0]["geometry_wkt"] == "MULTIPOLYGON(((2.0 2.0, 2.0 3.0, 3.0 3.0, 3.0 2.0, 2.0 2.0)))"


def test_id_passes_through_as_a_string():
    """The REST API's id is a stable integer PK — no more hash-derived
    fallback id (that existed only for raw WFS features that sometimes
    lacked a usable id/fid property)."""
    rows = _rows_from_records([record(id=683014)])
    assert rows[0]["id"] == "683014"


def test_missing_id_is_dropped():
    rec = record()
    del rec["id"]
    assert _rows_from_records([rec]) == []


def test_empty_multipolygon_coordinates_are_dropped():
    empty_multi = {"type": "MultiPolygon", "coordinates": []}
    assert _rows_from_records([record(shape=empty_multi)]) == []


def test_unclosed_ring_is_dropped():
    unclosed = {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0]]]}
    assert _rows_from_records([record(shape=unclosed)]) == []


def test_non_polygon_geometry_is_dropped():
    point = {"type": "Point", "coordinates": [1, 2]}
    assert _rows_from_records([record(shape=point)]) == []


def test_zero_and_negative_area_are_dropped():
    assert _rows_from_records([record(id="z", area_ha="0")]) == []
    assert _rows_from_records([record(id="n", area_ha="-4")]) == []


def test_unparseable_area_is_dropped():
    assert _rows_from_records([record(id="u", area_ha="not-a-num")]) == []


def test_missing_area_key_is_dropped():
    rec = record()
    del rec["area_ha"]
    assert _rows_from_records([rec]) == []


def test_null_firedate_is_kept_as_none():
    """fetch_effis_ba filters undated rows out at read time (WHERE firedate
    IS NOT NULL) — the normalizer's job is just to not crash on one."""
    rec = record()
    rec["firedate"] = None
    rows = _rows_from_records([rec])
    assert rows[0]["firedate"] is None


def test_province_is_preferred_over_commune():
    rows = _rows_from_records([record(province="Aragon", commune="Zaragoza")])
    assert rows[0]["place"] == "Aragon"


def test_commune_is_used_when_province_is_absent():
    rows = _rows_from_records([record(province=None, commune="Zaragoza")])
    assert rows[0]["place"] == "Zaragoza"


def test_country_is_extracted():
    rows = _rows_from_records([record(country="ES")])
    assert rows[0]["country"] == "ES"
