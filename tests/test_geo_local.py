import math

from pipeline.geo_local import (
    R_EARTH_M,
    cell_boundary_local_m,
    centroid_of_cells,
    latlon_to_local_m,
    local_m_to_latlon,
)


def test_local_m_round_trip():
    origin_lat, origin_lon = 45.0, 5.0
    lat, lon = 45.01, 5.02
    x_m, y_m = latlon_to_local_m(lat, lon, origin_lat, origin_lon)
    back_lat, back_lon = local_m_to_latlon(x_m, y_m, origin_lat, origin_lon)
    assert math.isclose(back_lat, lat, abs_tol=1e-9)
    assert math.isclose(back_lon, lon, abs_tol=1e-9)


def test_local_m_origin_is_zero():
    x_m, y_m = latlon_to_local_m(45.0, 5.0, 45.0, 5.0)
    assert math.isclose(x_m, 0.0, abs_tol=1e-9)
    assert math.isclose(y_m, 0.0, abs_tol=1e-9)


def test_local_m_longitude_scales_by_cos_latitude():
    # 1 degree of longitude at high latitude covers fewer meters than at the equator.
    x_equator, _ = latlon_to_local_m(0.0, 1.0, 0.0, 0.0)
    x_high_lat, _ = latlon_to_local_m(60.0, 1.0, 60.0, 0.0)
    assert x_high_lat < x_equator


def test_cell_boundary_local_m_returns_hexagon_ish_polygon():
    import h3

    cell_id = h3.latlng_to_cell(45.0, 5.0, 8)
    origin_lat, origin_lon = h3.cell_to_latlng(cell_id)
    poly = cell_boundary_local_m(cell_id, origin_lat, origin_lon)
    assert len(poly) >= 5  # hexagon (6) or pentagon (5, rare)
    # every vertex should be within ~1km of the origin for a res-8 cell (~0.7 km^2)
    for x_m, y_m in poly:
        assert abs(x_m) < 1000
        assert abs(y_m) < 1000


def test_centroid_of_cells_averages_positions():
    # Two cells straddling a point should centroid near that point; use real cell ids
    # from h3 at res 8 around a known lat/lon.
    import h3

    a = h3.latlng_to_cell(45.0, 5.0, 8)
    b = h3.latlng_to_cell(45.01, 5.01, 8)
    lat, lon = centroid_of_cells([a, b])
    assert 44.99 < lat < 45.02
    assert 4.99 < lon < 5.02
