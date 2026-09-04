from datetime import datetime, timezone

import h3

from pipeline.store import (
    H3_COLS,
    append_hotspots,
    cell_at,
    connect,
    delete_by_src_id,
    read_hotspots,
    write_points,
)


def _hot(lat, lon, day, src):
    return {
        "lat": lat, "lon": lon,
        "acq_time": datetime(2026, 7, day, 12, 0, tzinfo=timezone.utc),
        "tier": "viirs", "satellite": "N", "confidence": "h", "frp": 5.0, "src_id": src,
    }


def _has_geo(path) -> bool:
    kv = connect().execute(
        f"SELECT key FROM parquet_kv_metadata('{path}')"
    ).fetchall()
    keys = [k[0].decode() if isinstance(k[0], bytes) else k[0] for k in kv]
    return "geo" in keys


def test_hotspots_store_is_geoparquet_with_geometry(tmp_path):
    store = tmp_path / "hotspots.parquet"
    assert append_hotspots([_hot(44.8, -0.5, 20, "a")], store) == 1
    assert _has_geo(store)  # valid GeoParquet
    n_geom = connect().execute(
        f"SELECT count(geometry) FROM read_parquet('{store}')"
    ).fetchone()[0]
    assert n_geom == 1
    rows = read_hotspots(store)
    assert rows[0]["lat"] == 44.8 and rows[0]["acq_time"].tzinfo is not None


def test_append_dedups_and_keeps_geometry(tmp_path):
    store = tmp_path / "hotspots.parquet"
    append_hotspots([_hot(44.8, -0.5, 20, "a")], store)
    assert append_hotspots([_hot(44.8, -0.5, 20, "a")], store) == 0  # dup
    assert append_hotspots([_hot(45.0, 8.0, 21, "b")], store) == 1   # new
    assert _has_geo(store)
    assert len(read_hotspots(store)) == 2


def test_delete_by_src_id_removes_only_the_matched_rows(tmp_path):
    store = tmp_path / "hotspots.parquet"
    append_hotspots([_hot(44.8, -0.5, 20, "a"), _hot(45.0, 8.0, 21, "b")], store)
    assert delete_by_src_id(store, {"a"}) == 1
    rows = read_hotspots(store)
    assert [r["src_id"] for r in rows] == ["b"]
    assert _has_geo(store)  # rewrite must stay valid GeoParquet


def test_delete_by_src_id_is_a_noop_without_a_match_or_a_store(tmp_path):
    store = tmp_path / "hotspots.parquet"
    assert delete_by_src_id(store, {"nope"}) == 0  # no store yet
    append_hotspots([_hot(44.8, -0.5, 20, "a")], store)
    assert delete_by_src_id(store, {"nope"}) == 0  # no match
    assert delete_by_src_id(store, set()) == 0  # empty set
    assert len(read_hotspots(store)) == 1


def test_write_points_snapshot_geoparquet(tmp_path):
    p = tmp_path / "wind.parquet"
    rows = [{"lon": 1.0, "lat": 45.0, "kmh": 20}, {"lon": 2.0, "lat": 46.0, "kmh": None}]
    assert write_points(rows, p) == 2
    assert _has_geo(p)
    xy = connect().execute(
        f"SELECT ST_X(geometry), ST_Y(geometry) FROM read_parquet('{p}') ORDER BY ST_X(geometry)"
    ).fetchall()
    assert xy == [(1.0, 45.0), (2.0, 46.0)]


def test_h3_ladder_stored_and_hierarchical(tmp_path):
    store = tmp_path / "hotspots.parquet"
    append_hotspots([_hot(44.84, -0.58, 20, "a")], store)
    con = connect()
    cols = [c[0] for c in con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{store}')"
    ).fetchall()]
    for c in H3_COLS:
        assert c in cols  # r4/r6/r7/r8 all stored
    row = con.execute(
        f"SELECT h3_r4, h3_r8 FROM read_parquet('{store}')"
    ).fetchone()
    assert h3.cell_to_parent(row[1], 4) == row[0]  # coarse is the parent of fine


def test_read_hotspots_exposes_keys_and_cell_at_uses_them(tmp_path):
    store = tmp_path / "hotspots.parquet"
    append_hotspots([_hot(45.0, 8.0, 20, "a")], store)
    r = read_hotspots(store)[0]
    assert r["h3_r8"] == h3.latlng_to_cell(45.0, 8.0, 8)
    # cell_at prefers the stored key, and derives it when absent (live rows).
    assert cell_at(r, 8) == r["h3_r8"]
    assert cell_at({"lat": 45.0, "lon": 8.0}, 8) == h3.latlng_to_cell(45.0, 8.0, 8)


def test_regional_aggregation_by_coarse_cell(tmp_path):
    store = tmp_path / "hotspots.parquet"
    # Two detections in one r4 cell, one far away → GROUP BY h3_r4 separates them.
    append_hotspots(
        [_hot(44.80, -0.50, 20, "a"), _hot(44.81, -0.51, 20, "b"), _hot(52.0, 5.0, 20, "c")],
        store,
    )
    agg = connect().execute(
        f"SELECT count(*) FROM (SELECT h3_r4 FROM read_parquet('{store}') GROUP BY h3_r4)"
    ).fetchone()[0]
    assert agg == 2  # two distinct regional cells


def test_spatial_query_near_point(tmp_path):
    store = tmp_path / "hotspots.parquet"
    append_hotspots([_hot(44.84, -0.58, 20, "near"), _hot(52.0, 5.0, 20, "far")], store)
    near = connect().execute(
        f"SELECT count(*) FROM read_parquet('{store}') "
        f"WHERE ST_DWithin(geometry, ST_Point(-0.58, 44.84), 0.3)"
    ).fetchone()[0]
    assert near == 1
