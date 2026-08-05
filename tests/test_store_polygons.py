from pathlib import Path
from pipeline.store import connect, write_polygons

SQUARE = "POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))"
MULTI = "MULTIPOLYGON(((2 2, 2 3, 3 3, 3 2, 2 2)), ((5 5, 5 6, 6 6, 6 5, 5 5)))"


def test_writes_polygon_geometry(tmp_path: Path):
    path = tmp_path / "ba.parquet"
    con = connect()
    rows = [
        {"id": "a", "area_ha": 120.0, "geometry_wkt": SQUARE},
        {"id": "b", "area_ha": 300.0, "geometry_wkt": MULTI},
    ]
    assert write_polygons(rows, path) == 2
    got = con.execute(
        f"SELECT id, area_ha, ST_GeometryType(geometry) FROM read_parquet('{path}') ORDER BY id"
    ).fetchall()
    assert got == [("a", 120.0, "POLYGON"), ("b", 300.0, "MULTIPOLYGON")]


def test_drops_the_wkt_src_column(tmp_path: Path):
    path = tmp_path / "ba.parquet"
    con = connect()
    write_polygons([{"area_ha": 50.0, "geometry_wkt": SQUARE}], path)
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()]
    assert "geometry_wkt" not in cols
    assert "geometry" in cols


def test_empty_input_writes_readable_file(tmp_path: Path):
    path = tmp_path / "ba.parquet"
    con = connect()
    assert write_polygons([], path) == 0
    assert con.execute(f"SELECT count(*) FROM read_parquet('{path}')").fetchone()[0] == 0
